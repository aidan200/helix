```kg-node
id: E-AgentRuntime
kind: entity
graph: business
scope: domain
stack: backend
name: AgentRuntime
status: active
digest: 写 agent 装配、动驱动循环、排查 agent 生命周期时
updatedIn: iter-20260815-6tss
```

## 描述
daemon 唯一驱动层：负责 pi-agent-core Agent 的组装（组合根装配 + 钩子语义注入）、驱动执行与生命周期管理。自建部分仅百行级（方向盘和油门），loop 本体（流式/工具批执行/截断处理）直接用 pi-agent-core 的 Agent+agentLoop，一行不重写。不感知任何具体编排模式——主会话与 M2+ 的 SubAgent/phase/kg 共用这一条实现路径（v1 MainAgent/SubAgent 双轨的消除）。

## 规则
行为差异只经 AgentProfile 装配表达；钩子注入来自 HookSet 组合；新编排能力落地时 runtime 零改动（扩展公式：新能力 = HookSet + Profile）；对 pi 的访问只经 adapters/driven/pi-engine 防腐封装（AgentEnginePort）；runtime 产生的状态交 domain 聚合持有，自身不藏权威状态。

## 禁忌
不写 if(profile.kind == ...) 式编排分支；不旁路另写第二套驱动循环；不直接 import pi 主入口或 pi-coding-agent。

## 关系
读取 AgentProfile（E-AgentProfile）完成装配；消费 HookSet（E-HookSet）注入 pi Agent 钩子；驱动产生的会话状态进会话聚合（E-会话聚合）；steer/abort 经 SteerQueue（E-SteerQueue）语义化。

```kg-node
id: E-AgentProfile
kind: entity
graph: business
scope: domain
stack: backend
name: AgentProfile
status: active
digest: 加 agent 类型、配系统提示或工具集、定生命周期时
updatedIn: iter-20260815-6tss
```

## 描述
声明式 agent 规格：kind、系统提示、工具集、钩子装配（HookSet 组合）、生命周期策略（常驻多轮 vs 单轮收敛）。首迭代实例化 MainSessionProfile（常驻多轮 + 流式输出 + steer/abort + 最小钩子接线，即 CLI 多轮对话入口）；M2 SubAgent = 新增 SubAgentProfile，不改 runtime。

## 规则
profile 是纯声明（规格数据 + 装配意图），行为差异全部表达为钩子装配差异；作用域（daemon 全局/workspace/agent 实例）是 HookSet 的属性，不用目录结构表达；新增编排模式 = 新增 profile + HookSet 组合，AgentRuntime 不动。

## 禁忌
不在 profile 里写命令式驱动代码或运行时分支；不为单一 agent 类型 fork runtime。

## 关系
被 AgentRuntime（E-AgentRuntime）读取装配；引用 HookSet（E-HookSet）组合；生命周期策略决定 runtime 对该 agent 的驱动方式。

```kg-node
id: E-HookSet
kind: entity
graph: business
scope: domain
stack: backend
name: HookSet
status: active
digest: 扩编排能力、写钩子处理器、调作用域时
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
digest: 动会话数据、加轮次或工具调用记录、写恢复时
updatedIn: iter-20260815-6tss
```

## 描述
domain 层权威状态的主体聚合（充血模型：属性 + 行为，framework-free）：Entry 树（语义会话）、轮次生命周期、工具调用记录；AD-16 领域权威状态清单中的 agent 生命周期状态同为 domain 聚合，随同一单写路径持久化。对外只经 application service（ChatService/SessionService/RestoreService）读写；持久化经 SessionRepositoryPort 由 sqlite-session adapter 转贫血行模型；推前端经 ws-server adapter 转 protocol DTO。

## 规则
是会话数据的唯一持有者（内存 = 磁盘投影缓存，无第二事实源）；状态变更以领域事件表达并交单写队列落盘；崩溃恢复 = 读盘重建聚合 → 快照推前端（流式中间态不落盘，恢复到最后一致里程碑）；不 import pi 类型（Entry/LaneRecord 经 pi-engine 薄防腐映射）、不 import protocol 类型。

## 禁忌
不在聚合外维护第二份会话状态（前端副本、第二张表）；不给流式中间态补落盘；不在聚合上加持久化/DTO 转换方法（转换归 adapter）。

## 关系
变更经领域事件与单写队列（E-领域事件与单写队列）持久化并扇出；steer 消息经 SteerQueue（E-SteerQueue）在 turn 间注入轮次；由 ChatService/SessionService/RestoreService 编排。

```kg-node
id: E-领域事件与单写队列
kind: entity
graph: business
scope: domain
stack: backend
name: 领域事件与单写队列
status: active
digest: 加领域事件、动单写队列、扩订阅扇出时
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
digest: 写 steer 打断、turn 间消息注入、并发语义时
updatedIn: iter-20260815-6tss
```

## 描述
steer 打断的领域语义载体：生成中的用户消息进入 steering 队列，在 turn 边界 drain 注入下一轮（pi-agent-core Agent.steer() 内建 PendingMessageQueue 的领域化封装）。属 AD-16 领域权威状态清单（steer 队列 = domain 聚合）。与 abort 区分：steer = 注入后续轮次，abort = 中断当前执行。

## 规则
steer 消息不直接插入当前正在生成的流，经队列在 turn 间注入；对外经 service 暴露 steer/abort 入口（driving adapter 只转发命令）；状态属 domain 聚合（framework-free），pi 语义经 pi-engine 防腐映射。

## 禁忌
不在 adapter 或前端实现 steer 编排；不绕过队列直接改写当前生成中的轮次。

## 关系
注入会话聚合（E-会话聚合）的后续轮次；由 AgentRuntime（E-AgentRuntime）经 Agent.steer() 驱动；前端打断入口经 WS 命令 → service → 本队列。
