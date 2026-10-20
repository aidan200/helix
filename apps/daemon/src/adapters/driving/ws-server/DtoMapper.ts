/**
 * DtoMapper —— domain 充血模型 → @helix/protocol DTO 贫血转换（AD-17.5：
 * 转换在 adapter，domain/application 不感知协议）。
 *
 * 全部纯函数；domain 类型只以 `import type` 引入（零运行时耦合，AG-12）。
 * 线格式定稿：ts = epoch 毫秒（契约 §9-2）；args = JSON 序列化字符串。
 *
 * 守护式拆分（TR-AD-25④）后的模块族：EntryDtoMapper（条目级）/ SnapshotMapper
 * （快照与分页）/ EnvelopeMapper（领域事件→帧）/ ProjectDtoMapper（项目行 DTO，
 * kg.projects 与 workspace.open.result 共用口径——低危批自 handlers/kg.ts 迁入，
 * 消除 handlers 间横向依赖）；
 * 本文件为常设 barrel（语义族名 + 消费端隔离面）。
 * 依赖方向无环：EnvelopeMapper/SnapshotMapper/ProjectDtoMapper 均不反向依赖 barrel。
 * 投影收敛后：SpawnAnchor 纯函数已迁 @helix/protocol projection
 * 单源（本地模块退役，不再在依赖方向内）。
 */
export * from "./EntryDtoMapper";
export * from "./SnapshotMapper";
export * from "./EnvelopeMapper";
export * from "./ProjectDtoMapper";
