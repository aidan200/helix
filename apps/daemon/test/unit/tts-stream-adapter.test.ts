/**
 * DashScopeStreamingTtsAdapter 单测（V3b-2 流式 TTS 批；TDD 红→绿）。
 *
 * 覆盖面（协议形态以 docs/temp/tts-streaming/DECISION.md 冒烟钉死）：
 * - openUtterance：run-task 形态（task_group audio/task tts/function
 *   SpeechSynthesizer/streaming duplex/voice/format pcm/sample_rate 24000）；
 *   task-started 后 continue-task 整句 + finish-task 立即跟随；
 * - 二进制帧 → onAudio(base64)；task-finished → onDone + 连接回池复用；
 * - task-failed → onError（header.error_code/message 上抛）；
 * - abort → finish-task directive=cancel + 连接废弃（不回池）；
 * - 意外断连（在用）→ onError；池内空闲连接断连 → 静默摘除；
 * - 空闲回收定时器（20s 无新任务关闭）；
 * - key 未配 → openUtterance 同步抛中文引导。
 * 零真实网络：wsFactory/定时器面全注入。
 */
import { describe, expect, test, vi } from "bun:test";
import { DashScopeStreamingTtsAdapter, DASHSCOPE_TTS_STREAM_MODEL, DASHSCOPE_TTS_STREAM_VOICE, TTS_STREAM_IDLE_MS } from "../../src/adapters/driven/tts/streaming";

/** 最小 WS 假体（文本/二进制双通道；剧本驱动）。 */
class FakeSocket {
  sent: string[] = [];
  listeners = new Map<string, Set<(ev: { data?: unknown }) => void>>();
  closed = false;
  closeCode: number | undefined;
  constructor(public readonly label: string) {}
  send(data: string): void {
    this.sent.push(data);
  }
  close(code?: number): void {
    this.closed = true;
    this.closeCode = code;
  }
  addEventListener(type: string, l: (ev: { data?: unknown }) => void): void {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)!.add(l);
  }
  removeEventListener(type: string, l: (ev: { data?: unknown }) => void): void {
    this.listeners.get(type)?.delete(l);
  }
  fire(type: "open" | "message" | "close", data?: unknown): void {
    for (const l of this.listeners.get(type) ?? []) l({ data });
  }
}

interface Harness {
  adapter: DashScopeStreamingTtsAdapter;
  sockets: FakeSocket[];
  timers: Map<number, { cb: () => void; ms: number; fired: boolean }>;
  nextId: () => number;
  key: string | undefined;
  advance: (ms: number) => void;
}

function harness(key = "sk-test"): Harness {
  const sockets: FakeSocket[] = [];
  const timers = new Map<number, { cb: () => void; ms: number; fired: boolean }>();
  let next = 1;
  const h: Harness = {
    sockets,
    timers,
    key,
    nextId: () => next,
    adapter: new DashScopeStreamingTtsAdapter({
      getApiKey: () => h.key,
      wsFactory: (_url, _headers) => {
        const s = new FakeSocket(`ws-${next++}`);
        sockets.push(s);
        queueMicrotask(() => s.fire("open"));
        return s;
      },
      setTimer: (cb, ms) => {
        const id = next++;
        timers.set(id, { cb, ms, fired: false });
        return id;
      },
      clearTimer: (id) => {
        timers.delete(id);
      },
    }),
    advance: (ms) => {
      for (const [, t] of [...timers.entries()]) {
        if (!t.fired && ms >= t.ms) {
          t.fired = true;
          t.cb();
        }
      }
    },
  };
  return h;
}

const cb = () => ({ onAudio: vi.fn(), onDone: vi.fn(), onError: vi.fn() });
const sentJson = (s: FakeSocket) => s.sent.map((raw) => JSON.parse(raw) as Record<string, any>);

describe("DashScopeStreamingTtsAdapter（V3b-2 流式 TTS）", () => {
  test("① openUtterance：key 未配同步抛中文引导（不发帧不建连）", () => {
    const h = harness("");
    expect(() => h.adapter.openUtterance({ text: "测试。", callbacks: cb() })).toThrow("dashscope");
    expect(h.sockets.length).toBe(0);
  });

  test("② 协议形态：run-task → task-started → continue-task 整句 + finish-task；二进制帧透传；task-finished 收口", () => {
    const h = harness();
    const c = cb();
    h.adapter.openUtterance({ text: "你好，我是管家。", voice: "longanlingxi", callbacks: c });
    const s = h.sockets[0]!;
    expect(h.sockets.length).toBe(1);
    // open 后即发 run-task
    let msgs = sentJson(s);
    expect(msgs[0]!.header.action).toBe("run-task");
    expect(msgs[0]!.header.streaming).toBe("duplex");
    expect(typeof msgs[0]!.header.task_id).toBe("string");
    expect(msgs[0]!.payload.task_group).toBe("audio");
    expect(msgs[0]!.payload.task).toBe("tts");
    expect(msgs[0]!.payload.function).toBe("SpeechSynthesizer");
    expect(msgs[0]!.payload.model).toBe(DASHSCOPE_TTS_STREAM_MODEL);
    expect(msgs[0]!.payload.parameters.voice).toBe("longanlingxi");
    expect(msgs[0]!.payload.parameters.format).toBe("pcm");
    expect(msgs[0]!.payload.parameters.sample_rate).toBe(24000);
    expect(msgs[0]!.payload.input).toEqual({});
    const taskId = msgs[0]!.header.task_id as string;
    // task-started → continue-task（整句）+ finish-task 背靠背
    s.fire("message", JSON.stringify({ header: { event: "task-started", task_id: taskId } }));
    msgs = sentJson(s);
    expect(msgs[1]!.header.action).toBe("continue-task");
    expect(msgs[1]!.header.task_id).toBe(taskId);
    expect(msgs[1]!.payload.input.text).toBe("你好，我是管家。");
    expect(msgs[2]!.header.action).toBe("finish-task");
    expect(msgs[2]!.payload.input).toEqual({});
    // 二进制帧 → onAudio（base64）
    s.fire("message", new Uint8Array([1, 2, 3]).buffer as ArrayBuffer);
    expect(c.onAudio).toHaveBeenCalledTimes(1);
    const arg = (c.onAudio.mock.calls[0] as unknown as [string])[0];
    expect([...Buffer.from(arg, "base64")]).toEqual([1, 2, 3]);
    // task-finished → onDone
    s.fire("message", JSON.stringify({ header: { event: "task-finished", task_id: taskId } }));
    expect(c.onDone).toHaveBeenCalledTimes(1);
    expect(c.onError).not.toHaveBeenCalled();
    // 连接回池：第二句不再新建 WS
    const c2 = cb();
    h.adapter.openUtterance({ text: "第二句。", callbacks: c2 });
    expect(h.sockets.length).toBe(1);
    const msgs2 = sentJson(s);
    expect(msgs2[3]!.header.action).toBe("run-task");
    expect(msgs2[3]!.header.task_id).not.toBe(taskId); // 新 task_id
  });

  test("③ 缺省音色 = longanlingxi（导出常量）", () => {
    const h = harness();
    h.adapter.openUtterance({ text: "x。", callbacks: cb() });
    const p = sentJson(h.sockets[0]!)[0]!;
    expect(p.payload.parameters.voice).toBe(DASHSCOPE_TTS_STREAM_VOICE);
  });

  test("④ task-failed → onError（code/message 上抛）", () => {
    const h = harness();
    const c = cb();
    h.adapter.openUtterance({ text: "x。", callbacks: c });
    const s = h.sockets[0]!;
    s.fire("message", JSON.stringify({ header: { event: "task-failed", error_code: "InvalidParameter", error_message: "[cosyvoice:]Engine return error code: 418" } }));
    expect(c.onError).toHaveBeenCalledTimes(1);
    expect((c.onError.mock.calls[0] as unknown as [string])[0]).toContain("418");
    expect(c.onDone).not.toHaveBeenCalled();
    expect(s.closed).toBe(true); // 失败连接废弃不回池
    // 下一句新建连接
    h.adapter.openUtterance({ text: "y。", callbacks: cb() });
    expect(h.sockets.length).toBe(2);
  });

  test("⑤ abort → finish-task directive=cancel + 连接关闭不回池；后续回调静默", () => {
    const h = harness();
    const c = cb();
    const session = h.adapter.openUtterance({ text: "x。", callbacks: c });
    const s = h.sockets[0]!;
    s.fire("message", JSON.stringify({ header: { event: "task-started", task_id: sentJson(s)[0]!.header.task_id } }));
    session.abort();
    const msgs = sentJson(s);
    expect(msgs.at(-1)!.header.action).toBe("finish-task");
    expect(msgs.at(-1)!.payload.input.directive).toBe("cancel");
    expect(s.closed).toBe(true);
    // cancel 后服务端仍回 task-finished：终态回调静默（stop 语义收口在 service 层）
    s.fire("message", JSON.stringify({ header: { event: "task-finished" } }));
    expect(c.onDone).not.toHaveBeenCalled();
    // 幂等
    expect(() => session.abort()).not.toThrow();
  });

  test("⑥ 在用意外断连 → onError；池内空闲断连 → 静默摘除（下次新建）", () => {
    const h = harness();
    const c1 = cb();
    h.adapter.openUtterance({ text: "x。", callbacks: c1 });
    const s = h.sockets[0]!;
    s.fire("message", JSON.stringify({ header: { event: "task-started", task_id: sentJson(s)[0]!.header.task_id } }));
    s.fire("close");
    expect(c1.onError).toHaveBeenCalledTimes(1);
    // 失败后新句：新建
    const c2 = cb();
    h.adapter.openUtterance({ text: "y。", callbacks: c2 });
    const s2 = h.sockets[1]!;
    expect(h.sockets.length).toBe(2);
    s2.fire("message", JSON.stringify({ header: { event: "task-started", task_id: sentJson(s2)[0]!.header.task_id } }));
    s2.fire("message", JSON.stringify({ header: { event: "task-finished" } }));
    // s2 空闲回池；断连 → 静默
    s2.fire("close");
    const c3 = cb();
    h.adapter.openUtterance({ text: "z。", callbacks: c3 });
    expect(h.sockets.length).toBe(3); // 新建（池内断连已摘除）
  });

  test("⑦ 空闲回收：回池连接 TTS_STREAM_IDLE_MS 无新任务即关闭", () => {
    const h = harness();
    const c = cb();
    h.adapter.openUtterance({ text: "x。", callbacks: c });
    const s = h.sockets[0]!;
    s.fire("message", JSON.stringify({ header: { event: "task-started", task_id: sentJson(s)[0]!.header.task_id } }));
    s.fire("message", JSON.stringify({ header: { event: "task-finished" } }));
    expect(s.closed).toBe(false); // 回池存活
    h.advance(TTS_STREAM_IDLE_MS);
    expect(s.closed).toBe(true);
  });

  test("⑧ 终态超时兜底：finish-task 后 TTS_STREAM_FINISH_TIMEOUT_MS 无 task-finished → onError", () => {
    const h = harness();
    const c = cb();
    h.adapter.openUtterance({ text: "x。", callbacks: c });
    const s = h.sockets[0]!;
    s.fire("message", JSON.stringify({ header: { event: "task-started", task_id: sentJson(s)[0]!.header.task_id } }));
    // 不回 task-finished
    h.advance(60_000);
    expect(c.onError).toHaveBeenCalledTimes(1);
    expect((c.onError.mock.calls[0] as unknown as [string])[0]).toContain("超时");
  });

  test("⑨ started 超时：run-task 后无 task-started → onError", () => {
    const h = harness();
    const c = cb();
    h.adapter.openUtterance({ text: "x。", callbacks: c });
    h.advance(30_000);
    expect(c.onError).toHaveBeenCalledTimes(1);
    expect(h.sockets[0]!.closed).toBe(true);
  });
});

// ── 模型配置接入 P0：model getter（配置值优先，空/未配回落默认）──────

describe("模型配置接入 P0：getModel 注入（流式 TTS）", () => {
  test("model getter：getModel 生效；空/未配回落 DASHSCOPE_TTS_STREAM_MODEL", () => {
    const overridden = new DashScopeStreamingTtsAdapter({ getApiKey: () => "k", getModel: () => "stream-tts-custom" });
    expect(overridden.model).toBe("stream-tts-custom");
    const blank = new DashScopeStreamingTtsAdapter({ getApiKey: () => "k", getModel: () => " " });
    expect(blank.model).toBe(DASHSCOPE_TTS_STREAM_MODEL);
    const absent = new DashScopeStreamingTtsAdapter({ getApiKey: () => "k" });
    expect(absent.model).toBe(DASHSCOPE_TTS_STREAM_MODEL);
  });
});
