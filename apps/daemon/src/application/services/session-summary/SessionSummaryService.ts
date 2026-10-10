/**
 * SessionSummaryService —— 会话总结器（会话总结器独立化批①）。
 *
 * 定位（TR-28 会话服务边界对号入座）：旁路观察者 + 后台元数据写面——
 * 不进 ChatService 轮次写路径（轮末事件经 fan-out 桥异步触发，fire-and-forget
 * 不阻塞 fan-out 全序），聚合变更与领域事件仍走 ChatService.updateTopic
 * 单一写路径；write-through 落盘由 SessionProjection 消费 session.topic.updated
 * 自然触发（整行快照含 topic），shell 刷新复用 session.list_changed 出海。
 *
 * 归拢（批①用户裁决：总结是平台能力不是管家私产）：原「管家 B5 轮末沉淀」
 * （记忆自动沉淀）与「SessionTitleService 轮末联合摘要」（topic + progress）
 * 两侧归拢为独立总结器——同一锚点、同一输入窗、**一次 LLM 调用出三产物**：
 * - topic（演进语义全保留：「保持」哨兵 / cleanTopicText / 显式标题锁定 /
 *   updateTopic 单一写路径 / title-topic 分野）；
 * - progress（≤120 字与覆盖更新语义在 recordSessionProgress——本层只投递）；
 * - memoryPoints（值得跨会话记住的用户偏好/习惯/纠正/事实线索——**结构化
 *   产物 [{text, kind, domain}]**（domain 维度批）：kind ∈ preference|fact、
 *   domain ∈ habit|general|project 三判据提取分类，不再固定 kind=preference；
 *   走 remember 两段查重闸入库，source = "session-summary"；domain=project
 *   由写入单点取会话项目归约）；
 *
 * 触发与锚点：`turn.completed`（done + interrupted 都进——被打断也是进展
 * 信息）经 fan-out session-summary-bridge 旁路异步触发。锚点 = 统一计数
 *（done+interrupted 合计）`count===1 || count % everyTurns === 0`，
 * everyTurns = summary.everyTurns（1-20 可配缺省 3——标题/进展/记忆点共用
 * 节奏；重启计数清零可接受——覆盖更新幂等无累积伤害）。topic 产物额外
 * done-only（interrupted 轮进展照进，标题不动——旧语义保留）。
 *
 * 产物 gate：summary.enabled = 三产物总开关（false 全停零 LLM）；进展+记忆点
 * 需 summary.model 显式配置（无默认纪律）且对应写面在场；记忆点另有防双写
 * 闸——本轮（上次 turn.completed 以来）显式 remember 过 → 记忆点跳过
 *（用户刚教过的不再由总结器代写），topic/progress 照常。
 *
 * LLM 协议：三产物形态 = SUMMARY_SYSTEM_PROMPT + JSON 三字段（按产物集裁剪
 * 字段）；parseSessionSummary 容错（```json 围栏剥壳 + 首尾大括号定位 +
 * 字段缺席容忍 + memoryPoints 数组/单串双形态）；烂输出整体丢弃、下个锚点
 * 幂等重试（零半产物写入）。**只出标题降级形态**（summary.model 未配）保留
 * 旧纯文本协议 + cleanTopicText + 「保持」哨兵（零回归路径）。
 *
 * 模型槽位回落链（装配面 modelSlot 闭包收口）：summary.model → flash 默认
 *（PiStewardLlmAdapter defaultModel）——服务层单 adapter 无感知。
 *
 * 失败降级：LLM 失败保留旧 topic / 零 progress/记忆点写入静默过掉，下锚点
 * 自然重试；同会话 in-flight 防抖（inFlight Set）。
 */
import type { DomainEvent } from "../../../domain/events/DomainEvent";
import type { SessionEntryData } from "../../../domain/session/SessionSnapshot";
import type { MemoryDomain } from "../../ports/outbound/StewardMemoryPort";
import type { StewardLlmPort } from "../../ports/outbound/StewardLlmPort";
import type { SummaryConfigState } from "../../summary/summaryConfig";
import type { StewardMemoryWrittenPayload } from "@helix/protocol";
import { stewardBlocksText } from "../../steward/stewardBlocks";
import { deriveTitle } from "../SessionRegistry";

/** 演进执行面（组合根闭包注入：ChatService 单一写路径 + registry 广播出海）。 */
export interface SessionSummaryTarget {
  /** 聚合演进主题更新（ChatService.updateTopic——域守卫 + session.topic.updated 事件）。 */
  updateTopic(topic: string, previous: string, anchorTurn: number): void;
  /** 当前主题判定面：显式标题（锁定）/ 演进主题现值 / 轮数 / 输入素材。 */
  readonly title?: string;
  readonly topic?: string;
  readonly turnCount: number;
  /** 最近 N 条用户消息文本（时间升序；已截断）。 */
  readonly recentUserTexts: readonly string[];
  /** 首条 assistant 回复文本（首轮矫正素材；无 = undefined）。 */
  readonly firstAssistantText?: string;
  /** 首条用户消息原文（displayTitle 兜底推导源）。 */
  readonly firstUserText: string | null;
  /** 最近轮次对投影（可选——缺席时退化为 recentUserTexts 单侧投影）。 */
  readonly recentTurnPairs?: readonly { user: string; assistant?: string }[];
}

export interface SessionSummaryServiceDeps {
  /** 总结配置域实时读面（每次锚点判定前读——设置保存即刻生效）。 */
  readonly readConfig: () => SummaryConfigState;
  /** 生成面（单步补全；模型槽位 = 装配面 modelSlot 闭包——summary.model →
   *  flash 默认，服务层无感知）。 */
  readonly llm: StewardLlmPort;
  /** progress 写入面（StewardMemoryService.recordSessionProgress 委托；
   *  静默降级语义在彼端——本层只管投递；缺席 = progress 不产）。 */
  readonly progressStore?: {
    recordSessionProgress(sessionId: string, text: string): Promise<boolean>;
  };
  /** 记忆点写入面（StewardMemoryService.rememberSessionMemoryPoint 委托——
   *  remember 两段查重闸语义复用，source = "session-summary"；缺席 = 记忆点
   *  不产）。domain 维度批：结构化点（含 kind/domain 提取分类）+ sessionId
   *  透传（domain=project 时写入单点取会话项目）。explicitRememberedSince：
   *  防双写闸读面（本轮显式 remember 水位）。 */
  readonly memoryPointsStore?: {
    rememberMemoryPoint(point: MemoryPoint, sessionId: string): Promise<{ id: number; updated: boolean }>;
    explicitRememberedSince(since: number): boolean;
  };
  /** 记忆落盘通知（memory_written 通知卡链——自动沉淀换轨后沿用 B5 静默入库
   *  + 通知契约）。 */
  readonly emitMemoryWritten?: (payload: StewardMemoryWrittenPayload) => void;
  /** 热会话目标解析（冷会话/已删除 → undefined；锚点事件必热——冷会话无轮可完成）。 */
  readonly resolveTarget: (sessionId: string) => SessionSummaryTarget | undefined;
  /** 演进成功后的 shell 通知（session.list_changed 出海——组合根接 registry）。 */
  readonly announceTopicChanged: (sessionId: string) => void;
  /** 时钟（防双写水位窗；缺省 Date.now——测试注入）。 */
  readonly now?: () => number;
  readonly logger?: { warn(message: string): void };
}

// ── 纯函数（导出供单测） ────────────────────────────────────

/** 锚点判定：第 1 轮（首条消息 → 主题句）与每 everyTurns 轮（3 档 = 1/3/6/9…）。
 *  三产物共用节拍（summary.everyTurns 可配——done+interrupted 合计计数）。 */
export function isSummaryAnchorTurn(count: number, everyTurns: number): boolean {
  return count === 1 || (count > 1 && everyTurns > 0 && count % everyTurns === 0);
}

/** 新主题长度上限（Unicode 码点——与会话清单首条消息推导同口径）。 */
export const TOPIC_MAX_CHARS = 30;

/** 生成模型判定输出中的「保持」哨兵（完整输出等于该词 = 主题未漂移）。 */
export const TOPIC_KEEP_SENTINEL = "保持";

/** 单条用户消息截断（输入预算护栏——10 条 × 200 字 ≈ 2k token 内）。 */
export const TOPIC_INPUT_MSG_MAX_CHARS = 200;

/** 首轮矫正时首条 assistant 回复截断（主题句素材，非全文）。 */
export const TOPIC_FIRST_ASSISTANT_MAX_CHARS = 500;

/** 记忆点单条长度上限（Unicode 码点——超限截断；prompt 侧另限 40 字）。 */
export const SUMMARY_MEMORY_POINT_MAX_CHARS = 60;

/** 单锚点记忆点条数上限（成本/噪音护栏——提取以少而准为目标）。 */
export const SUMMARY_MEMORY_POINTS_MAX = 3;

/** LLM 输出清洗：去首尾空白/句读/包裹引号；「保持」或清洗后为空 → null（不更新）；超长截断。 */
export function cleanTopicText(raw: string): string | null {
  // 句读先修（模型常把句号落在引号外：「…」。——先剥引号会匹配不上）
  let t = raw.trim().replace(/[。．.！!？?…]+$/u, "").trim();
  // 包裹引号剥壳（模型爱加引号：『「"' 常见成对形态，最多剥两层）
  for (let i = 0; i < 2; i++) {
    const m = t.match(/^([「『"'《])(.*)([」』"'》])$/s);
    if (m === null) break;
    t = m[2]!.trim();
  }
  if (t === TOPIC_KEEP_SENTINEL) return null;
  if (t === "") return null;
  const chars = [...t];
  return chars.length > TOPIC_MAX_CHARS ? chars.slice(0, TOPIC_MAX_CHARS).join("") : t;
}

/** 生成面 system prompt（只出标题降级形态——旧纯文本协议零回归路径）。 */
export const TOPIC_SYSTEM_PROMPT =
  "你是会话主题命名器。根据当前主题与最近的用户消息，为这个工作会话命名一句话主题。" +
  "要求：不超过 30 字的名词短语（不带句号/引号），概括会话当前的实际工作内容。";

/** 生成面 user prompt（skipJudge = 首轮命名——不给「保持」出口）。 */
export function buildTopicPrompt(input: {
  readonly displayTitle: string;
  readonly recentUserTexts: readonly string[];
  readonly firstAssistantText?: string;
  readonly skipJudge: boolean;
}): string {
  const lines: string[] = [`当前主题：${input.displayTitle}`];
  if (input.firstAssistantText !== undefined) {
    lines.push(`会话开场的助手回复（节选）：${input.firstAssistantText}`);
  }
  if (input.recentUserTexts.length > 0) {
    lines.push("最近的用户消息（旧→新）：");
    for (const t of input.recentUserTexts) lines.push(`- ${t}`);
  } else {
    lines.push("（本会话暂无用户消息）");
  }
  lines.push(
    input.skipJudge
      ? "请输出该会话当前的一句话主题（仅主题短语本身）。"
      : `如果上述消息与当前主题方向一致（未实质漂移），只输出「${TOPIC_KEEP_SENTINEL}」；否则输出新的一句话主题（仅主题短语本身，不超过 30 字）。`,
  );
  return lines.join("\n");
}

// ── 三产物协议（JSON）────────────────────────────────────

/** 结构化记忆点（domain 维度批产物形状：[{text, kind, domain}]——
 *  kind ∈ preference|fact、domain ∈ habit|general|project，提取时分类）。 */
export interface MemoryPoint {
  readonly text: string;
  readonly kind: "fact" | "preference";
  readonly domain: MemoryDomain;
}

/** 三产物总结 system prompt（joint 形态——字段按产物集裁剪）。 */
export const SUMMARY_SYSTEM_PROMPT =
  "你是会话轮末总结器。根据当前主题与最近的消息窗口，输出一个 JSON 对象（不要输出 JSON 以外的任何文字）。" +
  "字段规则：topic = 不超过 30 字的名词短语（不带句号/引号），概括会话当前的实际工作内容；" +
  "progress = 中文进展总结（在做什么/干到哪/结论或待办），通常两到五句、200 字以内；" +
  "信息完整优先于简短：写清做了什么、结果与关键细节（文件、数字、提交号），目标是读到此条即可向用户交代会话现状、无需回源对话；" +
  "memoryPoints = 值得跨会话记住的记忆点对象数组（没有则空数组 []），每个对象三个字段：" +
  "text（一句记忆句，主语明确（用户……）、不超过 40 字）；" +
  "kind（二选一：\"preference\" = 用户偏好/习惯/要求；\"fact\" = 事实/环境/纠正）；" +
  "domain（三选一：\"habit\" = 关于用户怎么干活，换个团队也成立；\"general\" = 环境与通用工作方式事实，跟项目无关；\"project\" = 绑定具体项目才有意义，换个项目不成立）。";

/** 三产物 user prompt（按产物集裁剪字段——topic 未 wanted 时不给「保持」出口）。 */
export function buildSummaryPrompt(input: {
  readonly displayTitle: string;
  readonly recentTurnPairs: readonly { user: string; assistant?: string }[];
  readonly wantTopic: boolean;
  readonly wantProgress: boolean;
  readonly wantMemoryPoints: boolean;
}): string {
  const lines: string[] = [`当前主题：${input.displayTitle}`];
  if (input.recentTurnPairs.length > 0) {
    lines.push("最近的消息（旧→新）：");
    for (const p of input.recentTurnPairs) {
      lines.push(`[用户] ${p.user}`);
      if (p.assistant !== undefined && p.assistant !== "") lines.push(`[助手] ${p.assistant}`);
    }
  } else {
    lines.push("（本会话暂无用户消息）");
  }
  const fields: string[] = [];
  if (input.wantTopic) {
    fields.push('"topic": "不超过 30 字的名词短语；与当前主题方向一致（未实质漂移）时输出「保持」"');
  }
  if (input.wantProgress) {
    fields.push('"progress": "进展总结（在做什么/干到哪/结论或待办），通常两到五句、200 字以内，信息完整优先——写清做了什么、结果与关键细节（文件/数字/提交号）"');
  }
  if (input.wantMemoryPoints) {
    fields.push(
      '"memoryPoints": [{"text": "一句记忆句（主语明确、不超 40 字）", "kind": "preference|fact", "domain": "habit|general|project"}]（没有则 []；kind：preference=用户偏好/习惯/要求，fact=事实/环境/纠正；domain：habit=关于用户怎么干活（换个团队也成立），general=环境与通用工作方式事实（跟项目无关），project=绑定具体项目才有意义（换个项目不成立）)',
    );
  }
  lines.push(`请只输出一个 JSON 对象：{${fields.join(", ")}}`);
  return lines.join("\n");
}

/** 三产物解析（容错纯函数，导出供单测）：```json 围栏剥壳 + 首尾大括号
 * 定位 + JSON.parse；字段缺席容忍（只收有效字段——topic/progress 字符串非空、
 * memoryPoints 结构化 [{text,kind,domain}] 逐元素过滤无效项，旧纯文本形态容错
 * 为 {text, kind:"preference", domain:"habit"}（旧固定语义回落），单串容错为单
 * 元素数组）；任何解析失败 → undefined（烂输出整体丢弃，下个锚点幂等重试——
 * 零半产物写入）。 */
export function parseSessionSummary(raw: string): { topic?: string; progress?: string; memoryPoints?: MemoryPoint[] } | undefined {
  let t = raw.trim();
  const fence = t.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  if (fence !== null) t = fence[1]!;
  const start = t.indexOf("{");
  const end = t.lastIndexOf("}");
  if (start === -1 || end <= start) return undefined;
  let obj: unknown;
  try {
    obj = JSON.parse(t.slice(start, end + 1));
  } catch {
    return undefined;
  }
  if (typeof obj !== "object" || obj === null || Array.isArray(obj)) return undefined;
  const record = obj as Record<string, unknown>;
  const out: { topic?: string; progress?: string; memoryPoints?: MemoryPoint[] } = {};
  if (typeof record.topic === "string" && record.topic.trim() !== "") out.topic = record.topic;
  if (typeof record.progress === "string" && record.progress.trim() !== "") out.progress = record.progress;
  const mp = record.memoryPoints;
  const rawPoints: unknown[] = Array.isArray(mp) ? mp : typeof mp === "string" && mp.trim() !== "" ? [mp] : [];
  const points = rawPoints
    .map(toMemoryPoint)
    .filter((p): p is MemoryPoint => p !== null);
  if (points.length > 0) out.memoryPoints = points;
  return out;
}

/** 记忆点单元素容错（解析纯函数）：旧纯文本形态回落 {preference, habit}
 *（旧固定语义）；对象形态要求三字段全合法（无效元素过滤不整批丢）；
 * 其余形态 → null。 */
function toMemoryPoint(raw: unknown): MemoryPoint | null {
  if (typeof raw === "string") {
    const text = raw.trim();
    return text === "" ? null : { text, kind: "preference", domain: "habit" };
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const text = typeof r.text === "string" ? r.text.trim() : "";
  const kind = r.kind;
  const domain = r.domain;
  if (text === "") return null;
  if (kind !== "preference" && kind !== "fact") return null;
  if (domain !== "habit" && domain !== "general" && domain !== "project") return null;
  return { text, kind, domain };
}

/** 总结输入窗单条截断（Unicode 码点）。 */
const SUMMARY_PAIR_MAX_CHARS = 200;

/** 最近轮次对投影（总结素材：user 输入 + 同轮最后一条 assistant 文本
 *  = 最终结论；时间升序，单条截断；组合根装配用共享工具）。 */
export function recentTurnPairsOf(
  entries: readonly SessionEntryData[],
  limit: number,
): { user: string; assistant?: string }[] {
  const pairs: { user: string; assistant?: string }[] = [];
  let current: { user: string; assistant?: string } | undefined;
  const cap = (t: string): string =>
    [...t].length > SUMMARY_PAIR_MAX_CHARS ? [...t].slice(0, SUMMARY_PAIR_MAX_CHARS).join("") : t;
  for (const e of entries) {
    if (!("role" in e) || typeof e.text !== "string" || e.text === "") continue;
    if (e.role === "user") {
      current = { user: cap(e.text) };
      pairs.push(current);
    } else if (e.role === "assistant" && current !== undefined) {
      current.assistant = cap(e.text); // 同轮多条取末值（最终结论语义）
    }
  }
  return pairs.slice(-limit);
}

/** recentUserTexts 单侧退化投影（recentTurnPairs 缺席时光标——只有用户侧无助手结论）。 */
function recentUserTextsToPairs(texts: readonly string[]): { user: string; assistant?: string }[] {
  return texts.map((t) => ({ user: t }));
}

/** 最近用户消息投影（组合根装配用共享工具；时间升序、截断单条）。 */
export function recentUserTextsOf(entries: readonly SessionEntryData[], limit: number): string[] {
  const texts: string[] = [];
  for (const e of entries) {
    if (!("role" in e) || e.role !== "user" || typeof e.text !== "string" || e.text === "") continue;
    texts.push([...e.text].length > TOPIC_INPUT_MSG_MAX_CHARS ? [...e.text].slice(0, TOPIC_INPUT_MSG_MAX_CHARS).join("") : e.text);
  }
  return texts.slice(-limit);
}

/** 单条文本截断（Unicode 码点；记忆点护栏）。 */
function capPoints(t: string): string {
  const chars = [...t];
  return chars.length > SUMMARY_MEMORY_POINT_MAX_CHARS ? chars.slice(0, SUMMARY_MEMORY_POINT_MAX_CHARS).join("") : t;
}

// ── 服务体 ─────────────────────────────────────────────────

export class SessionSummaryService {
  private readonly deps: SessionSummaryServiceDeps;
  /** 同会话总结防抖（锚点间隔常态不重叠；紧贴场景防御）。 */
  private readonly inFlight = new Set<string>();
  /** 会话完成轮计数（done + interrupted 合计；内存态——重启清零可接受：
   *  锚点节奏重排一次，覆盖更新幂等无累积伤害）。 */
  private readonly turnCounts = new Map<string, number>();
  /** 轮跨度起点（防双写水位窗：「本轮」= 上次 turn.completed 至本次）。 */
  private readonly turnSpanStart = new Map<string, number>();
  private readonly startedAt: number;

  constructor(deps: SessionSummaryServiceDeps) {
    this.deps = deps;
    this.startedAt = (deps.now ?? Date.now)();
  }

  /**
   * fan-out 桥入口（wireEventFanout session-summary-bridge 链末端）：粗筛
   * 主实例完成轮 → fire-and-forget 总结（快进快出——LLM 调用全部异步，
   * 不阻塞 fan-out 全序与后续目标）。interrupted 轮也进（被打断也是进展
   * 信息）——计数面一律 ++，产物面 evolve 内分流（topic 只认 done 触发，
   * progress/记忆点按锚点照进）。
   */
  onDomainEvent(event: DomainEvent): void {
    if (event.type !== "turn.completed") return;
    const payload = event.payload as { reason?: string };
    if (payload.reason !== "done" && payload.reason !== "interrupted") return;
    const sessionId = event.sessionId;
    const now = (this.deps.now ?? Date.now)();
    this.turnCounts.set(sessionId, (this.turnCounts.get(sessionId) ?? 0) + 1);
    const spanStart = this.turnSpanStart.get(sessionId) ?? this.startedAt;
    this.turnSpanStart.set(sessionId, now);
    void this.evolve(sessionId, payload.reason === "done" ? "done" : "interrupted", spanStart).catch((err: unknown) => {
      this.deps.logger?.warn(`会话轮末总结失败（${sessionId}）：${(err as Error).message}`);
    });
  }

  /** 锚点总结主流程（纯副作用编排；全失败面静默降级保留旧 topic/零产物写入）。 */
  private async evolve(sessionId: string, trigger: "done" | "interrupted", spanStart: number): Promise<void> {
    const config = this.deps.readConfig();
    if (!config.enabled) return; // 三产物总开关——全停零 LLM
    if (this.inFlight.has(sessionId)) return;
    const target = this.deps.resolveTarget(sessionId);
    if (target === undefined) return;

    // 锚点判定（三产物共用 summary.everyTurns 节奏——done+interrupted 合计）
    const count = this.turnCounts.get(sessionId) ?? 0;
    if (!isSummaryAnchorTurn(count, config.everyTurns)) return;

    // 产物意图：topic = done-only + 显式标题未锁定；progress/记忆点 =
    // summary.model 显式已配（无默认纪律）+ 对应写面在场；记忆点另有防双写闸
    const topicWanted = trigger === "done" && target.title === undefined;
    const deep = (config.model ?? "") !== "";
    const progressWanted = deep && this.deps.progressStore !== undefined;
    const memoryWanted =
      deep &&
      this.deps.memoryPointsStore !== undefined &&
      !this.deps.memoryPointsStore.explicitRememberedSince(spanStart);
    if (!topicWanted && !progressWanted && !memoryWanted) return;

    this.inFlight.add(sessionId);
    try {
      const displayTitle = target.topic ?? deriveTitle(target.firstUserText);
      const jsonMode = progressWanted || memoryWanted;

      const response = await this.deps.llm.complete({
        systemPrompt: jsonMode ? SUMMARY_SYSTEM_PROMPT : TOPIC_SYSTEM_PROMPT,
        messages: [
          {
            role: "user",
            text: jsonMode
              ? buildSummaryPrompt({
                  displayTitle,
                  recentTurnPairs: target.recentTurnPairs ?? recentUserTextsToPairs(target.recentUserTexts),
                  wantTopic: topicWanted,
                  wantProgress: progressWanted,
                  wantMemoryPoints: memoryWanted,
                })
              : buildTopicPrompt({
                  displayTitle,
                  recentUserTexts: target.recentUserTexts,
                  firstAssistantText: target.firstAssistantText,
                  skipJudge: target.topic === undefined,
                }),
          },
        ],
        tools: [],
      });
      if (response.kind !== "blocks") return; // aborted 非产出面——降级过掉
      const raw = stewardBlocksText(response.blocks);

      if (jsonMode) {
        // JSON 三产物协议：烂输出整体丢弃（下个锚点幂等重试——零半产物写入）
        const parsed = parseSessionSummary(raw);
        if (parsed === undefined) return;
        if (topicWanted && parsed.topic !== undefined) {
          const topic = cleanTopicText(parsed.topic);
          if (topic !== null && topic !== displayTitle) {
            target.updateTopic(topic, displayTitle, target.turnCount);
            this.deps.announceTopicChanged(sessionId);
          }
        }
        if (progressWanted && parsed.progress !== undefined) {
          await this.deps.progressStore!.recordSessionProgress(sessionId, parsed.progress);
        }
        if (memoryWanted && parsed.memoryPoints !== undefined) {
          await this.storeMemoryPoints(parsed.memoryPoints, sessionId);
        }
      } else {
        // 只出标题降级形态（summary.model 未配）：旧纯文本协议（零回归路径）
        const topic = cleanTopicText(raw);
        if (topic === null || topic === displayTitle) return;
        target.updateTopic(topic, displayTitle, target.turnCount);
        this.deps.announceTopicChanged(sessionId);
      }
    } catch (err: unknown) {
      // 失败降级：保留旧 topic / 零 progress/记忆点写入，静默过掉——下个锚点自然重试
      this.deps.logger?.warn(`会话轮末总结降级（${sessionId}）：${(err as Error).message}`);
    } finally {
      this.inFlight.delete(sessionId);
    }
  }

  /** 记忆点入库（逐条 best-effort——单条失败不拖垮其余；查重语义在
   *  remember 两段闸（E-214）——同条覆盖更新不重复堆积。条数/单条长度护栏
   *  在此收口；结构化点（text/kind/domain）逐字段透传 + sessionId（domain=
   *  project 取会话项目）；落盘通知沿用 memory_written 通知卡链）。 */
  private async storeMemoryPoints(points: readonly MemoryPoint[], sessionId: string): Promise<void> {
    const store = this.deps.memoryPointsStore!;
    for (const point of points.slice(0, SUMMARY_MEMORY_POINTS_MAX)) {
      const capped: MemoryPoint = { ...point, text: capPoints(point.text) };
      try {
        const saved = await store.rememberMemoryPoint(capped, sessionId);
        this.deps.emitMemoryWritten?.({ text: capped.text, mode: saved.updated ? "updated" : "added" });
      } catch (err) {
        this.deps.logger?.warn(`记忆点入库降级：${(err as Error).message}`);
      }
    }
  }
}
