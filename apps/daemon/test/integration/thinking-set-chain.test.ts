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
 * - 解析链 = [会话覆盖, main-session kind 槽位] 逐值能力适配（clamp，SoT
 *   在 pi-ai）取首个生效值；**全链未配置 → undefined = 默认关**（D 方案：
 *   删 medium 兜底，不传 reasoning = pi-ai 显式关思考）；"off" = 合法
 *   override 值（显式关：clamp 前短路整链 → effective=null，后续请求不带
 *   reasoning——off:null map 模型若不短路会被 clamp 升档，语义反转）；
 *   reasoning=false → undefined → 不动 options（provider 默认）；
 * - 覆盖保留：换模只改生效档，覆盖不丢（AD-3 意图/生效分离）；换模后
 *   thinking.changed 重广播（消除 shell 侧 stale 档位）。
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
/** off:null 模型（off 显式关、high 支持——off 不短路则 clamp("off") 升到支持档，语义反转反例）。 */
const OFF_NULL_MODEL = {
  ...TRI_MODEL,
  id: "off-null",
  thinkingLevelMap: { off: null, high: "h" },
} as unknown as Model<any>;

interface SeenFrame {
  readonly model: string;
  readonly reasoning: unknown;
}

/** 剧本化 Models：streamSimple 记录 options.reasoning（机械判据断言源）。 */
function makeScriptedModels(seen: SeenFrame[]): Models {
  const known = [TRI_MODEL, NO_REASONING_MODEL, OFF_NULL_MODEL];
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
    // 主会话解析链（§3.1 落点一形态）：[会话覆盖（引擎观测面回读）, 槽位（本用例未配置）]
    // —— 覆盖读面自引用闭包（回调仅在 turn 开始触发 = 构造完成之后）；生产组合根接线见下述用例。
    let self: PiAgentEngineAdapter | undefined;
    const engine = new PiAgentEngineAdapter({
      profile: TestProfile,
      model: TRI_MODEL,
      apiKeys: { fake: "sk-test" },
      models,
      resolveThinking: (model) => resolveEffectiveThinking([self?.thinkingOverride(), undefined], model),
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

      // turn 1：无覆盖无槽位 → 默认关（不传 reasoning = pi-ai 显式关思考，D 方案）
      await daemon.chat.sendMessage("first");
      expect(seen).toEqual([{ model: "fake/tri", reasoning: undefined }]);

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

  test("thinking.set(\"off\")：显式关——outcome effective=null、后续 turn reasoning undefined、换模覆盖保留", async () => {
    const seen: SeenFrame[] = [];
    const models = makeScriptedModels(seen);
    let self: PiAgentEngineAdapter | undefined;
    const engine = new PiAgentEngineAdapter({
      profile: TestProfile,
      model: TRI_MODEL,
      apiKeys: { fake: "sk-test" },
      models,
      resolveThinking: (model) => resolveEffectiveThinking([self?.thinkingOverride(), undefined], model),
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

      // thinking.set("off")：显式关（合法 override 值）——outcome {override:"off", effective:null}
      const outcome = await daemon.model.setThinking(sid, "off");
      expect(outcome).toEqual({ override: "off", effective: null });
      expect(daemon.registry.peek(sid)!.chatService.currentThinking).toEqual({ override: "off", effective: null });

      // 后续 turn：不带 reasoning（显式关，非未配置回落）
      await daemon.chat.sendMessage("off-turn");
      expect(seen[0]).toEqual({ model: "fake/tri", reasoning: undefined });

      // 切 no-reasoning 模型再切回：override 保留仍 off（意图/生效分离，AD-3）
      daemon.registry.peek(sid)!.chatService.setModel("fake/no-reasoning");
      expect(daemon.registry.peek(sid)!.chatService.currentThinking).toEqual({ override: "off", effective: null });
      daemon.registry.peek(sid)!.chatService.setModel("fake/tri");
      expect(daemon.registry.peek(sid)!.chatService.currentThinking).toEqual({ override: "off", effective: null });
      await daemon.chat.sendMessage("off-back");
      expect(seen[1]).toEqual({ model: "fake/tri", reasoning: undefined });
    } finally {
      await daemon.shutdown();
    }
  });

  // 本任务最重要的反例钉桩：off:null map 模型（{off: null, high: "h"}）下
  // pi-ai clamp("off") 会向上找最近支持档——off 短路必须先于 clamp，
  // 否则 effective 被钳成支持档（语义反转：想关反而开）。
  test("off:null 模型 setThinking(\"off\")：effective=null（不被钳成支持档）、turn reasoning undefined", async () => {
    const seen: SeenFrame[] = [];
    const models = makeScriptedModels(seen);
    let self: PiAgentEngineAdapter | undefined;
    const engine = new PiAgentEngineAdapter({
      profile: TestProfile,
      model: OFF_NULL_MODEL,
      apiKeys: { fake: "sk-test" },
      models,
      resolveThinking: (model) => resolveEffectiveThinking([self?.thinkingOverride(), undefined], model),
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

      // 前置佐证：high 在 off-null 模型支持（map {off: null, high: "h"}）
      const high = await daemon.model.setThinking(sid, "high");
      expect(high).toEqual({ override: "high", effective: "high" });

      // 反例主体：off → effective null（不是支持档；若 off 进 clamp 会被升档）
      const outcome = await daemon.model.setThinking(sid, "off");
      expect(outcome).toEqual({ override: "off", effective: null });
      await daemon.chat.sendMessage("off-null-turn");
      expect(seen[0]).toEqual({ model: "fake/off-null", reasoning: undefined });
    } finally {
      await daemon.shutdown();
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
      // 缺省：无覆盖无槽位 → 默认关（claude-sonnet-4-5 reasoning=true，全链未配置 = 不传 reasoning）
      expect(chatService.currentThinking).toEqual({ override: null, effective: null });

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

// ── setModel 后 thinking.changed 重广播（附带修复：换模后 shell 侧 stale 档位） ──

describe("setModel 后 thinking.changed 重广播（WS 集成；换模只改 effective 不改 override，AD-3）", () => {
  test("model.set 成功 → 订阅连接在 model.changed 后收到 thinking.changed（override 不变、effective 按新模型重算）", async () => {
    const home = tmpHome();
    // 生产模式（真引擎 + 真目录）：sonnet-4-5（xhigh 无显式映射 → 钳到 high）
    // → opus-4-7（map {xhigh:"xhigh"} → xhigh 生效）——重算面可观测
    const daemon = await createTestDaemon({
      home,
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

      // 前置：thinking.set xhigh → sonnet-4-5 钳到 high（首帧 thinking.changed）
      ws.send(JSON.stringify({ v: PROTOCOL_VERSION, sessionId: sid, type: "thinking.set", payload: { level: "xhigh" } }));
      await until(() => frames.some((f) => f.type === "thinking.changed"));
      expect(frames.find((f) => f.type === "thinking.changed")!.payload).toEqual({ override: "xhigh", effective: "high" });

      // model.set → opus-4-7：model.changed 后补发 thinking.changed（effective 重算 xhigh）
      ws.send(JSON.stringify({ v: PROTOCOL_VERSION, sessionId: sid, type: "model.set", payload: { model: "anthropic/claude-opus-4-7" } }));
      await until(() => frames.some((f) => f.type === "model.changed"));
      // 两帧广播同步同点（setModel 成功路径）；model.changed 到达即重广播已入列
      await until(() => frames.filter((f) => f.type === "thinking.changed").length >= 2);
      const changed = frames.filter((f) => f.type === "thinking.changed")[1]!;
      expect(changed.sessionId).toBe(sid);
      expect(changed.channel).toBe("thinking");
      expect(changed.payload).toEqual({ override: "xhigh", effective: "xhigh" }); // override 不变、按新模型重算
    } finally {
      ws?.close();
      await daemon.shutdown();
    }
  });

  test("引擎未实现观测面（currentThinking undefined）→ setModel 后不广播 thinking.changed（additive 缺省形态不变）", async () => {
    const home = tmpHome();
    // 最小引擎 stub：实现模型面但不实现 currentThinking（旧引擎 additive 形态）
    const engine = new FakeAgentEngine({ initialModel: "anthropic/claude-sonnet-4-5" });
    (engine as unknown as { currentThinking: undefined }).currentThinking = undefined;
    const daemon = await createTestDaemon({
      home,
      engine,
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

      ws.send(JSON.stringify({ v: PROTOCOL_VERSION, sessionId: sid, type: "model.set", payload: { model: "anthropic/claude-opus-4-5" } }));
      await until(() => frames.some((f) => f.type === "model.changed"));
      // model.changed 已到 → setModel 同步广播链已走完：无 thinking.changed（未实现观测面不广播）
      expect(frames.some((f) => f.type === "thinking.changed")).toBe(false);
    } finally {
      ws?.close();
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
