/**
 * Agent 生命周期状态（契约 §6；AD-17.5：前端显示贫血 DTO）。
 *
 * 由 agent.state.changed 事件、connection.welcome、SessionSnapshotDto 携带。
 * 状态机转换规则属 T1.6/T1.7 契约（重连状态机见集成契约 §8）。
 */
export type AgentStateDto = "idle" | "running" | "steering" | "aborting" | "stopped";
