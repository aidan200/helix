/**
 * TtsStreamService 单测（V3b-2 流式 TTS 批；TDD 红→绿）。
 *
 * 覆盖面：
 * - utter → 协议帧组装：chunk（utterId/seq 1 起单调/audio）/done（provider/
 *   frames=最大 seq）/error（utterId/reason）；帧序 = 上游回调序；
 * - key 未配 → error 帧（reason 含设置页引导；shell 回落一次性合成）；
 * - stop 定向/全量：abort 上游 + 已取消句的终态回调静默（不再发帧）；
 * - closeSender：全量 abort 清位（断连清理）；
 * - 同连接多句并发（registry 按 utterId 隔离）。
 */
import { describe, expect, test, vi } from "bun:test";
import { TtsStreamService } from "../../src/application/tts/TtsStreamService";
import type { TtsStreamCallbacks, TtsStreamPort, TtsStreamSession } from "../../src/application/ports/outbound/TtsStreamPort";
import type { TtsStreamFrame } from "../../src/application/tts/TtsStreamService";

interface FakeEntry {
  session: TtsStreamSession;
  cbs: TtsStreamCallbacks;
}
class FakeAdapter implements TtsStreamPort {
  readonly providerId = "dashscope";
  readonly model = "qwen-audio-3.0-tts-flash";
  opened: FakeEntry[] = [];
  openUtterance(options: { text: string; voice?: string; callbacks: TtsStreamCallbacks }): TtsStreamSession {
    const entry: FakeEntry = { cbs: options.callbacks, session: { abort: vi.fn() } };
    this.opened.push(entry);
    return entry.session;
  }
  /** 测试驱动面。 */
  emit(i: number, ev: "audio" | "done", payload?: string): void {
    if (ev === "audio") this.opened[i]!.cbs.onAudio(payload ?? "AAA=");
    else this.opened[i]!.cbs.onDone();
  }
  fail(i: number, reason: string): void {
    this.opened[i]!.cbs.onError(reason);
  }
}

function rig(key = "sk-test") {
  const adapter = new FakeAdapter();
  const frames: Array<{ type: string; payload: Record<string, unknown> }> = [];
  const service = new TtsStreamService({
    adapters: [adapter],
    apiKeyOf: () => key,
  });
  const emit = (frame: TtsStreamFrame): void => {
    frames.push({ type: frame.type, payload: frame.payload as unknown as Record<string, unknown> });
  };
  return { adapter, service, frames, emit };
}

describe("TtsStreamService（V3b-2 单句流式生命周期）", () => {
  const SENDER = { id: "sender-1" } as object;
  const OTHER = { id: "sender-2" } as object;

  test("① utter → chunk/done 帧组装（seq 单调 1 起；frames 与最大 seq 恰等）", () => {
    const { adapter, service, frames, emit } = rig();
    service.utter(SENDER, { utterId: "u1", text: "你好。", sessionId: "__system__", emit });
    service.utter(SENDER, { utterId: "u2", text: "第二句。", sessionId: "__system__", emit });
    adapter.emit(0, "audio", "QQ==");
    adapter.emit(0, "audio", "ww==");
    adapter.emit(1, "audio", "ee==");
    adapter.emit(0, "done");
    adapter.emit(1, "done");
    expect(frames.map((f) => f.type)).toEqual([
      "voice.synthesize.chunk",
      "voice.synthesize.chunk",
      "voice.synthesize.chunk",
      "voice.synthesize.done",
      "voice.synthesize.done",
    ]);
    expect(frames[0]!.payload).toMatchObject({ utterId: "u1", seq: 1, audio: "QQ==" });
    expect(frames[1]!.payload).toMatchObject({ utterId: "u1", seq: 2 });
    expect(frames[2]!.payload).toMatchObject({ utterId: "u2", seq: 1 });
    expect(frames[3]!.payload).toMatchObject({ utterId: "u1", provider: "dashscope", frames: 2 });
    expect(frames[4]!.payload).toMatchObject({ utterId: "u2", provider: "dashscope", frames: 1 });
  });

  test("② key 未配 → error 帧（reason 含设置页引导）", () => {
    const { service, frames, emit } = rig("");
    service.utter(SENDER, { utterId: "u1", text: "x。", sessionId: "__system__", emit });
    expect(frames).toHaveLength(1);
    expect(frames[0]!.type).toBe("voice.synthesize.error");
    expect(frames[0]!.payload.utterId).toBe("u1");
    expect(String(frames[0]!.payload.reason)).toContain("auth.set_key");
  });

  test("③ 上游失败 → error 帧；后续回调静默（终态一次性）", () => {
    const { adapter, service, frames, emit } = rig();
    service.utter(SENDER, { utterId: "u1", text: "x。", sessionId: "__system__", emit });
    adapter.emit(0, "audio", "QQ==");
    adapter.fail(0, "上游连接断开");
    adapter.emit(0, "done"); // 终态后迟到回调
    expect(frames.map((f) => f.type)).toEqual(["voice.synthesize.chunk", "voice.synthesize.error"]);
    expect(frames[1]!.payload).toMatchObject({ utterId: "u1", reason: "上游连接断开" });
  });

  test("④ stop 定向：abort 该句 + 已取消句终态静默；他句不受扰", () => {
    const { adapter, service, frames, emit } = rig();
    service.utter(SENDER, { utterId: "u1", text: "x。", sessionId: "__system__", emit });
    service.utter(SENDER, { utterId: "u2", text: "y。", sessionId: "__system__", emit });
    service.stop(SENDER, "u1");
    expect(adapter.opened[0]!.session.abort).toHaveBeenCalledTimes(1);
    expect(adapter.opened[1]!.session.abort).not.toHaveBeenCalled();
    adapter.emit(0, "done"); // 被取消句：无帧
    adapter.emit(1, "audio", "QQ==");
    adapter.emit(1, "done");
    expect(frames.map((f) => f.type)).toEqual(["voice.synthesize.chunk", "voice.synthesize.done"]);
    expect(frames.every((f) => f.payload.utterId === "u2")).toBe(true);
  });

  test("⑤ stop 全量（utterId 省略）：该连接全部在途句 abort", () => {
    const { adapter, service, emit } = rig();
    service.utter(SENDER, { utterId: "u1", text: "x。", sessionId: "__system__", emit });
    service.utter(SENDER, { utterId: "u2", text: "y。", sessionId: "__system__", emit });
    service.utter(OTHER, { utterId: "u3", text: "z。", sessionId: "__system__", emit });
    service.stop(SENDER);
    expect(adapter.opened[0]!.session.abort).toHaveBeenCalledTimes(1);
    expect(adapter.opened[1]!.session.abort).toHaveBeenCalledTimes(1);
    expect(adapter.opened[2]!.session.abort).not.toHaveBeenCalled(); // 他连接不受扰
  });

  test("⑥ closeSender：全量 abort 清位（断连清理，同 stt.stream 纪律）", () => {
    const { adapter, service, emit } = rig();
    service.utter(SENDER, { utterId: "u1", text: "x。", sessionId: "__system__", emit });
    service.closeSender(SENDER);
    expect(adapter.opened[0]!.session.abort).toHaveBeenCalledTimes(1);
    // closeSender 后同 sender 新句照常（登记重建）
    service.utter(SENDER, { utterId: "u9", text: "w。", sessionId: "__system__", emit });
    expect(adapter.opened.length).toBe(2);
  });

  test("⑦ 重复 utterId：废旧句再开新句（连接内 utterId 唯一性由 shell 保证，daemon 防御）", () => {
    const { adapter, service, emit } = rig();
    service.utter(SENDER, { utterId: "u1", text: "x。", sessionId: "__system__", emit });
    service.utter(SENDER, { utterId: "u1", text: "x。", sessionId: "__system__", emit });
    expect(adapter.opened[0]!.session.abort).toHaveBeenCalledTimes(1);
    expect(adapter.opened.length).toBe(2);
  });
});
