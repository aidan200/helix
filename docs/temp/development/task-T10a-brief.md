# T10a Brief — 实例 ID 统一（方案 A）：daemon 核心段

## 项目定位

- 仓库：`/Users/siyong/AI_Project/helix`，本任务只动 `apps/daemon`（protocol wire/PROTOCOL.md 归 T10b，shell 归 T10c，e2e 归 T10d）。
- 测试命令：`bun test apps/daemon`、typecheck。
- **工作纪律（防超时丢活）**：每完成一个逻辑单元立即 git commit（增量提交，允许 3-6 个 commit）；隔离 worktree 工作。

## 需求（traceability）

用户决策（原话）：「agent的id应该是同一的agent-N，包括main agent……未来一个session中的main agent也可能是多个的，所以都用main，会有问题。agent-N的"N"不能是纯数字，而是Id生成的逻辑，一个不容易重复的字符串」+ 迁移方案 A（一次性全切 + 旧行只读兼容）。

目标形态：
- **所有实例**（含 main）instanceId = `agent-<唯一字符串>`（复用 session id 同款 `crypto.randomUUID()` 生成逻辑，Session.ts:36 先例；可用去横线/截短形态，定一处生成单点）。
- 废除主实例专用 ID `"main"`（MAIN_INSTANCE_ID 在 daemon 域的消费全部改 kind 判别）。
- **旧数据只读兼容**：历史行 instance_id="main" 不重写，判别函数把字面 "main" 视为 legacy main kind。
- `seq` / `agentSeqOf` / `maxAgentSeq` 三处整体退役（唯一字符串 ID 下无序号基线概念）。

## 探查事实（explorer 报告，可直接引用）

- MAIN_INSTANCE_ID daemon 消费点：`AgentInstance.ts:33`（re-export）+ `:40-43`（agentSeqOf）、`SchedulerService.ts:369`（spawn `agent-${++this.seq}`）+ `:154-155`（seq 字段）+ `:325-345`（restoreInstances 序号基线）、`RestoreService.ts:93`（maxAgentSeq 冗余字段）+ `:283/:330-334`（恢复用 agentSeqOf）、`SessionRegistry.buildView`（instances[0] instanceId=MAIN_INSTANCE_ID, kind="main"）、`Session.ts`/`Entry.ts`/`ToolCallRecord.ts`（main 归属缺省）、`wireEventFanout.ts:91`（agent_kind 判定）、`SessionMapper.ts`/`SqliteSessionRepository.ts`/`RowMapper.ts`/`WriteQueue.ts`（持久化 DEFAULT 'main' 回填）。
- 会话 ID 生成：`crypto.randomUUID()`（Session.ts:36）。
- `ensureSchemaEvolved`（WriteQueue.ts:469-507）幂等迁移机制；历史行 DEFAULT 'main' 回填天然后兼容。
- ⚠️ 字面混淆警告：`MAIN_AGENT_KIND="main"`（WriteQueue.ts:29）与 domain_events.agent_kind 列是 **kind 值**（保留不动），与实例 ID 的 "main" 不同物，改造时严防误改。

## 改动点（daemon，最小实现）

### 1. ID 生成单点 + spawn/主实例
- 新增实例 ID 生成单点（建议 domain/agent 下 `newInstanceId()`：`agent-` + crypto.randomUUID() 去横线或截短，注释写明用户决策语义）；`SchedulerService.spawn` 改调用它，`seq` 字段与 `++this.seq` 删除。
- 主实例 instanceId：查明主实例身份的生成/挂载点（Session 构建 / SessionRegistry.buildRuntime / buildView instances[0]）——改为每会话生成 `agent-<唯一串>`（kind 恒 "main" 不变）。所有以 MAIN_INSTANCE_ID 为归属缺省的位置（Entry/ToolCallRecord/Session 主通道）改读主实例实际 id。

### 2. kind 判别替代值判等
- 引入/复用主实例判别单点（如 `isMainInstanceId(id)`：id === 该会话主实例 id，**或 id === "main"（legacy 兼容）**——注意 per-session 主实例 id 需要可查询，判别函数的签名与挂载点按现状最小化设计）。
- daemon 内所有 `=== MAIN_INSTANCE_ID` / `!== MAIN_INSTANCE_ID` 判等改为该判别函数；MAIN_INSTANCE_ID 在 daemon 的 import 全部移除（protocol/common 侧定义归 T10b 处理，本任务只摘 daemon 依赖）。

### 3. 恢复与持久化兼容
- `restoreInstances` 删序号基线逻辑（agentSeqOf/max(N)+1）；`RestoredDomainState.maxAgentSeq` 字段删除（本就冗余）；`agentSeqOf` 删除（grep 确认零消费后）。
- 持久化层 `DEFAULT 'main'` 回填保留不动（历史行语义）；读取侧凡需判别 main 的位置走第 2 点判别函数（legacy "main" 字面值视为 main）。
- 冷恢复语义验证：旧库（含 "main" 行）恢复后主实例通道正常；新库主实例为 agent-<唯一串>。

### 4. wire 边界（本任务范围内的最小处理）
- daemon 发布侧：所有实例（含 main）事件信封**显式携带 instanceId**（不再依赖"省略=main"优化——写侧停止省略）；读侧/解析侧保留「省略=main」推断以兼容旧事件/旧快照。EnvelopeMapper 等 driving 面的协议文档化改动归 T10b，本任务只保证 daemon 行为正确 + 既有测试跟随。

## TDD 要求

- 先改钉桩看红：spawn 返回 agent-<非数字串>（非 agent-\d+ 正则断言）；主实例 instanceId 非 "main"；旧库恢复兼容用例；seq 退役后无撞号（连续 spawn id 互异）。
- 受影响测试文件跟随（SchedulerService/RestoreService/SessionRegistry/持久化/集成测试一大片——评估工作量，优先保证语义钉桩，钉桩文件逐批跟随）。

## 验收标准

1. spawn 的 SubAgent id = `agent-<唯一字符串>`（非纯数字 N；连续 spawn 互异；重启后无撞号概念）（测试钉）。
2. 主实例 instanceId = `agent-<唯一串>`，kind="main"（测试钉）。
3. 旧库（instance_id="main" 历史行）恢复后主流/抽屉分流、closure 注入寻址、directed steer 缺省全部正常（测试钉）。
4. `seq`/`agentSeqOf`/`maxAgentSeq` 零残留（grep 证据）；`MAIN_AGENT_KIND` 未被误改（grep 证据）。
5. daemon 内 MAIN_INSTANCE_ID import 零残留（grep 证据）；`bun test apps/daemon` 全绿 + typecheck。

## 报告要求

- submit_result 传 taskId=T10a；acceptance[] 逐条应答；findings[] 必填（无发现传 []）。若临近超时，**先 commit 在制工作再闭环**（status=PARTIAL 也可，findings 说明剩余面）。
