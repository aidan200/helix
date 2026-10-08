/**
 * DashScope 流式 TTS adapter（driven；V3b-2 流式 TTS 批主选 provider）。
 *
 * 模型 qwen-audio-3.0-tts-flash + 音色 longanlingxi + format=pcm +
 * sample_rate 24000（真实 key 冒烟钉死 docs/temp/tts-streaming/DECISION.md
 * ——2026-09-21 全链验证；端点走通用域名 dashscope.aliyuncs.com 免
 * workspace 子域）：
 * - 任务型 WS 协议（run-task/continue-task/finish-task）：run-task（task_
 *   group audio / task tts / function SpeechSynthesizer / streaming duplex）
 *   → task-started → continue-task 整句（上游自动分句：完整句立即出音）
 *   + finish-task 背靠背（冒烟实证：finish 不可省否则尾句不完整）→
 *   binary 帧增量音频（实测 19200B/帧 = 400ms@24k16bit——FAQ「8000B」
 *   口径与本采样率不符，以实测为准）→ task-finished；
 * - 连接池复用：task-finished 后连接回池（官方建议复用连接处理多任务；
 *   冒烟实证 3 任务一连接，run-task→task-started 稳定 ~90-100ms）；空闲
 *   TTS_STREAM_IDLE_MS 关闭（上游 23s 无文本约束 + money 纪律零孤儿连接）；
 * - 失败/中止的连接废弃不回池（cancel 走 finish-task directive=cancel，
 *   京区全模型支持）；
 * - 兜底：started 超时（10s）/终态超时（finish 后 20s）→ onError。
 *
 * key：组合根 getter（auth.json provider id "dashscope"，与一次性合成/
 * STT 共用条目——对齐 model-provider.ts AuthStore getter 先例）；缺 key
 * fail-fast 抛中文错误（指向设置页录入路径）。WS 工厂与定时器面注入
 * （测试 fake——零真实网络）。
 */
import type { TtsStreamCallbacks, TtsStreamOpenOptions, TtsStreamPort, TtsStreamSession } from "../../../application/ports/outbound/TtsStreamPort";
import { DEFAULT_VOICE_MODEL_CONFIG } from "../../../application/voice/voiceModelConfig";

/**
 * 最小 WS 客户端面（Bun global WebSocket 同构；测试 fake 注入）。
 * 二进制帧经 ev.data（ArrayBuffer/Buffer）到达。
 */
export interface TtsSocket {
  /** 已关闭标记（池内连接健康检查；真体 WebSocket 无此字段——undefined 视为可用）。 */
  readonly closed?: boolean;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: "open" | "message" | "close" | "error", listener: (ev: { data?: unknown }) => void): void;
  removeEventListener(type: "open" | "message" | "close" | "error", listener: (ev: { data?: unknown }) => void): void;
}

/** V3b-2 主选流式 TTS 模型（Qwen-Audio-TTS 实时族；1 元/万字符）。
 *  别名 = voiceModelConfig 默认值单源字段（模型配置接入 P0；getModel 可覆盖）。 */
export const DASHSCOPE_TTS_STREAM_MODEL = DEFAULT_VOICE_MODEL_CONFIG.ttsStreamModel;

/** 默认音色（longanlingxi 龙安灵犀——官方示例配对，冒烟验证）。 */
export const DASHSCOPE_TTS_STREAM_VOICE = "longanlingxi";

/** 任务型 WS 端点（通用域名——冒烟实证可用，免 workspace 子域）。 */
const TTS_STREAM_WS_URL = "wss://dashscope.aliyuncs.com/api-ws/v1/inference";

/** 回池连接空闲回收上限（上游 continue-task 间隔 ≤23s 口径内主动收口）。 */
export const TTS_STREAM_IDLE_MS = 20_000;

/** run-task 后等待 task-started 上限。 */
export const TTS_STREAM_START_TIMEOUT_MS = 10_000;

/** finish-task 后等待 task-finished 上限（尾帧超时兜底）。 */
export const TTS_STREAM_FINISH_TIMEOUT_MS = 20_000;

export interface DashScopeStreamingTtsDeps {
  /** 当前 provider key getter（组合根注入 authStore.apiKeyOf；每次调用重读）。 */
  readonly getApiKey: () => string | undefined;
  /** 模型 id getter（可选——模型配置接入 P0；每次 openUtterance 读现值；空/undefined 回落默认）。 */
  readonly getModel?: () => string | undefined;
  /** WS 工厂（缺省 Bun global WebSocket——headers 透传 Bearer；测试注入 fake）。 */
  readonly wsFactory?: (url: string, headers: Record<string, string>) => TtsSocket;
  /** 定时器面（缺省 setTimeout；测试注入手工时钟）。 */
  readonly setTimer?: (cb: () => void, ms: number) => number;
  readonly clearTimer?: (id: number) => void;
}

type Phase = "connecting" | "started" | "closed";

/** 池内空闲连接条目（close 监听持引用——acquire 时摘除防累积）。 */
interface Pooled {
  readonly socket: TtsSocket;
  idleTimer: number | undefined;
  readonly onClose: () => void;
}

export class DashScopeStreamingTtsAdapter implements TtsStreamPort {
  readonly providerId = "dashscope";
  private readonly getApiKey: () => string | undefined;
  private readonly getModel: (() => string | undefined) | undefined;
  private readonly wsFactory: (url: string, headers: Record<string, string>) => TtsSocket;
  private readonly setTimer: (cb: () => void, ms: number) => number;
  private readonly clearTimer: (id: number) => void;
  /** 空闲连接池（句间复用；空闲超时/意外断连即摘除）。 */
  private readonly idle: Pooled[] = [];

  constructor(deps: DashScopeStreamingTtsDeps) {
    this.getApiKey = deps.getApiKey;
    this.getModel = deps.getModel;
    this.wsFactory = deps.wsFactory ?? defaultWsFactory;
    this.setTimer = deps.setTimer ?? ((cb, ms) => setTimeout(cb, ms) as unknown as number);
    this.clearTimer = deps.clearTimer ?? ((id) => clearTimeout(id as unknown as Parameters<typeof clearTimeout>[0]));
  }

  /** 生效模型 id（配置值优先；空/未配回落默认常量；service 回执 model 随之反映配置）。 */
  get model(): string {
    return this.getModel?.()?.trim() || DASHSCOPE_TTS_STREAM_MODEL;
  }

  openUtterance(options: TtsStreamOpenOptions): TtsStreamSession {
    const apiKey = this.getApiKey();
    if (apiKey === undefined || apiKey === "") {
      throw new Error(
        `auth.json 中没有 provider "dashscope" 的 API key（请经设置页语音区 auth.set_key 录入；显式传入，不走环境变量）`,
      );
    }
    const socket = this.acquire(apiKey);
    return new Utterance(options, socket, this.model, this.setTimer, this.clearTimer, () => this.release(socket));
  }

  /** 取一条可用连接：池内优先（清空闲计时 + 摘池内监听），否则新建。 */
  private acquire(apiKey: string): TtsSocket {
    while (this.idle.length > 0) {
      const pooled = this.idle.pop()!;
      if (pooled.idleTimer !== undefined) {
        this.clearTimer(pooled.idleTimer);
        pooled.idleTimer = undefined;
      }
      try {
        pooled.socket.removeEventListener("close", pooled.onClose);
      } catch {
        // 环境差异——幂等
      }
      if (!pooled.socket.closed) return pooled.socket;
    }
    return this.wsFactory(TTS_STREAM_WS_URL, { Authorization: `Bearer ${apiKey}` });
  }

  /** task-finished 后回池（挂空闲回收 + 池内断连静默摘除）。 */
  private release(socket: TtsSocket): void {
    let pooled!: Pooled;
    pooled = {
      socket,
      idleTimer: undefined,
      onClose: () => {
        if (pooled.idleTimer !== undefined) this.clearTimer(pooled.idleTimer);
        const i = this.idle.indexOf(pooled);
        if (i >= 0) this.idle.splice(i, 1);
      },
    };
    pooled.idleTimer = this.setTimer(() => {
      try {
        socket.close();
      } catch {
        // 已关闭——幂等
      }
      pooled.onClose();
    }, TTS_STREAM_IDLE_MS);
    socket.addEventListener("close", pooled.onClose);
    this.idle.push(pooled);
  }
}

/** 缺省 WS 工厂：Bun global WebSocket（headers 扩展为 Bun 支持）。 */
function defaultWsFactory(url: string, headers: Record<string, string>): TtsSocket {
  const ws = new WebSocket(url, { headers }) as unknown as TtsSocket;
  try {
    (ws as unknown as { binaryType?: string }).binaryType = "arraybuffer";
  } catch {
    // 环境不支持——按缺省（Buffer/ArrayBuffer 均可兜）
  }
  return ws;
}

/** 池内复用形态：open 已完成的连接（新建 WebSocket readyState=0 待 open 事件）。 */
function isOpenNow(socket: TtsSocket): boolean {
  const rs = (socket as unknown as { readyState?: number }).readyState;
  return rs === undefined || rs === 1;
}

/** 单句会话（一句一任务；task_id 每句新签）。 */
class Utterance implements TtsStreamSession {
  private phase: Phase = "connecting";
  private readonly taskId = crypto.randomUUID().replaceAll("-", "");
  private startedTimer: number | undefined;
  private finishTimer: number | undefined;
  private readonly onMessage: (ev: { data?: unknown }) => void;
  private readonly onClose: () => void;

  constructor(
    private readonly options: TtsStreamOpenOptions,
    private readonly socket: TtsSocket,
    /** open 时点定格的模型 id（配置热改不影响在途句）。 */
    private readonly model: string,
    private readonly setTimer: (cb: () => void, ms: number) => number,
    private readonly clearTimer: (id: number) => void,
    private readonly release: (socket: TtsSocket) => void,
  ) {
    const cb = options.callbacks;
    this.onMessage = (ev) => this.handleMessage(ev.data, cb);
    this.onClose = () => this.dieWith(cb, "上游连接断开");
    socket.addEventListener("message", this.onMessage);
    socket.addEventListener("close", this.onClose);
    socket.addEventListener("open", () => this.sendRunTask());
    if (isOpenNow(socket)) this.sendRunTask();
    this.startedTimer = this.setTimer(() => {
      if (this.phase === "closed") return;
      this.dieWith(cb, "任务开启超时（task-started 未达）");
    }, TTS_STREAM_START_TIMEOUT_MS);
  }

  abort(): void {
    if (this.phase === "closed") return;
    // cancel 语义：finish-task directive=cancel（服务端立即回 task-finished
    // 且不再出音）——本地直接终态（stop 语义收口在 service 层），连接废弃不回池
    const wasStarted = this.phase === "started";
    this.die();
    try {
      if (wasStarted) {
        this.socket.send(
          JSON.stringify({
            header: { action: "finish-task", task_id: this.taskId, streaming: "duplex" },
            payload: { input: { directive: "cancel" } },
          }),
        );
      }
      this.socket.close();
    } catch {
      // 已关闭等——幂等静默
    }
  }

  // ── 内部 ────────────────────────────────────────────────

  private sendRunTask(): void {
    if (this.phase === "closed") return;
    this.sendJson({
      header: { action: "run-task", task_id: this.taskId, streaming: "duplex" },
      payload: {
        task_group: "audio",
        task: "tts",
        function: "SpeechSynthesizer",
        model: this.model,
        input: {},
        parameters: {
          voice: this.options.voice ?? DASHSCOPE_TTS_STREAM_VOICE,
          volume: 50,
          text_type: "PlainText",
          sample_rate: 24000,
          rate: 1,
          format: "pcm",
          pitch: 1,
          seed: 0,
          type: 0,
        },
      },
    });
  }

  private handleMessage(data: unknown, cb: TtsStreamCallbacks): void {
    if (this.phase === "closed") return;
    if (typeof data === "string") {
      let msg: { header?: { event?: string; error_code?: string; error_message?: string } };
      try {
        msg = JSON.parse(data);
      } catch {
        return; // 非 JSON 帧防御
      }
      switch (msg.header?.event) {
        case "task-started": {
          if (this.phase !== "connecting") return;
          this.clearStartTimer();
          this.phase = "started";
          // 整句单次上行 + finish 背靠背（冒烟钉死形态；上游完整句立即出音）
          this.sendJson({
            header: { action: "continue-task", task_id: this.taskId, streaming: "duplex" },
            payload: { input: { text: this.options.text } },
          });
          this.sendJson({
            header: { action: "finish-task", task_id: this.taskId, streaming: "duplex" },
            payload: { input: {} },
          });
          this.finishTimer = this.setTimer(() => {
            if (this.phase === "closed") return;
            this.dieWith(cb, "终态等待超时（task-finished 未达）");
          }, TTS_STREAM_FINISH_TIMEOUT_MS);
          return;
        }
        case "task-finished":
          this.finishUp(cb);
          return;
        case "task-failed":
          this.dieWith(cb, `上游合成失败（${msg.header.error_code ?? "unknown"}）：${msg.header.error_message ?? "未知错误"}`);
          return;
        default:
          return; // result-generated 等观测事件不消费
      }
    }
    // 二进制帧 → base64 透传
    let bytes: Uint8Array;
    if (data instanceof ArrayBuffer) bytes = new Uint8Array(data);
    else if (ArrayBuffer.isView(data)) bytes = new Uint8Array((data as ArrayBufferView).buffer, (data as ArrayBufferView).byteOffset, (data as ArrayBufferView).byteLength);
    else return;
    cb.onAudio(Buffer.from(bytes).toString("base64"));
  }

  private finishUp(cb: TtsStreamCallbacks): void {
    if (this.phase === "closed") return;
    this.die();
    this.detach();
    this.release(this.socket);
    cb.onDone();
  }

  private dieWith(cb: TtsStreamCallbacks, reason: string): void {
    if (this.phase === "closed") return;
    this.die();
    this.detach();
    try {
      this.socket.close();
    } catch {
      // 幂等
    }
    cb.onError(reason);
  }

  /** 终态收口（清计时器；不发回调）。 */
  private die(): void {
    this.phase = "closed";
    this.clearStartTimer();
    if (this.finishTimer !== undefined) {
      this.clearTimer(this.finishTimer);
      this.finishTimer = undefined;
    }
  }

  private clearStartTimer(): void {
    if (this.startedTimer !== undefined) {
      this.clearTimer(this.startedTimer);
      this.startedTimer = undefined;
    }
  }

  private detach(): void {
    try {
      this.socket.removeEventListener("message", this.onMessage);
      this.socket.removeEventListener("close", this.onClose);
    } catch {
      // 环境差异——幂等
    }
  }

  private sendJson(obj: Record<string, unknown>): void {
    try {
      this.socket.send(JSON.stringify(obj));
    } catch {
      // 连接已死——close 路径接管
    }
  }
}
