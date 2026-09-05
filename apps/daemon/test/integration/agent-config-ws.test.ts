import { afterAll, describe, expect, test } from "bun:test";
import { TOOL_PROMPT_SNIPPETS } from "../../src/adapters/driven/tools/ToolPromptSnippets";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { createTestDaemon } from "../helpers/createTestDaemon";
import { createPaths } from "../../src/infrastructure/paths";
import { FakeAgentEngine } from "../mocks/FakeAgentEngine";
import { PROTOCOL_VERSION, SYSTEM_SESSION_ID, type FrameVersion } from "@helix/protocol";

/**
 * M6 T3 agent.config 命令族全链集成（真组合根 + FakeAgentEngine + 真 SQLite
 * + loopback WS；模型目录走 builtin 读面零网络——hasModel 不触远端）：
 * - ① agent.config.list 全 kind / 单 kind → 结果帧数据（tools 全集+启停态；
 *   skills 含 source；diagnostics 坏文件上抛；model 槽位 null 形态）；
 * - ② agent.config.set_enabled 四路径：applied（含 agent.config.changed 广播
 *   发出断言）/ unknown-name skipped / model unknown-model skipped /
 *   model clear（changed name=null）；
 * - ③ 前置校验失败（非法 kind / 缺字段）→ connection.error invalid_payload。
 */

interface Frame {
  v: FrameVersion;
  type: string;
  payload: Record<string, unknown>;
  sessionId?: string;
  channel?: string;
}

class TestClient {
  readonly frames: Frame[] = [];
  private readonly ws: WebSocket;

  constructor(url: string) {
    this.ws = new WebSocket(url);
    this.ws.onmessage = (ev: MessageEvent) => {
      this.frames.push(JSON.parse(String(ev.data)));
    };
  }

  async open(timeoutMs = 3000): Promise<void> {
    await until(() => this.ws.readyState === WebSocket.OPEN, timeoutMs, "WS 连接建立");
  }

  send(obj: unknown): void {
    this.ws.send(JSON.stringify(obj));
  }

  async expect(type: string, timeoutMs = 3000): Promise<Frame> {
    await until(() => this.frames.some((f) => f.type === type), timeoutMs, `等待帧 ${type}（已收：${this.frames.map((f) => f.type).join(",")}）`);
    return this.frames.find((f) => f.type === type)!;
  }

  /** afterIndex 之后的指定 type 首帧（区分同型帧新旧）。 */
  async expectAfter(type: string, afterIndex: number, timeoutMs = 3000): Promise<Frame> {
    await until(() => this.frames.slice(afterIndex).some((f) => f.type === type), timeoutMs, `等待新帧 ${type}`);
    return this.frames.slice(afterIndex).find((f) => f.type === type)!;
  }

  /** 等待 invalid_payload 回执（含命令名文案锚点）。 */
  async waitForInvalidPayload(cmdType: string, timeoutMs = 3000): Promise<Frame> {
    const at = this.frames.length;
    await until(
      () =>
        this.frames
          .slice(at)
          .some((f) => f.type === "connection.error" && f.payload.code === "command.invalid_payload"),
      timeoutMs,
      `等待 invalid_payload（${cmdType}）`,
    );
    const frame = this.frames.slice(at).find(
      (f) => f.type === "connection.error" && f.payload.code === "command.invalid_payload",
    )!;
    expect(String(frame.payload.message)).toContain(cmdType);
    return frame;
  }

  async close(): Promise<void> {
    if (this.ws.readyState === WebSocket.OPEN) this.ws.close();
  }
}

/** hello 握手（T4：命中零条目内存草稿 → welcome.draft 时不推快照，显式订阅；同 ws-server.test 先例）。 */
async function helloHandshake(client: TestClient, token: string): Promise<void> {
  client.send({ v: PROTOCOL_VERSION, type: "hello", payload: { token, protocolVersion: PROTOCOL_VERSION } });
  await client.expect("connection.welcome");
  client.send({ v: 0, type: "session.subscribe", payload: {} });
}

async function until(cond: () => boolean, timeoutMs: number, what: string): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > timeoutMs) throw new Error(`等待超时：${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

const tmpRoots: string[] = [];

function tmpHome(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "helix-agent-config-it-"));
  tmpRoots.push(dir); // 泄漏修复：全部 tmp 目录进跟踪，afterAll 统一清（含 builtinSkillsDir 隔离目录）
  return dir;
}

afterAll(() => {
  for (const d of tmpRoots) rmSync(d, { recursive: true, force: true });
});

interface ProfileBlock {
  profileKind: string;
  tools: { name: string; enabled: boolean; snippet: string }[];
  skills: { name: string; description: string; filePath: string; source: string; audience: string; enabled: boolean }[];
  diagnostics: { code: string; message: string; path: string; source: string }[];
  model: string | null;
  thinkingLevel: string | null; // v0.11 批内补登（T1.3）
}

interface Rig {
  home: string;
  daemon: Awaited<ReturnType<typeof createTestDaemon>>;
  token: string;
  url: string;
  dispose: () => Promise<void>;
}

/** 组合根装配（随机端口；user 层技能预播种：好技能 + 坏文件）。 */
async function makeRig(): Promise<Rig> {
  const home = tmpHome();
  const workspace = tmpHome(); // project 层根（toolCwd 注入定向 tmp，与 resource-wiring 同法）
  const goodDir = path.join(createPaths(home).skillsHome(), "hello-skill");
  mkdirSync(goodDir, { recursive: true });
  writeFileSync(
    path.join(goodDir, "SKILL.md"),
    "---\nname: hello-skill\ndescription: 问候技能\n---\n\n正文",
    "utf8",
  );
  const badDir = path.join(createPaths(home).skillsHome(), "broken-skill");
  mkdirSync(badDir, { recursive: true });
  // 坏文件：缺 description → invalid_metadata 诊断（不产技能不炸）
  writeFileSync(path.join(badDir, "SKILL.md"), "---\nname: broken-skill\n---\n\n正文", "utf8");

  const builtinDir = tmpHome();
  const engine = new FakeAgentEngine({});
  const daemon = await createTestDaemon({
    home,
    engine,
    skipConfig: true,
    port: 0,
    cliInput: new PassThrough(),
    cliOutput: new PassThrough(),
    toolCwd: workspace,
    builtinSkillsDir: builtinDir, // T5：空目录隔离随仓内置技能（恰等断言不感知 builtin 面；tmpHome 跟踪内）
  });
  const token = readFileSync(path.join(home, "dev-token"), "utf8");
  return {
    home,
    daemon,
    token,
    url: `ws://127.0.0.1:${daemon.ws.port}`,
    dispose: async () => {
      await daemon.shutdown();
      rmSync(home, { recursive: true, force: true });
      rmSync(workspace, { recursive: true, force: true });
    },
  };
}

const MAIN_TOOLS = [
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
  "agent_park", // ⑤ 链 C：挂起（P1 仅 main）
  "agent_resume", // ⑤ 链 C：恢复（P1 仅 main）
  "browser",
  "kg", // T3.3：kg 双工具
  "kg-update",
  "codegraph", // W1-B（R5/R7）：codegraph 只读工具
  "task_create", // T2.4：chat 第二创建入口（AD-7，仅 main）
  "task_report", // D3：chat 回流通用报告查询面（仅 main）
  "plan_create", // main-session plan 批：主会话同含 plan 三名（两域同构）
  "plan_update",
  "plan_read",
];
const SUB_TOOLS = ["bash", "read", "write", "edit", "grep", "web_search", "web_fetch", "browser", "kg", "codegraph", "plan_create", "plan_update", "plan_read"]; // H-3：+browser（wire 转发通道接 daemon CDP 单例）；T3.3：+kg；T1.4：+plan 三工具（AD-6①；main-session plan 批起 Main 同含——两域同构）；W1-B：+codegraph；D8 W-R6：-kg-update（写面收权）
/** agent-roster 批：只读系统派生块三序（orchestrator 在前，reviewer 在后）。OrchestratorProfile.tools 声明全集同源（D6：+write 任务产物落盘）。 */
const ORCH_TOOLS = [
  "bash",
  "read",
  "grep",
  "write", // D6：任务报告目录内产物落盘（任务级汇总报告）——不加 edit
  "agent_spawn",
  "plan_read",
  "kg",
  "task_insert_batch",
  "task_dispatch_batch",
  "task_advance_stage",
  "task_stage_artifact",
  "task_complete_job",
  "task_fail_job",
];
/** builtin 目录内模型（model-provider.DEFAULT_MODEL_ID 同源；hasModel 读面零网络）。 */
const ANY_MODEL = "anthropic/claude-sonnet-4-5";

describe("agent.config.list（v0.6 全局命令；点对点结果帧）", () => {
  test("① 全 kind：双块（tools 全集+启停态；skills 含 source；diagnostics 坏文件上抛；model null）", async () => {
    const rig = await makeRig();
    const client = new TestClient(rig.url);
    try {
      await client.open();
      await helloHandshake(client, rig.token);
      await client.expect("session.snapshot");

      client.send({ v: PROTOCOL_VERSION, type: "agent.config.list", payload: {} });
      const result = await client.expect("agent.config.list.result");
      expect(result.v).toBe(PROTOCOL_VERSION);
      expect(result.channel).toBe("agent");
      expect(result.sessionId).toBe(SYSTEM_SESSION_ID); // 全局命令：会话无关
      const profiles = result.payload.profiles as ProfileBlock[];
      expect(profiles).toHaveLength(2);
      const [main, sub] = profiles;
      expect(main!.profileKind).toBe("main-session");
      expect(main!.tools.map((t) => t.name)).toEqual(MAIN_TOOLS);
      expect(main!.tools.every((t) => t.enabled)).toBe(true); // 缺省无记录 = 全启用
      // tools 行 snippet 一句话说明（ToolPromptSnippets 注册表同源；M6 T4 补登）
      const bashRow = main!.tools.find((t) => t.name === "bash")!;
      expect(bashRow.snippet).toBe(TOOL_PROMPT_SNIPPETS["bash"]!);
      expect(main!.tools.every((t) => t.snippet.length > 0)).toBe(true);
      expect(main!.skills).toEqual([
        {
          name: "hello-skill",
          description: "问候技能",
          filePath: expect.stringContaining("hello-skill"),
          source: "user",
          audience: "agent", // user/project 层恒为 agent 类（audience 分类注入，批二）
          enabled: true,
        },
      ]);
      expect(main!.diagnostics).toEqual([
        {
          code: expect.stringContaining("metadata"),
          message: expect.any(String),
          path: expect.stringContaining("broken-skill"),
          source: "user",
        },
      ]);
      expect(main!.model).toBeNull(); // 槽位未设 = null（非 undefined——JSON 面）
      expect(sub!.profileKind).toBe("subagent-worker");
      expect(sub!.tools.map((t) => t.name)).toEqual(SUB_TOOLS);
      expect(sub!.model).toBeNull();
    } finally {
      await client.close();
      await rig.dispose();
    }
  });

  test("② 单 kind：payload.profileKind 过滤 → 单块", async () => {
    const rig = await makeRig();
    const client = new TestClient(rig.url);
    try {
      await client.open();
      await helloHandshake(client, rig.token);

      client.send({
        v: PROTOCOL_VERSION,
        type: "agent.config.list",
        payload: { profileKind: "subagent-worker" },
      });
      const result = await client.expect("agent.config.list.result");
      const profiles = result.payload.profiles as ProfileBlock[];
      expect(profiles).toHaveLength(1);
      expect(profiles[0]!.profileKind).toBe("subagent-worker");
      expect(profiles[0]!.tools.map((t) => t.name)).toEqual(SUB_TOOLS);
      // 单 kind 过滤请求不携带 system（agent-roster 批：可选块零变化面）
      expect(result.payload.system).toBeUndefined();
    } finally {
      await client.close();
      await rig.dispose();
    }
  });

  // ── agent-roster 批：只读系统派生块读面 ──
  interface SystemBlock {
    profileKind: string;
    tools: { name: string; snippet: string }[];
    // 系统派生块技能读面批：五字段纯展示行（无启停位）
    skills?: { name: string; description: string; filePath: string; source: string; audience: string }[];
    derivedFrom?: string;
    pinnedTools?: string[];
  }

  test("②a 全量 list 携带 system 双块：orchestrator 声明全集 / kg-writer = worker 生效集 + kg-update（派生说明位）", async () => {
    const rig = await makeRig();
    const client = new TestClient(rig.url);
    try {
      await client.open();
      await helloHandshake(client, rig.token);

      client.send({ v: PROTOCOL_VERSION, type: "agent.config.list", payload: {} });
      const result = await client.expect("agent.config.list.result");
      const system = result.payload.system as SystemBlock[];
      expect(system).toHaveLength(3);
      // 序固定：orchestrator 在前、kg-writer 居中、reviewer 在后；无派生说明位
      const [orch, kgw, reviewer] = system;
      expect(orch!.profileKind).toBe("orchestrator");
      expect(orch!.tools.map((t) => t.name)).toEqual(ORCH_TOOLS);
      expect(orch!.derivedFrom).toBeUndefined();
      expect(orch!.pinnedTools).toBeUndefined();
      // 纯展示行形状：name + snippet（无启停位）；snippet 注册表同源
      expect(orch!.tools.every((t) => typeof t.snippet === "string")).toBe(true);
      const orchBash = orch!.tools.find((t) => t.name === "bash")!;
      expect(orchBash.snippet).toBe(TOOL_PROMPT_SNIPPETS["bash"]!);
      // kg-writer：worker 生效集（缺省全启用）+ kg-update 恒在 + 派生说明位
      expect(kgw!.profileKind).toBe("subagent-kg-writer");
      expect(kgw!.derivedFrom).toBe("subagent-worker");
      expect(kgw!.pinnedTools).toEqual(["kg-update"]);
      expect(kgw!.tools.map((t) => t.name)).toEqual([...SUB_TOOLS, "kg-update"]);
      // kg-update snippet 注册表同源（main 目录面同名行单源取回）
      const kgUpdate = kgw!.tools.find((t) => t.name === "kg-update")!;
      expect(kgUpdate.snippet).toContain("知识图谱即时落账");
      // D5 reviewer：worker 生效集（缺省全启用）− write/edit 恒摘除 + 派生说明位（代码写面机械关闭）
      expect(reviewer!.profileKind).toBe("subagent-code-reviewer");
      expect(reviewer!.derivedFrom).toBe("subagent-worker");
      expect(reviewer!.tools.map((t) => t.name)).toEqual(SUB_TOOLS.filter((n) => n !== "write" && n !== "edit"));
      expect(reviewer!.tools.map((t) => t.name)).not.toContain("write");
      expect(reviewer!.tools.map((t) => t.name)).not.toContain("edit");
      expect(reviewer!.tools.map((t) => t.name)).not.toContain("kg-update");
      // 系统派生块技能读面批（空 builtin 目录隔离形态）：orchestrator = 任务
      // SOP 注册表 = 空；kg-writer/reviewer = worker 生效技能集 = user 层
      // hello-skill（audience=agent、无成套声明、启用）
      expect(orch!.skills).toEqual([]);
      const expectedWorkerSkills = [
        {
          name: "hello-skill",
          description: "问候技能",
          filePath: expect.stringContaining("hello-skill"),
          source: "user",
          audience: "agent",
        },
      ];
      expect(kgw!.skills).toEqual(expectedWorkerSkills);
      expect(reviewer!.skills).toEqual(expectedWorkerSkills);
      // 纯展示行无启停位（enabled 不携带）
      expect(Object.keys(kgw!.skills![0]!)).not.toContain("enabled");
    } finally {
      await client.close();
      await rig.dispose();
    }
  });

  // ── 系统派生块技能读面批：三块技能清单派生语义 ──

  /** builtin 目录播种 rig：task 层 SOP + agent 层两技能（成套声明分叉）。 */
  async function makeSeededRig(): Promise<Rig> {
    const home = tmpHome();
    const workspace = tmpHome();
    const builtinDir = tmpHome();
    const mk = (rel: string, frontmatter: string) => {
      const dir = path.join(builtinDir, rel);
      mkdirSync(dir, { recursive: true });
      writeFileSync(path.join(dir, "SKILL.md"), `${frontmatter}\n\n正文`, "utf8");
    };
    // task 层：audience=task（kickoff 消费面）
    mk(
      "task/demo-review",
      "---\nname: demo-review\ndescription: 演示任务 SOP\ntask:\n  paramsSchema:\n    projectRoot: { type: string, required: true }\n---",
    );
    // agent 层：无成套声明（恒列）+ 成套声明 plan_create（worker 持有 → 列出）
    mk("agent/plain-skill", "---\nname: plain-skill\ndescription: 无成套声明技能\n---");
    mk("agent/paired-skill", "---\nname: paired-skill\ndescription: 成套声明技能\ntools: [plan_create]\n---");
    const engine = new FakeAgentEngine({});
    const daemon = await createTestDaemon({
      home,
      engine,
      skipConfig: true,
      port: 0,
      cliInput: new PassThrough(),
      cliOutput: new PassThrough(),
      toolCwd: workspace,
      builtinSkillsDir: builtinDir,
    });
    const token = readFileSync(path.join(home, "dev-token"), "utf8");
    return {
      home,
      daemon,
      token,
      url: `ws://127.0.0.1:${daemon.ws.port}`,
      dispose: async () => {
        await daemon.shutdown();
        rmSync(home, { recursive: true, force: true });
        rmSync(workspace, { recursive: true, force: true });
      },
    };
  }

  test("②c 系统块技能清单：orchestrator = builtin∧task SOP 注册表；kg-writer/reviewer = worker 生效技能集（成套装配跟随）", async () => {
    const rig = await makeSeededRig();
    const client = new TestClient(rig.url);
    try {
      await client.open();
      await helloHandshake(client, rig.token);

      client.send({ v: PROTOCOL_VERSION, type: "agent.config.list", payload: {} });
      const result = await client.expect("agent.config.list.result");
      const system = result.payload.system as SystemBlock[];
      const orch = system.find((b) => b.profileKind === "orchestrator")!;
      const kgw = system.find((b) => b.profileKind === "subagent-kg-writer")!;
      // orchestrator：任务 SOP 注册表（audience=task∧builtin）——agent 层技能不入此面
      expect(orch.skills?.map((s) => s.name)).toEqual(["demo-review"]);
      expect(orch.skills![0]!.audience).toBe("task");
      // kg-writer/reviewer：worker 生效技能集（audience=agent；成套声明
      // paired-skill 的 plan_create 在 worker 生效集 → 列出）
      expect(kgw.skills?.map((s) => s.name).sort()).toEqual(["paired-skill", "plain-skill"]);
      expect(kgw.skills!.every((s) => s.audience === "agent")).toBe(true);

      // 禁用 worker 的 plan_create（成套工具）→ paired-skill 联动下线，重 list 生效
      client.send({
        v: PROTOCOL_VERSION,
        type: "agent.config.set_enabled",
        payload: { profileKind: "subagent-worker", resourceType: "tool", name: "plan_create", enabled: false },
      });
      await client.expect("agent.config.set_enabled.result");
      const at = client.frames.length; // 区分新旧同型帧：重拉后的新 list 帧
      client.send({ v: PROTOCOL_VERSION, type: "agent.config.list", payload: {} });
      const after = await client.expectAfter("agent.config.list.result", at);
      const systemAfter = after.payload.system as SystemBlock[];
      const kgwAfter = systemAfter.find((b) => b.profileKind === "subagent-kg-writer")!;
      // 成套装配单点（ResourceService.getEffectiveSkills）：SOP 与工具不拆开出现
      expect(kgwAfter.skills?.map((s) => s.name)).toEqual(["plain-skill"]);
      // orchestrator SOP 注册表不受 worker toggle 影响
      const orchAfter = systemAfter.find((b) => b.profileKind === "orchestrator")!;
      expect(orchAfter.skills?.map((s) => s.name)).toEqual(["demo-review"]);
    } finally {
      await client.close();
      await rig.dispose();
    }
  });

  test("②b kg-writer 工具清单动态跟随 worker toggle：禁用 worker 工具 → 重 list → 生效集收窄", async () => {
    const rig = await makeRig();
    const client = new TestClient(rig.url);
    try {
      await client.open();
      await helloHandshake(client, rig.token);

      // 禁用 worker 的 grep（agent.config.changed 全局广播不阻塞回执序）
      client.send({
        v: PROTOCOL_VERSION,
        type: "agent.config.set_enabled",
        payload: { profileKind: "subagent-worker", resourceType: "tool", name: "grep", enabled: false },
      });
      await client.expect("agent.config.set_enabled.result");
      client.send({ v: PROTOCOL_VERSION, type: "agent.config.list", payload: {} });
      const result = await client.expect("agent.config.list.result");
      const system = result.payload.system as SystemBlock[];
      const kgw = system.find((b) => b.profileKind === "subagent-kg-writer")!;
      // 生效集收窄：grep 退出，kg-update 仍恒在
      expect(kgw.tools.map((t) => t.name)).toEqual([...SUB_TOOLS.filter((n) => n !== "grep"), "kg-update"]);
      // kind 隔离：orchestrator 声明全集不受 worker toggle 影响（grep 仍在）
      const orch = system.find((b) => b.profileKind === "orchestrator")!;
      expect(orch.tools.map((t) => t.name)).toContain("grep");
      // D5 reviewer：随 worker toggle 动态跟随（grep 退出），write/edit 恒不在面
      const reviewer = system.find((b) => b.profileKind === "subagent-code-reviewer")!;
      expect(reviewer.tools.map((t) => t.name)).toEqual(
        SUB_TOOLS.filter((n) => n !== "write" && n !== "edit" && n !== "grep"),
      );
    } finally {
      await client.close();
      await rig.dispose();
    }
  });
});

describe("agent.config.set_enabled（v0.6 全局命令；四路径回执形态）", () => {
  test("③ applied：tool 禁用 → 结果帧 applied + agent.config.changed 广播 + 落库生效", async () => {
    const rig = await makeRig();
    const client = new TestClient(rig.url);
    try {
      await client.open();
      await helloHandshake(client, rig.token);

      client.send({
        v: PROTOCOL_VERSION,
        type: "agent.config.set_enabled",
        payload: { profileKind: "main-session", resourceType: "tool", name: "grep", enabled: false },
      });
      const applied = await client.expect("agent.config.set_enabled.result");
      expect(applied.payload).toEqual({ status: "applied" });
      // applied → 广播发出（发起连接同收：daemon 级全局配置，订阅无关全连接）
      const changed = await client.expectAfter("agent.config.changed", client.frames.indexOf(applied));
      expect(changed.channel).toBe("agent");
      expect(changed.sessionId).toBe(SYSTEM_SESSION_ID);
      expect(changed.payload).toEqual({
        profileKind: "main-session",
        resourceType: "tool",
        name: "grep",
        enabled: false,
      });
      // 落库生效（合取面收窄；T2 刷新链既有测试面，此处只验数据域）
      expect(rig.daemon.resource.getEffectiveTools("main-session").includes("grep")).toBe(false);
      expect(rig.daemon.resource.getEffectiveTools("subagent-worker").includes("grep")).toBe(true);
    } finally {
      await client.close();
      await rig.dispose();
    }
  });

  test("④ unknown-name skipped：全集外名（subagent 禁 agent_spawn）→ skipped 回执 + 零广播零落库", async () => {
    const rig = await makeRig();
    const client = new TestClient(rig.url);
    try {
      await client.open();
      await helloHandshake(client, rig.token);

      client.send({
        v: PROTOCOL_VERSION,
        type: "agent.config.set_enabled",
        payload: { profileKind: "subagent-worker", resourceType: "tool", name: "agent_spawn", enabled: false },
      });
      const skipped = await client.expect("agent.config.set_enabled.result");
      expect(skipped.payload).toEqual({ status: "skipped", reason: "unknown-name" });
      await new Promise((r) => setTimeout(r, 150));
      expect(client.frames.filter((f) => f.type === "agent.config.changed")).toHaveLength(0); // skipped 零广播
    } finally {
      await client.close();
      await rig.dispose();
    }
  });

  test("⑤ model unknown-model skipped：目录外模型 → skipped 回执 + 零广播（ModelService.setModel 先例）", async () => {
    const rig = await makeRig();
    const client = new TestClient(rig.url);
    try {
      await client.open();
      await helloHandshake(client, rig.token);

      client.send({
        v: PROTOCOL_VERSION,
        type: "agent.config.set_enabled",
        payload: { profileKind: "main-session", resourceType: "model", name: "nope/no-such-model", enabled: true },
      });
      const skipped = await client.expect("agent.config.set_enabled.result");
      expect(skipped.payload).toEqual({ status: "skipped", reason: "unknown-model" });
      await new Promise((r) => setTimeout(r, 150));
      expect(client.frames.filter((f) => f.type === "agent.config.changed")).toHaveLength(0);
      expect(rig.daemon.resource.modelSlot("main-session")).toBeUndefined(); // 未落库
    } finally {
      await client.close();
      await rig.dispose();
    }
  });

  test("⑥⑦ model set/clear：set → applied+changed(name=id)；clear → applied+changed(name=null)；list 槽位往返", async () => {
    const rig = await makeRig();
    const client = new TestClient(rig.url);
    try {
      await client.open();
      await helloHandshake(client, rig.token);

      // set 槽位
      client.send({
        v: PROTOCOL_VERSION,
        type: "agent.config.set_enabled",
        payload: { profileKind: "subagent-worker", resourceType: "model", name: ANY_MODEL, enabled: true },
      });
      const set = await client.expect("agent.config.set_enabled.result");
      expect(set.payload).toEqual({ status: "applied" });
      const changedSet = await client.expectAfter("agent.config.changed", client.frames.indexOf(set));
      expect(changedSet.payload).toEqual({
        profileKind: "subagent-worker",
        resourceType: "model",
        name: ANY_MODEL,
        enabled: true,
      });
      expect(rig.daemon.resource.modelSlot("subagent-worker")).toBe(ANY_MODEL);

      // clear 槽位
      client.send({
        v: PROTOCOL_VERSION,
        type: "agent.config.set_enabled",
        payload: { profileKind: "subagent-worker", resourceType: "model", name: "-", enabled: false },
      });
      const clear = await client.expectAfter("agent.config.set_enabled.result", client.frames.indexOf(changedSet));
      expect(clear.payload).toEqual({ status: "applied" });
      const changedClear = await client.expectAfter("agent.config.changed", client.frames.indexOf(clear));
      expect(changedClear.payload).toEqual({
        profileKind: "subagent-worker",
        resourceType: "model",
        name: null, // clear = name null
        enabled: false,
      });
      expect(rig.daemon.resource.modelSlot("subagent-worker")).toBeUndefined();

      // list 槽位现状随写面往返（set → 读回 → clear → null）
      client.send({
        v: PROTOCOL_VERSION,
        type: "agent.config.set_enabled",
        payload: { profileKind: "main-session", resourceType: "model", name: ANY_MODEL, enabled: true },
      });
      await client.expectAfter("agent.config.set_enabled.result", client.frames.indexOf(changedClear));
      client.send({ v: PROTOCOL_VERSION, type: "agent.config.list", payload: { profileKind: "main-session" } });
      const list1 = await client.expectAfter("agent.config.list.result", client.frames.length - 1);
      expect((list1.payload.profiles as ProfileBlock[])[0]!.model).toBe(ANY_MODEL);
      client.send({
        v: PROTOCOL_VERSION,
        type: "agent.config.set_enabled",
        payload: { profileKind: "main-session", resourceType: "model", name: "-", enabled: false },
      });
      await client.expectAfter("agent.config.set_enabled.result", client.frames.length - 1);
      client.send({ v: PROTOCOL_VERSION, type: "agent.config.list", payload: { profileKind: "main-session" } });
      const list2 = await client.expectAfter("agent.config.list.result", client.frames.length - 1);
      expect((list2.payload.profiles as ProfileBlock[])[0]!.model).toBeNull();
    } finally {
      await client.close();
      await rig.dispose();
    }
  });

  test("⑧ skill applied：已装技能启停 → applied + changed(resourceType=skill)", async () => {
    const rig = await makeRig();
    const client = new TestClient(rig.url);
    try {
      await client.open();
      await helloHandshake(client, rig.token);

      client.send({
        v: PROTOCOL_VERSION,
        type: "agent.config.set_enabled",
        payload: { profileKind: "main-session", resourceType: "skill", name: "hello-skill", enabled: false },
      });
      const applied = await client.expect("agent.config.set_enabled.result");
      expect(applied.payload).toEqual({ status: "applied" });
      const changed = await client.expectAfter("agent.config.changed", client.frames.indexOf(applied));
      expect(changed.payload).toEqual({
        profileKind: "main-session",
        resourceType: "skill",
        name: "hello-skill",
        enabled: false,
      });
    } finally {
      await client.close();
      await rig.dispose();
    }
  });

  // T1.3（thinking 批 AD-6 配置资源扩维）：thinking 槽位型 set/clear 全链——
  // 零前置校验（helix 不做档位校验，SoT 在 pi-ai）+ changed 广播 + list 块往返。
  test("⑫ thinking set/clear：applied + changed(resourceType=thinking) + list 块 thinkingLevel 往返；kind 隔离", async () => {
    const rig = await makeRig();
    const client = new TestClient(rig.url);
    try {
      await client.open();
      await helloHandshake(client, rig.token);

      // 未配置 = null（读面钉死 null 非 undefined）
      client.send({ v: PROTOCOL_VERSION, type: "agent.config.list", payload: { profileKind: "subagent-worker" } });
      const list0 = await client.expect("agent.config.list.result");
      expect((list0.payload.profiles as ProfileBlock[])[0]!.thinkingLevel).toBeNull();

      // set 槽位（无目录校验面——任意档位字符串透传）
      client.send({
        v: PROTOCOL_VERSION,
        type: "agent.config.set_enabled",
        payload: { profileKind: "subagent-worker", resourceType: "thinking", name: "xhigh", enabled: true },
      });
      const set = await client.expectAfter("agent.config.set_enabled.result", client.frames.indexOf(list0));
      expect(set.payload).toEqual({ status: "applied" });
      const changedSet = await client.expectAfter("agent.config.changed", client.frames.indexOf(set));
      expect(changedSet.payload).toEqual({
        profileKind: "subagent-worker",
        resourceType: "thinking",
        name: "xhigh",
        enabled: true,
      });
      expect(rig.daemon.resource.thinkingSlot("subagent-worker")).toBe("xhigh");
      // kind 隔离：main-session 不传染
      expect(rig.daemon.resource.thinkingSlot("main-session")).toBeUndefined();

      // clear 槽位
      client.send({
        v: PROTOCOL_VERSION,
        type: "agent.config.set_enabled",
        payload: { profileKind: "subagent-worker", resourceType: "thinking", name: "-", enabled: false },
      });
      const clear = await client.expectAfter("agent.config.set_enabled.result", client.frames.indexOf(changedSet));
      expect(clear.payload).toEqual({ status: "applied" });
      const changedClear = await client.expectAfter("agent.config.changed", client.frames.indexOf(clear));
      expect(changedClear.payload).toEqual({
        profileKind: "subagent-worker",
        resourceType: "thinking",
        name: null,
        enabled: false,
      });
      expect(rig.daemon.resource.thinkingSlot("subagent-worker")).toBeUndefined();

      // list 块随写面往返
      client.send({
        v: PROTOCOL_VERSION,
        type: "agent.config.set_enabled",
        payload: { profileKind: "subagent-worker", resourceType: "thinking", name: "low", enabled: true },
      });
      await client.expectAfter("agent.config.set_enabled.result", client.frames.indexOf(changedClear));
      client.send({ v: PROTOCOL_VERSION, type: "agent.config.list", payload: { profileKind: "subagent-worker" } });
      const list1 = await client.expectAfter("agent.config.list.result", client.frames.length - 1);
      expect((list1.payload.profiles as ProfileBlock[])[0]!.thinkingLevel).toBe("low");
    } finally {
      await client.close();
      await rig.dispose();
    }
  });
});

describe("agent.config 前置校验（payload 形状）", () => {
  test("⑨ 非法 kind / 缺字段 → connection.error{command.invalid_payload}（连接保持）", async () => {
    const rig = await makeRig();
    const client = new TestClient(rig.url);
    try {
      await client.open();
      await helloHandshake(client, rig.token);

      client.send({
        v: PROTOCOL_VERSION,
        type: "agent.config.set_enabled",
        payload: { profileKind: "global", resourceType: "tool", name: "grep", enabled: false },
      });
      await client.waitForInvalidPayload("agent.config.set_enabled");

      client.send({
        v: PROTOCOL_VERSION,
        type: "agent.config.set_enabled",
        payload: { profileKind: "main-session", resourceType: "hook", name: "steer", enabled: true },
      });
      await client.waitForInvalidPayload("agent.config.set_enabled");

      client.send({ v: PROTOCOL_VERSION, type: "agent.config.set_enabled", payload: { profileKind: "main-session" } });
      await client.waitForInvalidPayload("agent.config.set_enabled");

      client.send({ v: PROTOCOL_VERSION, type: "agent.config.list", payload: { profileKind: "bogus" } });
      await client.waitForInvalidPayload("agent.config.list");

      // agent-roster 批：只读 kind 写面拒绝（新错误码；连接保持——后续命令仍可通）
      client.send({
        v: PROTOCOL_VERSION,
        type: "agent.config.set_enabled",
        payload: { profileKind: "orchestrator", resourceType: "tool", name: "grep", enabled: false },
      });
      {
        const at = client.frames.length;
        await until(
          () => client.frames.slice(at).some((f) => f.type === "connection.error" && f.payload.code === "agent.config.read_only"),
          3000,
          "等待 read_only 拒绝",
        );
      }
      // R7 系统槽位批：kg-writer 的 model/thinking 槽位可写（独立配置）；
      // tool/skill 启停仍拒。此处 clear model 槽位 → applied 回执（不再 read_only）。
      client.send({
        v: PROTOCOL_VERSION,
        type: "agent.config.set_enabled",
        payload: { profileKind: "subagent-kg-writer", resourceType: "model", name: "-", enabled: false },
      });
      await client.expect("agent.config.set_enabled.result");
      // kg-writer tool 启停仍拒（read_only）
      client.send({
        v: PROTOCOL_VERSION,
        type: "agent.config.set_enabled",
        payload: { profileKind: "subagent-kg-writer", resourceType: "tool", name: "grep", enabled: false },
      });
      {
        const at = client.frames.length;
        await until(
          () => client.frames.slice(at).some((f) => f.type === "connection.error" && f.payload.code === "agent.config.read_only"),
          3000,
          "等待 read_only 拒绝（kg-writer tool）",
        );
      }
      // D5 reviewer 同例：model 槽位可写（独立配置），tool 启停仍拒（read_only）
      client.send({
        v: PROTOCOL_VERSION,
        type: "agent.config.set_enabled",
        payload: { profileKind: "subagent-code-reviewer", resourceType: "model", name: "-", enabled: false },
      });
      await client.expect("agent.config.set_enabled.result");
      client.send({
        v: PROTOCOL_VERSION,
        type: "agent.config.set_enabled",
        payload: { profileKind: "subagent-code-reviewer", resourceType: "tool", name: "grep", enabled: false },
      });
      {
        const at = client.frames.length;
        await until(
          () => client.frames.slice(at).some((f) => f.type === "connection.error" && f.payload.code === "agent.config.read_only"),
          3000,
          "等待 read_only 拒绝（reviewer tool）",
        );
      }
      // 连接保持 + 零落库（只读 kind 无用户可写面）
      client.send({ v: PROTOCOL_VERSION, type: "agent.config.list", payload: { profileKind: "main-session" } });
      await client.expect("agent.config.list.result");
      expect(rig.daemon.resource.getEffectiveTools("subagent-worker").includes("grep")).toBe(true);
    } finally {
      await client.close();
      await rig.dispose();
    }
  });
});

describe("agent.base_prompt.get（base prompt 批：base 段系统提示词懒查询读面）", () => {
  test("⑬ 五 kind 全可读：点对点回执 basePrompt = profile 静态声明单源（kg-writer 含图谱产出型后缀 / reviewer 含评审纪律后缀）", async () => {
    const rig = await makeRig();
    const client = new TestClient(rig.url);
    try {
      await client.open();
      await helloHandshake(client, rig.token);

      const kinds = ["main-session", "subagent-worker", "orchestrator", "subagent-kg-writer", "subagent-code-reviewer"] as const;
      for (const kind of kinds) {
        const at = client.frames.length;
        client.send({ v: PROTOCOL_VERSION, type: "agent.base_prompt.get", payload: { profileKind: kind } });
        const result = await client.expectAfter("agent.base_prompt.get.result", at);
        expect(result.v).toBe(PROTOCOL_VERSION);
        expect(result.channel).toBe("agent");
        expect(result.sessionId).toBe(SYSTEM_SESSION_ID); // 全局命令：会话无关
        expect(result.payload.profileKind).toBe(kind);
        expect(typeof result.payload.basePrompt).toBe("string");
        expect((result.payload.basePrompt as string).length).toBeGreaterThan(0);
      }
      // 内容锚点：profile 声明单源（主会话角色段 / kg-writer 图谱产出型后缀）
      const at = client.frames.length;
      client.send({ v: PROTOCOL_VERSION, type: "agent.base_prompt.get", payload: { profileKind: "main-session" } });
      const main = await client.expectAfter("agent.base_prompt.get.result", at);
      expect(main.payload.basePrompt).toContain("helix");
      const at2 = client.frames.length;
      client.send({ v: PROTOCOL_VERSION, type: "agent.base_prompt.get", payload: { profileKind: "subagent-kg-writer" } });
      const kgw = await client.expectAfter("agent.base_prompt.get.result", at2);
      expect(kgw.payload.basePrompt).toContain("图谱产出型");
      // D5 reviewer：通用 worker base + 评审纪律后缀（只读评审）
      const at3 = client.frames.length;
      client.send({ v: PROTOCOL_VERSION, type: "agent.base_prompt.get", payload: { profileKind: "subagent-code-reviewer" } });
      const reviewer = await client.expectAfter("agent.base_prompt.get.result", at3);
      expect(reviewer.payload.basePrompt).toContain("只读");
      expect(reviewer.payload.basePrompt).toContain("禁止修改项目代码");
    } finally {
      await client.close();
      await rig.dispose();
    }
  });

  test("⑭ 非法 kind → connection.error{command.invalid_payload}（连接保持——后续命令仍可通）", async () => {
    const rig = await makeRig();
    const client = new TestClient(rig.url);
    try {
      await client.open();
      await helloHandshake(client, rig.token);

      client.send({ v: PROTOCOL_VERSION, type: "agent.base_prompt.get", payload: { profileKind: "bogus" } });
      await client.waitForInvalidPayload("agent.base_prompt.get");
      client.send({ v: PROTOCOL_VERSION, type: "agent.base_prompt.get", payload: {} });
      await client.waitForInvalidPayload("agent.base_prompt.get");
      // 连接保持
      client.send({ v: PROTOCOL_VERSION, type: "agent.base_prompt.get", payload: { profileKind: "orchestrator" } });
      const ok = await client.expect("agent.base_prompt.get.result");
      expect(ok.payload.profileKind).toBe("orchestrator");
    } finally {
      await client.close();
      await rig.dispose();
    }
  });
});

describe("agent.skill_content.get（skill-content 批：skill 正文懒查询读面）", () => {
  test("① 已装技能 → 点对点回执 name/filePath/content 全文（user 层 hello-skill）", async () => {
    const rig = await makeRig();
    const client = new TestClient(rig.url);
    try {
      await client.open();
      await helloHandshake(client, rig.token);
      await client.expect("session.snapshot");

      client.send({ v: PROTOCOL_VERSION, type: "agent.skill_content.get", payload: { name: "hello-skill" } });
      const result = await client.expect("agent.skill_content.get.result");
      expect(result.channel).toBe("agent");
      const p = result.payload as { name: string; filePath: string; content: string };
      expect(p.name).toBe("hello-skill"); // 请求回显——多行并发展开定向归位
      expect(p.filePath).toContain("hello-skill");
      expect(p.content).toContain("name: hello-skill"); // 全文含 frontmatter（事实源原文）
      expect(p.content).toContain("正文");
    } finally {
      await client.close();
      await rig.dispose();
    }
  });

  test("② 未知技能名 / 缺 name → connection.error{command.invalid_payload}（连接保持——后续命令仍可通）", async () => {
    const rig = await makeRig();
    const client = new TestClient(rig.url);
    try {
      await client.open();
      await helloHandshake(client, rig.token);

      client.send({ v: PROTOCOL_VERSION, type: "agent.skill_content.get", payload: { name: "no-such-skill" } });
      await client.waitForInvalidPayload("agent.skill_content.get");
      client.send({ v: PROTOCOL_VERSION, type: "agent.skill_content.get", payload: {} });
      await client.waitForInvalidPayload("agent.skill_content.get");
      // 连接保持
      client.send({ v: PROTOCOL_VERSION, type: "agent.skill_content.get", payload: { name: "hello-skill" } });
      const ok = await client.expect("agent.skill_content.get.result");
      expect(ok.payload.name).toBe("hello-skill");
    } finally {
      await client.close();
      await rig.dispose();
    }
  });
});
