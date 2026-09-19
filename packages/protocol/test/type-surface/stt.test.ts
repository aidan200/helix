/**
 * 语音输入批（V1 云转写）additive 断言：
 * - stt.transcribe 命令（音频 base64 data URL 载荷，对齐图片附件先例；
 *   信封 sessionId 可选——携带时 daemon 组装会话词汇表）；
 * - stt.transcribe.result 结果帧（点对点回执，channel = "stt" 新族；两判别
 *   ok/error）；
 * - 全字段可选位 additive（durationMs / language / 信封 sessionId——旧客户端
 *   零破坏；audio 必填）；
 * - CHANNEL 目录扩 "stt"（新增族 = additive，不动分发器）。
 */
import { describe, expect, test } from "bun:test";
import { COMMAND_TYPES, EVENT_CHANNELS, EVENT_TYPES, PROTOCOL_VERSION } from "../../src/index";
import type {
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
type _SttFamily = Expect<Equal<TypeOfChannel<"stt">, "stt.transcribe.result">>;

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
