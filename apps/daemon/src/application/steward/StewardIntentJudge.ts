/**
 * StewardIntentJudge —— 管家意图判别判定面（M3-a 批：判官第五消费面）。
 *
 * 确认口令的判官泛化层（三级漏斗第二级：词表 0ms → 判官 ~百ms → LLM 秒级）：
 * - 触发面（范围钳制）：**词表未命中 ∧ pending 卡在场**时才触发——无卡零
 *   判官调用（不判闲聊）；词表命中零判官调用（第一级优先）；
 * - 判定面：noul 三问并发（确认/取消/修正），阈值 ≥0.5（E-250 同款校准
 *   概率阈值）；优先级 revise > cancel > confirm（修正最具体、确认最泛化
 *   ——同高取更具体意图，防「好的，改成 B」误执行旧卡）；
 * - 降级链（E-250 同款纪律）：开关关（默认态零日志）/端点未配失效（WARN）/
 *   判官抛错（WARN 不重试）→ 回退词表后行为（原样走 LLM），零劣化；
 * - 配置面：**与管家分诊判官共享同一开关与端点**（steward.triage.judge*
 *   两键 + resolveTriageJudgeRecord 单源——E-263「判官判定」一个开关管
 *   全部管家判官判定，本批零新增配置面零 UI）。
 *
 * 判官真体经组合根 makeJudgeAdapter 构造（E-199 注册表唯一姿势——本模块
 * 不直 new 适配器不 import driven 面；防腐：判定域只依赖 JudgePort.noul）。
 */
import type { RuntimeConfigPort } from "../ports/outbound/RuntimeConfigPort";
import type { JudgePort } from "../ports/outbound/JudgePort";
import type { EmbeddingEndpointRecord } from "../embedding/EmbeddingConfigService";
import { resolveTriageJudgeRecord, STEWARD_TRIAGE_JUDGE_ENABLED_KEY } from "./StewardTriageJudge";

/** 意图判官阈值（noul 校准概率 ≥ 此值 = 命中该意图——E-250 记忆查重/详略 0.5 同款）。 */
export const STEWARD_INTENT_JUDGE_THRESHOLD = 0.5;

/** 判官问句（单源常量——测试直引防措辞漂移；判官 fake 按关键词分流）。 */
export const STEWARD_INTENT_JUDGE_CONFIRM_QUESTION =
  "用户这句话是在确认执行刚才那个待确认的操作吗？（明确同意、催促执行、示意可以动手 = 是；提出新要求、改内容、无关话题 = 不是）";

export const STEWARD_INTENT_JUDGE_CANCEL_QUESTION =
  "用户这句话是在取消或放弃刚才那个待确认的操作吗？（明确反悔、不要了、改主意、叫停 = 是；确认执行、提新要求 = 不是）";

export const STEWARD_INTENT_JUDGE_REVISE_QUESTION =
  "用户这句话是在修正或补充刚才那个待确认的操作吗？（改目标、改内容、补充细节、换个对象 = 是；单纯确认或取消、完全无关的新话题 = 不是）";

/** 意图判别结果（分流三态——confirm/cancel 复用口令路由执行面）。 */
export type StewardPendingIntent = "confirm" | "cancel" | "revise";

/**
 * 三问分数 → 意图分流（纯函数）：阈值门控严格优先级 revise > cancel >
 * confirm（安全偏置：confirm 是唯一不可逆的旧卡执行动作——任一更具体
 * 意图过阈值即优先，防「好的，改成 B」类双信号句误执行旧卡；分类器分数
 * 在阈值以上的相对高低是噪声，不作为分流依据）。越界值钳制 [0,1]、NaN
 * 视为 0（坏端点不炸分流——保守回退无关新任务）。
 */
export function pickIntentByScores(revise: number, cancel: number, confirm: number): StewardPendingIntent | undefined {
  const clamp = (v: number) => (Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0);
  if (clamp(revise) >= STEWARD_INTENT_JUDGE_THRESHOLD) return "revise";
  if (clamp(cancel) >= STEWARD_INTENT_JUDGE_THRESHOLD) return "cancel";
  if (clamp(confirm) >= STEWARD_INTENT_JUDGE_THRESHOLD) return "confirm";
  return undefined; // 三问皆低：无关新任务 → 原样走 LLM
}

/** 判官 state 组装（纯函数——noul 第一参：待确认卡全文上下文 + 用户这句话）。 */
export function buildIntentJudgeState(cardTarget: string, cardMessage: string, userText: string): string {
  return [
    `待确认操作目标：${cardTarget}`,
    `待确认操作内容：${cardMessage}`,
    `用户这句话：${userText}`,
  ].join("\n");
}

/** 修正轮 LLM 输入组装（纯函数——一次 LLM 带卡全文上下文：原提案 + 用户新输入）。 */
export function buildIntentReviseAskText(cardTarget: string, cardMessage: string, userText: string): string {
  return [
    "（系统注：用户否决/修正了下面这条待确认提案。请结合用户这句话按修正后的意图重新提案；若用户这句话与该提案无关，按正常新指令处理。）",
    `原待确认提案（目标：${cardTarget}）：`,
    cardMessage,
    `用户这句话：${userText}`,
  ].join("\n");
}

/**
 * 意图判官判定面窄接口（StewardService 判定依赖）：enabled/ready 两级读面
 * 供降级链分级（开关关 = 默认态零日志回退；开关开但端点未配/失效 = WARN
 * 提醒回退——E-250 可观测性分级同款）。
 */
export interface IntentJudgeFace {
  /** 判官开关读面（与分诊判官共享 KV steward.triage.judgeEnabled === "1"）。 */
  enabled(): boolean;
  /** 判定面就绪（开关开 ∧ 端点有效 classifier——resolveTriageJudgeRecord 单源）。 */
  ready(): boolean;
  /** noul 校准概率判定（透传注入的判官面；抛错由消费方捕获降级）。 */
  noul(state: string, question: string): Promise<number>;
}

export interface StewardIntentJudgeDeps {
  readonly config: RuntimeConfigPort;
  /** embedding 配置域查询面（endpointId → 端点条目——与分诊判官同源单点）。 */
  readonly embeddingConfig: { resolveRecord(endpointId: string): EmbeddingEndpointRecord | null };
  /** 判官 noul 面（组合根注入 makeJudgeAdapter(resolve, judgeServices) 真体——
   *  E-199 注册表分派，换端点/换变体零重启跟随；Pick 窄注入）。 */
  readonly judge: Pick<JudgePort, "noul">;
}

export function makeIntentJudgeFace(deps: StewardIntentJudgeDeps): IntentJudgeFace {
  return {
    enabled: () => deps.config.get(STEWARD_TRIAGE_JUDGE_ENABLED_KEY) === "1",
    ready: () =>
      deps.config.get(STEWARD_TRIAGE_JUDGE_ENABLED_KEY) === "1" &&
      resolveTriageJudgeRecord(deps.config, deps.embeddingConfig) !== null,
    noul: (state, question) => deps.judge.noul(state, question),
  };
}
