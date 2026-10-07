/**
 * 出站端口（outbound，管家感知批 M0.5：分诊器 LLM 面）。
 *
 * 任务终态「一次调用双轨产物」的分诊面抽象（设计 D12-⑨/⑩）：一次有界
 * LLM 调用同时产出摄入轨（管家分析用结构化详录）与呈现轨（≤60 字口语
 * ——语音播报与 steward.notify toast 同源同判断）。归一取代原 E-232 ③层
 * 独立摘要调用（BroadcastService 不再自持 LLM 面——内容生产归管家分诊器，
 * 播报只管播，职责分离裁决延续）。
 *
 * 实现体 = adapters/driven/voice/StewardDiagnosisAdapter（复用管家
 * StewardLlmPort 真体：模型槽位 summary.task.model 无默认 + key 同源
 * auth.json——③层摘要专用槽位沿用，独立 PiStewardLlmAdapter 实例先例）。
 *
 * 端口形状与 StewardLlmPort 分立（AG-01 同构纪律：域间不共享 port 类型，
 * 防腐归 adapter）；与 VoiceSummarizerPort 分立（单轨文本 → 双轨 JSON
 * 判别，语义升格非扩展）。
 */

/** 分诊请求（prompt 全文进 systemPrompt + userPrompt 两段——输入素材归
 *  StewardPerceptionService 构造：ring buffer 现场投影 + 终态事实）。 */
export interface StewardDiagnosisPrompt {
  /** 分诊角色指令（双轨协议/派生关系约束——StewardPerceptionService 单点常量）。 */
  readonly systemPrompt: string;
  /** 终态事实与现场素材（任务/实例标识 + ring buffer 批次 closure 投影）。 */
  readonly userPrompt: string;
}

/** 接续提案（呈现轨建议按钮——点按才动，写类动作仍过确认闸）。 */
export interface StewardDiagnosisSuggestion {
  /** 按钮文案（人读短句）。 */
  readonly label: string;
}

/** 分诊产物（一次调用双轨）：摄入轨供分析/记忆/追问，呈现轨供语音与
 *  notify 同源投递；呈现内容须在摄入轨有支撑（prompt 派生关系约束）。 */
export interface StewardDiagnosisResult {
  /** 是否值得打扰用户（false = 静默——「可判不打扰而静默」，D12-⑨）。 */
  readonly notify: boolean;
  /** 紧急度：normal = 常规（限流 ≤4 条/小时）；high = 门控高危（豁免限流）。 */
  readonly urgency: "normal" | "high";
  /** 呈现轨：≤60 字口语（语音播报与 steward.notify body 同源）。 */
  readonly present: string;
  /** 摄入轨：结构化全面详录（做了什么/改动面/发现统计/阻塞/下一步，
   *  ~2000 字级——只进 ring buffer 工作记录，不进长期记忆）。 */
  readonly ingest: string;
  /** 接续提案（完成只是事实，接续才是价值——开修复/投递下一会话/跳报告）。 */
  readonly suggestions: readonly StewardDiagnosisSuggestion[];
}

export interface StewardDiagnosisPort {
  /**
   * 分诊面可用性读面：false = 零 LLM 降级（管家关 / 总结开关关 / 模型
   * 槽位未配——三条件 gate 沿用 E-232 语义）= **未启用**（money gate+模型
   * 配，v2.9 D12-⑫：LLM 门槛=启用，启用态分诊恒做）；激活判定不在此处，
   * 归 StewardPerceptionService 单点（投递面判据）。
   */
  isAvailable(): boolean;
  /**
   * 一次分诊调用：resolve 双轨产物；失败/超时 throw（降级决策归
   * StewardPerceptionService——静默跳过不播半产物）。
   */
  diagnose(prompt: StewardDiagnosisPrompt): Promise<StewardDiagnosisResult>;
}
