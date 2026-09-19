/**
 * steward-voice-machine 纯函数面测试（管家语音模式 V3a；TDD 红→绿）。
 *
 * - deriveStewardVoicePhase：子状态聚合派生（unsupported/idle/listening/
 *   transcribing/asking/speaking）+ 优先级（录音链在途 > ask 在途 > 朗读）；
 * - shouldSpeakReply：money 纪律朗读闸（语音模式 + 偏好开 + answer 终态
 *   三条件缺一不可；error/confirm_required 不朗读）；
 * - mdToSpeechText：Markdown 回复 → 语音文本（fenced code 剥离 / 行内标记
 *   剥离 / 链接取文本 / 空产物回空串 / daemon 500 字符上限截断）；
 * - planTranscript：转写出路（ask 发出 → asked；发送失败 → fallback 草稿
 *   回填——文本态可重试，零静默丢话）。
 */
import { describe, expect, it } from "vitest";
import {
  deriveStewardVoicePhase,
  shouldSpeakReply,
  mdToSpeechText,
  planTranscript,
  STEWARD_SPEECH_TEXT_MAX,
  type StewardVoiceSnapshot,
} from "./steward-voice-machine";

const snap = (over: Partial<StewardVoiceSnapshot>): StewardVoiceSnapshot => ({
  voiceState: "idle",
  askInFlight: false,
  speaking: false,
  ...over,
});

describe("deriveStewardVoicePhase（阶段派生）", () => {
  it("mic 环境不可用 → unsupported（面板回退文本态）", () => {
    expect(deriveStewardVoicePhase(snap({ voiceState: "unsupported" }))).toBe("unsupported");
  });

  it("录音中 → listening；上传/转写在途 → transcribing", () => {
    expect(deriveStewardVoicePhase(snap({ voiceState: "recording" }))).toBe("listening");
    expect(deriveStewardVoicePhase(snap({ voiceState: "transcribing" }))).toBe("transcribing");
  });

  it("录音链空闲 + ask 在途 → asking", () => {
    expect(deriveStewardVoicePhase(snap({ askInFlight: true }))).toBe("asking");
  });

  it("全空闲 + 朗读中 → speaking；全空闲 → idle", () => {
    expect(deriveStewardVoicePhase(snap({ speaking: true }))).toBe("speaking");
    expect(deriveStewardVoicePhase(snap({}))).toBe("idle");
  });

  it("优先级：新一轮录音链在途压过 ask/朗读残留（转写期间上轮音频停读）", () => {
    expect(deriveStewardVoicePhase(snap({ voiceState: "recording", askInFlight: true, speaking: true }))).toBe("listening");
    expect(deriveStewardVoicePhase(snap({ voiceState: "transcribing", speaking: true }))).toBe("transcribing");
    expect(deriveStewardVoicePhase(snap({ askInFlight: true, speaking: true }))).toBe("asking");
  });
});

describe("shouldSpeakReply（money 纪律朗读闸）", () => {
  it("语音模式 + 偏好开 + answer 终态 → 朗读", () => {
    expect(shouldSpeakReply({ mode: "voice", speakEnabled: true, askResult: { status: "answer" } })).toBe(true);
  });

  it("文本模式永不朗读；偏好关不朗读（money 纪律）", () => {
    expect(shouldSpeakReply({ mode: "text", speakEnabled: true, askResult: { status: "answer" } })).toBe(false);
    expect(shouldSpeakReply({ mode: "voice", speakEnabled: false, askResult: { status: "answer" } })).toBe(false);
  });

  it("非 answer 终态不朗读（error 直答错误原因/confirm_required 走确认卡）", () => {
    expect(shouldSpeakReply({ mode: "voice", speakEnabled: true, askResult: { status: "error" } })).toBe(false);
    expect(shouldSpeakReply({ mode: "voice", speakEnabled: true, askResult: { status: "confirm_required" } })).toBe(false);
  });
});

describe("mdToSpeechText（Markdown → 语音文本）", () => {
  it("fenced 代码块整块剥离（读代码无意义）；正文保留", () => {
    const md = "现在跑着 2 个任务：\n\n```ts\nconst x = 1;\n```\n\n都在正常推进。";
    expect(mdToSpeechText(md)).toBe("现在跑着 2 个任务： 都在正常推进。");
  });

  it("行内 code 保留内容剥标记；加粗/斜体/删除线剥标记；链接取文本", () => {
    expect(mdToSpeechText("用 **steward.confirm** 放行，或 _取消_ 即可。")).toBe("用 steward.confirm 放行，或 取消 即可。");
    expect(mdToSpeechText("见 [任务页](/tasks) 的清单。")).toBe("见 任务页 的清单。");
    expect(mdToSpeechText("~~旧路径~~ 已废弃")).toBe("旧路径 已废弃");
  });

  it("标题井号与引用符与列表标记剥除（读出来不带符号）", () => {
    expect(mdToSpeechText("## 当前状态\n> 一切正常\n- 任务 A 在跑\n1. 任务 B 排队")).toBe(
      "当前状态 一切正常 任务 A 在跑 任务 B 排队",
    );
  });

  it("纯代码块回复 → 空串（调用方据此跳过合成零花费）", () => {
    expect(mdToSpeechText("```bash\nls -la\n```")).toBe("");
  });

  it("超长截断至 daemon 500 字符上限（text.length 口径对齐）", () => {
    const long = "跑".repeat(STEWARD_SPEECH_TEXT_MAX + 120);
    const out = mdToSpeechText(long);
    expect(out.length).toBe(STEWARD_SPEECH_TEXT_MAX);
  });
});

describe("planTranscript（转写出路）", () => {
  it("ask 发出 → asked（语音链继续：等流式回答）", () => {
    expect(planTranscript("现在有什么在跑？", true)).toEqual({ kind: "asked" });
  });

  it("发送失败（未连接）→ fallback：转写文本回填草稿（文本态可重试，零静默丢话）", () => {
    expect(planTranscript("现在有什么在跑？", false)).toEqual({ kind: "fallback", draft: "现在有什么在跑？" });
  });
});
