/**
 * 语音播报批（V2 TTS）additive 断言：
 * - voice.synthesize 命令（一次性合成试听面；text 必填、voice/language 可选）；
 * - voice.subscribe / voice.unsubscribe 命令（播报连接级订阅闸门——
 *   daemon 仅在有订阅连接时合成，默认零花费）；
 * - voice.broadcast 广播帧（daemon→已订阅连接；payload 含 text + audio
 *   base64 data URL + provider + seq 顺序号）；
 * - voice.synthesize.result 点对点结果帧（两判别 ok/error）；
 * - CHANNEL 目录扩 "voice"（新增族 = additive，不动分发器）。
 */
import { describe, expect, test } from "bun:test";
import { COMMAND_TYPES, EVENT_CHANNELS, EVENT_TYPES, PROTOCOL_VERSION } from "../../src/index";
import type {
  VoiceBroadcastEvent,
  VoiceBroadcastPayload,
  VoiceSubscribeCommand,
  VoiceSynthesizeCommand,
  VoiceSynthesizeResultEvent,
  VoiceSynthesizeResultPayload,
  VoiceUnsubscribeCommand,
} from "../../src/index";
import type { Equal, Expect, TypeOfChannel } from "./samples/helpers";
import { dispatchCommand, familyOf, summarizeEvent } from "./samples/helpers";

const TINY_WAV_DATA_URL = "data:audio/wav;base64,UklGRiQAAABXQVZFZm10";

// ── 类型级断言（编译期；任一不满足 → tsc --noEmit 失败）──

// payload 字段形状：text 必填、voice/language 可选（additive 纪律）
type _TextRequired = Expect<Equal<VoiceSynthesizeCommand["payload"]["text"], string>>;
type _SynthVoice = Expect<Equal<VoiceSynthesizeCommand["payload"]["voice"], string | undefined>>;

// 广播帧 payload：audio data URL + seq 顺序号必填
type _BroadcastAudio = Expect<Equal<VoiceBroadcastPayload["audio"], string>>;
type _BroadcastSeq = Expect<Equal<VoiceBroadcastPayload["seq"], number>>;
type _BroadcastKind = Expect<
  Equal<VoiceBroadcastPayload["kind"], "agent.completed" | "agent.failed" | "agent.killed">
>;

// 结果帧 payload 两判别联合
type _OkBranch = Expect<
  Equal<Extract<VoiceSynthesizeResultPayload, { status: "ok" }>["audio"], string>
>;
type _ErrorBranch = Expect<
  Equal<Extract<VoiceSynthesizeResultPayload, { status: "error" }>["reason"], string>
>;

// channel = "voice" 新族窄化（familyOf case 存在 + TypeOfChannel 收窄）
type _VoiceFamily = Expect<
  Equal<
    TypeOfChannel<"voice">,
    "voice.broadcast" | "voice.synthesize.chunk" | "voice.synthesize.done" | "voice.synthesize.error" | "voice.synthesize.result"
  >
>;

const synthCommand: VoiceSynthesizeCommand = {
  v: PROTOCOL_VERSION,
  type: "voice.synthesize",
  payload: { text: "播报测试：任务完成。", voice: "Cherry", language: "zh" },
};

const subscribeCommand: VoiceSubscribeCommand = {
  v: PROTOCOL_VERSION,
  type: "voice.subscribe",
  payload: { voice: "Cherry" },
};

const unsubscribeCommand: VoiceUnsubscribeCommand = {
  v: PROTOCOL_VERSION,
  type: "voice.unsubscribe",
  payload: {},
};

const broadcastFrame: VoiceBroadcastEvent = {
  v: PROTOCOL_VERSION,
  sessionId: "sess-1",
  channel: "voice",
  type: "voice.broadcast",
  payload: {
    kind: "agent.completed",
    agentId: "agent-2",
    text: "agent-2 已完成：修复登录超时",
    audio: TINY_WAV_DATA_URL,
    provider: "dashscope",
    voice: "Cherry",
    seq: 1,
  },
};

const synthOkResult: VoiceSynthesizeResultEvent = {
  v: PROTOCOL_VERSION,
  sessionId: "sess-1",
  channel: "voice",
  type: "voice.synthesize.result",
  payload: { status: "ok", audio: TINY_WAV_DATA_URL, provider: "dashscope", voice: "Cherry" },
};

const synthErrorResult: VoiceSynthesizeResultEvent = {
  v: PROTOCOL_VERSION,
  sessionId: "sess-1",
  channel: "voice",
  type: "voice.synthesize.result",
  payload: { status: "error", reason: "auth.json 中没有 provider \"dashscope\" 的 API key" },
};

describe("语音播报批（V2 TTS）：voice 族 additive", () => {
  test("命令/事件/通道目录登记（COMMAND_TYPES / EVENT_TYPES / EVENT_CHANNELS）", () => {
    expect(COMMAND_TYPES).toContain("voice.synthesize");
    expect(COMMAND_TYPES).toContain("voice.subscribe");
    expect(COMMAND_TYPES).toContain("voice.unsubscribe");
    expect(EVENT_TYPES).toContain("voice.broadcast");
    expect(EVENT_TYPES).toContain("voice.synthesize.result");
    expect(EVENT_CHANNELS["voice.broadcast"]).toBe("voice");
    expect(EVENT_CHANNELS["voice.synthesize.result"]).toBe("voice");
  });

  test("合成命令可构造且 dispatch 窄化消费 text/voice/language 独有字段", () => {
    expect(dispatchCommand(synthCommand)).toBe("voice-synthesize:播报测试：任务完成。:Cherry");
    const minimal: VoiceSynthesizeCommand = {
      v: PROTOCOL_VERSION,
      type: "voice.synthesize",
      payload: { text: "你好" },
    };
    expect(dispatchCommand(minimal)).toBe("voice-synthesize:你好:-");
  });

  test("订阅/退订命令最小载荷构造", () => {
    expect(subscribeCommand.payload.voice).toBe("Cherry");
    expect(dispatchCommand(subscribeCommand)).toBe("voice-subscribe:Cherry");
    expect(dispatchCommand(unsubscribeCommand)).toBe("voice-unsubscribe");
  });

  test("广播帧 payload 全字段窄化可达（kind/text/audio/seq）", () => {
    expect(broadcastFrame.payload.seq).toBe(1);
    expect(broadcastFrame.payload.audio.startsWith("data:audio/")).toBe(true);
  });

  test("结果帧两判别窄化：ok audio/provider 可达、error reason 可达", () => {
    expect(summarizeEvent(synthOkResult)).toBe(`voice-result:ok:dashscope:${TINY_WAV_DATA_URL.length}`);
    expect(summarizeEvent(synthErrorResult)).toBe(
      'voice-result:error:auth.json 中没有 provider "dashscope" 的 API key',
    );
  });

  test("familyOf 分族窄化：channel=voice → 'voice/<type>'", () => {
    expect(familyOf(broadcastFrame)).toBe("voice/voice.broadcast");
    expect(familyOf(synthOkResult)).toBe("voice/voice.synthesize.result");
  });
});
