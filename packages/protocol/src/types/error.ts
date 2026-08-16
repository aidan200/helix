/**
 * 协议错误码（契约 §7）。
 *
 * connection.error 事件 payload 的 code 取值全集；处置差异（关闭 vs 保持）
 * 见 PROTOCOL.md §7：auth.* / protocol.* 握手期拒绝（发 error 帧后 close），
 * command.* 命令错误回执（发 error 帧，连接保持）。连接层异常（非 WS 帧垃圾
 * 数据等）不发帧直接 close，前端走重连状态机（集成契约 §8）。
 */
export type ErrorCode =
  | "auth.missing_token"
  | "auth.invalid_token"
  | "protocol.version_unsupported"
  | "command.unknown"
  | "command.invalid_payload"
  /** v0.2 新增（契约 A 登记批）：命令 type 已在目录中、daemon 行为未落地（T2.x）——占位路由回执，连接保持 */
  | "command.unimplemented"
  /** v0.2 新增（契约 B §3，AD-4）：session 族命令目标会话不存在（subscribe/loadHistory/delete） */
  | "session.not_found"
  /** v0.2 新增（契约 B §3，AD-1）：loadHistory 游标非法（不在目标会话主时间轴内） */
  | "session.invalid_cursor"
  /** v0.2 新增（契约 B §3，Q-4④）：同会话删除进行中（重复 delete 请求） */
  | "session.delete_in_progress";
