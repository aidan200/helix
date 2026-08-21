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
  "main-session": ["bash", "read", "write", "edit", "grep", "agent_spawn", "agent_send", "agent_status"],
  "subagent-worker": ["bash", "read", "write", "edit", "grep"],
};

/** 测试用 snippet 映射（单点注入；注册表外名 = 空串语义由缺省覆盖）。 */
const TOOL_SNIPPETS: Readonly<Record<string, string>> = {
  bash: "在沙箱工作目录执行 shell 命令并返回输出",
  grep: "跨文件正则检索并列出匹配行",
};

const SKILLS: readonly SkillDescriptor[] = [
  { name: "code-review", description: "审查代码变更质量", filePath: "/tmp/x/code-review/SKILL.md", source: "user" },
  { name: "deploy-helper", description: "部署流程向导", filePath: "/tmp/y/deploy-helper/SKILL.md", source: "project" },
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
}

/** 可编程技能源假实现。 */
class FakeSkillSource implements SkillSourcePort {
  constructor(private current: SkillScanResult = { skills: SKILLS, diagnostics: [] }) {}
  async scan(): Promise<SkillScanResult> {
    return this.current;
  }
}

function makeService(store = new InMemoryResourceState(), skills: SkillSourcePort = new FakeSkillSource()): {
  service: ResourceService;
  store: InMemoryResourceState;
} {
  return { service: new ResourceService({ store, skills, toolsCatalog: TOOLS_CATALOG, toolSnippets: TOOL_SNIPPETS }), store };
}

describe("ResourceService：list 合并视图", () => {
  test("① 无记录 = 三类全启用（零配置兼容现状）+ model 槽位未设", async () => {
    const { service } = makeService();
    const view = await service.list("main-session");
    expect(view.tools).toEqual(
      TOOLS_CATALOG["main-session"].map((name) => ({ name, enabled: true, snippet: TOOL_SNIPPETS[name] ?? "" })),
    );
    expect(view.skills).toEqual(SKILLS.map((s) => ({ ...s, enabled: true })));
    expect(view.model).toBeUndefined();
  });

  test("⑩ list 透传扫描诊断（M6 T3 契约读面：坏文件 diagnostics 上抛不炸）", async () => {
    const skills = new FakeSkillSource({
      skills: [],
      diagnostics: [
        { code: "invalid_metadata", message: "SKILL.md 缺少 description", path: "/tmp/bad/SKILL.md", source: "project" },
      ],
    });
    const { service } = makeService(new InMemoryResourceState(), skills);
    const view = await service.list("main-session");
    expect(view.diagnostics).toEqual([
      { code: "invalid_metadata", message: "SKILL.md 缺少 description", path: "/tmp/bad/SKILL.md", source: "project" },
    ]);
  });

  test("② 禁用后 list 视图按行反映（tools/skills 双面）", async () => {
    const { service } = makeService();
    await service.toggle("main-session", "tool", "grep", false);
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
    expect(mainTools.length).toBe(7); // 8 全集 - 1 禁用

    // subagent 全集含 grep 且未禁 → 仍启用（kind 维隔离）
    const subTools = service.getEffectiveTools("subagent-worker");
    expect(subTools).toEqual([...TOOLS_CATALOG["subagent-worker"]]);

    // 双禁：subagent 也禁后才从 subagent 生效集消失
    await service.toggle("subagent-worker", "tool", "grep", false);
    expect(service.getEffectiveTools("subagent-worker").includes("grep")).toBe(false);
  });

  test("④ skills 合取：禁 main 的 code-review → main 生效技能空、subagent 不受影响", async () => {
    const { service } = makeService();
    await service.toggle("main-session", "skill", "code-review", false);
    expect((await service.getEffectiveSkills("main-session")).map((s) => s.name)).toEqual(["deploy-helper"]);
    expect((await service.getEffectiveSkills("subagent-worker")).map((s) => s.name)).toEqual([
      "code-review",
      "deploy-helper",
    ]);
  });

  test("⑤ 生效技能返回完整描述符（T2 提示注入消费面：name/description/filePath/source）", async () => {
    const { service } = makeService();
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
