/**
 * StewardTriageJudge —— 管家分诊判官配置与判定面（管家分诊判官接入批）。
 *
 * 分诊判定面的判官域收口（E-199 JudgeAdapterFactory 第四消费面）：
 * - 配置面：steward.triage.judgeEnabled（bool，缺省 false）+
 *   judgeEndpointId（string，指向 embedding 域 kind=classifier 端点；空串 =
 *   清除引用）——经 steward.set_config {triage} 组写入（E-263 先例：管家卡
 *   {model} / 记忆 {memory} 转发同款形态）；
 * - 端点解析单源：resolveTriageJudgeRecord 纯函数（KV id → embedding 域记录；
 *   未配/悬空/非 classifier → null——端点被删后读面视为未配，UI 显示「未
 *   选择」；kind 校验防判官与向量端点串用，与管家记忆判官闭包同款）；
 * - 判定面：noul 透传注入的判官面（组合根经 makeJudgeAdapter 构造——注册表
 *   唯一姿势，本模块不直 new 适配器，也不 import driven 面——防腐：判定域
 *   只依赖 JudgePort.noul 契约）。
 *
 * 降级语义归 StewardPerceptionService（E-214 先例：判官缺席/抛错 → 回退保守
 *   路径不挡主链路）：本模块只报状态（enabled/ready），不做降级决策。
 */
import type { RuntimeConfigPort } from "../ports/outbound/RuntimeConfigPort";
import type { JudgePort } from "../ports/outbound/JudgePort";
import type { EmbeddingEndpointRecord } from "../embedding/EmbeddingConfigService";

/** 分诊判官开关 KV 键（缺省 false——判官是可选增强，关闭回退现行 LLM 路径）。 */
export const STEWARD_TRIAGE_JUDGE_ENABLED_KEY = "steward.triage.judgeEnabled";

/** 分诊判官端点引用 KV 键（指向 embedding 域 kind=classifier 端点；空串 = 未配）。 */
export const STEWARD_TRIAGE_JUDGE_ENDPOINT_ID_KEY = "steward.triage.judgeEndpointId";

/** 配置面导出现态（凭据卫生：judgeEndpoint 只回 id/name/model/hasApiKey）。 */
export interface TriageJudgeState {
  /** 判官开关现态（默认 false）。 */
  readonly judgeEnabled: boolean;
  /** 当前判官端点引用（引用态；未引用/悬空/非 classifier = null——读面视为未配）。 */
  readonly judgeEndpoint: { readonly id: string; readonly name: string; readonly model: string; readonly hasApiKey: boolean } | null;
}

/**
 * 分诊判官判定面窄接口（StewardPerceptionService 判定依赖）：
 * enabled/ready 两级读面供降级链分级（开关关 = 默认态零日志回退；开关开但
 * 端点未配/失效 = WARN 提醒回退——可观测性分级）。
 */
export interface TriageJudgeFace {
  /** 判官开关读面（KV steward.triage.judgeEnabled === "1"）。 */
  enabled(): boolean;
  /** 判定面就绪（开关开 ∧ 端点有效 classifier）。 */
  ready(): boolean;
  /** noul 校准概率判定（透传注入的判官面；抛错由感知服务捕获降级）。 */
  noul(state: string, question: string): Promise<number>;
  /** 配置面现态（steward.config.result triage 组数据源）。 */
  state(): TriageJudgeState;
  /** 配置写面（steward.set_config {triage} 组——空串 judgeEndpointId = 清除引用）。 */
  setConfig(patch: { judgeEnabled?: boolean; judgeEndpointId?: string }): Promise<{ ok: true } | { ok: false; error: string }>;
}

/**
 * 端点记录解析（单源纯函数——face 与组合根判官闭包共用）：
 * judgeEndpointId 未设/空串 → null；条目已删 → null（读面视为未配）；
 * kind ≠ classifier → null（判官与向量端点不串用）。
 */
export function resolveTriageJudgeRecord(
  config: RuntimeConfigPort,
  embeddingConfig: { resolveRecord(endpointId: string): EmbeddingEndpointRecord | null },
): EmbeddingEndpointRecord | null {
  const endpointId = config.get(STEWARD_TRIAGE_JUDGE_ENDPOINT_ID_KEY);
  if (endpointId === undefined || endpointId === "") return null;
  const record = embeddingConfig.resolveRecord(endpointId);
  if (record === null || record.kind !== "classifier") return null;
  return record;
}

export interface StewardTriageJudgeDeps {
  readonly config: RuntimeConfigPort;
  /** embedding 配置域查询面（endpointId → 端点条目）。 */
  readonly embeddingConfig: { resolveRecord(endpointId: string): EmbeddingEndpointRecord | null };
  /** 判官 noul 面（组合根注入 makeJudgeAdapter(resolve, judgeServices) 真体——
   *  E-199 注册表分派，换端点/换变体零重启跟随）。 */
  readonly judge: Pick<JudgePort, "noul">;
}

export function makeTriageJudgeFace(deps: StewardTriageJudgeDeps): TriageJudgeFace {
  return {
    enabled: () => deps.config.get(STEWARD_TRIAGE_JUDGE_ENABLED_KEY) === "1",
    ready: () => deps.config.get(STEWARD_TRIAGE_JUDGE_ENABLED_KEY) === "1" && resolveTriageJudgeRecord(deps.config, deps.embeddingConfig) !== null,
    noul: (state, question) => deps.judge.noul(state, question),
    state: () => {
      const record = resolveTriageJudgeRecord(deps.config, deps.embeddingConfig);
      return {
        judgeEnabled: deps.config.get(STEWARD_TRIAGE_JUDGE_ENABLED_KEY) === "1",
        judgeEndpoint:
          record === null
            ? null
            : { id: record.id, name: record.name, model: record.model, hasApiKey: record.apiKey !== undefined },
      };
    },
    setConfig: async (patch) => {
      if (patch.judgeEndpointId !== undefined) {
        // 空串 = 清除引用（显式解绑）；悬空引用由读面自然降级（无前置校验——
        // 与记忆端点同款：先开后配是合法路径）
        await deps.config.set(STEWARD_TRIAGE_JUDGE_ENDPOINT_ID_KEY, patch.judgeEndpointId);
      }
      if (patch.judgeEnabled !== undefined) {
        await deps.config.set(STEWARD_TRIAGE_JUDGE_ENABLED_KEY, patch.judgeEnabled ? "1" : "0");
      }
      return { ok: true };
    },
  };
}
