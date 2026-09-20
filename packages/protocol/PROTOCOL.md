# Helix WS 协议 v0.14

> **版本位单源** = `src/envelope.ts` 的 `PROTOCOL_VERSION`（本标题行由
> sot-consistency 断言①守护对齐）。本文档 = **行为契约导览**：传输、
> 握手时序、统一信封、目录指引、错误码、版本演进叙事、dev token、
> SoT 守护口径。
>
> **命令/事件 payload 形状与字段语义单源 = `src/` 的 TypeScript 类型 +
> JSDoc**（协议文档收口批，changelog/ §39）——本文档不再
> 登记 payload 形状（原 §15/§16 已退役，节号墓碑保留下文）；字段级语义
> （缺省行为、错误路径、落盘语义、版本考古）随类型定义的 JSDoc 维护，
> 与代码同 commit 同文件。
>
> **节号引用口径**：本文档中形如 §10–§14、§17.5+、§18–§39 的节号引用，
> 均指 changelog/ 目录版本文件中的**原节号**（全域保留，经 changelog/README.md 索引定位）。

> 包：`@helix/protocol`（本目录）。类型唯一权威源——daemon 与前端 shell
> 共同 import，**仓库内禁止平行手写协议类型**（AD-8 / AG-13）。设计溯源
> 见 architecture.md §6。序列化：JSON——信封即 JSON 对象，无额外序列化
> 框架。

## 1. Endpoint 与传输

| 项 | 值 |
|---|---|
| 传输 | WebSocket（daemon 侧 Bun.serve websocket 原生实现，不引入 ws npm 包） |
| 地址 | `ws://127.0.0.1:{port}`，port 取 `~/.helix/config.json` 的 `port` 字段（默认 7333；0 = 随机，启动日志输出实际监听地址） |
| 绑定 | **仅 127.0.0.1 回环**，禁止 0.0.0.0 / :: |
| 认证 | 握手 hello 携带 dev token（daemon 每次启动生成并重写 `~/.helix/dev-token`，0600）；浏览器侧获取通道见 §9 |

## 2. 握手时序（F(6).2）

```
客户端                                        daemon (ws-server)
  │ ── WS connect ws://127.0.0.1:port ─────→ │  TCP / HTTP 升级
  │ ── { v:"0.14", type:"hello",              │  校验 token（与 ~/.helix/dev-token 比对）
  │      payload:{ token,                     │  校验 protocolVersion = "0.14"
  │             protocolVersion:"0.14" } } ───→ │
  │                                           │
  │ ←─ { v:"0.14", type:"connection.welcome", │  通过：sessionId / model / agentState
  │      payload:{ sessionId, model,          │
  │               agentState } } ────────────│
  │ ←─ { v:"0.14", type:"session.snapshot",   │  随后立即推全量快照
  │      payload:{ snapshot: SessionSnapshotDto } } │
  │                                           │
  │ ←─ { v:"0.14", type:"connection.error",   │  拒绝：先发 error 帧再 close
  │      payload:{ code, message } } ────────│
```

- **重连恢复 = 快照 + 增量**（AD-16）：重连后重新握手 → 收快照重建投影 → 续增量；首连空会话 = `snapshot.entries` 为空数组。
- **草稿握手分支（T4，§14.1）**：当前会话为零条目内存草稿时 welcome 携带 `draft:true`，不 attach 不推快照；真实会话握手维持上图时序。
- **拒绝三分支**(TP-CL6-5):无 `token` 字段 → `auth.missing_token`;token 与 `~/.helix/dev-token` 不符 → `auth.invalid_token`;`protocolVersion ≠ "0.14"`（含信封 `v ≠ "0.14"`）→ `protocol.version_unsupported`。
- 客户端浏览器侧获取 dev token 的机制已由 T1.6 钉死：daemon HTTP 端点 `GET /helix-dev-token`（见 §9）。

## 3. 统一信封

```ts
// 本代码块为 packages/protocol/src/envelope.ts 现行定义的忠实呈现（F(2).2 对齐，逐项抄源）。

/** 协议版本位。v0.14 帧 `v` 恒为 "0.14"；handshake 以此协商（旧客户端 fail-fast 拒绝）。 */
export const PROTOCOL_VERSION = "0.14" as const;

/**
 * 帧版本位取值域："0.14" = 当前批（v0.14）帧；`0` = v0/v0.1 历史帧（v0.1 未
 * bump 版本位，全部历史帧与既有测试/剧本字面量为 0——信封兼容读的类型面）。
 * v0.12→v0.13 为单仓同发一步替换（Q-1c：版本位是批次集合标记非协商位），
 * 仓内无 v0.12 帧存量；v0.13→v0.14 同口径（管家工作记忆批）。
 * handshake 的 HelloPayload.protocolVersion 不取联合（严格 "0.14" 单值）。
 */
export type FrameVersion = 0 | typeof PROTOCOL_VERSION;

/** workspace 路由（AD-7 预留）：仅类型与信封字段位存在，无路由实现（见下条声明）。 */
export interface WorkspaceRoute {
  workspaceId?: string;
}

/** C→S 命令信封基型（契约 A §1.1）。具体命令信封以 `type` 字面量收窄并实例化 `payload`。 */
export interface CommandFrame<T = unknown> {
  /** 协议版本位（FrameVersion：当前批帧 "0.14"；0 = v0/v0.1 历史帧兼容读） */
  v: FrameVersion;
  /** 消息目录名（如 "chat.send" / "session.loadHistory"） */
  type: string;
  /** 消息载荷，形状由 type 决定 */
  payload: T;
  /** 会话路由位（v0.2 新增，AD-4）：会话作用域命令必填；全局命令省略；类型层可选 */
  sessionId?: string;
  /** 实例归属预留位：命令侧不消费（agentId 在 payload 内；§10.1） */
  instanceId?: string;
  /** workspace 路由预留字段：可选；v0.2 仍不消费 */
  workspace?: WorkspaceRoute;
}

/** S→C 事件信封基型（v0.2 统一事件信封，契约 A §1.2；AD-3/AD-4）。 */
export interface EventFrame<T = unknown> {
  /** 协议版本位（FrameVersion：当前批帧 "0.14"；0 = v0/v0.1 历史帧兼容读） */
  v: FrameVersion;
  /** 事件归属会话（v0.2 新增，AD-4）：S→C 运行时必发；系统事件以 SYSTEM_SESSION_ID 占位 */
  sessionId?: string;
  /** 实例归属（v0.1 起）：可选；T10 起写侧全实例显式携带（main 同为 agent-<唯一串>）；缺省 = legacy 主实例（读侧推断，兼容历史帧；§17.11 T10 批内补登） */
  instanceId?: string;
  /** 事件类型学通道（v0.2 新增，AD-3）：events.ts 字面量登记所属族 */
  channel?: Channel;
  /** 消息目录名（如 "chat.stream.delta" / "session.list_changed"） */
  type: string;
  /** 消息载荷，形状由 type 决定 */
  payload: T;
}
```

- 具体命令/事件信封（`ChatSendCommand`、`ChatStreamDeltaEvent`…）继承
  `CommandFrame<载荷>` / `EventFrame<载荷>` 并以 `type` 字面量收窄；联合
  （`CommandEnvelope` / `EventEnvelope`）即**判别式联合**——两端
  `switch(frame.type)` 直接窄化 payload，无需运行时 type-guard。
- **⚠️ workspace 预留声明（AD-7，架构 §6.4）**：`workspace` 字段与
  `WorkspaceRoute` 类型当前为**预留语义，无路由实现**——daemon 全局单例、
  workspace 是其内部分组概念；本迭代不含任何 workspaceId 校验/分发行为，
  多窗口/workspace 路由留 M3+。合法实现可忽略该字段。


## 4. 命令与事件目录（代码自证）

命令/事件全集与 payload 形状不再于本文档登记（协议文档收口批，§15/§16 退役，
见 changelog/ §39）——**目录与形状单源 = 代码**：

- 命令目录常量 `COMMAND_TYPES` + 判别联合 `CommandEnvelope`：`src/commands/`
  （按族分文件：catalog / kg / mcp / model-config / resource / session /
  task）；payload 类型化收窄的构造器同目录供出。
- 事件目录常量 `EVENT_TYPES` + 判别联合 `EventEnvelope`：`src/events/`（按族
  分文件）。每事件的通道归属以 `EVENT_CHANNELS`（`src/envelope.ts`）登记为准
  ——通道归属例外（type 前缀 ≠ channel：`auth.*` / `config.*` 结果帧挂
  model 通道、`task.changed` 挂 notification 通道）以 `EVENT_CHANNELS` 为
  非默认推断面。
- 字段级语义（缺省行为 / 错误路径 / 落盘语义 / 批次考古）= 各类型定义的 JSDoc。

行为注记（目录语义）：

- `EmptyPayload = Record<string, never>`：空载荷约定。
- 握手期专用 `hello`（`HelloCommand` / `HelloPayload`）**不在命令目录内**（见 §2）。
- **命令错误回执**：未知 type → `connection.error { code:"command.unknown" }`；
  payload 不符 → `connection.error { code:"command.invalid_payload" }`；两者均
  **不关闭连接**。
- **daemon 实现超集注记（D-4）**：`session.subscribe` 在订阅恢复时**重推全量
  `session.snapshot`**（快照恢复公式，AD-16）；`session.unsubscribe` 只关流
  不回推。行为严于「仅保通路」，属良性扩展（v0 主会话默认订阅，两命令仅保
  通路语义）。
## 6. DTO 模型（前端显示贫血模型的家，AD-17.5）

ws-server driving adapter 将 domain 充血模型转换为 wire 侧贫血 DTO（domain /
application 不感知协议；映射层对 domain 仅 type-only import，AG-12；转换只在
driving adapter 做，TR-39）。DTO 全集与字段语义 = `src/types/` 各文件的类型 +
JSDoc（协议文档收口批起不在本文档复述代码块）；wire 边界实例归属编码（主实例
省略 / legacy `"main"`）以映射实现为准。

## 7. 错误码表

> **命名风格裁决（code-review M55，D5 用户裁决 2026-09-03）**：`ErrorCode`
> 以**点分风格为基准**（`task.not_found` / `kg.review.not_eligible` 族）。
> 大写下划线风格存量码（`KG_E_PARAM` / `WORKSPACE_E_INVALID_ROOT` 等）
> 保留可用、不批量改名；**新增错误码一律点分风格**（近例：task.internal /
> daemon.internal / task.task_running）；旧码若需迁移走 alias 兼容
> （新旧码同语义并存一个版本周期后再收口）。

`ErrorCode`（connection.error.payload.code 取值全集）：

| code | 场景 | 连接处置 |
|---|---|---|
| `auth.missing_token` | 握手：无 token 字段 | 发 error 帧后 **close** |
| `auth.invalid_token` | 握手：token 与 dev-token 不符 | 发 error 帧后 **close** |
| `protocol.version_unsupported` | 握手：protocolVersion ≠ 当前版本位（"0.11"） | 发 error 帧后 **close** |
| `command.unknown` | 命令：未知 type | 发 error 帧，**连接保持** |
| `command.invalid_payload` | 命令：payload 不符 | 发 error 帧，**连接保持** |
| `task.type_unknown` | task 批（T1.5）：createTask 的 type 无对应任务 skill（T2.4 工具面同码） | 发 error 帧，**连接保持** |
| `task.validation_failed` | task 批：manifest/paramsSchema/projects 基数校验失败（message 带具体违例） | 发 error 帧，**连接保持** |
| `task.internal` | code-review M7 批：createTask 未分类内部错误（原统一改标 validation_failed 失真） | 发 error 帧，**连接保持** |
| `daemon.internal` | code-review H5 批：chat.send/steer 等非 invalid_payload 的未分类异常兜底回执（原静默丢消息） | 发 error 帧，**连接保持** |
| `task.not_found` | task 批：jobId 不存在（detail/artifacts/生命周期命令） | 发 error 帧，**连接保持** |
| `task.invalid_state` | task 批：生命周期/删除的非法当前态（判断收口引擎 T1.3，handler 透传） | 发 error 帧，**连接保持** |
| `agent.config.read_only` | agent.config.set_enabled 对系统三 kind（orchestrator / subagent-kg-writer / subagent-code-reviewer）tool/skill/mcp-server 启停的写面拒绝（编排归位批：orchestrator 归位系统 kind——仅槽位型可写；前端只读只是表现，后端拒绝才是事实） | 发 error 帧，**连接保持** |
| `WORKSPACE_E_INVALID_ROOT` | workspace 批（W1）：workspace.open root 校验失败（不存在/非目录/不可读/危险根——文件系统根或主目录） | 发 error 帧，**连接保持** |
| `WORKSPACE_E_ACTIVE_AGENT` | workspace 批（W1）：存在运行中会话/智能体时拒绝重绑（F2 裁决 v1 禁止切换） | 发 error 帧，**连接保持** |
| `workspace.unbound` | workspace 批（W1）：未绑定工作空间时的依赖面拒绝（会话创建门禁/kg 参数型读面防御） | 发 error 帧，**连接保持** |
| （连接层异常） | 非 WS 帧垃圾数据等 | 不发帧直接 close，前端走重连状态机 |

- **daemon 实现超集注记（D-3）**：daemon 握手期**同时校验**信封 `v` 与
  `hello.protocolVersion` 不等于当前版本位（"0.11"），两者均以
  `protocol.version_unsupported` 同码拒绝（实现严于本文档仅列
  `protocolVersion` 的口径，属良性收紧）。

## 8. 版本与演进

- 版本位内建（AD-9）：`v: "0.14"`（当前）；协议不兼容变更时 bump
  `PROTOCOL_VERSION` 并同步本包类型与本文档，旧版本以
  `protocol.version_unsupported` 拒绝。
- 演进登记：v0.1 additive（§10，未 bump 版本位）；v0.2 一次 bump、版本位转
  字符串（§11）；v0.3 三处 additive 可选字段扩展 + bump（§12）；
  v0.4（§13：trace.query 命令族 + agent.instantiated /
  agent.model.changed 两落盘事件 additive 登记 + 版本位 `"0.3" → "0.4"`,
  批次集合标记非协商位）；v0.5（§17.5：payload 全量回迁 §15/§16 +
  SoT 守护口径 + 版本位 `"0.4" → "0.5"`，零新增命令/事件）；v0.6（§17.6：
  agent.config 族 2 命令 + 3 事件 additive + 版本位 `"0.5" → "0.6"`）；
  v0.7（§17.7：web 族 2 命令 + 3 事件 additive + 版本位
  `"0.6" → "0.7"`）；v0.8（§17.8：agent.config 读面 skills/
  diagnostics 的 source 字面量联合扩 builtin——零新增命令/事件 + 版本位
  `"0.7" → "0.8"`）；v0.9（§17.9：web 族 web.start 命令 +
  web.start.result 事件 additive + 版本位 `"0.8" → "0.9"`）；v0.10（§17.10：
  图片上下行 additive——chat.send.images + MessageEntryDto/
  ToolCallEntryDto.images 三可选字段，零新增命令/事件 + 版本位
  `"0.9" → "0.10"`）；v0.11（§17.11：thinking 批 additive 四块
  ——`thinking.set`/`thinking.changed` 命令族 + CatalogModel 能力位 +
  快照/`agent.instantiated`/`agent.config` thinking 槽位 additive + 版本位
  `"0.10" → "0.11"`）；P1 会话模式微批（§18：模式注册表 modes.ts 新模块 +
  `chat.send`/`connection.welcome`/`session.snapshot` 三处可选 mode 字段
  additive——零新增命令/事件，版本位不 bump，§14 微批同构先例）。
v0.12（CHANGELOG §17.12：
  占用协调批 U5/U6——版本位 `"0.11" → "0.12"`，单仓同发一步替换）；
v0.13（CHANGELOG changelog/v0.13.md §17.13：文本管家批 V2.5——steward 族
  六命令 + 四事件 additive（新 Channel 值 "steward"），版本位 `"0.12" → "0.13"`，
  `FrameVersion = 0 | "0.13"`，单仓同发一步替换）；**协议文档收口批**（CHANGELOG §39：PROTOCOL.md §15/§16
  退役、SoT 收敛至类型 + JSDoc、sot-consistency 断言族重构——零协议形状变更，
  版本位不 bump）；
v0.14（CHANGELOG changelog/v0.14.md §17.17：管家工作记忆批 A1——steward.history
  命令 + history.result/tool/thinking 三事件 additive，版本位 `"0.13" → "0.14"`，
  单仓同发一步替换）；
- v0 语义边界：workspace 路由**仅类型预留**（§3）；`session.subscribe` /
  `session.unsubscribe` 仅保通路语义（v0 主会话默认订阅）。
- 前端重连语义（状态机转换规则 = 契约，节奏实现自定）：断线 → 自动重连
  （指数退避）→ 重新握手 → 收快照重建投影 → 续增量（前端零权威状态，AD-16）。

## 9. dev token 浏览器侧获取（T1.6 定稿，架构 §10-1 缺口回填）

浏览器无法直接读文件 `<home>/dev-token`，获取通道统一为 daemon HTTP 端点：

```
GET http://127.0.0.1:{port}/helix-dev-token
→ 200 text/plain，响应体即 token（与 <home>/dev-token 文件内容一致）
```

处置规则（服务端已实现，TP-CL6 系列测试守护）：

- **无 Origin 头**（curl / 本地进程 / Node 客户端）→ 200 直接返回；
- **loopback 开发 Origin**（`http://localhost:*` / `http://127.0.0.1:*` / `http://[::1]:*`，
  即 vite dev 等）→ 200 且反射 `Access-Control-Allow-Origin: <origin>`；
- **应用自有资产协议源**（W6m 增：`tauri://localhost`〔macOS/Linux 打包〕与
  `http(s)://tauri.localhost`〔Windows 打包〕——该协议/主机仅本应用 webview 可用，
  信任级不低于 loopback http）→ 同反射放行；
- **其他 Origin**（任意外部站点）→ 403（防恶意网页窃取 token 接管本机 agent）。

两种前端形态共用同一机制（AG-13 同源基线的自然延伸）：

| 形态 | token 获取 | 前端资源来源 |
|---|---|---|
| vite dev（开发期） | `fetch("http://127.0.0.1:{port}/helix-dev-token")`（跨端口 fetch，ACAO 反射放行） | vite dev server |
| static-serve（生产形态） | 同一端点（同源 fetch，无 CORS 问题） | daemon `staticDir` 构建产物 |
| tauri bundle（打包桌面形态，W6m 登记） | 同一端点（跨源 fetch，ACAO 反射放行——`tauri://localhost` / `http(s)://tauri.localhost`） | tauri 资产协议（frontendDist 随 .app/.exe 内嵌） |

选型说明：契约草案曾以「vite dev 插件读文件注入 env」为首选，T1.6 落地时定稿为
**daemon 端点方案**——两种形态同一通路、零 vite 侧插件代码、生产/开发行为一致；
WS 连接本身不受 CORS 约束（浏览器允许跨源 WS），仅 token 的 HTTP 获取需上述
Origin 规则。v0 不做 token 过期/轮换通知（daemon 重启 = token 重写，前端握手
失败即重新拉取）。

> **§10–§14（v0.1–v0.4 演进登记与微批备案）已迁 changelog/（v0-v0.4.md）**
>（原节号保留——下文节号自 §9 直接跳至 §15 即此迁移痕迹，非缺节）。


## 15. 命令 payload 形状总登记（已退役）

> 协议文档收口批（changelog/ §39）退役：payload 形状与字段语义
> 单源收敛至 `src/commands/` / `src/types/` 的类型 + JSDoc。本节号保留为
> **墓碑**（防历史引用悬空）——历史登记内容见 CHANGELOG 各批次节；存量文档
> 引用「PROTOCOL.md §15.x」请改指源码类型或 CHANGELOG 对应节。

## 16. 事件 payload 形状总登记（已退役）

> 同 §15（协议文档收口批退役）；事件形状与通道归属单源 = `src/events/` +
> `EVENT_CHANNELS`。
## 17. SoT 声明与守护口径（协议文档收口批重构）

### 17.1 SoT 声明

**协议契约的形状与字段语义唯一事实源 = `packages/protocol/src` 的 TypeScript
类型 + JSDoc**（AD-8 / AG-13：daemon 与 shell 双端同源 import，仓内禁止平行
手写协议类型）。本文档不再登记命令/事件 payload 形状（原 §15/§16 已退役，
节号墓碑保留）——职责收窄为**行为契约导览**（传输 / 握手时序 / 信封 / 错误
回执语义 / 版本演进叙事 / 守护口径）。字段级语义（缺省行为、错误路径、落盘
语义、版本考古）随类型定义的 JSDoc 维护，与代码同 commit 同文件（原 §17.1
「本文档是唯一事实源」的声明自本批起翻转）。

### 17.2 登记纪律（协议文档收口批修订）

- **原① payload 形状正文登记律：废除**（§15/§16 登记面退役）。新增 / 变更
  命令·事件·payload 字段只须改类型（含 JSDoc 同 commit）并在
  changelog/ 当前版本文件落批次节（分配规则见 changelog/README.md）——无文档登记步。
- **② 版本位单点律（保留）**：`PROTOCOL_VERSION` 唯一定义于
  `packages/protocol/src/envelope.ts`；任何脚本 / 文档 / 测试引用版本一律从
  单点读或由断言①守护，禁止手写字面量。
- **③ 结果帧登记单轨律（保留）**：新增命令结果帧一律入 `EVENT_TYPES` /
  `EventEnvelope` 主轨；task 族十结果帧与 `diff.get.result` 的窄化接口轨为
  已登记历史例外，不得效仿扩展。

### 17.3 sot-consistency 断言口径（协议文档收口批重构：①⑥ 保留，②③④⑤ 退役）

1. **① 版本位一致（保留）**：本文档标题行与 §3 代码块中的版本字面量 ==
   `PROTOCOL_VERSION` 导出值（防版本字面量漂移复发）。
2. **⑥ 文件职责守护（目录化）**：changelog/ 目录含 v*.md 版本文件且当前
   版本位对应文件在位（版本 bump 须开新文件）；`## N.` 批次节号**全域连续
   无跳号且不得重复**（{10..14} ∪ {18..max}，§40+ 开放顺延；重复即红——
   set 去重盲区事故实证后补）；§15–§17 的 ## 级节号为
   本文档保留域（changelog/ 内出现即红——域分离）；
   本文档节号白名单 `{1–9, 15, 16, 17}` 与实际节标题**双向恰等**（白名单外
   节号出现即红——任何未来批次节写回现行文件即红；白名单内节号缺失亦红
   ——节号漂移即红）；`### 17.x` 小节只许 17.1–17.4。

原断言②③④⑤（类型 presence / 计数一致 / additive 字段 presence / 通道归属）
随 §15/§16 登记面退役而退役——守护对象消失；接管面 = typecheck（字段与形状
即契约，前端消费编译期即红）+ exports.test + arch-guard（目录/导出结构守护）。

### 17.4 生成式基建边界（保留，边界随收口消解）

字段级逐形状 diff（文档表 ↔ TS 接口全字段等价比较）属生成式文档工具
（AD-4 选项 C），已裁决转池不做；本批收口后文档不再承载形状复述，守护面
收窄为断言① + ⑥——该生成式需求的前提（文档承载形状）不复存在。

> **§17.5 起的批次登记（v0.5–v0.12）与 §18–§39 additive 微批备案均在
> changelog/ 目录**（原节号全域保留；§17.4 为本节末尾）。登记纪律
> （批次备案同 commit 落 CHANGELOG）见 §17.2。
