/**
 * steward-store —— 管家对话状态共享单例（面板/语音层/光球层同源批）。
 *
 * 为什么存在：useSteward 原是每实例一份 useState——语音层（useStewardVoice
 * 内）与面板（StewardPanel）各持一份，语音轮的 ask 只置语音层实例的
 * askInFlight，面板实例的 delta 守卫（防脏写）把语音轮流式增量全丢：面板
 * 只见终态结果、用户问句行也不进历史；反向（面板打字轮）光球过程行缺失。
 * 同根缺陷：工具/思考过程帧按「谁在途谁消费」分流，两面各见一半、时有时无。
 *
 * 形态：模块级单例 + useSyncExternalStore 订阅。帧订阅驱动权单份（attach
 * 首挂者安装、末卸者拆除），事件恰好处理一次；refs 0→1 时清位重置（测试
 * 天然隔离——RTL cleanup 卸载后下一用例拿到干净态）。
 *
 * 防自激纪律（TR-169）不变：订阅/配置/回放命令只按离散依赖触发，send
 * 失败 === false 严格判（TR-168）不复位守卫。
 */
import type { EventEnvelope, StewardAskSource, StewardHistoryRecord } from "@helix/protocol";

/** feed 滚动窗口上限（截尾保最新；面板轻量态不落 store）。 */
export const STEWARD_FEED_MAX_LINES = 50;

/** 状态区摘要滚动窗（两行——超出滚出；模型层截窗即滚出语义，jsdom 同口径可断言）。 */
export const STEWARD_THINKING_LINE_WINDOW = 2;

/** 条目滚动窗口上限（防无界；回放源在 daemon KV——超窗可再拉）。 */
const ITEM_WINDOW = 200;

/** 工具参数摘要截断（行内密度面）。 */
const ARGS_SUMMARY_MAX = 80;

/** 摘要行截断（密度面，ARGS_SUMMARY_MAX 同族）。 */
const THINKING_SUMMARY_MAX = 60;

/** 面板条目内容面（产出方构造的数据形态；渲染 key 另由 store 统一补）。 */
export type StewardPanelItemInput =
  | { readonly kind: "user"; readonly text: string }
  | { readonly kind: "assistant"; readonly text: string }
  | { readonly kind: "thinking"; readonly text: string }
  | {
      readonly kind: "tool";
      readonly toolCallId: string;
      readonly name: string;
      readonly argsSummary: string;
      readonly resultSummary: string | null;
      readonly startedAt: number | null;
      readonly endedAt: number | null;
    };

/**
 * 面板条目（渲染用）：内容面 + 稳定渲染键。
 *
 * **禁索引键**（code-review 低危）：items 由 history 同源重建或中途替换时，
 * `key={i}` 会让同索引位置复用同一组件实例——ThinkingRow/ToolRow 的展开态
 * 跨条目残留（A 条目展开着，B 条目顶到同一索引即继承展开）。
 * key 形态：实时链 `it-<store 序号>`，回放链 `hist-<记录序>`。
 */
export type StewardPanelItem = StewardPanelItemInput & { readonly key: string };

export interface StewardAskActivity {
  readonly phase: "thinking" | "tool";
  readonly toolName: string | null;
  readonly thinkingLines: readonly string[];
}

export interface FeedLine {
  readonly kind: string;
  readonly agentId: string;
  readonly text: string;
  readonly seq: number;
}

export interface StewardConfig {
  readonly enabled: boolean;
  readonly model: string;
}

export interface StewardStoreState {
  readonly items: readonly StewardPanelItem[];
  readonly streamingText: string | null;
  readonly feed: readonly FeedLine[];
  readonly askInFlight: boolean;
  readonly askActivity: StewardAskActivity | null;
  readonly config: StewardConfig | null;
  readonly dropNoticeSeq: number;
}

const EMPTY_STATE: StewardStoreState = {
  items: [],
  streamingText: null,
  feed: [],
  askInFlight: false,
  askActivity: null,
  config: null,
  dropNoticeSeq: 0,
};

/** i18n 译文函数（注入——store 非 React 域）。 */
type Translate = (key: string, params?: Record<string, string | number>) => string;

/** 发送面（useSession 注入——最新值覆盖，订阅驱动权单份）。 */
export interface StewardSenders {
  sendStewardAsk?: (text: string, source?: StewardAskSource) => boolean;
  sendStewardInterrupt?: (reason?: string) => boolean;
  sendStewardSubscribe?: () => boolean;
  sendStewardUnsubscribe?: () => boolean;
  sendStewardGetConfig?: () => boolean;
  sendStewardHistory?: (clear?: boolean) => boolean;
  subscribeStewardFrames?: (listener: (e: EventEnvelope) => void) => () => void;
}

function firstThinkingLine(text: string): string {
  const line = text
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l !== "") ?? "";
  return line.length <= THINKING_SUMMARY_MAX ? line : `${line.slice(0, THINKING_SUMMARY_MAX)}…`;
}

function summarizeArgs(args: Record<string, unknown>): string {
  const s = JSON.stringify(args) ?? "{}";
  return s.length <= ARGS_SUMMARY_MAX ? s : `${s.slice(0, ARGS_SUMMARY_MAX)}…`;
}

/** 回放记录 → 面板条目（同源映射：一条 assistant 记录可投影多个条目——
 *  thinking → 折叠条目、toolCall → 工具行；toolResult 按 toolCallId 配对
 *  回填结果摘要）。 */
export function recordsToItems(records: readonly StewardHistoryRecord[]): StewardPanelItem[] {
  const items: StewardPanelItem[] = [];
  // 回放键 = 记录时刻 + 记录内分片（u/t/c/a 与 toolCallId）：**内容派生**——
  // 同一记录重放键不变（展开态得以保留），不同记录即使落到同索引也不同键
  //（批内序号键会让「整批替换后同位置新条目」继承上一展开态——索引键缺陷
  // 换皮复发，实测踩中）
  const histKey = (r: StewardHistoryRecord, part: string) => `hist-${r.at}-${part}`;
  for (const r of records) {
    if (r.kind === "compaction") {
      continue; // 压缩摘要记录（事故热修批⑤）：内部上下文状态非用户话轮——零渲染
    }
    if (r.kind === "user") {
      items.push({ key: histKey(r, "u"), kind: "user", text: r.text });
      continue;
    }
    if (r.kind === "toolResult") {
      const target = [...items].reverse().find((i) => i.kind === "tool" && i.toolCallId === r.toolCallId);
      if (target !== undefined && target.kind === "tool") {
        const idx = items.indexOf(target);
        items[idx] = { ...target, resultSummary: r.text.slice(0, ARGS_SUMMARY_MAX) };
      } else {
        items.push({
          key: histKey(r, `tr-${r.toolCallId}`),
          kind: "tool",
          toolCallId: r.toolCallId,
          name: r.name,
          argsSummary: "",
          resultSummary: r.text.slice(0, ARGS_SUMMARY_MAX),
          startedAt: null,
          endedAt: null,
        });
      }
      continue;
    }
    if (r.thinking !== undefined && r.thinking.text !== "")
      items.push({ key: histKey(r, "t"), kind: "thinking", text: r.thinking.text });
    if (r.toolCall !== undefined) {
      items.push({
        key: histKey(r, `tc-${r.toolCall.id}`),
        kind: "tool",
        toolCallId: r.toolCall.id,
        name: r.toolCall.name,
        argsSummary: summarizeArgs(r.toolCall.args),
        resultSummary: null,
        startedAt: null,
        endedAt: null,
      });
    }
    if (r.text !== undefined && r.text !== "")
      items.push({ key: histKey(r, "a"), kind: "assistant", text: r.text });
  }
  return items;
}

class StewardStore {
  private state: StewardStoreState = EMPTY_STATE;
  private listeners = new Set<() => void>();
  private refs = 0;
  private unsubscribeFrames: (() => void) | null = null;
  private senders: StewardSenders = {};
  private t: Translate = (key) => key;
  private getConfigSentFor: number | null = null;
  private historySentFor: number | null = null;
  /** 连接代次（断连递增）：读命令幂等键——同代幂等防重渲染重发，换代重发
   *（daemon 重启/重连后 config 与 history 必须重拉；代次只随连接态变迁，
   * 不由 send 结果驱动——无 TR-169 自激面）。 */
  private connEpoch = 0;
  private installedSub: StewardSenders["subscribeStewardFrames"];

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): StewardStoreState => this.state;

  private setState(patch: Partial<StewardStoreState>): void {
    this.state = { ...this.state, ...patch };
    for (const l of this.listeners) l();
  }

  /** 测试隔离/零实例收位：清空状态与幂等守卫。 */
  reset(): void {
    this.state = EMPTY_STATE;
    this.getConfigSentFor = null;
    this.historySentFor = null;
    this.connEpoch = 0;
  }

  /**
   * 挂接客户端（每个 useSteward 实例 mount 一次）：refs 0→1 清位重置
   *（测试天然隔离）；帧订阅驱动权单份——按 subscribeStewardFrames 身份
   * 变化才换订（身份每渲染新的 mock/重连换函不致每渲染拆装冲状态）。
   */
  attach(senders: StewardSenders, t: Translate): () => void {
    this.senders = senders;
    this.t = t;
    this.refs += 1;
    if (this.refs === 1) this.reset();
    this.ensureDriver();
    return () => {
      this.refs -= 1;
      if (this.refs === 0) {
        this.unsubscribeFrames?.();
        this.unsubscribeFrames = null;
        this.installedSub = undefined;
        this.senders = {};
        this.reset();
      }
    };
  }

  /** 发送面刷新（每渲染——locale 切换等 t 更新）；顺带补装/换订驱动。 */
  setSenders(senders: StewardSenders, t: Translate): void {
    this.senders = senders;
    this.t = t;
    this.ensureDriver();
  }

  /** 驱动订阅：无订则装；subscribeStewardFrames 身份变化才换订。 */
  private ensureDriver(): void {
    const sub = this.senders.subscribeStewardFrames;
    if (typeof sub !== "function") return;
    if (this.installedSub === sub) return;
    this.unsubscribeFrames?.();
    this.unsubscribeFrames = sub((e) => this.applyEvent(e)) ?? null;
    this.installedSub = sub;
  }

  /** 断连即弃流式缓冲 + 复位 ask 在途面：daemon 的 ask.result 点对点发原连接
   *  （deliverResult(ctx.sendNow(sender))），断连后不会重连补发——不复位则
   *  面板输入禁用与 phase="asking" 永锁（TR-272 断连清位面）；连接代次递增
   *  （重连后读命令幂等键换代重拉）。 */
  onDisconnect(): void {
    this.connEpoch += 1;
    if (this.state.streamingText === null && !this.state.askInFlight && this.state.askActivity === null) return;
    this.setState({ streamingText: null, askInFlight: false, askActivity: null });
  }

  /** 配置读面（同连接代次幂等——防重渲染重发；重连换代重拉）。 */
  requestConfigOnce(): void {
    if (this.getConfigSentFor === this.connEpoch) return;
    this.getConfigSentFor = this.connEpoch;
    this.senders.sendStewardGetConfig?.();
  }

  /** 回放面（同连接代次幂等；重连换代重拉）。 */
  requestHistoryOnce(): void {
    if (this.historySentFor === this.connEpoch) return;
    this.historySentFor = this.connEpoch;
    this.senders.sendStewardHistory?.();
  }

  /** 订阅闸门（B1：connected + enabled → subscribe；开关关零订阅零推送）。 */
  syncSubscription(conn: string | undefined, enabled: boolean): void {
    if (conn !== "connected") return;
    if (enabled) this.senders.sendStewardSubscribe?.();
    else this.senders.sendStewardUnsubscribe?.();
  }

  ask(text: string, source?: StewardAskSource): boolean {
    const trimmed = text.trim();
    if (trimmed === "") return false;
    const send = this.senders.sendStewardAsk;
    if (typeof send !== "function") return false;
    const ok = send(trimmed, source);
    if (ok === false) return false; // 未连接：零静默丢消息（TR-168 严格判）
    this.pushItem({ kind: "user", text: trimmed });
    this.setState({
      streamingText: null, // 新一轮复位（防御：上轮断连残留）
      askInFlight: true,
      askActivity: { phase: "thinking", toolName: null, thinkingLines: [] },
    });
    return true;
  }

  stopInFlight(): boolean {
    const send = this.senders.sendStewardInterrupt;
    if (typeof send !== "function") return false;
    return send("panel-stop");
  }

  newDialog(): boolean {
    const send = this.senders.sendStewardHistory;
    if (typeof send !== "function") return false;
    const ok = send(true);
    if (ok === false) return false; // 未连接：不清（三处一致以 daemon 为准）
    this.setState({ items: [] }); // 本地先行清（回执空数组幂等覆盖）
    return true;
  }

  /** 条目序号（实时链 key 源——`it-<n>` 单调，禁索引键）。 */
  private itemSeq = 0;

  private pushItem(item: StewardPanelItemInput): void {
    const next = [...this.state.items, { ...item, key: `it-${(this.itemSeq += 1)}` } as StewardPanelItem];
    this.setState({ items: next.length > ITEM_WINDOW ? next.slice(-ITEM_WINDOW) : next });
  }

  private applyEvent(event: EventEnvelope): void {
    const t = this.t;
    if (event.type === "steward.ask.delta") {
      // 流式增量聚合：不落盘（items 不动）——终态 result 到达时清空并落
      // 权威消息；非在途（迟到 delta）忽略防脏写
      const payload = event.payload as { delta?: unknown };
      if (typeof payload.delta !== "string" || payload.delta === "") return;
      if (!this.state.askInFlight) return;
      this.setState({ streamingText: (this.state.streamingText ?? "") + payload.delta });
      return;
    }
    if (event.type === "steward.thinking") {
      const payload = event.payload as { text?: unknown };
      if (typeof payload.text !== "string" || payload.text === "") return;
      this.pushItem({ kind: "thinking", text: payload.text });
      if (this.state.askInFlight) {
        const prev = this.state.askActivity;
        if (prev !== null) {
          const next = [...prev.thinkingLines, firstThinkingLine(payload.text)];
          this.setState({
            askActivity: {
              ...prev,
              phase: "thinking",
              toolName: null,
              thinkingLines: next.length > STEWARD_THINKING_LINE_WINDOW ? next.slice(-STEWARD_THINKING_LINE_WINDOW) : next,
            },
          });
        }
      }
      return;
    }
    if (event.type === "steward.tool") {
      // 工具两相：start 开行（结果待配对）；end 回填最近同名待配对行。
      const payload = event.payload as
        | { phase: "start"; name?: unknown; argsSummary?: unknown }
        | { phase: "end"; name?: unknown; resultSummary?: unknown };
      if (payload.phase === "start") {
        if (typeof payload.name !== "string") return;
        const argsSummary = typeof payload.argsSummary === "string" ? payload.argsSummary : "{}";
        const startedAt = Date.now();
        this.pushItem({ kind: "tool", toolCallId: `live-${startedAt}`, name: payload.name, argsSummary, resultSummary: null, startedAt, endedAt: null });
        const prev = this.state.askActivity;
        if (prev !== null) this.setState({ askActivity: { ...prev, phase: "tool", toolName: payload.name } });
        return;
      }
      if (typeof payload.name !== "string") return;
      const resultSummary = typeof payload.resultSummary === "string" ? payload.resultSummary : "";
      const endedAt = Date.now();
      const items = this.state.items;
      for (let i = items.length - 1; i >= 0; i -= 1) {
        const it = items[i]!;
        if (it.kind === "tool" && it.name === payload.name && it.resultSummary === null) {
          const next = [...items];
          next[i] = { ...it, resultSummary, endedAt };
          this.setState({ items: next });
          break;
        }
      }
      const prev = this.state.askActivity;
      if (prev !== null) this.setState({ askActivity: { ...prev, phase: "thinking", toolName: null } });
      return;
    }
    if (event.type === "steward.history.result") {
      const payload = event.payload as { records?: unknown };
      if (!Array.isArray(payload.records)) return;
      this.setState({ items: recordsToItems(payload.records as StewardHistoryRecord[]) });
      return;
    }
    if (event.type === "steward.ask.result") {
      const payload = event.payload as
        | { status: "answer"; text: string }
        | { status: "confirm_required"; actionId: string; agentId: string; message: string }
        | { status: "queued"; queued: true; position: number }
        | { status: "dropped"; reason?: "ambient" }
        | { status: "stopped"; reason: string; dropped: number }
        | { status: "error"; reason: string };
      if (payload.status === "queued") {
        this.pushItem({ kind: "assistant", text: t("steward.askQueued", { position: payload.position }) });
        return;
      }
      this.setState({ streamingText: null, askActivity: null });
      if (payload.status === "dropped") {
        this.setState({ dropNoticeSeq: this.state.dropNoticeSeq + 1 });
        this.setState({ askInFlight: false });
        return;
      }
      if (payload.status === "stopped") {
        this.pushItem({
          kind: "assistant",
          text:
            payload.dropped > 0
              ? t("steward.stoppedNoticeDropped", { count: payload.dropped })
              : t("steward.stoppedNotice"),
        });
        this.setState({ askInFlight: false });
        return;
      }
      if (payload.status === "answer") {
        this.pushItem({ kind: "assistant", text: payload.text });
      } else if (payload.status === "error") {
        this.pushItem({ kind: "assistant", text: payload.reason });
      }
      this.setState({ askInFlight: false });
      return;
    }
    if (event.type === "steward.action.completed") {
      const payload = event.payload as { actionId?: unknown; ok?: unknown; detail?: unknown; outcome?: unknown };
      if (payload.outcome === "superseded") return;
      if (typeof payload.detail !== "string") return;
      this.pushItem({ kind: "assistant", text: payload.detail });
      return;
    }
    if (event.type === "steward.proactive") {
      const payload = event.payload as { title?: unknown; text?: unknown; suggestions?: unknown };
      if (typeof payload.title !== "string" || payload.title === "") return;
      if (typeof payload.text !== "string" || payload.text === "") return;
      const lines = [t("steward.proactiveTitle", { title: payload.title }), payload.text];
      if (Array.isArray(payload.suggestions)) {
        for (const s of payload.suggestions) {
          const label = (s as { label?: unknown }).label;
          if (typeof label === "string" && label.trim() !== "") lines.push(t("steward.proactiveSuggestion", { label }));
        }
      }
      this.pushItem({ kind: "assistant", text: lines.join("\n") });
      return;
    }
    if (event.type === "steward.config.result") {
      const payload = event.payload as StewardConfig;
      this.setState({ config: { enabled: payload.enabled === true, model: String(payload.model ?? "") } });
      return;
    }
    if (event.type === "steward.feed") {
      const payload = event.payload as FeedLine;
      if (typeof payload.seq !== "number" || typeof payload.text !== "string") return;
      const prevFeed = this.state.feed;
      // seq 去重（连接内单调；重连后 seq 重置——按 (seq,text) 宽松去重保尾窗）
      if (prevFeed.length > 0 && prevFeed[prevFeed.length - 1]!.seq === payload.seq && prevFeed[prevFeed.length - 1]!.text === payload.text) return;
      const next = [...prevFeed, payload];
      this.setState({ feed: next.length > STEWARD_FEED_MAX_LINES ? next.slice(-STEWARD_FEED_MAX_LINES) : next });
    }
  }
}

/** 模块级共享单例（面板/语音层/光球层同源）。 */
export const stewardStore = new StewardStore();
