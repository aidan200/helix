/**
 * DashScope realtime 流式 STT adapter 单测（V3b-1 流式转写批；TDD 红绿证据链）。
 *
 * 协议事实锚点 = 冒烟实测（docs/temp/stt-streaming/DECISION.md）：
 * - 握手 wss://dashscope.aliyuncs.com/api-ws/v1/realtime?model=qwen3-asr-flash-realtime
 *   + Authorization Bearer 头；open 后发 session.update（corpus 偏置 =
 *   context.hint；language；server_vad）；session.updated 回执后流就绪；
 * - 上行 input_audio_buffer.append（base64；服务端不回执）；就绪前缓冲；
 * - 下行 conversation.item.input_audio_transcription.text{text,stash}（interim）
 *   / .completed{transcript}（句终，全文 = 串联）/ session.finished（终态）；
 * - 断连重连一次（音频重放）；60s 无音频关流；finish 后终帧超时兜底；
 * - key 缺失 fail-fast 抛中文引导。
 *
 * WS 全程注入 fake（零真实网络——stt-adapters.test.ts 同构纪律）；
 * 定时器注入手工时钟（idle/final 超时面可测）。
 */
import { describe, expect, test } from "bun:test";
import {
  DashScopeRealtimeSttAdapter,
  DASHSCOPE_ASR_REALTIME_MODEL,
} from "../../src/adapters/driven/stt/realtime";
import type { AsrContext } from "../../src/application/stt/VocabularyBuilder";

// ── 测试资产 ────────────────────────────────────────────────

/** fake WS：记录上行 / 手工注入下行事件。 */
class FakeSocket {
  sent: string[] = [];
  closed = false;
  closeCode: number | undefined;
  private listeners = new Map<string, Set<(ev: { data?: unknown }) => void>>();

  addEventListener(type: string, listener: (ev: { data?: unknown }) => void): void {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)!.add(listener);
  }
  removeEventListener(type: string, listener: (ev: { data?: unknown }) => void): void {
    this.listeners.get(type)?.delete(listener);
  }
  send(data: string): void {
    this.sent.push(data);
  }
  close(code?: number): void {
    if (this.closed) return;
    this.closed = true;
    this.closeCode = code;
    this.emit("close", {});
  }
  // 注入面
  emitOpen(): void {
    this.emit("open", {});
  }
  emitMessage(obj: unknown): void {
    this.emit("message", { data: JSON.stringify(obj) });
  }
  emitUnexpectedClose(): void {
    if (this.closed) return;
    this.closed = true;
    this.emit("close", {});
  }
  private emit(type: string, ev: { data?: unknown }): void {
    for (const cb of this.listeners.get(type) ?? []) cb(ev);
  }
}

/** 手工时钟：idle/final 超时回调手动触发。 */
class ManualClock {
  private nextId = 1;
  private jobs = new Map<number, () => void>();
  readonly setTimer = (cb: () => void, _ms: number): number => {
    const id = this.nextId++;
    this.jobs.set(id, cb);
    return id;
  };
  readonly clearTimer = (id: number): void => {
    this.jobs.delete(id);
  };
  fire(id: number): void {
    const cb = this.jobs.get(id);
    this.jobs.delete(id);
    cb?.();
  }
  fireAll(): void {
    for (const id of [...this.jobs.keys()]) this.fire(id);
  }
  get pending(): number {
    return this.jobs.size;
  }
}

const CONTEXT: AsrContext = {
  terms: [{ term: "Paraformer", weight: 4, source: "base" }],
  hint: "Paraformer, DashScope",
};

interface Harness {
  sockets: FakeSocket[];
  clock: ManualClock;
  adapter: DashScopeRealtimeSttAdapter;
  events: { started: number; interim: { prior: string; text: string; stash: string }[]; final: string[]; errors: string[] };
  key: string | undefined;
}

/** 建适配器 + 收集回调；emitStarted 模拟上游就绪握手完成。 */
function harness(key = "sk-test"): Harness {
  const sockets: FakeSocket[] = [];
  const clock = new ManualClock();
  const h: Harness = {
    sockets,
    clock,
    key,
    adapter: undefined as unknown as DashScopeRealtimeSttAdapter,
    events: { started: 0, interim: [], final: [], errors: [] },
  };
  h.adapter = new DashScopeRealtimeSttAdapter({
    getApiKey: () => h.key,
    wsFactory: () => {
      const s = new FakeSocket();
      sockets.push(s);
      return s;
    },
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  });
  return h;
}

/** open 流并走完上游握手（open → session.update 发出 → session.updated 回执）。 */
function openReady(h: Harness, language = "zh") {
  const session = h.adapter.open({
    language,
    context: CONTEXT,
    callbacks: {
      onStarted: () => h.events.started++,
      onInterim: (f) => h.events.interim.push(f),
      onFinal: (t) => h.events.final.push(t),
      onError: (r) => h.events.errors.push(r),
    },
  });
  const ws = h.sockets[h.sockets.length - 1]!;
  ws.emitOpen();
  const update = JSON.parse(ws.sent[0]!) as { type: string; session: Record<string, unknown> };
  ws.emitMessage({ type: "session.created", session: {} });
  ws.emitMessage({ type: "session.updated", session: update.session });
  return { session, ws };
}

// ── 断言面 ─────────────────────────────────────────────────

describe("DashScope realtime 流式 adapter：握手与 session.update", () => {
  test("key 缺失 fail-fast 抛中文引导（指向设置页录入）", () => {
    const h = harness(""); // 空串同走 key 缺失分支（undefined 会触发 JS 默认参数）
    expect(() =>
      h.adapter.open({ context: CONTEXT, callbacks: { onStarted: () => {}, onInterim: () => {}, onFinal: () => {}, onError: () => {} } }),
    ).toThrow(/dashscope/);
  });

  test("open 后发 session.update：corpus=context.hint、language、server_vad（400ms 静音断句）", () => {
    const h = harness();
    const { ws } = openReady(h);
    const update = JSON.parse(ws.sent[0]!) as {
      type: string;
      session: {
        input_audio_format: string;
        sample_rate: number;
        input_audio_transcription: { language?: string; corpus?: { text: string } };
        turn_detection: { type: string; threshold: number; silence_duration_ms: number };
      };
    };
    expect(update.type).toBe("session.update");
    expect(update.session.input_audio_format).toBe("pcm");
    expect(update.session.sample_rate).toBe(16000);
    expect(update.session.input_audio_transcription.language).toBe("zh");
    expect(update.session.input_audio_transcription.corpus?.text).toBe("Paraformer, DashScope");
    expect(update.session.turn_detection).toEqual({ type: "server_vad", threshold: 0, silence_duration_ms: 400 });
  });

  test("session.updated 回执后才 onStarted（之前 append 缓冲、之后即刻透传）", () => {
    const h = harness();
    const session = h.adapter.open({
      language: "zh",
      context: CONTEXT,
      callbacks: { onStarted: () => h.events.started++, onInterim: (f) => h.events.interim.push(f), onFinal: (t) => h.events.final.push(t), onError: (r) => h.events.errors.push(r) },
    });
    const ws = h.sockets[0]!;
    ws.emitOpen();
    expect(h.events.started).toBe(0);
    session.appendAudio("AAA1");
    session.appendAudio("AAA2");
    expect(ws.sent.filter((s) => s.includes("input_audio_buffer.append"))).toHaveLength(0); // 缓冲不透传
    ws.emitMessage({ type: "session.updated", session: {} });
    expect(h.events.started).toBe(1);
    const appended = ws.sent.filter((s) => s.includes("input_audio_buffer.append")).map((s) => JSON.parse(s) as { audio: string });
    expect(appended.map((a) => a.audio)).toEqual(["AAA1", "AAA2"]); // 缓冲依序冲刷
    session.appendAudio("AAA3");
    const after = ws.sent.filter((s) => s.includes("input_audio_buffer.append")).map((s) => JSON.parse(s) as { audio: string });
    expect(after.map((a) => a.audio)).toEqual(["AAA1", "AAA2", "AAA3"]); // 后续直达
  });

  test("空 hint = 裸转写（不带 corpus 字段）；language 缺省不携带", () => {
    const h = harness();
    const session = h.adapter.open({
      context: { terms: [], hint: "" },
      callbacks: { onStarted: () => {}, onInterim: () => {}, onFinal: () => {}, onError: () => {} },
    });
    const ws = h.sockets[0]!;
    ws.emitOpen();
    const update = JSON.parse(ws.sent[0]!) as { session: { input_audio_transcription: Record<string, unknown> } };
    expect(update.session.input_audio_transcription.corpus).toBeUndefined();
    expect(update.session.input_audio_transcription.language).toBeUndefined();
    session.abort();
  });
});

describe("DashScope realtime 流式 adapter：interim/final 帧解析", () => {
  test("interim = prior(已完结句串联) + text + stash；completed 累积进 prior", () => {
    const h = harness();
    const { session } = openReady(h);
    const ws = h.sockets[0]!;
    ws.emitMessage({ type: "conversation.item.input_audio_transcription.text", text: "帮我把", stash: "Para" });
    ws.emitMessage({ type: "conversation.item.input_audio_transcription.text", text: "帮我把Paraformer", stash: "接入" });
    expect(h.events.interim).toEqual([
      { prior: "", text: "帮我把", stash: "Para" },
      { prior: "", text: "帮我把Paraformer", stash: "接入" },
    ]);
    ws.emitMessage({ type: "conversation.item.input_audio_transcription.completed", transcript: "帮我把Paraformer接入。" });
    ws.emitMessage({ type: "conversation.item.input_audio_transcription.text", text: "", stash: "先跑" });
    expect(h.events.interim[2]).toEqual({ prior: "帮我把Paraformer接入。", text: "", stash: "先跑" });
    session.abort();
  });

  test("finish → session.finish 上行；session.finished → onFinal(completed 串联)", () => {
    const h = harness();
    const { session } = openReady(h);
    const ws = h.sockets[0]!;
    ws.emitMessage({ type: "conversation.item.input_audio_transcription.completed", transcript: "第一句。" });
    session.finish();
    expect(ws.sent.some((s) => s.includes('"session.finish"'))).toBe(true);
    ws.emitMessage({ type: "conversation.item.input_audio_transcription.completed", transcript: "第二句。" }); // 尾段句终
    ws.emitMessage({ type: "session.finished" });
    expect(h.events.final).toEqual(["第一句。第二句。"]);
    expect(ws.closed).toBe(true);
  });

  test("finish 后超时无 session.finished：有文本 best-effort final / 无文本 error", () => {
    const h = harness();
    const { session } = openReady(h);
    const ws = h.sockets[0]!;
    ws.emitMessage({ type: "conversation.item.input_audio_transcription.completed", transcript: "已识别文本。" });
    session.finish();
    h.clock.fireAll();
    expect(h.events.final).toEqual(["已识别文本。"]);
    expect(h.events.errors).toHaveLength(0);

    const h2 = harness();
    const { session: s2 } = openReady(h2);
    s2.finish();
    h2.clock.fireAll();
    expect(h2.events.final).toHaveLength(0);
    expect(h2.events.errors[0]).toContain("超时");
  });
});

describe("DashScope realtime 流式 adapter：断连重连一次与 60s 空闲关", () => {
  test("意外断连 → 重连一次（重放已上行音频 + 补发 finish）；再断 → error", () => {
    const h = harness();
    const { session } = openReady(h);
    session.appendAudio("AA1");
    session.appendAudio("AA2");
    h.sockets[0]!.emitUnexpectedClose(); // 第一次意外断
    expect(h.sockets).toHaveLength(2); // 重连建了新 WS
    const ws2 = h.sockets[1]!;
    ws2.emitOpen();
    const update2 = JSON.parse(ws2.sent[0]!) as { type: string };
    expect(update2.type).toBe("session.update");
    // 重放发生在新连接 session.updated 后（上游就绪才收 append）
    expect(ws2.sent.filter((s) => s.includes("input_audio_buffer.append"))).toHaveLength(0);
    ws2.emitMessage({ type: "session.updated", session: {} });
    const replay = ws2.sent.filter((s) => s.includes("input_audio_buffer.append")).map((s) => JSON.parse(s) as { audio: string });
    expect(replay.map((a) => a.audio)).toEqual(["AA1", "AA2"]); // 音频重放
    session.appendAudio("AA3");
    expect(ws2.sent.filter((s) => s.includes("input_audio_buffer.append")).map((s) => (JSON.parse(s) as { audio: string }).audio)).toEqual(["AA1", "AA2", "AA3"]);

    session.finish();
    expect(ws2.sent.some((s) => s.includes('"session.finish"'))).toBe(true);
    ws2.emitUnexpectedClose(); // 第二次断（重连额度耗尽）
    expect(h.events.errors[0]).toContain("断开");
  });

  test("重连后 session.updated 不再触发 onStarted（started 恰一次）", () => {
    const h = harness();
    const { session } = openReady(h);
    h.sockets[0]!.emitUnexpectedClose();
    const ws2 = h.sockets[1]!;
    ws2.emitOpen();
    ws2.emitMessage({ type: "session.updated", session: {} });
    expect(h.events.started).toBe(1);
    session.abort();
  });

  test("60 秒无音频 → 关流 + error（money 纪律安全阀）", () => {
    const h = harness();
    const { session } = openReady(h);
    const ws = h.sockets[0]!;
    expect(h.clock.pending).toBeGreaterThan(0); // idle 计时器在飞
    h.clock.fireAll();
    expect(ws.closed).toBe(true);
    expect(h.events.errors[0]).toContain("60");
  });

  test("append 会重置 idle 计时器（持续说话不断流）", () => {
    const h = harness();
    const { session } = openReady(h);
    const before = h.clock.pending;
    session.appendAudio("AA");
    expect(h.clock.pending).toBe(before); // 重置后仍是一个在飞计时器
    session.abort();
  });
});

describe("DashScope realtime 流式 adapter：abort 与终态纪律", () => {
  test("abort = 关上游不期终帧；后续回调零（幂等）", () => {
    const h = harness();
    const { session } = openReady(h);
    const ws = h.sockets[0]!;
    session.abort();
    session.abort();
    expect(ws.closed).toBe(true);
    expect(h.events.final).toHaveLength(0);
    expect(h.events.errors).toHaveLength(0);
    expect(h.clock.pending).toBe(0); // 计时器全清
  });

  test("上游 error 事件 → 流失败（中文错误面）", () => {
    const h = harness();
    const { session } = openReady(h);
    h.sockets[0]!.emitMessage({ type: "error", error: { code: "invalid_api_key", message: "Invalid API-key" } });
    expect(h.events.errors[0]).toContain("Invalid API-key");
    session.abort();
  });

  test("final 后上游再无消费（closed 态 append/finish 静默）", () => {
    const h = harness();
    const { session } = openReady(h);
    const ws = h.sockets[0]!;
    ws.emitMessage({ type: "session.finished" });
    expect(h.events.final).toEqual([""]);
    const sentBefore = ws.sent.length;
    session.appendAudio("AA");
    session.finish();
    expect(ws.sent.length).toBe(sentBefore);
  });

  test("模型名常量 = 冒烟实测模型（qwen3-asr-flash-realtime）", () => {
    const h = harness();
    expect(h.adapter.model).toBe(DASHSCOPE_ASR_REALTIME_MODEL);
    expect(DASHSCOPE_ASR_REALTIME_MODEL).toBe("qwen3-asr-flash-realtime");
  });
});
