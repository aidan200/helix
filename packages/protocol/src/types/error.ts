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
  | "session.delete_in_progress"
  /** v0.2 新增（契约 C §4，T2.3-result-frames 微批）：model.set/set_default 的 model id 不在合并目录 */
  | "model_not_found"
  /** v0.2 新增（契约 C §4）：auth.* 的 providerId 不在目录 provider 全集 */
  | "provider_not_found"
  /** v0.2 新增（契约 C §4）：目录拉取失败（catalog/catalog_refresh 通路；降级快照仍可用，列表不空） */
  | "catalog_unreachable"
  /** kg 批新增（iter-20260825-11fo T5.3，契约 kg-viewer-api）：kg 族命令参数非法/无法解析（含 project 不在项目列表、过滤值越界）；发 error 帧连接保持 */
  | "KG_E_PARAM"
  /** kg 批新增：目标节点/项目不存在（kg.node.detail / kg.node.confirm）；发 error 帧连接保持 */
  | "KG_E_NOT_FOUND"
  /** kg 批新增：状态机非法迁移（confirm 非 draft 节点）；发 error 帧连接保持 */
  | "KG_E_STATE"
  /** kg 批新增：索引构建触发失败（kg.index.status rebuild；面板保持 degraded 可重试）；发 error 帧连接保持 */
  | "KG_E_REBUILD_FAILED"
  /** workspace 批新增（W1 绑定闭环）：workspace.open root 校验失败（不存在/非目录/不可读/危险根——文件系统根或主目录）；发 error 帧连接保持 */
  | "WORKSPACE_E_INVALID_ROOT"
  /** workspace 批新增：存在运行中会话/智能体时拒绝重绑（F2 裁决 v1 禁止切换）；发 error 帧连接保持 */
  | "WORKSPACE_E_ACTIVE_AGENT"
  /** workspace 批新增：未绑定工作空间时的依赖面拒绝（会话创建门禁/kg 参数型读面防御）；发 error 帧连接保持 */
  | "workspace.unbound"
  /** task 批新增（iter-20260829-ys7q T1.5，契约 task-api §4）：createTask 的 type 无对应任务 skill（T2.4 工具面同码）；发 error 帧连接保持 */
  | "task.type_unknown"
  /** task 批新增：manifest/paramsSchema/projects 基数校验失败（message 带具体违例）；发 error 帧连接保持 */
  | "task.validation_failed"
  /** task 批新增：jobId 不存在（task.detail/artifacts/生命周期命令）；发 error 帧连接保持 */
  | "task.not_found"
  /** task 批新增：生命周期/删除的非法当前态（如 running 任务删除、done 任务暂停——判断收口引擎 T1.3，handler 透传）；发 error 帧连接保持 */
  | "task.invalid_state"
  /** kg-bootstrap 批新增（iter-20260829-ys7q T3.2，契约 kg-bootstrap-api §2）：bootstrap 准入复核未过（message 带原因：index_absent / index_building / knowledge_not_empty——后端机械复核不信赖前端）；发 error 帧连接保持 */
  | "kg.bootstrap.not_eligible"
  /** kg-bootstrap 批新增：目标节点不存在（kg.node.update / kg.node.supersede；kg 族既有 KG_E_NOT_FOUND 同义错误码两形态并存——修正面与 task.validation_failed 词表对齐用本码）；发 error 帧连接保持 */
  | "kg.node.not_found"
  /** kg 维护批新增（C1）：kg.graph.purge 安全门禁——存在运行中（running/pending）kg-bootstrap 任务时拒绝清空（防 done 任务悬挂引用）；发 error 帧连接保持 */
  | "kg.graph.purge_blocked"
  /** kg 评审批新增（W2-F）：kg.review.create 准入复核未过（message 带原因 index_absent——从简准入，允许反复发起与 bootstrap 一次性语义不同）；发 error 帧连接保持 */
  | "kg.review.not_eligible"
  /** agent-roster 批新增：agent.config.set_enabled 对只读系统派生 kind（orchestrator / subagent-kg-writer）的写面拒绝——前端只读只是表现，后端拒绝才是事实；发 error 帧连接保持 */
  | "agent.config.read_only";
