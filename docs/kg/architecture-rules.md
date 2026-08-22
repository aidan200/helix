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
updatedIn: iter-20260821-dg90
```

## 规则
daemon 采用 DDD 六边形架构，固定四层目录与单向依赖：domain/（纯业务：会话聚合、轮次生命周期、steer/abort 语义、工具调用模型、workspace 分组；framework-free，禁止 import 外层任何模块与 pi 库符号——唯一例外 @helix/common：业务无关通用常量/纯工具经 AG-02① 白名单显式允许直引，@helix/protocol 与 pi 系仍禁，iter-20260821-dg90 AD-1）→ application/（ports/ 按 inbound/outbound 双向组织——inbound：AgentOrchestrationPort、SystemPort、ChatPort、ResourceConfigPort、SessionPort、ModelPort、SessionDirectoryPort 等（接口由 service 或组合根实现）；outbound：AgentEnginePort、SessionRepositoryPort、ToolExecutorPort、EventPublisherPort、ClockPort、AuthStorePort、DefaultModelPort、ModelCatalogPort、BrowserPort、ResourceStatePort、SkillSourcePort 生效 10 个（由 service 调用；双向清单详见 TR-AD-2，iter-20260821-dg90 终验 L3 复核校正计数）+ services/：ChatService、SessionService、RestoreService、SchedulerService；只依赖 domain 与自有 port + 白名单三项（@helix/common——业务无关通用层直引，AD-1/iter-20260821-dg90；@helix/protocol——协议类型与纯投影消费（MAIN_INSTANCE_ID 唯一定义已迁 @helix/common，protocol 为 re-export 通道，AG-13 取源断言语义同步）；node:path——scheduler/ClosureRecorder 产物路径；以守护 AG-02② 白名单为准，iter-20260821-dg90 扩为三项），禁止 import adapters 与 pi 库）→ adapters/（driving/：ws-server、cli，调用 inbound port；driven/：pi-engine 防腐封装、sqlite-session、tools、subagent（SubAgent 子进程 launcher/child/transport）、static-serve、cdp（BrowserPort 的 CDP 实现域：CdpConnectionManager/browser-discovery/TabRegistry，零 pi import、不入 AG-04 三根——iter-20260821-dg90 终验 L3 复核补枚举），实现 outbound port；adapter 之间禁止互相 import 绕过 application）→ infrastructure/（组合根：装配、配置、日志、进程生命周期；唯一允许 import 全部层的装配点；组合根锚面 = container.ts + infrastructure/assembly/**——命名装配函数族 buildPersistence/buildModelStack/buildSessionStack/wireEventFanout 落 assembly/ 目录，iter-20260821-dg90 H2.2 拆分，AG-02④ 豁免面同步扩为该锚面）。新增代码先定层再写文件。

## 理由
六边形与 daemon「唯一事实源 + 端口适配」职责天然契合——pi 引擎/SQLite/WS 都是可替换端口（AD-12）；单向依赖保证防腐：换引擎、换存储、换前端均不动 domain 与 application（AD-17）；业务逻辑 framework-free 才能零依赖单测。iter-20260821-dg90 两处扩张均为机械跟随非语义反转：domain 白名单开 @helix/common 例外是 AD-1 裁决——MAIN_INSTANCE_ID 双源即本规则「取源单点」条款与 AG-02 domain 禁令内战的产物，解法 = 引入两者之下都合法的最小公共层（规则全文见 TR-AD-28）；组合根锚面从单文件扩为目录是 H2.2 四命名装配函数拆分的落位配套（组合根「唯一允许 import 全部层、new 具体实现」语义不变，container <500 行目标的结构前提）。

## 适用范围
apps/daemon 全部新增/修改代码的落位决策；新增任何 adapter 或 port 时；代码评审的分层检查项；动 infrastructure/assembly/ 装配函数、组合根豁免面或 DaemonOptions 生产/测试形态（createTestDaemon）时；packages/common 依赖边接入 domain/application 的白名单审查。

## 反例
application/services/ChatService 直接 import { Agent } from '@earendil-works/pi-agent-core' 驱动对话——绕过 AgentEnginePort，pi 升级即侵入 application（正确做法：经 outbound port 由 adapters/driven/pi-engine 实现）；或 domain import @helix/protocol——AG-02① 仍禁（白名单例外仅 @helix/common，协议类型经 adapter/projection 层转换）；或 infrastructure/assembly/ 之外的任何层 new 具体 adapter/service 实现——AG-02④ 红（组合根豁免面 = container.ts + assembly/**）；或把测试注入口（skipConfig/skipLock/engine 注入）写回生产 DaemonOptions——H2.3 两形态分离违例。

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
updatedIn: iter-20260821-dg90
```

## 规则
application/ports/ 按方向分两个子目录：inbound/（入口端口：接口由 service 或组合根实现——AgentOrchestrationPort 由 SchedulerService 实现、经 driven 编排工具（agent_spawn/send/status）回口调用；SystemPort 由组合根内联实现、driving ws-server 调用；ModelPort 由 ModelService 实现、SessionDirectoryPort 由 SessionRegistry 实现（T2.3 模型模块新增）；ChatPort 由 ChatService 实现、ResourceConfigPort 由 ResourceService 实现、SessionPort 由 SessionService 实现（iter-20260821-dg90 终验 L3 复核补枚举））与 outbound/（出口端口生效 10 个：AgentEnginePort、SessionRepositoryPort、ToolExecutorPort、EventPublisherPort、ClockPort、AuthStorePort、DefaultModelPort、ModelCatalogPort + BrowserPort、ResourceStatePort、SkillSourcePort，由 service 调用；SystemPort 自创建起即位于 inbound/；守护测试断言 ports 文件数 ≥9）。outbound port 的实现允许四类落位：driven adapter（pi-engine/sqlite-session/tools）、driving adapter（通知方向的标准形态——EventPublisherPort 的实现 EventStream/StdoutEventPublisher 落 driving 侧）、组合根内联（ClockPort 等纯技术 port 由 container 装配期实现）、infrastructure 纯技术文件 port（AuthStore——纯文件读写无 driving/driven 语义，落 infrastructure/auth-store.ts，AG-06③ 原子写白名单显式列名，与 dev-token/config 同类）、application service（EventPublisherPort 的会话投影实现 SessionProjection——fan-out 投影目标，经 container 装配进 publisherTargets，服务消费面 = 组合根内联 fanout，iter-20260820-qhv8 终验补记）；PathsPort 已删除（iter-20260820-qhv8 F-7 死代码清理，零实现零消费）。port 文件只允许接口定义（类型与方法签名），不允许出现任何实现代码、工厂函数或实例化；port 契约的参数/返回类型只用 domain 模型或 port 自有类型（protocol DTO 转换发生在 ws-server adapter，见模型隔离规则）。

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
digest: 加配置项、定位数据文件、解析任何路径时
derivedFrom:
  - AD-13
  - AD-14
anchors:
  implementedBy:
    - apps/daemon/src/infrastructure/paths.ts
    - apps/daemon/src/infrastructure/auth-store.ts
    - apps/daemon/src/adapters/driven/pi-engine/model-catalog.ts
  testedBy:
    - apps/daemon/test/unit/paths.test.ts
    - apps/daemon/test/unit/config.test.ts
    - apps/daemon/test/unit/auth-store.test.ts
relations:
  governs:
    - E-领域事件与单写队列
    - E-认证凭据
updatedIn: iter-20260820-qhv8
```

## 规则
~/.helix 是 daemon 唯一配置/数据/日志主目录，全部自有状态进 home，不用环境变量：config.json（daemon 配置面：端口、调度预算等——T2.3 瘦身后模型数据面已迁出：provider API keys → auth.json、默认模型 → helix.db default_model 表、模型目录缓存 → models-store.json，旧格式幂等迁移）、auth.json（provider 凭据，0600，格式见 TR-AD-7）、dev-token（CL-6）、logs/、helix.db（SQLite WAL）、models-store.json（ModelCatalog 落盘兜底）。所有业务路径解析收束于 infrastructure/paths.ts 单一模块：home 展开的跨平台处理（os.homedir + path，Windows 差异同处收束）、各文件相对 home 的定位；新增 auth.json/models-store 路径必须经 paths.ts 单点派生（勿复制 container.ts reports 旁路先例）；支持可选 `--home <dir>` 启动参数覆盖（测试指向 tmp 目录用）。任何模块不得自行拼接 ~/.helix 子路径，也不得经环境变量取配置；壳零参与路径解析（需要业务路径时向 daemon 查询；壳仅保留自身 bundle 资源定位：sidecar 二进制/前端静态产物）。

## 理由
单一事实源原则的文件系统延伸；daemon 全局单例（AD-7）与全局 home 目录天然对应；dev 期壳缺席（AD-8）而路径逻辑放壳会造成 dev/打包双轨（AD-14）；路径解析收束一处才 framework-free 可测试；模型数据面迁出 config.json 是 AD-2 落地（T2.3）的文件布局面。

## 适用范围
CL-1 配置模块设计、CL-6 token 落点、CL-8 db 路径、测试注入 home 目录；任何新增自有状态文件的落点决策；模型模块（auth.json/models-store.json/default_model）文件布局评审。

## 反例
ws-server adapter 里自己写 `path.join(os.homedir(), '.helix', 'dev-token')` 读 token，或用 `process.env.HELIX_DB` 指定数据库路径——绕过 paths.ts 单点，--home 覆盖对它失效；或 auth-store 自行拼接 ~/.helix/auth.json 路径而不经 paths.ts——测试 home 注入对该文件失效。

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
anchors:
  implementedBy:
    - apps/daemon/src/adapters/driven/pi-engine/
    - apps/daemon/src/adapters/driven/tools/
    - apps/daemon/src/adapters/driven/subagent/
  testedBy:
    - apps/daemon/test/arch-guard/arch-guard.test.ts
relations:
  governs:
    - E-AgentRuntime
    - E-模型目录
    - E-认证凭据
updatedIn: iter-20260821-dg90
```

## 规则
daemon 运行时依赖仅限 @earendil-works/pi-agent-core 与 @earendil-works/pi-ai 两包，零 pi-coding-agent import。工具集 = bash/edit/read/write 四个 core 内置工具 + 自写 grep + web 族（web_search/web_fetch 静态注册 + browser 条件注册薄转投 BrowserPort，tools/web/——iter-20260821-dg90 终验 L3 复核补枚举）+ 编排三工具（agent_spawn/agent_send/agent_status，tools/agent/AgentOrchestrationTools 薄转投 AgentOrchestrationPort，注册进 MainSessionProfile）。pi 库 import 只允许出现在 adapters/driven/pi-engine、adapters/driven/tools（工具接线域：core Tool 接口/ExecutionEnv 封装的必然导入，AD-10 工具封装条款）与 adapters/driven/subagent（SubAgent 子进程形态：launcher 透传 Model、child 复用 pi-engine 防腐墙、剧本引擎用 pi-ai 流原语；T2.2 新增第三域；守护测试 AG-04 三根同口径）。import 通道红线：真实 provider 必须经 `@earendil-works/pi-ai/providers/all` 子路径（主入口 side-effect-free 拿不到真实 provider）；Node 执行环境必须经 `@earendil-works/pi-agent-core/node` 子入口。模型接入 = pi-ai + 显式凭据（AD-13；凭据存 ~/.helix/auth.json：Record<providerId, type-tagged Credential 联合>（pi 生态格式等价），0600 + pid 文件锁 + 原子写，OAuth 类型面支持、登录流不做，格式详见 E-认证凭据），弃 pi 的 SettingsManager 体系；模型能力来源 = daemon 自实现 ModelCatalog（builtin 静态表（provider 数随 pi-ai 版本演进，0.84.2 = 40）+ pi.dev overlay 合并，ETag 条件刷新/4h 缓存/防降级/落盘兑底，零 pi-coding-agent import，落位 driven，详见 E-模型目录）；默认模型存 SQLite default_model 表（非 config.json）。

## 理由
extension 身份是 v1 兼容成本根源，pi 降为库（AD-2）；F-7 实读证明 core 已自带四工具（「pi-coding-agent 当工具箱」前提被证伪，AD-10）；依赖最小化既定原则；主入口/子入口陷阱是 pi 源码实读结论（F-7）。

## 适用范围
新增任何 pi 相关依赖或 import、接模型 provider、实现工具集、评审 adapters/driven 的 pi-engine/tools/subagent 三域。

## 反例
从 pi-ai 主入口 import 模型工厂（side-effect-free 导出为空实现，运行时才炸），或为省两行代码 import pi-coding-agent 的 write 工具工厂。

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
  - S1-S4 布局统一用户裁决（2026-08-21：AppLayout 统一壳/五页签/models 迁 settings/sidebar 语义自决）
anchors:
  implementedBy:
    - apps/shell/src/app/route.ts#routeOfPath
    - apps/shell/src/app/useAppRoute.ts
    - apps/shell/src/app/App.tsx
    - apps/shell/src/widgets/nav-rail/ui/IconRail.tsx
    - apps/shell/src/widgets/app-layout/ui/AppLayout.tsx
    - apps/shell/src/shared/ui/ConstructionBoard.tsx
  testedBy:
    - apps/shell/src/app/route.test.ts
    - apps/shell/src/widgets/app-layout/ui/AppLayout.test.tsx
    - apps/shell/src/tests/ag-scans.test.ts
relations:
  governs:
    - E-会话聚合
updatedIn: task-20260821-s1s4
```

## 规则
前端采用标准 FSD 五层（app/pages/widgets/features/entities + shared）；WS 客户端落 shared/api（transport 缝隙集中于此）；Cyber HUD 设计 token 落 shared/ui：CSS 变量 :root 唯一真源 + rgb(var(--x)/<alpha-value>) alpha 修饰符模式；原子组件自持有（shadcn 哲学：Magic UI 等按需 copy-in，无全量库依赖）。主题用注册表机制：每主题 = 同名语义 token 变量块不同值（暗色挂 :root 为默认，追加主题以 html class 挂载），后期整体调整只改主题块不动组件；主题是纯前端 concern，daemon 无主题概念；用户偏好 localStorage 持久化。文案全 key 纪律：P-1 页面所有 UI 文案走搬入的 desk 轻量 i18n（React context + localStorage 持久化 + navigator.language 检测，zh-CN/en-US 双语言包），无硬编码文案；协议 DTO 不含语言字段，中英文本传原始内容，语言选择是前端渲染 concern。
页面域与会话域分离：路由层（app/route.ts + useAppRoute + IconRail 导航壳）表达页面域（五页签 chat/skills/trace/project/settings 终态；手写路径路由 / /skills /trace /project /settings，不采 ?page= 深链；未知路径回落工作台，/models 与旧 /settings/models 同语义退役不保兼容），SessionProvider 及其内（会话侧栏/主区/dispatcher/consumers）表达会话域；SessionProvider 在路由层之上（切页零 WS 影响），IconRail 不读会话 store、会话域组件不感知路由状态。chat 页常驻 DOM（route-layer + data-route display 切换保流式），其余页条件渲染离开卸载。统一布局壳（task-20260821-s1s4 用户裁决）：全部页面共用 widgets/app-layout AppLayout——.app-layout（100dvh 自身不滚）→ header（48px 全宽固定；headerLeft 页面标题槽 + headerRight 动作槽）→ layout-body（sidebar 可选槽 + main.layout-main 唯一滚动容器）；页面滚动只发生在 layout-main，header/IconRail 不随内容滚动，页面禁自建页壳/自开整页滚动。IconRail 品牌位 = HelixLogo 渐变图标（header 品牌位退役）、主题切换单钮（Sun/Moon 显示切换目标）置 rail 底部头像上方（header 主题分段钮退役）；scanline 氛围层 App 层全局单份。各页 sidebar 语义自决（壳只管布局不感知内容）：chat = 会话清单（可折叠）、trace = 上下分区（上会话清单/下选中会话实例列表）、settings = 分区导航（首项模型设置；/models 独立页已退役，模型配置迁入功能零变更，chat 快捷入口链同批退役）、project 暂不启用（槽位预留）。页面回填 additive：未来功能页填充不动导航壳与路由骨架（新增页面 = 路由位 + 页组件 + IconRail 图标三项 additive）。占位页 = 静态施工牌（图标 + 页名 + 一句话能力预告 + 「规划中」徽标，复用 Cyber HUD 空态语言；现仅 project 使用），不绑路线图（不做时间/顺序暗示，避免隐性承诺），与断连态视觉区分。

## 理由
desk 前端本就 FSD 五层，切片搬运成本最低（F-6）；desk i18n 方案已验证且轻量（~1.7k LOC，F-8）；daemon 是开发者面向、统一中文不做 i18n（AD-18）；主题注册表避免后期主题级调整侵入每个组件（Q-7 裁决）。M4 AD-1 + Q-4a/b/c：框架先行解耦交付（页面内容随功能推进）；域分离是「chat 页常驻 DOM 保流式」与「页面自由扩展」两个不变量的结构基础——任何一侧感知另一侧都会在页面增长后产生耦合反噬；施工牌不绑路线图避免把迭代规划泄漏成对用户的隐性承诺。

## 适用范围
CL-7 前端聊天流切片搬运与 P-1 页面开发；新增任何前端组件、文案、主题 token；shared/api 的 WS transport 改造。新增或填充任何页面（仅 project 施工牌待回填；skills/trace/settings 已实页）；动 App.tsx 装配序或路由常量；IconRail/导航壳/AppLayout 统一壳与 sidebar 槽演进评审；占位页与施工态设计。

## 反例
组件里写死「发送」二字不走 i18n key，或卡片组件内硬编码 rgb(0,255,255) 色值绕过主题变量——换主题即漏色。新功能页组件 import 会话 store 内部（页面域污染会话域——页面卸载时会话态被误清或页面状态残留）；或占位页写「即将上线 / Q4 推出」时间暗示（隐性承诺）；或页面填充时改 IconRail 骨架/路由结构（回填必须 additive）；或把 IconRail 放进 SessionProvider 内部依赖活跃会话渲染；或新页面自建页壳/自开整页滚动容器绕过 AppLayout（header 随内容滚走、布局风格漂移复发——统一前四页三套头部的历史问题即此）。

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
updatedIn: iter-20260822-m1uc
```

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
name: closure 双通道分发与异步交付
status: active
digest: 动 closure 收口或注入链路、写 SubAgent 完成卡片时
derivedFrom:
  - AD-8
relations:
  governs:
    - E-SteerQueue
    - E-ClosureRecord
updatedIn: iter-20260819-erio
```

## 规则
closure 结构承接 v1：{status: done|failed, summary, reportPath?, findings?, taskId?}；findings 字段保留（kg 自动落账 v2 重生长时接，M4+ 事项不在本规则范围）。
异步交付语义：agent_spawn 工具秒回 {agentId, spawned} 不挂起当前 turn；closure 到达驱动 MainAgent 新 turn（不是被动等待）；等待期用户 steer 与 closure 注入同队列 FIFO（SteerQueue 一等机制，替代 v1 customPrompt hack）。
closure 到达时双通道分发：①上下文通道——SteerQueue.enqueue（「agent-N closure: done — <summary>」），唯一入口进 MainAgent 窗口，turn 边界 drain；②用户通道——领域事件 agent.completed{agentId, closure} → WS → 聊天流 SubAgent 完成卡片（summary + 状态徽标 + 抽屉入口，可回溯）。同一事实单一呈现面：注入文本进 MainAgent 上下文供 LLM 消费，前端以完成卡片呈现同一事实，不作为普通用户气泡重复渲染。
SubAgent 内部工具调用不回主线：只进 per-instance 事件流（落盘为挂 instanceId 的 Entry）→ UI 抽屉消费。
closure 记录与任务报告经 daemon 单写队列落 SQLite（closure 抗重启），不开第二写通道（TR-AD-13 同口径）；报告若为文件产物则经单写通道原子写、落点遵循 ~/.helix 单点（TR-AD-6）。

## 理由
AD-8（Q-9 修正版）：v1 已验证同构双消费（LLM 上下文 + 用户界面）；异步注入是「主会话不阻塞」的完整语义；SubAgent 内部工具若回主线会撑爆主线窗口，违背隔离初衷。

## 适用范围
closure 收口解析（SubAgent 系统提示约定的结构）、SteerQueue 注入消费、agent.completed 事件与完成卡片渲染、任务报告落盘路径设计、M4+ kg 自动落账接入时的结构约束。
（reportPath 产物形态待开发裁决 O-5，不作规则化。）
SubAgent 错误呈现面 = agent.failed error 字段（iter-20260819-erio AD-1/AF-1 留痕）：engine.error 帧对 SubAgent 实例由 DtoMapper 守卫抑制不广播，用户可见错误原文经 closure 兼容摘要第四消费面透出（agent.failed error → SubAgentCard 展示链），不占主聊天流。

## 反例
closure 到达直接拼进 MainAgent 当前生成中的流（绕过 SteerQueue，FIFO 语义与 turn 边界丢失）；或 SubAgent 每个工具调用都转发主线聊天流——主线窗口被撑爆、隔离失效；或前端把注入文本再渲染成一条用户气泡——同一事实双呈现。

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
name: SubAgent 模型三级解析链（profile > 会话快照 > 全局兜底）
status: active
digest: 动 SubAgent 模型来源、写 spawn 模型透传管线、配 profile 模型槽位、调全局兜底语义时
derivedFrom:
  - AD-3（iter-20260819-erio：用户裁决「按优先级，profile > 会话模型 > 全局默认」）
anchors:
  implementedBy:
    - apps/daemon/src/adapters/driven/subagent/SubagentLauncher.ts
    - apps/daemon/src/application/services/scheduler/SchedulerService.ts
    - apps/daemon/src/infrastructure/container.ts
    - apps/daemon/src/adapters/driven/pi-engine/runtime/AgentRuntime.ts
    - apps/daemon/src/adapters/driven/pi-engine/PiAgentEngineAdapter.ts
  testedBy:
    - apps/daemon/test/unit/engine-state-mutation.test.ts
relations:
  governs:
    - E-AgentProfile
    - E-调度器
updatedIn: iter-20260821-m6
```

## 规则
SubAgent 实例的模型来源按三级优先级解析：①SubAgentProfile.model 真实槽位（装配期 resolveModelSlot 解析，声明即最高优先级）→ ②spawn 时快照的会话模型（spawnModels 管线：agent_spawn 经 AgentOrchestrationPort.spawn 透传会话现值，SchedulerService.spawn 时刻快照入 spawnModels，此后主实例再切模型不影响在跑/排队实例）→ ③全局兜底（默认模型存储现值 getter，container 组合根注入，语义 = 「全局兜底」而非「SubAgent 默认来源」）。launch 段是三级链的唯一消费点：SubagentLauncher.launch 携带解析结果，子进程 HELIX_MODEL_JSON 仍为完整 Model 对象透传（防 registry 不含的红线不变）。取代边界：本规则取代 M2 AD-6「SubAgent 缺省继承全局默认」中「SubAgent 模型源 = 全局默认表」的解析规则；不取代会话级 model.set 内存态语义（主实例模型仍为 AgentState.model 内存态，重启/卸载回退全局默认）。

state 直改族谱扩展（M6，iter-20260821-m6）：setModel 之外新增 setTools/setSystemPrompt 同构直改（AgentRuntime → AgentEnginePort 可选扩面 → PiAgentEngineAdapter → ChatService 六层链，赋 agent.state 即下一 run 生效、in-flight context 快照定格不变——pi agent.d.ts「Assigning state.tools copies the top-level array」官方语义背书）。不走 prepareNextTurn 链（CompactionHook 占用且「首个非空生效」合并语义会短路，与换模同款机械裁决）。资源配置变更（kind 维）经 onApplied 回调刷新该 kind 全部活跃 runtime；SubAgent 按代生效（spawn 时刻 env 定格快照）；主会话槽位 UI 化后 main 型读面 = 四级链（per-session 覆盖 > kind 槽位 > default_model，读面生效不强推活跃 runtime）。

## 理由
M4 终验后真机 7 连败根因之一：会话内 model.set 只切主实例，SubAgent 模型源仍是全局默认（zai 配额耗尽后子进程 429 静默失败）。用户裁决三级优先级原话「profile > 会话模型 > 全局默认」。spawnModels 半截管线已存在（透传与存储段在线、launch 段未消费），改动面集中于 launch 签名与 model getter，无需新建通道。spawn 时快照（而非 launch 时读会话现值）保证排队实例的模型语义在 spawn 时刻确定、可观测（status 读面已携带 model）。

## 适用范围
SubAgent spawn/launch 链路实现与评审；profile model 槽位声明（代码层入口；UI 管理由智能体页 /skills 承接，模型下拉可用性过滤与 chat P-3 同口径）；default_model 相关文案/注释口径调整；模型切换链路的 E 层与真机验证；未来新增 profile 类型时模型槽位语义评审。

## 反例
SubagentLauncher 每次 launch 直接读全局默认 getter（单级解析回退——会话内切模型后 SubAgent 仍用旧全局默认，7 连败根因复发）；或 launch 时才读会话现值而不在 spawn 时快照（排队实例模型随主实例后续切换漂移，spawn 语义不可观测）。

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
  - AD-1（iter-20260821-dg90 技术债偿还：Q-2/D-4 用户裁决「正好引入 common 概念…保证其业务无关性」）
anchors:
  implementedBy:
    - packages/common/src/
  testedBy:
    - apps/daemon/test/arch-guard/arch-guard.test.ts
updatedIn: iter-20260821-dg90
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
updatedIn: iter-20260822-m1uc
```

## 规则
内置 TS 后端与 rg 后端对同一检索请求必须产出语义一致的结果，契约逐项固化：gitignore 遵守、隐藏文件处理、glob 过滤、大小写开关、上下文行、返回格式（恒为 GrepMatch：path/lineNumber/line）。契约由双后端对比测试机械守护（同一请求对 fixture 仓库跑真实两后端做结果对比断言，不用 mock 替代 rg——TR-TEST-3 契约等价口径）；新增任何语义维必须双端同批扩展并同步扩契约断言。一致性未覆盖的 rg 差异行为一律在 rg 后端适配层对齐到内置 TS 语义（rg 默认遵守 .gitignore、跳过隐藏文件——与内置行为不一致即适配层归一），宁失速不失真：加速不得改变检索结果。降级链：rg 缺失/执行失败/超时 → 门面捕获 → 本轮回退内置 TS 后端，结果照常返回 + warning 日志；用户与 agent 无感；降级不升级、不重试 rg 本轮调用。

## 理由
iter-20260822-m1uc CL-3 命门：rg 默认行为（gitignore/隐藏文件）若与内置 TS grep 不一致，加速会静默改变 agent 的检索结果——性能优化变成行为回归；契约先于加速钉死，双后端对比测试把「语义一致」从口头约定变成红绿事实；降级链保证零依赖环境（干净 macOS 无 rg）功能完备（CL-1 F1.3 零依赖功能验证的架构前提）。

## 适用范围
grep 工具双后端实现与评审；新增检索语义维（新参数/新过滤行为）时的双端同批扩展；一致性契约测试维护；rg 后端适配层的行为归一评审；降级路径与日志面评审。

## 反例
rg 后端直接透传 rg 原生行为（默认遵守 .gitignore、跳隐藏文件）而不与内置 TS 后端对齐——同一代码库在「有 rg」与「无 rg」环境下 agent 看到不同检索结果，加速变成行为分叉；或新增 glob 语义只改 TS 后端忘改 rg 后端且无契约断言——双端语义静默漂移，无测试能红。

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
updatedIn: iter-20260822-m1uc
```

## 规则
打包产物的资源落位分三条固定通道：①daemon 编译单文件（bun build --compile 产物）走 Tauri externalBin（sidecar 机制）——sidecar 语义 = 被壳看护的 daemon 进程，壳 spawn 并做进程看护；②三方二进制（本期 rg macOS arm64，后续 codegraph 同通道）走 bundle resources，包内落位 resources/bin/；③shell 静态产物（vite build dist）走 frontendDist。三类资源禁止错位：三方二进制不得塞进 externalBin（sidecar 语义专属被看护 daemon），daemon sidecar 不得散落成普通 resources，前端产物不走 resources 手工拷贝。架构目标 arm64 only：所有捆绑二进制只产单架构，不做 universal 双份（AD-6）。构建管线一条命令依序编排：bun build --compile → vite build → tauri build，任一步失败即中断报错（CL-2 F2.1）；签名配置位读环境变量（有=签名+公证/无=ad-hoc，AD-5），不硬编码证书。

## 理由
iter-20260822-m1uc AD-4/F2.3 定三通道布局；externalBin 与 resources 在 Tauri 语义上是两种机制（进程看护目标 vs 数据资源），错位会使壳的 spawn/看护逻辑与资源定位逻辑纠缠；arm64 only 是用户确认的范围裁决（universal 需 rg/daemon 双份，工作量 +30% 收益小）；管线失败即断保证分发物不会产生「半截打包」的歧义状态。

## 适用范围
src-tauri/tauri.conf.json 的 externalBin/bundle/frontendDist 配置评审；构建管线脚本（build-desktop）实现与评审；新增三方二进制捆绑时的落位决策；签名/公证配置位接线评审。

## 反例
把 rg 也打成 externalBin sidecar——壳的 sidecar 看护面被迫处理「非 daemon 进程」，spawn 语义混淆；或把 daemon compile 单文件丢进 resources 再壳手工拼路径 spawn——绕过 Tauri sidecar 机制，签名/公证与权限面失去框架保障；或为 Intel Mac 兼容悄悄加 universal target——AD-6 裁决被架空，rg/daemon 双份捆绑成本静默进场。

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
updatedIn: iter-20260822-m1uc
```

## 规则
daemon 存在两种运行形态：dev 形态 = bun 直跑源码（一行 dev 命令编排三进程：daemon 直跑 + vite dev server + tauri dev；前置自检 Rust/cargo，缺失时输出一行安装提示并退出——Rust 是 Tauri 壳构建前提，非 helix 运行时依赖）；打包形态 = bun build --compile 单文件 sidecar。两形态行为一致性由 compile 产物等价验证兜底（F2.2：compile 单文件验证 spawn 自身跑子进程链路 + bun:sqlite，产出「功能等价于 dev 直跑」的验证报告，管线内步骤非手工检查）；compile 产物只在构建管线验证，dev 永远直跑源码。daemon 行为不得按运行形态分叉：禁止 daemon 代码内出现「检测自身是 compile 产物则走另一路径」类分支（资源定位差异只允许经启动参数注入消解，见三方二进制解析收口规则）。本规则是 TR-AD-12 的 daemon 侧互补：前端永远走同一 WS 通路，daemon 侧同样双形态同构。

## 理由
iter-20260822-m1uc CL-4 内嵌决策（用户 2026-08-22 确认）：dev 直跑源码保证调试体验（断点/热改/源码栈），compile 产物只在管线验证避免 dev 期被编译速度拖累；F-7① 实锤 compile 产物 spawn 自身跑 ChildMain 链路未验证——形态差异必须有机械兜底，否则「dev 能跑、打包炸」会在分发后才暴露；行为分叉分支一旦出现即产生双轨，与 TR-AD-12 前端面同构约束同一原理。

## 适用范围
dev 编排脚本（dev-desktop）与前置自检实现评审；构建管线 F2.2 等价验证步骤维护；daemon 进程启动/子进程 spawn 相关改动（ChildMain 链路、bun:sqlite 使用）评审；任何「按形态分支」的 daemon 代码评审。

## 反例
daemon 里写 if (isCompiled) { 用另一套子进程启动方式 }——双形态行为分叉，F2.2 等价验证失去意义（验证的不再是同一份行为）；或 dev 也跑 compile 产物求「绝对一致」——dev 调试体验被编译周期拖垮，且 CL-4 内嵌决策被违反；或前置自检缺失时直接 tauri dev 报一堆 Rust 工具链原始错误——F4.1 要求的一行安装提示指引被绕过。

