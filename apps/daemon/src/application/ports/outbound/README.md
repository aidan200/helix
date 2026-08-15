# application/ports/outbound/ — 出口端口（AD-17.2）

service 调用、driven adapter 实现的接口（AgentEnginePort / SessionRepositoryPort /
ToolExecutorPort / PathsPort / EventPublisherPort / ClockPort 等，后续任务落位）。
铁律：port 文件只有接口定义，零实现。
