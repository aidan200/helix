> 【过渡态·已迁入】v2 管道已停用 md 解析（SoT 下沉 .helix-kg/kg.db 单库，iter-20260825-11fo AF-21 终态；81 节点已于终验 kg-migrate --apply 迁入）；老版 phase runtime 仍解析本文件维护 v1 索引（.kg/kg.db，注入面）——终验新增/修订的 kg-node 块对老版注入有效，v2 侧以本文件为恢复基线（kg-migrate 幂等重建）。

> 【过渡态】v2 管道已停用 md 解析（SoT 下沉 .helix-kg 单库，iter-20260825-11fo AF-21 终态）；但老版 phase runtime 仍解析本文件维护 v1 索引（.kg/kg.db，注入面）——终验新增/修订的 kg-node 块（TR-AD-50+、E-知识图谱等）对老版注入有效。v2 单库启用时以 kg-migrate 幂等迁入（恢复基线：md 快照）。

```kg-node
id: TR-AD-1
kind: rule
graph: tech
layer: arch
scope: domain
stack: backend
name: daemon 六边形四层与依赖方向
status: active
digest: 写 daemon 代码、加 adapter、动分层边界时
derivedFrom:
  - AD-12
  - AD-17
  - AD-1（iter-20260821-dg90：packages/common 白名单例外）
  - H2.2（iter-20260821-dg90：组合根锚面扩 assembly/）
anchors:
  implementedBy:
    - apps/daemon/src/domain/
    - apps/daemon/src/application/
    - apps/daemon/src/adapters/
    - apps/daemon/src/infrastructure/
    - apps/daemon/src/infrastructure/assembly/
  testedBy:
    - apps/daemon/test/arch-guard/arch-guard.test.ts
relations:
  governs:
    - E-AgentRuntime
    - E-会话聚合
updatedIn: iter-20260825-11fo
```

## 规则
daemon 采用 DDD 六边形架构，固定四层目录与单向依赖：domain/（纯业务：会话聚合、轮次生命周期、steer/abort 语义、工具调用模型、workspace 分组；framework-free，禁止 import 外层任何模块与 pi 库符号——唯一例外 @helix/common：业务无关通用常量/纯工具经 AG-02① 白名单显式允许直引，@helix/protocol 与 pi 系仍禁，iter-20260821-dg90 AD-1）→ application/（ports/ 按 inbound/outbound 双向组织——inbound：AgentOrchestrationPort、SystemPort、ChatPort、ResourceConfigPort、SessionPort、ModelPort、SessionDirectoryPort 等（接口由 service 或组合根实现）；outbound：AgentEnginePort、SessionRepositoryPort、ToolExecutorPort、EventPublisherPort、ClockPort、AuthStorePort、DefaultModelPort、ModelCatalogPort、BrowserPort、ResourceStatePort、SkillSourcePort、RuntimeConfigPort + KnowledgeGraphPort、KnowledgeStorePort、CodegraphEnginePort 生效 15 个（iter-20260825-11fo 终验 L3 复核校正：kg 子系统新增三 port，读写分离见 TR-AD-50）+ services/：ChatService、SessionService、RestoreService、SchedulerService 及 kg 域服务族；只依赖 domain 与自有 port + 白名单三项（@helix/common——业务无关通用层直引，AD-1/iter-20260821-dg90；@helix/protocol——协议类型与纯投影消费（历史注记：MAIN_INSTANCE_ID 常量已随 T10c 实例 ID 统一退役删除，packages/common/constants.ts 空置，现为 AgentInstance.ts 与 protocol/projection/instance.ts 两处局部 LEGACY_MAIN_INSTANCE_ID 判别，iter-20260825-11fo 终验 L3 复核校正）；node:path——scheduler/ClosureRecorder 产物路径；以守护 AG-02② 白名单为准），禁止 import adapters 与 pi 库）→ adapters/（driving/：ws-server、cli，调用 inbound port；driven/：pi-engine 防腐封装、sqlite-session、tools、subagent、static-serve、cdp、sqlite-kg/kg 子系统存储域（iter-20260825-11fo 新增），实现 outbound port；adapter 之间禁止互相 import 绕过 application）→ infrastructure/（组合根：装配、配置、日志、进程生命周期；唯一允许 import 全部层的装配点；组合根锚面 = container.ts + infrastructure/assembly/**，AG-02④ 豁免面同口径）。新增代码先定层再写文件。

## 理由
六边形与 daemon「唯一事实源 + 端口适配」职责天然契合——pi 引擎/SQLite/WS 都是可替换端口（AD-12）；单向依赖保证防腐：换引擎、换存储、换前端均不动 domain 与 application（AD-17）；业务逻辑 framework-free 才能零依赖单测。iter-20260821-dg90 两处扩张均为机械跟随非语义反转：domain 白名单开 @helix/common 例外是 AD-1 裁决；组合根锚面从单文件扩为目录是 H2.2 拆分配套。

## 适用范围
apps/daemon 全部新增/修改代码的落位决策；新增任何 adapter 或 port 时；代码评审的分层检查项；动 infrastructure/assembly/ 装配函数、组合根豁免面或 DaemonOptions 生产/测试形态（createTestDaemon）时；packages/common 依赖边接入 domain/application 的白名单审查。

## 反例
application/services/ChatService 直接 import { Agent } from '@earendil-works/pi-agent-core' 驱动对话——绕过 AgentEnginePort，pi 升级即侵入 application（正确做法：经 outbound port 由 adapters/driven/pi-engine 实现）；或 domain import @helix/protocol——AG-02① 仍禁（白名单例外仅 @helix/common，协议类型经 adapter/projection 层转换）；或 infrastructure/assembly/ 之外的任何层 new 具体 adapter/service 实现——AG-02④ 红；或把测试注入口写回生产 DaemonOptions——两形态分离违例。

```kg-node
id: TR-AD-2
kind: rule
graph: tech
layer: arch
scope: domain
stack: backend
name: port 双向结构与零实现
status: active
digest: 新增或修改 port、接线 adapter 与 service 时
derivedFrom:
  - AD-17
  - AD-12
anchors:
  implementedBy:
    - apps/daemon/src/application/ports/
  testedBy:
    - apps/daemon/test/arch-guard/arch-guard.test.ts
relations:
  governs:
    - E-领域事件与单写队列
    - E-会话聚合
    - E-AgentRuntime
updatedIn: iter-20260825-11fo
```

## 规则
application/ports/ 按方向分两个子目录：inbound/（入口端口：接口由 service 或组合根实现——AgentOrchestrationPort 由 SchedulerService 实现、经 driven 编排工具回口调用；SystemPort 由组合根内联实现、driving ws-server 调用；ModelPort 由 ModelService 实现、SessionDirectoryPort 由 SessionRegistry 实现；ChatPort 由 ChatService 实现、ResourceConfigPort 由 ResourceService 实现、SessionPort 由 SessionService 实现）与 outbound/（出口端口生效 15 个：AgentEnginePort、SessionRepositoryPort、ToolExecutorPort、EventPublisherPort、ClockPort、AuthStorePort、DefaultModelPort、ModelCatalogPort、BrowserPort、ResourceStatePort、SkillSourcePort、RuntimeConfigPort + KnowledgeGraphPort、KnowledgeStorePort、CodegraphEnginePort（iter-20260825-11fo kg 子系统新增，读写分离承载见 TR-AD-50），由 service 调用；守护测试断言 ports 文件数 ≥9 为下限断言、与 15 兼容）。outbound port 的实现允许四类落位：driven adapter（pi-engine/sqlite-session/tools/sqlite-kg）、driving adapter（通知方向的标准形态——EventPublisherPort 的实现 EventStream/StdoutEventPublisher 落 driving 侧）、组合根内联（ClockPort 等纯技术 port 由 container 装配期实现）、infrastructure 纯技术文件 port（AuthStore——纯文件读写无 driving/driven 语义，落 infrastructure/auth-store.ts，AG-06③ 原子写白名单显式列名）、application service（EventPublisherPort 的会话投影实现 SessionProjection——fan-out 投影目标，经 container 装配进 publisherTargets）。port 文件只允许接口定义（类型与方法签名），不允许出现任何实现代码、工厂函数或实例化；port 契约的参数/返回类型只用 domain 模型或 port 自有类型（protocol DTO 转换发生在 ws-server adapter，见模型隔离规则）。

## 理由
port 是 adapter↔application 两个方向的唯一衔接契约（AD-17 条 2/3）；契约里混入实现即产生第二事实源，driving/driven 的可替换性（换 WS、换引擎、换存储）即刻失效。

## 适用范围
application/ports/ 目录全部文件；新增 driving/driven adapter 接线时；port 设计评审。

## 反例
AgentEnginePort.ts 里顺手写 `export function createDefaultEngine(): AgentEngine`——port 文件出现实现，应移到 adapters/driven/pi-engine。

```kg-node
id: TR-AD-3
kind: rule
graph: tech
layer: arch
scope: domain
stack: shared
name: 充血/贫血模型隔离与转换归属
status: active
digest: 定义 domain 聚合、写持久化行模型或 DTO 时
derivedFrom:
  - AD-17
  - AD-16
anchors:
  implementedBy:
    - apps/daemon/src/adapters/driven/sqlite-session/rows/RowMapper.ts
  testedBy:
    - apps/daemon/test/unit/session-mapper-roundtrip.test.ts
relations:
  governs:
    - E-会话聚合
updatedIn: iter-20260815-6tss
```

## 规则
application 与 adapter 之间禁止共用同一套模型：domain 内是充血模型（属性+行为，framework-free）；adapter 内是贫血模型（纯数据：sqlite-session 的持久化行模型、ws-server 的前端显示 DTO）。充血↔贫血的转换逻辑必须写在 adapter 内（转换器归属 adapter）；packages/protocol 的类型是前端显示贫血模型的家，由 ws-server adapter 使用并转换；domain 不 import protocol 类型；前端只消费 protocol DTO，不 import daemon domain。

## 理由
防腐三隔离：换引擎、换存储、换前端均不动 domain 与 application（AD-17）；protocol 作为共享内核只承载显示契约（AD-12 CL-2），避免前端与 daemon 内部模型锁死。

## 适用范围
domain 聚合定义；sqlite-session/ws-server 等 adapter 的模型与转换器；packages/protocol 类型设计；前端的类型 import 选择。

## 反例
sqlite-session 直接把 domain 会话聚合序列化入库（无行模型与转换器），或为省事在 domain 聚合上加 toRow()/toDTO() 方法——转换职责外泄进 domain。

```kg-node
id: TR-AD-4
kind: rule
graph: tech
layer: arch
scope: domain
stack: backend
name: 统一 AgentRuntime 扩展公式
status: active
digest: 加 profile、扩编排能力、动 runtime 装配时
derivedFrom:
  - AD-15
  - AD-3
relations:
  governs:
    - E-AgentRuntime
    - E-AgentProfile
    - E-HookSet
updatedIn: iter-20260815-6tss
```

## 规则
所有 agent 走同一条实现路径，扩展遵循固定公式：新编排能力 = 新 HookSet（钩子处理器组合）+ 新 AgentProfile（声明式规格），AgentRuntime 零改动。三层职责：AgentRuntime 是 daemon 唯一驱动层（组装 pi-agent-core 的 Agent、注入钩子语义、驱动执行、管理生命周期），不感知任何具体编排模式；AgentProfile 是声明式规格（kind、系统提示、工具集、钩子装配、生命周期策略：常驻多轮 vs 单轮收敛），主会话 = MainSessionProfile，M2 SubAgent = SubAgentProfile（新增 profile，不改 runtime）；HookSet 是可组合钩子处理器（beforeToolCall/prepareNextTurn/transformContext 三槽位 + bind() 装配回调（事件流处理器的实际承载面）+ SteerCapable steer/abort 能力面；shouldStopAfterTurn 为 pi 侧可用、helix 未接线的扩展位——iter-20260820-qhv8 终验 L3 复核校正），作用域（daemon 全局/workspace/agent 实例）是钩子处理器的属性而非目录结构。loop 本体（流式/工具批执行/截断）用 pi-agent-core 的 Agent+agentLoop 一行不重写，自建仅百行级驱动层；对 pi 库的 import 只允许出现在 adapters/driven/pi-engine。

## 理由
v1 的 MainAgent/SubAgent 双轨是 pi CLI 寄生限制的产物，v2 无此限制（AD-15）；循环所有权——编排内核的心脏不能长在别人身上，自建 = 方向盘和油门而非重造 loop（AD-3）；扩展公式保证 M2+（SubAgent/phase/kg）不碰 runtime 核心。

## 适用范围
domain 层 AgentProfile/HookSet 抽象设计；runtime 驱动层实现；M2+ 新增任何编排能力时的扩展路径评审。

## 反例
为 SubAgent 在 AgentRuntime 里加 `if (profile.kind === 'subagent')` 分支，或旁路 runtime 另写一套 SubAgent 驱动循环——v1 双轨复发。

```kg-node
id: TR-AD-5
kind: rule
graph: tech
layer: arch
scope: domain
stack: shared
name: 权威状态领域化与单写路径
status: active
digest: 动状态流、加持久化、处理重连恢复时
derivedFrom:
  - AD-16
anchors:
  implementedBy:
    - apps/daemon/src/adapters/driven/sqlite-session/WriteQueue.ts
    - apps/daemon/src/adapters/driving/ws-server/WsServerAdapter.ts
  testedBy:
    - apps/daemon/test/integration/sqlite-persistence.test.ts
    - e2e/CL-1-e2e-switch-state-isolation.spec.ts
relations:
  governs:
    - E-会话聚合
    - E-领域事件与单写队列
    - E-SteerQueue
updatedIn: iter-20260816-6q6f
```

## 规则
daemon domain 层持有全部权威状态（会话聚合 Entry 树/轮次、agent 生命周期状态、steer 队列、工具调用记录），framework-free；前端零权威状态，只是纯事件投影（WS 事件流→reducer→视图状态，本地仅存纯 UI 态如输入草稿/折叠）。落盘唯一路径是 write-through 单写队列：领域事件 → application 单写队列 → SQLite WAL（~/.helix/helix.db）；内存 = 磁盘的投影缓存，无第二事实源；流式中间态不落盘（崩溃丢当前流，恢复到最后一致里程碑，与 pi LaneRecord 同语义）。重连恢复 = daemon 推快照 + 续增量事件，禁止前端自恢复。domain 定义自己的聚合类型，pi 的 Entry/LaneRecord 经 adapters/driven/pi-engine 薄防腐映射，domain 不 import pi 类型。
per-session 帧章纪律（T5.1 热修沉淀，OI-VER-5 根因）：system.getStatus() 是系统级「当前会话」（注册表最近活跃会话投影）读面，仅限 welcome 单会话握手等自洽场景；per-session 帧（session.subscribe 快照、draft 建会话快照）禁止用它盖章——多会话下 current ≠ 目标会话即状态串台；per-session 帧章由 SessionStateView.agentState/model 随视图同源组装（SessionRegistry.buildView 从目标会话 runtime 直读，sessionStamp 每帧同源）。

## 理由
v1 双轨病根 = 前端状态副本 + DB 双写（F-2 desk 实锤）；D7 唯一事实源决策的领域层落地；write-through + WAL 让崩溃恢复语义简单（AD-16）。帧章同源是 per-session 状态语义（AD-2）的快照面延伸——全局投影盖 per-session 帧在多会话下必然串台（用户实机 OI-VER-5 实锤）。

## 适用范围
CL-8 持久化与恢复实现；CL-7 F(7).4 重连逻辑；任何新增领域状态的归属与落盘决策；WS 快照组装（welcome/session.snapshot/draft 建会话）的盖章数据源选择。

## 反例
前端把会话历史再存一份 IndexedDB 并做双向同步，或某 adapter 绕过单写队列直写 helix.db——第二事实源出现，重启后两边状态分叉；或 session.subscribe 快照的 agentState/model 取 system.getStatus()（全局最近活跃投影）——A 流式中切到空闲 B，B 显示 A 的状态（串台，E 层 switch-state-isolation 三面断言锁定）。

```kg-node
id: TR-AD-6
kind: rule
graph: tech
layer: arch
scope: domain
stack: backend
name: ~/.helix 主目录与 Paths 单点解析
status: active
digest: 加配置项、定位数据文件、解析任何路径、加壳→daemon env 注入参数或 subagent env 透传时
derivedFrom:
  - AD-13
  - AD-14
  - iter-20260823-6ps5 终验 L3 复核（TR-AD-6-l3）：例外款漏 subagent IPC 豁免族校正
  - iter-20260825-11fo 终验 L3 复核：例外族①补 HELIX_CODEGRAPH_PATH + .helix-kg 路径登记
anchors:
  implementedBy:
    - apps/daemon/src/infrastructure/paths.ts
    - apps/daemon/src/infrastructure/auth-store.ts
    - apps/daemon/src/adapters/driven/pi-engine/model-catalog.ts
    - apps/daemon/src/infrastructure/container.ts
    - apps/daemon/src/adapters/driven/subagent/child/ChildMain.ts
  testedBy:
    - apps/daemon/test/unit/paths.test.ts
    - apps/daemon/test/unit/config.test.ts
    - apps/daemon/test/unit/auth-store.test.ts
    - apps/daemon/test/arch-guard/arch-guard.test.ts
    - apps/daemon/test/integration/default-model.test.ts
relations:
  governs:
    - E-领域事件与单写队列
    - E-认证凭据
updatedIn: iter-20260825-11fo
```

## 规则
~/.helix 是 daemon 唯一配置/数据/日志主目录，全部自有状态进 home，不用环境变量：config.json（daemon 配置面：端口、调度预算等；模型数据面已迁出：provider API keys → auth.json、默认模型 → helix.db runtime_config KV 表、模型目录缓存 → models-store.json）、auth.json（provider 凭据，0600，格式见 TR-AD-7）、dev-token（CL-6）、logs/、helix.db（SQLite WAL）、models-store.json（ModelCatalog 落盘兑底）。所有业务路径解析收束于 infrastructure/paths.ts 单一模块：home 展开的跨平台处理、各文件相对 home 的定位；新增自有状态文件路径必须经 paths.ts 单点派生；支持可选 --home <dir> 启动参数覆盖（测试指向 tmp 目录用）。任何模块不得自行拼接 ~/.helix 子路径，也不得经环境变量取配置——两条例外族：①跨进程启动参数注入面（壳 → daemon 的 bundle 资源定位产物：HELIX_RG_PATH 与 HELIX_CODEGRAPH_PATH（iter-20260825-11fo AF-2 扩，AG-08 已同批断言三键）；及 rg/codegraph 三级解析探测对象 PATH）：读取收束于组合根 container.ts 单点，合法键集合由 arch-guard AG-08 机械断言；②subagent 父子进程 env IPC 面（adapters/driven/subagent/ 全目录：SubagentLauncher 写入 HELIX_* 定格快照 → ChildMain 子进程读取消费——传输通道非配置源，AG-08 白名单第二族）。两族新增键须同批扩守护断言与本款清单，工具/业务代码（两白名单外）维持零 process.env；壳零参与路径解析。项目级例外：kg 库路径 <projectRoot>/.helix-kg/kg.db 不进 ~/.helix home 域（按项目根持有，iter-20260825-11fo AF-21 裁决，库边界详见 TR-AD-50），是本规则唯一 project 级数据落点例外。

## 理由
单一事实源原则的文件系统延伸；daemon 全局单例（AD-7）与全局 home 目录天然对应；路径解析收束一处才 framework-free 可测试；模型数据面迁出 config.json 是 AD-2 落地的文件布局面。env 例外款（AF-2）：壳的 bundle 资源定位职责产物须跨进程送达 daemon，argv/env 是唯一合法启动面通道；不收束组合根单点则 env 读取散落 = 配置源分裂回潮。第二豁免族：subagent 父子 IPC 是传输通道非配置源。项目级 kg 库路径是唯一 project 级例外（AF-21 裁决，TR-AD-50 管辖）。

## 适用范围
CL-1 配置模块设计、CL-6 token 落点、CL-8 db 路径、测试注入 home 目录；任何新增自有状态文件的落点决策；模型模块文件布局评审；新增壳→daemon env 注入参数（跨进程启动面）评审与 AG-08 守护维护；subagent 父子 env 透传键新增（HELIX_* 定格值族）评审；container.ts 装配改动评审；kg 库路径/项目级数据落点评审（TR-AD-50 域）。

## 反例
ws-server adapter 里自己写 path.join(os.homedir(), '.helix', 'dev-token') 读 token，或用 process.env.HELIX_DB 指定数据库路径——绕过 paths.ts 单点，--home 覆盖对它失效；或 rg-backend.ts 直接 process.env.HELIX_RG_PATH 取值——env 读取散落出组合根单点，AG-08 红；或在 subagent/ 白名单目录外（如 services 层）读 HELIX_THINKING_LEVEL——第二豁免族读取限该目录，越出即 AG-08 红。

```kg-node
id: TR-AD-7
kind: rule
graph: tech
layer: arch
scope: domain
stack: backend
name: pi 库使用红线
status: active
digest: 接模型 provider、加工具、import pi 符号时
derivedFrom:
  - AD-2
  - AD-10
  - AD-11
  - AD-12（iter-20260825-11fo 方案 C：自写 edit+read，write/bash 保留 pi）+ AF-1
anchors:
  implementedBy:
    - apps/daemon/src/adapters/driven/pi-engine/
    - apps/daemon/src/adapters/driven/tools/
    - apps/daemon/src/adapters/driven/subagent/
  testedBy:
    - apps/daemon/test/arch-guard/arch-guard.test.ts
    - apps/daemon/test/integration/tools-edit-parity.test.ts
relations:
  governs:
    - E-AgentRuntime
    - E-模型目录
    - E-认证凭据
updatedIn: iter-20260825-11fo
```

## 规则
daemon 运行时依赖仅限 @earendil-works/pi-agent-core 与 @earendil-works/pi-ai 两包，零 pi-coding-agent import。工具集 = pi 内置 bash/write（保留不自写，AD-12）+ 自写 read/edit 同名覆盖 + edit-lines（行锚编辑，expectedText 校验；三件均复用 VENDORED 内核，详见 TR-AD-55，CoreToolExecutor 按注册序同名覆盖后注册者胜）+ 自写 grep + web 族（web_search/web_fetch 静态注册 + browser 条件注册薄转投 BrowserPort，tools/web/）+ 编排四工具（agent_spawn/agent_send/agent_status/agent_inspect，tools/agent/AgentOrchestrationTools 薄转投 AgentOrchestrationPort，注册进 MainSessionProfile）+ kg/kg-update 双工具（iter-20260825-11fo 新增：kg 查询面只读 search/get 与 kg-update supersede/落账写面，tools/kg/）。pi 库 import 只允许出现在 adapters/driven/pi-engine、adapters/driven/tools（工具接线域：core Tool 接口/ExecutionEnv 封装的必然导入，AD-10 工具封装条款；VENDORED 复制件收口于 tools/edit/kernel/，不新开 pi import）与 adapters/driven/subagent（SubAgent 子进程形态：launcher 透传 Model、child 复用 pi-engine 防腐墙、剧本引擎用 pi-ai 流原语；守护测试 AG-04 三根同口径）。import 通道红线：真实 provider 必须经 `@earendil-works/pi-ai/providers/all` 子路径；Node 执行环境必须经 `@earendil-works/pi-agent-core/node` 子入口。模型接入 = pi-ai + 显式凭据（凭据存 ~/.helix/auth.json：Record<providerId, type-tagged Credential 联合>，0600 + pid 文件锁 + 原子写，详见 E-认证凭据），弃 pi 的 SettingsManager 体系；模型能力来源 = daemon 自实现 ModelCatalog（builtin 静态表 + pi.dev overlay 合并，ETag 条件刷新/4h 缓存/防降级/落盘兑底，详见 E-模型目录）；默认模型存 SQLite runtime_config KV 表 default_model 键（非 config.json）。

## 理由
extension 身份是 v1 兼容成本根源，pi 降为库（AD-2）；F-7 实读证明 core 已自带工具（AD-10）；依赖最小化既定原则；主入口/子入口陷阱是 pi 源码实读结论。iter-20260825-11fo：edit 失败率 7.1%（F-16）驱动自写三件（AD-12），pi 内核纯函数因 exports 白名单无法 import 改 VENDORED 复制收口（AF-1 裁决，详见 TR-AD-55）。

## 适用范围
新增任何 pi 相关依赖或 import、接模型 provider、实现工具集、评审 adapters/driven 的 pi-engine/tools/subagent 三域；pi-agent-core 升级（VENDORED 重复制+平权，TR-AD-55）。

## 反例
从 pi-ai 主入口 import 模型工厂（side-effect-free 导出为空实现，运行时才炸），或为省两行代码 import pi-coding-agent 的 write 工具工厂；或在 tools/ 域外新开 pi import 接内核函数（应经 tools/edit/kernel 复制件，TR-AD-55）。

```kg-node
id: TR-AD-8
kind: rule
graph: tech
layer: arch
scope: domain
stack: frontend
name: 前端 FSD 五层与主题/i18n 纪律
status: active
digest: 写前端组件、动路由/导航壳/布局壳、搬 desk 切片、加文案或主题时
derivedFrom:
  - AD-12
  - AD-18
  - AD-1（M4 导航框架范围：只做框架不做填充）
  - CL-4 裁决（M4：Q-4a IconRail 形态 / Q-4b 六页签与路径路由 / Q-4c 占位施工牌）
  - S1-S4 布局统一用户裁决（2026-08-21）
  - iter-20260825-11fo V-3 裁决（project 页实页化：P-1 单页 master-detail 图谱查看）
anchors:
  implementedBy:
    - apps/shell/src/app/route.ts#routeOfPath
    - apps/shell/src/app/useAppRoute.ts
    - apps/shell/src/app/App.tsx
    - apps/shell/src/widgets/nav-rail/ui/IconRail.tsx
    - apps/shell/src/widgets/app-layout/ui/AppLayout.tsx
    - apps/shell/src/pages/P-1/
  testedBy:
    - apps/shell/src/app/route.test.ts
    - apps/shell/src/widgets/app-layout/ui/AppLayout.test.tsx
    - apps/shell/src/tests/ag-scans.test.ts
relations:
  governs:
    - E-会话聚合
updatedIn: iter-20260825-11fo
```

## 规则
前端采用标准 FSD 五层（app/pages/widgets/features/entities + shared）；WS 客户端落 shared/api（transport 缝隙集中于此）；Cyber HUD 设计 token 落 shared/ui：CSS 变量 :root 唯一真源 + rgb(var(--x)/<alpha-value>) alpha 修饰符模式；原子组件自持有（shadcn 哲学）。主题用注册表机制：每主题 = 同名语义 token 变量块不同值（暗色挂 :root 为默认，追加主题以 html class 挂载）；主题是纯前端 concern，daemon 无主题概念；用户偏好 localStorage 持久化（helix-theme 键，AG-14 白名单）。文案全 key 纪律：P-1 页面所有 UI 文案走搬入的 desk 轻量 i18n（React context + localStorage 持久化 + navigator.language 检测，zh-CN/en-US 双语言包），无硬编码文案。
页面域与会话域分离：路由层（app/route.ts + useAppRoute + IconRail 导航壳）表达页面域（五页签 chat/skills/trace/project/settings 终态；手写路径路由 / /skills /trace /project /settings；未知路径回落工作台）；SessionProvider 及其内表达会话域；SessionProvider 在路由层之上（切页零 WS 影响），IconRail 不读会话 store、会话域组件不感知路由状态。chat 页常驻 DOM（route-layer + data-route display 切换保流式），其余页条件渲染离开卸载。统一布局壳（task-20260821-s1s4 用户裁决）：全部页面共用 widgets/app-layout AppLayout；页面滚动只发生在 layout-main，页面禁自建页壳/自开整页滚动。IconRail 品牌位 = HelixLogo 渐变图标、主题切换单钮置 rail 底部；scanline 氛围层 App 层全局单份。各页 sidebar 语义自决：chat = 会话清单（可折叠）、trace = 上下分区、settings = 分区导航、project = 项目域两段（项目列表+工作树占位，iter-20260825-11fo V-3 实页化：P-1 单页 master-detail——左栏选中后折叠窄轨，主区四态状态机图谱查看，pages/P-1/ 十文件，无 /kg 路由无跳转）。页面回填 additive：未来功能页填充不动导航壳与路由骨架。占位施工牌 ConstructionBoard 已随 project 实页化退役（全仓零引用死代码，待清理裁决——iter-20260825-11fo 终验 L3 复核发现）。

## 理由
desk 前端本就 FSD 五层，切片搬运成本最低；desk i18n 方案已验证且轻量；daemon 是开发者面向、统一中文不做 i18n（AD-18）；主题注册表避免后期主题级调整侵入每个组件。M4 AD-1 + Q-4a/b/c：框架先行解耦交付；域分离是「chat 页常驻 DOM 保流式」与「页面自由扩展」两个不变量的结构基础。iter-20260825-11fo V-3：project 页实页化（单页 master-detail，用户二次裁决推翻两级跳转形态）——五页签全部实页，占位施工牌时代结束。

## 适用范围
CL-7 前端聊天流切片搬运与 P-1 页面开发；新增任何前端组件、文案、主题 token；shared/api 的 WS transport 改造；填充或演进任何页面（五页签全部实页化：chat/skills/trace/project/settings）；动 App.tsx 装配序或路由常量；IconRail/导航壳/AppLayout 统一壳与 sidebar 槽演进评审。

## 反例
组件里写死「发送」二字不走 i18n key，或卡片组件内硬编码 rgb(0,255,255) 色值绕过主题变量——换主题即漏色。新功能页组件 import 会话 store 内部（页面域污染会话域）；或页面填充时改 IconRail 骨架/路由结构（回填必须 additive）；或把 IconRail 放进 SessionProvider 内部依赖活跃会话渲染；或新页面自建页壳/自开整页滚动容器绕过 AppLayout。

```kg-node
id: TR-AD-9
kind: rule
graph: tech
layer: convention
scope: domain
stack: backend
name: service 编排职责与中文注释
status: active
digest: 写 application service、评审编排逻辑时
derivedFrom:
  - AD-17
  - AD-18
anchors:
  implementedBy:
    - apps/daemon/src/application/services/ChatService.ts
  testedBy:
    - apps/daemon/test/unit/chat-service.test.ts
relations:
  governs:
    - E-SteerQueue
    - E-会话聚合
updatedIn: iter-20260815-6tss
```

## 规则
所有逻辑编排在 application/services/ 的 service 中完成（ChatService/SessionService/RestoreService…）；service 只关注业务流转与执行逻辑，不关心具体实现——一切外部能力（引擎/存储/工具执行）经 outbound port 调用，driving adapter 保持薄壳。service 实现必须附详细中文注释，面向业务流转与执行逻辑（步骤意图、流转条件、异常路径）。daemon 侧日志与错误消息统一中文（与注释同语系），不做 i18n。

## 理由
用户在 grilling 声明的架构纪律（AD-17 条 1/6）；编排集中让 adapter 可替换、业务流转可读；daemon 是开发者面向，中文统一降低维护成本（AD-18）。

## 适用范围
application/services/ 全部实现；service 代码评审检查项；daemon 日志/错误消息文案。

## 反例
ws-server adapter 的 message handler 里就地编排「查会话→调引擎→写事件→推 WS」全流程（编排泄漏进 driving adapter），或 ChatService 只写一行 `// orchestrate the chat` 英文注释交差。

```kg-node
id: TR-AD-10
kind: rule
graph: tech
layer: arch
scope: domain
stack: shared
name: 壳是薄监督者，业务不回流壳
status: active
digest: 搬 Rust 资产进壳、写壳侧代码、接 Tauri 打包时
derivedFrom:
  - AD-4
  - AD-5
anchors:
  implementedBy:
    - apps/shell/src-tauri/
    - apps/daemon/src/adapters/driving/ws-server/WsServerAdapter.ts
relations:
  governs:
    - E-AgentRuntime
updatedIn: iter-20260823-6ps5
```

## 规则
Tauri 壳承载监督者职责——已落地三类 + 一类规划位：进程看护（sidecar spawn/重启——sidecar 异常退出时壳检测并重启恢复或给明确错误提示，重启须先释放旧单例锁或检测陈旧锁，TR-AD-11 同口径）、窗口管理、bundle 资源定位（sidecar 二进制/前端静态产物/捆绑三方二进制 rg——iter-20260822-m1uc 落地扩面）；trust（desk 现成 Rust 资产按此边界搬运）为规划位（未落地，src-tauri 零代码承载——iter-20260823-6ps5 终验 L3 复核校正，搬运启动时再落地）。壳与 daemon 的 stdio 只走生命周期信号，包内资源路径经 sidecar 启动参数注入 daemon（进程启动面，非业务通道）。desk Rust 侧的 RPC 桥、SQLite、watcher、kg 查询等业务职责全部归 daemon（TS），禁止搬运回壳；壳需要任何业务数据一律经 WS 协议（127.0.0.1:port + token）向 daemon 查询。壳不解析业务路径（路径切面见 TR-AD-6）。

## 理由
AD-4（daemon 即后端，Rust 业务层消解）：常驻 TS 编排进程既定，Rust 业务耦合最重的部分已有了更好归宿；壳做业务 = Rust 业务回流 + dev 期（壳缺席，AD-8）功能双轨——同一功能打包形态有、开发形态无。v1 desk 的 Rust 10.8k LOC 桥接层是已验证的反面教材。iter-20260822-m1uc 落地：职责清单显式化（bundle 资源定位独立成面，rg 与 sidecar/前端产物同归此面），监督者语义不变。trust 规划位保留搬运边界宣示但不作现状宣称（零承载即零宣称，防审计者按文找码落空）。

## 适用范围
src-tauri 壳实现与 sidecar 打包链路；任何壳侧新增 Rust 代码的职责边界评审；壳与 daemon 通信面设计；包内资源定位注入通道评审；sidecar 崩溃看护重启逻辑评审；trust 资产搬运启动决策时（规划位落地即撤标注）。

## 反例
搬 desk 的 Rust SQLite 查询代码进 src-tauri 供托盘「历史会话」菜单用——业务回流壳：dev 形态（无壳）下该功能不存在，双形态行为分叉；正确做法是经 WS session.subscribe 获取快照数据。或壳侧自行 spawn rg 做检索而不经 daemon——检索是业务职责，回流壳即 dev 形态功能缺失；壳只负责把 rg 包内路径注入 daemon，调用归 daemon grep 域。把 trust 规划位当现状宣称（「壳已承载 trust」）——零承载零宣称。

## 规则
Tauri 壳只承载四类监督者职责：进程看护（sidecar spawn/重启——sidecar 异常退出时壳检测并重启恢复或给明确错误提示，重启须先释放旧单例锁或检测陈旧锁，TR-AD-11 同口径）、窗口、trust（desk 现成 Rust 资产按此边界搬运）、bundle 资源定位（sidecar 二进制/前端静态产物/捆绑三方二进制 rg——iter-20260822-m1uc 落地扩面）；壳与 daemon 的 stdio 只走生命周期信号（ready/token），包内资源路径经 sidecar 启动参数注入 daemon（进程启动面，非业务通道）。desk Rust 侧的 RPC 桥、SQLite、watcher、kg 查询等业务职责全部归 daemon（TS），禁止搬运回壳；壳需要任何业务数据一律经 WS 协议（127.0.0.1:port + token）向 daemon 查询。壳不解析业务路径（路径切面见 TR-AD-6）。

## 理由
AD-4（daemon 即后端，Rust 业务层消解）：常驻 TS 编排进程既定，Rust 业务耦合最重的部分已有了更好归宿；壳做业务 = Rust 业务回流 + dev 期（壳缺席，AD-8）功能双轨——同一功能打包形态有、开发形态无。v1 desk 的 Rust 10.8k LOC 桥接层是已验证的反面教材。iter-20260822-m1uc 落地：三类职责扩为四类（bundle 资源定位显式化，rg 与 sidecar/前端产物同归此面），监督者语义不变。

## 适用范围
src-tauri 壳实现与 sidecar 打包链路（原 M3 规划，iter-20260822-m1uc 首次落地执行）；任何壳侧（src-tauri/）新增 Rust 代码的职责边界评审；壳与 daemon 通信面设计；包内资源（rg 等三方二进制）定位注入通道评审；sidecar 崩溃看护重启逻辑评审。

## 反例
搬 desk 的 Rust SQLite 查询代码进 src-tauri 供托盘「历史会话」菜单用——业务回流壳：dev 形态（无壳）下该功能不存在，双形态行为分叉；正确做法是经 WS session.subscribe 获取快照数据。或壳侧自行 spawn rg 做检索而不经 daemon——检索是业务职责，回流壳即 dev 形态功能缺失；壳只负责把 rg 包内路径注入 daemon，调用归 daemon grep 域。

```kg-node
id: TR-AD-11
kind: rule
graph: tech
layer: arch
scope: domain
stack: backend
name: daemon 全局单例与幂等锁
status: active
digest: 写 daemon 生命周期、加进程入口、处理二启/多实例时
derivedFrom:
  - AD-7
anchors:
  implementedBy:
    - apps/daemon/src/infrastructure/lifecycle.ts
    - apps/daemon/src/infrastructure/container.ts
  testedBy:
    - apps/daemon/test/integration/singleton-process.test.ts
    - apps/daemon/test/integration/singleton.test.ts
relations:
  governs:
    - E-领域事件与单写队列
updatedIn: iter-20260815-6tss
```

## 规则
daemon 是全局单例进程（不是 per-workspace daemon）：同一 home（默认 ~/.helix，可 --home 覆盖）下二次启动必须被幂等单例锁拒绝（锁文件落 home 内，acquireSingletonLock fail-fast）；workspace 是 daemon 内部分组概念，禁止以多开 daemon 进程实现多 workspace。所有 daemon 启动路径共用 createDaemon 组合根（锁语义唯一实现点），新增入口不得绕过。

## 理由
AD-7（daemon 全局单例）：唯一事实源与 SubAgent 全局并发预算都要求单例；per-workspace daemon = N 个 helix.db、N 份 dev-token/端口，事实源分裂。锁经 home 定位使 --home 测试隔离天然获得独立锁域。

## 适用范围
infrastructure/lifecycle.ts 及任何生命周期改动；新增 daemon 启动入口/运行模式；M3 sidecar 看护重启逻辑（重启须先释放旧锁或检测陈旧锁）。

## 反例
为同时开发两个 workspace 起两个 daemon 进程各绑一个目录——两份 helix.db 与恢复语义分叉；正确做法是单 daemon + workspace 分组（协议 WorkspaceRoute 预留位）。

```kg-node
id: TR-AD-12
kind: rule
graph: tech
layer: arch
scope: domain
stack: shared
name: 双形态零迁移：前端永远连 127.0.0.1:port+token
status: active
digest: 接壳 WebView、配打包部署、写前端连接配置时
derivedFrom:
  - AD-8
  - AD-9
anchors:
  implementedBy:
    - apps/shell/src/shared/api/helix-ws.ts
    - apps/daemon/src/adapters/driving/ws-server/WsServerAdapter.ts
    - apps/shell/src-tauri/
  testedBy:
    - e2e/CL-6-CL-7-dual-base.spec.ts
relations:
  governs:
    - E-会话聚合
updatedIn: iter-20260822-m1uc
```

## 规则
前端（浏览器 dev 形态与 Tauri WebView 打包形态同构）连的永远是 daemon 的 WS 端点 127.0.0.1:port + token，容器形态对 daemon 不可见。禁止为任一形态开设特化通道：不得用 Tauri invoke 直调 daemon、不得在壳内嵌 HTTP 直连绕过 WS 协议、不得按形态分支连接逻辑。协议面（packages/protocol）是两种形态的唯一契约；dev token 经 daemon 端点 GET /helix-dev-token（loopback Origin 反射 ACAO）获取，两种形态同一通路。iter-20260822-m1uc 落地补全 daemon 侧互补面：daemon 自身也是双运行形态（dev = bun 直跑源码 / 打包 = compile sidecar），daemon 行为同样不得按形态分叉（详见 TR-AD-35「daemon 双运行形态同构」）。

## 理由
AD-8（monorepo 单仓，开发/打包双形态零迁移）：连接方式完全一致是零迁移的结构保证；任何形态特化通道都会造成 dev/打包行为分叉，且打破 AD-16 前端纯投影（WS 事件流是唯一领域状态入口）。双基线行为指纹一致（TP-CL6-7 E2E）是该约束的验收形态。

## 适用范围
Tauri 壳 WebView 接线与 externalBin/sidecar 配置（原 M3 规划，iter-20260822-m1uc 首次落地执行）；apps/shell shared/api 连接配置；打包链路（bun build --compile / vite build / tauri build）评审；dev 形态编排（dev:desktop 三进程编排）与打包形态的行为一致性评审。

## 反例
打包形态下为「省一层 WS」让前端经 Tauri invoke 直调 daemon 内部函数——dev 形态无此通道，双基线守护（TP-CL6-7）的行为指纹即刻分叉，且绕过了协议版本握手；或为打包形态在 daemon 侧开形态检测分支改变启动行为——daemon 侧双轨，与前端面同构约束同一违例族。


```kg-node
id: TR-AD-13
kind: rule
graph: tech
layer: arch
scope: domain
stack: backend
name: 单写通道模式（进程内唯一写点）
status: active
digest: 写任何落盘通道、加持久化写路径、做产物文件写入时
derivedFrom:
  - AD-5
anchors:
  implementedBy:
    - apps/daemon/src/adapters/driven/sqlite-session/WriteQueue.ts
  testedBy:
    - apps/daemon/test/integration/sqlite-persistence.test.ts
    - apps/daemon/test/arch-guard/arch-guard.test.ts
relations:
  governs:
    - E-领域事件与单写队列
updatedIn: iter-20260821-dg90
```

## 规则
进程内任何「唯一写点」场景（领域事件落盘、未来的产物文件写入通道）一律复用 WriteQueue 单写通道模式：分仓 FIFO + 全局链串行化保证顺序（sessionTails 每会话仓内严格 FIFO、仓间互不阻塞；无会话维 job 走 globalTail 全局链——AD-4 演进落位，iter-20260821-dg90 终验 L3 复核校正「单链 FIFO」旧表述）；onError 不中断链（单条失败可观测、队列存活继续消费）；close = drain 排空 + 关闭且幂等。禁止在队列之外直写 SQLite/文件（写路径唯一由守护测试 AG-06 扫描固化）。新写点接入 = 往同一队列追加 handler，不开第二条队列。

## 理由
T1.8 实证模式：事件顺序即事实源顺序（TR-AD-5 恢复语义的前提）；多写点必然产生交错与半写状态；分仓 FIFO + 不断链 + 幂等 close 三件套是崩溃一致性的最小实现（无外部依赖）。

## 适用范围
apps/daemon 任何新增持久化/文件写入路径；WriteQueue 自身维护；M2+ 产物文件写入通道设计。

## 反例
service 为省一次排队直接 db.insert 写 domain_events——绕过队列后守护测试 AG-06 红，且崩溃时事件交错顺序不可重建。

```kg-node
id: TR-AD-14
kind: rule
graph: tech
layer: arch
scope: domain
stack: backend
name: RowMapper 充血↔贫血转换模板
status: active
digest: 加行模型映射、写持久化 DTO 转换、引入 pi-session-backend 时
derivedFrom:
  - AD-5
anchors:
  implementedBy:
    - apps/daemon/src/adapters/driven/sqlite-session/rows/RowMapper.ts
  testedBy:
    - apps/daemon/test/unit/session-mapper-roundtrip.test.ts
    - apps/daemon/test/integration/sqlite-persistence.test.ts
relations:
  governs:
    - E-会话聚合
updatedIn: iter-20260815-6tss
```

## 规则
domain 聚合（充血）与 SQLite 行模型（贫血）之间的转换一律经 RowMapper 模板（sqlite-session/rows/RowMapper.ts 为范本）：toRow(domain)→行模型（JSON 字段显式序列化、时间戳统一口径）；fromRow(row)→domain（默认值兜底 + 前向兼容）；行模型不外泄出 driven adapter（domain 层零感知存储形态，TR-AD-3 模型隔离）。往返一致性必须有专项单测（session-mapper-roundtrip 同构）。未来引入 pi-session-backend 时按此模板复制 RowMapper，不共用行模型。

## 理由
T1.8 实证模式：聚合演进不改 schema 面即可控；转换集中一处可被 roundtrip 单测机械守护；TR-AD-3 转换归属 adapter 在持久化切面的具体化。

## 适用范围
新增/修改任何 SQLite 表与行模型；pi-session-backend 若引入时；持久化 schema 演进评审。

## 反例
service 读出行后手工 new Session(...) 散落三处——schema 加一列要改三个调用点，且漏改处静默用默认值。

```kg-node
id: TR-AD-15
kind: rule
graph: tech
layer: arch
scope: domain
stack: shared
name: AgentInstance 一等概念与 instanceId 全链路
status: active
digest: 写领域事件或聚合 Entry、加协议事件字段、做实例分段渲染、动用户干预通道时
derivedFrom:
  - AD-3
  - AD-1
  - CL-3 裁决（M4：Q-3a 消息双处可见 / Q-3b 抽屉输入栏）
  - AD-5（M4 契约 v0.3 一次定形）
anchors:
  implementedBy:
    - apps/daemon/src/adapters/driving/ws-server/EntryDtoMapper.ts#isMainAxisEntry
    - apps/daemon/src/adapters/driving/ws-server/SnapshotMapper.ts#instanceChannels
    - apps/daemon/src/domain/session/Session.ts#applyDirectedSteer
    - apps/shell/src/widgets/chat-stream/ui/MessageFlow.tsx
    - apps/shell/src/entities/session/model/session-reducer.ts
  testedBy:
    - apps/daemon/test/unit/chat-service.test.ts
    - apps/shell/src/entities/session/model/session-reducer-drawer.test.ts
    - apps/daemon/test/integration/ws-server-spy.test.ts
relations:
  governs:
    - E-AgentInstance
    - E-会话聚合
    - E-领域事件与单写队列
    - E-SteerQueue
updatedIn: iter-20260818-mq5a
```

## 规则
主会话实例与 SubAgent 同为 AgentInstance（domain/agent/AgentInstance：instanceId、kind: "main"|"subagent"、profileKind、sessionId、实例状态机、createdAt），机制同构——同 AgentRuntime 驱动、同 AgentProfile 声明机制、同事件通道、同 trace/统计/持久化路径；编排分层只经 profile 生命周期声明表达（main = persistent 常驻多轮、用户对话锚点，re-profile 时销毁重建；subagent = single-shot 单轮收敛、closure 回主线后销毁）。「同构」只发生在机制层，禁止按 kind 分叉任何机制通道。
每条领域事件与聚合 Entry（消息/工具调用/thinking/compaction）一律挂 instanceId；持久化兑现 trace 四维查询 session × instance × type × time：domain_events 增 agent_instance_id 列 + 索引（agent_kind 保留为冗余快速过滤维度）、agent_lifecycle 主键扩为 (session_id, instance_id)、tool_calls 增实例归属列；协议信封 Envelope 增可选 instanceId? 字段，缺省 = 主实例（向后兼容），快照增 instances 实例清单。
SubAgent 实例的 instanceId 即 agent_spawn 返回、agent_send/agent_status/agent.kill 寻址的 agentId（同一标识空间的两个视角，分配即定）；主实例在会话创建时分配固定 id。
会话聚合与 agent 实例窗口分离（三层模型）：聚合是全历史 Entry 树、跨实例持续追加（UI/持久化单位，实例切换或收口时不重建）；实例窗口是 LLM 上下文、销毁重建（执行层全切、交接层受控注入、显示层连续）。实例创建/销毁/re-profile 是一等操作，调度器与状态机不得假设一个会话单实例线性推进。聚合 Entry 树含 SubAgent 归属条目（Entry.instanceId；经会话投影 SessionProjection 落树；恢复重放进快照 entries——RestoreService.replaySubAgentHistory，agent_kind=subagent 事件流补齐）。
UI 时间线按实例分段：主线视图默认只渲染主实例 Entry + SubAgent 卡片 + 里程碑标记，抽屉视图 = 按实例过滤的全流（全流载体 = 聚合 Entry per-instance channel + 恢复重放，SubAgent 历史含在内）；重启后恢复实例骨架/closure/账目/SubAgent 全流历史。
用户干预消息同构落 Entry：chat.steer 产生的用户干预消息（缺省主实例 / 定向实例）一律落 Entry（标注目标实例 instanceId）经会话投影进时间轴，恢复重放完整保留干预历史；定向路径复用 agent_send 通道（ChatService 判定 instanceId → AgentOrchestrationPort.send → InstanceRunner → transport → 子进程 Agent.steer()），路由判定归 application service、driving adapter 只透传；不设「不投影」例外通道（旁路直投实例流不进聚合 = 干预历史在恢复重放中消失）。UI 双处可见：主线时间轴定向消息轻量渲染 + 抽屉实例 feed；协议面仅 ChatSteerPayload 扩可选 instanceId（缺省 = 主实例，additive）。

## 理由
F-12 实锤现状只有 agent_kind 无实例 id，同类型多实例不可区分、协议事件无任何 agent 标识（单 agent 假设）；主会话即使不 spawn SubAgent 也会因 re-profile 存在多实例（用户在 grilling 指出）。机制同构才能统一 trace/统计/事件通道（AD-3）；聚合与窗口分离是相位模式在 v2 重新生长的地基（AD-1），M2 主实例 + N 个 SubAgent 已在事实层面运行该模型。M4 CL-3（Q-3a）：主 Agent steer 既有落 Entry 投影语义（M2），定向 SubAgent steer 同构才不产生「部分干预可回放、部分不可回放」的历史分叉；复用 agent_send 通道是机制同构（TR-AD-4 扩展公式）的又一次运用——零新通道。

## 适用范围
M2+ 写任何领域事件、聚合 Entry、持久化 schema（domain_events/agent_lifecycle/tool_calls）时；协议事件/快照字段扩展时；SubAgent 编排（调度/收口/kill 寻址）实现时；UI 时间线实例分段与抽屉过滤渲染时；trace 四维查询与账目分实例统计时。schema 列级演进走建表幂等 + 守护式补列，RowMapper fromRow 默认值兑底（TR-AD-14 同口径）。M4+ 写任何用户干预入口（主 Composer / 抽屉输入栏 / 未来 phase 干预面）；动 steer 路由或 SteerQueue 注入链路；定向消息渲染；恢复重放验证干预历史完整性的测试面。

## 反例
领域事件只带 agent_kind 不带 agent_instance_id——两个并行的 subagent-worker 事件流、账目、抽屉内容全部串台不可区分；或 SchedulerService 给 SubAgent 另建一条事件通道/另一套持久化路径（「同构」退化为双轨）；或 UI 把所有实例 Entry 平铺进主线聊天流——SubAgent 内部工具调用刷屏主线，违背隔离初衷。定向 steer 走旁路通道直投子进程 stdin 而不落 Entry（干预历史在恢复重放中消失）。

```kg-node
id: TR-AD-16
kind: rule
graph: tech
layer: arch
scope: domain
stack: backend
name: SubAgent 调度预算与排队语义
status: active
digest: 写调度或并发预算代码、扩编排工具、动排队与 stalled 判定时
derivedFrom:
  - AD-7
  - AD-5
relations:
  governs:
    - E-调度器
    - E-AgentInstance
updatedIn: iter-20260816-uzvg
```

## 规则
预算语义：maxConcurrent=3 为 daemon 全局运行中 SubAgent 实例上限（config.json 可配，缺省 3；全局预算依赖 daemon 全局单例，per-workspace 多开会使预算碎片化）；超限请求不拒绝不抛错，FIFO 入队（maxQueued=8），queued 状态事件（含位次）推 UI；队列达上限才向 LLM 报错（预算真实耗尽）——排队语义取代 v1 的并发抛错。
超时分级：idle > 5min 无事件增量 → stalled 警示事件推 UI（警示不自动杀，可恢复继续 running）；hard 无上限不自动杀；终止权手动在用户（抽屉 kill 按钮 → agent.kill 命令 → launcher 终止；信号序列待开发裁决 O-6）。优先级本迭代不做（无竞争场景），M4 DAG 依赖调度时引入。
编排三工具注册进 MainSessionProfile 工具集：agent_spawn(task, profile?)（预算判定后秒回 {agentId, spawned} 不挂起当前 turn，超限返回 queued 事实——异步交付语义见 TR-AD-17）、agent_send(agentId, msg)（经 transport 转投目标实例 Agent.steer()，内建队列使 send-kill 链从根上消失）、agent_status(agentId?)（无参返回全部实例概要、有参单实例详情）。
非线性红线：实例创建/销毁/re-profile 是一等操作；队列与状态机对「任意实例任意时刻到达任意状态」保持正确，不假设线性推进。
落位分层：SchedulingPolicy 为 domain 纯语义（预算/上限/stalled 阈值，纯数据 + 判定，可零依赖单测）；SchedulerService 为 application 编排（预算判定/出队/stalled 监视/closure 收口/账目扇出）；编排工具实现只 import inbound AgentOrchestrationPort 接口（与 ws-server 调 inbound port 同一模式，引用由组合根注入），不 import 任何其他 adapter。

## 理由
AD-7 整包裁决：v1 超限抛错问题（F-3②）由排队语义消除；自动杀误伤成本 > 保守等待，故 stalled 只警示；优先级无真实竞争场景不预做。AD-5 承载性约束④要求调度器不假设线性推进，为 M4 DAG/phase 状态机预留正确性。

## 适用范围
M2+ 调度器/池/队列实现与评审；编排工具（agent_spawn/send/status）扩展；SubAgent 并发行为调参（maxConcurrent/maxQueued/stalled 阈值经 config.json 配置）；M4 DAG 依赖调度生长时的基线约束。SubAgent 子进程启动形态（O-7）与 kill 信号序列（O-6）待开发裁决，不在此规则化。

## 反例
spawn 超过 3 个运行实例即向 LLM 抛并发错误——v1 抛错行为复发，排队语义被绕过；或 stalled 5 分钟后自动 SIGKILL「清理僵尸」——误伤合法长任务（如长时间 bash 编译），终止权已裁在用户；或在编排工具实现里直接 import SubagentLauncher 驱动子进程——adapter 间互相 import 绕过 application，编排泄漏。

```kg-node
id: TR-AD-17
kind: rule
graph: tech
layer: arch
scope: domain
stack: shared
name: closure 双通道分发与通知/正文分层（reportPath 原值透传+findings 落账）
status: active
digest: 动 closure 收口或注入链路、写 SubAgent 完成卡片时
derivedFrom:
  - AD-8（iter-20260818-mq5a：双通道分发骨架）
  - AD-17（iter-20260825-11fo：closure 通路修复，通知与正文分层）+ AF-4（覆盖病灶精确定位）
anchors:
  implementedBy:
    - apps/daemon/src/application/services/scheduler/ClosureRecorder.ts
    - apps/daemon/src/adapters/driven/subagent/SubagentLauncher.ts
    - apps/daemon/src/application/services/ChatService.ts
    - apps/daemon/src/infrastructure/container.ts
  testedBy:
    - apps/daemon/test/integration/closure-chain.test.ts
updatedIn: iter-20260825-11fo
```

## 规则
closure 结构承接 v1：{status: done|failed, summary, reportPath?, findings?, taskId?}；findings 已接通 kg 落账（iter-20260825-11fo，见③）。
异步交付语义：agent_spawn 工具秒回 {agentId, spawned} 不挂起当前 turn；closure 到达驱动 MainAgent 新 turn（不是被动等待）；等待期用户 steer 与 closure 注入同队列 FIFO（SteerQueue 一等机制）。
closure 到达时双通道分发：①上下文通道——SteerQueue.enqueue，唯一入口进 MainAgent 窗口，turn 边界 drain；②用户通道——领域事件 agent.completed{agentId, closure} → WS → 聊天流 SubAgent 完成卡片（summary + 状态徽标 + 抽屉入口，可回溯）。同一事实单一呈现面：注入文本进 MainAgent 上下文供 LLM 消费，前端以完成卡片呈现同一事实。
三条分层约束（iter-20260825-11fo AD-17 修复新增）：①通知与正文分层——主线注入恒一行通知（instanceId+status+summary）+ reportPath 指针行；报告正文不进注入（summary 足够决策要不要深入，深入才 read，成本仅在消费时发生）。②reportPath 原值透传——SubAgent 自报 closure.reportPath 恒优先、daemon 只透传路径不重渲染覆盖（报告由 SubAgent 按任务完成报告模板写；无自报时才走 reportsDir 兑底落最小摘要文件）；报告三重角色 = MainAgent 按需读源 / 人类审计面 / kg 落账原始数据。③findings 接通落账——closure findings（含显式「无」）经 findingsSink → KgWriteService 唯一写入口落 .helix-kg change_log（断头消除）；落库仍走既有单写队列（TR-AD-13 同口径）。
SubAgent 内部工具调用不回主线：只进 per-instance 事件流（落盘为挂 instanceId 的 Entry）→ UI 抽屉消费。
SubAgent 错误呈现面 = agent.failed error 字段（iter-20260819-erio AD-1/AF-1 留痕）：engine.error 帧对 SubAgent 实例由 DtoMapper 守卫抑制不广播，用户可见错误原文经 closure 兼容摘要透出不占主聊天流。

## 理由
AD-8（Q-9 修正版）：v1 已验证同构双消费（LLM 上下文 + 用户界面）；异步注入是「主会话不阻塞」的完整语义。F-22 实锤三病：注入仅一行信息量不足、daemon reportsDir 恒覆盖重渲染越位（AF-4 精确到 ClosureRecorder.saveClosureArtifacts L67-70，SubAgentProfile 引导实为死值）、findings 落 closure_records 后断头。分层修复与 kg digest+指针同构（渐进披露贯穿 agent 间）；daemon 重渲染还会覆盖 SubAgent 按模板写的正文（人类审计面失真）。

## 适用范围
closure 收口解析（SubAgent 系统提示约定的结构）、SteerQueue 注入消费、agent.completed 事件与完成卡片渲染、ClosureRecorder 收口链路与注入行格式、SubagentLauncher 的 reportPath 传参（HELIX_* env IPC 面，TR-AD-6 第二豁免族/AG-08 白名单）、findings 落账管道（findingsSink→KgWriteService）、SubAgentProfile 报告落盘引导。

## 反例
daemon 把报告全文渲染进注入行（dense payload 污染主线——F-4 教训）；或恢复 reportsDir 恒覆盖自报路径（SubAgent 模板引导变死值，AF-4 病灶复发）；或 findings 只落 closure_records 不接 kg（断头——CL-3 落账管道与变化报告数据源同时失去输入）；或 closure 到达直接拼进 MainAgent 当前生成中的流（绕过 SteerQueue，FIFO 语义与 turn 边界丢失）；或 SubAgent 每个工具调用都转发主线聊天流——主线窗口被撑爆、隔离失效。

```kg-node
id: TR-AD-18
kind: rule
graph: tech
layer: arch
scope: domain
stack: shared
name: thinking/usage/compaction/error 四通道与协议 additive 演进
status: active
digest: 加协议 entry 或事件、扩引擎事件联合、动 EntryDto 时
derivedFrom:
  - AD-4
  - AD-9
  - AD-3
relations:
  governs:
    - E-会话聚合
    - E-UsageLedger
updatedIn: iter-20260816-6q6f
```

## 规则
三通道（thinking/usage/compaction）统一链路模式：pi 引擎事件/产物（thinking_start/delta/end、message_end 携带的 Usage、CompactResult）→ PiAgentEngineAdapter 防腐转发或提取（挂 instanceId）→ 领域事件 → Entry/账目（domain 权威状态）→ WS 事件与快照；对 pi 符号的 import 只在 pi-engine 防腐域（TR-AD-7 同口径）。
thinking：流式 delta 为中间态不落盘（TR-AD-5 原则不变）；完成态 ThinkingEntry{instanceId, text, durationMs, reasoningTokens} 全量落盘进聚合（重启可回看）；reasoning tokens 随 usage 入账（计费自洽）。
usage：turn 完成从 message_end 提取完整 Usage（input/output/cacheRead/cacheWrite/reasoning/totalTokens/cost）挂 instanceId 入事件流（usage.recorded）；per-instance 小计 → per-session 聚合（主线+委托合计）；compaction 摘要调用成本（CompactResult.usage）同通道入账——一切真实 LLM 成本不漏账；流式中不动账、turn 完成入账。
compaction：由驱动层（AgentRuntime）turn 间按 profile.compaction 参数接线 pi 的 shouldCompact/compact 独立函数族（loop 不自动跑，驱动层 turn 间调用）；CompactionEntry{instanceId, tokensBefore, summary, usage} 进该实例 pi session Entry 树与领域聚合，UI 里程碑折叠条可见（复用 thinking 组件模式：折叠条 + 点击展开 summary）；接线不感知 profile.kind——主实例与 SubAgent 实例同路径可装配 compaction（profile 声明 compaction 参数即获得；SubAgentProfile 当前未声明，SubAgent 实例实际未装配）；失败走既有 engine_error 不崩会话路径 + 失败注入测试守护。
协议演进 v0 → v0.1 additive 纪律：①判别式联合只增不删不改（既有事件 type 字面量与 payload 形状不动）；②可选字段带缺省语义（Envelope.instanceId? 缺省 = 主实例、message_end 的 usage? 缺省 = 未携带，旧剧本兼容）；③EntryDto 联合新增 kind: "thinking" | "compaction" 成员，旧 kind 不动，旧消费者忽略未知 kind；④快照 additive（新增可选 instances/usage 字段，既有字段不动）；⑤增量演进保持 v=0 不 bump，破坏性变更（删字段/改判别值）才 bump PROTOCOL_VERSION；守护测试「目录常量 ↔ 联合双向一致性」随新增成员同步扩；落盘行模型前向兼容走 RowMapper fromRow 默认值兑底（TR-AD-14）。
错误通道（engine.error，热修沉淀并入）：pi-ai 将 provider HTTP 失败规范化为流内 error 帧（非异常，errorMessage 含 provider 原文）；引擎错误经 engine.error 协议事件透传前端（错误卡）。error 轮语义：不产 assistant 气泡、turn 正常收口、全零 usage 不入账（零成本非真实计费）。mock 契约等价的错误面：FakeLLM/剧本须覆盖 error 帧路径（TR-TEST-3 等价原则的错误维度，errorReply 剧本为断言面，与真实 pi-ai 失败帧同构）。

## 理由
thinking/usage 是首迭代有意裁剪的通道（F-10/F-11 核实：上游能力完整、非 bug），接入成本低；压缩对用户不可见是缺陷（usage 突变无解释）且摘要调用计费不能漏（AD-9）；monorepo 同仓同版本发布使 additive 演进协商成本为零（架构文档 §7.4）。

## 适用范围
M2+ 新增任何协议 entry/事件/快照字段、扩展 AgentEnginePort 事件联合（FakeAgentEngine 同步扩——TR-TEST-3 契约等价）时；三通道实现与守护测试；UI 三态渲染（thinking 流式/完成折叠/无块）与 compaction 里程碑条；协议版本位与守护测试维护。

## 反例
为 thinking 流式 delta 开第二条落盘通道（违背流式中间态不落盘，恢复语义分叉）；或直接修改既有 message entry 的 payload 结构塞 thinking 字段（破坏性变更应 bump 版本，旧消费者解析炸裂）；或 compaction 摘要调用的 usage 不入账——header 合计与真实账单对不上。

```kg-node
id: TR-AD-19
kind: rule
graph: tech
layer: arch
scope: domain
stack: backend
name: SubAgent 重启恢复语义（failed 收口不自动续跑）
status: active
digest: 写恢复或收口代码、动快照实例字段、处理崩溃重启边界时
derivedFrom:
  - AD-10
relations:
  governs:
    - E-AgentInstance
    - E-调度器
updatedIn: iter-20260816-6q6f
```

## 规则
重启后：running 态 SubAgent 实例收口为 failed（「daemon 重启，任务未完成」——与首迭代 D-1 工具卡收口同构），历史保留可回放，closure failed 经 SteerQueue 注入主线，不自动续跑；queued 态任务清队不落盘（调度队列持久化边界 = 不持久化），快照标 cancelled（区别于 failed），不自动重派。
重试是编排决策而非恢复机制：MainAgent 收到 failed closure 后自主决定（spawn 新实例重试/转述用户/放弃），决策点在编排层（LLM + 系统提示），不在恢复代码——恢复代码不执行任何东西。
正常运行期 SubAgent 崩溃同语义：崩溃隔离（子进程崩溃不伤 daemon 主线），closure failed 通道回主线。
恢复重建面（重启 daemon 全部恢复）：实例注册表（agent_lifecycle per-instance）→ 卡片/抽屉骨架；Entry 树（主实例主轴 + SubAgent per-instance channel）→ 主线视图 + 抽屉全流重放（SubAgent 历史含在内，恢复重放见 RestoreService.replaySubAgentHistory）；usage 聚合 → header 合计与下钻明细；closure 记录 → 终态卡片与账目；全部经快照推前端纯投影重建（前端零自恢复，TR-AD-5）。

## 理由
AD-10（Q-13=A）确定性优先：自动续跑 = 不知情时执行带旧状态的重试，错误根源在任务时会重演且烧钱；failed 收口不执行任何东西，故不需要「保证不再错」；v1 D-1 已验证同构收口模式；cancelled 与 failed 区分忠实反映「未启动被取消」与「执行中断」两种事实。

## 适用范围
RestoreService 恢复扩展、快照 instances 字段设计（cancelled/failed 终态标记）、E 层重启恢复 E2E 增例、P-1/P-2 的 failed/cancelled 态渲染、调度队列持久化边界评审。

## 反例
重启时扫描出 running 任务自动重新 spawn「接着跑」——不知情重试带旧状态，错误根源重演且烧钱（已裁不自动续跑）；或把 queued 任务也标 failed——与「未启动即被取消」事实不符（已裁为 cancelled 且区别于 failed）；或在 RestoreService 里内置「失败任务自动重派 N 次」策略——重试决策已裁归编排层（MainAgent），恢复代码越权执行。

```kg-node
id: TR-AD-20
kind: rule
graph: tech
layer: arch
scope: domain
stack: shared
name: 能力边界分层约束（bash 现实主义：白名单+审批为硬，SOP+审计为软）
status: active
digest: 配 profile 工具集、写工具审批挂起、做能力边界或相位锁设计时
derivedFrom:
  - AD-2
anchors:
  implementedBy:
    - apps/daemon/src/adapters/driven/pi-engine/runtime/AgentProfile.ts
    - apps/daemon/src/adapters/driven/pi-engine/runtime/profiles/MainSessionProfile.ts
    - apps/daemon/src/adapters/driven/pi-engine/runtime/profiles/SubAgentProfile.ts
    - apps/daemon/src/adapters/driven/pi-engine/runtime/HookSet.ts
  testedBy:
    - apps/daemon/test/arch-guard/arch-guard.test.ts
relations:
  governs:
    - E-AgentProfile
    - E-HookSet
updatedIn: iter-20260816-uzvg
```

## 规则
能力边界分两层表达，硬软分明：硬层 = 注册工具白名单（profile.tools 按名声明，工具不在白名单即不注册）+ 敏感操作 beforeToolCall 审批挂起（HookSet 钩子位）；软层 = bash 内行为靠 SOP 系统提示约束 + 越界审计（事后可观测），不追求对 bash 硬拦截。
bash 是基础工具永远在场，属白名单决策项而非逃生舱——裁剪边界 = 从 tools 白名单移除，不是给 bash 加命令级拦截。v1 相位锁拦不住 bash 内行为是既有事实，v2 的进步点在 SOP 残留不叠加污染（AD-1 re-profile）与交接协议化，不在把软约束伪装成硬约束。
落位节奏：M2 profile 结构以 tools 白名单表达能力边界（subagent-worker 裁决取全工具集，Q-6=A——白名单机制在而取全集是决策不是缺失）；相位级白名单与审批挂起随 M4 phase profile 落（beforeToolCall 钩子位已备）；越界审计随 SOP 系统提示完善。禁止提前实现无裁决的相位锁/审批策略（无场景不预做）。

## 理由
AD-2（grilling 裁决）：v1 相位锁同样拦不住 bash 内行为（编码绕行/间接调用），硬拦截 bash 会催生绕行反而制造假安全性；误伤合法长任务（编译/脚本）的成本高于软约束漏网。分层表达使「能做什么」（硬，可静态审计）与「该做什么」（软，可事后追责）各得其所。

## 适用范围
M4 相位 profile 工具集定义与审批挂起钩子实现；任何新增 profile（agent 类型）的能力边界声明评审；越界审计设计；工具集裁剪决策（白名单决策项口径）；SubAgent/未来 worker profile 的工具授权评审。

## 反例
在 bash 工具内做命令静态分析硬拦截「危险操作」（编码绕行拦不住、合法长任务被误杀，且把边界语义从 profile 声明泄漏进工具实现）；或把能力边界实现为按 agent 类型的目录级工具隔离而 profile 无白名单声明（v1 双轨复发、白名单不可静态审计）；或 M2 就为无竞争场景提前实现相位锁（无裁决不预做）。

```kg-node
id: TR-AD-21
kind: rule
graph: tech
layer: arch
scope: domain
stack: shared
name: 命令结果 = 点对点结果帧；状态变化 = 广播
status: active
digest: 加命令族、写命令结果回执、看点对点发帧时
derivedFrom:
  - AD-4
  - AD-1
anchors:
  implementedBy:
    - apps/daemon/src/adapters/driving/ws-server/WsServerAdapter.ts
    - packages/protocol/src/events/index.ts
  testedBy:
    - packages/protocol/test/type-surface/catalog.test.ts
    - apps/shell/src/entities/session/model/dispatcher/dispatcher.test.ts
relations:
  governs:
    - E-领域事件与单写队列
updatedIn: iter-20260820-qhv8
```

## 规则
命令的结果载荷与领域状态变化的分发通道二分：命令结果 = 点对点结果帧（`*.result` 事件类型，WsServerAdapter.sendNow 直发发起连接，不经 EventStream 广播——清单/分页等连接私有读面广播即泄漏他连接数据且浪费）；领域状态变化 = 广播帧（EventStream 章印路由，按订阅集过滤）。新增命令族套用固定模式：①协议登记 `*.result` 事件（EVENT_TYPES/EVENT_CHANNELS/exports 计数与 type-surface 穷尽守护同步扩）；②daemon routeCommand case 内组帧 sendNow；③shell dispatcher 先 no-op 占位（保持「全类型已路由」守护绿）后接真消费（T1.2 先例）。错误回执同帧直发（command.invalid_payload 等错误码或命令族专码）。

## 理由
T2.2 session 族 2 帧（session.list.result/loadHistory.result）+ T2.3 微批 model/auth 族 9 帧三度同构实证（三度同构即规则）；连接私有读面广播浪费且泄漏；占位先例使协议面与 shell 面可异步接线（并行任务不互锁）。源决策 = 契约 B §2.3 机制注记 / AD-4。

## 适用范围
新增任何命令族的结果回执设计；EVENT_TYPES 事件目录扩员；dispatcher 消费者接线；协议契约文档（契约 B/C）的结果帧章节维护。

## 反例
session.list 结果经 EventStream 广播——所有连接收到他连接的会话清单（泄漏）；或命令发完无结果帧、结果只写 daemon 日志（T2.3 曾短暂如此）——前端永久等不到回执只能超时。

```kg-node
id: TR-AD-22
kind: rule
graph: tech
layer: arch
scope: domain
stack: shared
name: 事件分发两层拓扑（daemon 投影 ↔ shell dispatcher 同构）
status: active
digest: 扩事件消费者、动 store 拓扑、加投影或路由时
derivedFrom:
  - AD-3
anchors:
  implementedBy:
    - apps/daemon/src/application/services/SessionProjection.ts
    - apps/shell/src/entities/session/model/dispatcher/
  testedBy:
    - apps/daemon/test/integration/session-projection.test.ts
    - apps/shell/src/entities/session/model/dispatcher/dispatcher.test.ts
relations:
  governs:
    - E-会话聚合
updatedIn: hotfix-20260820
```

## 规则
事件消费按 sessionId 分实例化的两层拓扑，daemon 与 shell 同构：daemon 侧 SessionProjection = fan-out 显式消费者 + 共享聚合访问器 + 幂等去重集（projectedEntryIds）+ persistedState 组合面，经 SessionRegistry 按会话实例化（SubAgent Entry 落聚合 instanceId 归属 + usageLedger 并入 + write-through 迁入）；SchedulerService 只产事件零聚合写（守护断言在集成测试）。shell 侧 dispatcher 两层 = 会话 store 级消费者（SessionState 域）+ 拓扑级 directory 消费者（TopologyState 域），帧入口三向路由（活跃完整 store / 后台轻量 store / 系统帧；session.snapshot 例外优先路由活跃——连接级重建指令）。后台路由不依赖 activeId 非空（hotfix-20260820：「activeId null 仅首连前」的 v0.1 假设被草稿态废止——草稿态旧会话帧一律进后台轻量/未知会话丢弃，model 配置族前置拓扑级消费防误吞）。新增事件族 = additive 扩展面（新消费者注册，不动拓扑骨架）。

## 理由
多会话下投影按会话隔离才不串台（SessionRegistry 分实例化）；两层（会话内状态 vs 跨会话拓扑）职责分离使后台轻量跟踪成为可能——后台会话不建完整 store，内存随会话数有界；daemon/shell 同构使协议事件族扩展的双端接线模式固定（新增族双端同构扩）。

## 适用范围
扩展事件消费者；动 store 拓扑或 SessionProjection；新增事件族的分发接线（daemon 消费者 + shell 消费者注册）；后台轻量 store 的字段取舍评审。

## 反例
把后台会话也建完整 store（entries 全量驻留，内存随会话数无界增长）；或 dispatcher 单层平铺全部状态（跨会话拓扑与单会话状态耦合，切换会话时误清拓扑/误留会话态）；或 SchedulerService 里顺手写聚合（零聚合写守护即红）。

```kg-node
id: TR-AD-23
kind: rule
graph: tech
layer: arch
scope: domain
stack: shared
name: 协议演进 additive 模式与订阅状态连接级隔离
status: active
digest: 扩协议命令或字段、定契约版本批次、动订阅或连接状态时
derivedFrom:
  - AD-2（M4 monitor 档，Q-2b 机制定案）
  - AD-5（M4 契约 v0.3 一次定形）
  - Q-1c（M4 一步替换无协商）
  - AD-4（iter-20260819-erio 契约 v0.4 批次定形）
  - CL-4（iter-20260821-dg90 协议包行为契约定案）
anchors:
  implementedBy:
    - apps/daemon/src/adapters/driving/ws-server/EventStream.ts#MONITOR_TIER_EVENT_TYPES
    - apps/daemon/src/adapters/driving/ws-server/EventStream.ts#push
    - apps/daemon/src/adapters/driving/ws-server/EventStream.ts#ConnProjection
    - apps/daemon/src/adapters/driving/ws-server/EventStream.ts#subscribeSession
    - packages/protocol/src/commands.ts#SessionSubscribePayload
    - packages/protocol/src/envelope.ts#PROTOCOL_VERSION
    - packages/protocol/src/projection/
    - packages/protocol/src/events/agent.ts
    - apps/shell/src/entities/session/model/subscription-ledger.ts
  testedBy:
    - apps/daemon/test/integration/ws-server-spy.test.ts
    - apps/daemon/test/arch-guard/arch-guard.test.ts
    - packages/protocol/test/type-surface/catalog.test.ts
    - packages/protocol/test/type-surface/sot-consistency.test.ts
    - packages/protocol/test/type-surface/agent-config.test.ts
    - apps/shell/src/entities/session/model/subscription-ledger.test.ts
relations:
  governs:
    - E-领域事件与单写队列
updatedIn: iter-20260821-dg90
```

## 规则
协议能力演进三定律：
①可选参数扩展优先于新命令对——同一命令能以可选参数承载的语义（session.subscribe 扩 tier、chat.steer 扩 instanceId、welcome 扩 draft 标记、chat.send 扩 draft 建会话 model——hotfix-20260820 例证）不新增命令对；仅当载荷形态无法容纳才新增（届时按 TR-AD-21 整链登记模式）。可选参数必带缺省语义（缺省 = 既有行为，旧剧本兼容），事件类型判别式只增不删不改（TR-AD-18 同源纪律）。
②契约版本一次定形——同一批协议演进收拢为一次契约版本定形后铺开（v0.3 = spawn 锚点 DTO + tier 订阅 + steer 寻址三处同批；v0.4 = trace.query 命令族 + agent.instantiated/model.changed 落盘事件 + engine.error SubAgent 抑制守卫同批，iter-20260819-erio；v0.5 = payload 形状全量回迁正文（13 命令 + 11 结果帧 + draft 字段登记）+ §14 微批字段定形 + SoT 五断言同批，iter-20260820-qhv8，执行律详见 TR-AD-26；v0.6 = agent.config.* 命令族 additive（COMMAND_TYPES 22→24 + EVENT_TYPES 40→43：changed 广播 + 两点对点结果帧；tools 行 snippet 字段 additive 补登）——四面同构（常量/PROTOCOL.md §15§16/catalog 逐字面量/sot 五断言）同批落定，零既有形状变更，iter-20260821-m6）；EVENT_TYPES/EVENT_CHANNELS 守护计数与 type-surface 穷尽断言同步一次扩。单仓同发（protocol + daemon + shell 同 commit 发版）无跨版本组合场景：PROTOCOL_VERSION 是批次集合标记而非协商位；批内破坏性清理（删 dead 类型 / 路径迁移 / 旧推导代码删除）一步完成不留双轨。
③订阅状态连接级隔离——daemon 订阅状态（Map<sessionId, tier>，tier = full | monitor）是连接私有状态，由 EventStream 按连接持有；daemon 不持跨连接全局订阅知识（拒绝「daemon 知道哪些会话活跃」的中心化换档）；断连即丢、重连由客户端重放全订阅图。N 窗口 = N 连接 = N 独立订阅图，多窗口/多客户端在协议层零改动扩展。档位过滤（monitor 白名单）在事件分发层一处完成，不散落 service。
④协议包职责 = 类型契约 + 行为契约（iter-20260821-dg90 CL-4 定案，T3.1 落位）：无 IO 纯函数 projection（usage/instance/trace 三域）落 packages/protocol/src/projection/，daemon/shell/fake-transport 三方薄适配消费同一单源，消灭平行实现；IO/SQL/框架代码仍禁入 protocol 包（纯函数无框架依赖为入面硬门槛）。

## 理由
Q-2b 定案：连接级单档 Map 消除双集交集歧义，切换先升后降保证不丢帧不串台；拒绝 daemon 持活跃会话知识（原子换档方案）保持去中心化订阅模型——多窗口协议层零改动是结构红利而非补丁。Q-1c：单仓同发使协商成本为零，拆多次小版本只产生多次守护计数扰动；可选参数承载使守护面与 shell dispatcher 路由面零新增。

## 适用范围
M4+ 新增任何协议命令/事件/DTO 字段时；契约版本批次规划（同批演进收集后一次定形）；动 EventStream 订阅结构或连接状态时；多窗口/多客户端形态演进评审。

## 反例
为 monitor 档新增 session.subscribe_monitor / unsubscribe_monitor 命令对（可选参数即可承载，徒增命令目录与 dispatcher 路由面）；或 daemon 维护全局活跃会话表做原子换档（第二连接连入即污染第一连接订阅图，多窗口被迫开协议协商）；或 v0.3 拆三次小版本铺开（三次守护计数扰动）；或 monitor 白名单散落各 service 各写一份（口径漂移，过滤必须事件分发层一处）。

```kg-node
id: TR-AD-24
kind: rule
graph: tech
layer: arch
scope: domain
stack: backend
name: SubAgent 模型两级解析链（profile 槽位 > 全局兑底；T12 砍 spawn 会话快照级）
status: active
digest: 动 SubAgent 模型来源、写 spawn 模型透传管线、配 profile 模型槽位、调 kind 槽位或全局兑底语义时
derivedFrom:
  - AD-3（iter-20260819-erio：用户裁决「按优先级，profile > 会话模型 > 全局默认」）
  - M6 T2（iter-20260821-m6 478ab2c：kind 槽位插入 ①② 之间，枚举未随更——iter-20260823-6ps5 终验
    L3 复核校正三级→四级）
  - TR-AD-44（iter-20260823-6ps5：kind 槽位经 getter 折叠进 profile 读面）
  - T12（用户裁决「只需要subagent根据自己的profile来就行，没有spawn，也没有继承main session的选择」
    ——spawn 会话快照级砍除，四级链收为两级）
anchors:
  implementedBy:
    - apps/daemon/src/adapters/driven/subagent/SubagentLauncher.ts
    - apps/daemon/src/application/services/scheduler/SchedulerService.ts
    - apps/daemon/src/infrastructure/container.ts
    - apps/daemon/src/adapters/driven/pi-engine/runtime/AgentRuntime.ts
    - apps/daemon/src/adapters/driven/pi-engine/PiAgentEngineAdapter.ts
    - apps/daemon/src/infrastructure/assembly/buildSessionStack.ts
  testedBy:
    - apps/daemon/test/unit/engine-state-mutation.test.ts
    - apps/daemon/test/unit/subagent-thinking-chain.test.ts
relations:
  governs:
    - E-AgentProfile
    - E-调度器
updatedIn: task-20260824-thinking-unify
```

## 规则
SubAgent 实例的模型来源按两级优先级解析（T12 砍 spawn 会话快照级后）：①SubAgentProfile.model 真实槽位（launch 期 resolveModelFor 解析，声明即最高优先级）→ ②kind 槽位（resource_state model 型行 subagent-worker 槽位；launch 期经 deps.uiModelSlot/profile getter 读现值定格——TR-AD-44 折叠约定，静态声明优先于运行期槽位值）→ 全局兑底（默认模型存储现值 getter，container 组合根注入，语义 = 「全局兑底」而非「SubAgent 默认来源」）。SubAgent 只认自身 profile 链，不继承 main session 当前模型：scheduler.spawn 第四参（spawn 透传模型 id）仅存 spawnModels 填充 AgentInstanceDto.model / agent.spawned 载荷与 instantiated 快照（组合根 resolveSubagentModelId 单点供给，与 launch 解析同源），不再进入 launcher 解析链；bindSpawnModelSource/spawnModelOf/backfill.spawnModelSource 管线退役。launch 段是两级链的唯一消费点：SubagentLauncher.launch 携带解析结果，子进程 HELIX_MODEL_JSON 仍为完整 Model 对象透传（防 registry 不含的红线不变）。取代边界：本规则取代 M2 AD-6「SubAgent 缺省继承全局默认」中「SubAgent 模型源 = 全局默认表」的解析规则；不取代会话级 model.set 内存态语义（主实例模型仍为 AgentState.model 内存态，重启/卸载回退全局默认）。

state 直改族谱扩展（M6，iter-20260821-m6）：setModel 之外新增 setTools/setSystemPrompt 同构直改（AgentRuntime → AgentEnginePort 可选扩面 → PiAgentEngineAdapter → ChatService 六层链，赋 agent.state 即下一 run 生效、in-flight context 快照定格不变——pi agent.d.ts「Assigning state.tools copies the top-level array」官方语义背书）。不走 prepareNextTurn 链（CompactionHook 占用且「首个非空生效」合并语义会短路，与换模同款机械裁决）。资源配置变更（kind 维）经 onApplied 回调刷新该 kind 全部活跃 runtime；SubAgent 按代生效（spawn 时刻 env 定格快照）；主会话槽位 UI 化后 main 型读面 = 四级链（per-session 覆盖 > kind 槽位 > default_model，读面生效不强推活跃 runtime）。

## 理由
M4 终验后真机 7 连败根因之一：会话内 model.set 只切主实例，SubAgent 模型源仍是全局默认（zai 配额耗尽后子进程 429 静默失败）。原用户裁决优先级「profile > 会话模型 > 全局默认」；M6 T2 槽位 UI 化在 ①② 间插入 kind 槽位级。T12 用户再裁决砍 spawn 会话快照级：根因实证为语义稀释——spawn 继承会话当前模型时，P-2 按「槽位 ?? 全局默认」预览的 thinking 档位在该会话模型上被 supportsThinkingLevel 静默过滤成 OFF；砍级后 P-2 预览基准与 spawn 实际模型天然同源，稀释消失，SubAgent 行为由 profile 配置单源决定。

## 适用范围
SubAgent spawn/launch 链路实现与评审；profile model 槽位与 kind 槽位声明（代码层入口；UI 管理由智能体页 /skills 承接，模型下拉可用性过滤与 chat P-3 同口径）；default_model 相关文案/注释口径调整；模型切换链路的 E 层与真机验证；未来新增 profile 类型时模型槽位语义评审；kind 维资源配置（model/thinking 及后续新槽位型）接入解析链评审。

## 反例
SubagentLauncher 每次 launch 直接读全局默认 getter（单级解析回退——kind 槽位配置不生效，P-2 配置面失效）；或在解析链内重新引入会话模型级（spawn 快照/launch 读会话现值同罪——T12 裁决明确禁止 SubAgent 继承 main session 选择，语义稀释根因复发）；或解析单点内直接调 ResourceService 读 kind 槽位（单点耦合配置资源 + 快照供给面漏读——两读面不同源即漂移，应按 TR-AD-44 getter 折叠）。

```kg-node
id: TR-AD-25
kind: rule
graph: tech
layer: arch
scope: domain
stack: shared
name: 源码体量双线与触发式拆分（700 预警 / 1000 强制）
status: active
digest: 新增代码使文件超 700 行、审计体量热点、拆分裁决时
derivedFrom:
  - AD-3（iter-20260820-qhv8：越线才修 + 常设策略落规则，用户 2026-08-20 裁决）
  - F-9（全库体量盘点：5 热点零收敛 + 400–700 段新增 16 个）
  - "F-2 #1/#2/#3（上迭代终验优化池：type-surface 1582 越强制线 + 三大文件 700+ + events.ts 贴线）"
  - "F-9 计数更正（终验 TR-AD-25-r2：审计时 16 个 → 收口复测 20 .ts + 2 .tsx 登记——热修批后测试自然增长，T4.3 复测与 T4.1 实测恰等）"
relations:
  governs:
    - E-调度器
    - E-会话聚合
    - E-领域事件与单写队列
anchors:
  implementedBy:
    - scripts/audit-assert.ts#SIZE_FAIL_LINES
    - scripts/audit-assert.ts#SIZE_EXEMPT
    - .github/workflows/ci.yml#Engineering hygiene gate
    - apps/daemon/src/application/services/scheduler/
    - apps/daemon/src/adapters/driving/ws-server/handlers/
    - packages/protocol/src/events/
    - packages/protocol/test/type-surface/
  testedBy:
    - bun run audit:assert
    - apps/daemon/test/integration/session-projection.test.ts
    - packages/protocol/test/exports.test.ts
updatedIn: iter-20260820-qhv8
```

## 规则
源码与测试文件的体量双线：700 行预警 / 1000 行强制，作用于 apps/** 与 packages/** 的 .ts 文件（文档与 git 管理的产物不在此列）。四条执行律：①强制线机械阻断——超过 1000 行的文件使 audit:assert 非零退出（CI 红），非协商、不豁免于「临时」理由；本仓唯一豁免通道 = audit-assert.ts 内显式豁免清单（文件 + 一行理由），禁止上调阈值（阈值是裁决值，蠕变即策略失效）。②预警线审计可见——≥700 行在 audit:assert 输出汇总（文件 + 行数），进优化池登记，不阻断；新增代码使既有文件越过预警线时，同批内要么拆分要么登记（不许静默增长）。③触发式还债——400–700 段的登记热点（F-9 审计 16 个，收口复测 20 .ts + 2 .tsx 登记）不主动拆；被触碰（新增功能/修缺陷需改该文件）时先还债（拆分或明确豁免登记）再加码。④拆分纪律——拆分一律机械迁移：函数/case 体逐行搬移 + 仅机械代换（this.deps.X → ctx.X / import 路径），不改分支、字符串、回执时序；拆分 = 独立 commit + 拆分前后对应包全量测试绿；行为变化与结构搬移不得混入同一 commit。

## 理由
iter-20260820-qhv8 全库盘点（F-9）实证体量走势零收敛：五个已知热点无一收敛（WsServerAdapter +13、events.ts +6），且 400–700 段新增 16 个——靠「批次集中治理」无法对抗每次迭代 +N 行的增量惯性，必须常设化。双线设计把「何时必须拆」从评审争论变成机械判定（1000 线由脚本红绿裁决）；700 线只登记不阻断，避免治理本身成为功能迭代摩擦源。触发式还债（用户 AD-3 裁决）平衡「彻底治理」与「本期不扩散拆分面」：16 个热点未来触碰时还债，未触碰不投入。type-surface.test.ts 1582 行（上迭代优化池 #1）证明测试文件与源码同线同责——守护网自身也会腐化。拆分纪律四条来自 T1.1 handler 模块化的成功先例（diff 逐行对照可行），是行为等价（AD-1）在结构治理面的落地。

## 适用范围
新增或扩写任何 apps/**、packages/** 的 .ts 文件时（源码与测试同线）；工程审计与 audit:assert CI step 的口径评审；拆分方案设计评审（接缝选择、目录落位、commit 划分）；豁免清单增删裁决。

## 反例
「这次先加上去、下迭代一起拆」使文件突破 1000 强制线（强制线不接受排期豁免——豁免清单是唯一通道且须附理由）；或为过线把一个内聚模块切成三个互相 import 的小文件（假拆分：文件行数达标但耦合面反向加深，madge 环数上升即证伪）；或把 1000 调到 1200 应付审计（阈值蠕变）；或拆分 commit 里顺手修一个「看到的小 bug」（行为变化混入机械迁移，diff 审查失效——缺陷走独立 commit + 白名单留痕，AD-1/AD-2）。

```kg-node
id: TR-AD-26
kind: rule
graph: tech
layer: arch
scope: domain
stack: shared
name: 契约 SoT 完整性（PROTOCOL.md 正文登记 + type-surface 一致性断言）
status: active
digest: 加命令/事件、改 payload 字段、升契约版本时
derivedFrom:
  - iter-20260820-qhv8 AD-4
  - TR-AD-23
  - iter-20260820-qhv8 F-5
anchors:
  implementedBy:
    - packages/protocol/PROTOCOL.md#§15
    - packages/protocol/PROTOCOL.md#§16
    - packages/protocol/PROTOCOL.md#§17
    - packages/protocol/src/envelope.ts#PROTOCOL_VERSION
    - scripts/perf-a11y-audit.mjs#V
    - apps/shell/src/shared/api/fake-transport.ts#buildTraceReply
  testedBy:
    - packages/protocol/test/type-surface/sot-consistency.test.ts
    - packages/protocol/test/type-surface/catalog.test.ts
    - apps/shell/src/pages/trace/model/trace-model.test.ts
relations:
  governs:
    - E-领域事件与单写队列
updatedIn: iter-20260820-qhv8
```

## 规则
PROTOCOL.md 是 WS 契约的唯一事实源，且该地位必须机械可验证。四条执行律：①payload 形状正文登记——所有命令/事件的 payload 形状必须登记在 PROTOCOL.md 正文（§15 命令全集 / §16 事件全集，按通道族组织，与 packages/protocol/src/events/ 族拆分、type-surface 族测试三面同构）；禁止委托仓外文档或「以代码为文档」。additive 可选字段（TR-AD-23① 口径）同样必须落字段行登记（含缺省语义），新增命令/事件不同步登记即守护红。②版本位单点——PROTOCOL_VERSION 唯一定义在 packages/protocol/src/envelope.ts；任何脚本/文档/测试引用版本一律从单点读或由断言守护，禁止手写字面量。实现注记（node 直跑脚本，T2.2 落地先例）：引用 workspace TS 包时优先 import 自包含单文件源（perf-a11y-audit.mjs 直读 envelope.ts）——包入口 index.ts 的无扩展名 re-export 在 node 24 type-stripping 下不可解析，勿走包入口。③一致性断言守护——sot-consistency.test.ts 五条机械断言：文档版本位 == 单点导出值；COMMAND_TYPES/EVENT_TYPES 每字面量有正文登记锚；文档计数 == 常量目录长度；关键 additive 字段 presence；§16 族小节 == EVENT_CHANNELS 通道归属。断言粒度边界：字段级逐形状 diff 属生成式基建（AD-4 选项 C，入池），本期不建。④mock 契约等价联动（TR-TEST-3 延伸）——fake-transport 等契约 mock 的校验口径对齐真实 daemon normalize 实现，不弱于、也不私设口径；验证链三层闭合：文档 ↔ 类型（sot-consistency）↔ daemon normalize（integration）↔ mock（shell 测试）。

## 理由
一致性审计（F-5）实证了「口头 SoT」的三种腐化形态：版本字面量漂移（脚本 0.3 vs 实值 0.4，audit:a11y 持续发非法帧）、正文登记缺口（welcome.draft 零登记）、历史形态残留（§3 信封代码块展示已删除的接口）——以及结构性的第四种：v0.2 起 13 命令 + 11 结果帧 payload 形状委托仓外文档，与 §12「SoT 归本文档」声明直接相悖。结论：SoT 声明若不可机械验证，漂移只是时间问题；回迁正文 + 五条 presence 级断言以最小成本（无生成式基建）把声明变成红绿事实。mock 联动律来自优化池 #8 的教训：mock 侧校验缺口会让 mock 测试绿而真机行为偏离——mock 是契约的第三投影面，必须与 daemon 同口径。版本批次语义（一次定形、批次标记非协商位）仍归 TR-AD-23②，本规则只管「登记完整 + 不漂移」。

## 适用范围
新增任何协议命令/事件/DTO 字段时（含 additive 微批——登记与代码同 commit）；契约版本升位（v0.5 起）；修改任何 payload 字段形状/可选性时；编写或修改契约 mock（fake-transport / e2e mock-session）校验分支时；PROTOCOL.md 结构调整评审；perf-a11y 等引用协议版本的脚本与文档维护。

## 反例
payload 形状只写在 events.ts/commands.ts 的接口注释里、PROTOCOL.md 只列目录不列字段（前端/工具链被迫翻代码猜字段）；或脚本里手写 const V = "0.3" 而注释声称「来自单点」（登记在案的漂移反例）；或升 v0.5 只改 envelope.ts 不动文档标题与 §3 代码块（sot-consistency 断言①红）；或加 chat.send.payload.draft 字段但 §15.1 无字段行（draft 零登记复发，断言④红）；或 mock 的 trace.query 忽略 agentKind 过滤维只回显（mock 与 daemon normalize 口径分裂，TR-TEST-3 违例）。

```kg-node
id: TR-AD-27
kind: rule
graph: tech
layer: arch
scope: domain
stack: backend
name: SystemPrompt 三段组装器（组装唯一来源 + 无条件化纪律）
status: active
digest: 改系统提示词、加工具/技能提示段、调组装顺序或格式时
derivedFrom:
  - M6 规划 §三（2026-08-20 用户多轮裁决：无条件化联动/自写格式化/双源消除）
anchors:
  implementedBy:
    - apps/daemon/src/application/services/SystemPromptAssembler.ts
    - apps/daemon/src/adapters/driven/tools/ToolPromptSnippets.ts
  testedBy:
    - apps/daemon/test/unit/system-prompt-assembler.test.ts
    - apps/daemon/test/unit/profile-slim.test.ts
    - apps/daemon/test/integration/resource-refresh-chain.test.ts
relations:
  governs:
    - E-AgentProfile
    - E-智能体配置资源
updatedIn: iter-20260821-m6
```

## 规则
systemPrompt 组装唯一来源 = 三段拼接：①profile base（静态瘦身，角色+行为引导，零手写工具清单）+ ②可用工具段（`- name: snippet` 扁平清单，snippet 一句话，从 resolveTools 产物同源派生——能力与提示双断的结构保证）+ ③可用技能段（内容对齐 agentskills.io 标准：三句引导语（技能是什么/匹配时先 read 全文/相对路径以技能目录为基准解析）+ 每技能 name/description/location 三行 YAML 子块 + description 单行折行防御；格式非 XML 自写，不用 pi 的 formatSkillsForSystemPrompt）。三个消费面同源：main engineFor 装配 / toggle 刷新推送 / subagent spawn 快照缓存。无条件化纪律（用户裁决）：组装器不做任何状态联动判断——read 被禁不删技能引导句、编排三件套被禁不删委派段；提示词与资源状态错配 = 使用不当，不是代码缺陷。

## 理由
M6 前两 profile 为双源维护（systemPrompt 手写工具清单已漂移：漏 grep、编排挤「并行委派」段），增删工具必漂；tools 段从 resolveTools 产物派生使清单与装配面结构性同源（state.tools 是 provider function calling 与分发双料事实源——移除即能力+提示双断）。自写格式化的依据：pi 库层格式化是纯拼串函数零耦合，且 pi 自家 coding-agent 亦是独立实现（应用自决层）；XML 换 YAML 子块但三字段+三引导语内容要素与标准逐项对齐（location 是技能文件型资源的功能性字段，模型靠它 read 技能全文）。

## 适用范围
系统提示词相关实现与评审；新增工具/技能时的提示段接入；snippet 注册表维护；组装格式调整（须同步 system-prompt-assembler.test 断言）。

## 反例
在 profile systemPrompt 常量里手写/回填工具名清单（双源复发，profile-slim.test 词边界断言即红）；组装器里加「read 禁用则删引导句」类联动判断（无条件化裁决被违反）；技能段丢 location 或丢相对路径解析引导语（功能性要素缺失，模型读不到技能文件）。

```kg-node
id: TR-AD-28
kind: rule
graph: tech
layer: arch
scope: domain
stack: shared
name: packages/common 业务无关通用层与零依赖守护
status: active
digest: 新建全局常量或通用 utils、动 packages/common 内容、加 @helix/common 依赖边时
derivedFrom:
  - AD-1
anchors:
  implementedBy:
    - packages/common/src/
  testedBy:
    - apps/daemon/test/arch-guard/arch-guard.test.ts
updatedIn: iter-20260822-m1uc
```

## 规则
packages/common 是 monorepo 业务无关通用层，处于全依赖图最底层。包结构：src/constants.ts（全局常量唯一落位）+ src/utils/（通用纯工具）+ src/index.ts 门面导出。依赖方向硬约束：零外部依赖、零 @helix/* 依赖——import 只允许 node/bun 内置说明符与包内相对路径；daemon 各层（domain/application/adapters/infrastructure）、protocol、shell 均可依赖 common，common 不依赖任何 @helix/* 包与第三方包。业务无关性双治理：①结构断言机械守护——arch-guard AG-15：packages/common/src 全部 .ts 的 import 说明符 ∈ {相对路径, node:*/bun:* 内置}、packages/common/package.json dependencies 必空；②内容纪律评审守护——不含领域概念/业务语义，准入判据 = 「换一个产品仍然成立」的通用件，领域词汇（Session/Agent/Instance 等领域语义）一律拒绝入内。首个成员：MAIN_INSTANCE_ID（原 domain/agent/AgentInstance.ts 与 packages/protocol/src/envelope.ts 双源收编，唯一定义 = common/src/constants.ts；domain 经 AG-02① 白名单例外直引；protocol re-export 保持既有 @helix/protocol 消费面兼容（本迭代不批量迁移既有消费点）；AG-13 取源断言语义与 test/unit/protocol-import.test.ts 双源相等断言随迁）。新代码取用 MAIN_INSTANCE_ID 直引 @helix/common，不再经 protocol re-export 链。范围控制：既有 utils 不批量迁移，后续按需逐个迁入，每笔迁入过业务无关性双治理。

## 理由
iter-20260821-dg90 AD-1：MAIN_INSTANCE_ID 双源的根因是规则内战——TR-AD-1「@helix/protocol 仅 MAIN_INSTANCE_ID 取源单点」与 AG-02「domain 禁 import 协议包」互相打架（源报告 A5 核实），解法不是放宽某一侧，而是引入两者之下都合法的最小公共层；零依赖结构断言（AG-15）让「业务无关」从口头纪律变成红绿事实，与 AG-05 零依赖纪律同源；不批量迁移既有 utils 是范围控制裁决（避免偿还债本身变成新的大迁移）。

## 适用范围
新建全局常量或通用工具函数时的落位决策；packages/common 包内容增删评审（业务无关性判据）；任何 @helix/common 依赖边新增（daemon/protocol/shell 的 package.json dependencies）；arch-guard AG-15 断言维护；MAIN_INSTANCE_ID 取源审查。

## 反例
在 packages/common 里 import @helix/protocol（或任何 @helix/*、第三方包）——common 是全依赖图最底层，反向即环，AG-15 断言红；或把 SessionRecord 这类领域簿记概念、AgentInstance 这类领域语义塞进 common utils——业务无关性纪律违例（结构断言查不出，评审拦）；或在 domain/agent/AgentInstance.ts 重新定义 MAIN_INSTANCE_ID = "main" 字面量——双源复发，AG-13 取源断言红。

```kg-node
id: TR-AD-29
kind: rule
graph: tech
layer: convention
scope: domain
stack: backend
name: 注释叙事三分类与 ADR 落档判据
status: active
digest: 清理或新写代码注释、处理任务号/迭代号叙事、落 ADR 时
```

## 规则
代码注释三分类判据：①行级强约束——保留约束表述与活锚（TR-AD-N/AD-N/AG-N/TR-TEST-N/O-N 活观察节点/Q-Na 契约款/§文档节引用），删任务号叙事尾巴；②文件级考古——迁 docs/decisions/ ADR（含背景/取舍/演进史三要素），源文件留当前契约 + ADR 指针；③纯叙事——全删。叙事模式 18 族机械可判定（追修/原T/任务号T/里程碑M/闭环CL/需求点F/K系/O系/TS系/spike/迭代号/TP/AF/FB/OI/C系/D批/G系）。ADR 目录准入判据：有独立演进史与取舍的决策域才立 ADR，一次性实现细节不立。

## 理由
任务号/迭代号叙事注释写完即开始腐烂（所指批次完成后语义悬空），18 族模式机械可判定使清理可脚本化；文件级考古迁 ADR 保留背景/取舍/演进史三要素，比留在源码注释更可持续；活锚白名单防止清理误伤仍在生效的约束引用。

## 适用范围
全部源码注释的新写与清理评审；docs/decisions/ ADR 新增准入；注释清理批次任务的判型依据。

## 反例
新写「T3.3：AD-1 单源收编（iter-20260821-dg90）」式任务号叙事注释——写完即腐（AgentInstance.ts L27 实证）；或把文件级演进史大段留在源码文件头——应迁 docs/decisions/ ADR 留指针。

```kg-node
id: TR-AD-30
kind: rule
graph: tech
layer: convention
scope: domain
stack: backend
name: 事件扇出带名注册表与顺序断言
status: active
digest: 组装多目标事件扇出、写发布顺序敏感的组合根接线时
anchors:
  implementedBy:
    - apps/daemon/src/infrastructure/assembly/wireEventFanout.ts
  testedBy:
    - apps/daemon/test/integration/fanout-assembly.test.ts
updatedIn: iter-20260821-dg90
```

## 规则
组合根的多目标事件扇出组装用「带名注册表」模式：扇出目标以 NamedFanoutTarget 数组显式登记（名字 + 目标引用），注册表顺序即发布顺序的唯一权威声明，wireEventFanout 按注册表序接线 FanoutPublisher。凡发布顺序承载语义（如「先事件行后状态行」），必须有顺序专项断言把口头契约转为机械断言（逐名全序断言）；负边界（某目标不应收某类事件）同样落断言面。

## 理由
扇出目标的注册顺序此前是隐式口头契约，目标增减时顺序漂移无任何机制能发现；带名注册表使顺序成为可审读的唯一事实源，顺序断言使其成为红绿事实（iter-20260821-dg90 终验架构师实证：wireEventFanout 六目标 + fanout-assembly.test.ts:111-118 顺序断言 + resources.changed 三负边界断言）。

## 适用范围
daemon 组合根事件扇出组装面；未来任何「push 序即语义」的多目标发布组装；扇出目标增删的评审。

## 反例
组合根里逐行 publisher.add(a); publisher.add(b) 隐式依赖添加顺序而无注册表与顺序断言——后续插入新目标即可能打乱「先事件行后状态行」语义且无测试能红。
```

```kg-node
id: TR-AD-31
kind: rule
graph: tech
layer: convention
scope: domain
stack: backend
name: 服务依赖两形态接口（生产必填 + 测试宽松）
status: active
digest: 设计 service 依赖注入面、写测试替身注入、动可选钩子字段时
anchors:
  implementedBy:
    - apps/daemon/src/application/services/ChatService.ts
  testedBy:
    - apps/daemon/test/arch-guard/arch-guard.test.ts
updatedIn: iter-20260821-dg90
```

## 规则
application service 的可选钩子/依赖用两形态接口表达：完整形态（生产，如 ChatServiceDeps——钩子字段全必填）+ 测试形态（如 ChatServiceTestDeps——字段可选）；生产组合根装配点按完整形态装配，编译期保证全钩子在位，根治「?.() 可选调用静默跳过」类病根。已知边界：构造器签名取两形态联合类型时，内部仍存运行期不可达兜底分支——分支消灭依赖装配纪律而非类型收窄；追求彻底消分支的后续方向 = 构造器收窄为完整形态 + 测试工厂包缺省填充。

## 理由
可选字段 + `?.()` 调用使「钩子未装配」在编译期不可见、运行期静默跳过（A4 病根实证）；两形态接口把「生产必须全钩子」变成类型级事实，测试侧保留宽松注入便利（iter-20260821-dg90 终验架构师实证：ChatService.ts:53-85 三件套 + :108 联合构造器落地）。

## 适用范围
application 服务依赖面设计；一切「生产必填钩子 + 测试宽松注入」的服务；评审新增可选依赖字段时的形态归属。

## 反例
service deps 接口直接全字段可选 + 内部 `deps.onX?.()` 散布——某钩子忘装配时无任何报错，行为静默缺失（A4 病根形态）；或为消兜底分支把测试形态也改为全必填——测试装配面被迫逐字段填充，测试写法成本飙升。
```

```kg-node
id: TR-AD-32
kind: rule
graph: tech
layer: arch
scope: domain
stack: backend
name: 三方二进制运行时解析收口（单点解析 + 禁裸名 spawn）
status: active
digest: 接入 rg/codegraph 等三方二进制、写 spawn 外部工具代码时
derivedFrom:
  - AD-1
  - AD-2
anchors:
  implementedBy:
    - apps/daemon/src/adapters/driven/tools/grep/resolve-rg.ts
  testedBy:
    - apps/daemon/test/integration/grep-rg-backend.test.ts
    - apps/daemon/test/integration/grep-degrade.test.ts
relations:
  governs:
    - E-AgentRuntime
updatedIn: iter-20260822-m1uc
```

## 规则
所有随包捆绑或外部可用的三方二进制（本期 rg，后续 codegraph 同模式）的路径解析收束于单一解析模块（rg 的落位 = adapters/driven/tools/grep/resolve-rg.ts；后续三方二进制按同模式建各自解析器）。解析顺序固定三级：①包内 bundle 资源（Tauri resources/bin，路径由壳经 sidecar 启动参数注入，TR-AD-6/TR-AD-10 bundle 资源定位口径）→ ②用户配置显式路径（~/.helix/config.json，经 paths.ts 单点派生）→ ③宿主 PATH 探测。三级全部缺失或不可用即走该工具声明的降级路径（rg → 内置 TS grep），不抛裸错。禁止工具/业务代码散落 spawn 裸名（spawn("rg") 直撞 PATH）或各自拼接包内资源路径；dev 形态下 bundle 级缺失即自然落到 ②③。

## 理由
iter-20260822-m1uc F3.1 定三级解析顺序；解析散落多处会使降级语义、配置覆盖、bundle 注入三处口径漂移（v1 rg 依赖问题即解析与调用混散的教训）；单点收口使「包内 → 配置 → PATH」成为可单测的纯函数，且 codegraph 等后续三方二进制有固定接入模式可复用（AD-1 分化策略的执行面）。

## 适用范围
接入任何三方二进制（rg/codegraph/未来工具）时；grep 域 resolve-rg 实现与评审；涉及 spawn 外部可执行文件的新代码评审；用户配置项（rg 路径类）的文件布局评审。

## 反例
在 rg-backend.ts 里直接 spawn("rg") 让 PATH 解析「顺便发生」——bundle 注入与用户配置两级被绕过，打包形态下用户配置覆盖失效且降级不可观测；或为图快在壳里解析 rg 路径后写进业务配置——业务路径回流壳，违背 TR-AD-6（壳只管 bundle 资源定位，注入走启动参数）。

```kg-node
id: TR-AD-33
kind: rule
graph: tech
layer: arch
scope: domain
stack: backend
name: grep 双后端一致性契约（语义对齐先于加速）
status: active
digest: 改 grep 工具、加检索后端、写一致性对比测试时
derivedFrom:
  - AD-2
  - CL-3
anchors:
  implementedBy:
    - apps/daemon/src/adapters/driven/tools/grep/
  testedBy:
    - apps/daemon/test/integration/grep-backends-parity.test.ts
    - apps/daemon/test/integration/grep-degrade.test.ts
relations:
  governs:
    - E-AgentRuntime
updatedIn: iter-20260822-m1uc
```

## 规则
内置 TS 后端与 rg 后端对同一检索请求必须产出语义一致的结果，契约逐项固化：gitignore 遵守、隐藏文件处理、glob 过滤、大小写开关、上下文行、返回格式（恒为 GrepMatch：path/lineNumber/line）。契约由双后端对比测试机械守护（同一请求对 fixture 仓库跑真实两后端做结果对比断言，不用 mock 替代 rg——TR-TEST-3 契约等价口径）；新增任何语义维必须双端同批扩展并同步扩契约断言。一致性未覆盖的 rg 差异行为一律在 rg 后端适配层对齐到内置 TS 语义（rg 默认遵守 .gitignore、跳过隐藏文件——与内置行为不一致即适配层归一），宁失速不失真：加速不得改变检索结果。降级链（AF-1 裁决语义：启动定格 + 首败永久降级）：组合根装配时一次性执行 resolve-rg 三级解析 + 轻量可用性探针（rg --version，2s 超时），结果内存定格——成功定格 rg 后端，失败定格 ts 标识 + startup info 日志（含缺失原因），进程生命周期内不重新解析、不升级；grep 每次调用只读内存标识选后端，零逐次降级判断；运行期首败永久降级——定格 rg 后某次调用失败/超时 → 当轮 ts 重跑返回结果 + warning 日志 + 翻转标识为 ts（此后直接 ts），判断只发生在失败路径一次；用户与 agent 无感。

## 理由
iter-20260822-m1uc CL-3 命门：rg 默认行为（gitignore/隐藏文件）若与内置 TS grep 不一致，加速会静默改变 agent 的检索结果——性能优化变成行为回归；契约先于加速钉死，双后端对比测试把「语义一致」从口头约定变成红绿事实；降级链保证零依赖环境（干净 macOS 无 rg）功能完备（CL-1 F1.3 零依赖功能验证的架构前提）。AF-1（用户裁决 2026-08-22）：降级判定收束为启动时一次性能力检查 + 运行期首败永久翻转，杜绝逐次调用现场判断带来的口径漂移与不可观测性。

## 适用范围
grep 工具双后端实现与评审；新增检索语义维（新参数/新过滤行为）时的双端同批扩展；一致性契约测试维护；rg 后端适配层的行为归一评审；降级路径与日志面评审。

## 反例
rg 后端直接透传 rg 原生行为（默认遵守 .gitignore、跳隐藏文件）而不与内置 TS 后端对齐——同一代码库在「有 rg」与「无 rg」环境下 agent 看到不同检索结果，加速变成行为分叉；或新增 glob 语义只改 TS 后端忘改 rg 后端且无契约断言——双端语义静默漂移，无测试能红；或每次 grep 调用时现场探测 rg 是否可用/是否超时来选后端——逐次判断违反启动定格口径（AF-1），降级时机与日志面不可观测。

```kg-node
id: TR-AD-34
kind: rule
graph: tech
layer: arch
scope: domain
stack: shared
name: Tauri 壳资源捆绑布局（externalBin sidecar + resources/bin 三方二进制）
status: active
digest: 接 Tauri 打包、配 bundle 资源、动 sidecar/rg 落包位置时
derivedFrom:
  - AD-4
  - AD-6
  - CL-2
anchors:
  implementedBy:
    - apps/shell/src-tauri/tauri.conf.json
    - scripts/build-desktop.ts
    - scripts/fetch-rg.ts
  testedBy:
    - scripts/tauri-conf.test.ts
    - scripts/build-desktop.test.ts
relations:
  governs:
    - E-AgentRuntime
updatedIn: iter-20260822-m1uc
```

## 规则
打包产物的资源落位分三条固定通道：①daemon 编译单文件（bun build --compile 产物）走 Tauri externalBin（sidecar 机制）——sidecar 语义 = 被壳看护的 daemon 进程，壳 spawn 并做进程看护；②三方二进制（本期 rg macOS arm64，后续 codegraph 同通道）走 bundle resources，包内落位 resources/bin/（tauri.conf bundle.resources 必须用 map 形式显式指定包内目标位，slice 形式会保留配置相对路径前缀致落位错位，AF-6）；③shell 静态产物（vite build dist）走 frontendDist。三类资源禁止错位：三方二进制不得塞进 externalBin（sidecar 语义专属被看护 daemon），daemon sidecar 不得散落成普通 resources，前端产物不走 resources 手工拷贝。架构目标 arm64 only：所有捆绑二进制只产单架构，不做 universal 双份（AD-6）。构建管线一条命令依序编排：fetch-rg → bun build --compile → 等价验证 → vite build → tauri build，任一步失败即中断报错（CL-2 F2.1）；签名配置位读环境变量（有=签名+公证/无=ad-hoc，AD-5），不硬编码证书。

## 理由
iter-20260822-m1uc AD-4/F2.3 定三通道布局；externalBin 与 resources 在 Tauri 语义上是两种机制（进程看护目标 vs 数据资源），错位会使壳的 spawn/看护逻辑与资源定位逻辑纠缠；arm64 only 是用户确认的范围裁决（universal 需 rg/daemon 双份，工作量 +30% 收益小）；管线失败即断保证分发物不会产生「半截打包」的歧义状态。

## 适用范围
src-tauri/tauri.conf.json 的 externalBin/bundle/frontendDist 配置评审；构建管线脚本（build-desktop）实现与评审；新增三方二进制捆绑时的落位决策；签名/公证配置位接线评审。

## 反例
把 rg 也打成 externalBin sidecar——壳的 sidecar 看护面被迫处理「非 daemon 进程」，spawn 语义混淆；或把 daemon compile 单文件丢进 resources 再壳手工拼路径 spawn——绕过 Tauri sidecar 机制，签名/公证与权限面失去框架保障；或为 Intel Mac 兼容悄悄加 universal target——AD-6 裁决被架空，rg/daemon 双份捆绑成本静默进场；或 bundle.resources 用 slice 形式导致 resources/bin/rg 落位保留前缀（Contents/Resources/resources/bin/rg）与壳定位位错位——AF-6 实测教训，须用 map 形式显式指定包内目标位。

```kg-node
id: TR-AD-35
kind: rule
graph: tech
layer: arch
scope: domain
stack: shared
name: daemon 双运行形态同构（dev bun 直跑 / 打包 compile sidecar）
status: active
digest: 动 dev 编排、打包管线、daemon 进程启动方式时
derivedFrom:
  - CL-4
  - CL-2
  - TR-AD-12
anchors:
  implementedBy:
    - scripts/dev-desktop.ts
    - scripts/compile-daemon.ts
    - apps/daemon/src/main.ts
    - apps/daemon/src/infrastructure/parent-watchdog.ts
  testedBy:
    - apps/daemon/test/arch-guard/form-isomorphism.test.ts
    - smoke/verify-compiled-daemon.ts
    - scripts/dev-desktop.test.ts
    - apps/daemon/test/integration/sidecar-mode.test.ts
    - apps/daemon/test/unit/parent-watchdog.test.ts
relations:
  governs:
    - E-AgentRuntime
updatedIn: hotfix-20260822
```

## 规则
daemon 存在两种运行形态：dev 形态 = bun 直跑源码（一行 dev 命令编排：daemon 经壳 sidecar wrapper 直跑源码 + vite dev server + tauri dev；前置自检 = Rust/cargo（缺失输出一行安装提示并退出——Rust 是 Tauri 壳构建前提，非 helix 运行时依赖）+ rg 存在性检查（缺失自动 fetch-rg 幂等补，失败一行警告不阻塞——dev rg 走 PATH/config 三级解析兜底，顺带为 build 暖场）；tauri dev 经 `--config '{"bundle":{"externalBin":[],"resources":[]}}'` override 剥离 bundle 资源生产校验——dev 不消费 externalBin（daemon 跑源码）与 resources（rg 三级解析），tauri.conf 生产三通道声明不动（RFC 7386 实测：数组字段覆盖语义成立、resources 必须 [] 非 {}——空对象 patch 对 map 字段是递归合并空操作、必须 v2 格式无 "tauri" 包装键）；vite 端口覆盖位经同通道 devUrl 随动——tauri dev 启动前等待 devUrl 可达（180s 超时退出），不随动则空等默认 5173（hotfix-20260822 H-1））；打包形态 = bun build --compile 单文件 sidecar。两形态行为一致性由 compile 产物等价验证兜底（F2.2：compile 单文件验证 spawn 自身跑子进程链路 + bun:sqlite，产出「功能等价于 dev 直跑」的验证报告，管线内步骤非手工检查）；compile 产物只在构建管线验证，dev 永远直跑源码。daemon 行为不得按运行形态分叉：禁止 daemon 代码内出现「检测自身是 compile 产物则走另一路径」类分支（资源定位差异只允许经启动参数注入消解，见三方二进制解析收口规则；argv 分发入口 --sidecar/--child-main 是双形态共享的同一路径，非形态分支）。sidecar 形态 daemon 侧义务（hotfix-20260822 H-4，契约 §3 补款）：父死看门狗——壳的收编只在优雅退出路径执行，壳异常死亡（SIGKILL/崩溃/Ctrl+C 前台进程组广播秒杀）时 sidecar 被 reparent 到 pid 1 成孤儿持锁常驻（砖化下次启动）；sidecar 形态周期（5s）判定 ppid==1 → 走 SIGTERM 同一优雅关停。判据无歧义（壳恒直 spawn 且终身看护，sidecar 形态父死 = 孤儿）；仅 sidecar 形态接线（CLI 形态父 = 终端会话，归 SIGHUP 体系管）。本规则是 TR-AD-12 的 daemon 侧互补：前端永远走同一 WS 通路，daemon 侧同样双形态同构。

## 理由
iter-20260822-m1uc CL-4 内嵌决策（用户 2026-08-22 确认）：dev 直跑源码保证调试体验（断点/热改/源码栈），compile 产物只在管线验证避免 dev 期被编译速度拖累；F-7① 实锤 compile 产物 spawn 自身跑 ChildMain 链路未验证——形态差异必须有机械兜底，否则「dev 能跑、打包炸」会在分发后才暴露；行为分叉分支一旦出现即产生双轨，与 TR-AD-12 前端面同构约束同一原理。

## 适用范围
dev 编排脚本（dev-desktop）与前置自检实现评审；构建管线 F2.2 等价验证步骤维护；daemon 进程启动/子进程 spawn 相关改动（ChildMain 链路、bun:sqlite 使用）评审；任何「按形态分支」的 daemon 代码评审。

## 反例
daemon 里写 if (isCompiled) { 用另一套子进程启动方式 }——双形态行为分叉，F2.2 等价验证失去意义（验证的不再是同一份行为）；或 dev 也跑 compile 产物求「绝对一致」——dev 调试体验被编译周期拖垮，且 CL-4 内嵌决策被违反；或前置自检缺失时直接 tauri dev 报一堆 Rust 工具链原始错误——F4.1 要求的一行安装提示指引被绕过；或 dev:desktop 编排器直接 spawn daemon 与壳 sidecar 机制并存——双 daemon 撞默认端口 fail-fast，daemon 必须经壳 sidecar + HELIX_SIDECAR_PATH wrapper 注入（AF-6/T4.1 落地口径）；或去掉 dev 的 --config override 恢复对 tauri.conf 生产资源声明的依赖——干净态首次 dev:desktop 被 externalBin/resources 生产校验连续误伤（exit 101）回归（H-1 实证）；或 sidecar 父死不管——壳异常死亡后 daemon reparent 成 pid 1 孤儿持锁常驻，下次启动新 sidecar 撞锁 fail-fast、壳看护重试 3 次注定失败砖化（H-4 实证，父死看门狗收口）。

```kg-node
id: TR-AD-36
kind: rule
graph: tech
layer: arch
scope: domain
stack: backend
name: SubAgent 进程外资源共享通道（wire 转发 + owner 归属校验）
status: active
digest: 给子进程开放 daemon 进程内共享单例资源（CDP/浏览器）、动 subagent wire 协议、评审进程外 port 实现时
derivedFrom:
  - AD-1（hotfix-20260822：SubAgent 接入 CDP 用户裁决——转发通道/归属校验/无队列）
anchors:
  implementedBy:
    - apps/daemon/src/adapters/driven/subagent/child/RemoteBrowserPort.ts
    - apps/daemon/src/adapters/driven/subagent/ScopedBrowserProxy.ts
    - apps/daemon/src/adapters/driven/subagent/transport/wire.ts
    - apps/daemon/src/adapters/driven/subagent/SubagentLauncher.ts
  testedBy:
    - apps/daemon/test/unit/subagent-remote-browser-port.test.ts
    - apps/daemon/test/unit/subagent-scoped-browser-proxy.test.ts
    - apps/daemon/test/unit/subagent-wire.test.ts
    - apps/daemon/test/integration/subagent-child.test.ts
relations:
  governs:
    - E-AgentRuntime
updatedIn: hotfix-20260822
```

## 规则
daemon 进程内共享单例资源（本期 = CDP 浏览器连接 CdpConnectionManager）不向子进程扩散实现：子进程经 port 的进程外实现 + stdio wire 帧（tool-req/tool-res，reqId 关联，256KB 出口截断护栏）转发调用，daemon 侧 ScopedBrowserProxy 纯函数收口后调单例。六要点：①wire 白名单 = 工具可达的操作方法；管理面方法（connect/onStatusChange/stop/reclaimOwner）不上 wire，子进程侧本地安全 noop——stop/reclaimOwner 越 owner 边界（波及他人 tab/全局连接），归属校验兜不住，有意收窄；②owner 归属强制：openTab ownerId 改写为通道 instanceId（不可伪造），tabId 方法查归属拒绝越权，listTabs 过滤 owner 子集，getStatus 透传；launcher 只转发不决策（AG-12），校验全部落纯函数面；③ownerId 单命名空间 = agentId（"main" = MAIN_INSTANCE_ID 保留值）；各 agent 自开自关，回收 = 终态钩子 reclaimOwner(agentId)（既有接线）+ idle sweep 同口径，无移交/共享机制；④lazy connect 调用方无关：SubAgent 首发调用即可拉起连接，主线幂等复用；连接生命周期 = daemon，子进程退出只回收其 tabs 不断连；⑤并发安全靠归属校验（操作集合不相交）不靠队列互斥——sendCDP 单 WS 在飞并发 + id 关联，并发上限间接由调度器全局预算约束；⑥大体积不过 IPC：截图只传路径，子进程自行 readFile 回填（同机文件系统共享）。BrowserPort.getStatus/listTabs 为此 async 化（同步签名是进程外化障碍）。演进兼容存档：BrowserPort 传输无关（进程内/IPC/未来网络 RPC 可替换），ownerId 可直接当 DAG nodeId。

## 理由
P0-1（plan-web-access 审核）否决子进程直连（各自连浏览器 = TabRegistry/idle sweep/回收管理面分裂 + 授权弹窗/竞态），留白「子进程↔daemon 转发通道后置」；H-3 落地该留白。域形状 port（零 CDP 符号、全 JSON 可序列化）天然可进程外化；BrowserTools/CoreToolExecutor 条件注册先例使工具面零改动。归属校验而非互斥队列：tab 唯一归属一个 owner 后操作集合不相交，无共享资源可互斥。

## 适用范围
subagent wire 协议扩展；子进程新增 daemon 单例资源访问能力（同模式复用：新 port 进程外实现 + Scoped 代理）；BrowserPort 签名演进评审；DAG 节点化时 ownerId→nodeId 映射评审。

## 反例
子进程直连 CDP 或自起浏览器进程——P0-1 否决形态复发：管理面分裂，且自起浏览器的临时 profile 不在发现矩阵（daemon 反而不可见）；或把 stop/reclaimOwner 放上 wire——子进程停掉全局共享连接/回收主线 tab，越 owner 边界；或为多子进程并发加队列互斥——误把共享资源当互斥问题（归属校验已切开操作集合）；或转发帧携带截图 base64 等大体积负载——行 JSON 无流控背压失控（路径传参 + 同机文件系统共享是正解）。

## 规则
daemon 进程内共享单例资源（本期 = CDP 浏览器连接 CdpConnectionManager）不向子进程扩散实现：子进程（ChildMain）经 port 的进程外实现（RemoteBrowserPort implements BrowserPort）+ stdio wire 帧（tool-req/tool-res，reqId 关联，256KB 出口截断护栏）转发调用，daemon 侧 ScopedBrowserProxy 纯函数收口后调单例。六要点：①wire 白名单 = 工具可达的 12 个操作方法；管理面 4 方法（connect/onStatusChange/stop/reclaimOwner）不上 wire，子进程侧本地安全 noop——stop/reclaimOwner 越 owner 边界（波及他人 tab/全局连接），归属校验兜不住，有意收窄；②owner 归属强制：openTab ownerId 改写为通道 instanceId（不可伪造），tabId 方法查归属拒绝越权，listTabs 过滤 owner 子集，getStatus 透传；launcher 只转发不决策（AG-12），校验全部落纯函数面；③ownerId 单命名空间 = agentId（"main" = MAIN_INSTANCE_ID 保留值）；各 agent 自开自关，回收 = 终态钩子 reclaimOwner(agentId)（既有接线）+ idle sweep 同口径，无移交/共享机制；④lazy connect 调用方无关：SubAgent 首发调用即可拉起连接，主线幂等复用；连接生命周期 = daemon，子进程退出只回收其 tabs 不断连；⑤并发安全靠归属校验（操作集合不相交）不靠队列互斥——sendCDP 单 WS 在飞并发 + id 关联，并发上限间接由调度器全局预算约束；⑥大体积不过 IPC：截图只传路径，子进程自行 readFile 回填（同机文件系统共享）。BrowserPort.getStatus/listTabs 为此 async 化（同步签名是进程外化障碍）。演进兼容存档：BrowserPort 传输无关（进程内/IPC/未来网络 RPC 可替换），ownerId 可直接当 DAG nodeId。

## 理由
P0-1（plan-web-access 审核）否决子进程直连（各自连浏览器 = TabRegistry/idle sweep/回收管理面分裂 + 授权弹窗/竞态），留白「子进程↔daemon 转发通道后置」；H-3 落地该留白。域形状 port（零 CDP 符号、全 JSON 可序列化）天然可进程外化；BrowserTools/CoreToolExecutor 条件注册先例使工具面零改动。归属校验而非互斥队列：tab 唯一归属一个 owner 后操作集合不相交，无共享资源可互斥。

## 适用范围
subagent wire 协议扩展；子进程新增 daemon 单例资源访问能力（同模式复用：新 port 进程外实现 + Scoped 代理）；BrowserPort 签名演进评审；DAG 节点化时 ownerId→nodeId 映射评审。

## 反例
子进程直连 CDP 或自起浏览器进程——P0-1 否决形态复发：管理面分裂，且自起浏览器的临时 profile 不在发现矩阵（daemon 反而不可见）；或把 stop/reclaimOwner 放上 wire——子进程停掉全局共享连接/回收主线 tab，越 owner 边界；或为多子进程并发加队列互斥——误把共享资源当互斥问题（归属校验已切开操作集合）；或转发帧携带截图 base64 等大体积负载——行 JSON 无流控背压失控（路径传参 + 同机文件系统共享是正解）。

```kg-node
id: TR-AD-37
kind: rule
graph: tech
layer: arch
scope: domain
stack: backend
name: AgentProfile hooks 声明形态 = HookCtor 构造器引用（装配点实例化）
status: active
digest: 新增 HookSet、动 AgentProfile.hooks 声明、评审多会话/多 runtime hooks 隔离时
derivedFrom:
  - AD-1（hotfix-20260823：SubAgent 编排推送闭环与过程监督用户裁决）
anchors:
  implementedBy:
    - apps/daemon/src/adapters/driven/pi-engine/runtime/AgentProfile.ts
    - apps/daemon/src/adapters/driven/pi-engine/runtime/AgentRuntime.ts
    - apps/daemon/src/adapters/driven/pi-engine/runtime/profiles/MainSessionProfile.ts
    - apps/daemon/src/adapters/driven/pi-engine/runtime/profiles/SubAgentProfile.ts
  testedBy:
    - apps/daemon/test/integration/profile-hooks-isolation.test.ts
    - apps/daemon/test/arch-guard/arch-guard.test.ts
relations:
  governs:
    - E-AgentProfile
    - E-HookSet
    - E-AgentRuntime
updatedIn: hotfix-20260823
```

## 规则
profile.hooks 声明 HookCtor（`new (): HookSet` + `static readonly hookName`）构造器引用——纯数据，不声明实例。实例化唯一位于 AgentRuntime 装配点（`profile.hooks.map(H => new H())`），每 runtime 独立实例、逐实例 bind。新 HookSet 类必须提供 `static readonly hookName`（与实例 `.name` 等值，如 "steer"/"minimal"）；快照读面经 `H.hookName` 取值——`H.name` 是类构造器名语义（"SteerHooks"），与 hook 名不等值，禁用。

## 理由
P0 实证（2026-08-23 多会话实测）：模块级共享 hooks 实例 + `SteerHooks.bind(agent)` 后建覆盖先建 → 会话 A 的 closure steer/abort 注入会话 B（B 的 LLM 上下文直证收到、A 的 LLM 反而未收到；domain entry 归属本来正确）。`bind` 携带 agent 引用使 HookSet 天然 per-runtime，共享即串台。工厂函数方案被 AG-10 守护否决（profiles/ 纯声明式，正则禁 function/=>/if）——类引用是纯数据，守护零改动即绿，且实例化落在真正的根（装配点），profiles/ 保持架构要求的纯声明形态。

## 适用范围
新增 HookSet 类；AgentProfile 声明变更评审；多 runtime/多会话形态的注入与中断链路评审；快照读面 hook 名单取值；测试内 TestProfile 的 hooks 声明。

## 反例
profile 里 `new` 出 hooks 实例（模块级常量被多 runtime 复用 = P0 串台复发）；或为绕 AG-10 把工厂函数放进 profiles/（守护禁函数语法——正确解法是类引用声明 + 装配点实例化，不是放松守护）；或快照读面用 `H.name`（类名而非 hook 名，快照值漂移）；或新 HookSet 缺 `static hookName`（类型契约不满足，编译期拦截）。

```kg-node
id: TR-AD-38
kind: rule
graph: tech
layer: arch
scope: domain
stack: backend
name: closure 送达保证——aborting 暂存 + idle 链式 flush（run 收口同步段窗口）
status: active
digest: 改 ChatService.injectClosure 生命周期分支、评审「run 收口同步段内续发消息」场景时
derivedFrom:
  - AD-1（hotfix-20260823：SubAgent 编排推送闭环与过程监督用户裁决）
  - AD-8（ADR-subagent-scheduler：双通道异步交付）
anchors:
  implementedBy:
    - apps/daemon/src/application/services/ChatService.ts
  testedBy:
    - apps/daemon/test/unit/chat-service-closure-flush.test.ts
relations:
  governs:
    - E-会话聚合
    - E-SteerQueue
    - E-ClosureRecord
updatedIn: hotfix-20260823
```

## 规则
closure 注入主线四种生命周期全覆盖（送达保证）：idle → sendMessage 新 turn；running/steering → applySteer + engine.steer（turn 边界 drain）；aborting → 内存 FIFO 暂存（closureBuffer），abort 收尾回 idle 后经 scheduleClosureDrain 挂 dying run promise settle、再逐条链式 flush（每条独立 sendMessage 新 turn，fire-and-forget，失败 engine.error 可观测不崩链）；stopped → 可观测丢弃（closure_records 已落盘，恢复会话可见，不补投）。flush 窗口被用户新 run 抢占时挂该 run 收口后续送（幂等守卫，无双发无重投）。两条铁律：①flush 不得在 agent_end 同步回流段内直接 sendMessage——此时 idle 已置但引擎 promise 未 settle、仍视为在飞，同段直发撞协议误用守卫（delete-settle-race 同款窗口）；②closure 一律以顶层新 turn 送达，不并入 steer 队列（applySteer 仅 running/steering 分支用）。

## 理由
aborting/stopped 直丢破坏「closure 保证送达」契约——用户中断生成恰是 SubAgent 收口高发窗口，结论静默丢失后 MainAgent 无从知情，推送模型的前提被挖空（实测这正是 MainAgent 不信任注入、反复轮询的根源之一）。「同步段内直发不可行」是实测裁决（FakeAgentEngine 在飞守卫与真引擎同险）；promise settle 后逐条链式 flush 以 6 用例证明不丢/不乱序/不崩/抢占可续送。

## 适用范围
ChatService 生命周期分支变更；任何「run 收口同步段内续发消息」的新场景（同窗口规则复用）；closure/steer 注入语义评审；推送模型送达保证的回归验收。

## 反例
aborting 直丢（送达保证破窗）；或在 agent_end 同步回流段内直接 sendMessage（引擎在飞守卫竞态）；或把 closure flush 并入 steer 队列（closure 须以顶层新 turn 送达，混入注入队列改变 drain 语义）；或 stopped 也暂存补投（daemon 已停无可投递对象，落盘恢复语义已覆盖，补投无消费者）。

```kg-node
id: TR-AD-39
kind: rule
graph: tech
layer: arch
scope: domain
stack: backend
name: SubAgent 过程监督契约——周期进展报告（机械 Δ）+ agent_inspect + 永不自动终止
status: active
digest: 改 SubAgent 监督/报告/终止机制、spawn 参数、编排工具语义、主会话委派提示词契约时
derivedFrom:
  - AD-1（hotfix-20260823：SubAgent 编排推送闭环与过程监督用户裁决）
anchors:
  implementedBy:
    - apps/daemon/src/application/services/scheduler/SchedulerService.ts
    - apps/daemon/src/application/services/scheduler/SubagentEventTranslator.ts
    - apps/daemon/src/application/ports/inbound/AgentOrchestrationPort.ts
    - apps/daemon/src/adapters/driven/tools/agent/AgentOrchestrationTools.ts
    - apps/daemon/src/adapters/driven/pi-engine/runtime/profiles/MainSessionProfile.ts
  testedBy:
    - apps/daemon/test/integration/scheduler-progress-report.test.ts
    - apps/daemon/test/integration/agent-inspect.test.ts
    - apps/daemon/test/unit/main-prompt-contract.test.ts
relations:
  governs:
    - E-调度器
    - E-AgentInstance
updatedIn: hotfix-20260823
```

## 规则
系统只负责送达信息，永不自动终止。四件套：①spawn 可选 reportIntervalMs（缺省 0 不报告；>10 分钟任务建议 600000 起步，LLM 自估声明；>0 且有限才启用，负/NaN 视为 0）→ scheduler per-instance 定时器周期经 injectClosure 同通道注入一行机械信封（`[agent-N 进展报告 #k] 状态=running 静默=<idleMs>ms Δ工具调用=+x Δ输出=+y字符 Δ轮次=+z`——纯机械数据一行，无行为建议）；②机械计数器与 20 容量轨迹环缓冲由 translator 维护（流式防双计：thinking 走独立事件类型不混入字符计数，message_update 累加；onClosureCleanup 清空）；③agent_inspect 工具（Port.inspect → AgentInspection|null，含 idleMs/累计 toolCalls/轨迹）供 MainAgent 核实连续零增量报告；④主会话提示词正向契约：spawn 后简述计划并结束回合、closure/进展报告自动注入驱动下一轮、不轮询 agent_status 等待结果、不在实例执行期间自行重做该任务、连续零增量用 agent_inspect 核实后确无进展可 kill 重派、agent_status 仅用户主动询问进度时使用。定时器四点清理：终态 onInstanceClosure（紧邻 translator.onClosureCleanup 同序列位）/kill/cancelSession/stop；注入失败吞 engine.error 不崩调度。stalled 检测（lastEventAt）只警示不杀。

## 理由
机械阈值无解「有事件流但无进展」的死循环（LLM 打转时事件流不断、lastEventAt 持续新鲜，stalled 抓不到），而 wall-clock timeout 误杀长任务——「有无进展」需要任务上下文才能判定，只有 MainAgent/用户有。推送而非轮询：实测 MainAgent 明知会有 closure 注入仍轮询 14 次（LLM 闲时倾向主动做事），周期注入把「拉」改「推」从根上消灭轮询。机械 Δ 自带防 compaction 丢失判定依据（LLM 无需记忆历次报告，零增量即死循环信号）。不靠 SubAgent 自觉汇报——死循环实例恰恰不会汇报，机械定时器才可靠。每次报告注入 = main 一次 LLM turn 成本，故缺省关闭、长任务才声明。

## 适用范围
spawn/调度/监督链路变更；编排工具（agent_spawn/agent_send/agent_status/agent_inspect）语义评审；主会话委派契约提示词演进；「需 MainAgent 阶段性知情」新场景的复用模式；报告成本与间隔评审。

## 反例
加 wait 工具或 wall-clock timeout 自动 kill（与 AD-8 秒回推送模型冲突/误杀长任务）；信封里写行为建议或 markdown（机械数据一行，行为建议在提示词里）；靠 SubAgent 自觉 notify 汇报进度（死循环实例不会汇报，监督信号恰在最需要时缺席）；stalled 警示升级为自动终止（把「零事件」误判权交给机械阈值）；报告缺省开启或间隔过密（监督成本无差别摊到短任务）。

```kg-node
id: TR-AD-40
kind: rule
graph: tech
layer: arch
scope: domain
stack: backend
name: thinkingLevel 解析链（[覆盖, 槽位] 两级 + 默认关 + off 显式关；与 TR-AD-24 模型链同构）
status: active
digest: 动 thinkingLevel 来源、写 thinking 透传管线、配 profile thinking 槽位、动默认关/off 语义、写换模重播时
derivedFrom:
  - AD-1（iter-20260823-6ps5：thinkingLevel 解析链与 TR-AD-24 同构，用户裁决选项 B）
  - AD-3（iter-20260823-6ps5：覆盖保留 + 按能力解析，意图/生效分离）
  - AD-6（iter-20260823-6ps5：AgentProfile 配置资源扩可选 thinkingLevel 维）
  - D 方案（task-20260824-thinking-unify：用户裁决「思考默认都不开启，只有手动的时候去开启」——删兜底 medium，未配置 = 不传 reasoning = pi-ai 显式关）
  - off 升格（task-20260824-thinking-unify：用户裁决「off 升格为合法 override 值」——clamp 前短路防 off:null 模型升档反转）
anchors:
  implementedBy:
    - packages/protocol/src/commands.ts
    - packages/protocol/src/events/thinking.ts
    - packages/protocol/src/events/agent.ts
    - apps/daemon/src/adapters/driving/ws-server/handlers/thinking.ts
    - apps/daemon/src/adapters/driven/pi-engine/thinking-resolve.ts
    - apps/daemon/src/adapters/driven/pi-engine/model-provider.ts
    - apps/daemon/src/adapters/driven/pi-engine/PiAgentEngineAdapter.ts
    - apps/daemon/src/adapters/driven/pi-engine/runtime/AgentRuntime.ts
    - apps/daemon/src/adapters/driven/subagent/SubagentLauncher.ts
    - apps/daemon/src/adapters/driven/subagent/child/ChildMain.ts
    - apps/daemon/src/application/ports/outbound/AgentEnginePort.ts
    - apps/daemon/src/application/services/ModelService.ts
    - apps/daemon/src/infrastructure/assembly/buildSessionStack.ts
  testedBy:
    - apps/daemon/test/unit/subagent-thinking-chain.test.ts
    - apps/daemon/test/unit/model-provider.test.ts
    - apps/daemon/test/integration/subagent-child.test.ts
    - apps/daemon/test/integration/thinking-set-chain.test.ts
relations:
  governs:
    - E-AgentProfile
    - E-AgentInstance
updatedIn: task-20260824-thinking-unify
```

## 规则
thinkingLevel 按两条链解析，与 TR-AD-24 模型解析链同构、不新建第三处解析单点；**无兜底档——全链未配置 = 默认关**（task-20260824 D 方案：不传 reasoning 参数 = pi-ai 适配器显式关思考，anthropic thinkingEnabled:false / openai effort:off 或缺省）。主会话链（仅 mainAgent 引擎）：会话覆盖（composer 滑块 thinking.set，引擎内存态 + domain_events 落盘、跨冷恢复）> 主 session profile 槽位，链尽 → undefined = 默认关；解析单点 = buildSessionStack engineFor 工厂闭包，引擎每 turn 开始读解析结果。SubAgent 链：仅自身 profile 槽位（SubAgentProfile.thinkingLevel ?? subagent-worker kind 槽位，TR-AD-44 getter 折叠），无配置 → HELIX_THINKING_LEVEL env 缺席 → 子进程不装注入器 = 默认关；解析单点 = SubagentLauncher.resolveThinkingFor（launch 段唯一出口），定格值经 env 透传（ChildMain 只消费，无解析链）。主会话覆盖永不作用于 SubAgent。**"off" 为合法 override 值（显式关）**：链值 off 在 clampThinkingLevel 之前短路返回 undefined——off:null map 模型（真实目录约 15%）的 clamp("off") 会向上找最近支持档，「想关反而开」语义反转，故短路必须先于 clamp。引擎解析时链上每个值过「当前模型支持」过滤（resolveEffectiveThinking：model.reasoning 且 clamp 后非 off，取首个生效值）；模型无 reasoning 能力 → 整链 undefined。覆盖值不丢：换模只改生效档，切回原模型自动恢复；**model.set 成功后重播 thinking.changed**（生效档按新模型重算，消除 shell 侧 stale 档位；引擎无 currentThinking 观测面不广播）。观测面 currentThinking {override, effective} 双位（意图/生效分离）；agent.instantiated.thinkingLevel 必填→可选（未配置不携带）。

## 理由
与 TR-AD-24 模型解析语义同构：agent 行为 spawn 时刻确定、trace 可复盘；会话覆盖是 mainAgent 私有意图，SubAgent 行为由 profile 配置决定。默认关（D 方案）与 pi-ai 物理缺省契约对齐（不传 = 尽力显式关），reasoning tokens 占输出 30-60% 的成本对不用思考的会话是刚性浪费；"配置了但被能力静默过滤成 OFF"与"未配置"在用户视野同构（③ 实证语义稀释），默认关使 UI 显示 = 真实行为。意图（覆盖）与生效（解析结果）分离使换模无损。档位语义 SoT 在 pi-ai，helix 全链字符串透传、不维护第二份枚举。

## 适用范围
动主会话/SubAgent 的 thinking 参数来源与优先级时；动默认关/off 显式关语义时；写 streamFn 注入器 / spawn env 透传 / agent.instantiated 快照字段时；实现换模后生效档重解析与 UI 轻提示时；写 setModel/换模链路时（须同步重播 thinking.changed）。

## 反例
在 chat.send 逐消息 payload 携带 thinkingLevel（会话状态非消息参数，AD-4① 否决）；主会话覆盖经 spawn 快照传导到 SubAgent（覆盖是 mainAgent 私有意图，永不作用）；换模时钳制或清空覆盖值（意图丢失，AD-3 否决）；在链尾加任何兜底档（medium 或其他——默认关是缺省语义非链环节，加兜底即复活「显示 OFF 但实际发档」错位）；off 不短路直接过 clamp（off:null 模型升档反转）；在 UI 或注入器里 clamp 档位或维护第二份档位枚举（SoT 在 pi-ai）；在 ChildMain 子进程内重解析 thinking 链（子进程只消费 spawn 定格快照）；换模后不重播 thinking.changed（shell 显示 stale 档位）。

## 规则
thinkingLevel 按两条链解析，与 TR-AD-24 模型解析链同构、不新建第三处解析单点。主会话链（仅 mainAgent 引擎）：会话覆盖（composer 滑块 thinking.set，引擎内存态 + domain_events 落盘、跨冷恢复）> 主 session profile 槽位 > 兜底 medium；解析单点 = buildSessionStack engineFor 工厂闭包（buildSessionStack.ts:336-356 模型解析同点扩展），引擎每 turn 开始读解析结果（会话状态非逐消息参数）。SubAgent 链：spawn 时从自身 profile 槽位（AgentProfile.thinkingLevel 可选字段，留空 = 未配置）解析快照 > 兜底 medium；解析单点 = SubagentLauncher.resolveThinkingFor（resolveModelFor 同点扩展，launch 段为唯一出口），解析快照随 agent.instantiated 落盘事件携带、经 env 定格透传子进程（ChildMain 无解析链，只消费定格值）。主会话覆盖永不作用于 SubAgent。引擎解析时链上每个值过「当前模型支持」过滤（model.reasoning 且 thinkingLevelMap[值] !== null），取第一个被支持值；全链不支持（或模型无 reasoning 能力）→ 不传 thinking 参数（provider 默认）。覆盖值不丢：换模只改生效档，切回原模型自动恢复。

## 理由
与 TR-AD-24 模型解析语义同构：agent 行为 spawn 时刻确定、trace 可复盘；会话覆盖是 mainAgent 私有意图，SubAgent 行为由 profile 配置决定，便于与模型匹配。意图（覆盖）与生效（解析结果）分离使换模成为无损操作。档位语义 SoT 在 pi-ai，helix 全链字符串透传、不维护第二份枚举，pi-ai 未来加档零协议改动。

## 适用范围
动主会话/SubAgent 的 thinking 参数来源与优先级时；新增会话级引擎参数并考虑是否挂进解析链时；写 streamFn 注入器 / spawn env 透传 / agent.instantiated 快照字段时；实现换模后生效档重解析与 UI 轻提示时。

## 反例
在 chat.send 逐消息 payload 携带 thinkingLevel（会话状态非消息参数，AD-4① 否决）；主会话覆盖经 spawn 快照传导到 SubAgent（覆盖是 mainAgent 私有意图，永不作用）；换模时钳制或清空覆盖值（意图丢失，AD-3 否决选项 B/C）；在 UI 或注入器里 clamp 档位或维护第二份档位枚举（SoT 在 pi-ai，过滤只在引擎解析段一次完成）；在 ChildMain 子进程内重解析 thinking 链（子进程只消费 spawn 定格快照）。

```kg-node
id: TR-AD-41
kind: rule
graph: tech
layer: arch
scope: domain
stack: shared
name: 会话级参数协议演进模式（会话状态命令族 + 快照恢复，区别于逐消息 payload）
status: active
digest: 给会话加跨 turn 生效的运行参数、在 chat.send 与独立命令族之间选承载位、设计参数跨冷恢复时
derivedFrom:
  - AD-4（iter-20260823-6ps5：协议 additive 四块——thinking.set/thinking.changed 命令族 + CatalogModel 能力位 + session 快照恢复 + agent.instantiated 携带）
  - F-3（iter-20260823-6ps5：ChatSendPayload 仅 text/draft?/model?/images? 四字段，会话级参数 plumbing 不存在）
  - F-5（iter-20260823-6ps5：model.set per-session 覆盖不跨冷恢复现状——thinking 批显式选择不同的持久化语义）
anchors:
  implementedBy:
    - packages/protocol/src/commands.ts
    - packages/protocol/src/events
    - packages/protocol/src/events/agent.ts
    - apps/daemon/src/adapters/driving/ws-server/handlers/thinking.ts
    - apps/daemon/src/application/services/ModelService.ts
    - apps/daemon/src/application/services/ChatService.ts
    - apps/daemon/src/application/services/SessionRegistry.ts
    - apps/daemon/src/application/services/RestoreService.ts
    - apps/daemon/src/application/ports/inbound/SessionPort.ts
    - apps/daemon/src/infrastructure/assembly/buildSessionStack.ts
  testedBy:
    - packages/protocol/test/type-surface/thinking.test.ts
    - apps/daemon/test/integration/thinking-set-chain.test.ts
    - apps/daemon/test/integration/thinking-restore.test.ts
relations:
  governs:
    - E-会话聚合
updatedIn: iter-20260823-6ps5
```

## 规则
会话级持久状态参数（跨 turn 生效、需跨冷恢复、语义上属于「会话状态」而非「消息本体」）走独立命令族三件套：① xxx.set 命令（信封 sessionId 必填 per-session）→ daemon 覆盖写引擎内存态（AgentEnginePort 直改面，下一 turn 生效；thinking.set 链 = handlers/thinking.ts → ModelService/ChatService → AgentEnginePort → PiAgentEngineAdapter/AgentRuntime → domain_events 单写队列落盘，TR-AD-5）+ ② xxx.changed 广播（EventStream，前端状态树同步）+ ③ session 快照（SessionStateView additive 扩字段）携带该参数，RestoreService 回放重建实现跨冷恢复（restoreThinkingOverride 只读回放末值直写引擎内存——绕过发布面、零新事件流，与 model.set 不恢复的差异为显式负断言钉死）。per-session 直改命令族是同构模板的第二次实例化（model.set 先例），新参数按模板四步接线。chat.send payload 只承载消息本体参数（text/images/draft），永不加会话状态字段；引擎 turn 开始读解析结果。契约演进保持 additive（v0.1 起先例）：只加不改，新命令/事件/字段按批登记。是否需要跨冷恢复是每个会话级参数的显式裁决点（model.set 不持久 vs thinking.set 持久，两种合法形态并存）。

## 理由
会话级持久状态语义与 chat.send 逐消息参数冲突：逐消息带参会复制状态、模糊权威源（最后一条消息 vs 会话状态）；命令族 + 落盘 + 快照三件套复用既有单写队列与恢复管线，事件溯源天然给出 trace 可复盘性。additive 演进纪律保护既有客户端与测试契约零破坏。

## 适用范围
新增任何「会话级、跨 turn、引擎侧生效」的运行参数时（thinking.set 为首例，后续同类参数直接套用同构模板）；评审 chat.send 加字段提案时（几乎必然是反例）；设计参数的持久化/恢复语义时；规划契约版本批次时。

## 反例
把 thinkingLevel 挂进 chat.send 逐消息带（AD-4 选项 A，已否决：会话状态非逐消息参数）；引擎每 turn 从消息历史反推参数（无权威源）；新参数直接改既有 DTO 字段语义（非 additive，破坏契约先例）；不加显式裁决就默认参数跨冷恢复（model.set 与 thinking.set 持久化语义不同，必须逐参数裁决）。

## 规则
会话级持久状态参数（跨 turn 生效、需跨冷恢复、语义上属于「会话状态」而非「消息本体」）走独立命令族三件套：① xxx.set 命令（信封 sessionId 必填 per-session）→ daemon 覆盖写引擎内存态（AgentEnginePort 直改面，下一 turn 生效）+ domain_events 单写队列落盘（TR-AD-5）；② xxx.changed 广播（前端状态树同步）；③ session 快照（SessionStateView additive 扩字段）携带该参数，RestoreService 回放重建实现跨冷恢复。chat.send payload 只承载消息本体参数（text/images/draft），永不加会话状态字段；引擎 turn 开始读解析结果。契约演进保持 additive（v0.1 起先例）：只加不改，新命令/事件/字段按批登记。是否需要跨冷恢复是每个会话级参数的显式裁决点（model.set 不持久 vs thinking.set 持久，两种合法形态并存）。

## 理由
会话级持久状态语义与 chat.send 逐消息参数冲突：逐消息带参会复制状态、模糊权威源（最后一条消息 vs 会话状态）；命令族 + 落盘 + 快照三件套复用既有单写队列与恢复管线，事件溯源天然给出 trace 可复盘性。additive 演进纪律保护既有客户端与测试契约零破坏。

## 适用范围
新增任何「会话级、跨 turn、引擎侧生效」的运行参数时（thinking.set 为首例，后续同类参数直接套用）；评审 chat.send 加字段提案时（几乎必然是反例）；设计参数的持久化/恢复语义时；规划契约版本批次时。

## 反例
把 thinkingLevel 挂进 chat.send 逐消息带（AD-4 选项 A，已否决：会话状态非逐消息参数）；引擎每 turn 从消息历史反推参数（无权威源）；新参数直接改既有 DTO 字段语义（非 additive，破坏契约先例）；不加显式裁决就默认参数跨冷恢复（model.set 与 thinking.set 持久化语义不同，必须逐参数裁决）。

```kg-node
id: TR-AD-42
kind: rule
graph: tech
layer: convention
scope: domain
stack: shared
name: 能力位驱动 UI（CatalogModel 防腐能力字段 → UI 按能力渲染/禁用，不硬编码）
status: active
digest: 前端渲染与模型能力相关的控件（档位、选项集、开关）时；给 CatalogModel 加防腐字段时；UI 需要禁用/降级提示时
derivedFrom:
  - AD-2（iter-20260823-6ps5：档位全暴露、必选、字符串透传，档位语义 SoT 在 pi-ai）
  - "AD-4②（iter-20260823-6ps5：CatalogModel 防腐 reasoning: boolean + thinkingLevels: string[]，pi-ai thinkingLevelMap 键集派生）"
  - F-6（iter-20260823-6ps5：pi-ai reasoning 能力位齐备，协议未防腐）
anchors:
  implementedBy:
    - packages/protocol/src/types/model.ts
    - apps/daemon/src/adapters/driven/pi-engine/model-catalog.ts
    - apps/shell/src/features/model-switch
    - apps/shell/src/features/thinking-level
    - apps/shell/src/entities/session
    - apps/shell/src/shared/api/commands.ts
    - apps/shell/src/shared/lib/catalog-match.ts
  testedBy:
    - apps/shell/src/shared/api/commands.test.ts
    - apps/shell/src/features/thinking-level/ui/ComposerThinkingPicker.test.tsx
    - apps/shell/src/features/thinking-level/ui/ThinkingLevelSlider.test.tsx
    - apps/shell/src/features/thinking-level/ui/thinking-level.css.test.ts
    - apps/shell/src/features/thinking-level/model/thinking-resolution.test.ts
    - apps/shell/src/entities/session/model/consumers/thinking-level.test.ts
relations:
  governs:
    - E-模型目录
updatedIn: iter-20260823-6ps5
```

## 规则
模型相关 UI 控件的可选集与可用性一律由协议 CatalogModel 防腐能力字段驱动：daemon 在 pi-ai 防腐墙内（model-catalog.ts snapshot() 映射单点）把 pi-ai 能力位（如 Model.reasoning / thinkingLevelMap 非 null 键集派生 = getSupportedThinkingLevels(model).filter(l => l !== "off")）映射为协议字段（如 reasoning: boolean + thinkingLevels: string[]，canonical 升序与缺席键规则保持 pi-ai SoT）；shell 只消费协议字段渲染——刻度数 = thinkingLevels.length（thinking-capability.ts 刻度=length 不自判），能力缺失（reasoning === false）→ 控件禁用 + 提示。UI 不硬编码档位/能力全集，不自判模型能力，不 import pi-ai 类型。档位语义 SoT 在 pi-ai：helix 任何一层（protocol/daemon/shell）不维护第二份枚举，协议层字符串透传（thinkingSetCommand 零校验），pi-ai 加档零协议改动。覆盖意图与实际生效分离显示：控件强调实际生效值，意图 ≠ 生效时给轻提示（如「xhigh → high（模型能力所限）」）。首个完整实例化 = features/thinking-level（P-1 composer picker + P-2 profile 字段双消费位，ThinkingLevelSlider 共用原子组件 props 契约零改动双消费）。

## 理由
防腐字段让前端与 pi-ai 类型演进解耦（TR-AD-7 三域边界）；UI 硬编码枚举会在 pi-ai 加档/模型能力分化时静默漂移出错；能力位集中映射单点保证全端口径一致（P-3 模型可用性过滤已是同一哲学的先例：前端 join 协议字段，不自拉能力判据）。

## 适用范围
新增任何依模型能力变化的 UI 控件（档位滑块、参数选项、特性开关）时；评审前端出现硬编码模型能力/档位清单的 PR 时；给 CatalogModel 扩防腐字段时；设计控件禁用与降级提示交互时。

## 反例
UI 写死六档列表再按模型名 if-else 裁剪（能力判据散落、pi-ai 加档即漂移）；前端自行 import pi-ai 类型或维护模型能力表（越防腐墙）；模型不支持时隐藏控件不给提示（用户无法理解为何不可调）；覆盖意图与生效值混为一个显示态（意图/生效分离被破坏，换模后用户误以为覆盖丢失）。

## 规则
模型相关 UI 控件的可选集与可用性一律由协议 CatalogModel 防腐能力字段驱动：daemon 在 pi-ai 防腐墙内（model-catalog.ts 映射单点）把 pi-ai 能力位（如 Model.reasoning / thinkingLevelMap 非 null 键集）映射为协议字段（如 reasoning: boolean + thinkingLevels: string[]）；shell 只消费协议字段渲染——刻度数 = thinkingLevels.length，能力缺失（reasoning === false）→ 控件禁用 + 提示。UI 不硬编码档位/能力全集，不自判模型能力，不 import pi-ai 类型。档位语义 SoT 在 pi-ai：helix 任何一层（protocol/daemon/shell）不维护第二份枚举，协议层字符串透传，pi-ai 加档零协议改动。覆盖意图与实际生效分离显示：控件强调实际生效值，意图 ≠ 生效时给轻提示（如「xhigh → high（模型能力所限）」）。

## 理由
防腐字段让前端与 pi-ai 类型演进解耦（TR-AD-7 三域边界）；UI 硬编码枚举会在 pi-ai 加档/模型能力分化时静默漂移出错；能力位集中映射单点保证全端口径一致（P-3 模型可用性过滤已是同一哲学的先例：前端 join 协议字段，不自拉能力判据）。

## 适用范围
新增任何依模型能力变化的 UI 控件（档位滑块、参数选项、特性开关）时；评审前端出现硬编码模型能力/档位清单的 PR 时；给 CatalogModel 扩防腐字段时；设计控件禁用与降级提示交互时。

## 反例
UI 写死六档列表再按模型名 if-else 裁剪（能力判据散落、pi-ai 加档即漂移）；前端自行 import pi-ai 类型或维护模型能力表（越防腐墙）；模型不支持时隐藏控件不给提示（用户无法理解为何不可调）；覆盖意图与生效值混为一个显示态（意图/生效分离被破坏，换模后用户误以为覆盖丢失）。

```kg-node
id: TR-AD-43
kind: rule
graph: tech
layer: convention
scope: domain
stack: frontend
name: WS 命令拉取效应连接态门控（挂载期/进页期拉取必须 conn 门控 + 握手完成重发）
status: active
digest: 写挂载期/进页期 WS 命令拉取效应（model.catalog/model.get_default/auth.list/agent.config.list 同族）时
anchors:
  implementedBy:
    - apps/shell/src/features/thinking-level/ui/ComposerThinkingPicker.tsx
    - apps/shell/src/pages/skills/AgentPage.tsx
  testedBy:
    - e2e/CL-1-thinking-slider.spec.ts
relations:
  governs:
    - E-会话聚合
updatedIn: iter-20260823-6ps5
```

## 规则
shell 侧「组件挂载/进页即拉」的 WS 命令效应（useEffect 内 send model.catalog / model.get_default / auth.list / agent.config.list 等读命令）必须以连接态为门控：命令发送包裹在 conn === "connected" 判定内，且 conn 进效应依赖数组——握手完成时效应重跑自动补拉。HelixWsClient.send 对未握手连接是静默拒绝语义（无重试无排队），效应早于握手触发 = 命令丢失且永不再发。

## 理由
挂载期效应与 WS 握手完成是竞态关系而非先后保证（fresh-load 下效应先跑是常态）；send 的 fire-and-forget 静默失败使丢帧不可观测（UI 停在缺省态无报错）。conn 门控 + 依赖重发把竞态转为确定性状态机：未连接不发，连接态变化即重发。AgentPage [conn,...] 依赖是既有先例，ComposerThinkingPicker fresh-load 目录帧丢失（commit 3ec1f81 修复）证明该形态必须升格为全 shell 约定而非个案修补。

## 适用范围
shell 全部挂载期/进页期 WS 命令拉取效应（model.catalog / model.get_default / auth.list / agent.config.list 同族）；新增任何「组件挂载即发命令」的 useEffect 评审；排查「首屏数据缺省但手动刷新即恢复」类症状时（本规则违例是第一嫌疑）。

## 反例
useEffect(() => { api.requestModelConfig(); }, []) 裸依赖拉取——握手前挂载即静默丢帧，fresh-load 偶发必现（ComposerThinkingPicker 实证）；用 setTimeout 轮询重试替代 conn 门控（把确定性状态机换成竞态赌运气）；只在发送处 try/catch 吞错（静默失败语义下 catch 永不触发，问题被掩盖得更深）。

```kg-node
id: TR-AD-44
kind: rule
graph: tech
layer: convention
scope: domain
stack: backend
name: 配置资源槽位经 getter 折叠进 profile 读面（静态声明优先，解析单点保持字面链形状）
status: active
digest: 组合根把 resource_state 槽位接进 SubAgent 解析链读面、扩 SubagentLauncherDeps 注入源形态时
derivedFrom:
  - 架构师终审 F-1（iter-20260823-6ps5：AD-1 两级链与 AD-6 配置资源写入的张力求解，用户裁决采纳沉淀）
anchors:
  implementedBy:
    - apps/daemon/src/adapters/driven/subagent/SubagentLauncher.ts
    - apps/daemon/src/infrastructure/assembly/buildSessionStack.ts
  testedBy:
    - apps/daemon/test/unit/subagent-thinking-chain.test.ts
relations:
  governs:
    - E-AgentProfile
    - E-智能体配置资源
updatedIn: iter-20260823-6ps5
```

## 规则
SubAgent 解析链（model / thinkingLevel 等）读 profile 槽位时，配置资源（resource_state kind 槽位）的合流不进解析单点本体：SubagentLauncherDeps.profile 扩为 AgentProfile | (() => AgentProfile)（与 deps.model / deps.apiKeys 注入源模式同构先例），组合根 getter 在 launch 时刻读现值把 kind 槽位折叠进 profile 读面——静态 profile 声明优先于运行期槽位值。resolveModelFor / resolveThinkingFor 单点本体保持字面链形状（profile 槽位 ?? … ?? 兜底），不感知折叠来源；subagentSnapshotFor 快照供给与解析共用同一 getter 读面（同源同时点，spawn 锚与实际解析零漂移）。

## 理由
解析单点若直接读 ResourceService：①adapters/driven/subagent 耦合 application 配置资源服务（依赖倒置破坏）；②单点内长出「静态声明 vs 槽位」第二张优先级表（链形状被侵蚀）。getter 折叠复用既有注入源模式零新机制，链形状不变使解析与快照天然同源。同形态此前两处靠注释维系（launcher 解析 + 快照供给手工复制同一链序），复制点越多注释维系越脆，落显式约定。

## 适用范围
组合根为 SubagentLauncher 装配任何「静态声明 + 运行期槽位」双来源的 profile 维度时；评审 deps 注入源形态扩展时；subagentSnapshotFor 快照供给与解析链读面一致性评审；新增 kind 维配置资源（工具/模型/thinking 之后的新槽位）接线时。

## 反例
resolveThinkingFor 内部直接调 resourceService.thinkingSlot(kind)（单点耦合配置资源 + 快照供给面漏读——两读面不同源即 spawn 快照与实际解析漂移）；getter 内做 clamp/过滤等解析职责（折叠只合流数据，解析归单点）；ChildMain 子进程重读 resource_state（子进程只消费 spawn 定格快照）。

```kg-node
id: TR-AD-45
kind: rule
graph: tech
layer: convention
scope: domain
stack: frontend
name: P-1 推理控件默认关显示形态（OFF 第 0 刻度 UI 合成 + 无覆盖/显式关同态 + ghost 区分）
status: active
digest: 动 chat composer 推理滑块刻度、改 OFF 档交互、动 chip 档位显示逻辑时
derivedFrom:
  - T2 显示决策（task-20260824-thinking-unify：默认关语义 UI 承接，用户裁决 scope 文案删除）
anchors:
  implementedBy:
    - apps/shell/src/features/thinking-level/ui/ComposerThinkingPicker.tsx
    - apps/shell/src/features/thinking-level/ui/ThinkingLevelSlider.tsx
  testedBy:
    - apps/shell/src/features/thinking-level/ui/ComposerThinkingPicker.test.tsx
relations:
  governs:
    - E-AgentProfile
updatedIn: task-20260824-thinking-unify
```

## 规则
P-1 chat composer 推理控件按默认关语义显示：滑块 OFF 为 UI 合成第 0 刻度（levels = ["off", ...CatalogModel.thinkingLevels]——协议与目录零变更，off 不进 pi-ai 档位枚举）；chip 无覆盖（effective=null，默认关）与显式关（override="off"）同态显示 OFF（AUTO 文案退场），滑块以 ghost 空心/实心 thumb 区分两态；选 OFF 刻度 → setSessionThinking("off") 协议透传（daemon 按 TR-AD-40 短路处理）；PEAK 判据入参用能力档序列（不含 off）防 thinkingLevels 空时误判；刻度数仍由 CatalogModel 能力位驱动（TR-AD-42 复用，不硬编码档数）。

## 理由
默认关语义需要 UI 可达「关回去」入口（覆盖无清除路径的功能缺陷消解）；UI 合成 OFF 刻度避免协议/目录扩面（off 非 pi-ai 档位成员）；同态 OFF + ghost 区分平衡「显示=真实行为」与「两态可辨」。

## 适用范围
动 composer 推理控件交互/形态时；新增推理相关 chip/徽标显示位时；能力位驱动刻度逻辑演进时。

## 反例
把 off 写进 CatalogModel.thinkingLevels 或协议档位枚举（SoT 在 pi-ai，off 是 helix 会话覆盖语义）；chip 无覆盖显示 AUTO（与真实行为「关」错位）；滑块刻度数硬编码（能力位驱动既有纪律）。

```kg-node
id: TR-AD-46
kind: rule
graph: tech
layer: convention
scope: domain
stack: frontend
name: 推理强度默认档中位规则（defaultLevelFor——两档取低档、最高档不默认）
status: active
digest: 动 P-2 开关 on 默认档写入、新增「开 thinking 默认档」消费位时
derivedFrom:
  - 用户裁决（task-20260824-thinking-unify：「所有模型的推理强度默认都取中间档位，如果只有两个档位则取第一档位，最高档位默认都不选」）
anchors:
  implementedBy:
    - apps/shell/src/features/thinking-level/model/thinking-capability.ts
  testedBy:
    - apps/shell/src/features/thinking-level/model/thinking-capability.test.ts
relations:
  governs:
    - E-AgentProfile
updatedIn: task-20260824-thinking-unify
```

## 规则
开启推理的默认档按模型自身档位集合取中位：defaultLevelFor(levels) = levels[Math.floor((n-1)/2)]——n=2 取低档、n=3 取中、n=4 取低中位、n=1 唯一档（无选择例外）、空数组 undefined 不写；最高档默认不选。纯函数沉淀于 thinking-capability 模型段（AG-14 无 React/IO）；消费位 = P-2 开关 off→on 翻转时的默认档写入（开 on 即写槽位；off 由开关承担——P-2 滑块无 OFF 刻度，与 P-1 形态分野）。

## 理由
中位默认与「按任务调节」心智匹配（默认不冲最高档——成本峰值不默认；两档取低——保守侧）；在模型自身集合上做位置中位而非全局枚举锚点（绝对档位 medium 在子集模型上漂移——low/high 型模型会被钳到 high）。

## 适用范围
P-2 开关 on 默认档逻辑演进时；未来其他消费位需要「开 thinking 默认档」语义时（复用单点，不另写）。

## 反例
拿全局枚举 medium 当默认再去 clamp（子集模型漂移——[low,high] 被钳 high）；默认取最高档（成本峰值不默认）；组件内散写中位计算（纯函数单点纪律）。

```kg-node
id: TR-AD-47
kind: rule
graph: tech
layer: arch
scope: domain
stack: shared
name: steer 注入 source 三值贯通（user/closure/progress——协议/Entry/持久化/实时帧全线）
status: active
digest: 写 closure 注入、周期进展报告注入、steer 事件载荷、Entry 物种字段、steer_queue 持久化时
derivedFrom:
  - T11a 裁决（task-20260824-thinking-unify：closure 注入与用户 steer 消息类型区分，用户确认方向）
anchors:
  implementedBy:
    - packages/protocol/src/types/chat.ts
    - packages/protocol/src/events/chat.ts
    - apps/daemon/src/domain/session/Entry.ts
    - apps/daemon/src/application/services/ChatService.ts
    - apps/daemon/src/adapters/driven/sqlite-session/WriteQueue.ts
    - apps/daemon/src/adapters/driving/ws-server/EnvelopeMapper.ts
  testedBy:
    - apps/daemon/test/integration/closure-chain.test.ts
    - apps/daemon/test/integration/scheduler-progress-report.test.ts
    - apps/daemon/test/integration/sqlite-persistence.test.ts
relations:
  governs:
    - E-AgentInstance
    - E-SteerQueue
updatedIn: task-20260824-thinking-unify
```

## 规则
closure 注入与用户 steer 的消息类型区分全线贯通 SteerSource = "user"|"closure"|"progress"：①协议面单点定义于 protocol types/chat.ts，贯通 steer.queued/drained 载荷 + MessageEntryDto（additive 批内补登不 bump）；②daemon Entry 物种带 source（快照 JSON 往返自动携带）；③ChatService.injectClosure 签名扩展带 source（调度链 ClosureRecorder 传 closure、周期进展报告传 progress；用户 steer 显式 user）；④SQLite steer_queue.source 列（守护式 ALTER 补列，旧行 NULL 前向兼容）；⑤实时 chat.message.completed 帧 entry.source 透传。三值由协议面定死（helix 自有枚举——AD-2 字符串透传原则不适用）；domain 与 protocol 各自定义同值域枚举（domain 不 import @helix/protocol 纪律，adapter 层映射）；老数据缺省按 user 渲染。

## 理由
closure 终态语义已有独立协议类型（agent.completed 族 + ClosureDto 驱动抽屉卡），但注入内容复用 steer 通道无判别——主时间轴上 closure 注入与用户 steer/用户消息不可区分（idle 时零标记、running 时与用户 steer 同形）；source 标记原止于 daemon 内存 SteerQueue 不出进程边界，需贯通到协议面与持久化才能支撑显示区分与重启不丢。

## 适用范围
新增注入来源类型时（扩枚举须协议面同步）；写 steer/closure/progress 注入链时；动 Entry 物种字段或 steer_queue 表结构时；实现主时间轴注入内容区分渲染时（TR-AD-48 承接）。

## 反例
source 只进内存不落协议/DB（重启丢失来源语义——本规则前的现状缺口）；在 shell 侧推断来源（文本前缀匹配等 best-effort——协议字段权威）；枚举值散落各层定义（协议单点定死）；把 progress 与 closure 混用同值（周期报告与收口语义不同，显示与审计需分野）。

```kg-node
id: TR-AD-48
kind: rule
graph: tech
layer: convention
scope: domain
stack: frontend
name: 主时间轴注入徽标 source 变体（CLOSURE amber / PROGRESS cyan / 用户 steer violet 不变）
status: active
digest: 动主时间轴消息徽标渲染、扩注入来源显示形态、改 steer 对账链时
derivedFrom:
  - T11b 裁决（task-20260824-thinking-unify：显示区分段，用户确认「按照你的逻辑来」）
anchors:
  implementedBy:
    - apps/shell/src/widgets/chat-stream/ui/MessageBubble.tsx
    - apps/shell/src/entities/session/model/consumers/chat.ts
  testedBy:
    - apps/shell/src/widgets/chat-stream/ui/MessageBubble.test.tsx
relations:
  governs:
    - E-AgentInstance
updatedIn: task-20260824-thinking-unify
```

## 规则
主时间轴 MessageBubble/SteerBadge 按 entry.source 分族渲染：closure=amber「CLOSURE」、progress=cyan「PROGRESS」、user/缺省=既有 violet STEER 两态（queued 脉冲/drained，老数据缺省按 user——TR-AD-47 口径）；idle 注入无 steerState 时渲染静态来源徽标（不带两态）；实时帧区分经 MessageCompletedPayload.source 透传（不靠快照对账）；steer.queued/drained 对账链（consumers/chat）透传 source 到渲染条目。ClosureCard（抽屉/终态面）不在本规则范围（主时间轴注入内容专属）。

## 理由
同一主时间轴内 closure 注入、周期进展与用户 steer 视觉不可区分是显示缺口（用户观察实锤）；amber/cyan 与 violet 三色分族使注入来源一眼可辨；用户 steer 渲染零变化保老数据兼容。

## 适用范围
动主时间轴徽标/气泡渲染时；新增注入来源的显示形态时；steer 对账链（confirmSteerEcho/drainSteer）演进时。

## 反例
用文本前缀（"agent-N closure:"）做显示判别（协议 source 字段权威）；改用户 steer 既有 violet 形态（回归风险）；徽标族混用同一色系变体（三来源须一眼可辨）。

```kg-node
id: TR-AD-49
kind: rule
graph: tech
layer: arch
scope: domain
stack: shared
name: 会话模式机制（绑定/锁定/过程信息边界/扩展路线）
status: active
digest: 加模式、动 session.mode 语义、动模式切换入口、做 P2 阶段迭代或 P3 工作流编排、动模式过程信息存储时
derivedFrom:
  - P1 设计对话用户裁决序列（task-20260824-p1-mode：D3 仅草稿可切唯一入口 / D4 锁定=结构不可能 / D6 过程信息临时性）
anchors:
  implementedBy:
    - packages/protocol/src/modes.ts
    - apps/daemon/src/application/services/modes.ts
    - apps/daemon/src/application/services/SessionRegistry.ts
    - apps/daemon/src/infrastructure/assembly/buildSessionStack.ts
    - apps/shell/src/entities/session/model/state.ts
    - apps/shell/src/widgets/top-bar/ui/P-1-top-bar.tsx
  testedBy:
    - packages/protocol/test/type-surface/modes.test.ts
    - apps/daemon/test/unit/modes.test.ts
    - apps/daemon/test/unit/chat-send-mode.test.ts
    - apps/daemon/test/unit/session-registry-draft.test.ts
    - apps/shell/src/entities/session/model/session-mode.test.ts
    - apps/shell/src/entities/session/SessionContext.mode.test.tsx
relations:
  governs:
    - E-AgentProfile
    - E-会话聚合
updatedIn: task-20260824-p1-mode
```

## 规则
会话模式 = session 与 agent 绑定的一等概念，注册表唯一事实源在 @helix/protocol（modes.ts：MODES/ModeId/DEFAULT_MODE_ID；ModeSpec.kind = single|staged|orchestrated 三值联合，staged 带 stages 序列——P2 phase/P3 workflow 不返工；mode wire 面一律 string + 未知 fallback default，类型层不锁死联合使 fallback 可表达；daemon 解析单点 application/services/modes.ts，domain 层禁 protocol 故不落 domain）。锁定语义 = 结构不可能（非校验拒绝）：草稿切换唯一入口 = shell ui/set-draft-mode（仅草稿生效 + 同步丢弃 draft model/thinking 暂存），唯一上送点 = chat.send{draft:true,mode}（非 default 才带，减少帧噪音），daemon 唯一消费点 = startDraftSession；建会话定格 session_state.mode（可空列 + 守护式补列 + 恢复侧 resolveModeId 归一旧行 default）+ 快照/welcome 只读回带；无 mode.set 命令，非草稿链（信封带 sessionId）payload.mode 忽略。热草稿转正复用条件 = 零条目 && profileKindOf(mode) 一致，不一致丢弃重建走 createFresh（零条目草稿无成本；复用零条目前提不因一致弱化——sendMessage 同步落聚合使转正后必有内容）。过程信息边界（D6）：模式过程信息（P2 迭代空间/P3 工作流空间、阶段交接摘要）= session 级临时态（daemon 会话聚合内存+事件流），会话结束销毁、不落 workspace 文件、不建持久表；跨会话沉淀归未来「项目知识图谱」（随更改动态更新）——过程空间永不自带持久层，本边界约束 P2/P3 设计。shell 读面：header 模式选择器（草稿可切/已建只读，MODES 数据驱动；chat.header.session 静态词条退役）；草稿模型徽标三级回退 = 本地暂存 ?? 模式槽位模型 ?? 全局默认；thinking picker 草稿刻度基准 = 槽位模型能力位、显示值 = 本地暂存 ?? 槽位 thinking ?? 默认关；模式槽位读面 = agentConfig.slots（agent.config.list.result 真消费提升的 topology 读面，connected 初拉 + revision 失效重拉，不新建第三条平行配置读面）；已建会话语义零侵染（P-3 菜单与 thinking.set 覆盖链不动）。

## 理由
绑定硬编码（profileKind 写死 main-session）使「换 agent 形态」只能改代码；模式注册表把它变成数据。锁定用结构不可能而非校验：无第二条写路径 = 无竞态无拒绝分支无 UI/协议双面校验，快照回带天然只读。过程信息临时性（D6 用户裁决）：「需要持久化的信息都在知识图谱」——过程中值得留的早该沉淀进图谱，session 级易失是特性不是缺陷，与「切换 agent 只拿上阶段摘要」的收缩哲学一致。扩展路线：P2 phase = staged 三阶段 agent（design/build/verify），阶段切换 = main 实例收口换新实例（同 session 新 profileKind，F1.9 一等创建/销毁天然支持）+ 交接摘要注入新实例初始上下文（closure summary 形态；时机倾向 T1 切换时收口生成，P2 定稿），欢迎词走前端 i18n 渲染不进 context；P3 workflow = orchestrated 编排者常驻（node = agent/逻辑节点，循环/并行/分支/节点退出复用既有 agent_spawn/send/status + closure 协议），与 P2 共用过程空间基础设施。协议版本位不随 P1 bump（additive + §18 微批登记，bump 决策留批次集合标记）。

## 适用范围
新增模式（注册表条目 + profile + 前端词条）时；动 session.mode 语义/切换入口/持久化时；P2 阶段迭代、P3 工作流编排设计时（过程信息边界硬约束）；动模式槽位读面/草稿显示链时；chat.send draft 链 payload 演进时。

## 反例
为已建会话提供任何 mode 写路径（mode.set 命令、非草稿链消费 payload.mode——锁定语义即告破坏，唯一例外是 P2 阶段切换的显式新命令且须另行裁决）；mode wire 面用联合类型锁死（未知 fallback default 不可表达，旧 daemon/旧客户端破面）；为模式过程信息建持久表或落 workspace 文件（D6 红线——持久归知识图谱）；daemon/shell 各建一份注册表（AG-13 同构纪律，唯一事实源 protocol）；草稿显示链绕过槽位读面直查 ResourceService（第三条平行配置读面）。

```kg-node
id: TR-AD-50
kind: rule
graph: tech
layer: arch
scope: domain
stack: backend
name: kg 单库 SoT 与库定位（.helix-kg 按项目根持有 + 唯一写入口）
status: active
digest: 写 .helix-kg 库、加 kg 表或列、动 kg 写入口、配 kg 库路径或 git 跟踪口径时
derivedFrom:
  - AD-9（iter-20260825-11fo：SoT 下沉数据库，统一单库+最小只读页面，md 表示层消失）
  - AF-21 二次裁决（2026-08-26：v2 库定位 .helix-kg/，v1 .kg/kg.db 原位保留恢复 git 跟踪）
anchors:
  implementedBy:
    - apps/daemon/src/adapters/driven/sqlite-kg/KgDatabase.ts
    - apps/daemon/src/adapters/driven/sqlite-kg/schema.ts
    - apps/daemon/src/adapters/driven/sqlite-kg/SqliteKnowledgeStore.ts
    - apps/daemon/src/application/services/kg/KgWriteService.ts
    - apps/daemon/src/adapters/driven/workspace-scan.ts
  testedBy:
    - apps/daemon/test/integration/kg-schema.test.ts
    - apps/daemon/test/arch-guard/arch-guard.test.ts
updatedIn: iter-20260825-11fo
```

## 规则
项目知识图谱（kg）的 SoT 是按项目根持有的单一 SQLite 库 `<projectRoot>/.helix-kg/kg.db`（KgDatabase.kgDbPath 单点定义），知识层（nodes/anchor_decl/edges/change_log）与符号层（files/symbols/contains_edges）+物化锚同库；本地运行态 gitignore，md 快照+幂等迁移（scripts/oneoff/kg-migrate.ts，默认 dry-run、--apply 落库）构成恢复基线。三条硬边界：①知识层唯一写入口 = KgWriteService（结构化参数+schema 校验前置——写错形态在参数层被拒，禁旁路直写）；②读面（workspace-scan 存在性探测/search/get/切片注入）绝不新建库文件——未建 .helix-kg 的项目不可见（absent 态）；③v1 库 `.kg/kg.db` 原位不动不读不写（AF-21 二次裁决：同名冲突靠目录隔离消除，迁移管道对 v1 仅 probeV1Db 只读探测）。daemon 全局自有状态仍在 ~/.helix/helix.db（TR-AD-6），两库互不混淆；.helix-kg 不进 daemon 全局 WriteQueue 语义域，但执行同一「唯一写点+串行化」模式（TR-AD-13 对齐：AG-06 白名单已扩 KgDatabase/SqliteKnowledgeStore 两写点 + codegraph-db-projection 只读读点）。

## 理由
v1 教训：md 表示层使「写错形态=损坏的文档」，且 git diff md 无原子性；SoT 下沉后写入口收敛为 API，错误形态变成被拒绝的请求（AD-9）。v2 曾与 v1 同用 .kg 目录致建表 DDL 撞名（v1 nodes 表列集不同），用户二次裁决「同名必然有问题」——独立目录 .helix-kg 消除冲突，v1 恢复 git 跟踪以保历史审计面。per-project 持有使多 worktree 天然隔离（AD-15）。

## 适用范围
任何触碰 .helix-kg 的代码：加表/加列（additive，幂等直建）、动 KgDatabase 连接管理、新增 kg 写场景（必须经 KgWriteService）、迁移管道维护、AG-06 写点白名单变更、以及部署/环境巡检（确认 .helix-kg/kg.db 存在且节点数与 md 基线一致——缺失时重跑 kg-migrate --apply 幂等恢复）。

## 反例
工具/handler 绕过 KgWriteService 直接 new Database 写 .helix-kg 知识层（旁路写口使 schema 校验防线失效，AG-06 红）；或读面为「顺手补建」在探测时创建空库（absent 语义被破坏，页面冷启动 CTA 失去判定依据）；或 v2 代码读写 v1 .kg/kg.db（撞名 DDL 半套表+INSERT 失败，AF-21 病灶复发）。

```kg-node
id: TR-AD-51
kind: rule
graph: tech
layer: arch
scope: domain
stack: backend
name: kg sync 双源汇队列+去抖单飞并发模型（表分域写不竞争）
status: active
digest: 动 kg 同步触发、加 sync 写路径、改去抖或单飞语义、接 fs-watch 或写后通知时
derivedFrom:
  - AD-15（iter-20260825-11fo：双源汇队列+去抖单飞，附着不依赖新鲜度）
anchors:
  implementedBy:
    - apps/daemon/src/application/services/kg/KgSyncService.ts
    - apps/daemon/src/adapters/driven/fs-watch/FsWatchAdapter.ts
    - apps/daemon/src/infrastructure/assembly/buildKnowledgeStack.ts
  testedBy:
    - apps/daemon/test/unit/kg-sync-service.test.ts
    - apps/daemon/test/unit/kg-fswatch.test.ts
    - apps/daemon/test/integration/kg-sync-pipeline.test.ts
updatedIn: iter-20260825-11fo
```

## 规则
.helix-kg 符号层与物化锚的新鲜化由单一 sync 管道维护，并发模型三定式：①双源汇队列——自写 edit/edit-lines 落盘后 notifyWrite（写后投递，不在写路径跑 sync）与 fs-watch 单流 watch（外部编辑/删/改名兜底）汇入同一队列，按 (path,hash) 去重；②去抖+单飞——去抖窗口批量合并（2-5s），running 标志保证同一时刻至多一个 sync 在写，running 期间新事件合并等待重入队，永不并发写 .helix-kg；sync 是四步单事务（ensure-symbols → 符号+span+contains 导入 → 锚物化 → 基准戳）。③表分域写不竞争——sync 管道写符号层+物化锚+meta，知识层四表只经 KgWriteService，两写者按表分域互不竞争。运行态按 projectRoot 隔离（组合根 per-project 工厂：去抖队列/单飞标志/快照缓存不跨项目共享）。附着读上次 sync 快照、允许滞后（少附/降级/跳过，不错附）——不存在「编辑等同步」的阻塞路径；符号消亡（删/改名）diff 产出锚孤儿信号供验证期检查。

## 理由
写后通知覆盖 daemon 自有工具的高频路径（免 watch 抖动），watch 兜底一切外部修改；去抖吸收 burst，单飞使 SQLite 事务永不交错。per-project 隔离是多 worktree 并发的天然边界（AD-15 定论）。附着若依赖新鲜度会引入编辑→同步阻塞链，与「宁可沉默不可错附」冲突。

## 适用范围
修改 KgSyncService 触发/去抖/单飞逻辑、新增 sync 事件源、改 notifyWrite 投递点（EditTool/EditLinesTool/CoreToolExecutor）、动 FsWatchAdapter（F-21 单流模式参数：macOS/Win 递归 fs.watch、Linux inotify 补挂+总量帽、ignore 前置过滤）、以及任何想「绕过队列直接写符号层」的场景（应入队而非直写）。

## 反例
edit 工具成功后同步等待 sync 完成再返回（编辑链路引入秒级阻塞，违反附着不依赖新鲜度）；或两个 sync 并发写 .helix-kg（running 标志被绕过——如新触发面直调四步管道不走单飞判定，WAL 下事务交错致基准戳与符号表不一致）。

```kg-node
id: TR-AD-52
kind: rule
graph: tech
layer: arch
scope: domain
stack: backend
name: 知识附着管线纪律（四层递降+宁可沉默不可错附+服务层快照缓存）
status: active
digest: 动附着匹配、改 📎 块渲染或预算、加附着触发载体、调快照缓存失效时
derivedFrom:
  - AD-4（动作层附着）+ AD-7 补充（自下而上三层+保守兜底）+ AD-14（协议行）
  - AF-15（快照缓存放服务层而非 port 层，2026-08-26）
anchors:
  implementedBy:
    - apps/daemon/src/domain/kg/attachment/identifier-extract.ts
    - apps/daemon/src/domain/kg/attachment/scope-matcher.ts
    - apps/daemon/src/domain/kg/attachment/budget.ts
    - apps/daemon/src/domain/kg/attachment/render.ts
    - apps/daemon/src/application/services/kg/KgAttachmentService.ts
    - apps/daemon/src/adapters/driven/tools/edit/EditTool.ts
  testedBy:
    - apps/daemon/test/unit/kg-attachment-match.test.ts
    - apps/daemon/test/unit/kg-attachment-budget.test.ts
    - apps/daemon/test/integration/kg-attachment-wiring.test.ts
updatedIn: iter-20260825-11fo
```

## 规则
动作层知识附着（edit 成功后返回值尾部附 📎 块）遵守四条纪律：①四层递降匹配——标识符∩本文件锚域的方法级名键精确命中 → contains 边类级上溯 → 行号×上次 sync span 保守定位（仅兜底：span 陈旧向上回扫签名行校验，撞双候选降级，行号漂移跨多符号全部跳过）→ 文件级路径域兜底；只匹配本文件定义的符号（callee 不挂），全局域节点不进附着（常驻系统提示已到达）。②宁可沉默不可错附——任何不确定性向下降级或跳过；附着管线内部异常不影响工具成功返回（附着失败=无块，零工具错误）。③会话级跨通道去重+预算——任务层注入过的 id 不再附；单块 token 硬顶，超限按特异性排序（符号域>路径域）；块尾附协议行「若本次改动推翻此节点，随改动提交 supersede」。④快照缓存归属服务层——KgAttachmentService 按 projectRoot 缓存附着快照、baseline 戳比对失效（attach 前一次 getIndexStatus meta 点查）；port（SqliteKnowledgeGraph.getAttachmentSnapshot）保持逐读逐查——知识层写（supersede 等）不推进 baseline，附着面滞后合法，但 port 是多消费方读口（注入/页面共用），不得为附着热路径改变全局读语义。

## 理由
v1 教训：通道被 agent 学会忽略——错附一次的噪声代价大于漏附十次；附着是纯读点查（微秒级）才有资格挂在 edit 热路径上。AF-15：port 层缓存会把 superseded 节点滞留在快照（baseline 只随 sync 推进），破坏「supersede 立即可见」的多消费方读语义，故缓存只属于附着的滞后容忍面（服务层）。

## 适用范围
改四层匹配策略/标识符提取分词、调 token 预算或特异性排序、改 📎 块渲染与协议行文案、新增附着载体（write 薄包装，O-1 开放面）、动 KgAttachmentService 缓存、以及任何想「让附着更主动/更实时」的提议（应先评估滞后容忍边界）。

## 反例
为提高命中率放宽到 callee 符号或跨文件符号（噪声放大，通道被忽略——v1 下场）；附着管线异常向上抛成工具错误（edit 成功被附着失败污染，违反失败静默）；或把快照缓存下沉 port 层（superseded 节点滞留快照，kg-anchor-decl ② 场景红——AF-15 病灶）。

```kg-node
id: TR-AD-53
kind: rule
graph: tech
layer: arch
scope: domain
stack: backend
name: 锚三级作用域模型与确定性物化（关联由写入时声明决定）
status: active
digest: 加锚作用域声明、改锚物化 join、动 materialized_anchors 或 orphan 判定、配 degraded 降级锚时
derivedFrom:
  - AD-13（iter-20260825-11fo：三级作用域锚，关联由写入时声明决定，宁漏附不噪声）
  - AF-13（materialized_anchors.orphan 列 + 整文件符号先删后插增量 diff，2026-08-26）
anchors:
  implementedBy:
    - apps/daemon/src/domain/kg/anchor-materialize.ts
    - apps/daemon/src/adapters/driven/sqlite-kg/schema.ts
    - apps/daemon/src/application/services/kg/KgSyncService.ts
    - apps/daemon/src/domain/kg/verify/orphans.ts
  testedBy:
    - apps/daemon/test/unit/kg-anchor-materialize.test.ts
    - apps/daemon/test/integration/kg-anchor-decl.test.ts
updatedIn: iter-20260825-11fo
```

## 规则
知识节点与代码的关联由写入时的锚作用域声明（anchor_decl）决定，不做全量计算：①全局域（scope_kind=global）不物化锚——常驻系统提示已 100% 到达，附着=重复运输；②路径域（path）按 glob/path pattern 物化为文件锚；③符号域（symbol）物化为 path#symbol 锚（要求 path#symbol 锚定形态）。物化是 anchor_decl × symbols/files 的确定性 join（anchor-materialize 纯函数），随 sync 单事务推进。失效语义：符号消亡（symbols diff，含同文件先删后插）→ 物化锚标 orphan=1 保留行（不物理删），附着快照滤 orphan=0；降级语义：codegraph 引擎不可用 → degraded 标记 + docs-only 锚（路径域锚仍物化，符号域降级文件级或跳过）。锚精度只经声明升级（如迁移只做文件级→path 域反推，符号精度由日常落账逐步生长），不发明未声明的符号锚。

## 理由
全量计算锚（v1 218 文件级锚的病根）无符号精度且维护面失控；写入时声明让关联意图显式可审计（change_log 可追溯），确定性 join 使 sync 幂等可重放。orphan 保留行使「腐烂锚」成为可检出的确定信号（find_orphans 数据源）而非静默丢失。

## 适用范围
加锚声明字段/改作用域 kind 词表、动物化 join 规则、改 orphan 判定与保留语义、动 degraded 降级路径、写消费锚的面（附着快照/节点详情/验证检查），以及评估「自动推断锚」类提议（应走声明通道而非计算通道）。

## 反例
sync 时按代码内容自动推断/猜测节点锚（未声明的关联——错附源头，违反 AD-13 声明决定关联）；或符号消亡时物理删除物化锚行（失效信号丢失，find_orphans 断数据源）；或全局域节点也物化锚（重复运输+挤占附着预算）。

```kg-node
id: TR-AD-54
kind: rule
graph: tech
layer: arch
scope: domain
stack: backend
name: kg 节点 id 策略（前缀+单调序号+保号迁移+id 不进人类界面）
status: active
digest: 动节点发号、加 id 校验、写迁移或导入管道、改节点展示引用形态时
derivedFrom:
  - AD-16（iter-20260825-11fo：id 策略四定论）+ AF-20（parseMigrationId 保号直写消解）
anchors:
  implementedBy:
    - apps/daemon/src/domain/kg/node-id.ts
    - apps/daemon/src/adapters/driven/sqlite-kg/SqliteKnowledgeStore.ts
    - apps/daemon/src/application/services/kg/KgWriteService.ts
    - scripts/oneoff/kg-migrate.ts
  testedBy:
    - apps/daemon/test/unit/kg-node-id.test.ts
    - apps/daemon/test/integration/kg-seq.test.ts
    - apps/daemon/test/integration/kg-write-schema.test.ts
updatedIn: iter-20260825-11fo
```

## 规则
kg 节点 id = `<kind前缀>-<序号>`（rule 前缀产 TR、entity 前缀产 E），序号按 kind 在落库事务内单调分配、永不复用——supersede 只翻 status 不换号（换号=丢引用链）。两套解析器分工：parseNodeId 严格形态（TR 或 E 前缀加数字序号）用于常规校验；parseMigrationId 宽松形态（TR/E 前缀+任意存量尾缀如 TR-AD-47/E-会话聚合；数字尾缀给 seq 推进计数器、非数字 null 不推进）用于显式 id 入口（KgWriteService 与 SqliteKnowledgeStore 两层校验同一函数）——存量旧 id 原样保号直写，新号从同 kind max+1 起。人类界面纪律：裸 id 永不做界面语汇——展示位统一「粗体 name + kind 徽章 + digest 首行」，id 仅经详情链接/工具指针承载（kg get 指针是 LLM 面合法形态）。

## 理由
旧 id 是既成引用（trace/报告/人脑记忆），重发号零收益纯风险（AF-20：严格校验曾把 65 例存量形态全部拒之门外）；序号事务内分配避免并发双发。id 进人类界面会诱导用户记忆不稳定标识，name+digest 才是稳定语汇（重名合法靠 digest 区分）。

## 适用范围
动 node-id 解析/发号、加新的显式 id 写入场景（必须经 parseMigrationId 口径）、维护迁移管道保号映射、改任何展示面（P-1 页面/变化报告/工具输出）的节点引用形态。

## 反例
迁移时给存量节点重发新号（TR-AD-47 变 TR-58——全部既成引用断链）；或页面直接渲染裸 id 列表（AD-16 人类面纪律破坏）；或 supersede 时新建节点换号（supersede 链断裂，change_log 审计面失去「同号翻状态」语义）。

```kg-node
id: TR-AD-55
kind: rule
graph: tech
layer: arch
scope: domain
stack: backend
name: 上游纯函数 VENDORED 复制收口（五要素头注释+行为 oracle 平权护栏）
status: active
digest: 复制三方库纯函数、升级 pi-agent-core、动 tools/edit/kernel 内核、加 vendored 复制件时
derivedFrom:
  - AD-12（iter-20260825-11fo 方案 C）+ AF-1 裁决（pi exports 白名单拦截，复制收口，2026-08-25）
anchors:
  implementedBy:
    - apps/daemon/src/adapters/driven/tools/edit/kernel/edit-diff.js
    - apps/daemon/src/adapters/driven/tools/edit/kernel/edit-diff.d.ts
    - apps/daemon/src/adapters/driven/tools/edit/kernel/file-mutation-queue.js
    - apps/daemon/src/adapters/driven/tools/edit/kernel/file-mutation-queue.d.ts
  testedBy:
    - apps/daemon/test/integration/tools-edit-parity.test.ts
updatedIn: iter-20260825-11fo
```

## 规则
三方包（pi-agent-core）的编辑内核纯函数无法经包公开 API import（exports 白名单拦截）时，允许复制实现收口进 `adapters/driven/tools/edit/kernel/`（.js+.d.ts 成对逐字复制），受五条机械纪律约束：①VENDORED 头注释五要素——来源包名+精确版本+上游文件路径+不可 import 原因（AF-1）+「禁手改，升级=按 pin 版本重复制且平权测试必须绿」；②除注明的内联微调（如 getOrThrow 内联）外禁手改复制件；③行为正确性由平权护栏机械验证——以 pi 官方入口（/node 子入口 createEditTool）为行为 oracle 的对照测试；④连带依赖（如 diff 包）须登记运行时依赖白名单（AG-05）；⑤复制件收口面保持「pi 工具符号只出现在 tools/ 目录」豁免语义（TR-AD-7 域界不动，edit-lines 等兄弟工具经 ../edit/kernel 引用复制件而非新开 pi import）。

## 理由
fork-patch（patchedDependencies）每次包升级重打维护面大，推动上游导出时序不可控；复制+平权测试把「复用正确性」变成机械可验证事实（pi 升级→重复制→平权红即拦截行为漂移）。AF-1 已裁：AD-12 决策实质（自写外壳+行为平权）不变，仅复用机制从 import 变 copy。

## 适用范围
任何「上游有纯函数实现但 exports 拦截」的复用决策；pi-agent-core 升级流程（重复制+平权测试全绿）；动 edit-diff/file-mutation-queue 内核逻辑（应改外壳 recovery.ts 而非内核）；新增其他 vendored 复制件（照抄五要素+oracle 护栏模式）。

## 反例
直接手改 kernel/edit-diff.js 修 bug（复制件与上游分叉，下次升级重复制即丢改动，且平权测试无从判定谁对）；或为省两行代码绕开 kernel 另写一套 diff 实现（双实现行为漂移，edit-lines 与 edit 结果不一致）；或复制件不带版本头注释（升级时无从判断该不该重同步）。

```kg-node
id: TR-AD-56
kind: rule
graph: tech
layer: arch
scope: domain
stack: backend
name: workspace 项目发现与 projectRoot 单点解析（宽松口径+纯逻辑/IO 分置）
status: active
digest: 动项目列表扫描、加 project 参数命令、改 projectRoot 归属解析、扩排除清单时
derivedFrom:
  - §3.5（iter-20260825-11fo，V-3 用户裁决宽松口径）+ AF-12/AF-16（组合根内联→单点收口）
anchors:
  implementedBy:
    - apps/daemon/src/domain/kg/project-discovery.ts
    - apps/daemon/src/adapters/driven/workspace-scan.ts
    - apps/daemon/src/application/services/kg/KgProjectService.ts
    - apps/daemon/src/infrastructure/assembly/buildKnowledgeStack.ts
  testedBy:
    - apps/daemon/test/unit/kg-kgsync-background.test.ts
    - apps/daemon/test/integration/kg-handlers.test.ts
updatedIn: iter-20260825-11fo
```

## 规则
workspace 根 = daemon 启动 cwd（不新增 env 键，TR-AD-6 管辖面不扩）。「project 参数 → projectRoot」解析与 workspace 扫描全部收口单点，三层分置：domain/kg/project-discovery.ts 持纯逻辑（一层扫描过滤/resolveProjectArg/排除清单常量）；adapters/driven/workspace-scan.ts 只持目录枚举 IO 与 .helix-kg 存在性探测；KgProjectService 持聚合编排（注入 scan IO，零 env 读取）。入列口径=宽松口径（V-3 用户裁决）：workspace 一级目录全部入列，排除清单是唯一过滤（docs/、.helix/、.worktrees/、隐藏目录、node_modules、文件项），不做目录资格甄别；未建索引目录以 absent 态入列（读面绝不新建库文件）。handlers/service 层禁自带 isAbsolute/join 解析（v1 gate.ts/project-docs.ts 多处重复实现的教训）；文件→所属项目的归属解析（projectRootOfPath）与启动扫描共用同一排除清单常量；per-project 实例经组合根工厂解析缓存。

## 理由
v1 explorer boundary finding：workspace→projectRoot 解析散落多处（isAbsolute ? x : join(workspaceRoot,x) 重复），行为漂移不可审计。单点+纯逻辑分置使口径变化（排除清单增删）一处生效；宽松口径避免「标记集」类资格甄别的持续维护（AF-6 遗留口径已消解）。

## 适用范围
加带 project 参数的 ws 命令（必经 KgProjectService/resolveProjectArg）、动扫描或排除清单、改 edit 附着归属（projectRootOfPath）、动组合根 per-project 工厂，以及任何想「就地 join 一下 project 路径」的便捷写法（应回单点）。

## 反例
handler 里自带 `isAbsolute(p) ? p : join(workspaceRoot, p)`（口径第二实现——与单点漂移后 kg.projects 列表与命令作用域不一致）；或扫描时按「有无 package.json/工程标记」甄别资格（回到标记集口径，违反 V-3 宽松裁决）；或归属解析与启动扫描各自维护排除清单（排除目录事件触达 watch 归属，AF-16 修正前的病灶）。

```kg-node
id: TR-AD-57
kind: rule
graph: tech
layer: arch
scope: domain
stack: backend
name: 外部 SQLite 库只读直读投影（mode=ro + 白名单登记 + 零 DML/DDL）
status: active
digest: 直读外部 SQLite 库（codegraph.db 等）、加跨库投影查询、动只读连接回退时
derivedFrom:
  - AF-2/AF-11（iter-20260825-11fo：codegraph.db 只读投影 + AG-06「只读读点」概念扩登记）
anchors:
  implementedBy:
    - apps/daemon/src/adapters/driven/codegraph-engine/codegraph-db-projection.ts
    - apps/daemon/src/adapters/driven/codegraph-engine/CodegraphEngineAdapter.ts
  testedBy:
    - apps/daemon/test/arch-guard/arch-guard.test.ts
    - apps/daemon/test/integration/kg-codegraph-engine.test.ts
updatedIn: iter-20260825-11fo
```

## 规则
直读非自有 SQLite 库（如 .codegraph/codegraph.db）做投影时：①连接恒 `?mode=ro` URI 只读打开；WAL 干净退出态（-wal/-shm 缺失致 CANTOPEN）回退 `mode=ro&immutable=1` 等价只读选项；②该文件仅允许 SELECT——零 DML/DDL/写类 PRAGMA；③新只读读点必须登记 AG-06 sqliteReadonlyWhitelist 单例（arch-guard 机械断言：白名单文件只含 SELECT、其余文件出现 new Database 即红），与写点白名单（sqliteWriteWhitelist）分列；④schema 版本门——目标库 schema_versions 超上限或缺表 → degraded（不硬崩、不猜测列）；⑤绝不写该库（投影是只读消费，写权属库的 owner 进程）。

## 理由
外部库（codegraph CLI 所有）有自己的写者与迁移节奏；RW 打开会在对方 WAL 态上留下锁/残留文件（AF-21 曾清理 probe 遗留的 0 字节 wal/shm 副产物）。白名单+SELECT 断言把「只读承诺」从注释变成机械守护（AG-06 原「写点唯一」口径扩出第三类读点后的复用登记面——后续任何直读外部库场景照此办理，不绕 AG-06）。

## 适用范围
新增任何直读外部 SQLite 的投影/查询面（.codegraph、其他工具的库）、动只读连接的打开与回退参数、动 AG-06 白名单结构、升级外部库后复核 schema 版本门上限。

## 反例
为「顺手修个数据」在投影文件里写 UPDATE（外部库被污染，owner 进程下次构建撞脏数据）；或新直读面不走白名单登记（AG-06 ① 断言 new Database 出现即红，被迫删测试而非合规登记）；或 schema 变更后无版本门硬按旧列名 SELECT（SQLITE_ERROR 抛进 sync 热路径）。

```kg-node
id: TR-AD-58
kind: rule
graph: tech
layer: arch
scope: domain
stack: shared
name: 提示词段库+LLM 装配与三条硬约束（机制层不可裁剪）
status: active
digest: 动 brief/report/变化报告模板段、改段库目录或装配指引、加硬约束校验判据时
derivedFrom:
  - AD-18（iter-20260825-11fo：段库+LLM 装配+三条硬约束）+ AF-7/AF-8（AG-10 豁免/判据兼容）
anchors:
  implementedBy:
    - apps/daemon/src/adapters/driven/pi-engine/runtime/templates/catalog.ts
    - apps/daemon/src/adapters/driven/pi-engine/runtime/templates/guide.ts
    - apps/daemon/src/adapters/driven/pi-engine/runtime/templates/validate.ts
  testedBy:
    - apps/daemon/test/unit/kg-templates.test.ts
updatedIn: iter-20260825-11fo
```

## 规则
brief / report / kg-change-report 三场景的提示词模板 = 段库（runtime/templates/ 下声明式数据模块：brief 六段、report 四段、kg-change-report 四类条目）+ LLM 按任务实况选段装配 + 三条 LLM 不可裁的硬约束：①brief 必含任务目标+范围钳制（「范围锥制」同义拼写，判据正则两拼写同判）+完成判定；②report 必含 summary+findings 且显式「无」原则（findings 空数组=显式无发现——闭环机械判定与 kg 落账的输入）；③空段省略不占位。机制层（submit_result 唯一闭环信号/findings 必填）不在模板可裁剪范围；硬约束由 validate.ts 机械校验（validateBrief/validateReport），消费面接线于 SubagentLauncher（violation 记录日志）。段库数据模块与 profiles 同域豁免 AG-10 模式词扫描（validate.ts 逻辑源码不豁免仍受扫描）。

## 理由
固定模板使 agent 为填段执行段外动作（F-23 天气查询实案：模板含 tests 段→agent 真去跑了天气 API 测试）；任务形态是开放集合，规则表追不上实况，LLM 选段+硬约束保底把「灵活性」与「闭环可判定性」分层。硬约束是 plan_mark_done 闭环检查与 kg 落账管道的机械判据，漏则管道断（findings 断头即 F-22 病根）。

## 适用范围
加/改段库段、调装配指引（TEMPLATE-USAGE.md 为段库目录+硬约束声明，非装配规则表）、改 validate 判据、给新场景（如 phase 文档）立模板体系、以及任何「让模板强制某段必填」的提议（应区分类别：机制层硬约束可强制，内容段让 LLM 按实况选）。

## 反例
固定四文件模板（每任务全段渲染——F-23 教训复发，agent 为填段执行段外动作）；或 findings 段允许静默缺省（「没写=无发现」与「没收集」不可区分，闭环协议失去机械判据）；或把硬约束交 LLM 判断要不要守（机制层可裁剪——闭环信号可被模板吞掉）。

```kg-node
id: TR-AD-59
kind: rule
graph: tech
layer: arch
scope: domain
stack: backend
name: 任务系统三段式（引擎代码化机制 + builtin 任务类型 skill + 编排主 agent）
status: active
digest: 新增任务类型、写任务 skill、改任务引擎或编排主 agent、动 job/stage/batch 持久化时
derivedFrom:
  - AD-1（iter-20260829-ys7q）
  - AD-3（iter-20260829-ys7q）
anchors:
  implementedBy:
    - apps/daemon/src/domain/task/
    - apps/daemon/src/application/services/task/
    - apps/daemon/src/adapters/driven/sqlite-session/
    - apps/daemon/resources/skills/
  testedBy:
    - apps/daemon/test/arch-guard/arch-guard.test.ts
updatedIn: iter-20260829-ys7q
```

## 规则
「无交互纯多 agent 任务」是一等持久化概念，职责切三段：①任务引擎（TS 代码，domain/task + application/services/task + sqlite-session 任务四表新表域）承载全部机制——job/stage/batch 持久化、通用状态机、manifest 校验、断点恢复、自动重试、并发预算、进度汇总，零任务类型语义；②任务类型 skill（builtin 层 resources/skills/<type>/SKILL.md，随仓不可删改）承载 SOP——frontmatter 机器可读 manifest（paramsSchema + stages 策略）+ 正文运行期指引（批次划分原则/brief 模板/写作规范/完成判定），一文两消费；③编排主 agent（每运行中任务一个，OrchestratorProfile，pi-engine 同防腐墙）承载项目实况相关的 LLM 判断——划批次、装配 brief、派 SubAgent、读 closure/plan 判成败、进阶段或重试。批次执行单元 = 普通 SubAgent（SchedulerService 既有 spawn/monitor/closure 通路，共享 maxConcurrent=3 全局预算）。新增任务类型 = 加一个 skill 文件，引擎/页面/恢复框架零改动。

## 理由
批次划分与层间上下文传递是项目实况相关的 LLM 判断，纯代码做不了；纯 LLM 自由编排不可控——skill 是「LLM 判断 + 人可读可改约束」的已验证形态（v1 phase 体系同构），且 builtin 层随仓分发不可删改使 SOP 正确性有工程保障；引擎与 SOP 分离后任务系统通用性才成立（用户裁决 2026-08-29，方案 C）。

## 适用范围
新增任何任务类型时；修改任务引擎状态机/恢复/重试机制时；新增或修改 builtin 任务 skill 时；给编排主 agent 或批次 SubAgent 装配工具时；动 job/stage/batch 表结构时。

## 反例
把 kg-bootstrap 的分层逻辑硬编码进任务引擎 TS 代码（新增任务类型就要改引擎——通用性破产）；或让编排逻辑纯 LLM 自由发挥无 skill 约束（不可控）；或为 bootstrap 在 /project 索引面板做内嵌临时监控方案（AD-1 用户裁决否决的选项 A）；或批次绕过 SchedulerService 直起子进程（预算/监控/closure 通路失守）。

```kg-node
id: TR-AD-60
kind: rule
graph: tech
layer: arch
scope: domain
stack: backend
name: 任务干预边界与职责分界（任务页零创建零内容干预；确认只开启前一次；结果后处理归任务类型域）
status: active
digest: 加任务页功能、加任务相关命令或工具、设计任务状态机迁移、讨论审阅/重试/steer 入口时
derivedFrom:
  - AD-2（iter-20260829-ys7q）
  - AD-5（iter-20260829-ys7q）
  - AD-10（iter-20260829-ys7q）
anchors:
  implementedBy:
    - apps/daemon/src/application/services/task/
    - apps/daemon/src/adapters/driving/ws-server/handlers/task.ts
    - apps/shell/src/pages/tasks/
updatedIn: iter-20260829-ys7q
```

## 规则
①干预边界：任务的作用 = 根据 task 定义完成任务——重试自动；人对运行中任务只有生命周期控制（暂停/继续/取消），内容零干预（无 steer、无批次级人工重试、无内容编辑面）；内容纠偏出口 = 起跑前定义 / 跑完后任务类型域的后处理。②创建入口分离：任务页面不承载创建入口（通用创建表单描述不了任务上下文）；创建按任务类型各有宿主——kg-bootstrap 宿主 = /project 页（kg.bootstrap.create），无项目任务宿主 = chat（task_create 工具，对话即确认）；协议面不设任务通用创建命令。③确认只在开启前一次（确认物 = 干什么 + 怎么分阶段；按任务类型 manifest 可免确认）；执行全程无 gate——状态机无 awaiting-review 中途态，分层计划是执行期中间产物（可观察、非待批件）。④职责分界：任务系统只执行并给结果；结果的后处理（落盘/呈现/修正）是任务类型的域逻辑，不进任务系统——bootstrap 产出呈现与事后修正在 /project 页 kg 域，任务引擎零产出处置概念；任务域 → kg 域唯一衔接面 = kg 节点元数据（taskId/origin_batchId/layer）。

## 理由
「无交互」指任务内容不受干预，但生命周期是人对长运行实体的正当控制（用户裁决 2026-08-29）；中途 gate 会把任务变成阶段审核逻辑，违背无交互设计；任务系统若承载各任务类型的结果后处理，每个类型都要改任务页，通用性（AD-1）破产——产出处置单位与场景在图谱域（节点/批次/层），不在任务域。

## 适用范围
给任务页面或任务命令族加任何功能时；设计新任务类型的确认形态与宿主入口时；动任务状态机（加状态/加迁移）时；讨论任务结果的后处理（呈现/修正/重跑）落位时。

## 反例
在任务详情页加 steer 输入框或「重试此批次」按钮（内容干预，AD-2 否决的选项 C）；在状态机加 awaiting-review 层间人审态（AD-5 否决的选项 A/B——任务变阶段审核逻辑）；把 bootstrap 产出呈现/修正塞进任务详情页（AD-10 纠正的错位——产出处置场景在图谱域）；加 task.create 通用 WS 命令（创建入口必须落宿主上下文）。

```kg-node
id: TR-AD-61
kind: rule
graph: tech
layer: arch
scope: domain
stack: backend
name: 实例级工作台账（plan 工具族全量配给所有 SubAgent；chat/task 统一写口；closure 硬约束 plan 全 resolve）
status: active
digest: 派 SubAgent 写 brief、判子实例进度、做断点接力恢复、改 closure 收口判定、加实例进度展示时
derivedFrom:
  - AD-6（iter-20260829-ys7q）
anchors:
  implementedBy:
    - apps/daemon/src/adapters/driven/tools/plan/
    - apps/daemon/src/application/services/task/WorkLedgerService.ts
    - apps/daemon/src/adapters/driven/subagent/child/ChildMain.ts
updatedIn: iter-20260829-ys7q
```

## 规则
①数据 = 实例 plan（work_item 表：instanceId/seq/content/status(pending→in_progress→done/abandoned)/note（关键事实+产物指针）/updatedAt）。②写口 = plan 工具族三操作（plan_create 开工计划 / plan_update 项状态+note / plan_read）全量配给所有 SubAgent——不新造专用台账工具；SubAgent 不感知派发方，chat MainAgent 与任务编排器派出的实例写口完全一致。③读口 = 派发方随时读子实例 plan（chat 判进度不扒代码现场；task 编排器判批次进度 + 任务页渲染中间状态）。④接力恢复 = 新实例 brief 注入前序 plan 摘要（已完成项+note 事实+产物指针）从断点继续，产物指针让幂等重跑跳过已产。⑤三件套不重叠：trace = 机器审计原始流 / 实例 plan = LLM 策展语义进度 / closure = 终点收口。⑥硬约束（模板层 LLM 不可裁）：强制 plan 的任务 brief 必含「先写 plan 再动手」+ 阶段转换必更新；closure 机械判据 = plan 全部 resolve（done 或 abandoned 带理由）。⑦强制程度按 brief 装配——工具常驻可用，长任务（bootstrap 批次）强制，chat 轻量小任务可免（工具常在、纪律按任务配）。

## 理由
进度事实源原只有原始 trace（太低层）与终点 closure（太晚）——SubAgent 中途出问题时派发方只能扒代码现场猜进度，原工作进度丢失；统一 plan 工具族（而非专用台账工具）让 chat/task 两域同一实现、同一纪律，避免双轨。

## 适用范围
写任何 SubAgent brief 模板（决定是否强制 plan）时；实现派发方进度判定或断点接力时；改 closure 机械判据时；给任务页或 chat 侧加实例进度展示时。

## 反例
为任务编排器新造一套专用台账工具与 chat 域分叉（双轨——AD-6 裁决的就是统一写口）；把 plan 当 trace 用记录原始工具流（语义层级错乱——plan 是 LLM 策展的语义进度）；closure 时 plan 留 pending 项也判收口成功（硬约束失守，编排器无法机械判批次成败）；brief 不写 plan 硬约束却要求长任务有台账（纪律按任务配——无硬约束段则无强制）。

```kg-node
id: TR-AD-62
kind: rule
graph: tech
layer: arch
scope: domain
stack: backend
name: 阶段通用化与 skill manifest（阶段落数据行不落代码；创建时定义确认后冻结；任务间无关系结构）
status: active
digest: 动 stage 表或阶段状态机、改任务类型 manifest 字段、加 createTask 校验、想做任务关联/任务编排任务时
derivedFrom:
  - AD-9（iter-20260829-ys7q）
anchors:
  implementedBy:
    - apps/daemon/src/domain/task/manifest.ts
    - apps/daemon/src/application/services/task/TaskEngineService.ts
updatedIn: iter-20260829-ys7q
```

## 规则
①阶段（stage）是任务系统一等通用结构（job.stages[]：名称/状态/摘要/产物集），引擎只做通用阶段状态机（pending→running→done/failed），零语义——bootstrap 的 L0/L1/L2 只是 stage 行的实例数据。②阶段逻辑不落代码落数据行：createTask 时把发起者确认后的阶段计划作为 stage 数据行插入（「每次发起都不一样」= 实例级数据天然成立）；确认落库后冻结 = 不再增删行，引擎只转 status，编排主 agent 只在阶段内展开批次（批次划分是运行期 LLM 判断，阶段划分不是——防执行中阶段漂移）。③任务类型 skill 的 frontmatter 扩展为机器可读 manifest（task.paramsSchema + stages 策略：fixed list → 引擎直接生成阶段行 / free → 取发起者确认列表 + confirm/plan 声明），引擎 createTask 时确定性校验；正文 = 编排 agent 运行期 SOP——一文两消费，SkillScanner 本就解析 frontmatter，新增任务类型 = 加一个 skill 文件不改引擎代码。④任务间无关系结构：projects[] 多标签不是任务↔任务；批次/任务重跑渊源由 batch.retryCount + kg change_log supersede 链承载，不建任务关系表。

## 理由
阶段是进度呈现/阶段产物/断点恢复的组织单位（必须进引擎通用层），但其内容是实例级的（进创建时确认）——两级骨架 job→stage→batch→SubAgent 实例因此通用，新任务类型零引擎改动；任务关系是开放语义，register 明确不做（范围外），重跑渊源已有审计面承载。

## 适用范围
修改 stage 表结构或阶段状态机时；给任务类型 manifest 加字段时；实现 createTask 校验或断点恢复重建时；任何想引入任务↔任务关系（依赖/编排/父子）的设计讨论时。

## 反例
把 L0/L1/L2 写成代码里的枚举驱动逻辑（阶段语义进引擎——新任务类型就要改代码）；编排 agent 运行中增删 stage 行（阶段漂移——冻结语义失守）；建 task_relations 表表达任务依赖（register 明确范围外，重跑渊源走 retryCount + change_log）；manifest 校验放编排 agent 提示词里靠 LLM 自律（确定性校验必须代码化，schema 校验即防线）。

```kg-node
id: TR-AD-63
kind: rule
graph: tech
layer: arch
scope: domain
stack: backend
name: 任务的项目关联 0..n 普通标签（projects[] 可空多选；基数由任务类型 paramsSchema 声明；引擎不做项目假设）
status: active
digest: 动 job 表 projects 字段、加任务类型参数 schema、写任务列表项目过滤/徽章、解析任务目标项目时
derivedFrom:
  - AD-8（iter-20260829-ys7q）
anchors:
  implementedBy:
    - apps/daemon/src/domain/task/
    - apps/daemon/src/application/services/task/
updatedIn: iter-20260829-ys7q
```

## 规则
任务实体的项目关联 = 多选标签数组（job.projects[]，空数组合法、可空）——项目是任务的普通上下文标签，不是组织维度；任务是开放概念，无项目关联是常态（跨项目调研/workspace 级审查/纯文档任务与多项目关联分析都合法）。是否需项目、需几个，由任务类型的 paramsSchema 声明（kg-bootstrap 要求恰好 1 个），引擎按 schema 校验，不对任务实体做项目假设。任务页项目 = 行属性徽章（有才显示）+ 普通过滤器，列表组织维度 = 状态与时间，不分栏。宿主逻辑不变：需项目上下文的任务类型宿主 = /project 页，无项目任务宿主 = chat。

## 理由
用户裁决（2026-08-29）：projectRoot 作为普通标签、多选、可为 null——把项目升成组织维度会让无项目/多项目任务成为二等公民，且任务页按项目分栏与「全局平铺观察全部任务」的监控定位冲突。

## 适用范围
修改 job 表或任务 DTO 的项目字段时；设计新任务类型的参数 schema（声明项目基数）时；实现任务列表过滤/分组或项目徽章渲染时；任务内解析目标项目路径时（仍走 TR-AD-56 单点解析）。

## 反例
job 表设 projectId 单值非空外键（无项目任务无法表达）；任务引擎内置「任务必须有项目」校验（越权——基数判定归任务类型 schema）；任务页按项目分栏组织列表（组织维度 = 状态与时间，项目只是过滤器）；把 projects[] 当任务↔任务关系或工作区分组用（它是普通上下文标签）。

```kg-node
id: TR-AD-64
kind: rule
graph: tech
layer: arch
scope: domain
stack: backend
name: kg 节点任务元数据衔接面（taskId/origin_batchId/layer 是任务域→kg 域唯一衔接面；批次重跑幂等 = 旧产出
  supersede + 新跑）
status: active
digest: 写 bootstrap 批次产出落库、动 nodes/change_log 表结构、做批次重跑幂等、写按任务/批次/层分组的产出查询时
derivedFrom:
  - AD-10（iter-20260829-ys7q）
  - F2.4（iter-20260829-ys7q）
anchors:
  implementedBy:
    - apps/daemon/src/adapters/driven/sqlite-kg/schema.ts
    - apps/daemon/src/application/services/kg/KgWriteService.ts
updatedIn: iter-20260829-ys7q
```

## 规则
任务系统产出知识时，任务域 → kg 域的唯一衔接面 = 三个节点元数据：①layer——既有 nodes.layer 列启用（L0/L1/L2，domain/kg/types.ts NodeLayer），bootstrap 分层标记；②origin_batchId——nodes 表 additive 新列（日常落账节点为 NULL），批次产出判据；③taskId——change_log 表 additive 新列（与 iterationId 并列），审计链溯源。写入唯一通道 = 批次 SubAgent 经 KgWriteService（KnowledgeWriteOp additive 扩 taskId?/originBatchId?，schema 校验登记），含 additive 批量 op batchCreateNodes（O-5 用户裁决 2026-08-29 本迭代直接做——LLM/编排器按写入量自选单条 createNode 或批量 op）；bootstrap 产出落库 status=confirmed（无 draft 状态，用户裁决——以代码事实落盘即正式知识）。批次重跑幂等 = 按 origin_batchId 检出旧产出 supersede（理由如实记录）+ 新跑产新节点；实例 plan 的产物指针辅助跳过已完成的探索步骤。任务系统不感知产出处置——产出呈现分组查询（按任务/阶段/批次）由 kg 域经这三个元数据驱动。

## 理由
AD-10 职责分界的物理兑现：任务只执行并给结果，后处理（呈现/修正）是 kg 域逻辑——衔接面必须窄且确定性（三个元数据列），宽衔接（任务系统读 kg 状态/写处置结论）会让两域耦合，通用性破产；supersede + 新跑（而非原地改）保住 change_log 审计链与「修正代价是重跑不是阻塞」哲学。

## 适用范围
实现或修改 bootstrap 批次产出落库路径时；给 nodes/change_log 加列或改 KnowledgeWriteOp 时；实现批次自动重试/整任务重跑的幂等逻辑时；写 /project 页产出呈现区的分组查询时。

## 反例
任务系统直接查 kg 库判产出处置进度或回写处置结论（宽衔接——AD-10 否决；衔接面只有三个元数据列）；批次重跑时原地 updateNode 覆盖旧产出（审计链断裂——必须 supersede + 新号）；绕过 KgWriteService 在编排器里直写 nodes 表（F-1 唯一写入口失守）；给 layer 列加 CHECK 约束冻结词表（F-2：词表待 bootstrap 实践冻结，schema 注释明说不加 CHECK）。

```kg-node
id: TR-AD-65
kind: rule
graph: tech
layer: arch
scope: global
stack: shared
name: 人类可读性总体原则（图谱内容 + 任务人类界面全部为「人类判断与裁决」设计；bootstrap 写作规范五条）
status: active
digest: 写 kg 节点正文/digest、写批次产出摘要或阶段产物、做任务页或产出呈现区渲染、评审任何人类界面文案时
derivedFrom:
  - AD-4（iter-20260829-ys7q）
anchors:
  implementedBy:
    - apps/daemon/resources/skills/kg-bootstrap/SKILL.md
    - apps/daemon/src/application/services/task/TaskQueryService.ts
updatedIn: iter-20260829-ys7q
```

## 规则
不止图谱内容，任务系统提供给人类审核的全部界面物（任务内容卡/进度呈现/批次产出摘要/阶段产物/产出呈现区）同样必须为「人类判断与裁决」设计——人读不懂则修正决策是空话。①bootstrap 写作规范五条（入 kg-bootstrap skill，批次产出验收条件）：正文完整自然语言（语义自包含、禁电报体、引用节点必带 name）；digest ≤2 行叙述式（一句话说清这是什么+何时相关），非触发式电报体；每条知识带「为什么存在」（来源符号/文件+存在理由）；实体/契约必须符号域锚（path#symbol）、规则按三级作用域；closure 自检「人类开发者只看正文不看代码能否理解」，不能则不产出。②任务人类界面遵循 P1 人类可读三原则（事件导向非节点导向/因果链完整/永远带行动项）+ 引用规范（知识节点 = 粗体 name+kind 徽章+digest 首行，代码符号 = 符号名+路径:行号，裸 id 不出现——TR-AD-54 延伸）；数据面（TaskQueryService/KgReportService）组装时即按规范产出，不依赖前端自律。

## 理由
v1 图谱对人类不可读的教训（电报体 digest/编号语汇/正文稀疏）不得在任务系统重演（用户裁决 2026-08-29，选项 B 全面覆盖）；人类可读是 bootstrap 产出呈现与事后修正（CL-4）的硬前提——呈现区若读不懂，错误知识就无人能发现、事后修正就是形式。

## 适用范围
写或改任何 kg 节点（digest/正文）时；编排 agent 产阶段摘要/批次 scope 描述时；实现任务页/产出呈现区/报告面渲染时；评审涉及人类界面的 PR 时。

## 反例
批次产出 digest 写「动 X 时」（触发式电报体，不说清这是什么——bootstrap 写作规范禁；注：daemon 内部规则 digest 的触发式约定（TR-AD-1~58 形态）是机器注入面语汇，不在此例）；任务页批次列表直接渲染 batch-<id>（裸 id 进人类界面）；阶段摘要只堆节点 id 清单无因果叙述（三原则失守）；前端自行拼人类可读文案（规范必须在数据面组装层强制）。
