/**
 * SessionTitleService —— 会话阶段演进主题（动态主题批）application service。
 *
 * 定位（TR-28 会话服务边界对号入座）：旁路观察者 + 后台元数据写面——
 * 不进 ChatService 轮次写路径（轮末事件经 fan-out 桥异步触发，fire-and-forget
 * 不阻塞 fan-out 全序），聚合变更与领域事件仍走 ChatService.updateTopic
 * 单一写路径；write-through 落盘由 SessionProjection 消费 session.topic.updated
 * 自然触发（整行快照含 topic），shell 刷新复用 session.list_changed 出海。
 *
 * 演进策略（用户裁决 2026-09-24）：以 LLM 轮次为节拍——
 * - 锚点 = 第 1 / 3 / 6 / 9… 个完成轮（turn.completed reason="done"）：
 *   首轮矫正把「首条用户消息」升格为一句话主题；此后每 3 轮矫正一次；
 * - 分类判断恒开（用户裁决 2026-09-24）：选中分类模型（topic_config.
 *   classifyEndpointId，Jev 等按端点 variant 区分实现）→ 判官先判
 *   「主题是否实质漂移」（零生成 token），未漂移直接短路省掉生成调用；
 *   未选 → 生成模型一次调用自带「保持 | 新主题」判别（生成模型兼任判断）；
 * - 显式标题保护（域守卫双保险）：title 已定格（用户/管家显式命名）的
 *   会话零演进——读面优先级 title > topic > firstUserText；
 * - 失败降级：LLM/判官失败保留旧 topic 静默过掉，下个锚点自然重试。
 */
import type { DomainEvent } from "../../../domain/events/DomainEvent";
import type { SessionEntryData } from "../../../domain/session/SessionSnapshot";
import type { TopicConfig } from "../../ports/outbound/TopicConfigPort";
import type { StewardLlmPort } from "../../ports/outbound/StewardLlmPort";
import { stewardBlocksText } from "../../steward/stewardBlocks";
import { deriveTitle } from "../SessionRegistry";

// ── 配置（单键 topic_config JSON——TopicConfigStore 读写单点；服务只吃形状） ──

/** 运行时配置读面形状（TopicConfigPort.current 实时读——设置保存即刻生效）。 */
export type SessionTopicRuntimeConfig = TopicConfig;

/** 演进执行面（组合根闭包注入：ChatService 单一写路径 + registry 广播出海）。 */
export interface SessionTitleEvolveTarget {
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
  /** progress 批：最近轮次对投影（可选——缺席时退化为 recentUserTexts 单侧投影）。 */
  readonly recentTurnPairs?: readonly { user: string; assistant?: string }[];
}

export interface SessionTitleServiceDeps {
  /** 配置实时读面（每次锚点判定前读——开关关 = 零 LLM 调用零演进）。 */
  readonly readConfig: () => SessionTopicRuntimeConfig;
  /** 生成面（单步补全；模型槽位 = 装配面 modelSlot 闭包——联合模式下
   *  解析序 sessionMemory.model → topic_config.model → flash 默认，服务层
   *  无感知（单一 adapter 单次调用，合并请求的模型分派在装配面收口）。 */
  readonly llm: StewardLlmPort;
  /** 分类判官能力位（可选——装配层按 classifyEndpointId 实时解析构造；
   *  classifyEndpointId 未选/端点失效 = 退化为生成模型兼任判断）。progress
   *  批：仅在纯 topic 模式（sessionMemory 未开）生效——联合模式下短路退役
   *  （「主题稳定、进展推进」是最常见态，短路会恰掐掉进展最需要更新的场景）。 */
  readonly judge?: { noul(state: string, question: string): Promise<number> };
  /** progress 批：sessionMemory 配置读面（可选——缺席 = progress 永不产）。 */
  readonly sessionMemory?: {
    read(): { enabled: boolean; model: string | null; everyTurns: number };
  };
  /** progress 批：progress 写入面（StewardMemoryService.recordSessionProgress
   *  委托；静默降级语义在彼端——本层只管投递）。 */
  readonly progressStore?: {
    recordSessionProgress(sessionId: string, text: string): Promise<boolean>;
  };
  /** 热会话目标解析（冷会话/已删除 → undefined；锚点事件必热——冷会话无轮可完成）。 */
  readonly resolveTarget: (sessionId: string) => SessionTitleEvolveTarget | undefined;
  /** 演进成功后的 shell 通知（session.list_changed 出海——组合根接 registry）。 */
  readonly announceTopicChanged: (sessionId: string) => void;
  readonly logger?: { warn(message: string): void };
}

// ── 纯函数（导出供单测） ────────────────────────────────────

/** 矫正锚点判定：第 1 轮（首条消息 → 主题句）与每 3 轮（3/6/9…）。 */
export function isAnchorTurn(turnCount: number): boolean {
  return turnCount === 1 || (turnCount > 1 && turnCount % 3 === 0);
}

/** 新主题长度上限（Unicode 码点——与会话清单首条消息推导同口径）。 */
export const TOPIC_MAX_CHARS = 30;

/** 生成模型判定输出中的「保持」哨兵（完整输出等于该词 = 主题未漂移）。 */
export const TOPIC_KEEP_SENTINEL = "保持";

/** 单条用户消息截断（输入预算护栏——10 条 × 200 字 ≈ 2k token 内）。 */
export const TOPIC_INPUT_MSG_MAX_CHARS = 200;

/** 首轮矫正时首条 assistant 回复截断（主题句素材，非全文）。 */
export const TOPIC_FIRST_ASSISTANT_MAX_CHARS = 500;

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

/** 判官漂移阈值（校准概率 ≥ 此值 = 实质漂移 → 进入生成段；noul ∈ [0,1]）。 */
export const TOPIC_DRIFT_THRESHOLD = 0.5;

/** 生成面 system prompt（一段式与两段式共用；两段式时 judge 已判漂移，生成段只产新主题）。 */
export const TOPIC_SYSTEM_PROMPT =
  "你是会话主题命名器。根据当前主题与最近的用户消息，为这个工作会话命名一句话主题。" +
  "要求：不超过 30 字的名词短语（不带句号/引号），概括会话当前的实际工作内容。";

/** 生成面 user prompt（skipJudge = 两段式已判漂移——不再给「保持」出口）。 */
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

/** 两段式判官输入：state（最近用户消息全文）与 question（漂移判定问句）分离
 *（Jev noul 协议面：state = 上下文、question = 判定问题）。 */
export function buildDriftJudgeInput(input: {
  readonly displayTitle: string;
  readonly recentUserTexts: readonly string[];
}): { state: string; question: string } {
  const state =
    input.recentUserTexts.length > 0
      ? `会话当前主题：「${input.displayTitle}」\n最近用户消息（旧→新）：\n- ${input.recentUserTexts.join("\n- ")}`
      : `会话当前主题：「${input.displayTitle}」（暂无用户消息）`;
  return {
    state,
    question: "该会话的实际工作内容是否已经发生实质漂移（当前主题不再能概括最近的消息）？",
  };
}

// ── progress 批：联合摘要协议（JSON 双产物）───────────────

/** 联合摘要 system prompt（joint / progress-only 两形态共用——字段按产物集裁剪）。 */
export const JOINT_SUMMARY_SYSTEM_PROMPT =
  "你是会话轮末摘要器。根据当前主题与最近的消息窗口，输出一个 JSON 对象（不要输出 JSON 以外的任何文字）。" +
  "字段规则：topic = 不超过 30 字的名词短语（不带句号/引号），概括会话当前的实际工作内容；" +
  "progress = 不超过两句的简洁中文进展状态（在做什么/干到哪/待办或结论）。";

/** 联合摘要 user prompt（按产物集裁剪字段——topic 未wanted 时不给「保持」出口）。 */
export function buildJointPrompt(input: {
  readonly displayTitle: string;
  readonly recentTurnPairs: readonly { user: string; assistant?: string }[];
  readonly wantTopic: boolean;
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
  fields.push('"progress": "不超过两句的进展状态（在做什么/干到哪/待办或结论）"');
  lines.push(`请只输出一个 JSON 对象：{${fields.join(", ")}}`);
  return lines.join("\n");
}

/** 联合产物解析（容错纯函数，导出供单测）：```json 围栏剥壳 + 首尾大括号
 * 定位 + JSON.parse；字段缺席容忍（只收字符串非空字段）；任何解析失败 →
 * undefined（烂输出整体丢弃，下个锚点幂等重试——零半产物写入）。 */
export function parseJointSummary(raw: string): { topic?: string; progress?: string } | undefined {
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
  if (typeof obj !== "object" || obj === null) return undefined;
  const record = obj as Record<string, unknown>;
  const out: { topic?: string; progress?: string } = {};
  if (typeof record.topic === "string" && record.topic.trim() !== "") out.topic = record.topic;
  if (typeof record.progress === "string" && record.progress.trim() !== "") out.progress = record.progress;
  return out;
}

/** progress 输入窗单条截断（Unicode 码点）。 */
const JOINT_PAIR_MAX_CHARS = 200;

/** 最近轮次对投影（progress 素材：user 输入 + 同轮最后一条 assistant 文本
 *  = 最终结论；时间升序，单条截断；组合根装配用共享工具）。 */
export function recentTurnPairsOf(
  entries: readonly SessionEntryData[],
  limit: number,
): { user: string; assistant?: string }[] {
  const pairs: { user: string; assistant?: string }[] = [];
  let current: { user: string; assistant?: string } | undefined;
  const cap = (t: string): string =>
    [...t].length > JOINT_PAIR_MAX_CHARS ? [...t].slice(0, JOINT_PAIR_MAX_CHARS).join("") : t;
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

// ── 服务体 ─────────────────────────────────────────────────

export class SessionTitleService {
  private readonly deps: SessionTitleServiceDeps;
  /** 同会话演进防抖（锚点间隔 3 轮常态不重叠；turn1→turn3 紧贴场景防御）。 */
  private readonly inFlight = new Set<string>();
  /** progress 独立完成轮计数（progress 批：done + interrupted 合计；内存态
   * ——重启清零可接受：锚点节奏重排一次，覆盖更新幂等无累积伤害）。 */
  private readonly progressCount = new Map<string, number>();

  constructor(deps: SessionTitleServiceDeps) {
    this.deps = deps;
  }

  /**
   * fan-out 桥入口（wireEventFanout session-topic-bridge 链末端）：粗筛
   * 主实例完成轮 → fire-and-forget 演进（快进快出——LLM 调用全部异步，
   * 不阻塞 fan-out 全序与后续目标）。progress 批：interrupted 轮也进（被打断
   * 也是进展信息）——计数面一律 ++，产物面 evolve 内分流（topic 只认 done
   * 锚点，行为不变；progress 按 everyTurns 锚点判定）。
   */
  onDomainEvent(event: DomainEvent): void {
    if (event.type !== "turn.completed") return;
    const payload = event.payload as { reason?: string };
    if (payload.reason !== "done" && payload.reason !== "interrupted") return;
    const sessionId = event.sessionId;
    this.progressCount.set(sessionId, (this.progressCount.get(sessionId) ?? 0) + 1);
    void this.evolve(sessionId, payload.reason === "done" ? "done" : "interrupted").catch((err: unknown) => {
      this.deps.logger?.warn(`会话轮末摘要失败（${sessionId}）：${(err as Error).message}`);
    });
  }

  /** 锚点演进主流程（纯副作用编排；全失败面静默降级保留旧 topic/零 progress 写入）。 */
  private async evolve(sessionId: string, trigger: "done" | "interrupted"): Promise<void> {
    const config = this.deps.readConfig();
    const sm = this.deps.sessionMemory?.read() ?? { enabled: false, model: null, everyTurns: 3 };
    if (!config.enabled && !sm.enabled) return;
    if (this.inFlight.has(sessionId)) return;
    const target = this.deps.resolveTarget(sessionId);
    if (target === undefined) return;

    // 产物意图判定：topic = done-only + topic_config 开 + 显式标题未锁定 + 轮锚点；
    // progress = sessionMemory 开 ∧ 模型显式已配（无默认纪律）∧ 独立计数锚点。
    const topicWanted =
      trigger === "done" && config.enabled && target.title === undefined && isAnchorTurn(target.turnCount);
    const everyTurns = sm.everyTurns > 0 ? sm.everyTurns : 3;
    const count = this.progressCount.get(sessionId) ?? 0;
    const progressWanted =
      sm.enabled && (sm.model ?? "") !== "" && this.deps.progressStore !== undefined && (count === 1 || count % everyTurns === 0);
    if (!topicWanted && !progressWanted) return;

    this.inFlight.add(sessionId);
    try {
      const displayTitle = target.topic ?? deriveTitle(target.firstUserText);
      const joint = topicWanted && progressWanted;
      const progressOnly = !topicWanted && progressWanted;

      // 纯 topic 模式：判官短路保留（联合模式跳过——见 deps.judge 注释）
      let driftJudged = false;
      if (topicWanted && !progressWanted) {
        const firstNaming = target.topic === undefined;
        driftJudged =
          !firstNaming && (config.classifyEndpointId ?? "") !== "" && this.deps.judge !== undefined;
        if (driftJudged) {
          const { state, question } = buildDriftJudgeInput({ displayTitle, recentUserTexts: target.recentUserTexts });
          const probability = await this.deps.judge!.noul(state, question);
          if (probability < TOPIC_DRIFT_THRESHOLD) return; // 未漂移短路（省生成调用）
        }
      }

      const response = await this.deps.llm.complete({
        systemPrompt: joint || progressOnly ? JOINT_SUMMARY_SYSTEM_PROMPT : TOPIC_SYSTEM_PROMPT,
        messages: [
          {
            role: "user",
            text:
              joint || progressOnly
                ? buildJointPrompt({
                    displayTitle,
                    recentTurnPairs: target.recentTurnPairs ?? recentUserTextsToPairs(target.recentUserTexts),
                    wantTopic: topicWanted,
                  })
                : buildTopicPrompt({
                    displayTitle,
                    recentUserTexts: target.recentUserTexts,
                    firstAssistantText: target.firstAssistantText,
                    skipJudge: driftJudged || target.topic === undefined,
                  }),
          },
        ],
        tools: [],
      });
      if (response.kind !== "blocks") return; // aborted 非产出面——降级过掉
      const raw = stewardBlocksText(response.blocks);

      if (joint || progressOnly) {
        // JSON 联合协议：烂输出整体丢弃（下个锚点幂等重试——零半产物写入）
        const parsed = parseJointSummary(raw);
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
      } else {
        // 纯 topic 旧文本协议（零回归路径）
        const topic = cleanTopicText(raw);
        if (topic === null || topic === displayTitle) return;
        target.updateTopic(topic, displayTitle, target.turnCount);
        this.deps.announceTopicChanged(sessionId);
      }
    } catch (err: unknown) {
      // 失败降级：保留旧 topic / 零 progress 写入，静默过掉——下个锚点自然重试（零重试轰炸）
      this.deps.logger?.warn(`会话轮末摘要降级（${sessionId}）：${(err as Error).message}`);
    } finally {
      this.inFlight.delete(sessionId);
    }
  }
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
