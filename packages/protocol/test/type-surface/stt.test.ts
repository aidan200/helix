/**
 * 语音输入批（V1 云转写）+ 流式转写批（V3b-1）additive 断言：
 * - stt.transcribe 命令（音频 base64 data URL 载荷，对齐图片附件先例；
 *   信封 sessionId 可选——携带时 daemon 组装会话词汇表）；
 * - stt.transcribe.result 结果帧（点对点回执，channel = "stt" 新族；两判别
 *   ok/error）；
 * - stt.stream 四命令族（start/chunk/finish/stop——上行音频块流式转写）；
 * - stt.stream 三事件族（started/interim/final——下行流式帧，streamId
 *   单飞门控判别位）；
 * - 全字段可选位 additive（durationMs / language / 信封 sessionId——旧客户端
 *   零破坏；audio 必填）；
 * - CHANNEL 目录扩 "stt"（新增族 = additive，不动分发器）。
 */
import { describe, expect, test } from "bun:test";
import { COMMAND_TYPES, EVENT_CHANNELS, EVENT_TYPES, PROTOCOL_VERSION } from "../../src/index";
import type {
  SttStreamChunkCommand,
  SttStreamFinalEvent,
  SttStreamFinalPayload,
  SttStreamFinishCommand,
  SttStreamInterimEvent,
  SttStreamStartCommand,
  SttStreamStartedEvent,
  SttStreamStartedPayload,
  SttStreamStopCommand,
  SttTranscribeCommand,
  SttTranscribePayload,
  SttTranscribeResultEvent,
  SttTranscribeResultPayload,
} from "../../src/index";
import type { Equal, Expect, TypeOfChannel } from "./samples/helpers";
import { dispatchCommand, familyOf, summarizeEvent } from "./samples/helpers";

const TINY_AUDIO_DATA_URL = "data:audio/webm;codecs=opus;base64,SGVsbG8=";

// ── 类型级断言（编译期；任一不满足 → tsc --noEmit 失败）──

// payload 字段形状：audio 必填、durationMs/language 可选（additive 纪律）
type _AudioRequired = Expect<Equal<SttTranscribePayload["audio"], string>>;
type _DurationMs = Expect<Equal<SttTranscribePayload["durationMs"], number | undefined>>;
type _Language = Expect<Equal<SttTranscribePayload["language"], string | undefined>>;

// 结果帧 payload 两判别联合
type _OkBranch = Expect<
  Equal<Extract<SttTranscribeResultPayload, { status: "ok" }>["text"], string>
>;
type _ErrorBranch = Expect<
  Equal<Extract<SttTranscribeResultPayload, { status: "error" }>["reason"], string>
>;

// channel = "stt" 新族窄化（familyOf case 存在 + TypeOfChannel 收窄）
type _SttFamily = Expect<
  Equal<
    TypeOfChannel<"stt">,
    "stt.transcribe.result" | "stt.stream.started" | "stt.stream.interim" | "stt.stream.final"
  >
>;

// 目录登记（运行时目录常量包含新成员）
type _CommandInEnvelope = Expect<Equal<SttTranscribeCommand["type"], "stt.transcribe">>;

const sttCommand: SttTranscribeCommand = {
  v: PROTOCOL_VERSION,
  type: "stt.transcribe",
  sessionId: "sess-1", // 会话内语音输入（P1 会话词汇表源）
  payload: {
    audio: TINY_AUDIO_DATA_URL,
    durationMs: 4200,
    language: "zh",
  },
};

const sttOkResult: SttTranscribeResultEvent = {
  v: PROTOCOL_VERSION,
  sessionId: "sess-1",
  channel: "stt",
  type: "stt.transcribe.result",
  payload: { status: "ok", text: "把 useEffect 修一下", provider: "dashscope", language: "zh" },
};

const sttErrorResult: SttTranscribeResultEvent = {
  v: PROTOCOL_VERSION,
  sessionId: "sess-1",
  channel: "stt",
  type: "stt.transcribe.result",
  payload: { status: "error", reason: "auth.json 中没有 provider \"dashscope\" 的 API key" },
};

describe("语音输入批（V1 云转写）：stt.transcribe additive", () => {
  test("命令/事件/通道目录登记（COMMAND_TYPES / EVENT_TYPES / EVENT_CHANNELS）", () => {
    expect(COMMAND_TYPES).toContain("stt.transcribe");
    expect(EVENT_TYPES).toContain("stt.transcribe.result");
    expect(EVENT_CHANNELS["stt.transcribe.result"]).toBe("stt");
  });

  test("命令信封可构造且 dispatch 窄化消费 audio/durationMs/language 独有字段", () => {
    expect(dispatchCommand(sttCommand)).toBe(`stt-transcribe:${TINY_AUDIO_DATA_URL.slice(0, 8)}:4200:zh`);
    // provider 可选位：携带时随命令传入（设置页用户偏好）
    const withProvider: SttTranscribeCommand = {
      v: PROTOCOL_VERSION,
      type: "stt.transcribe",
      payload: { audio: TINY_AUDIO_DATA_URL, provider: "dashscope" },
    };
    expect(withProvider.payload.provider).toBe("dashscope");
    // 最小载荷（仅 audio 必填）：可选位缺省仍合法
    const minimal: SttTranscribeCommand = {
      v: PROTOCOL_VERSION,
      type: "stt.transcribe",
      payload: { audio: TINY_AUDIO_DATA_URL },
    };
    expect(dispatchCommand(minimal)).toBe(`stt-transcribe:${TINY_AUDIO_DATA_URL.slice(0, 8)}:-:auto`);
  });

  test("结果帧两判别窄化：ok 文本/provider 可达、error reason 可达", () => {
    expect(summarizeEvent(sttOkResult)).toBe("stt-result:ok:dashscope:把 useEffect 修一下");
    expect(summarizeEvent(sttErrorResult)).toBe(
      'stt-result:error:auth.json 中没有 provider "dashscope" 的 API key',
    );
  });

  test("familyOf 分族窄化：channel=stt → 'stt/stt.transcribe.result'", () => {
    expect(familyOf(sttOkResult)).toBe("stt/stt.transcribe.result");
  });
});

// ── 流式转写批（V3b-1）：stt.stream 四命令 + 三事件 ─────────────

const streamStart: SttStreamStartCommand = {
  v: PROTOCOL_VERSION,
  type: "stt.stream.start",
  payload: { language: "zh", provider: "dashscope" },
};
const streamStartMinimal: SttStreamStartCommand = {
  v: PROTOCOL_VERSION,
  type: "stt.stream.start",
  payload: {},
};
const streamChunk: SttStreamChunkCommand = {
  v: PROTOCOL_VERSION,
  type: "stt.stream.chunk",
  payload: { audio: "AAAAgL8AAACAvw==" }, // base64 PCM 16k mono ~100ms
};
const streamFinish: SttStreamFinishCommand = { v: PROTOCOL_VERSION, type: "stt.stream.finish", payload: {} };
const streamStop: SttStreamStopCommand = { v: PROTOCOL_VERSION, type: "stt.stream.stop", payload: {} };

const streamStartedOk: SttStreamStartedEvent = {
  v: PROTOCOL_VERSION,
  sessionId: "sess-1",
  channel: "stt",
  type: "stt.stream.started",
  payload: { status: "ok", streamId: "str-1", provider: "dashscope", model: "qwen3-asr-flash-realtime" },
};
const streamStartedError: SttStreamStartedEvent = {
  v: PROTOCOL_VERSION,
  sessionId: "sess-1",
  channel: "stt",
  type: "stt.stream.started",
  payload: { status: "error", reason: "provider 未录入 API key" },
};
const streamInterim: SttStreamInterimEvent = {
  v: PROTOCOL_VERSION,
  sessionId: "sess-1",
  channel: "stt",
  type: "stt.stream.interim",
  payload: { streamId: "str-1", prior: "", text: "帮我把", stash: "Paraformer" },
};
const streamFinalOk: SttStreamFinalEvent = {
  v: PROTOCOL_VERSION,
  sessionId: "sess-1",
  channel: "stt",
  type: "stt.stream.final",
  payload: { status: "ok", streamId: "str-1", text: "帮我把 Paraformer 接入", provider: "dashscope" },
};
const streamFinalError: SttStreamFinalEvent = {
  v: PROTOCOL_VERSION,
  sessionId: "sess-1",
  channel: "stt",
  type: "stt.stream.final",
  payload: { status: "error", streamId: "str-1", reason: "上游连接断开" },
};

// 类型级断言：stream 族 payload 全字段（additive 纪律——可选位显式 undefined）
type _StreamChunkAudio = Expect<Equal<SttStreamChunkCommand["payload"]["audio"], string>>;
type _StreamStartLanguage = Expect<Equal<SttStreamStartCommand["payload"]["language"], string | undefined>>;
type _StartedOkStreamId = Expect<
  Equal<Extract<SttStreamStartedPayload, { status: "ok" }>["streamId"], string>
>;
type _InterimPrior = Expect<Equal<SttStreamInterimEvent["payload"]["prior"], string>>;
type _FinalOkText = Expect<Equal<Extract<SttStreamFinalPayload, { status: "ok" }>["text"], string>>;
type _FinalErrorStreamId = Expect<
  Equal<Extract<SttStreamFinalPayload, { status: "error" }>["streamId"], string>
>;

describe("流式转写批（V3b-1）：stt.stream 命令/事件族 additive", () => {
  test("目录登记（COMMAND_TYPES 四命令 / EVENT_TYPES 三事件 / CHANNEL 目录）", () => {
    expect(COMMAND_TYPES).toContain("stt.stream.start");
    expect(COMMAND_TYPES).toContain("stt.stream.chunk");
    expect(COMMAND_TYPES).toContain("stt.stream.finish");
    expect(COMMAND_TYPES).toContain("stt.stream.stop");
    expect(EVENT_TYPES).toContain("stt.stream.started");
    expect(EVENT_TYPES).toContain("stt.stream.interim");
    expect(EVENT_TYPES).toContain("stt.stream.final");
    for (const ty of ["stt.stream.started", "stt.stream.interim", "stt.stream.final"]) {
      expect(EVENT_CHANNELS[ty as "stt.stream.started"]).toBe("stt");
    }
  });

  test("四命令信封可构造且 dispatch 窄化消费独立字段", () => {
    expect(dispatchCommand(streamStart)).toBe("stt-stream-start:zh:dashscope");
    expect(dispatchCommand(streamStartMinimal)).toBe("stt-stream-start:auto:auto");
    expect(dispatchCommand(streamChunk)).toBe("stt-stream-chunk:AAAAg");
    expect(dispatchCommand(streamFinish)).toBe("stt-stream-finish");
    expect(dispatchCommand(streamStop)).toBe("stt-stream-stop");
  });

  test("三事件帧窄化：started 两判别 / interim 四字段 / final 两判别", () => {
    expect(summarizeEvent(streamStartedOk)).toBe("stt-stream-started:ok:dashscope:str-1");
    expect(summarizeEvent(streamStartedError)).toBe("stt-stream-started:error:provider 未录入 API key");
    expect(summarizeEvent(streamInterim)).toBe("stt-stream-interim:str-1::帮我把:Paraformer");
    expect(summarizeEvent(streamFinalOk)).toBe("stt-stream-final:ok:str-1:帮我把 Paraformer 接入");
    expect(summarizeEvent(streamFinalError)).toBe("stt-stream-final:error:str-1:上游连接断开");
  });

  test("familyOf：stt 族四事件全窄化", () => {
    expect(familyOf(streamStartedOk)).toBe("stt/stt.stream.started");
    expect(familyOf(streamInterim)).toBe("stt/stt.stream.interim");
    expect(familyOf(streamFinalOk)).toBe("stt/stt.stream.final");
  });
});
