# application/ports/outbound/ — 出口端口（AD-17.2）

service 调用、driven adapter 实现的出口接口（AgentEnginePort / SessionRepositoryPort /
ToolExecutorPort / EventPublisherPort / ClockPort 等已全部落位；全集以本目录为准——
目录即真相源）。
铁律：port 文件只有接口定义，零实现。
