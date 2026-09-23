import type { EventFrame } from "../envelope";

// ── config 族命令结果帧（压缩参数配置；全局命令，无会话归属）──

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
}
export interface ConfigSetSandboxResultEvent extends EventFrame<ConfigSetSandboxResultPayload> {
  channel?: "model";
  type: "config.set_sandbox.result";
}

// ── config.topic 族（动态主题批；会话阶段演进主题配置，全局命令）──

/**
 * config.get_topic / config.set_topic 回执同形载荷（get = 现态读面；
 * set = 校验通过写入后的新现态回读）。分类判断恒开：classifyEndpointId
 * 选中分类模型 = 两段式（先判漂移再生成）；null = 由主题生成模型兼任判断。
 * judgeEndpoints 恒携带——设置页分类模型下拉数据源（可选项恒为已配置的
 * 分类端点，Jev 等按端点 variant 区分实现，UI 不感知具体实现）。
 */
export interface ConfigTopicStatePayload {
  /** 动态主题开关（默认关）。 */
  enabled: boolean;
  /** 主题生成模型（"provider/model-id"；null = 未配置，回退全局兜底模型）。 */
  model: string | null;
  /** 分类模型端点 id（embedding 配置域 kind=classifier 条目；null = 不选，
   *  生成模型兼任判断）。 */
  classifyEndpointId: string | null;
  /** 可选分类端点清单（id + 显示名；空数组 = 暂无可选分类模型）。 */
  judgeEndpoints: readonly ConfigTopicJudgeEndpoint[];
}
export interface ConfigTopicJudgeEndpoint {
  id: string;
  name: string;
}
export interface ConfigGetTopicResultEvent extends EventFrame<ConfigTopicStatePayload> {
  channel?: "model";
  type: "config.get_topic.result";
}
export interface ConfigSetTopicResultPayload {
  /** 写入后的新现态（与 get 同形）。 */
  state: ConfigTopicStatePayload;
}
export interface ConfigSetTopicResultEvent extends EventFrame<ConfigSetTopicResultPayload> {
  channel?: "model";
  type: "config.set_topic.result";
}
