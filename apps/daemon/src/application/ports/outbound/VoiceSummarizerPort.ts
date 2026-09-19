/**
 * 出站端口（outbound，语音播报批 ③层 LLM 摘要）。
 *
 * BroadcastService 的 LLM 摘要面抽象：单轮补全（播报 prompt 全文由
 * application 层构建——长度/口语化指令是播报域语义，归 service 单点）→
 * 白话播报稿文本。实现体 = adapters/driven/voice/StewardVoiceSummarizerAdapter
 * （复用管家 StewardLlmPort 真体：模型槽位/key/模型解析全同源 steward 配置
 * 面——「复用管家配置的模型」的落地点，播报域不另建模型槽位）。
 *
 * 端口形状与 StewardLlmPort 分立（voice 域自有窄面，无 tools/无会话史——
 * 摘要是单发无状态调用；AG-01 同构纪律：域间不共享 port 类型，防腐归 adapter）。
 */

/** 单轮摘要请求（prompt 全文进 systemPrompt + userPrompt 两段）。 */
export interface VoiceSummaryPrompt {
  /** 播报摘要角色指令（长度/口语化约束——BroadcastService 单点常量）。 */
  readonly systemPrompt: string;
  /** 终态事件事实（事件类型/agentId/closure 摘要/error 原文）。 */
  readonly userPrompt: string;
}

export interface VoiceSummarizerPort {
  /**
   * 摘要面可用性读面：false = 服务层走②层模板直出（零 LLM 调用——
   * 管家开关关 / 模型槽位未配置的回退 gate）。
   */
  isAvailable(): boolean;
  /**
   * 单轮摘要补全：resolve 白话播报稿文本；失败/超时 throw（回退决策归
   * BroadcastService——播报不哑，降级不丢功能）。
   */
  complete(prompt: VoiceSummaryPrompt): Promise<string>;
}
