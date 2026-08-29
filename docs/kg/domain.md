> 【过渡态·已迁入】v2 管道已停用 md 解析（SoT 下沉 .helix-kg/kg.db 单库，iter-20260825-11fo AF-21 终态；81 节点已于终验 kg-migrate --apply 迁入）；老版 phase runtime 仍解析本文件维护 v1 索引（.kg/kg.db，注入面）——终验新增/修订的 kg-node 块对老版注入有效，v2 侧以本文件为恢复基线（kg-migrate 幂等重建）。

> 【过渡态】v2 管道已停用 md 解析（SoT 下沉 .helix-kg 单库，iter-20260825-11fo AF-21 终态）；但老版 phase runtime 仍解析本文件维护 v1 索引（.kg/kg.db，注入面）——终验新增/修订的 kg-node 块（TR-AD-50+、E-知识图谱等）对老版注入有效。v2 单库启用时以 kg-migrate 幂等迁入（恢复基线：md 快照）。

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
digest: 加 agent 类型、配模型槽位或推理级别、配工具集、定生命周期时
anchors:
  implementedBy:
    - apps/daemon/src/adapters/driven/pi-engine/runtime/AgentProfile.ts
    - apps/daemon/src/adapters/driven/pi-engine/runtime/profiles/SubAgentProfile.ts
    - apps/daemon/src/adapters/driven/subagent/SubagentLauncher.ts
    - apps/daemon/src/application/services/ResourceService.ts
    - apps/daemon/src/adapters/driven/sqlite-session/ResourceStateStore.ts
    - apps/daemon/src/application/ports/outbound/ResourceStatePort.ts
    - apps/daemon/src/adapters/driven/sqlite-session/WriteQueue.ts
    - packages/protocol/src/events/agent.ts
    - packages/protocol/src/commands.ts
    - apps/shell/src/pages/skills/ui/P-2-ThinkingField.tsx
    - apps/shell/src/pages/skills/AgentPage.tsx
    - apps/shell/src/pages/skills/model/agent-config-model.ts
    - apps/shell/src/features/thinking-level/model/thinking-resolution.ts
    - apps/daemon/src/application/services/modes.ts
    - packages/protocol/src/modes.ts
updatedIn: task-20260824-p1-mode
```

## 描述
声明式 agent 规格：kind、系统提示、工具集、model 槽位、thinkingLevel 槽位（可选）、钩子装配（HookSet 组合）、compaction 参数、生命周期策略。生命周期声明是编排分层的唯一表达：persistent（常驻多轮，MainSessionProfile）vs single-shot（单轮收敛 + closure 协议回主线，SubAgentProfile）。main 实例绑定模式注册表驱动（P1 task-20260824-p1-mode）：session 一对一绑定模式（session.mode 建会话定格持久化，session_state.mode 可空列 + 守护式补列 + 恢复侧归一），main 实例 profileKind 不再硬编码 "main-session"——解析单点 = application/services/modes.ts（import @helix/protocol MODES；domain 层禁 protocol 故落 application，AG-02 白名单），未知/缺省 fallback default；engineFor 模型/thinking 槽位 kind 从 profileKindOf(mode) 取值（default 下行为零变化，解析链优先级不变）；热草稿转正复用加 profileKind 一致性（不一致丢弃重建走 createFresh，零条目草稿无成本）；扩展公式不变：P2 staged 模式三阶段 agent = 注册表新条目 + 新 profile（resource_state 槽位按 profileKind 天然隔离），runtime 零改动（详见 TR-AD-49）。model 槽位语义（AD-3 修订，取代 M2 AD-6「缺省继承全局默认」）：model 槽位是 SubAgent 模型解析链的最高优先级——profile 声明 model（provider/model-id，完整 Model 对象透传防 registry 不含）即该类型实例固定用声明模型；未声明则回退 kind 槽位（launch 期读现值定格，TR-AD-44）、全局兑底（runtime_config default_model 键现值；语义为「全局兑底」而非「SubAgent 默认来源」，T12 砍 spawn 会话快照级）。取代边界：仅取代「SubAgent 模型源 = 全局默认表」的解析规则；会话级 model.set 内存态语义不变（主实例 AgentState.model，重启/卸载回退全局兑底）。thinkingLevel 槽位（iter-20260823-6ps5 AD-6 新增，可选）：与 model 槽位并列声明推理级别，便于和模型匹配；留空 = 未配置 → 解析链默认关（TR-AD-40 D 方案，无兑底档）；SubAgent spawn 时经 resolveThinkingFor 解析快照（自身 profile 槽位，未配置 = env 缺席 = 子进程不装注入器，TR-AD-40），主会话覆盖永不作用 SubAgent。配置资源 7 步链（resource_state thinking 槽位型）：ResourceType+"thinking" / WriteQueue 通用 slotValue 原子替换 job / ResourceStateStore / ResourceService 三态 / protocol DTO v0.11 批内补登 / resource.ts handler 零校验透传 / EventStream 广播；kind 维合取不传染、缺省无记录=未配置语义不变。SubAgentProfile.model 从显式 undefined 转为真实槽位——代码层声明入口（UI 管理已由智能体页 /skills 承接：双 kind 卡片，模型下拉复用 filterAvailableModels 与 chat P-3 同一可用性口径，provider configured 过滤 + 当前槽位兑底 + authLoaded 门控；thinkingLevel 滑块字段同页落位——读 = agent.config list.result profiles[].thinkingLevel（null → unset ghost），写 = set_enabled resourceType="thinking" 槽位语义（set=档位字符串透传；clear=删除行），applied 等 changed 广播 revision 重拉收口；刻度数随槽位模型能力位驱动）。已实例化 MainSessionProfile 与 SubAgentProfile（subagent-worker：单任务收敛 SOP + closure 协议系统提示、全工具集、single-shot）——扩展公式的首次生产运用。典型用法：主会话旗舰模型、worker 声明便宜模型。

## 规则
profile 是纯声明（规格数据 + 装配意图），行为差异全部表达为钩子装配与生命周期声明差异；model 解析收束 SubagentLauncher.resolveModelFor 单点（两级解析链：profile 槽位 > kind 槽位 > 全局兑底，消费面只依赖解析后的 Model 对象，launch 段为唯一消费点，见 TR-AD-24/TR-AD-44；spawn 会话快照级已砍，T12）；主实例模型解析同构：构造期 engineFor 读 profileKindOf(session.mode) 槽位 > 全局兑底（P1，buildSessionStack 参数化）；thinkingLevel 解析收束 SubagentLauncher.resolveThinkingFor 单点（resolveModelFor 同点扩展：自身 profile 槽位，未配置 = 默认关（无兑底档），spawn 快照定格经 env 透传子进程，见 TR-AD-40）；新增编排模式 = 新增 profile + HookSet 组合，AgentRuntime 不动（TR-AD-4）——新增模式同理：注册表新条目 + 新 profile，session.mode 定格绑定（TR-AD-49）。

## 禁忌
不在 profile 里写命令式驱动代码或运行时分支；不为单一 agent 类型 fork runtime 或加 kind 分支；不把 model 槽位语义回退为「未声明 = 全局默认」单级解析（AD-3 已取代该语义，会话内切模型必须能经 spawn 快照传导到 SubAgent）；不把主会话 thinking 覆盖经 spawn 快照传导给 SubAgent（覆盖是 mainAgent 私有意图，TR-AD-40 红线）；不散落读取配置绕过解析链单点；不在 shell 侧对 thinkingLevel 做档位校验（字符串原样透传，解析权威在 daemon；canonical 序仅作展示位镜像）。

## 关系
被 AgentRuntime（E-AgentRuntime）读取装配；引用 HookSet（E-HookSet）组合；生命周期声明决定实例形态，实例化为 AgentInstance（E-AgentInstance）；SubAgentProfile 的实例由调度器（E-调度器）spawn（预算判定 + 模型 resolveSubagentModelId 单点供给，不继承会话模型）；模型槽位参与两级解析链（TR-AD-24），kind 槽位经 TR-AD-44 getter 折叠进读面，全局兑底级依赖 runtime_config default_model 键（E-模型目录 / P1 KV 底座）；thinkingLevel 槽位参与 thinking 解析链（TR-AD-40：spawn 时自身槽位，快照随 agent.instantiated 落盘），读写面经智能体配置资源（E-智能体配置资源）thinking 槽位型；main 实例 profileKind 由会话模式注册表解析（TR-AD-49，P1），mode 定格于会话聚合。

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
updatedIn: iter-20260820-qhv8
```

## 描述
可组合的钩子处理器单元，编排能力的原子载体：beforeToolCall（工具审批/相位锁挂起）、prepareNextTurn（自定义提示注入）、transformContext（kg 注入等上下文变换）三处理器槽位 + bind() 装配回调（事件流处理器的实际承载面）+ SteerCapable steer/abort 能力面；shouldStopAfterTurn 为 pi 侧可用、helix 未接线的扩展位（iter-20260820-qhv8 终验 L3 复核校正：全仓零接线，勿当现有能力引用）。编排能力（相位锁/kg 注入/closure 协议）= 钩子处理器组合，profile 装配即启用。作用域是钩子处理器的属性：daemon 全局 / workspace / agent 实例。

## 规则
每个处理器单一职责、可独立组合复用；钩子语义映射到 pi-agent-core Agent 的对应钩子位（相位锁→beforeToolCall、customPrompt→prepareNextTurn、kg 注入→transformContext、send 矛盾→steer()；调度时机→shouldStopAfterTurn 属 pi 侧可用、helix 未接线扩展位，接线时再入正规则）；M2+ 编排能力以新 HookSet 在 v2 重新生长，不搬 v1 的目录概念划分。

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
digest: 动会话数据、加 Entry 或工具记录、跨实例聚合、写恢复、动草稿会话转正时
anchors:
  implementedBy:
    - apps/daemon/src/domain/session/Session.ts
    - apps/daemon/src/application/ports/inbound/SessionPort.ts
    - apps/daemon/src/application/services/RestoreService.ts#restoreThinkingOverride
    - apps/daemon/src/adapters/driving/ws-server/handlers/thinking.ts
  testedBy:
    - apps/daemon/test/integration/thinking-restore.test.ts
    - apps/daemon/test/integration/thinking-set-chain.test.ts
updatedIn: iter-20260823-6ps5
```

## 描述
domain 层权威状态的主体聚合（充血模型：属性 + 行为，framework-free）：Entry 树（语义会话——消息/工具调用/thinking/compaction，每条挂 instanceId）、轮次生命周期、工具调用记录（含实例归属）；agent 生命周期/实例注册表、调度队列语义、usage 账目、closure 记录同为 domain 权威状态，随同一单写路径持久化。M2 起聚合是跨实例持续追加的会话级单位（AD-1）：实例窗口（LLM 上下文）销毁重建时聚合不重建、显示层连续——SubAgent 内容以挂 instanceId 的领域事件行入会话级存储（domain_events，trace 四维可查），聚合 Entry 树含主实例主轴 + SubAgent per-instance 归属条目（Entry.instanceId；经会话投影 SessionProjection 落树）；快照尾窗切法保留 per-instance channel 完整性（AD-1 硬约束）；主线视图只取主实例 Entry + 卡片，抽屉取单实例全流。会话级 thinking 覆盖的持久化（iter-20260823-6ps5）：覆盖意图经 thinking.set 命令族落 domain_events（单写队列），跨冷恢复由 RestoreService.restoreThinkingOverride 只读回放末值直写引擎内存（绕过发布面，零新事件流），SessionStateView additive thinking {override, effective} 双位读面随快照出会话（TR-AD-41③）。对外只经 application service（ChatService/SessionService/RestoreService/SchedulerService）读写；持久化经 SessionRepositoryPort 转 贫血行模型；推前端经 ws-server adapter 转 protocol DTO。内存草稿语义（hotfix-20260820 AD-1）：会话可先以零条目内存草稿存在；草稿双面不可见且握手经 welcome.draft 标记；首个用户条目「转正」——promoteDraft 单点恰好一次，此后与持久会话等价。

## 规则
是会话数据的唯一持有者（内存 = 磁盘投影缓存，无第二事实源）；零条目内存草稿不进清单不写事件、首条消息才落库并转正；每条 Entry 挂 instanceId（TR-AD-15 全链路）；thinking 完成态与 compaction 里程碑为一等 Entry 成员（流式中间态仍不落盘，TR-AD-5）；会话级 thinking 覆盖持久化归 domain_events 事件行（restore 只读回放末值，零新事件流铁律）；状态变更以领域事件表达并交单写队列落盘；「会话是否为空」判定唯一口径 = Session.isEmpty；崩溃恢复 = 读盘重建聚合 → 快照推前端；不 import pi 类型、不 import protocol 类型。

## 禁忌
不在聚合外维护第二份会话状态（前端副本、第二张表）；不给流式中间态补落盘；不在聚合上加持久化/DTO 转换方法；不按实例重建聚合（实例切换/收口只追加不重建）；恢复路径不为 thinking 覆盖补发新事件（回放直写，零新事件流）。

## 关系
变更经领域事件与单写队列（E-领域事件与单写队列）持久化并扇出；steer/closure 消息经 SteerQueue（E-SteerQueue）在 turn 间注入轮次；Entry 按 instanceId 归属 AgentInstance（E-AgentInstance）；由 ChatService/SessionService/RestoreService/SchedulerService 编排；thinking 覆盖读面经 SessionPort 快照供前端状态树（TR-AD-41/TR-AD-5）。

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
digest: 写 steer 打断、turn 间消息注入、closure 注入主线、用户定向干预实例时
anchors:
  implementedBy:
    - apps/daemon/src/domain/session/Session.ts#applySteer
    - apps/daemon/src/domain/session/Session.ts#steerEntry
    - apps/daemon/src/domain/session/Session.ts#applyDirectedSteer
    - apps/daemon/src/domain/agent/SteerQueue.ts#SteerQueue
    - apps/daemon/src/application/services/ChatService.ts#steer
    - apps/daemon/src/application/services/ChatService.ts#steerInstance
  testedBy:
    - apps/daemon/test/unit/chat-service.test.ts
    - apps/daemon/test/unit/domain-session.test.ts
    - apps/daemon/test/unit/chat-service-steer-orphan.test.ts
updatedIn: task-20260824-steer-orphan
```

## 描述
steer 打断与主线注入的领域语义载体：生成中的用户消息与 SubAgent closure 消息进入 steering 队列，在 turn 边界 drain 注入下一轮（pi-agent-core Agent.steer() 内建 PendingMessageQueue 的领域化封装）。属领域权威状态（framework-free）。与 abort 区分：steer = 注入后续轮次，abort = 中断当前执行。M2 起 closure 注入复用同队列（AD-8）：closure 到达 enqueue（「agent-N closure: …」），与等待期用户 steer 同队列 FIFO、记录含来源可区分；closure 注入驱动 MainAgent 新 turn；本队列是外部消息进 MainAgent 窗口的唯一入口（替代 v1 customPrompt hack）。M4 起用户 steer 可定向 SubAgent 实例：chat.steer 扩可选 instanceId，daemon 路由目标实例的本队列（复用 agent_send 通道：ChatService 判定 → AgentOrchestrationPort.send → InstanceRunner → transport → 子进程 Agent.steer()），缺省无 instanceId = 主实例（既有语义不变）；定向干预消息同构落 Entry（标注目标实例）经会话投影，恢复重放完整。run 收口清账（task-20260824-steer-orphan，孤儿缺陷修复）：closure 双通道在 run 无后续消费轮时（模型正写最后回复，pi run 收尾不消费残留 pending）引擎侧永不消费——settleRunEnd 收口段 drainAllSteer 残留逐条 engine.error 可观测丢弃（与 stopped 分支同族；注入对象已不在即放弃，closure 文本已在 entry 树可回看）。不变式：队列只存在两类合法驻留——运行中待 drain 项 + 跨重启恢复保留项（restoreSteer，pendingSteer 随快照落盘）；run 收口即清账，孤儿自愈（存量脏行在所属会话下次 run 收口时同点清理）。丢弃文案中性（覆盖 closure/progress/user steer/恢复残留全来源）。

## 规则
steer 消息不直接插入当前正在生成的流，经队列在 turn 间注入；closure 注入与用户 steer 同队列 FIFO，不设旁路；队列记录按来源可区分（用户 steer / closure 注入；用户定向 steer 按目标实例标注）；对外经 service 暴露 steer/abort 入口（driving adapter 只转发命令，路由判定归 application service）；状态属 domain 聚合（framework-free），pi 语义经 pi-engine 防腐映射；用户干预消息一律落 Entry 同构投影，不设不投影例外通道；run 收口时 domain 队列残留必须清账（drain + 可观测丢弃）——孤儿滞留即缺陷，下次发消息被补注入过时内容同罪。

## 禁忌
不在 adapter 或前端实现 steer/closure 注入编排；不绕过队列直接改写当前正在生成中的轮次；closure 不走第二条注入通道直插主线窗口；定向 steer 不走旁路通道直投子进程而不落 Entry（干预历史恢复后消失）。

## 关系
注入会话聚合（E-会话聚合）的后续轮次（干预消息落 Entry 挂目标 instanceId 经会话投影）；由 AgentRuntime（E-AgentRuntime）经 Agent.steer() 驱动；closure 注入来自调度器（E-调度器）收口（载荷结构 ClosureRecord，E-ClosureRecord）；用户定向入口经 WS chat.steer{instanceId}（复用编排 agent_send 通道），寻址目标 AgentInstance（E-AgentInstance）；前端打断入口经 WS 命令 → service → 本队列。

```kg-node
id: E-AgentInstance
kind: entity
graph: business
scope: domain
stack: backend
name: AgentInstance
status: active
digest: 写实例生命周期、挂 instanceId、kind 判别主/Sub 实例、供 spawn 锚点时
derivedFrom:
  - T10 实例 ID 统一（task-20260824-thinking-unify：用户裁决「agent的id应该是同一的agent-N，包括main agent……未来一个session中的main agent也可能是多个的……N不能是纯数字，而是Id生成的逻辑」——方案 A 一次性全切 + 旧行只读兼容）
anchors:
  implementedBy:
    - packages/protocol/src/projection/instance.ts#computeAnchorEntryId
    - packages/protocol/src/projection/instance.ts#lastMainAnchorId
    - packages/protocol/src/projection/instance.ts#AnchorScanEntry
    - apps/daemon/src/application/services/scheduler/SchedulerService.ts#spawnAnchors
    - apps/daemon/src/application/services/scheduler/SchedulerService.ts#spawnAnchorOf
    - apps/daemon/src/domain/agent/AgentInstance.ts
    - apps/daemon/src/adapters/driving/ws-server/EventStream.ts#publish
    - apps/daemon/src/adapters/driving/ws-server/EntryDtoMapper.ts
    - apps/daemon/src/infrastructure/container.ts#computeSpawnAnchor
    - apps/daemon/src/domain/events/DomainEvent.ts#AgentInstantiatedPayload
    - apps/daemon/src/infrastructure/assembly/buildSessionStack.ts#subagentSnapshotFor
    - apps/shell/src/entities/session/model/consumers/snapshot.ts
    - apps/shell/src/entities/session/model/state.ts
    - apps/shell/src/widgets/chat-stream/ui/MessageFlow.tsx
  testedBy:
    - apps/daemon/test/integration/spawn-anchor.test.ts
    - apps/daemon/test/unit/subagent-thinking-chain.test.ts
    - apps/shell/src/entities/session/model/instance-anchors.test.ts
    - apps/shell/src/widgets/chat-stream/ui/MessageFlow.test.tsx
    - apps/daemon/test/integration/agent-ws.test.ts
updatedIn: task-20260824-thinking-unify
```

## 描述
agent 实例一等概念（AD-3 trace 实例同构）：{instanceId, kind: "main"|"subagent", profileKind, sessionId, 实例状态机, createdAt}。**instanceId 统一 agent-<唯一串>（T10，含主实例）**：所有实例 id = `agent-` + crypto.randomUUID 派生 hex（生成单点 newInstanceId，Daemon 唯一串无序号概念——seq/agentSeqOf/maxAgentSeq 序号基线退役）；主/Sub 区分由 kind 承载（AgentInstanceDto.kind + isMainInstanceId/isMainChannel/isWireMainAttribution 判别单点，shell/daemon/wire 三层同构）；**legacy "main" 字面/缺省 = 读侧推断**（历史行只读兼容，写侧不再产出——wire 写侧全实例显式携带 instanceId，「省略=main」线格式优化退役为读侧兼容）；持久化 session_state.main_instance_id 列 + 5 表 DEFAULT 'main' 回填保留；MAIN_INSTANCE_ID 常量全仓退役。主会话实例与 SubAgent 同为 AgentInstance——机制同构（同 AgentRuntime 驱动、同 AgentProfile 声明机制、同事件通道、同 trace/统计/持久化路径），编排分层仅经 profile 生命周期声明表达：main = persistent（常驻多轮、用户对话锚点，re-profile 时销毁重建）；subagent = single-shot（单轮收敛、closure 回主线后销毁）。实例创建/销毁/re-profile 是一等操作（非线性红线）。SubAgent 实例的 instanceId 即编排工具寻址的 agentId（同一标识空间，分配即定）；主实例在会话创建时分配唯一串 id。M4 起实例携带 spawn 锚点：daemon 快照组装面权威计算 spawn 关联 entry 稳定标识（复用 EntryDto.id 体系——主实例 e{N} / SubAgent {instanceId}#N；语义 = 快照组装面规则①；spawn 时刻钉值规则② = agent_spawn 工具调用 id），经 instances DTO 锚点字段下发；锚点是组装期派生值不持久化。agent.instantiated 落盘事件可选携带 spawn 时解析的 thinkingLevel（TR-AD-40 默认关语义下未配置不携带）。**wire 归属编码一致性铁律（T10d R4 红点根因）**：thinking delta 载荷与 completed entry.instanceId 必须同一编码（主实例归一 legacy "main"）——错位致 shell thinkingStreams 槽位键悬挂、cursor 永挂。

## 规则
每条领域事件与聚合 Entry 挂 instanceId（写侧全实例显式携带）；trace 四维查询 session × instance × type × time；主/Sub 判别走 kind 判别单点（instanceId === 会话主实例 id，或 legacy "main" 字面/缺省——绝不散落值判等）；SubAgent 实例状态机 queued{位次} → running → done/failed（kill 收口 = failed 单一终态），stalled 为 running 态上的可重复警示事件（非状态迁移），重启清队标 cancelled；实例窗口销毁重建而会话聚合跨实例持续追加；调度器与状态机不假设单实例线性推进；spawn 锚点由 daemon 权威计算，前端纯消费零推导；wire 归属编码跨帧一致（delta 与 completed 同编码）。

## 禁忌
不按 kind 分叉机制通道（事件/持久化/统计/驱动路径必须同构）；不假设一个会话单实例到底；不在实例对象外维护第二实例注册表；**不恢复 instanceId 值判等（=== "main" 散落——必须走判别单点；不恢复序号 id agent-<N>——唯一串下无序号概念）**；不在前端推导锚点；不把锚点持久化为独立状态列；wire 层不同事件族使用不同归属编码（跨帧错位 = 槽位键悬挂）。

## 关系
由 AgentProfile（E-AgentProfile）声明装配（生命周期声明即编排分层唯一表达）；生命周期受调度器（E-调度器）管理（spawn/预算/收口/kill）；事件与 Entry 进会话聚合（E-会话聚合）按 instanceId 归属（锚点即聚合 Entry id 的引用，经会话投影与 DtoMapper 组装进 instances DTO）；持久化投影 agent_lifecycle（主键 (session_id, instance_id)），重启经 RestoreService 重建实例注册表（恢复语义见 TR-AD-19）；用户定向 steer 寻址本实例（E-SteerQueue）；instantiated 事件携带的 thinkingLevel 快照供给 trace 复盘与 spawn 解析链观测（TR-AD-40）。

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
anchors:
  implementedBy:
    - packages/protocol/src/projection/usage.ts
  testedBy:
    - packages/protocol/test/projection/usage.test.ts
updatedIn: iter-20260821-dg90
```

## 描述
token/费用账目（AD-4）：turn 完成从 message_end 提取完整 Usage（input/output/cacheRead/cacheWrite/reasoning/totalTokens/cost，pi-ai calculateCost 直算）挂 instanceId 入事件流（usage.recorded）；per-instance 小计 → per-session 聚合（主线+委托合计）；compaction 摘要成本（CompactResult.usage）与 reasoning tokens 同通道入账（计费自洽）。纯函数实现单源在 packages/protocol/src/projection/usage.ts（iter-20260821-dg90 T3.1 收敛：ZERO_USAGE/addUsage/applyUsage/instanceUsageOf/aggregateSession，compaction 计入实例小计口径唯一定义点，AD-9③）；daemon 侧账目状态与入账时机不动（TR-AD-5），经单写队列落 domain_events（trace 四维天然含账）；快照含 usage 聚合字段（instances 小计 + total），重启恢复合计与明细。UI = header 合计徽标 + hud-popover per-instance 下钻（kind+model+tokens 含 cache 维度+cost+状态，纯投影）。

## 规则
一切真实 LLM 成本必须入账（含 compaction 摘要调用与 reasoning tokens）；账目按 instanceId 归属（相位实例/SubAgent 各自累计）；流式中不动账、turn 完成入账；前端零账目累计（纯投影，TR-AD-5）。

## 禁忌
不漏记任何真实计费调用；不在前端累计或持久化账目；不按 kind 而按 instanceId 分账。

## 关系
记录归属 AgentInstance（E-AgentInstance）；扇出与落盘经领域事件与单写队列（E-领域事件与单写队列）；compaction 成本来自 AgentRuntime（E-AgentRuntime）接线产物；UI 投影经 ws-server DTO（UsageDto）。

```kg-node
id: E-认证凭据
kind: entity
graph: business
scope: domain
stack: backend
name: 认证凭据（auth.json）
status: active
digest: 写 auth.json、动凭据存取、加 provider key 管理时
anchors:
  implementedBy:
    - apps/daemon/src/infrastructure/auth-store.ts
  testedBy:
    - apps/daemon/test/unit/auth-store.test.ts
    - e2e/CL-3-e2e-model-chain.spec.ts
updatedIn: iter-20260816-6q6f
```

## 描述
provider API keys 的唯一存储（~/.helix/auth.json，路径经 paths.ts 单点派生）：Record<providerId, type-tagged Credential 联合>（pi 生态格式等价；OAuth 类型面支持、登录流不做）；文件权限 0600；跨进程 pid 文件锁 + 进程内 opQueue 串行；原子写（tmp+rename，AG-06③ 白名单显式列名）。auth 命令族（auth.list/set_key/delete_key/verify）与 set_model 的 apiKey 跟随均以此为源；连通验证（verify）经 pi-ai streamSimple 最小 completion（maxTokens=1）真探活——done → ok+latency / error → fail+reason。

## 规则
0600 权限是硬约束（E 层断言背书）；写必经原子写 + 锁（无并发半写）；凭据不进 config.json、不落日志、不外传协议原文（前端脱敏 key 尾 4 位）；认证面是第四类 port 落位（infrastructure 纯技术文件 port，TR-AD-2）。

## 禁忌
不以明文回显完整 key（协议/日志/UI 均脱敏）；不绕过锁并发写；不把凭据写进 SQLite 或 config.json；不复制 pi 的 SettingsManager 凭据体系（自有 auth.json 独立管理）。

## 关系
E-模型目录 的可用性过滤（P-3 菜单 configured 判定）以本实体的已配置 provider 集为判据；verify 连通三态供 P-4 展示；E 层测试以 prepHome 预置 auth.json seed（0600）为标准注入面。

```kg-node
id: E-模型目录
kind: entity
graph: business
scope: domain
stack: backend
name: 模型目录（ModelCatalog）
status: active
digest: 动模型目录、扩 provider、调缓存刷新或落盘兑底时
anchors:
  implementedBy:
    - apps/daemon/src/adapters/driven/pi-engine/model-catalog.ts
    - apps/daemon/src/application/ports/outbound/ModelCatalogPort.ts
    - apps/daemon/src/adapters/driving/ws-server/handlers/model.ts
  testedBy:
    - apps/daemon/test/unit/model-catalog.test.ts
    - apps/daemon/test/integration/ws-server-spy.test.ts
    - e2e/CL-3-e2e-model-chain.spec.ts
updatedIn: iter-20260823-6ps5
```

## 描述
可用模型清单的权威供给面：builtin 静态表（provider 数随 pi-ai 版本演进，pi-ai 0.84.2 = 40；iter-20260821-dg90 终验 L3 复核校正——不写死数字防版本演进再漂移）+ pi.dev overlay 在线目录合并（ETag 条件刷新，缓存 4h；304 只挪 checkedAt——目录数据不变，刷新轮统一 best-effort 落盘含元数据（4h 窗口跨重启所必需，iter-20260820-qhv8 终验 L3 复核校正））；防降级（新目录不得清空既有 overlay）；落盘兑底（~/.helix/models-store.json，离线启动用缓存，路径经 paths.ts 单点派生）。thinking 能力位防腐（iter-20260823-6ps5 AD-4②）：snapshot() 映射单点直透 Model.reasoning 并派生 thinkingLevels = pi-ai getSupportedThinkingLevels(model).filter(l => l !== "off")——canonical 升序与缺席键规则保持 pi-ai SoT（helix 不引入 off 语义、不维护第二份档位枚举），handlers/model.ts 目录帧直透。经 ModelCatalogPort（outbound）供 ModelService 消费；前端 P-3/P-4 经协议 model.catalog 命令族读取，P-1/P-2 thinking 控件消费 thinkingLevels 能力位（TR-AD-42）。默认模型（SQLite default_model 表）为其附属状态，不独立成实体。

## 规则
builtin 表是离线兑底基线永不失效；overlay 刷新走 ETag 条件请求，失败保缓存不报错（无外网可用）；目录合并幂等；落盘经 paths.ts + 原子写（AG-06③ 白名单）；零 pi-coding-agent import（TR-AD-7 红线，G-2 裁决自实现）；thinkingLevels 派生公式单点在 snapshot() 防腐映射（滤 off 不自建序，缺席键语义随 pi-ai）。

## 禁忌
不因网络失败清空或降级目录（防降级硬约束）；不在 daemon 外（前端）自拉 pi.dev；不经 config.json 携带模型清单；不 import pi-coding-agent 的目录能力；不在 helix 任何层维护第二份档位枚举或自算档位序（SoT 在 pi-ai）。

## 关系
P-3 菜单可用性过滤以 E-认证凭据 的已配置 provider 集为判据（前端 join，协议不加可用性字段）；短 id 跨厂商歧义宁可不标（T5.4 resolveCatalogMatch 裁决）；catalog_refresh 命令触发同步刷新（延迟可能高，后台预刷新未做）；thinkingLevels/reasoning 能力位供给 TR-AD-42 能力位驱动 UI。

```kg-node
id: E-智能体配置资源
kind: entity
graph: business
scope: domain
stack: backend
name: 智能体配置资源（resource_state）
status: active
digest: 动资源启停、扩资源配置维度、调 kind 维合取语义时
anchors:
  implementedBy:
    - apps/daemon/src/adapters/driven/sqlite-session/ResourceStateStore.ts
    - apps/daemon/src/application/services/ResourceService.ts
    - apps/daemon/src/adapters/driven/pi-engine/SkillScanner.ts
    - packages/protocol/src/commands.ts
    - packages/protocol/src/events/agent.ts
    - apps/daemon/src/adapters/driven/sqlite-session/WriteQueue.ts
  testedBy:
    - apps/daemon/test/integration/resource-state.test.ts
    - apps/daemon/test/unit/resource-service.test.ts
    - apps/daemon/test/unit/skill-scanner.test.ts
    - apps/daemon/test/integration/agent-config-ws.test.ts
updatedIn: iter-20260823-6ps5
```

## 描述
按 profile kind 维度的资源启停/槽位状态（SQLite resource_state 表，主键 (profile_kind, resource_type, name)，全局表走 WriteQueue globalTail 链）：resource_type ∈ {tool, skill, model, thinking} 四类（iter-20260823-6ps5 扩 thinking 槽位型，v0.11 批内补登）。生效集 = profile 静态全集（tools 声明）/扫描全集（skills）∩ kind 启用集；槽位型（model/thinking）语义 = 每 kind 至多一行现值：model 型行 enabled 恒 1、删除行 = 未设；thinking 型同槽位语义——set = 档位字符串零校验透传（enabled=1）、clear = 删除行（缺省无记录 = 未配置，解析链回落兑底 medium，负断言守护）。缺省无记录 = 启用/未配置（零配置兼容现状，存量会话/测试零迁移）。模型槽位链位：main-session 槽位 = 出厂默认（四级解析链 per-session 覆盖 > kind 槽位 > default_model），subagent-worker 槽位 = 解析链 kind 槽位级（launch 期 getter 折叠读现值定格，TR-AD-24/TR-AD-44）UI 化；thinking 槽位同理（subagent-worker 槽位折入 profile 读面，静态声明优先）。skills 扫描三层目录（user=~/.helix/skills 经 paths.ts 单点派生 + project=<工作区>/.helix/skills 启动时定格 + builtin=daemon 随仓 resources/skills，builtin 层不可禁用——ResourceService builtin-immutable 跳过语义；iter-20260821-dg90 终验 L3 复核校正层数宣称），pi loadSourcedSkills 防腐墙内包装，诊断上抛不炸。

## 规则
合取语义硬约束：kind 启停不跨 kind 传染；未知名 toggle 显式跳过（skipped 回执，不落库——全集外无生效面）；list 读面只回全集内资源；槽位型写经通用 slotValue 原子替换 job（同 job 内先 DELETE 后 INSERT，model/thinking 同道，替代原 modelSlot 专用 job 的泛化形态）。

## 禁忌
不以 enabled=0 表达槽位「未设」（删除行才是未设）；不在 application 层 import profiles（tools 全集经组合根注入映射表，AG-02）；扫描器 pi 类型不得越防腐墙；不兼容 pi 的 ~/.pi 目录（用户裁决：三层自有目录）；不对 thinking 槽位值做档位校验（字符串透传，解析权威在解析链）。

## 关系
E-AgentProfile 的静态全集是合取的一侧（运行期启用集是另一侧）；E-模型目录 default_model 为 main 槽位的下级兑底；thinking 槽位供 TR-AD-40 解析链消费（经 TR-AD-44 getter 折叠）；agent.config.* 命令族是唯一写入口（set_enabled/changed resourceType 扩 "thinking"；list 读面 profiles[].thinkingLevel string|null）；T2 刷新链消费合取结果直改活跃 runtime。

```kg-node
id: E-知识图谱
kind: entity
graph: business
scope: domain
stack: shared
name: 知识图谱（kg）
status: active
digest: 动 kg 库 schema、写附着或 sync 管道、扩 kg 工具/命令面、改锚声明或项目发现时
updatedIn: iter-20260825-11fo
```

## 描述
helix v2 项目知识图谱子系统（iter-20260825-11fo 落地）——按项目根持有的知识层×符号层×物化锚单库体系，统摄五个业务面：图谱构建与增量同步（CL-2）、知识到达（CL-1，附着+任务切片双通道）、知识沉淀与事后修正（CL-3）、主动查询面（CL-4，search/get 最小集）、图谱查看页面（CL-5，P-1 /project）。库 = <projectRoot>/.helix-kg/kg.db（AF-21 终态，本地运行态）；md 表示层已停用（AD-9 SoT 下沉）。独立生命周期（sync 管道维护新鲜度、节点 draft/confirmed/superseded 状态机）；唯一标识 = 节点 id（TR-AD-54 策略）；多模块消费（sync/附着/查询/报告/P-1 页/验证检查）。

## 规则
①SoT = <projectRoot>/.helix-kg/kg.db 单库（知识层/符号层/物化锚同库，TR-AD-50）；知识层唯一写入口 KgWriteService（schema 校验即防线）。②符号层新鲜化单一 sync 管道：双源汇队列+去抖+单飞+表分域写（TR-AD-51）；附着读快照允许滞后。③知识到达双通道：动作层附着（edit 成功尾部 📎 块，四层递降+宁可沉默不可错附，TR-AD-52）+ 任务层切片注入；读面绝不新建库。④锚关联由写入时作用域声明决定（global/path/symbol 三级，确定性物化，TR-AD-53）。⑤节点 id 前缀+单调序号永不复用，supersede 只翻 status；id 不进人类界面（TR-AD-54）。⑥验证期机械检查只列不修（find_conflicts/find_orphans/活跃度启发），处置权在人。⑦查询面最小集：search(q) LIKE 确定性匹配 + get(nodeId) 全量，无 embedding（F-6）。

## 禁忌
绕过 KgWriteService 旁路直写知识层；读面（探测/查询/页面）新建库文件（absent 语义破坏）；v2 代码读写 v1 .kg/kg.db（AF-21 同名冲突）；附着放宽到 callee/跨文件符号或错附不沉默（通道被 agent 学会忽略——v1 下场）；全局域节点物化锚（重复运输）。

## 关系
由 TR-AD-50~58 共同 governs（存储/同步/附着/锚/发号/复制/发现/只读/模板九面）；与候选台账（E-候选台账）构成沉淀闭环：附着发现的知识缺口、候选、人审落库三步；查询面供 agent（kg search/get 工具）与人类（P-1 /project 页）双面消费。

```kg-node
id: E-候选台账
kind: entity
graph: business
scope: domain
stack: shared
name: 候选台账（candidates）
status: active
digest: 写 propose/apply/discard/defer 流转、动 candidates 分区、做 gc_report 或 pending 门控检查时
updatedIn: iter-20260825-11fo
```

## 描述
知识沉淀的人审裁决台账（iter-20260825-11fo 经 verification entity 覆盖率审计确立为独立业务实体）——候选从产生到落库的状态机载体：propose（候选落 pending）→ 终验人审三选一（apply 正式落库发号 / discard 否决留痕可复活 / defer 挂起限龄限量）。独立生命周期（pending/deferred/applied/discarded 四分区流转）；被多模块消费（gc_report 正确性类检出直写、candidates_pending_empty 门控、终验人审编排）。载体演进：v1 = docs/kg/candidates.md 四分区（本迭代已停用）；v2 = .helix-kg 库内（经 KgWriteService，change_log 审计面）。

## 规则
①状态机：propose（候选落 pending）→ 人审三选一 apply（正式节点落库+发号）/ discard（否决留痕可复活）/ defer（挂起，≤10 条且 ≤2 迭代年龄）。②写入权：MainAgent 单点写入；SubAgent 只能经 submit_result findings（kind=sediment）上报，闭环时自动落账。③apply 的 formalId 由终验人审签发，绝不发明正式号；开发期用临时号 KIND-iter-seq。④部分实现不落库——必须完整实现且通过验证。⑤幂等判定仅对 pending/deferred 分区（applied/discarded 历史命中不吞新检出）。⑥v1 载体 md 四分区（已停用）；v2 载体 .helix-kg 库内（经 KgWriteService，change_log 审计）。

## 禁忌
SubAgent 直接写台账；部分实现落库；发明 formalId；幂等判定命中 applied/discarded 分区即跳过（吞掉正确性类检出——OI-gc-idempotency-swallow 病根）。

## 关系
知识图谱（E-知识图谱）沉淀闭环的裁决面：SubAgent findings sediment 经 propose 落 pending，再由终验人审流转；受 TR-AD-54 管辖（id 策略：正式号仅人审签发，开发期用临时号）；gc_report 正确性类检出直写本台账 pending。

```kg-node
id: E-任务
kind: entity
graph: business
scope: domain
stack: shared
name: 任务（无交互多 agent 任务系统）
status: active
digest: 新建任务类型、动任务引擎/编排主 agent/任务页、改 job/stage/batch/work_item 四表、做断点恢复或自动重试时
updatedIn: iter-20260829-ys7q
```

## 描述
helix v2 通用「无交互纯多 agent 任务」系统（iter-20260829-ys7q 落地）——任务 = 持久化一等实体：状态机推进、多 agent 批次执行、中间状态与产出持久化、失败自动重试、断点恢复，全程无需人介入（跑得完、死得起、恢得复）；kg-bootstrap 是首个任务类型。三段式承载（TR-AD-59）：任务引擎（机制代码化）+ 任务类型 skill（builtin 层 SOP）+ 编排主 agent（LLM 判断）；批次执行单元复用 SubAgent 基础设施（共享 maxConcurrent=3 预算）。持久化 = helix.db 新表域四表（job/stage/batch/work_item；表分域写——父进程经 WriteQueue 写 job/stage/batch，子进程经 plan 工具直连写 work_item；O-1 用户裁决：子进程写面 = plan 工具代码边界，LLM 无裸写通道，分库无安全收益）。独立生命周期（pending→running⇄paused→done/failed/cancelled，无中途人审态）；唯一标识 = job id（task-<唯一串>，不进人类界面）；多模块消费（编排主 agent/任务页 P-2/双宿主创建面/kg 产出呈现区经元数据衔接）；任务删除 = 人工操作，仅终态可删，清任务域全部记录（job/stage/batch + 批次实例 work_item），不动 kg 产出。

## 规则
①职责 = 根据 task 定义完成任务并给出结果（自动重试/生命周期控制/过程与结果查询）；结果后处理（落盘/呈现/修正）是任务类型的域逻辑，任务系统零产出处置概念（TR-AD-60）。②人对运行中任务只有生命周期控制（暂停/继续/取消），内容零干预；任务页零创建，创建按任务类型各有宿主。③确认只在开启前一次（任务内容卡或对话），执行全程无 gate。④阶段是通用结构：创建时定义、确认后冻结、落数据行不落代码；任务间无关系结构。⑤项目关联 = projects[] 0..n 普通标签，基数由任务类型 paramsSchema 声明。⑥批次产出落 kg 经 KgWriteService 唯一入口（含 batchCreateNodes 批量 op），衔接面 = taskId/origin_batchId/layer 三元数据；批次重跑幂等 = 旧产出 supersede + 新跑（TR-AD-64）。⑦daemon 重启扫 running 任务重开编排会话续跑，断点粒度 = stage/batch 行。⑧任务删除（人工）：仅终态可删、清任务域全部记录（含批次实例 plan）、不动 kg 产出。

## 禁忌
把任务做成 bootstrap 内嵌临时监控（AD-1 否决的选项 A——通用化后才能复用于后续同类任务）；任务页加创建表单或 steer 入口（干预边界失守）；状态机加层间人审 gate（无交互设计破产）；任务系统承载审阅/转正/产出处置逻辑（每加一个任务类型就要改任务页）；批次绕 SchedulerService 直起子进程（预算/closure 通路失守）；删任务时连带删 kg 产出节点（知识归 kg 域，AD-10——清理知识走 /project 图谱页修正/supersede）。

## 关系
由 TR-AD-59~65 共同 governs（三段式/干预边界/实例台账/阶段通用化/项目标签/元数据衔接/人类可读性七面）；与知识图谱（E-知识图谱）经节点元数据（taskId/origin_batchId/layer）单点衔接——任务产 confirmed 知识（无 draft，以代码事实落盘即正式知识），kg 域呈现与事后修正；执行面复用 E-AgentInstance/E-调度器既有通路；批次实例语义进度由 E-实例plan 承载。

```kg-node
id: E-任务类型skill
kind: entity
graph: business
scope: domain
stack: shared
name: 任务类型 skill（task skill）
status: active
digest: 新增任务类型、写或改 builtin 任务 skill、动 frontmatter manifest 字段、改 TaskSkillRegistry 装载口径时
updatedIn: iter-20260829-ys7q
```

## 描述
任务类型的定义载体（iter-20260829-ys7q）——builtin 层 resources/skills/<type>/SKILL.md，随仓分发、产品不可删改（ResourceService builtin-immutable 防护既有）。一文两消费：frontmatter = 机器可读 manifest（task.paramsSchema + stages 策略 fixed/free + confirm/plan 声明），引擎 createTask 时确定性校验；正文 = 编排主 agent 运行期 SOP（各层产出目标与验收/批次划分原则/brief 装配模板/写作规范/完成判定）。首个实例 = kg-bootstrap（L0 核心层→L1 领域层→L2 实体层固定三阶段；准入 = 有索引且无图谱的老项目；产出以代码事实落盘即 confirmed，无 draft）。装载 = SkillScanner 扫描（含 task 块入任务类型注册表，普通技能不受影响）。新增任务类型 = 加一个 skill 文件，引擎零改动。

## 规则
①frontmatter 必须机器可校验：paramsSchema 声明参数与项目基数（kg-bootstrap 恰好 1 个项目）；stages 策略 fixed → 引擎直接生成阶段行，free → 取发起者确认列表；confirm/plan 声明驱动确认形态与 plan 硬约束。②正文 SOP 约束的是编排 agent 的 LLM 判断面（批次划分/上下文传递/验收），不替代引擎机制。③builtin 层不可删改 = SOP 正确性的工程保障；manifest 校验失败 = 被拒绝的请求，不产 job 行。④kg-bootstrap 正文含写作规范五条（TR-AD-65①），是批次产出验收条件。⑤类型合法性 = 注册表驱动：有对应 skill 才认（task_create 工具与 /project 入口同一 createTask 校验面）。

## 禁忌
把任务流程硬编码进引擎绕过 skill（三段式破产，TR-AD-59）；manifest 靠 LLM 读正文自觉（确定性校验必须代码化）；把 SOP 放 user/project 层被用户改坏（bootstrap SOP 属产品行为，必须 builtin 层）；skill 正文写引擎机制（状态机/重试细节——机制归代码，skill 只写判断面约束）。

## 关系
任务（E-任务）三段式的 SOP 段（TR-AD-59②）；manifest 字段与校验纪律由 TR-AD-62 governs；kg-bootstrap 实例的写作规范由 TR-AD-65 governs；经 SkillScanner/SystemPromptAssembler 既有技能体系装载注入（F-8）。

```kg-node
id: E-实例plan
kind: entity
graph: business
scope: domain
stack: shared
name: 实例 plan（实例级工作台账）
status: active
digest: 派 SubAgent 写 brief、判子实例进度、做断点接力恢复、改 closure 收口判定、给任务页/chat 加实例进度展示时
updatedIn: iter-20260829-ys7q
```

## 描述
chat/task 统一的 SubAgent 语义级阶段记录（iter-20260829-ys7q，AD-6）——填补「原始 trace 太低层、终点 closure 太晚」之间的进度事实源空白。数据 = work_item 表（instanceId/seq/content/status(pending→in_progress→done/abandoned)/note（关键事实+产物指针：文件/节点 id/卡点）/updatedAt），实例作用域；写口 = plan 工具族三操作（plan_create/plan_update/plan_read）全量配给所有 SubAgent（SubAgent 不感知派发方，chat 与 task 写口完全一致）；读口 = 派发方随时读（chat MainAgent 判进度 / 任务编排器判批次进度 / 任务页渲染中间状态）。与 trace（机器审计原始流）、closure（终点收口）三件套不重叠——plan 是 LLM 策展的语义进度。

## 规则
①强制程度按 brief 装配：工具常驻可用，长任务（bootstrap 批次）强制、chat 轻量小任务可免（工具常在、纪律按任务配，TR-AD-61⑦）。②硬约束（模板层 LLM 不可裁）：强制 plan 的 brief 必含「先写 plan 再动手」+ 阶段转换必更新；closure 机械判据 = plan 全部 resolve（done 或 abandoned 带理由）。③接力恢复 = 新实例 brief 注入前序 plan 摘要（已完成项+note 事实+产物指针），产物指针让幂等重跑跳过已产。④存储 = helix.db work_item 表（任务四表新表域），子进程经 plan 工具直连写、父进程只读（表分域不竞争，WAL+busy_timeout 跨进程串行化）；任务删除时随任务一并清除（经 batch.instanceId 定位）。⑤阶段产物聚合 = 编排主 agent 聚合批次 plan+closure 写 stage.artifact（任务页阶段产物 tab 与 bootstrap 产出呈现区数据源）。

## 禁忌
为任务编排器新造专用台账工具与 chat 域分叉（双轨——统一写口是 AD-6 裁决核心）；把 plan 当 trace 记原始工具流（语义层级错乱）；closure 时 plan 留 pending 项也判收口成功（硬约束失守，编排器无法机械判批次成败）；父进程写 work_item 或子进程写 job/stage/batch（表分域写者越界）。

## 关系
纪律面由 TR-AD-61 governs；宿主 = 任务（E-任务，批次实例台账）与 E-AgentInstance（chat 域实例统一获益）；closure 收口判定与 E-ClosureRecord 协同（plan 全 resolve 是 closure 硬约束）；产物指针衔接 E-知识图谱（批次产出的节点 id 入 note）。
