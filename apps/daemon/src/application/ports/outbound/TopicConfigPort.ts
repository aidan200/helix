/**
 * 动态主题配置出站端口（outbound，动态主题批）。
 *
 * 职责：会话阶段演进主题的全局配置读写面（开关 / 主题生成模型 / 两段式
 * 分类判断）。实现体 = driven/sqlite-session/TopicConfigStore
 *（RuntimeConfigPort KV 上 topic_config 单键 JSON——SchedulingConfigStore/
 * SandboxConfigStore 同构模板）。写面经 WriteQueue 单写通道（AG-06）。
 *
 * 生效语义：运行期即热——锚点判定前实时读（开关关 = 零 LLM 调用），
 * 设置保存后下一次锚点即按新配置执行；judge 端点校验（classifyEnabled
 * 开启时 endpoint 必须指向 embedding 配置域 kind=classifier 条目）在
 * 命令 handler 侧单点（清单面在 EmbeddingConfigService），本端口只存不判。
 */
export interface TopicConfig {
  /** 动态主题开关（默认关——与管家开关先例同构）。 */
  readonly enabled: boolean;
  /** 主题生成模型（"provider/model-id"；null = 未配置，回落全局兜底）。 */
  readonly model: string | null;
  /** 分类模型判断开关（两段式：判官先判漂移再生成）。 */
  readonly classifyEnabled: boolean;
  /** 分类端点 id（embedding 配置域 kind=classifier 条目；null = 未选）。 */
  readonly classifyEndpointId: string | null;
}

export interface TopicConfigPort {
  /** 当前配置（存储值 ?? 缺省全关；db 已关闭 → 最近已知值）。 */
  current(): TopicConfig;
  /** 写入（单写通道，落盘完成即返回；同步观测缓存）。 */
  set(config: TopicConfig): Promise<void>;
}
