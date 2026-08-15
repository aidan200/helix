# application/services/ — 编排服务（AD-17.1）

只管业务流转（如 ChatService：收到输入 → 聚合状态变更 → 判 steer 或新 turn → 调
AgentEnginePort → 发布领域事件），不碰实现；实现必须附详细中文注释（AD-17.6）。
ChatService / SessionService / RestoreService 等后续任务落位。
