# ADR：会话生命周期域（多会话注册表 / 草稿转正 / 冷删除 / 重启恢复）

> 来源：SessionRegistry.ts / Session.ts / SessionSnapshot.ts / RestoreService.ts 注释考古迁档。
> 活规则锚：AD-4（删除收口链）、AD-10（恢复语义树）、AD-16（快照恢复公式）、TR-AD-14（旧行前向兼容）。

## 背景

daemon 支持多会话并存：热会话（运行时在注册表）+ 冷会话（仅 SQLite 行，懒加载）。会话有完整生命周期：内存草稿 → 转正（首个用户条目落库）→ 活跃 → 删除/空闲卸载；daemon 重启后须「重连同样成立」。

## 取舍

- **单台账 SessionRecord**：六平行 Map/Set（runtimes/lastActivityMs/lastBroadcastRunState/deleting/unpromotedDrafts/createdAnnounced）收敛为单 `Map<string, SessionRecord>` 聚合——清理点 N→1（deleteSession/unloadIdle 各恰一次 sessions.delete，六类状态无残留；promoteDraft 零 delete 纯字段翻转）。record.runtime 允许 undefined = 「冷删除占位」（库有行未热加载的删除进行中）。
- **内存草稿「不可见 + 转正」**：零条目热草稿对外不可见（不进 listSessions；createFresh 不写 agent.instantiated——trace 查询面无幻影）；转正单点 promoteDraft：首个用户条目时恰好一次 instantiated + created 补广播（经 createdAnnounced 去重不双发）。发布点从「会话创建」推迟到「转正」是 bug1/bug4（草稿泄漏/幻影事件）的修复。
- **删除收口链（AD-4）**：取消链顺序硬约束——主线 abort + 封口（stopped 终态）→ 等在飞 run（捕获语义：whenSettled 等待调用时刻的 run，窗口内新 run 不延长等待）→ SubAgent cancelSession（queued→cancelled 摘队 / running→kill）→ 删库（六表清行入本会话仓尾）→ 台账销毁。重复删除回 delete_in_progress。
- **快照 per-session 盖章（热修定档）**：agentState/model 取视图归属会话自身（buildView 随视图同源组装），禁用 system.getStatus() 全局最近活跃投影——多会话下 current 恒被后台流式会话锚定，盖目标会话快照即串台。
- **重启恢复（AD-10）**：数据源三合一（agent_lifecycle 行 + closure_records 行 + domain_events agent.spawned 载荷）；悬挂 open turn 一律收口 interrupted（重启不可能有 run 在飞）；running→failed（closure 注入主线但不自动续跑）、queued→cancelled（队列不落盘重启即清，无 closure 行——未开跑）；账目不落快照，权威源 = usage.recorded 事件流重放（AD-4 事件即账）。
- **SubAgent 历史重放（AD-3）**：事件流 agent_kind=subagent 全量补齐（投影落库前的旧库升级 + 事件行先于状态行的崩溃窗口自愈；快照已有条目按 id 去重）——恢复不重放铁律保持（不发布事件、不落盘、不触发 launch）。

## 演进史

1. 单会话时代：restoreLatest 取 ids.at(-1) 末位语义；多会话化后废弃，目标会话由调用方决定（懒加载/启动取当前）。
2. 六平行台账 → 单 SessionRecord（结构收敛批）；deleting/unpromotedDraft/createdAnnounced 从独立 Set 收进 record 字段。
3. 草稿链：welcome.draft + 不 attach 不推快照（握手面）→ chat.send draft 建会话链（模型先 setModel 后发消息；同模型短路跳过 setModel 防无意义切换记录；异模型路径先转正再换模，created 补广播经去重）。
4. 空闲卸载：idleUnload 定时器卸载冷会话（write-through 落盘后销毁台账；执行中会话不卸载）；重载经 register 重设 lastBroadcastRunState 基线自愈、unpromotedDraft=false 使 promoteDraft 幂等守卫 no-op。
