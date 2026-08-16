```kg-node
id: E-AgentRuntime
kind: entity
graph: business
scope: domain
stack: backend
name: AgentRuntime
status: active
digest: 写 agent 装配、动驱动循环、排查 agent 生命周期时
updatedIn: iter-20260816-uzvg
```

## 描述
daemon 唯一驱动层：负责 pi-agent-core Agent 的组装（组合根装配 + 钩子语义注入）、驱动执行与生命周期管理。自建部分仅百行级（方向盘和油门），loop 本体（流式/工具批执行/截断处理）直接用 pi-agent-core 的 Agent+agentLoop，一行不重写。不感知任何具体编排模式——主会话与 SubAgent/phase/kg 共用这一条实现路径（v1 MainAgent/SubAgent 双轨的消除）。M2 起驱动循环在 turn 边界按 profile.compaction 参数接线 pi 的 shouldCompact/compact 独立函数族（loop 不自动跑，驱动层 turn 间调用；provider 硬约束 = 支持非流式 complete），CompactEntry 插该实例 pi session Entry 树、引擎事件防腐映射回传（TR-AD-18 compaction 通道）——主实例与 SubAgent 实例同路径获得 compaction。

## 规则
行为差异只经 AgentProfile 装配表达；钩子注入来自 HookSet 组合；新编排能力落地时 runtime 零改动（扩展公式：新能力 = HookSet + Profile）；compaction 接线按 profile 参数驱动、不感知 profile.kind；对 pi 的访问只经 adapters/driven/pi-engine 防腐封装（AgentEnginePort）；runtime 产生的状态交 domain 聚合持有，自身不藏权威状态。

## 禁忌
不写 if(profile.kind == ...) 式编排分支；不旁路另写第二套驱动循环；不直接 import pi 主入口或 pi-coding-agent。

## 关系
读取 AgentProfile（E-AgentProfile）完成装配；消费 HookSet（E-HookSet）注入 pi Agent 钩子；驱动产生的会话状态进会话聚合（E-会话聚合）；steer/abort 经 SteerQueue（E-SteerQueue）语义化；turn 间 compaction 产物经事件通道入聚合与账目（E-UsageLedger）。

```kg-node
id: E-AgentProfile
kind: entity
graph: business
scope: domain
stack: backend
name: AgentProfile
status: active
digest: 加 agent 类型、配模型槽位或工具集、定生命周期时
updatedIn: iter-20260816-uzvg
```

## 描述
声明式 agent 规格：kind、系统提示、工具集、model 槽位（provider/model-id；未声明 → 继承「当前系统选择的模型」——完整 Model 对象透传防 registry 不含，本迭代「当前模型」= config.json 静态临时位、改文件重启生效）、钩子装配（HookSet 组合）、compaction 参数、生命周期策略。生命周期声明是编排分层的唯一表达：persistent（常驻多轮，MainSessionProfile）vs single-shot（单轮收敛 + closure 协议回主线，SubAgentProfile）。已实例化 MainSessionProfile 与 SubAgentProfile（subagent-worker：单任务收敛 SOP + closure 协议系统提示、全工具集、single-shot、model 缺省继承）——扩展公式的首次生产运用。典型用法：主会话旗舰模型、worker 声明便宜模型。

## 规则
profile 是纯声明（规格数据 + 装配意图），行为差异全部表达为钩子装配与生命周期声明差异；model 解析收束 infrastructure/config 单点，消费面只依赖 Model 对象（config.json 是临时配置位，不得当永久接口——后续 auth.json 格式修改、模型模块重做，F-14 红线）；新增编排模式 = 新增 profile + HookSet 组合，AgentRuntime 不动（TR-AD-4）。

## 禁忌
不在 profile 里写命令式驱动代码或运行时分支；不为单一 agent 类型 fork runtime 或加 kind 分支；不把 config.json 当永久接口散落读取。

## 关系
被 AgentRuntime（E-AgentRuntime）读取装配；引用 HookSet（E-HookSet）组合；生命周期声明决定实例形态，实例化为 AgentInstance（E-AgentInstance）；SubAgentProfile 的实例由调度器（E-调度器）spawn（预算判定）。

```kg-node
id: E-HookSet
kind: entity
graph: business
scope: domain
stack: backend
name: HookSet
status: active
digest: 扩编排能力、写钩子处理器、调作用域时
anchors:
  implementedBy:
    - apps/daemon/src/adapters/driven/pi-engine/runtime/HookSet.ts
  testedBy:
    - apps/daemon/test/integration/test-profile.test.ts
updatedIn: iter-20260815-6tss
```

## 描述
可组合的钩子处理器单元，编排能力的原子载体：beforeToolCall（工具审批/相位锁挂起）、prepareNextTurn（自定义提示注入）、transformContext（kg 注入等上下文变换）、shouldStopAfterTurn（调度时机）、事件流处理器等。编排能力（相位锁/kg 注入/closure 协议）= 钩子处理器组合，profile 装配即启用。作用域是钩子处理器的属性：daemon 全局 / workspace / agent 实例。

## 规则
每个处理器单一职责、可独立组合复用；钩子语义映射到 pi-agent-core Agent 的对应钩子位（相位锁→beforeToolCall、customPrompt→prepareNextTurn、kg 注入→transformContext、调度时机→shouldStopAfterTurn、send 矛盾→steer()）；M2+ 编排能力以新 HookSet 在 v2 重新生长，不搬 v1 的目录概念划分。

## 禁忌
不把编排逻辑硬编码进 AgentRuntime；不用目录结构表达作用域（作用域 = 处理器属性）。

## 关系
被 AgentProfile（E-AgentProfile）装配启用；由 AgentRuntime（E-AgentRuntime）注入 pi Agent 对应钩子位。

```kg-node
id: E-会话聚合
kind: entity
graph: business
scope: domain
stack: backend
name: 会话聚合
status: active
digest: 动会话数据、加 Entry 或工具记录、跨实例聚合、写恢复时
updatedIn: iter-20260816-uzvg
```

## 描述
domain 层权威状态的主体聚合（充血模型：属性 + 行为，framework-free）：Entry 树（语义会话——消息/工具调用/thinking/compaction，每条挂 instanceId）、轮次生命周期、工具调用记录（含实例归属）；agent 生命周期/实例注册表、调度队列语义、usage 账目、closure 记录同为 domain 权威状态，随同一单写路径持久化。M2 起聚合是跨实例持续追加的会话级单位（AD-1）：实例窗口（LLM 上下文）销毁重建时聚合不重建、显示层连续——SubAgent 内容以挂 instanceId 的领域事件行入会话级存储（domain_events，trace 四维可查；抽屉消费 per-instance 事件流），聚合 Entry 树 v0.1 仅主实例（closure 注入以 isSteer entry、main 归属落树；SubAgent Entry 进聚合与恢复重放为 M3+ 子项，见 TR-AD-15 边界声明）；主线视图只取主实例 Entry + 卡片，抽屉取单实例全流。对外只经 application service（ChatService/SessionService/RestoreService/SchedulerService）读写；持久化经 SessionRepositoryPort 转 贫血行模型（RowMapper）；推前端经 ws-server adapter 转 protocol DTO。

## 规则
是会话数据的唯一持有者（内存 = 磁盘投影缓存，无第二事实源）；每条 Entry 挂 instanceId（TR-AD-15 全链路）；thinking 完成态与 compaction 里程碑为一等 Entry 成员（流式中间态仍不落盘，TR-AD-5）；状态变更以领域事件表达并交单写队列落盘；崩溃恢复 = 读盘重建聚合 → 快照推前端（快照含 instances 清单与 usage 聚合字段）；不 import pi 类型（Entry/LaneRecord 经 pi-engine 薄防腐映射）、不 import protocol 类型。

## 禁忌
不在聚合外维护第二份会话状态（前端副本、第二张表）；不给流式中间态补落盘；不在聚合上加持久化/DTO 转换方法（转换归 adapter）；不按实例重建聚合（实例切换/收口只追加不重建）。

## 关系
变更经领域事件与单写队列（E-领域事件与单写队列）持久化并扇出；steer/closure 消息经 SteerQueue（E-SteerQueue）在 turn 间注入轮次；Entry 按 instanceId 归属 AgentInstance（E-AgentInstance）；由 ChatService/SessionService/RestoreService/SchedulerService 编排。

```kg-node
id: E-领域事件与单写队列
kind: entity
graph: business
scope: domain
stack: backend
name: 领域事件与单写队列
status: active
digest: 加领域事件、动单写队列、扩订阅扇出时
anchors:
  implementedBy:
    - apps/daemon/src/adapters/driven/sqlite-session/WriteQueue.ts
    - apps/daemon/src/domain/events/DomainEvent.ts
  testedBy:
    - apps/daemon/test/integration/sqlite-persistence.test.ts
updatedIn: iter-20260815-6tss
```

## 描述
领域状态变更的单一通道：聚合变更 → 领域事件 → application 单写队列 → write-through 落盘 SQLite WAL（~/.helix/helix.db）；同一事件向订阅方扇出（WS 事件流推前端，前端 reducer 纯投影）；重连恢复 = daemon 推快照 + 续增量事件。

## 规则
落盘唯一路径，无第二写者（任何旁路直写 SQLite 即违规）；write-through + 崩溃恢复语义（崩溃丢当前流，恢复到最后一致里程碑，与 pi LaneRecord 同语义）；扇出与落盘同源（订阅方读到的事件对应已落盘状态）；db 路径经 infrastructure/paths.ts 解析，支持 --home 覆盖（测试 tmp 注入）。

## 禁忌
不允许 adapter 绕过队列直写库；不为流式中间态另设落盘通道；不在前端持久化业务状态再同步回来。

## 关系
持久化会话聚合（E-会话聚合）的变更；事件经 ws-server adapter 转 protocol DTO 喂前端投影；落盘经 SessionRepositoryPort 与 sqlite-session adapter。

```kg-node
id: E-SteerQueue
kind: entity
graph: business
scope: domain
stack: backend
name: SteerQueue
status: active
digest: 写 steer 打断、turn 间消息注入、closure 注入主线时
updatedIn: iter-20260816-uzvg
```

## 描述
steer 打断与主线注入的领域语义载体：生成中的用户消息与 SubAgent closure 消息进入 steering 队列，在 turn 边界 drain 注入下一轮（pi-agent-core Agent.steer() 内建 PendingMessageQueue 的领域化封装）。属领域权威状态（framework-free）。与 abort 区分：steer = 注入后续轮次，abort = 中断当前执行。M2 起 closure 注入复用同队列（AD-8）：closure 到达 enqueue（「agent-N closure: …」），与等待期用户 steer 同队列 FIFO、记录含来源可区分；closure 注入驱动 MainAgent 新 turn；本队列是外部消息进 MainAgent 窗口的唯一入口（替代 v1 customPrompt hack）。

## 规则
steer 消息不直接插入当前正在生成的流，经队列在 turn 间注入；closure 注入与用户 steer 同队列 FIFO，不设旁路；队列记录按来源可区分（用户 steer / closure 注入）；对外经 service 暴露 steer/abort 入口（driving adapter 只转发命令）；状态属 domain 聚合（framework-free），pi 语义经 pi-engine 防腐映射。

## 禁忌
不在 adapter 或前端实现 steer/closure 注入编排；不绕过队列直接改写当前生成中的轮次；closure 不走第二条注入通道直插主线窗口。

## 关系
注入会话聚合（E-会话聚合）的后续轮次；由 AgentRuntime（E-AgentRuntime）经 Agent.steer() 驱动；closure 注入来自调度器（E-调度器）收口（载荷结构 ClosureRecord，E-ClosureRecord）；前端打断入口经 WS 命令 → service → 本队列。

```kg-node
id: E-AgentInstance
kind: entity
graph: business
scope: domain
stack: backend
name: AgentInstance
status: active
digest: 写实例生命周期、挂 instanceId、区分主/Sub 实例时
updatedIn: iter-20260816-uzvg
```

## 描述
agent 实例一等概念（AD-3 trace 实例同构）：{instanceId, kind: "main"|"subagent", profileKind, sessionId, 实例状态机, createdAt}。主会话实例与 SubAgent 同为 AgentInstance——机制同构（同 AgentRuntime 驱动、同 AgentProfile 声明机制、同事件通道、同 trace/统计/持久化路径），编排分层仅经 profile 生命周期声明表达：main = persistent（常驻多轮、用户对话锚点，re-profile 时销毁重建）；subagent = single-shot（单轮收敛、closure 回主线后销毁）。实例创建/销毁/re-profile 是一等操作（非线性红线）。SubAgent 实例的 instanceId 即编排工具寻址的 agentId（同一标识空间，分配即定）；主实例在会话创建时分配固定 id。

## 规则
每条领域事件与聚合 Entry 挂 instanceId；trace 四维查询 session × instance × type × time；SubAgent 实例状态机 queued{位次} → running → stalled（警示可恢复）/done/failed（kill 收口 = failed 单一终态，无独立 killed 态），重启清队标 cancelled；实例窗口销毁重建而会话聚合跨实例持续追加（执行层全切/交接层受控注入/显示层连续）；调度器与状态机不假设单实例线性推进。

## 禁忌
不按 kind 分叉机制通道（事件/持久化/统计/驱动路径必须同构）；不假设一个会话单实例到底；不在实例对象外维护第二实例注册表。

## 关系
由 AgentProfile（E-AgentProfile）声明装配（生命周期声明即编排分层唯一表达）；生命周期受调度器（E-调度器）管理（spawn/预算/收口/kill）；事件与 Entry 进会话聚合（E-会话聚合）按 instanceId 归属；持久化投影 agent_lifecycle（主键 (session_id, instance_id)），重启经 RestoreService 重建实例注册表（恢复语义见 TR-AD-19）。

```kg-node
id: E-调度器
kind: entity
graph: business
scope: domain
stack: backend
name: 调度器
status: active
digest: 写并发预算或排队判定、扩编排工具、做 stalled 监视时
updatedIn: iter-20260816-uzvg
```

## 描述
SubAgent 并发编排的领域机制（AD-7 整包）：SchedulingPolicy（domain 纯语义——maxConcurrent=3 daemon 全局预算（config.json 可配，缺省 3）、maxQueued=8 FIFO 上限、stalled 阈值 idle>5min 无事件增量）+ SchedulerService（application 编排——预算判定/出队/stalled 监视/closure 收口/账目扇出）。超限 FIFO 排队不拒绝（queued 事件含位次推 UI），队列满才报错回 LLM（预算真实耗尽）；stalled 警示不自动杀、hard 无上限不自动杀，终止权手动在用户（抽屉 kill 按钮）；正常运行期 SubAgent 崩溃 = 崩溃隔离 + closure failed 通道。预算语义依赖 daemon 全局单例（per-workspace 多开使预算碎片化）。

## 规则
调度策略是 domain 纯数据 + 判定（可零依赖单测）；非线性红线——实例创建/销毁/re-profile 一等操作，状态机对「任意实例任意时刻到达任意状态」保持正确；编排三工具（agent_spawn/agent_send/agent_status）注册 MainSessionProfile、经 inbound AgentOrchestrationPort 回调度，agent_send 转投目标实例 Agent.steer()；调度队列不落盘（重启清队标 cancelled，TR-AD-19）。

## 禁忌
超限不抛错拒绝（v1 并发抛错禁止复发）；不自动杀 stalled/超时实例；本迭代不做优先级（M4 DAG 依赖调度再引入）；调度逻辑不进 adapter 或编排工具实现。

## 关系
管理 AgentInstance（E-AgentInstance）生命周期（spawn/queued/running/收口/kill）；closure 收口产生 ClosureRecord（E-ClosureRecord）并经 SteerQueue（E-SteerQueue）注入主线；账目扇出进 UsageLedger（E-UsageLedger）；全部状态变更经领域事件与单写队列（E-领域事件与单写队列）落盘。

```kg-node
id: E-ClosureRecord
kind: entity
graph: business
scope: domain
stack: backend
name: ClosureRecord
status: active
digest: 动 closure 结构、写收口落盘、处理 failed 注入时
updatedIn: iter-20260816-uzvg
```

## 描述
SubAgent 收口记录（AD-8，结构承接 v1）：{status: done|failed, summary, reportPath?, findings?, taskId?}。SubAgent 系统提示约定以此结构收口，子进程出口（ChildMain）解析回传；经 daemon 单写队列落 SQLite（closure 抗重启）；双通道消费——SteerQueue 注入 MainAgent 下轮上下文（唯一主线入口）+ agent.completed 事件完成卡片（用户消费，可回溯）。findings 字段保留（kg 自动落账 v2 重生长时接，M4+）。重启后 running 实例收口 failed、closure failed 注入主线（AD-10）。

## 规则
closure 是 SubAgent 结果回主线的唯一结构；记录经单写队列持久化（不开第二写通道，TR-AD-13）；报告文件产物落点遵循 ~/.helix 单点（TR-AD-6）；同一事实单一呈现面（注入文本供 LLM、完成卡片供用户，不重复渲染）；reportPath 产物形态已裁决（O-5 双产物）：closure_records 记录行 + <home>/reports/<session>/<agentId>.md 文件产物（reportsDir 未配置时不产文件，reportPath=null）。

## 禁忌
不绕过单写队列落 closure；不把 SubAgent 内部工具调用塞进 closure 或主线（内部流只进 per-instance 事件与抽屉）；不在恢复代码里自动重派任务（重试归编排层决策，AD-10）。

## 关系
由调度器（E-调度器）收口产生；注入经 SteerQueue（E-SteerQueue）；呈现为会话聚合（E-会话聚合）内完成卡片；归属 AgentInstance（E-AgentInstance）。

```kg-node
id: E-UsageLedger
kind: entity
graph: business
scope: domain
stack: backend
name: UsageLedger
status: active
digest: 动 token/费用统计、扩 usage 事件、做账目恢复时
updatedIn: iter-20260816-uzvg
```

## 描述
token/费用账目（AD-4）：turn 完成从 message_end 提取完整 Usage（input/output/cacheRead/cacheWrite/reasoning/totalTokens/cost，pi-ai calculateCost 直算）挂 instanceId 入事件流（usage.recorded）；per-instance 小计 → per-session 聚合（主线+委托合计）；compaction 摘要成本（CompactResult.usage）与 reasoning tokens 同通道入账（计费自洽）。domain 权威状态，经单写队列落 domain_events（trace 四维天然含账）；快照含 usage 聚合字段（instances 小计 + total），重启恢复合计与明细。UI = header 合计徽标 + hud-popover per-instance 下钻（kind+model+tokens 含 cache 维度+cost+状态，纯投影）。

## 规则
一切真实 LLM 成本必须入账（含 compaction 摘要调用与 reasoning tokens）；账目按 instanceId 归属（相位实例/SubAgent 各自累计）；流式中不动账、turn 完成入账；前端零账目累计（纯投影，TR-AD-5）。

## 禁忌
不漏记任何真实计费调用；不在前端累计或持久化账目；不按 kind 而按 instanceId 分账。

## 关系
记录归属 AgentInstance（E-AgentInstance）；扇出与落盘经领域事件与单写队列（E-领域事件与单写队列）；compaction 成本来自 AgentRuntime（E-AgentRuntime）接线产物；UI 投影经 ws-server DTO（UsageDto）。
