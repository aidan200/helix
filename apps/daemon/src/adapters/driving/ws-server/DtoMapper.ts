/**
 * DtoMapper —— domain 充血模型 → @helix/protocol DTO 贫血转换（AD-17.5：
 * 转换在 adapter，domain/application 不感知协议）。
 *
 * 全部纯函数；domain 类型只以 `import type` 引入（零运行时耦合，AG-12）。
 * 线格式定稿：ts = epoch 毫秒（契约 §9-2）；args = JSON 序列化字符串。
 *
 * 四职责域拆分（TR-AD-25④ 守护式拆分）
 * EntryDtoMapper / SnapshotMapper / SpawnAnchor / EnvelopeMapper 四模块；
 * 本文件为常设 barrel（语义族名 + 消费端隔离面），导出面与拆分前恰等，
 * 8 个消费端 import 点（3 src + 5 test）零改动。
 * 依赖方向无环：EnvelopeMapper/SnapshotMapper → EntryDtoMapper；
 * SnapshotMapper → SpawnAnchor。投影收敛后：
 * SpawnAnchor 纯函数已迁 @helix/protocol projection 单源（本地模块退役）。
 */
export * from "./EntryDtoMapper";
export * from "./SnapshotMapper";
export * from "./EnvelopeMapper";
