import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { createTestDaemon } from "../helpers/createTestDaemon";
import { PiAgentEngineAdapter } from "../../src/adapters/driven/pi-engine/PiAgentEngineAdapter";
import { resolveEffectiveThinking } from "../../src/adapters/driven/pi-engine/thinking-resolve";
import { MinimalHooks } from "../../src/adapters/driven/pi-engine/runtime/hooks/MinimalHooks";
import type { AgentProfile } from "../../src/adapters/driven/pi-engine/runtime/AgentProfile";
import { createAssistantMessageEventStream, type AssistantMessage, type Model, type Models } from "@earendil-works/pi-ai";
import { FakeAgentEngine } from "../mocks/FakeAgentEngine";
import { PROTOCOL_VERSION } from "@helix/protocol";
import { WriteQueue } from "../../src/adapters/driven/sqlite-session/WriteQueue";
import { SqliteSessionRepository } from "../../src/adapters/driven/sqlite-session/SqliteSessionRepository";
import { createPaths } from "../../src/infrastructure/paths";

/**
 * thinking 批 T1.2（test-design §2.3/§2.5；architecture §3.1 落点一/§3.3/§3.4①/§3.5/§5.1/§5.2）：
 * - thinking.set 全链：handler → ModelService/ChatService → AgentEnginePort 直改
 *   → AgentRuntime 覆盖态 → domain_events 单写队列落盘（agent.thinking.changed）
 *   → thinking.changed 广播 {override, effective}；
 * - 解析链 = [会话覆盖, main-session kind 槽位, 兜底 "medium"] 逐值能力适配
 *   （clamp，SoT 在 pi-ai）取首个生效值；全链不支持 / reasoning=false →
 *   undefined → 不动 options（provider 默认）；
 * - 覆盖保留：换模只改生效档，覆盖不丢（AD-3 意图/生效分离）。
 */

const tmpRoots: string[] = [];
function tmpHome(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "helix-thinking-set-"));
  tmpRoots.push(dir);
  return dir;
}
afterAll(() => {
  for (const d of tmpRoots) rmSync(d, { recursive: true, force: true });
});

/** 三档模型（tri fixture）：仅 low/medium/high 支持。 */
const TRI_MODEL = {
  id: "tri",
  name: "Tri",
  api: "anthropic-messages",
  provider: "fake",
  baseUrl: "http://localhost-unused",
  reasoning: true,
  thinkingLevelMap: { minimal: null, low: "l", medium: "m", high: "h", xhigh: null, max: null },
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 100_000,
  maxTokens: 8192,
} as unknown as Model<any>;
/** 无推理模型（reasoning=false → 解析 undefined，options 不动）。 */
const NO_REASONING_MODEL = { ...TRI_MODEL, id: "no-reasoning", reasoning: false, thinkingLevelMap: undefined } as unknown as Model<any>;

interface SeenFrame {
  readonly model: string;
  readonly reasoning: unknown;
}

/** 剧本化 Models：streamSimple 记录 options.reasoning（机械判据断言源）。 */
function makeScriptedModels(seen: SeenFrame[]): Models {
  const known = [TRI_MODEL, NO_REASONING_MODEL];
  return {
    getModel: (provider: string, id: string) => known.find((m) => m.provider === provider && m.id === id),
    getModels: (provider: string) => known.filter((m) => m.provider === provider),
    streamSimple: (model: Model<any>, _ctx: unknown, opts?: { reasoning?: unknown }) => {
      seen.push({ model: `${model.provider}/${model.id}`, reasoning: opts?.reasoning });
      const stream = createAssistantMessageEventStream();
      const final: AssistantMessage = {
        role: "assistant",
        content: [{ type: "text", text: `reply@${model.id}` }],
        api: model.api,
        provider: model.provider,
        model: model.id,
        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason: "stop",
        timestamp: Date.now(),
      } as unknown as AssistantMessage;
      void (async () => {
        stream.push({ type: "start", partial: final });
        await new Promise((r) => setTimeout(r, 5));
        stream.push({ type: "done", reason: "stop", message: final });
      })();
      return stream;
    },
  } as unknown as Models;
}

const TestProfile: AgentProfile = {
  kind: "test-thinking-chain",
  systemPrompt: "测试系统提示",
  tools: [],
  lifecycle: { mode: "single-shot" },
  hooks: [MinimalHooks],
};

describe("thinking.set 全链（真引擎 + 剧本 Models，能力解析可观测）", () => {
  test("覆盖 → 生效档钳制 → 下一 turn options.reasoning；reasoning=false → options 不动；落盘无旁路", async () => {
    const seen: SeenFrame[] = [];
    const models = makeScriptedModels(seen);
    // 主会话解析链（§3.1 落点一形态）：[会话覆盖（引擎观测面回读）, 槽位（本用例未配置）, 兜底 medium]
    // —— 覆盖读面自引用闭包（回调仅在 turn 开始触发 = 构造完成之后）；生产组合根接线见下述用例。
    let self: PiAgentEngineAdapter | undefined;
    const engine = new PiAgentEngineAdapter({
      profile: TestProfile,
      model: TRI_MODEL,
      apiKeys: { fake: "sk-test" },
      models,
      resolveThinking: (model) => resolveEffectiveThinking([self?.thinkingOverride(), undefined, "medium"], model),
    });
    self = engine;
    const home = tmpHome();
    const daemon = await createTestDaemon({
      home,
      engine,
      skipConfig: true,
      port: 0,
      cliInput: new PassThrough(),
      cliOutput: new PassThrough(),
    });
    try {
      const sid = daemon.registry.currentSessionId();

      // turn 1：无覆盖 → 兜底 medium（tri 支持）
      await daemon.chat.sendMessage("first");
      expect(seen).toEqual([{ model: "fake/tri", reasoning: "medium" }]);

      // thinking.set：xhigh 覆盖 → tri 钳到 high；ack 载荷 {override, effective}
      const outcome = await daemon.model.setThinking(sid, "xhigh");
      expect(outcome).toEqual({ override: "xhigh", effective: "high" });
      expect(daemon.registry.peek(sid)!.chatService.currentThinking).toEqual({ override: "xhigh", effective: "high" });

      // turn 2：覆盖生效（钳制值进 options.reasoning）
      await daemon.chat.sendMessage("second");
      expect(seen[1]).toEqual({ model: "fake/tri", reasoning: "high" });

      // 换模到 reasoning=false：覆盖保留、生效档 null、options 不动
      daemon.registry.peek(sid)!.chatService.setModel("fake/no-reasoning");
      expect(daemon.registry.peek(sid)!.chatService.currentThinking).toEqual({ override: "xhigh", effective: null });
      await daemon.chat.sendMessage("third");
      expect(seen[2]).toEqual({ model: "fake/no-reasoning", reasoning: undefined });

      // 切回 tri：覆盖自动恢复生效（换模无损，AD-3）
      daemon.registry.peek(sid)!.chatService.setModel("fake/tri");
      expect(daemon.registry.peek(sid)!.chatService.currentThinking).toEqual({ override: "xhigh", effective: "high" });
      await daemon.chat.sendMessage("fourth");
      expect(seen[3]).toEqual({ model: "fake/tri", reasoning: "high" });
    } finally {
      await daemon.shutdown();
    }

    // 落盘纪律：agent.thinking.changed 经 domain_events 单写队列（TR-AD-5），
    // 载荷 {instanceId, level}；无旁路表/旁路写面（断言唯一直写源 = domain_events 行）
    const queue = new WriteQueue(createPaths(home).dbPath());
    try {
      const repo = new SqliteSessionRepository(queue);
      const rows = repo.queryEvents({ type: "agent.thinking.changed" });
      expect(rows).toHaveLength(1);
      expect(rows[0]!.payload).toEqual({ instanceId: "main", level: "xhigh" });
    } finally {
      await queue.close();
    }
  });
});

describe("thinking.changed 广播（WS 集成，契约 ①）", () => {
  test("thinking.set → 订阅该会话的连接收到 thinking.changed（override/effective/sessionId 章印/channel=thinking）", async () => {
    const home = tmpHome();
    const daemon = await createTestDaemon({
      home,
      engine: new FakeAgentEngine({ initialModel: "anthropic/claude-sonnet-4-5" }),
      skipConfig: true,
      port: 0,
      cliInput: new PassThrough(),
      cliOutput: new PassThrough(),
    });
    const url = `ws://127.0.0.1:${daemon.ws.port}`;
    const token = readFileSync(path.join(home, "dev-token"), "utf8");
    let ws: WebSocket | undefined;
    try {
      const frames: Record<string, unknown>[] = [];
      ws = new WebSocket(url);
      ws.onmessage = (ev) => frames.push(JSON.parse(String(ev.data)));
      await until(() => ws!.readyState === WebSocket.OPEN);
      ws.send(JSON.stringify({ v: PROTOCOL_VERSION, type: "hello", payload: { token, protocolVersion: PROTOCOL_VERSION } }));
      await until(() => frames.some((f) => f.type === "connection.welcome"));
      const welcome = frames.find((f) => f.type === "connection.welcome")!;
      if ((welcome.payload as { draft?: boolean }).draft === true) {
        ws.send(JSON.stringify({ v: 0, type: "session.subscribe", payload: {} }));
      }
      await until(() => frames.some((f) => f.type === "session.snapshot"));
      const sid = daemon.registry.currentSessionId();

      ws.send(JSON.stringify({ v: PROTOCOL_VERSION, sessionId: sid, type: "thinking.set", payload: { level: "high" } }));
      await until(() => frames.some((f) => f.type === "thinking.changed"));
      const changed = frames.find((f) => f.type === "thinking.changed")!;
      expect(changed.sessionId).toBe(sid);
      expect(changed.channel).toBe("thinking");
      expect(changed.payload).toEqual({ override: "high", effective: "high" }); // Fake 引擎契约等价面：恒支持
      // 引擎内存覆盖即时可观测
      expect(daemon.registry.peek(sid)!.chatService.currentThinking).toEqual({ override: "high", effective: "high" });

      // 非法载荷 → command.invalid_payload（model.set 先例）
      ws.send(JSON.stringify({ v: PROTOCOL_VERSION, sessionId: sid, type: "thinking.set", payload: {} }));
      await until(() => frames.some((f) => f.type === "connection.error"));
      const err = frames.find((f) => f.type === "connection.error")!;
      expect((err.payload as { code: string }).code).toBe("command.invalid_payload");

      // 不存在会话 → session.not_found（model.set 既有错误处理先例，不新增错误类型）
      ws.send(JSON.stringify({ v: PROTOCOL_VERSION, sessionId: "sess-nonexistent", type: "thinking.set", payload: { level: "low" } }));
      await until(() => frames.filter((f) => f.type === "connection.error").length === 2);
      const err2 = frames.filter((f) => f.type === "connection.error")[1]!;
      expect((err2.payload as { code: string }).code).toBe("session.not_found");
    } finally {
      ws?.close();
      await daemon.shutdown();
    }
  });

  // F-8 修复（thinking 批③ wire 面接通）：session.snapshot 帧携带 thinking
  // {override, effective}——协议 SessionSnapshotDto additive 字段 + SnapshotMapper
  // 映射；两态断言（无覆盖 / 有覆盖）。
  test("session.snapshot wire 面携带 thinking：无覆盖 {null,null} → thinking.set 后重推快照携带 {high,high}", async () => {
    const home = tmpHome();
    const daemon = await createTestDaemon({
      home,
      engine: new FakeAgentEngine({ initialModel: "anthropic/claude-sonnet-4-5" }),
      skipConfig: true,
      port: 0,
      cliInput: new PassThrough(),
      cliOutput: new PassThrough(),
    });
    const url = `ws://127.0.0.1:${daemon.ws.port}`;
    const token = readFileSync(path.join(home, "dev-token"), "utf8");
    let ws: WebSocket | undefined;
    try {
      const frames: Record<string, unknown>[] = [];
      ws = new WebSocket(url);
      ws.onmessage = (ev) => frames.push(JSON.parse(String(ev.data)));
      await until(() => ws!.readyState === WebSocket.OPEN);
      ws.send(JSON.stringify({ v: PROTOCOL_VERSION, type: "hello", payload: { token, protocolVersion: PROTOCOL_VERSION } }));
      await until(() => frames.some((f) => f.type === "connection.welcome"));
      const welcome = frames.find((f) => f.type === "connection.welcome")!;
      if ((welcome.payload as { draft?: boolean }).draft === true) {
        ws.send(JSON.stringify({ v: 0, type: "session.subscribe", payload: {} }));
      }
      await until(() => frames.some((f) => f.type === "session.snapshot"));
      const sid = daemon.registry.currentSessionId();
      const snapOf = (f: Record<string, unknown>) =>
        (f.payload as { snapshot: { thinking?: { override: string | null; effective: string | null } } }).snapshot;

      // 态一（无覆盖）：快照帧携带 thinking 双位 null（Fake 引擎契约等价面：恒支持）
      const snap1 = frames.find((f) => f.type === "session.snapshot")!;
      expect(snapOf(snap1).thinking).toEqual({ override: null, effective: null });

      // thinking.set → 重订阅重推快照（AD-16 快照恢复公式）
      ws.send(JSON.stringify({ v: PROTOCOL_VERSION, sessionId: sid, type: "thinking.set", payload: { level: "high" } }));
      await until(() => frames.some((f) => f.type === "thinking.changed"));
      ws.send(JSON.stringify({ v: PROTOCOL_VERSION, sessionId: sid, type: "session.subscribe", payload: {} }));
      await until(() => frames.filter((f) => f.type === "session.snapshot").length >= 2);

      // 态二（有覆盖）：重推快照携带 override/effective 双位
      const snap2 = frames.filter((f) => f.type === "session.snapshot")[1]!;
      expect(snap2.sessionId).toBe(sid);
      expect(snapOf(snap2).thinking).toEqual({ override: "high", effective: "high" });
    } finally {
      ws?.close();
      await daemon.shutdown();
    }
  });
});

describe("生产组合根接线（TR-TEST-5：buildSessionStack 生产路径，禁手工 new 注入器）", () => {
  test("生产 engineFor 装配的引擎：解析链双读面（覆盖 + main-session 槽位）经 currentThinking 可观测", async () => {
    const home = tmpHome();
    // 生产模式（不注入 engine）→ 真引擎装配（构造期无网络；本用例不发起 turn）
    const daemon = await createTestDaemon({
      home,
      skipConfig: true,
      port: 0,
      cliInput: new PassThrough(),
      cliOutput: new PassThrough(),
    });
    try {
      const sid = daemon.registry.currentSessionId();
      const chatService = daemon.registry.peek(sid)!.chatService;
      // 缺省：无覆盖无槽位 → 兜底 medium（claude-sonnet-4-5 reasoning=true，medium 支持）
      expect(chatService.currentThinking).toEqual({ override: null, effective: "medium" });

      // 槽位读面（T1.3 落地前缺省 = 未配置；本用例直写 resource_state 验证读面接通）
      await daemon.resource.setThinkingSlot("main-session", "high");
      expect(chatService.currentThinking).toEqual({ override: null, effective: "high" });

      // 覆盖读面：覆盖 > 槽位（xhigh 超出 sonnet 能力 → 钳到 high；覆盖不丢）
      await daemon.model.setThinking(sid, "xhigh");
      expect(chatService.currentThinking).toEqual({ override: "xhigh", effective: "high" });
      await daemon.resource.clearThinkingSlot("main-session");
      expect(chatService.currentThinking).toEqual({ override: "xhigh", effective: "high" });
    } finally {
      await daemon.shutdown();
    }
  });
});

async function until(cond: () => boolean, timeoutMs = 5000): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > timeoutMs) throw new Error(`等待超时（${Date.now() - t0}ms）`);
    await new Promise((r) => setTimeout(r, 5));
  }
}
