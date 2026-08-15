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
updatedIn: iter-20260815-6tss
```

## 规则
daemon 采用 DDD 六边形架构，固定四层目录与单向依赖：domain/（纯业务：会话聚合、轮次生命周期、steer/abort 语义、工具调用模型、workspace 分组；framework-free，禁止 import 外层任何模块与 pi 库符号）→ application/（ports/：AgentEnginePort、SessionRepositoryPort、ToolExecutorPort + services/：ChatService、SessionService、RestoreService；只依赖 domain 与自有 port，禁止 import adapters 与 pi 库）→ adapters/（driving/：ws-server、cli，调用 inbound port；driven/：pi-engine 防腐封装、sqlite-session、tools、static-serve，实现 outbound port；adapter 之间禁止互相 import 绕过 application）→ infrastructure/（组合根：DI 装配、配置、日志、进程生命周期；唯一允许 import 全部层的装配点）。新增代码先定层再写文件。

## 理由
六边形与 daemon「唯一事实源 + 端口适配」职责天然契合——pi 引擎/SQLite/WS 都是可替换端口（AD-12）；单向依赖保证防腐：换引擎、换存储、换前端均不动 domain 与 application（AD-17）；业务逻辑 framework-free 才能零依赖单测。

## 适用范围
apps/daemon 全部新增/修改代码的落位决策；新增任何 adapter 或 port 时；代码评审的分层检查项。

## 反例
application/services/ChatService 直接 `import { Agent } from '@earendil-works/pi-agent-core'` 驱动对话——绕过 AgentEnginePort，pi 升级即侵入 application（正确做法：经 outbound port 由 adapters/driven/pi-engine 实现）。

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
updatedIn: iter-20260815-6tss
```

## 规则
application/ports/ 按方向分两个子目录：inbound/（入口端口：接口由 service 实现、driving adapter 调用）与 outbound/（出口端口：AgentEnginePort、SessionRepositoryPort、ToolExecutorPort，由 service 调用、driven adapter 实现）。port 文件只允许接口定义（类型与方法签名），不允许出现任何实现代码、工厂函数或实例化；port 契约的参数/返回类型只用 domain 模型或 port 自有类型（protocol DTO 转换发生在 ws-server adapter，见模型隔离规则）。

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
所有 agent 走同一条实现路径，扩展遵循固定公式：新编排能力 = 新 HookSet（钩子处理器组合）+ 新 AgentProfile（声明式规格），AgentRuntime 零改动。三层职责：AgentRuntime 是 daemon 唯一驱动层（组装 pi-agent-core 的 Agent、注入钩子语义、驱动执行、管理生命周期），不感知任何具体编排模式；AgentProfile 是声明式规格（kind、系统提示、工具集、钩子装配、生命周期策略：常驻多轮 vs 单轮收敛），主会话 = MainSessionProfile，M2 SubAgent = SubAgentProfile（新增 profile，不改 runtime）；HookSet 是可组合钩子处理器（beforeToolCall/prepareNextTurn/transformContext/shouldStopAfterTurn/事件流），作用域（daemon 全局/workspace/agent 实例）是钩子处理器的属性而非目录结构。loop 本体（流式/工具批执行/截断）用 pi-agent-core 的 Agent+agentLoop 一行不重写，自建仅百行级驱动层；对 pi 库的 import 只允许出现在 adapters/driven/pi-engine。

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
relations:
  governs:
    - E-会话聚合
    - E-领域事件与单写队列
    - E-SteerQueue
updatedIn: iter-20260815-6tss
```

## 规则
daemon domain 层持有全部权威状态（会话聚合 Entry 树/轮次、agent 生命周期状态、steer 队列、工具调用记录），framework-free；前端零权威状态，只是纯事件投影（WS 事件流→reducer→视图状态，本地仅存纯 UI 态如输入草稿/折叠）。落盘唯一路径是 write-through 单写队列：领域事件 → application 单写队列 → SQLite WAL（~/.helix/helix.db）；内存 = 磁盘的投影缓存，无第二事实源；流式中间态不落盘（崩溃丢当前流，恢复到最后一致里程碑，与 pi LaneRecord 同语义）。重连恢复 = daemon 推快照 + 续增量事件，禁止前端自恢复。domain 定义自己的聚合类型，pi 的 Entry/LaneRecord 经 adapters/driven/pi-engine 薄防腐映射，domain 不 import pi 类型。

## 理由
v1 双轨病根 = 前端状态副本 + DB 双写（F-2 desk 实锤）；D7 唯一事实源决策的领域层落地；write-through + WAL 让崩溃恢复语义简单（AD-16）。

## 适用范围
CL-8 持久化与恢复实现；CL-7 F(7).4 重连逻辑；任何新增领域状态的归属与落盘决策。

## 反例
前端把会话历史再存一份 IndexedDB 并做双向同步，或某 adapter 绕过单写队列直写 helix.db——第二事实源出现，重启后两边状态分叉。

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
updatedIn: iter-20260815-6tss
```

## 规则
~/.helix 是 daemon 唯一配置/数据/日志主目录，全部自有状态进 home，不用环境变量：config.json（全部自有配置：model 字符串、端口等；apiKeys 字段文件权限 0600，daemon 读取后显式传入 pi-ai 工厂函数，不走其 env 解析路径）、dev-token（CL-6）、logs/、helix.db（SQLite WAL）。所有业务路径解析收束于 infrastructure/paths.ts 单一模块：home 展开的跨平台处理（os.homedir + path，Windows 差异同处收束）、各文件相对 home 的定位；支持可选 `--home <dir>` 启动参数覆盖（测试指向 tmp 目录用）。任何模块不得自行拼接 ~/.helix 子路径，也不得经环境变量取配置；壳零参与路径解析（需要业务路径时向 daemon 查询；壳仅保留自身 bundle 资源定位：sidecar 二进制/前端静态产物）。

## 理由
单一事实源原则的文件系统延伸；daemon 全局单例（AD-7）与全局 home 目录天然对应；dev 期壳缺席（AD-8）而路径逻辑放壳会造成 dev/打包双轨（AD-14）；路径解析收束一处才 framework-free 可测试。

## 适用范围
CL-1 配置模块设计、CL-6 token 落点、CL-8 db 路径、测试注入 home 目录；任何新增自有状态文件的落点决策。

## 反例
ws-server adapter 里自己写 `path.join(os.homedir(), '.helix', 'dev-token')` 读 token，或用 `process.env.HELIX_DB` 指定数据库路径——绕过 paths.ts 单点，--home 覆盖对它失效。

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
updatedIn: iter-20260815-6tss
```

## 规则
daemon 运行时依赖仅限 @earendil-works/pi-agent-core 与 @earendil-works/pi-ai 两包，零 pi-coding-agent import。工具集 = bash/edit/read/write 四个 core 内置工具 + 自写 grep（走 core 的 Tool 接口 + ExecutionEnv 抽象，封装边界留 adapters/driven/tools，日后可换）。pi 库 import 只允许出现在 adapters/driven/pi-engine。import 通道红线：真实 provider 必须经 `@earendil-works/pi-ai/providers/all` 子路径（主入口 side-effect-free 拿不到真实 provider）；Node 执行环境必须经 `@earendil-works/pi-agent-core/node` 子入口。模型接入 = pi-ai + 显式 apiKeys（AD-13），弃 pi 的 SettingsManager/auth.json/models.json 体系；模型能力（provider 目录/refresh/OAuth）全部来自 pi-ai 内置，daemon 仅在 config.json 写一个 model 字符串。

## 理由
extension 身份是 v1 兼容成本根源，pi 降为库（AD-2）；F-7 实读证明 core 已自带四工具（「pi-coding-agent 当工具箱」前提被证伪，AD-10）；依赖最小化既定原则；主入口/子入口陷阱是 pi 源码实读结论（F-7）。

## 适用范围
新增任何 pi 相关依赖或 import、接模型 provider、实现 CL-5 工具集、评审 adapters/driven/pi-engine 与 adapters/driven/tools。

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
digest: 写前端组件、搬 desk 切片、加文案或主题时
derivedFrom:
  - AD-12
  - AD-18
updatedIn: iter-20260815-6tss
```

## 规则
前端采用标准 FSD 五层（app/pages/widgets/features/entities + shared）；WS 客户端落 shared/api（transport 缝隙集中于此）；Cyber HUD 设计 token 落 shared/ui：CSS 变量 :root 唯一真源 + rgb(var(--x)/<alpha-value>) alpha 修饰符模式；原子组件自持有（shadcn 哲学：Magic UI 等按需 copy-in，无全量库依赖）。主题用注册表机制：每主题 = 同名语义 token 变量块不同值（暗色挂 :root 为默认，追加主题以 html class 挂载），后期整体调整只改主题块不动组件；主题是纯前端 concern，daemon 无主题概念；用户偏好 localStorage 持久化。文案全 key 纪律：P-1 页面所有 UI 文案走搬入的 desk 轻量 i18n（React context + localStorage 持久化 + navigator.language 检测，zh-CN/en-US 双语言包），无硬编码文案；协议 DTO 不含语言字段，中英文本传原始内容，语言选择是前端渲染 concern。

## 理由
desk 前端本就 FSD 五层，切片搬运成本最低（F-6）；desk i18n 方案已验证且轻量（~1.7k LOC，F-8）；daemon 是开发者面向、统一中文不做 i18n（AD-18）；主题注册表避免后期主题级调整侵入每个组件（Q-7 裁决）。

## 适用范围
CL-7 前端聊天流切片搬运与 P-1 页面开发；新增任何前端组件、文案、主题 token；shared/api 的 WS transport 改造。

## 反例
组件里写死「发送」二字不走 i18n key，或卡片组件内硬编码 rgb(0,255,255) 色值绕过主题变量——换主题即漏色。

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
