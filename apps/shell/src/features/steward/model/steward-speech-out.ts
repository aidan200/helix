/**
 * steward-speech-out —— 管家朗读流式编排（V3b-2 接线件三；哑帧修复批）。
 *
 * 职责（纯编排层，零 React；消费端 = useStewardVoice）：
 * - 回答增量（steward.ask.delta 原文）聚合 → mdToSpeechText 可朗读化 →
 *   尾部 withhold（增量 markdown 变换的前缀稳定性防御：仅最后一个句读
 *   边界前的文本喂切句）→ SentenceBuffer 切句 → 逐句 voice.synthesize.stream
 *   （utterId 连接内单调）；
 * - chunk 帧 → **播放闸** → SpeechPlayer 播放队列（乱序修复批）：多句并发
 *   合成是常态（上一句播放中下一句已在合成），chunk 到达序 ≠ 发句序——
 *   闸按发句序过闸释放（头句直通；后句缓冲至前句收口 flush），播放序恒
 *   = 文本序；句内 seq 单调防御（迟到/重复帧丢弃——WS FIFO 下物理有序，
 *   防御层）；句间串行无缝 = player timeline 追加调度（nextStart 连续推进，
 *   一块播完才是下一块）；done/error 帧句级收口（error 推进闸——后继句照常放行）；
 * - 回退链（V3b-2 原语义）：流式失败（error 帧且本轮零出声 / 首帧超时 /
 *   发送失败 / 播放面不可用）→ 链死降级，未读句累积 → answer 终态一次性
 *   voice.synthesize 整段回退（≤500 截断）；再失败只丢句不断对话；
 *   中途失败（已出声）只丢句不降级；
 * - 静音钮 stopSpeaking：voice.synthesize.stop（全部在途句）+ 播放队列清空
 *   + 分句缓冲 reset + 本轮静音（终态不再回退出声）；
 * - 无 delta 的 answer（纯一次性路径）= V3a 现行为等价。
 *
 * money 纪律：闸（语音模式 × 偏好开 × answer）在消费端（useStewardVoice）
 * 判——本层只在「被喂」后工作；answerResult 非 answer 终态零回退。
 */
import { createWebAudioSpeechPlayer, type SpeechPlayer, type SpeechPlayerFactory } from "@/shared/lib/pcm-player";
import { SentenceBuffer, SENTENCE_BOUNDARY_CHARS } from "./sentence-splitter";
import { mdToSpeechText, STEWARD_SPEECH_TEXT_MAX } from "./steward-voice-machine";

/** 单句首帧（chunk）等待上限：超时 = 流式失败（定向 stop + 降级回退）。 */
export const SPEECH_FIRST_CHUNK_TIMEOUT_MS = 6_000;

/** 无边界残余强制切空闲窗（1.5s——V3b-2 任务书面；定时器归本编排层）。 */
export const SPEECH_CUT_IDLE_MS = 1_500;

/** 流式单句防御上限（daemon handlers/voice.ts SYNTHESIZE_STREAM_TEXT_MAX 对齐）。 */
export const SPEECH_SENTENCE_MAX = 600;

/** 聚合 mdToSpeechText 截断上限（放宽——500 是一次性合成面；流式按句发）。 */
const SPEECH_AGGREGATE_MAX = 10_000;

/** 命令发送面（hook 注入 command-surface 四方法）。 */
export interface SpeechOutSenders {
  sendStream(utterId: string, text: string, opts?: { voice?: string }): boolean;
  sendStopFor(utterId: string): boolean;
  sendStopAll(): boolean;
  sendFallback(text: string, opts?: { voice?: string }): boolean;
}

export interface StewardSpeechOutOptions {
  readonly senders: SpeechOutSenders;
  /** 播放器工厂（缺省 Web Audio；测试注入 fake）。 */
  readonly createPlayer?: SpeechPlayerFactory;
  /** 音色偏好读面（每次 issue 现读——设置页改动即时跟随）。 */
  readonly voiceProvider?: () => string | undefined;
  /** 首帧超时 ms（缺省 SPEECH_FIRST_CHUNK_TIMEOUT_MS；测试注短窗）。 */
  readonly firstChunkTimeoutMs?: number;
  /** 强制切空闲窗 ms（缺省 SPEECH_CUT_IDLE_MS；测试注短窗）。 */
  readonly cutIdleMs?: number;
}

/** answerResult 裁决：stream = 流式在途/已播（无一次性）；fallback = 已发
 * 一次性回退（消费端等回执播放）；none = 零朗读（终态非 answer/静音/发送失败）。 */
export type SpeechOutVerdict = "stream" | "fallback" | "none";

/** 在途句登记。 */
interface PendingUtter {
  readonly text: string;
  gotChunk: boolean;
  timer: ReturnType<typeof setTimeout> | null;
  /** 播放闸：done/error 已收口（闸推进判据——后继句放行条件）。 */
  done: boolean;
  /** 播放闸：已过闸（此后续 chunk 直通 player；未过闸 = 缓冲）。 */
  released: boolean;
  /** 句内已接受最大 seq（单调防御；undefined = 无 seq 信息不防御）。 */
  lastSeq: number | undefined;
  /** 未过闸 chunk 缓冲（到达序 FIFO——WS 同连接保证句内有序）。 */
  buffered: string[];
}

/** 最后一个句读边界后的稳定喂入点（尾部 withhold——边界前文本不会再变）。 */
function stableFeedPoint(text: string): number {
  const boundaries = new Set<string>(SENTENCE_BOUNDARY_CHARS);
  for (let i = text.length - 1; i >= 0; i--) {
    if (boundaries.has(text[i] ?? "")) return i + 1;
  }
  return 0;
}

export class StewardSpeechOut {
  private readonly senders: SpeechOutSenders;
  private readonly player: SpeechPlayer;
  private readonly voiceProvider: () => string | undefined;
  private readonly firstChunkTimeoutMs: number;
  private readonly cutIdleMs: number;
  private readonly buffer = new SentenceBuffer();
  /** 回答聚合态（answerActive 期间有效）。 */
  private rawMd = "";
  private fedLen = 0;
  private answerActive = false;
  private streamUsed = false;
  private streamDead = false;
  private anyAudio = false;
  private muted = false;
  private fallbackText = "";
  private cutTimer: ReturnType<typeof setTimeout> | null = null;
  /** utterId 单调计数（连接内唯一——跨轮不复位置零，防撞）。 */
  private utterSeq = 0;
  private readonly pending = new Map<string, PendingUtter>();
  private speakingListeners = new Set<(speaking: boolean) => void>();
  private disposed = false;

  constructor(options: StewardSpeechOutOptions) {
    this.senders = options.senders;
    this.player = (options.createPlayer ?? createWebAudioSpeechPlayer)();
    this.voiceProvider = options.voiceProvider ?? (() => undefined);
    this.firstChunkTimeoutMs = options.firstChunkTimeoutMs ?? SPEECH_FIRST_CHUNK_TIMEOUT_MS;
    this.cutIdleMs = options.cutIdleMs ?? SPEECH_CUT_IDLE_MS;
    this.player.onActiveChange((active) => {
      for (const cb of this.speakingListeners) cb(active);
    });
  }

  /** 播放态边沿透传（消费端合并 legacy Audio 面后驱动 phase）。 */
  onSpeakingChange(cb: (speaking: boolean) => void): () => void {
    this.speakingListeners.add(cb);
    return () => {
      this.speakingListeners.delete(cb);
    };
  }

  /** 回答增量喂入（原文 md；仅 answerActive 轮内消费——轮次由消费端经
   * resetAnswer 在 ask 时开启，answerResult 收口后迟到 delta 丢弃）。 */
  feedRawDelta(rawDelta: string): void {
    if (this.disposed || rawDelta === "" || !this.answerActive || this.muted) return;
    this.rawMd += rawDelta;
    // 尾部 withhold：仅稳定区（最后句读边界前）喂切句——边界后残余可能随
    // 后续 delta 变换（未闭合 **/`` 等），提前喂会锁进错误形态
    const speakable = mdToSpeechText(this.rawMd, SPEECH_AGGREGATE_MAX);
    const stable = speakable.slice(0, stableFeedPoint(speakable));
    if (stable.length <= this.fedLen) {
      this.armCutTimer();
      return;
    }
    const feed = stable.slice(this.fedLen);
    this.fedLen = stable.length;
    for (const sentence of this.buffer.push(feed)) this.issue(sentence);
    this.armCutTimer();
  }

  /** chunk 帧消费：seq 单调防御 → 闸（未过闸缓冲/过闸直通）→ 音频入队；
   * 播放面死 → 整链降级回退。 */
  onChunkFrame(utterId: string, base64Pcm: string, seq?: number): void {
    if (this.disposed) return;
    const pending = this.pending.get(utterId);
    if (pending === undefined) return; // 迟到/他面/已收口帧
    if (pending.timer !== null) {
      clearTimeout(pending.timer);
      pending.timer = null;
    }
    pending.gotChunk = true;
    // 句内 seq 单调防御：迟到/重复帧丢弃（迟到帧无法插入已调度的 timeline）
    if (seq !== undefined) {
      if (pending.lastSeq !== undefined && seq <= pending.lastSeq) return;
      pending.lastSeq = seq;
    }
    if (!pending.released) {
      pending.buffered.push(base64Pcm); // 前句未收口——闸住（乱序到达不插队）
      return;
    }
    this.enqueueOrDegrade(utterId, pending, base64Pcm);
  }

  /** done 帧消费：句收口标记 + 闸推进（音频已全量下发；后继句过闸 flush）。 */
  onDoneFrame(utterId: string): void {
    const pending = this.pending.get(utterId);
    if (pending === undefined) return;
    if (pending.timer !== null) clearTimeout(pending.timer);
    pending.done = true;
    if (pending.released) this.pending.delete(utterId); // 音频已全量入队
    this.pumpGate();
  }

  /** error 帧消费：未出声句转回退；已出声句只丢（半句重读会重复）；闸推进。 */
  onErrorFrame(utterId: string): void {
    const pending = this.pending.get(utterId);
    if (pending === undefined) return;
    if (pending.timer !== null) clearTimeout(pending.timer);
    this.pending.delete(utterId);
    this.player.drop(utterId);
    if (pending.gotChunk) {
      this.pumpGate(); // 中途断：丢句不降级（V3b-2 语义）——后继句照常放行
      return;
    }
    this.fallbackText += pending.text; // 先入缓冲（时序正确——降级废的在途句后到后拼）
    if (!this.anyAudio) this.degrade();
    else this.pumpGate();
  }

  /** answer 终态裁决（status = steward.ask.result 判别；text = 全文权威）。 */
  answerResult(status: string, text: string): SpeechOutVerdict {
    if (this.disposed) return "none";
    const wasActive = this.answerActive;
    this.answerActive = false;
    this.clearCutTimer();
    if (status !== "answer") {
      // error/confirm_required：零朗读零回退（money 纪律；递话不合成）
      this.buffer.reset();
      return "none";
    }
    // 终态权威收口（仅流式已启用轮）：answer.text 全量变换后，未喂残余
    //（尾部 withhold + 无边界残余）一次性冲刷入流；零 delta 轮走下方纯一次性
    // 回退路径（现行为等价）
    if (this.streamUsed) {
      const speakable = mdToSpeechText(text, SPEECH_AGGREGATE_MAX);
      const leftover = speakable.slice(Math.min(this.fedLen, speakable.length));
      for (const sentence of this.buffer.push(leftover)) this.issue(sentence);
      const tail = this.buffer.flush();
      if (tail !== null) this.issue(tail);
    }
    // 静音轮：余句全丢，零回退零出声
    if (this.muted) {
      this.fallbackText = "";
      return "none";
    }
    // 纯一次性路径（无 delta 喂入——V3a 现行为等价）
    if (!wasActive || !this.streamUsed) {
      const speech = mdToSpeechText(text);
      if (speech === "") return "none";
      return this.senders.sendFallback(speech, { voice: this.voiceProvider() }) ? "fallback" : "none";
    }
    // 流式路径：链死且未读残余 → 一次性整段回退（≤500 截断对齐现行为）
    if (this.streamDead && this.fallbackText.trim() !== "") {
      const fallback = this.fallbackText.slice(0, STEWARD_SPEECH_TEXT_MAX);
      this.fallbackText = "";
      return this.senders.sendFallback(fallback, { voice: this.voiceProvider() }) ? "fallback" : "none";
    }
    return "stream";
  }

  /** 静音钮：全停在途（stop 命令 + 队列 + 缓冲）+ 本轮静音标记。无在途句
   *（pending 空）时零命令发出——预停读（startListening 先停上轮）不空发帧。 */
  stopSpeaking(): void {
    if (this.pending.size > 0) this.senders.sendStopAll();
    for (const pending of this.pending.values()) {
      if (pending.timer !== null) clearTimeout(pending.timer);
    }
    this.pending.clear();
    this.player.stop();
    this.buffer.reset();
    this.clearCutTimer();
    this.fallbackText = "";
    this.muted = true;
    this.streamDead = true; // 本轮余句全丢（静音后不再流式）
  }

  /** 新一轮回答开启（消费端在 ask 发出时调用；answerResult 后迟到 delta
   * 零消费——不重开轮次防句泄漏）。 */
  resetAnswer(): void {
    this.beginAnswer();
  }

  /** B2 主动发言（欢迎语/口令回读）：整段文本直接切句发流（闸/播放队列/
   * 回退链全复用——TR-200 播放闸零改动）；money 闸归调用方判（偏好关零
   * 调用）。与 answer 轮互斥收口：在途轮关闭（迟到 delta 零消费）+ 静音
   * 位复位（主动发言不受上轮 stopSpeaking 静音影响）。 */
  sayNow(text: string): void {
    if (this.disposed) return;
    this.answerActive = false;
    this.muted = false;
    this.streamDead = false; // 上轮 stopSpeaking 链死位复位（主动发言独立开流）
    this.fallbackText = "";
    this.clearCutTimer();
    const speech = mdToSpeechText(text, SPEECH_AGGREGATE_MAX);
    if (speech === "") return;
    for (const sentence of this.buffer.push(speech)) this.issue(sentence);
    const tail = this.buffer.flush();
    if (tail !== null) this.issue(tail);
  }

  /** 释放（面板卸载）。 */
  close(): void {
    this.disposed = true;
    this.stopSpeaking();
    this.answerActive = false;
    this.player.close();
  }

  /** 复活（StrictMode 双效应兼容：mount→cleanup→remount 的 cleanup 先跑
   * close() 毒死 useRef 持有的同一实例——remount 后 setup 必须显式重开，
   * 否则 disposed 永真 → 全链静默（2026-09-21 生产事故根因）。真实卸载
   * 不经本方法，close 语义不变。） */
  reopen(): void {
    if (!this.disposed) return;
    this.disposed = false;
    this.player.reopen();
  }

  /** 本轮流式链死判别（消费端提示面可选读）。 */
  get degraded(): boolean {
    return this.streamDead && this.streamUsed;
  }

  // ── 内部 ────────────────────────────────────────────────

  private beginAnswer(): void {
    this.rawMd = "";
    this.fedLen = 0;
    this.buffer.reset();
    this.answerActive = true;
    this.streamUsed = false;
    this.streamDead = false;
    this.anyAudio = false;
    this.muted = false;
    this.fallbackText = "";
  }

  /** 切句出货：链死入回退缓冲；否则发流式（超长硬切 ≤600 防御）。 */
  private issue(sentence: string): void {
    if (this.muted) return; // 静音轮零发声零累积
    for (const piece of hardSplit(sentence)) {
      if (this.streamDead) {
        this.fallbackText += piece;
        continue;
      }
      this.streamUsed = true;
      const utterId = `utt-${(this.utterSeq += 1)}`;
      const sent = this.senders.sendStream(utterId, piece, { voice: this.voiceProvider() });
      if (!sent) {
        // 发送失败（未连接等）：链死降级，本句入回退
        this.streamDead = true;
        this.fallbackText += piece;
        continue;
      }
      this.pending.set(utterId, {
        text: piece,
        gotChunk: false,
        timer: setTimeout(() => this.onFirstChunkTimeout(utterId), this.firstChunkTimeoutMs),
        done: false,
        released: false,
        lastSeq: undefined,
        buffered: [],
      });
      this.pumpGate(); // 头句立即过闸（流水线：首 chunk 到达即直通）
    }
  }

  private onFirstChunkTimeout(utterId: string): void {
    const pending = this.pending.get(utterId);
    if (pending === undefined) return;
    this.pending.delete(utterId);
    // money 纪律：超时句定向 stop（daemon 侧任务取消），不弃在途任务
    this.senders.sendStopFor(utterId);
    if (!this.anyAudio) this.degrade();
    else this.pumpGate(); // 已出声链：不降级——闸推进，后继句放行
    this.fallbackText += pending.text;
  }

  /** 入队单点：player 拒收（播放面不可用）→ 整链降级回退（回退链第三入口）。 */
  private enqueueOrDegrade(utterId: string, pending: PendingUtter, audio: string): void {
    const ok = this.player.enqueue(utterId, audio);
    if (!ok) {
      // 播放面不可用（AudioContext 构造失败等）：流式音频无处可播——整链
      // 降级，未读句转一次性
      this.pending.delete(utterId);
      this.player.drop(utterId);
      this.degrade();
      this.fallbackText += pending.text;
      return;
    }
    this.anyAudio = true;
  }

  /** 播放闸推进：按发句序（Map 插入序 = issue 序）扫描——未过闸句过闸
   *（缓冲按序 flush）；已收口句清位推进；未收口句拦住后继（等待其 done/
   * error/超时收口后再推进）。降级/停读时 pending 清空即闸复位。 */
  private pumpGate(): void {
    for (const [utterId, p] of [...this.pending.entries()]) {
      if (!p.released) {
        p.released = true;
        const buffered = p.buffered;
        p.buffered = [];
        for (const audio of buffered) {
          this.enqueueOrDegrade(utterId, p, audio);
          if (this.streamDead) return; // 降级已清场——快照迭代即刻终止
        }
      }
      if (!p.done) break; // 未收口：后继句必须等它（乱序修复的核心闸）
      this.pending.delete(utterId); // 已收口且音频全量入队
    }
  }

  /** 链死降级：未出声在途句全废（各自定向 stop——money 零孤儿）。 */
  private degrade(): void {
    this.streamDead = true;
    for (const [utterId, pending] of [...this.pending.entries()]) {
      if (pending.timer !== null) clearTimeout(pending.timer);
      this.pending.delete(utterId);
      this.senders.sendStopFor(utterId);
      if (!pending.gotChunk) this.fallbackText += pending.text;
    }
  }

  /** 无边界残余强制切（空闲窗到点 cut——长句不无限滞留）。 */
  private armCutTimer(): void {
    this.clearCutTimer();
    if (this.buffer.pending === "") return;
    this.cutTimer = setTimeout(() => {
      this.cutTimer = null;
      const cut = this.buffer.cut();
      if (cut !== null) this.issue(cut);
    }, this.cutIdleMs);
  }

  private clearCutTimer(): void {
    if (this.cutTimer !== null) {
      clearTimeout(this.cutTimer);
      this.cutTimer = null;
    }
  }
}

/** 超长句硬切（≤SPEECH_SENTENCE_MAX 段；尾段收剩余）。 */
function* hardSplit(sentence: string): Generator<string> {
  if (sentence.length <= SPEECH_SENTENCE_MAX) {
    yield sentence;
    return;
  }
  for (let i = 0; i < sentence.length; i += SPEECH_SENTENCE_MAX) {
    yield sentence.slice(i, i + SPEECH_SENTENCE_MAX);
  }
}
