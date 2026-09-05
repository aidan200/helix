import { describe, expect, test } from "bun:test";
import { ResourceService } from "../../src/application/services/ResourceService";
import type { ProfileKind, ResourceStateData, ResourceStatePort, ResourceType } from "../../src/application/ports/outbound/ResourceStatePort";
import type {
  SkillDescriptor,
  SkillScanResult,
  SkillSourcePort,
} from "../../src/application/ports/outbound/SkillSourcePort";

/**
 * M6 T1 ResourceService（kind 维资源启停的合取计算层）：
 * - 语义核心：**缺省无记录 = 启用**（零配置兼容现状）；
 * - 生效集 = 全集（profile tools 声明 / 扫描技能）∩ kind 启用集——同 kind
 *   隔离（main 禁不影响 subagent）；
 * - 未知名（不在全集内，如 subagent 禁 agent_spawn）toggle 显式跳过不落库；
 * - model 槽位：未设 = undefined、set/clear 走 store 替换语义；
 * - tools 全集经组合根注入（profiles 在 driven 层，application 只见映射表）。
 */

/** 与生产 profiles 同构的注入映射（MainSessionProfile/SubAgentProfile.tools）。 */
const TOOLS_CATALOG: Readonly<Record<ProfileKind, readonly string[]>> = {
  "main-session": [
    "bash",
    "read",
    "write",
    "edit",
    "grep",
    "web_search",
    "web_fetch",
    "agent_spawn",
    "agent_send",
    "agent_status",
    "agent_inspect", // T3-B
    "browser",
  ],
  "subagent-worker": ["bash", "read", "write", "edit", "grep", "web_search", "web_fetch"],
  "task-worker": ["bash", "read", "write", "edit", "grep", "web_search", "web_fetch"], // 任务 subAgent 独立配置批第六 kind（声明面同 worker）
  "subagent-kg-writer": ["kg-update"],
    "subagent-code-reviewer": ["bash", "read", "grep"], // D5 第五 kind（worker − write/edit 声明面；本文件只作合取计算输入）
    "orchestrator": ["bash", "read", "grep"], // T2.2 第三 kind（additive 扩值同步）
};

/** 测试用 snippet 映射（单点注入；注册表外名 = 空串语义由缺省覆盖）。 */
const TOOL_SNIPPETS: Readonly<Record<string, string>> = {
  bash: "在沙箱工作目录执行 shell 命令并返回输出",
  grep: "跨文件正则检索并列出匹配行",
};

const SKILLS: readonly SkillDescriptor[] = [
  { name: "code-review", description: "审查代码变更质量", filePath: "/tmp/x/code-review/SKILL.md", source: "user", audience: "agent" },
  { name: "deploy-helper", description: "部署流程向导", filePath: "/tmp/y/deploy-helper/SKILL.md", source: "user", audience: "agent" },
];

/** 内存假实现：镜像 ResourceStatePort 语义（含 model 槽位单行不变式）。 */
class InMemoryResourceState implements ResourceStatePort {
  readonly rows = new Map<string, ResourceStateData>();

  private key(kind: ProfileKind, type: string, name: string): string {
    return `${kind}|${type}|${name}`;
  }

  async upsert(kind: ProfileKind, resourceType: ResourceType, name: string, enabled: boolean): Promise<void> {
    this.rows.set(this.key(kind, resourceType, name), {
      profileKind: kind,
      resourceType,
      name,
      enabled,
      updatedAt: new Date().toISOString(),
    });
  }

  get(kind: ProfileKind, resourceType: ResourceType, name: string): ResourceStateData | undefined {
    return this.rows.get(this.key(kind, resourceType, name));
  }

  list(kind: ProfileKind, resourceType?: ResourceType): readonly ResourceStateData[] {
    return [...this.rows.values()].filter(
      (r) => r.profileKind === kind && (resourceType === undefined || r.resourceType === resourceType),
    );
  }

  async setModelSlot(kind: ProfileKind, model: string): Promise<void> {
    for (const r of this.list(kind, "model")) this.rows.delete(this.key(kind, "model", r.name));
    await this.upsert(kind, "model", model, true);
  }

  async clearModelSlot(kind: ProfileKind): Promise<void> {
    for (const r of this.list(kind, "model")) this.rows.delete(this.key(kind, "model", r.name));
  }

  modelSlot(kind: ProfileKind): string | undefined {
    return this.list(kind, "model")[0]?.name;
  }

  async setThinkingSlot(kind: ProfileKind, level: string): Promise<void> {
    for (const r of this.list(kind, "thinking")) this.rows.delete(this.key(kind, "thinking", r.name));
    await this.upsert(kind, "thinking", level, true);
  }

  async clearThinkingSlot(kind: ProfileKind): Promise<void> {
    for (const r of this.list(kind, "thinking")) this.rows.delete(this.key(kind, "thinking", r.name));
  }

  thinkingSlot(kind: ProfileKind): string | undefined {
    return this.list(kind, "thinking")[0]?.name;
  }
}

/** 可编程技能源假实现（createSkill 写面 stub——ResourceService 只消费 scan，创建链路归 skill-scanner.test）。 */
class FakeSkillSource implements SkillSourcePort {
  constructor(private current: SkillScanResult = { skills: SKILLS, diagnostics: [] }) {}
  async scan(): Promise<SkillScanResult> {
    return this.current;
  }
  async createSkill(): Promise<never> {
    throw new Error("FakeSkillSource.createSkill: not expected in ResourceService tests");
  }
}

function makeService(store = new InMemoryResourceState(), skills: SkillSourcePort = new FakeSkillSource()): {
  service: ResourceService;
  store: InMemoryResourceState;
} {
  return { service: new ResourceService({ store, skills, toolsCatalog: (kind) => TOOLS_CATALOG[kind], toolSnippets: TOOL_SNIPPETS }), store };
}

describe("ResourceService：list 合并视图", () => {
  test("① 无记录 = 工具全启用；技能按来源缺省（统一启停批：builtin 行为技能启用、user 显式启用制禁用）+ model 槽位未设", async () => {
    const { service } = makeService();
    const view = await service.list("main-session");
    expect(view.tools).toEqual(
      TOOLS_CATALOG["main-session"].map((name) => ({ name, enabled: true, snippet: TOOL_SNIPPETS[name] ?? "" })),
    );
    // SKILLS 全为 user 源：显式启用制（无行 = 禁用，装上不自动生效）
    expect(view.skills).toEqual(SKILLS.map((s) => ({ ...s, enabled: false })));
    expect(view.model).toBeUndefined();
  });

  test("⑩ list 透传扫描诊断（M6 T3 契约读面：坏文件 diagnostics 上抛不炸）", async () => {
    const skills = new FakeSkillSource({
      skills: [],
      diagnostics: [
        { code: "invalid_metadata", message: "SKILL.md 缺少 description", path: "/tmp/bad/SKILL.md", source: "user" },
      ],
    });
    const { service } = makeService(new InMemoryResourceState(), skills);
    const view = await service.list("main-session");
    expect(view.diagnostics).toEqual([
      { code: "invalid_metadata", message: "SKILL.md 缺少 description", path: "/tmp/bad/SKILL.md", source: "user" },
    ]);
  });

  test("② 禁用后 list 视图按行反映（tools/skills 双面；user 技能显式启用行兜底对照）", async () => {
    const { service } = makeService();
    await service.toggle("main-session", "tool", "grep", false);
    await service.toggle("main-session", "skill", "code-review", true); // user 技能显式启用
    await service.toggle("main-session", "skill", "deploy-helper", false);
    const view = await service.list("main-session");
    expect(view.tools.find((t) => t.name === "grep")?.enabled).toBe(false);
    expect(view.tools.find((t) => t.name === "bash")?.enabled).toBe(true);
    expect(view.skills.find((s) => s.name === "deploy-helper")?.enabled).toBe(false);
    expect(view.skills.find((s) => s.name === "code-review")?.enabled).toBe(true);
  });
});

describe("ResourceService：合取语义（全集 ∩ kind 启用集）", () => {
  test("③ 禁用 main 的 grep → main 生效集不含 grep，subagent-worker 不受影响", async () => {
    const { service } = makeService();
    await service.toggle("main-session", "tool", "grep", false);

    const mainTools = service.getEffectiveTools("main-session");
    expect(mainTools.includes("grep")).toBe(false);
    expect(mainTools.length).toBe(11); // 12 全集 - 1 禁用（T3-B +agent_inspect）

    // subagent 全集含 grep 且未禁 → 仍启用（kind 维隔离）
    const subTools = service.getEffectiveTools("subagent-worker");
    expect(subTools).toEqual([...TOOLS_CATALOG["subagent-worker"]]);

    // 双禁：subagent 也禁后才从 subagent 生效集消失
    await service.toggle("subagent-worker", "tool", "grep", false);
    expect(service.getEffectiveTools("subagent-worker").includes("grep")).toBe(false);
  });

  test("④ skills 合取：显式启用后禁 main 的 code-review → main 生效集收缩、subagent 不受影响", async () => {
    const { service } = makeService();
    // user 技能缺省禁用：两 kind 先显式启用，再验证合取与隔离
    for (const kind of ["main-session", "subagent-worker"] as const) {
      await service.toggle(kind, "skill", "code-review", true);
      await service.toggle(kind, "skill", "deploy-helper", true);
    }
    await service.toggle("main-session", "skill", "code-review", false);
    expect((await service.getEffectiveSkills("main-session")).map((s) => s.name)).toEqual(["deploy-helper"]);
    expect((await service.getEffectiveSkills("subagent-worker")).map((s) => s.name)).toEqual([
      "code-review",
      "deploy-helper",
    ]);
  });

  test("⑤ 生效技能返回完整描述符（T2 提示注入消费面：name/description/filePath/source）+ user 技能显式启用后进入", async () => {
    const { service } = makeService();
    expect(await service.getEffectiveSkills("main-session")).toEqual([]); // 显式启用制：无行 = 不生效
    await service.toggle("main-session", "skill", "code-review", true);
    await service.toggle("main-session", "skill", "deploy-helper", true);
    const skills = await service.getEffectiveSkills("main-session");
    expect(skills).toEqual(SKILLS);
  });

  test("⑥ 重启用（enabled=true）行落库后生效集复原", async () => {
    const { service } = makeService();
    await service.toggle("main-session", "tool", "grep", false);
    await service.toggle("main-session", "tool", "grep", true);
    expect(service.getEffectiveTools("main-session")).toEqual([...TOOLS_CATALOG["main-session"]]);
  });
});

describe("ResourceService：未知名 toggle 显式跳过", () => {
  test("⑦ subagent 禁 agent_spawn（不在其 profile 全集）→ skipped、零落库、生效集不受影响", async () => {
    const { service, store } = makeService();
    const outcome = await service.toggle("subagent-worker", "tool", "agent_spawn", false);
    expect(outcome).toEqual({ status: "skipped", reason: "unknown-name" });
    expect(store.rows.size).toBe(0);
    expect(service.getEffectiveTools("subagent-worker")).toEqual([...TOOLS_CATALOG["subagent-worker"]]);
  });

  test("⑧ 未安装技能名同样跳过；已知名 applied", async () => {
    const { service, store } = makeService();
    expect((await service.toggle("main-session", "skill", "not-installed", false)).status).toBe("skipped");
    expect((await service.toggle("main-session", "tool", "bash", false)).status).toBe("applied");
    expect(store.get("main-session", "tool", "bash")?.enabled).toBe(false);
  });
});

describe("ResourceService：thinking 槽位（thinking 批 AD-6 扩维，T1.3）", () => {
  test("三态：未配置 = undefined（缺省无记录）；set 后 list 视图与 thinkingSlot 读回；clear 复原", async () => {
    const { service } = makeService();
    // 未配置 = undefined（零配置兼容；kind 维合取语义不变）
    expect(service.thinkingSlot("subagent-worker")).toBeUndefined();
    const before = await service.list("subagent-worker");
    expect(before.thinkingLevel).toBeUndefined();
    // set → 读回（list 合并视图同点携带）
    await service.setThinkingSlot("subagent-worker", "xhigh");
    expect(service.thinkingSlot("subagent-worker")).toBe("xhigh");
    const after = await service.list("subagent-worker");
    expect(after.thinkingLevel).toBe("xhigh");
    // 覆写 = 原子替换（单行不变式）
    await service.setThinkingSlot("subagent-worker", "high");
    expect(service.thinkingSlot("subagent-worker")).toBe("high");
    // clear → 复原未配置
    await service.clearThinkingSlot("subagent-worker");
    expect(service.thinkingSlot("subagent-worker")).toBeUndefined();
  });

  test("kind 维合取不传染：subagent 设档不影响 main（隔离负断言）", async () => {
    const { service } = makeService();
    await service.setThinkingSlot("subagent-worker", "xhigh");
    expect(service.thinkingSlot("main-session")).toBeUndefined();
    expect((await service.list("main-session")).thinkingLevel).toBeUndefined();
    expect((await service.list("subagent-worker")).thinkingLevel).toBe("xhigh");
  });

  test("setEnabled 对 thinking 型 → 显式 skipped（槽位走 set/clearThinkingSlot API，不承载启停语义）", async () => {
    const { service, store } = makeService();
    const outcome = await service.setEnabled("subagent-worker", "thinking", "xhigh", true);
    expect(outcome).toEqual({ status: "skipped", reason: "thinking-uses-slot-api" });
    expect(store.list("subagent-worker", "thinking")).toEqual([]); // 零落库
  });
});

describe("ResourceService：model 槽位", () => {
  test("⑨ 未设 = undefined；set 后 list 视图与 modelSlot 读回；clear 复原；kind 隔离", async () => {
    const { service } = makeService();
    expect(service.modelSlot("main-session")).toBeUndefined();

    await service.setModel("main-session", "anthropic/claude-sonnet-4-5");
    expect(service.modelSlot("main-session")).toBe("anthropic/claude-sonnet-4-5");
    expect((await service.list("main-session")).model).toBe("anthropic/claude-sonnet-4-5");
    // kind 隔离：subagent 槽位不受影响
    expect(service.modelSlot("subagent-worker")).toBeUndefined();

    await service.clearModel("main-session");
    expect(service.modelSlot("main-session")).toBeUndefined();
    expect((await service.list("main-session")).model).toBeUndefined();
  });
});

describe("ResourceService：builtin 技能不可禁用防护（T5 内置第三源）", () => {
  const BUILTIN: readonly SkillDescriptor[] = [
    ...SKILLS,
    { name: "web-access", description: "联网操作指引", filePath: "/daemon/resources/skills/agent/web-access/SKILL.md", source: "builtin", audience: "agent" },
  ];

  test("⑪ setEnabled 对 builtin 技能 → skipped(builtin-immutable)、零落库、读面恒启用", async () => {
    const skills = new FakeSkillSource({ skills: BUILTIN, diagnostics: [] });
    const { service, store } = makeService(new InMemoryResourceState(), skills);

    const outcome = await service.setEnabled("main-session", "skill", "web-access", false);
    expect(outcome).toEqual({ status: "skipped", reason: "builtin-immutable" });
    expect(store.rows.size).toBe(0); // builtin 技能不进 resource_state（不可落禁用记录）

    // list 读面透传 source=builtin 且恒启用（缺省无记录 = 启用，天然覆盖）
    const view = await service.list("main-session");
    const row = view.skills.find((s) => s.name === "web-access");
    expect(row).toBeDefined();
    expect(row!.source).toBe("builtin");
    expect(row!.enabled).toBe(true);

    // 生效集恒含 builtin 技能（toggle 防护后重试也不受影响）
    expect((await service.getEffectiveSkills("main-session")).map((s) => s.name)).toContain("web-access");

    // 再试启用（enabled=true）同样 skipped——builtin 面不产生任何状态行
    expect(await service.toggle("main-session", "skill", "web-access", true)).toEqual({
      status: "skipped",
      reason: "builtin-immutable",
    });
    expect(store.rows.size).toBe(0);
    // user/project 技能不受防护影响（applied 先例保持）
    expect((await service.toggle("main-session", "skill", "code-review", false)).status).toBe("applied");
  });
});

describe("ResourceService：统一启停模型（拆 audience×kind 双轨批）", () => {
  const AUDIENCED: readonly SkillDescriptor[] = [
    { name: "web-access", description: "联网操作指引", filePath: "/b/agent/web-access/SKILL.md", source: "builtin", audience: "agent" },
    { name: "kg-bootstrap", description: "知识图谱批量创建", filePath: "/b/task/kg-bootstrap/SKILL.md", source: "builtin", audience: "task" },
    { name: "user-skill", description: "用户技能", filePath: "/u/user-skill/SKILL.md", source: "user", audience: "agent" },
  ];

  test("⑫ kind 维缺省（编排归位批）：main/sub builtin 行为技能缺省启用 + user 显式启用制；orchestrator 技能面缺省全禁（变相禁用，写面只读在 handler 层）；task 类不进任何 kind 生效集", async () => {
    const { service } = makeService(new InMemoryResourceState(), new FakeSkillSource({ skills: AUDIENCED, diagnostics: [] }));
    for (const kind of ["main-session", "subagent-worker"] as const) {
      const effective = await service.getEffectiveSkills(kind);
      // builtin∧agent 缺省启用；task（目录二分）/user（显式启用制）不生效
      expect(effective.map((s) => s.name)).toEqual(["web-access"]);
    }
    // orchestrator：kind 缺省全禁 → 技能段恒空（builtin/user 均不生效；
    // task 类目录二分本就不进生效集）
    expect(await service.getEffectiveSkills("orchestrator")).toEqual([]);
    // task 类 SOP 写面只读：audience-guard skipped（任何 kind、任何 enabled 值）
    expect(await service.setEnabled("main-session", "skill", "kg-bootstrap", true)).toEqual({ status: "skipped", reason: "audience-guard" });
    // user 技能显式启用 → main 生效；orchestrator 经显式启用行也可生效
    //（store 差异行优先于 kind 缺省——加载链同构，只读由写面拒绝承担）
    expect(await service.setEnabled("main-session", "skill", "user-skill", true)).toEqual({ status: "applied" });
    expect((await service.getEffectiveSkills("main-session")).map((s) => s.name).sort()).toEqual(["user-skill", "web-access"]);
  });

  test("⑬ 读面：任务 SOP 不进 agent kind 技能清单（目录二分）；orchestrator 清单全量携带（其系统块技能区 = 任务 SOP 注册表）", async () => {
    const { service } = makeService(new InMemoryResourceState(), new FakeSkillSource({ skills: AUDIENCED, diagnostics: [] }));
    const view = await service.list("main-session");
    expect(view.skills.find((s) => s.name === "kg-bootstrap")).toBeUndefined(); // task 类不进 agent 卡
    expect(view.skills.find((s) => s.name === "web-access")?.enabled).toBe(true);
    expect(view.skills.find((s) => s.name === "user-skill")?.enabled).toBe(false);
    // orchestrator：全量携带（含 task 类——注册表展示数据源），kind 缺省全禁
    const orchView = await service.list("orchestrator");
    expect(orchView.skills.find((s) => s.name === "kg-bootstrap")?.audience).toBe("task");
    expect(orchView.skills.every((s) => !s.enabled)).toBe(true);
  });
});

describe("ResourceService：skills+tools 成套装配（批三裁决）", () => {
  const BUNDLED: readonly SkillDescriptor[] = [
    { name: "web-access", description: "联网操作指引", filePath: "/b/agent/web-access/SKILL.md", source: "builtin", audience: "agent" },
    {
      name: "plan-workflow",
      description: "工作台账使用规范",
      filePath: "/b/agent/plan-workflow/SKILL.md",
      source: "builtin",
      audience: "agent",
      tools: ["plan_create", "plan_update", "plan_read"],
    },
  ];

  test("⑭ 持全部成套工具的 kind → 技能列出；缺任一成套工具的 kind → 技能随之下线（SOP 与工具不拆开出现）", async () => {
    const skills = new FakeSkillSource({ skills: BUNDLED, diagnostics: [] });
    const store = new InMemoryResourceState();
    const { service } = makeService(store, skills);
    // makeService 的 toolsCatalog 两 kind 仅含 bash——plan 三工具缺席 → plan-workflow 下线，web-access（未声明成套）恒在
    for (const kind of ["main-session", "subagent-worker"] as const) {
      const effective = await service.getEffectiveSkills(kind);
      expect(effective.map((s) => s.name)).toEqual(["web-access"]);
    }
  });

  test("⑮ 生效工具集含 plan 三工具 → plan-workflow 列出；禁用其中一件 → 技能联动下线", async () => {
    const skills = new FakeSkillSource({ skills: BUNDLED, diagnostics: [] });
    const store = new InMemoryResourceState();
    const service = new ResourceService({
      store,
      skills,
      toolsCatalog: (kind: ProfileKind): readonly string[] =>
        (
          {
            "main-session": ["bash", "plan_create", "plan_update", "plan_read"],
            "subagent-worker": ["bash", "plan_create", "plan_update", "plan_read"],
            "task-worker": ["bash", "plan_create", "plan_update", "plan_read"],
            "subagent-kg-writer": ["bash"],
            "subagent-code-reviewer": ["bash"],
            orchestrator: ["bash", "plan_read"], // 仅 plan_read 非全套 → 不成套（且 orchestrator 技能面恒空）
          } as Record<ProfileKind, readonly string[]>
        )[kind] ?? [],
      toolSnippets: {},
    });
    expect((await service.getEffectiveSkills("main-session")).map((s) => s.name).sort()).toEqual(["plan-workflow", "web-access"]);
    await service.setEnabled("main-session", "tool", "plan_read", false);
    expect((await service.getEffectiveSkills("main-session")).map((s) => s.name)).toEqual(["web-access"]);
  });
});

// ── server 级配置面批：mcp-server 差异行（per-kind server 启停门控） ──

const MCP_SERVERS: Partial<Record<ProfileKind, readonly { name: string; state: string; toolCount?: number }[]>> = {
  "main-session": [{ name: "shadcn", state: "running", toolCount: 2 }],
  "subagent-worker": [{ name: "shadcn", state: "running", toolCount: 2 }],
};

function makeMcpService(store = new InMemoryResourceState()) {
  return {
    service: new ResourceService({
      store,
      skills: new FakeSkillSource(),
      toolsCatalog: (kind) => [...TOOLS_CATALOG[kind], "shadcn__echo", "shadcn__discover"],
      effectiveToolsCatalog: (kind) => [...TOOLS_CATALOG[kind], "shadcn__discover"],
      mcpServersOf: (kind) => MCP_SERVERS[kind] ?? [],
      toolSnippetOf: (name) => (name === "shadcn__echo" ? "回声工具（MCP description 透传）" : undefined),
      toolSnippets: {},
    }),
    store,
  };
}

describe("ResourceService：mcp-server 差异行（server 级配置面）", () => {
  test("① list 携带 server 行 + enabled 差异行合取（缺省无记录 = 启用）", async () => {
    const { service, store } = makeMcpService();
    const block = await service.list("main-session");
    expect(block.mcpServers).toEqual([{ name: "shadcn", state: "running", toolCount: 2, enabled: true }]);
    await store.upsert("main-session", "mcp-server", "shadcn", false);
    expect((await service.list("main-session")).mcpServers).toEqual([{ name: "shadcn", state: "running", toolCount: 2, enabled: false }]);
  });

  test("② list：toolSnippetOf 优先于静态注册表（MCP 行 description 透传）", async () => {
    const { service } = makeMcpService();
    const block = await service.list("main-session");
    expect(block.tools.find((t) => t.name === "shadcn__echo")?.snippet).toBe("回声工具（MCP description 透传）");
    expect(block.tools.find((t) => t.name === "shadcn__discover")?.snippet).toBe(""); // 动态面无值回落注册表空串
  });

  test("③ setEnabled mcp-server：全集内 applied 落库；全集外 unknown-mcp-server skipped", async () => {
    const { service, store } = makeMcpService();
    expect(await service.setEnabled("main-session", "mcp-server", "shadcn", false)).toEqual({ status: "applied" });
    expect(store.get("main-session", "mcp-server", "shadcn")?.enabled).toBe(false);
    expect(await service.setEnabled("main-session", "mcp-server", "ghost", false)).toEqual({ status: "skipped", reason: "unknown-mcp-server" });
    expect(store.get("main-session", "mcp-server", "ghost")).toBeUndefined();
  });

  test("④ setEnabled：mcpServersOf 未注入（零 MCP daemon）恒 skipped", async () => {
    const { service } = makeService();
    expect(await service.setEnabled("main-session", "mcp-server", "shadcn", false)).toEqual({ status: "skipped", reason: "unknown-mcp-server" });
  });

  test("⑤ getEffectiveTools：server 关 ⇒ 该前缀整组出局（含 meta），静态工具与其它 server 不受影响", async () => {
    const { service, store } = makeMcpService();
    // deferred 语义：生效集 = 静态 + shadcn__discover（meta）
    expect(service.getEffectiveTools("main-session")).toContain("shadcn__discover");
    expect(service.getEffectiveTools("main-session")).not.toContain("shadcn__echo");
    await store.upsert("main-session", "mcp-server", "shadcn", false);
    const effective = service.getEffectiveTools("main-session");
    expect(effective).not.toContain("shadcn__discover"); // meta 同出局
    expect(effective).not.toContain("shadcn__echo");
    expect(effective).toContain("bash"); // 静态工具不受影响
  });

  test("⑥ kind 隔离：main 关不影响 subagent-worker", async () => {
    const { service, store } = makeMcpService();
    await store.upsert("main-session", "mcp-server", "shadcn", false);
    expect(service.getEffectiveTools("subagent-worker")).toContain("shadcn__discover");
  });
});
