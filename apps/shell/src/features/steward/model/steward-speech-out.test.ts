/**
 * StewardSpeechOut 单测 —— V3b-2 管家朗读流式编排（哑帧修复批接线件三）。
 *
 * 断言面（fake senders + fake player + fake timers——零 WS 零音频设备）：
 * - delta 聚合 → md 剥离 → 尾部 withhold → SentenceBuffer 切句 → 逐句
 *   sendStream（utterId 单调；超长句硬切 ≤600 防御）；
 * - chunk → player.enqueue（未知 utterId no-op）；done → 句收口；
 * - 回退链：首句 error（零出声）→ 链死 → answerResult 回退一次性整段；
 *   中途 error（已出声）→ 只丢句不降级；首帧超时 → 定向 stop + 降级；
 *   播放面死 → 降级回退；
 * - 无 delta 的 answer → 一次性路径等价（现行为回归面）；
 * - stopSpeaking → sendStopAll + player.stop + 缓冲 reset + 本轮静音
 * （answerResult 不再回退出声）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StewardSpeechOut, SPEECH_SENTENCE_MAX, type SpeechOutSenders } from "./steward-speech-out";
import type { SpeechPlayer } from "@/shared/lib/pcm-player";

function fakePlayer(): SpeechPlayer & {
  enqueued: [string, string][];
  dropped: string[];
  stopped: number;
  closed: number;
  reopened: number;
  active: boolean;
  emit(active: boolean): void;
} {
  let cb: ((a: boolean) => void) | null = null;
  const p = {
    enqueued: [] as [string, string][],
    dropped: [] as string[],
    stopped: 0,
    closed: 0,
    reopened: 0,
    active: false,
    enqueue(utterId: string, b64: string) {
      p.enqueued.push([utterId, b64]);
      return true;
    },
    setVolume: () => {},
    drop(utterId: string) {
      p.dropped.push(utterId);
    },
    stop() {
      p.stopped += 1;
    },
    close() {
      p.closed += 1;
    },
    reopen() {
      p.reopened += 1;
    },
    onActiveChange(fn: (a: boolean) => void) {
      cb = fn;
      return () => {
        cb = null;
      };
    },
    emit(active: boolean) {
      p.active = active;
      cb?.(active);
    },
  };
  return p as typeof p;
}

function fakeSenders(): SpeechOutSenders & {
  streams: [string, string][];
  stopFor: string[];
  stopAll: number;
  fallbacks: string[];
  streamFails: boolean;
} {
  const s = {
    streams: [] as [string, string][],
    stopFor: [] as string[],
    stopAll: 0,
    fallbacks: [] as string[],
    streamFails: false,
    sendStream(utterId: string, text: string) {
      if (s.streamFails) return false;
      s.streams.push([utterId, text]);
      return true;
    },
    sendStopFor(utterId: string) {
      s.stopFor.push(utterId);
      return true;
    },
    sendStopAll() {
      s.stopAll += 1;
      return true;
    },
    sendFallback(text: string) {
      s.fallbacks.push(text);
      return true;
    },
  };
  return s;
}

describe("StewardSpeechOut（流式朗读编排）", () => {
  let player: ReturnType<typeof fakePlayer>;
  let senders: ReturnType<typeof fakeSenders>;
  let out: StewardSpeechOut;

  beforeEach(() => {
    vi.useFakeTimers();
    player = fakePlayer();
    senders = fakeSenders();
    out = new StewardSpeechOut({ senders, createPlayer: () => player, voiceProvider: () => "longanlingxi" });
    out.resetAnswer(); // ask 发出时开轮（hook 接线同序）
  });
  afterEach(() => {
    out.close();
    vi.useRealTimers();
  });

  it("close→reopen（StrictMode 双效应）：close 毒死后 reopen 复活——delta/result 全链恢复发命令", () => {
    // StrictMode 时序：mount → cleanup（close 毒死）→ remount setup（reopen 复活）
    out.close();
    expect(() => out.feedRawDelta("第一句。")).not.toThrow();
    out.reopen();
    out.resetAnswer(); // 新一轮 ask
    out.feedRawDelta("第一句。第二句。");
    const verdict = out.answerResult("answer", "第一句。第二句。");
    expect(verdict).not.toBe("none"); // 复活后链路活着（stream 或 fallback）
    expect(player.reopened).toBe(1); // 播放器同步复活
  });

  it("delta 切句：md 剥离 + 尾部 withhold + 逐句流式（utterId 单调）", () => {
    out.feedRawDelta("**加粗**第一句。");
    out.feedRawDelta("第二句");
    expect(senders.streams.length).toBe(1); // 尾 withhold：无边界残余不出句
    out.feedRawDelta("到了。");
    expect(senders.streams.map(([, t]) => t)).toEqual(["加粗第一句。", "第二句到了。"]);
    expect(senders.streams[0]![0] < senders.streams[1]![0]).toBe(true); // utterId 单调
  });

  it("chunk → player.enqueue；done → 句收口；未知 utterId 帧 no-op", () => {
    out.feedRawDelta("第一句。");
    const utterId = senders.streams[0]![0];
    out.onChunkFrame(utterId, "QUJD");
    out.onChunkFrame("unknown-utter", "AAAA"); // 他面/迟到帧
    expect(player.enqueued).toEqual([[utterId, "QUJD"]]);
    out.onDoneFrame(utterId);
    out.onDoneFrame("unknown-utter"); // no-op 不抛
    expect(player.enqueued.length).toBe(1);
  });

  it("回退链：首句 error（零出声）→ 链死；后续句入回退缓冲；终态一次性整段回退", () => {
    out.feedRawDelta("第一句。第二句。");
    expect(senders.streams.length).toBe(2);
    const [id1, id2] = [senders.streams[0]![0], senders.streams[1]![0]];
    out.onErrorFrame(id1); // 首句失败（未出过声）→ 降级
    expect(player.dropped).toEqual([id1]);
    // 第二句在途 error 也进回退缓冲
    out.onErrorFrame(id2);
    const verdict = out.answerResult("answer", "第一句。第二句。全文");
    expect(verdict).toBe("fallback");
    expect(senders.fallbacks).toEqual(["第一句。第二句。全文"]); // 含终态冲刷尾句
    // 链死后新 delta 不再发流
    out.feedRawDelta("第三句。");
    expect(senders.streams.length).toBe(2);
  });

  it("中途 error（已出声）→ 只丢句不降级：后续句继续流式", () => {
    out.feedRawDelta("第一句。第二句。");
    const [id1, id2] = [senders.streams[0]![0], senders.streams[1]![0]];
    out.onChunkFrame(id1, "QUJD"); // 已出声
    out.onErrorFrame(id1);
    expect(player.dropped).toEqual([id1]);
    expect(out.answerResult("answer", "第一句。第二句。")).toBe("stream"); // 不回退
    out.feedRawDelta("第三句。"); // answerResult 已收口——迟到 delta 丢弃
    expect(senders.streams.length).toBe(2);
    void id2;
  });

  it("首帧超时 → 定向 stop + 降级；终态回退一次性", () => {
    out.feedRawDelta("第一句。");
    const id1 = senders.streams[0]![0];
    vi.advanceTimersByTime(6_100);
    expect(senders.stopFor).toEqual([id1]);
    expect(out.answerResult("answer", "第一句。")).toBe("fallback");
    expect(senders.fallbacks).toEqual(["第一句。"]);
  });

  it("播放面死（enqueue false）→ 降级回退", () => {
    player.enqueue = () => false; // AudioContext 不可用形态
    out.feedRawDelta("第一句。");
    const id1 = senders.streams[0]![0];
    out.onChunkFrame(id1, "QUJD");
    expect(out.answerResult("answer", "第一句。")).toBe("fallback");
    expect(senders.fallbacks).toEqual(["第一句。"]);
  });

  it("无 delta 的 answer → 一次性路径等价（现行为回归面）", () => {
    const verdict = out.answerResult("answer", "有 **2 个**任务。\n\n```bash\nls\n```\n详见任务页。");
    expect(verdict).toBe("fallback");
    expect(senders.fallbacks).toEqual(["有 2 个任务。 详见任务页。"]);
    expect(senders.streams.length).toBe(0);
  });

  it("confirm_required / error 终态 → 零朗读零回退", () => {
    out.feedRawDelta("第一句。");
    expect(out.answerResult("confirm_required", "递话")).toBe("none");
    expect(out.answerResult("error", "")).toBe("none");
    expect(senders.fallbacks.length).toBe(0);
  });

  it("stopSpeaking：sendStopAll + player.stop + 静音本轮（终态不再回退出声）", () => {
    out.feedRawDelta("第一句。第二句。");
    player.emit(true);
    out.stopSpeaking();
    expect(senders.stopAll).toBe(1);
    expect(player.stopped).toBe(1);
    expect(out.answerResult("answer", "第一句。第二句。")).toBe("none");
    expect(senders.fallbacks.length).toBe(0);
    // 新一轮回答（ask 时 resetAnswer 开轮）非静音残留
    out.resetAnswer();
    out.feedRawDelta("新一轮。");
    expect(senders.streams.length).toBe(3);
  });

  it("超长句（>600）硬切多段（daemon 防御上限对齐）", () => {
    const long = "字".repeat(SPEECH_SENTENCE_MAX + 50) + "。";
    out.feedRawDelta(long);
    expect(senders.streams.length).toBe(2);
    expect(senders.streams[0]![1].length).toBe(SPEECH_SENTENCE_MAX);
    expect(senders.streams[1]![1].length).toBe(51); // 50 字 + 句号
  });

  it("答终态 flush 尾句：无边界残余经 answerResult 冲刷入流", () => {
    out.feedRawDelta("第一句。第二句还没边界");
    expect(senders.streams.length).toBe(1);
    expect(out.answerResult("answer", "第一句。第二句还没边界")).toBe("stream");
    expect(senders.streams.map(([, t]) => t)).toEqual(["第一句。", "第二句还没边界"]);
  });

  it("流式发送失败（未连接）→ 首句即降级回退", () => {
    senders.streamFails = true;
    out.feedRawDelta("第一句。");
    expect(senders.streams.length).toBe(0);
    expect(out.answerResult("answer", "第一句。")).toBe("fallback");
    expect(senders.fallbacks).toEqual(["第一句。"]);
  });

  describe("播放闸（乱序修复：入队序 = 发句序，句内 seq 单调）", () => {
    it("句间乱序到达：后句 chunk 先到不插队——前句收口后按发句序 flush", () => {
      out.feedRawDelta("第一句。第二句。");
      const [id1, id2] = [senders.streams[0]![0], senders.streams[1]![0]];
      // 句 2 合成更快：chunk 先到（闸未开——零入队缓冲）
      out.onChunkFrame(id2, "RDg=", 1);
      expect(player.enqueued).toEqual([]);
      // 句 1 chunk 到达：头句已释放，直通
      out.onChunkFrame(id1, "QUJD", 1);
      expect(player.enqueued).toEqual([[id1, "QUJD"]]);
      // 句 1 收口 → 句 2 过闸，缓冲按序 flush
      out.onDoneFrame(id1);
      expect(player.enqueued).toEqual([
        [id1, "QUJD"],
        [id2, "RDg="],
      ]);
    });

    it("头句直通流水线：未收口期间后续 chunk 不缓冲", () => {
      out.feedRawDelta("第一句。第二句。");
      const [id1, id2] = [senders.streams[0]![0], senders.streams[1]![0]];
      out.onChunkFrame(id1, "QUJD", 1);
      out.onChunkFrame(id2, "RDg=", 1); // 后句缓冲
      out.onChunkFrame(id1, "Q0JD", 2); // 头句第二块直通（不缓冲）
      out.onChunkFrame(id2, "RUVG", 2); // 后句仍缓冲
      expect(player.enqueued).toEqual([
        [id1, "QUJD"],
        [id1, "Q0JD"],
      ]);
      out.onDoneFrame(id1);
      expect(player.enqueued).toEqual([
        [id1, "QUJD"],
        [id1, "Q0JD"],
        [id2, "RDg="],
        [id2, "RUVG"],
      ]);
    });

    it("前句 error（已出声）→ 闸推进：后句缓冲照常 flush", () => {
      out.feedRawDelta("第一句。第二句。");
      const [id1, id2] = [senders.streams[0]![0], senders.streams[1]![0]];
      out.onChunkFrame(id2, "RDg=", 1); // 后句先备好（缓冲）
      out.onChunkFrame(id1, "QUJD", 1); // 头句出声
      out.onErrorFrame(id1); // 中途断——只丢句不降级
      expect(player.dropped).toEqual([id1]);
      expect(player.enqueued).toEqual([[id1, "QUJD"], [id2, "RDg="]]); // 闸推进后 flush
      expect(out.answerResult("answer", "第一句。第二句。")).toBe("stream");
    });

    it("未过闸句 error：缓冲整句丢弃（零入队），drop 照记", () => {
      out.feedRawDelta("第一句。第二句。");
      const [id1, id2] = [senders.streams[0]![0], senders.streams[1]![0]];
      out.onChunkFrame(id2, "RDg=", 1); // 缓冲
      out.onErrorFrame(id2); // 未过闸失败（未出声）→ 回退缓冲 + drop
      expect(player.dropped).toEqual([id2]);
      out.onChunkFrame(id1, "QUJD", 1);
      expect(player.enqueued).toEqual([[id1, "QUJD"]]); // id2 缓冲未泄漏进队列
    });

    it("句内 seq 单调防御：回退/重复 seq 帧丢弃", () => {
      out.feedRawDelta("第一句。");
      const id1 = senders.streams[0]![0];
      out.onChunkFrame(id1, "QUJD", 1);
      out.onChunkFrame(id1, "QUJD", 1); // 重复
      out.onChunkFrame(id1, "QUJD", 0); // 回退
      out.onChunkFrame(id1, "Q0JD", 2); // 正常升序
      expect(player.enqueued).toEqual([[id1, "QUJD"], [id1, "Q0JD"]]);
    });
  });

  describe("新轮清在途 + a×b 互斥（双声重叠修复 ①②）", () => {
    it("T1 重叠回归：旧轮句未收口（无 done）+ 新轮 resetAnswer → 旧句逐条 sendStopFor 定向停 + player.stop 旧尾音 + 新句头句直通零卡闸 + 零降级零回退", () => {
      // 旧轮：句 1 已收口在播尾音，句 2 在途未收口（闸卡后继的病根形态）
      out.feedRawDelta("第一句。第二句。");
      const [id1, id2] = [senders.streams[0]![0], senders.streams[1]![0]];
      out.onChunkFrame(id1, "QUJD", 1);
      out.onDoneFrame(id1);
      out.onChunkFrame(id2, "RDg=", 1); // 句 2 过闸入队（旧轮在播）
      player.emit(true);
      // 新轮开（ask 时 hook 接线同序）
      out.resetAnswer();
      expect(senders.stopFor).toEqual([id2]); // 在途句逐条定向停——money 零孤儿（id1 已 done 收口出 pending，仅 id2 在途）
      expect(player.stopped).toBe(1); // 旧尾音即停（anyAudio 错位缺陷同步根除）
      // 新句不再卡闸：issue → 头句直通，chunk 立即入队（零缓冲）
      out.feedRawDelta("新轮句。");
      const id3 = senders.streams[2]![0];
      out.onChunkFrame(id3, "Q0JD", 1);
      expect(player.enqueued.map(([id]) => id)).toEqual([id1, id2, id3]);
      // 零降级：超时窗内无超时降级（闸未卡——超时触发器消失）
      vi.advanceTimersByTime(6_500);
      expect(senders.stopFor).toEqual([id2]);
      expect(out.answerResult("answer", "新轮句。")).toBe("stream"); // 非回退
      expect(senders.fallbacks).toEqual([]); // 零一次性回退（双声第二源头消失）
    });

    it("空场开轮零空发：无在途无在播时 resetAnswer 不发 stop 命令不空停 player", () => {
      out.resetAnswer();
      expect(senders.stopFor).toEqual([]); // money：无在途零命令
      expect(player.stopped).toBe(0);
    });

    it("b 起播即停 a（stopInFlightPlayback）：在途句定向停 + player 全停；不动轮次语义位（非静音——后续喂句照常发流）", () => {
      out.feedRawDelta("第一句。");
      const id1 = senders.streams[0]![0];
      out.onChunkFrame(id1, "QUJD", 1);
      player.emit(true);
      out.stopInFlightPlayback();
      expect(senders.stopFor).toEqual([id1]);
      expect(player.stopped).toBe(1);
      // 与 stopSpeaking 区分：不置静音位——同轮后续句照常发流
      out.feedRawDelta("第二句。");
      expect(senders.streams.length).toBe(2);
    });
  });
});
