/** 全局配置域命令族：model.* / config.* / auth.* / thinking.set（全局命令，信封 sessionId 省略）。 */
import type { CommandFrame } from "../envelope";
import type {
  AuthListResultPayload,
  AuthSetKeyResultPayload,
  AuthVerifyResultPayload,
  ModelCatalogResultPayload,
  ModelGetDefaultResultPayload,
  ModelGetResultPayload,
  ModelSetDefaultResultPayload,
} from "../events/model";
import type { EmptyPayload } from "./session";

// ── v0.2 新增：model 族（契约 C §1；AD-2，G-6 定名） ──

/** model.set 载荷：运行期切换（P-3，F(3.3).2）——信封 sessionId 必填（per-session），下一 turn 生效 */
export interface ModelSetPayload {
  /** "provider/model-id" 完整 id */
  model: string;
}
export interface ModelSetCommand extends CommandFrame<ModelSetPayload> {
  type: "model.set";
}

/**
 * model.get 结果载荷（与 events/model.ts ModelGetResultPayload 同形双定义
 * 收敛为别名——SessionListResult 同规先例：权威位 = 事件线载荷，本名为
 * 兼容别名，协议面 additive 纪律 TR-AD-18 不删导出名）。
 */
export type ModelGetResult = ModelGetResultPayload;

/** model.get 载荷：信封 sessionId 必填（per-session） */
export interface ModelGetCommand extends CommandFrame<EmptyPayload> {
  type: "model.get";
}

/** 目录结果载荷（model.catalog / model.catalog_refresh 共用；事件线载荷别名，同 ModelGetResult 收敛先例） */
export type ModelCatalogResult = ModelCatalogResultPayload;

/** model.catalog 载荷：全局命令（4h 缓存口径，T2.3 落地） */
export interface ModelCatalogCommand extends CommandFrame<EmptyPayload> {
  type: "model.catalog";
}

/** model.catalog_refresh 载荷：绕过 4h 缓存强制拉 pi.dev（失败降级 builtin，响应含说明） */
export interface ModelCatalogRefreshCommand extends CommandFrame<EmptyPayload> {
  type: "model.catalog_refresh";
}

/** model.set_default 结果载荷（事件线载荷别名，同 ModelGetResult 收敛先例） */
export type ModelSetDefaultResult = ModelSetDefaultResultPayload;

/** model.set_default 载荷：全局默认值（无信封 sessionId；SQLite 读面，T2.3 落地） */
export interface ModelSetDefaultPayload {
  model: string;
}
export interface ModelSetDefaultCommand extends CommandFrame<ModelSetDefaultPayload> {
  type: "model.set_default";
}

/**
 * model.set_thinking_default 载荷（R7 全局推理强度兜底批）：全局默认推理
 * 强度——level = 档位字符串透传（pi-ai ThinkingLevel，AD-2）；null = 清除
 *（回退未配置态：各 agent 未配槽位 → 默认关）。与 model.set_default 同构
 *（全局命令，无信封 sessionId；runtime_config 单键存储）。
 */
export interface ModelSetThinkingDefaultPayload {
  level: string | null;
}
export interface ModelSetThinkingDefaultCommand extends CommandFrame<ModelSetThinkingDefaultPayload> {
  type: "model.set_thinking_default";
}

/**
 * model.get_default 结果载荷（事件线载荷别名，同 ModelGetResult 收敛先例——
 * 别名化同时修复双定义漂移：本地旧定义缺 thinkingDefault，权威形以
 * ModelGetDefaultResultPayload 为准）。
 */
export type ModelGetDefaultResult = ModelGetDefaultResultPayload;

/** model.get_default 载荷：全局命令 */
export interface ModelGetDefaultCommand extends CommandFrame<EmptyPayload> {
  type: "model.get_default";
}

// ── config 族（压缩参数配置；全局命令，无信封 sessionId；runtime_config 单键 JSON） ──

/** config.set_compaction 载荷：压缩参数（token 绝对值）。 */
export interface ConfigSetCompactionPayload {
  reserveTokens: number;
  keepRecentTokens: number;
}
export interface ConfigSetCompactionCommand extends CommandFrame<ConfigSetCompactionPayload> {
  type: "config.set_compaction";
}

/** config.get_compaction 载荷：全局命令。 */
export interface ConfigGetCompactionCommand extends CommandFrame<EmptyPayload> {
  type: "config.get_compaction";
}

/** config.set_scheduling 载荷：SubAgent 调度预算（运行期可调——下一次预算判定生效）。 */
export interface ConfigSetSchedulingPayload {
  maxConcurrent: number;
  maxQueued: number;
}
export interface ConfigSetSchedulingCommand extends CommandFrame<ConfigSetSchedulingPayload> {
  type: "config.set_scheduling";
}

/** config.get_scheduling 载荷：全局命令。 */
export interface ConfigGetSchedulingCommand extends CommandFrame<EmptyPayload> {
  type: "config.get_scheduling";
}

/** config.set_port 载荷：WS 监听端口（重启生效；argv --port 本次运行优先）。 */
export interface ConfigSetPortPayload {
  port: number;
}
export interface ConfigSetPortCommand extends CommandFrame<ConfigSetPortPayload> {
  type: "config.set_port";
}

/** config.get_port 载荷：全局命令。 */
export interface ConfigGetPortCommand extends CommandFrame<EmptyPayload> {
  type: "config.get_port";
}

/** config.set_sandbox 载荷：沙箱配置（enabled/extraRoots 新会话/新任务生效——装配期定格读取；
 * autoApprove 运行期即热——每次提权申请现值判定）。
 * 部分更新语义：enabled/extraRoots/autoApprove 任选至少一项，未携带项保留现值。 */
export interface ConfigSetSandboxPayload {
  enabled?: boolean;
  /** 额外可写根（全局清单，绝对路径；工具链/环境目录逃生门）。 */
  extraRoots?: string[];
  /** 提权申请自动通过（permission_request 免弹卡确认自动批准；仅该 kind 生效，缺省 false）。 */
  autoApprove?: boolean;
}
export interface ConfigSetSandboxCommand extends CommandFrame<ConfigSetSandboxPayload> {
  type: "config.set_sandbox";
}

/** config.get_sandbox 载荷：全局命令。 */
export interface ConfigGetSandboxCommand extends CommandFrame<EmptyPayload> {
  type: "config.get_sandbox";
}

// ── config.kg 族（批2 WP-C「知识库」配置组——查重阈值；全局命令） ──

/**
 * config.set_kg 载荷：知识库配置（部分更新语义：携带项写入，未携带项保留
 * 现值；查重阈值 = kg.similarityWarn / kg.similarityDup，语义召回 =
 * kg.semanticTopK / kg.semanticMinScore）。查重阈值值域 [0,1]、semanticTopK
 * 为正整数、semanticMinScore 值域 [0,1]——写面只做类型闸（有限数），值
 * 语义（非法/颠倒回退缺省）读面单点裁决（memoryConfig 哲学）；回执恒回
 * **生效值**（所见即所得）。后续 kg 新增可配置项落本组（D4 归宿纪律
 * ——「知识库」配置组是 kg 展面配置的归宿）。
 */
export interface ConfigSetKgPayload {
  /** 查重软警告阈值（+similarTo 连线触发线；缺省 0.80）。 */
  similarityWarn?: number;
  /** 疑似重复阈值（+自动疑似重复候选触发线；缺省 0.92）。 */
  similarityDup?: number;
  /** 语义召回轨 top-K（向量轨最多贡献命中数；缺省 5，合法整数 [1,50]——读面裁决）。 */
  semanticTopK?: number;
  /** 语义召回最低相似度（余弦；缺省 0.35，值域 [0,1]——读面裁决）。 */
  semanticMinScore?: number;
}
export interface ConfigSetKgCommand extends CommandFrame<ConfigSetKgPayload> {
  type: "config.set_kg";
}

/** config.get_kg 载荷：全局命令。 */
export interface ConfigGetKgCommand extends CommandFrame<EmptyPayload> {
  type: "config.get_kg";
}

// ── config.summary 族（会话总结器独立化批①；总结配置组独立收口）──

/**
 * config.set_summary 载荷：总结配置（部分更新语义：携带项写入，未携带项
 * 保留现值）。总结是平台能力（标题 + 进展 + 记忆点三产物 + 任务总结子功能），
 * 配置收编 summary.* 通用域——管家配置零总结项（steward.set_config 已摘
 * summary/sessionMemory 组）。
 */
export interface ConfigSetSummaryPayload {
  /** 三产物总开关（标题/进展/记忆点——任务总结开关独立归 task.enabled）。 */
  enabled?: boolean;
  /** 锚点轮次间隔（合法 1-20 整数；非法回执 invalid_payload——写面类型闸，
   *  值语义读面单点兜底）。 */
  everyTurns?: number;
  /** 总结模型槽位（"provider/model-id"；空串/null = 清空回未配置态——显式配
   *  才产进展+记忆点（无默认纪律），标题回落链 summary.model → flash 默认）。 */
  model?: string | null;
  /** 任务总结子功能组（语音播报摘要 + 感知分诊 gate 共用；全部位可选）。 */
  task?: {
    /** 任务总结开关（默认关）。 */
    enabled?: boolean;
    /** 任务总结模型槽位（空串/null = 清空；**无默认模型**——未配 = 任务总结
     *  面不可用，回退极简终态通知）。 */
    model?: string | null;
  };
}
export interface ConfigSetSummaryCommand extends CommandFrame<ConfigSetSummaryPayload> {
  type: "config.set_summary";
}

/** config.get_summary 载荷：全局命令。 */
export interface ConfigGetSummaryCommand extends CommandFrame<EmptyPayload> {
  type: "config.get_summary";
}

// ── config.voice_models 族（ASR/TTS 模型配置接入 P0；语音模型槽位）──

/**
 * config.set_voice_models 载荷：ASR/TTS 模型配置（部分更新语义：携带项写入，
 * 未携带项保留现值；字段空串 = 回落默认值）。非 string 字段回执 invalid_payload。
 */
export interface ConfigSetVoiceModelsPayload {
  /** STT 一次性转写 · DashScope 模型 id。 */
  sttModel?: string;
  /** STT 一次性转写 · SiliconFlow 模型 id。 */
  sttSiliconflowModel?: string;
  /** STT 流式转写 · DashScope realtime 模型 id。 */
  sttRealtimeModel?: string;
  /** TTS 一次性合成 · DashScope 模型 id。 */
  ttsModel?: string;
  /** TTS 流式合成 · DashScope 模型 id。 */
  ttsStreamModel?: string;
}
export interface ConfigSetVoiceModelsCommand extends CommandFrame<ConfigSetVoiceModelsPayload> {
  type: "config.set_voice_models";
}

/** config.get_voice_models 载荷：全局命令。 */
export interface ConfigGetVoiceModelsCommand extends CommandFrame<EmptyPayload> {
  type: "config.get_voice_models";
}

/** 语音模型槽位五件（载荷字段名协议契约单源——daemon 驱动侧 import 白名单
 *  放行 @helix/protocol，字段遍历面从这里取）。 */
export const VOICE_MODEL_FIELDS = [
  "sttModel",
  "sttSiliconflowModel",
  "sttRealtimeModel",
  "ttsModel",
  "ttsStreamModel",
] as const;

// ── v0.2 新增：auth 管理族（契约 C §1.3；G-6 定名） ──

/** auth.list 结果载荷（事件线载荷别名，同 ModelGetResult 收敛先例） */
export type AuthListResult = AuthListResultPayload;

/** auth.list 载荷：全局命令 */
export interface AuthListCommand extends CommandFrame<EmptyPayload> {
  type: "auth.list";
}

/** auth.set_key 结果载荷（事件线载荷别名，同 ModelGetResult 收敛先例） */
export type AuthSetKeyResult = AuthSetKeyResultPayload;

/** auth.set_key 载荷：daemon 写 ~/.helix/auth.json（0600 + 文件锁）；空 apiKey = 协议层 error */
export interface AuthSetKeyPayload {
  providerId: string;
  apiKey: string;
}
export interface AuthSetKeyCommand extends CommandFrame<AuthSetKeyPayload> {
  type: "auth.set_key";
}

/** auth.delete_key 载荷 */
export interface AuthDeleteKeyPayload {
  providerId: string;
}
export interface AuthDeleteKeyCommand extends CommandFrame<AuthDeleteKeyPayload> {
  type: "auth.delete_key";
}

/** auth.verify 结果载荷：不缓存，每次真实请求（provider 最小请求探活）；事件线载荷别名，同 ModelGetResult 收敛先例 */
export type AuthVerifyResult = AuthVerifyResultPayload;

/** auth.verify 载荷 */
export interface AuthVerifyPayload {
  providerId: string;
}
export interface AuthVerifyCommand extends CommandFrame<AuthVerifyPayload> {
  type: "auth.verify";
}


// ── v0.11 新增：thinking 族（thinking 批 ①，iter-20260823-6ps5 T1.1；AD-2/AD-4，契约 = PROTOCOL-CHANGELOG.md §17.11） ──

/**
 * thinking.set 载荷：会话 thinking 档覆盖（P-1/F1.1）——信封 sessionId 必填
 *（per-session，仿 model.set（ModelSetPayload）形态），下一 turn 生效。level 为 pi-ai
 * ThinkingLevel 字符串透传（AD-2：helix 不维护第二份档位枚举，SoT 在 pi-ai，
 * 协议层不校验未知档位）；无关闭态（未覆盖 = 不发命令）。chat.send 零字段
 *（AD-4①：thinking 是会话状态非逐消息参数，引擎 turn 开始读解析结果）。
 * 生效回执 = thinking.changed 广播（events/thinking.ts）。
 */
export interface ThinkingSetPayload {
  /** pi-ai ThinkingLevel 字符串透传（如 "medium" / "high"；未知档位由引擎按能力过滤） */
  level: string;
}
export interface ThinkingSetCommand extends CommandFrame<ThinkingSetPayload> {
  type: "thinking.set";
}

