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
  stepBargeInGate,
  openBargeInSilenceWindow,
  isBargeInArmed,
  zcrInVoiceBand,
  zcrVoiceBandCeiling,
  bargeInThreshold,
  INITIAL_BARGE_IN_GATE,
  BARGE_IN_SILENCE_WINDOW_MS,
  BARGE_IN_ECHO_THRESHOLD_SCALE,
  VOICE_ZCR_MIN,
  VOICE_ZCR_MAX_STRICT,
  VOICE_ZCR_MAX_LENIENT,
  STEWARD_SPEECH_TEXT_MAX,
  type BargeInGateState,
  type StewardVoicePhase,
  type StewardVoiceSnapshot,
  matchWakeWord,
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

// ── B2 barge-in 门判定（fake meter 帧驱动——纯函数面，AG-14）────────────

/** 帧驱动辅助：把 rms 帧序列喂给门，返回触发点序列（atMs 单调递增）。 */
function driveFrames(
  start: BargeInGateState,
  frames: readonly { rms: number; atMs: number; armed?: boolean }[],
): { state: BargeInGateState; firedAt: number[] } {
  let state = start;
  const firedAt: number[] = [];
  for (const f of frames) {
    const out = stepBargeInGate(state, { rms: f.rms, atMs: f.atMs, armed: f.armed ?? true });
    state = out.state;
    if (out.trigger) firedAt.push(f.atMs);
  }
  return { state, firedAt };
}

const LOUD = 0.05; // ≥ VOICE_RMS_THRESHOLD 0.012
const QUIET = 0.001;

/** 每 100ms 一帧（rms-meter 节流同构）的帧序列生成。 */
function every100ms(from: number, count: number, rms: number, armed?: boolean): { rms: number; atMs: number; armed?: boolean }[] {
  return Array.from({ length: count }, (_, i) => ({ rms, atMs: from + i * 100, ...(armed !== undefined ? { armed } : {}) }));
}

describe("stepBargeInGate（barge-in 门判定——RMS 帧驱动）", () => {
  it("阈值下不触发：连续低于阈值帧（长时）零触发", () => {
    const { firedAt } = driveFrames(INITIAL_BARGE_IN_GATE, every100ms(0, 20, QUIET));
    expect(firedAt).toEqual([]);
  });

  it("短脉冲不触发：单帧尖峰后回落（持续 < VOICE_MIN_DURATION_MS）零触发——双条件防单帧尖峰", () => {
    const { firedAt } = driveFrames(INITIAL_BARGE_IN_GATE, [
      { rms: LOUD, atMs: 0 },
      { rms: QUIET, atMs: 100 },
      { rms: QUIET, atMs: 200 },
      { rms: LOUD, atMs: 300 }, // 第二个孤立尖峰（与前段不连续——loudSince 已被静音帧清零）
      { rms: QUIET, atMs: 400 },
    ]);
    expect(firedAt).toEqual([]);
  });

  it("达标触发：持续超阈 ≥ VOICE_MIN_DURATION_MS 恰触发一次，触发帧自带静默窗", () => {
    const { state, firedAt } = driveFrames(INITIAL_BARGE_IN_GATE, [
      { rms: LOUD, atMs: 1000 }, // 开口（loudSince 起算，不触发）
      { rms: LOUD, atMs: 1100 }, // 持续 200ms——不触发
      { rms: LOUD, atMs: 1200 }, // 持续 200ms——不触发
      { rms: LOUD, atMs: 1300 }, // 持续 300ms ≥ 300 → 触发
    ]);
    expect(firedAt).toEqual([1300]);
    expect(state.muteUntilMs).toBe(1300 + BARGE_IN_SILENCE_WINDOW_MS);
  });

  it("触发后武装续帧零二次触发（fired 闩锁——重复触发幂等）", () => {
    const { firedAt } = driveFrames(
      INITIAL_BARGE_IN_GATE,
      every100ms(0, 4, LOUD).concat(every100ms(400, 10, LOUD)), // 触发后继续满 loud 帧到 1300ms（含出窗段）
    );
    expect(firedAt).toEqual([300]);
  });

  it("静默窗内不触发：openBargeInSilenceWindow 后窗内持续超阈零触发（停播残响防线）；出窗重新累积", () => {
    const opened = openBargeInSilenceWindow(INITIAL_BARGE_IN_GATE, 0);
    expect(opened.muteUntilMs).toBe(BARGE_IN_SILENCE_WINDOW_MS);
    const { firedAt } = driveFrames(opened, [
      ...every100ms(0, 3, LOUD), // 窗内 0/100/200 全 loud——零触发且累积清零
      { rms: LOUD, atMs: 400 }, // 出窗首帧：重新起算 loudSince
      { rms: LOUD, atMs: 500 },
      { rms: LOUD, atMs: 600 },
      { rms: LOUD, atMs: 700 }, // 出窗后持续 300ms → 触发
    ]);
    expect(firedAt).toEqual([700]);
  });

  it("未武装（idle/listening/text 模式）零触发；解除武装帧复位闩锁（下一轮可再触发）", () => {
    // 武装段：300ms 触发
    const first = driveFrames(INITIAL_BARGE_IN_GATE, every100ms(0, 4, LOUD));
    expect(first.firedAt).toEqual([300]);
    // 解除武装帧（如进 listening）→ 闩锁复位
    const rearmed = stepBargeInGate(first.state, { rms: QUIET, atMs: 500, armed: false });
    expect(rearmed.trigger).toBe(false);
    // 下一轮武装段可再触发
    const second = driveFrames(rearmed.state, every100ms(9000, 4, LOUD));
    expect(second.firedAt).toEqual([9300]);
    // 未武装段满 loud 帧零触发
    const unarmed = driveFrames(INITIAL_BARGE_IN_GATE, every100ms(0, 10, LOUD, false));
    expect(unarmed.firedAt).toEqual([]);
  });
});

describe("isBargeInArmed（门武装判定——相位派生扩展）", () => {
  it("语音模式 ×（speaking | asking）→ 武装（全双工可打断相位）", () => {
    expect(isBargeInArmed({ mode: "voice", phase: "speaking" })).toBe(true);
    expect(isBargeInArmed({ mode: "voice", phase: "asking" })).toBe(true);
  });

  it("其余相位/文本模式/unsupported → 不武装（text 模式与 mic 不可用行为不变）", () => {
    expect(isBargeInArmed({ mode: "voice", phase: "idle" })).toBe(false);
    expect(isBargeInArmed({ mode: "voice", phase: "listening" })).toBe(false);
    expect(isBargeInArmed({ mode: "voice", phase: "transcribing" })).toBe(false);
    expect(isBargeInArmed({ mode: "voice", phase: "unsupported" })).toBe(false);
    expect(isBargeInArmed({ mode: "text", phase: "speaking" })).toBe(false);
  });
});

// ── B3 回声防线：双参判定（RMS + ZCR）+ 门限分档 + 容忍带（TDD 红测）────

/** B3 帧驱动辅助（带 zcr/相位/双参开关的全量输入直喂）。 */
function driveFrames3(
  start: BargeInGateState,
  frames: readonly {
    rms: number;
    zcr?: number;
    atMs: number;
    armed?: boolean;
    phase?: StewardVoicePhase;
    voiceCheck?: boolean;
    zcrTolerance?: number;
  }[],
): { state: BargeInGateState; firedAt: number[] } {
  let state = start;
  const firedAt: number[] = [];
  for (const f of frames) {
    const out = stepBargeInGate(state, {
      rms: f.rms,
      atMs: f.atMs,
      armed: f.armed ?? true,
      ...(f.zcr !== undefined ? { zcr: f.zcr } : {}),
      ...(f.phase !== undefined ? { phase: f.phase } : {}),
      ...(f.voiceCheck !== undefined ? { voiceCheck: f.voiceCheck } : {}),
      ...(f.zcrTolerance !== undefined ? { zcrTolerance: f.zcrTolerance } : {}),
    });
    state = out.state;
    if (out.trigger) firedAt.push(f.atMs);
  }
  return { state, firedAt };
}

/** 人声带内低 ZCR（浊音谐波结构）与带外高 ZCR（键盘声宽带脉冲）标定帧。 */
const ZCR_VOICE = 0.08;
const ZCR_KEYBOARD = 0.5;

describe("zcrInVoiceBand（人声带判定——容忍带强度驱动）", () => {
  it("人声带内（低 ZCR）判过；键盘声高 ZCR 判拒", () => {
    expect(zcrInVoiceBand(ZCR_VOICE)).toBe(true);
    expect(zcrInVoiceBand(ZCR_KEYBOARD)).toBe(false);
  });

  it("容忍带边界：恰在上界判过、越界判拒（默认强度 50 = 严格/宽容中档）", () => {
    const ceil = zcrVoiceBandCeiling();
    expect(zcrInVoiceBand(ceil)).toBe(true);
    expect(zcrInVoiceBand(ceil + 0.01)).toBe(false);
    expect(ceil).toBeCloseTo((VOICE_ZCR_MAX_STRICT + VOICE_ZCR_MAX_LENIENT) / 2, 5);
  });

  it("强度 0 = 严格档上界；强度 100 = 宽容档上界（容忍齿音清音偏高 ZCR）", () => {
    expect(zcrVoiceBandCeiling(0)).toBe(VOICE_ZCR_MAX_STRICT);
    expect(zcrInVoiceBand(VOICE_ZCR_MAX_STRICT, 0)).toBe(true);
    expect(zcrInVoiceBand(VOICE_ZCR_MAX_STRICT + 0.01, 0)).toBe(false);
    expect(zcrVoiceBandCeiling(100)).toBe(VOICE_ZCR_MAX_LENIENT);
    expect(zcrInVoiceBand(VOICE_ZCR_MAX_LENIENT, 100)).toBe(true);
    expect(zcrInVoiceBand(VOICE_ZCR_MAX_LENIENT + 0.01, 100)).toBe(false);
    // 越界强度钳制（150 与 100 同档）
    expect(zcrVoiceBandCeiling(150)).toBe(VOICE_ZCR_MAX_LENIENT);
  });

  it("带下界：过低 ZCR（直流/低频隆隆）判拒", () => {
    expect(zcrInVoiceBand(VOICE_ZCR_MIN)).toBe(true);
    expect(zcrInVoiceBand(VOICE_ZCR_MIN - 0.005)).toBe(false);
  });
});

describe("bargeInThreshold（门限分档——B3 回声防护）", () => {
  it("speaking 相位阈值高于 listening（自声回灌窗口抬档防误触）", () => {
    const base = 0.012;
    expect(bargeInThreshold("speaking", base)).toBeCloseTo(base * BARGE_IN_ECHO_THRESHOLD_SCALE, 6);
    expect(bargeInThreshold("speaking", base)).toBeGreaterThan(bargeInThreshold("listening", base));
  });

  it("asking 相位同抬档（TTS 残响/回灌窗口）；listening/他相位/缺省维持基准灵敏度", () => {
    const base = 0.012;
    expect(bargeInThreshold("asking", base)).toBe(bargeInThreshold("speaking", base));
    expect(bargeInThreshold("listening", base)).toBe(base);
    expect(bargeInThreshold("idle", base)).toBe(base);
    expect(bargeInThreshold(undefined, base)).toBe(base);
  });
});

describe("stepBargeInGate 双参判定（RMS × ZCR 人声带）", () => {
  it("人声帧（低 ZCR + RMS 超阈）持续达标 → 触发", () => {
    const frames = [
      { rms: LOUD, zcr: ZCR_VOICE, atMs: 0, phase: "speaking" as const },
      { rms: LOUD, zcr: ZCR_VOICE, atMs: 100, phase: "speaking" as const },
      { rms: LOUD, zcr: ZCR_VOICE, atMs: 200, phase: "speaking" as const },
      { rms: LOUD, zcr: ZCR_VOICE, atMs: 300, phase: "speaking" as const },
    ];
    expect(driveFrames3(INITIAL_BARGE_IN_GATE, frames).firedAt).toEqual([300]);
  });

  it("键盘帧（高 ZCR 超带）持续超阈零触发——双参判定拒宽带脉冲", () => {
    const frames = Array.from({ length: 6 }, (_, i) => ({ rms: LOUD, zcr: ZCR_KEYBOARD, atMs: i * 100 }));
    expect(driveFrames3(INITIAL_BARGE_IN_GATE, frames).firedAt).toEqual([]);
  });

  it("RMS 不足拒（ZCR 合格也不触发）；高 ZCR 帧不计持续（人声段重新起算）", () => {
    const quietFrames = Array.from({ length: 6 }, (_, i) => ({ rms: QUIET, zcr: ZCR_VOICE, atMs: i * 100 }));
    expect(driveFrames3(INITIAL_BARGE_IN_GATE, quietFrames).firedAt).toEqual([]);
    // 2 帧键盘声 + 3 帧人声：持续时长自人声段重新起算（3 帧仅跨 200ms——不触发）
    const mixed = [
      { rms: LOUD, zcr: ZCR_KEYBOARD, atMs: 0 },
      { rms: LOUD, zcr: ZCR_KEYBOARD, atMs: 100 },
      { rms: LOUD, zcr: ZCR_VOICE, atMs: 200 },
      { rms: LOUD, zcr: ZCR_VOICE, atMs: 300 },
      { rms: LOUD, zcr: ZCR_VOICE, atMs: 400 },
    ];
    expect(driveFrames3(INITIAL_BARGE_IN_GATE, mixed).firedAt).toEqual([]);
    // 人声段续帧：自 200ms 起算，500ms 处持续满 300ms → 触发
    const continued = [...mixed, { rms: LOUD, zcr: ZCR_VOICE, atMs: 500 }, { rms: LOUD, zcr: ZCR_VOICE, atMs: 600 }];
    expect(driveFrames3(INITIAL_BARGE_IN_GATE, continued).firedAt).toEqual([500]);
  });

  it("zcr 缺省放行（兼容旧帧载荷——计量缺 ZCR 不挡打断）", () => {
    const frames = Array.from({ length: 4 }, (_, i) => ({ rms: LOUD, atMs: i * 100 }));
    expect(driveFrames3(INITIAL_BARGE_IN_GATE, frames).firedAt).toEqual([300]);
  });

  it("双参判定开关关（voiceCheck=false）→ ZCR 不参与（B2 行为等价）", () => {
    const frames = Array.from({ length: 4 }, (_, i) => ({ rms: LOUD, zcr: ZCR_KEYBOARD, atMs: i * 100, voiceCheck: false }));
    expect(driveFrames3(INITIAL_BARGE_IN_GATE, frames).firedAt).toEqual([300]);
  });

  it("门限分档入档：介于基准与抬档阈值之间的 RMS 在 speaking 相位不触发、listening 相位触发", () => {
    const mid = 0.02; // ≥ 0.012 基准、< 0.012 × 3 抬档
    const band = (phase: StewardVoicePhase) =>
      Array.from({ length: 4 }, (_, i) => ({ rms: mid, zcr: ZCR_VOICE, atMs: i * 100, phase }));
    expect(driveFrames3(INITIAL_BARGE_IN_GATE, band("speaking")).firedAt).toEqual([]);
    expect(driveFrames3(INITIAL_BARGE_IN_GATE, band("asking")).firedAt).toEqual([]);
    expect(driveFrames3(INITIAL_BARGE_IN_GATE, band("listening")).firedAt).toEqual([300]);
  });
});

describe("matchWakeWord（B4 唤醒词本地文本匹配）", () => {
  it("命中：剥离唤醒词前缀（命中前内容不带出——不入对话）", () => {
    expect(matchWakeWord("helix 明天天气怎么样", "helix")).toEqual({ hit: true, rest: " 明天天气怎么样" });
    // 命中前有前言：整段前缀（含唤醒词）剥掉，只留剩余话语
    expect(matchWakeWord("嗯哼 helix 帮我查下", "helix")).toEqual({ hit: true, rest: " 帮我查下" });
  });

  it("大小写不敏感命中", () => {
    expect(matchWakeWord("HeLiX 你好", "helix")).toEqual({ hit: true, rest: " 你好" });
    expect(matchWakeWord("说 HELIX 了吗", "Helix")).toEqual({ hit: true, rest: " 了吗" });
  });

  it("未命中：hit=false（命中前的转写内容不入对话）", () => {
    expect(matchWakeWord("今天天气不错", "helix")).toEqual({ hit: false, rest: "" });
  });

  it("空串直通：唤醒词关 = 零门槛，全文作为剩余话语", () => {
    expect(matchWakeWord("今天有什么任务", "")).toEqual({ hit: true, rest: "今天有什么任务" });
    expect(matchWakeWord("", "")).toEqual({ hit: true, rest: "" });
  });
});

describe("deriveStewardVoicePhase × wake-armed（B4 状态机新增态）", () => {
  it("录音 + 唤醒待命 → wake_armed（命中前）；待命结束 → listening（命中后同链）", () => {
    expect(deriveStewardVoicePhase(snap({ voiceState: "recording", wakeStandby: true }))).toBe("wake_armed");
    expect(deriveStewardVoicePhase(snap({ voiceState: "recording", wakeStandby: false }))).toBe("listening");
  });

  it("unsupported 优先于待命态；wakeStandby 缺省 = 既有派生不变", () => {
    expect(deriveStewardVoicePhase(snap({ voiceState: "unsupported", wakeStandby: true }))).toBe("unsupported");
    expect(deriveStewardVoicePhase(snap({ voiceState: "recording" }))).toBe("listening");
  });
});
