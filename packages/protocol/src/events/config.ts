import type { EventFrame } from "../envelope";

/**
 * config 族命令结果帧（全局命令，无会话归属；点对点回执）。
 *
 * set 回执形状规约：**新增 set 回执一律平铺生效态**——回执字段即写入后的
 * 生效值（compaction / scheduling / port / sandbox / kg 先例，所见即所得）。
 * `{ state: ... }` 包裹为存量例外（config.set_summary /
 * config.set_voice_models 两族：get/set 共用同一状态载荷而加包裹层），不改造、
 * 不作新命令范例。例外清单以本文件的 set 载荷类型为准（勿按注释枚举）。
 */

/** config.get_compaction.result：压缩参数读面回执（点对点；全局命令） */
export interface ConfigGetCompactionResultPayload {
  reserveTokens: number;
  keepRecentTokens: number;
}
export interface ConfigGetCompactionResultEvent extends EventFrame<ConfigGetCompactionResultPayload> {
  channel?: "model";
  type: "config.get_compaction.result";
}

/** config.set_compaction.result：压缩参数写回执（点对点；全局命令） */
export interface ConfigSetCompactionResultPayload {
  reserveTokens: number;
  keepRecentTokens: number;
}
export interface ConfigSetCompactionResultEvent extends EventFrame<ConfigSetCompactionResultPayload> {
  channel?: "model";
  type: "config.set_compaction.result";
}

/** config.get_scheduling.result：SubAgent 调度预算读面回执（点对点；全局命令） */
export interface ConfigGetSchedulingResultPayload {
  maxConcurrent: number;
  maxQueued: number;
}
export interface ConfigGetSchedulingResultEvent extends EventFrame<ConfigGetSchedulingResultPayload> {
  channel?: "model";
  type: "config.get_scheduling.result";
}

/** config.set_scheduling.result：调度预算写回执（点对点；全局命令） */
export interface ConfigSetSchedulingResultPayload {
  maxConcurrent: number;
  maxQueued: number;
}
export interface ConfigSetSchedulingResultEvent extends EventFrame<ConfigSetSchedulingResultPayload> {
  channel?: "model";
  type: "config.set_scheduling.result";
}

/** config.get_port.result：WS 端口读面回执（点对点；全局命令） */
export interface ConfigGetPortResultPayload {
  /** 当前监听端口（本次运行实际值——argv 覆盖时为 argv 值）。 */
  effectivePort: number;
  /** 存储端口（runtime_config daemon_port；重启后生效值）。 */
  storedPort: number | null;
  /** 本次运行是否经 argv --port 显式覆盖（true 时改存储不影响本次）。 */
  overriddenByArgv: boolean;
}
export interface ConfigGetPortResultEvent extends EventFrame<ConfigGetPortResultPayload> {
  channel?: "model";
  type: "config.get_port.result";
}

/** config.set_port.result：WS 端口写回执（点对点；重启生效提示在 UI 层）。 */
export interface ConfigSetPortResultPayload {
  port: number;
}
export interface ConfigSetPortResultEvent extends EventFrame<ConfigSetPortResultPayload> {
  channel?: "model";
  type: "config.set_port.result";
}

/** config.get_sandbox.result：沙箱开关读面回执（点对点；全局命令）。 */
export interface ConfigGetSandboxResultPayload {
  enabled: boolean;
  /** 额外可写根全局清单（缺省 []）。 */
  extraRoots: string[];
  /** 提权申请自动通过生效值（permission_request 免弹卡自动批准；缺省 false）。 */
  autoApprove: boolean;
}
export interface ConfigGetSandboxResultEvent extends EventFrame<ConfigGetSandboxResultPayload> {
  channel?: "model";
  type: "config.get_sandbox.result";
}

/** config.set_sandbox.result：沙箱开关写回执（点对点；生效时机提示在 UI 层）。 */
export interface ConfigSetSandboxResultPayload {
  enabled: boolean;
  /** 额外可写根全局清单（合并写后的全量现值）。 */
  extraRoots: string[];
  /** 提权申请自动通过（合并写后的全量现值）。 */
  autoApprove: boolean;
}
export interface ConfigSetSandboxResultEvent extends EventFrame<ConfigSetSandboxResultPayload> {
  channel?: "model";
  type: "config.set_sandbox.result";
}

// ── config.kg 族（批2 WP-C「知识库」配置组——查重阈值） ──

/**
 * config.get_kg / config.set_kg 回执同形载荷（查重阈值对 + 语义召回对——
 * 读面裁决后的真实取数口径，非法/颠倒已回退缺省，所见即所得；KV kg.*
 * 为底层存储单源）。
 */
export interface KgConfigStatePayload {
  /** 查重软警告阈值生效值（+similarTo 连线触发线；缺省 0.80）。 */
  similarityWarn: number;
  /** 疑似重复阈值生效值（+自动候选触发线；缺省 0.92）。 */
  similarityDup: number;
  /** 语义召回轨 top-K 生效值（缺省 5；检索语义化批 additive）。 */
  semanticTopK: number;
  /** 语义召回最低相似度生效值（缺省 0.35；检索语义化批 additive）。 */
  semanticMinScore: number;
}
export interface ConfigGetKgResultEvent extends EventFrame<KgConfigStatePayload> {
  channel?: "model";
  type: "config.get_kg.result";
}
export interface ConfigSetKgResultEvent extends EventFrame<KgConfigStatePayload> {
  channel?: "model";
  type: "config.set_kg.result";
}

// ── config.summary 族（会话总结器独立化批①；总结配置组，全局命令）──

/**
 * config.get_summary / config.set_summary 回执同形载荷（get = 现态读面；
 * set = 校验通过写入后的新现态回读）。总结配置组独立收口于 summary.* 通用域
 * （memory.* 同构形态）；steward.config.result 同形回显本组（只读观测面）。
 */
export interface SummaryConfigStatePayload {
  /** 三产物总开关（标题/进展/记忆点）。 */
  enabled: boolean;
  /** 锚点轮次间隔生效值（1-20；非法 KV 回显读面兜底值——所见即所得）。 */
  everyTurns: number;
  /** 总结模型槽位（"provider/model-id"；未配置 = null——无默认纪律）。 */
  model: string | null;
  /** 任务总结子功能现态（语音播报摘要 + 感知分诊 gate）。 */
  task: {
    /** 任务总结开关现态（默认 false）。 */
    enabled: boolean;
    /** 任务总结模型槽位现值（未配置 = null——无默认模型）。 */
    model: string | null;
  };
}
export interface ConfigGetSummaryResultEvent extends EventFrame<SummaryConfigStatePayload> {
  channel?: "model";
  type: "config.get_summary.result";
}
export interface ConfigSetSummaryResultPayload {
  /** 写入后的新现态（与 get 同形）。 */
  state: SummaryConfigStatePayload;
}
export interface ConfigSetSummaryResultEvent extends EventFrame<ConfigSetSummaryResultPayload> {
  channel?: "model";
  type: "config.set_summary.result";
}

// ── config.voice_models 族（ASR/TTS 模型配置接入 P0；语音模型槽位）──

/**
 * config.get_voice_models / config.set_voice_models 回执同形载荷（get = 现态
 * 读面；set = 校验通过写入后的新现态回读）。5 个语音模型槽位全量生效态
 *（所见即所得，含默认值填充）；空串写入 = 回落默认值。
 */
export interface VoiceModelConfigStatePayload {
  /** STT 一次性转写 · DashScope 模型 id（默认 qwen-audio-3.0-asr-flash）。 */
  sttModel: string;
  /** STT 一次性转写 · SiliconFlow 模型 id（默认 FunAudioLLM/SenseVoiceSmall）。 */
  sttSiliconflowModel: string;
  /** STT 流式转写 · DashScope realtime 模型 id（默认 qwen3-asr-flash-realtime）。 */
  sttRealtimeModel: string;
  /** TTS 一次性合成 · DashScope 模型 id（默认 qwen3-tts-flash）。 */
  ttsModel: string;
  /** TTS 流式合成 · DashScope 模型 id（默认 qwen-audio-3.0-tts-flash）。 */
  ttsStreamModel: string;
}
export interface ConfigGetVoiceModelsResultEvent extends EventFrame<VoiceModelConfigStatePayload> {
  channel?: "model";
  type: "config.get_voice_models.result";
}
export interface ConfigSetVoiceModelsResultPayload {
  /** 写入后的新现态（与 get 同形）。 */
  state: VoiceModelConfigStatePayload;
}
export interface ConfigSetVoiceModelsResultEvent extends EventFrame<ConfigSetVoiceModelsResultPayload> {
  channel?: "model";
  type: "config.set_voice_models.result";
}
