/**
 * agent.config / agent 资源命令族集成测试共享 rig（体量治理拆分）：
 * TestClient 帧断言 + makeRig 组合根装配（随机端口 + user 层技能预播种）+
 * 工具清单常量（MAIN/SUB/ORCH）——agent-config-ws 与 agent-resource-ws
 * 两测试文件共用；tmp 目录注册进 tmpRoots，各测试文件 afterAll 调
 * cleanupAgentConfigTmp 统一清（幂等）。
 */
import { afterAll, expect } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { createTestDaemon } from "./createTestDaemon";
import { createPaths } from "../../src/infrastructure/paths";
import { FakeAgentEngine } from "../mocks/FakeAgentEngine";
import { PROTOCOL_VERSION, type FrameVersion } from "@helix/protocol";

export interface Frame {
  v: FrameVersion;
  type: string;
  payload: Record<string, unknown>;
  sessionId?: string;
  channel?: string;
}

export class TestClient {
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
export async function helloHandshake(client: TestClient, token: string): Promise<void> {
  client.send({ v: PROTOCOL_VERSION, type: "hello", payload: { token, protocolVersion: PROTOCOL_VERSION } });
  await client.expect("connection.welcome");
  client.send({ v: 0, type: "session.subscribe", payload: {} });
}

export async function until(cond: () => boolean, timeoutMs: number, what: string): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > timeoutMs) throw new Error(`等待超时：${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

const tmpRoots: string[] = [];

export function tmpHome(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "helix-agent-config-it-"));
  tmpRoots.push(dir); // 泄漏修复：全部 tmp 目录进跟踪，afterAll 统一清（含 builtinSkillsDir 隔离目录）
  return dir;
}

/** 清空全部注册的 tmp 根（幂等；各测试文件 afterAll 调用）。 */
export function cleanupAgentConfigTmp(): void {
  for (const d of tmpRoots) rmSync(d, { recursive: true, force: true });
}

export interface ProfileBlock {
  profileKind: string;
  tools: { name: string; enabled: boolean; snippet: string }[];
  skills: { name: string; description: string; filePath: string; source: string; audience: string; enabled: boolean }[];
  diagnostics: { code: string; message: string; path: string; source: string }[];
  model: string | null;
  thinkingLevel: string | null; // v0.11 批内补登（T1.3）
}

export interface Rig {
  home: string;
  daemon: Awaited<ReturnType<typeof createTestDaemon>>;
  token: string;
  url: string;
  dispose: () => Promise<void>;
}

/** 组合根装配（随机端口；user 层技能预播种：好技能 + 坏文件）。 */
export async function makeRig(): Promise<Rig> {
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

export const MAIN_TOOLS = [
  "bash",
  "read",
  "write",
  "edit",
  "edit-lines", // F4 接通批：行锚编辑进 main 白名单
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
  "coord_claim", // U4 占用协调三工具（仅 main——决策主体）
  "coord_release",
  "coord_query",
];
export const SUB_TOOLS = ["bash", "read", "write", "edit", "edit-lines", "grep", "web_search", "web_fetch", "browser", "kg", "codegraph", "plan_create", "plan_update", "plan_read"]; // H-3：+browser（wire 转发通道接 daemon CDP 单例）；T3.3：+kg；T1.4：+plan 三工具（AD-6①；main-session plan 批起 Main 同含——两域同构）；W1-B：+codegraph；D8 W-R6：-kg-update（写面收权）；F4 接通批：+edit-lines
/** agent-roster 批：只读系统派生块三序（orchestrator 在前，reviewer 在后）。OrchestratorProfile.tools 声明全集同源（D6：+write 任务产物落盘）。 */
export const ORCH_TOOLS = [
  "bash",
  "read",
  "grep",
  "write", // D6：任务报告目录内产物落盘（任务级汇总报告）——不加 edit
  "agent_spawn",
  "plan_read",
  "kg",
  "task_insert_batch",
  "task_assembly_done",
  "task_dispatch_batch",
  "task_advance_stage",
  "task_stage_artifact",
  "task_complete_job",
  "task_fail_job",
];
/** builtin 目录内模型（model-provider.DEFAULT_MODEL_ID 同源；hasModel 读面零网络）。 */
export const ANY_MODEL = "anthropic/claude-sonnet-4-5";
