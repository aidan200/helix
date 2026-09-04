# Helix WS 协议 v0.11

> 当前版本位 `PROTOCOL_VERSION = "0.11"`（envelope.ts）。本文档 = **现行
> 契约**：§1–§9 基线 + §15/§16 命令事件全集（61 命令 / 78 事件 payload
> 形状，以 §15/§16 计数声明行为准）+ §17.1–§17.4 SoT 守护口径。
> **批次演进备案已分离**：§10–§14（v0.1–v0.4 演进登记）、§17.5–§17.11
>（v0.5–v0.11 批次登记，含当前批 v0.11）、§18–§23（v0.11 后 additive
> 微批）见 **PROTOCOL-CHANGELOG.md**（protocol-split 批迁出）。
>
> **节号映射声明**：本文档中形如 §10–§14、§17.5+、§17.11、§18–§23 的
> 节号引用，均指 PROTOCOL-CHANGELOG.md 中的**原节号**（迁移原样保留，
> 未重排）；§15/§16 字段表「登记版本」列的节号引用同此口径。

> 包：`@helix/protocol`（本目录）。类型唯一权威源——daemon（T1.6）与前端
> shell（T1.7）共同 import，**仓库内禁止平行手写协议类型**（AD-8 / AG-13）。
> 依据：architecture.md §6 + 集成契约 `contracts/ws-protocol-v0.md`；
> 命名定稿：T1.2（契约 §9 回填记录）。
> 序列化：JSON——信封即 JSON 对象，无额外序列化框架。

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
  │ ── { v:"0.11", type:"hello",              │  校验 token（与 ~/.helix/dev-token 比对）
  │      payload:{ token,                     │  校验 protocolVersion = "0.11"
  │             protocolVersion:"0.11" } } ───→ │
  │                                           │
  │ ←─ { v:"0.11", type:"connection.welcome", │  通过：sessionId / model / agentState
  │      payload:{ sessionId, model,          │
  │               agentState } } ────────────│
  │ ←─ { v:"0.11", type:"session.snapshot",   │  随后立即推全量快照
  │      payload:{ snapshot: SessionSnapshotDto } } │
  │                                           │
  │ ←─ { v:"0.11", type:"connection.error",   │  拒绝：先发 error 帧再 close
  │      payload:{ code, message } } ────────│
```

- **重连恢复 = 快照 + 增量**（AD-16）：重连后重新握手 → 收快照重建投影 → 续增量；首连空会话 = `snapshot.entries` 为空数组。
- **草稿握手分支（T4，§14.1）**：当前会话为零条目内存草稿时 welcome 携带 `draft:true`，不 attach 不推快照；真实会话握手维持上图时序。
- **拒绝三分支**(TP-CL6-5):无 `token` 字段 → `auth.missing_token`;token 与 `~/.helix/dev-token` 不符 → `auth.invalid_token`;`protocolVersion ≠ "0.11"`（含信封 `v ≠ "0.11"`）→ `protocol.version_unsupported`。
- 客户端浏览器侧获取 dev token 的机制已由 T1.6 钉死：daemon HTTP 端点 `GET /helix-dev-token`（见 §9）。

## 3. 统一信封

```ts
// 本代码块为 packages/protocol/src/envelope.ts 现行定义的忠实呈现（F(2).2 对齐，逐项抄源）。

/** 协议版本位。v0.11 帧 `v` 恒为 "0.11"；handshake 以此协商（旧客户端 fail-fast 拒绝）。 */
export const PROTOCOL_VERSION = "0.11" as const;

/**
 * 帧版本位取值域："0.11" = 当前批（v0.11）帧；`0` = v0/v0.1 历史帧（信封兼容读
 * 的类型面）。handshake 的 HelloPayload.protocolVersion 不取联合（严格 "0.11" 单值）。
 */
export type FrameVersion = 0 | typeof PROTOCOL_VERSION;

/** workspace 路由（AD-7 预留）：仅类型与信封字段位存在，无路由实现（见下条声明）。 */
export interface WorkspaceRoute {
  workspaceId?: string;
}

/** C→S 命令信封基型（契约 A §1.1）。具体命令信封以 `type` 字面量收窄并实例化 `payload`。 */
export interface CommandFrame<T = unknown> {
  /** 协议版本位（FrameVersion：当前批帧 "0.11"；0 = v0/v0.1 历史帧兼容读） */
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
  /** 协议版本位（FrameVersion：当前批帧 "0.11"；0 = v0/v0.1 历史帧兼容读） */
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

## 4. 命令目录（C→S，5 个）

| type | payload 类型 | payload | 语义（daemon 侧去向） |
|---|---|---|---|
| `chat.send` | `ChatSendPayload` | `{ text: string }` | 发送用户消息（新输入）→ ChatPort.sendMessage |
| `chat.steer` | `ChatSteerPayload` | `{ text: string }` | 生成中注入消息 → ChatPort.steer → SteerQueue.enqueue |
| `chat.abort` | `EmptyPayload` | `{}` | 中断当前生成 → ChatPort.abort |
| `session.subscribe` | `EmptyPayload` | `{}` | 订阅事件流（v0 主会话默认订阅，仅保通路语义） |
| `session.unsubscribe` | `EmptyPayload` | `{}` | 退订事件流（同上） |

- `EmptyPayload = Record<string, never>`：空载荷约定（T1.2 定稿，回填契约 §9）。
- 联合类型 `CommandEnvelope`；目录常量 `COMMAND_TYPES`（与联合一致性由测试守护）。
- 握手期专用 `hello`（`HelloCommand` / `HelloPayload`）**不在命令目录内**，见 §2。
- **命令错误回执**：未知 type → `connection.error { code:"command.unknown" }`；payload 不符 → `connection.error { code:"command.invalid_payload" }`；两者均**不关闭连接**。
- **daemon 实现超集注记（D-4）**：`session.subscribe` 的 daemon 实现会在订阅恢复时**重推全量 `session.snapshot`**（快照恢复公式，AD-16）；`session.unsubscribe` 只关流不回推。行为严于「仅保通路」，属良性扩展。

## 5. 事件目录（S→C，12 个）

| type | payload 类型 | payload | 语义 |
|---|---|---|---|
| `connection.welcome` | `ConnectionWelcomePayload` | `{ sessionId, model, agentState }` | 握手通过回执 |
| `connection.error` | `ConnectionErrorPayload` | `{ code, message }` | 握手拒绝 / 命令错误回执 |
| `session.snapshot` | `SessionSnapshotPayload` | `{ snapshot: SessionSnapshotDto }` | 全量快照（握手后/重连后） |
| `chat.stream.delta` | `ChatStreamDeltaPayload` | `{ messageId, delta }` | 流式增量（中间态，**不落盘**，AD-16） |
| `chat.turn.started` | `ChatTurnStartedPayload` | `{ turnId }` | 轮次里程碑（落盘事件） |
| `chat.turn.completed` | `ChatTurnCompletedPayload` | `{ turnId, reason: "completed"\|"aborted" }` | 轮次结束 |
| `chat.message.completed` | `ChatMessageCompletedPayload` | `{ entry: EntryDto }` | 一条消息完成（落盘事件；kind=message 且含最终 content） |
| `steer.queued` | `SteerQueuedPayload` | `{ entryId, source? }` | 消息入 steer 队列（前端徽标「STEER·已入队」依据） |
| `steer.drained` | `SteerDrainedPayload` | `{ entryId, source? }` | turn 边界 drain 注入（徽标转「已注入·本轮结束」依据） |
| `tool.call.started` | `ToolCallStartedPayload` | `{ entry: EntryDto }` | 工具调用开始（tool-call 变体，state="running"） |
| `tool.call.result` | `ToolCallResultPayload` | `{ entry: EntryDto }` | 工具调用结果（tool-call 变体，state="done"\|"error"，含 result 与 durationMs） |
| `agent.state.changed` | `AgentStateChangedPayload` | `{ state: AgentStateDto }` | agent 生命周期状态变更 |

- 联合类型 `EventEnvelope`；目录常量 `EVENT_TYPES`（与联合一致性由测试守护）。
- `steer.queued` / `steer.drained` 为细化阶段自 review.md steer 徽标两态反推补充（架构 §6.3 目录未列，T1.2 定稿纳入，见集成契约 §5 注记）。

## 6. DTO 模型（前端显示贫血模型的家，AD-17.5）

字段形状与 review.md 原型 mock 载体对齐（role / content / ts / 工具调用
{name, args, result, state, duration}）——ws-server adapter 将 domain 充血
模型转换为本节贫血 DTO。

```ts
export type AgentStateDto = "idle" | "running" | "steering" | "aborting" | "stopped";

export interface SessionSnapshotDto {
  sessionId: string;
  model: string;        // 展示用（P-1 header 模型徽标；来自 config.json model）
  agentState: AgentStateDto;
  revision: number;     // 增量基线序号（快照之后的增量事件续接）
  entries: EntryDto[];  // 时间顺序排列
}

// 会话条目：判别式联合，按 kind 窄化
export type EntryDto = MessageEntryDto | ToolCallEntryDto;

export interface MessageEntryDto {
  kind: "message";
  id: string;
  role: "user" | "assistant";
  content: string;          // 最终内容（流式中间态走 chat.stream.delta）
  ts: number;               // epoch 毫秒（T1.2 定稿，回填契约 §9）
  steerState?: "queued" | "drained";  // 仅 chat.steer 产生的用户消息携带
  source?: "user" | "closure" | "progress";  // v0.11 批内补登（T11a）：注入来源；仅注入类 user 消息携带，缺省 = 用户输入
  images?: readonly string[];  // v0.10（T9）：图片附件 base64 data URL 数组；仅 user 消息携带（assistant 不产图）；缺省 = 纯文本旧形态
  turnId?: string;          // 所属轮次 id（additive，轮末 token 用量显示面）：主线条目携带；SubAgent/恢复注入（turnId=null）不携带
}

export interface ToolCallEntryDto {
  kind: "tool-call";
  id: string;
  name: string;
  args: string;             // JSON 序列化字符串
  result?: string;          // state=done|error 时存在
  state: "running" | "done" | "error";
  durationMs?: number;      // state=done|error 时存在
  ts: number;               // epoch 毫秒
  images?: readonly string[];  // v0.10（T9）：工具结果附带图片（如 browser 截图）base64 data URL 数组；缺省 = 无图旧形态
}
```

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
| `agent.config.read_only` | agent-roster 批：agent.config.set_enabled 对只读系统派生 kind（orchestrator / subagent-kg-writer）的写面拒绝（前端只读只是表现，后端拒绝才是事实） | 发 error 帧，**连接保持** |
| `WORKSPACE_E_INVALID_ROOT` | workspace 批（W1）：workspace.open root 校验失败（不存在/非目录/不可读/危险根——文件系统根或主目录） | 发 error 帧，**连接保持** |
| `WORKSPACE_E_ACTIVE_AGENT` | workspace 批（W1）：存在运行中会话/智能体时拒绝重绑（F2 裁决 v1 禁止切换） | 发 error 帧，**连接保持** |
| `workspace.unbound` | workspace 批（W1）：未绑定工作空间时的依赖面拒绝（会话创建门禁/kg 参数型读面防御） | 发 error 帧，**连接保持** |
| （连接层异常） | 非 WS 帧垃圾数据等 | 不发帧直接 close，前端走重连状态机 |

- **daemon 实现超集注记（D-3）**：daemon 握手期**同时校验**信封 `v` 与
  `hello.protocolVersion` 不等于当前版本位（"0.11"），两者均以
  `protocol.version_unsupported` 同码拒绝（实现严于本文档仅列
  `protocolVersion` 的口径，属良性收紧）。

## 8. 版本与演进

- 版本位内建（AD-9）：`v: "0.11"`（当前）；协议不兼容变更时 bump
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
  `"0.7" → "0.8"`）；**v0.9 = 当前**（§17.9：web 族 web.start 命令 +
  web.start.result 事件 additive + 版本位 `"0.8" → "0.9"`）；v0.10（§17.10：
  图片上下行 additive——chat.send.images + MessageEntryDto/
  ToolCallEntryDto.images 三可选字段，零新增命令/事件 + 版本位
  `"0.9" → "0.10"`）；**v0.11 = 当前**（§17.11：thinking 批 additive 四块
  ——`thinking.set`/`thinking.changed` 命令族 + CatalogModel 能力位 +
  快照/`agent.instantiated`/`agent.config` thinking 槽位 additive + 版本位
  `"0.10" → "0.11"`）；P1 会话模式微批（§18：模式注册表 modes.ts 新模块 +
  `chat.send`/`connection.welcome`/`session.snapshot` 三处可选 mode 字段
  additive——零新增命令/事件，版本位不 bump，§14 微批同构先例）。
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

> **§10–§14（v0.1–v0.4 演进登记与微批备案）已迁 PROTOCOL-CHANGELOG.md**
>（原节号保留——下文节号自 §9 直接跳至 §15 即此迁移痕迹，非缺节）。

## 15. 命令 payload 形状总登记（C→S，61 命令全集）

> **计数声明：61 命令全集**（15.1 chat 3 + 15.2 session 5 + 15.3 agent 6 +
> 15.4 model 7 + config 2 + 15.5 auth 4 + 15.6 trace 1 + 15.7 web 3 + 15.8 thinking 1 +
> 15.9 kg 6+5+2+1+1+1+1 + 15.10 workspace 2 + 15.11 task 10）——与 `COMMAND_TYPES` 常量恰等
>（守护断言③口径）。本节为命令 payload 形状的**唯一正文登记面**（TR-AD-26①；
> AD-4 选项 B 全量回迁收口），类型权威源 = `packages/protocol/src/commands.ts`，
> 文档与其逐项对齐（AD-1）；仓外契约文档降为历史定形档案（§17.1）。
>
> 登记锚格式：每命令一个 `#### \`<type>\`` 锚 + payload 字段表
>（字段 / 类型 / 可选性 / 登记版本 / 语义）。空载荷命令（`EmptyPayload =
> Record<string, never>`）以「（无字段）」一行明示。引用 DTO 定义指针：§6
> （EntryDto / AgentStateDto / SessionSnapshotDto）、§10.4（ClosureDto）、
> §10.5（ThinkingEntryDto / CompactionEntryDto / UsageDto / AgentInstanceDto）、
> §13.2（TraceEventRow / TraceInstanceRecord / TraceProfileSnapshot /
> TraceQueryFilterEcho）；`SessionMeta` / `AuthProviderInfo` / `CatalogModel` /
> `TraceTimeRange` / `TraceQueryPageInput` 定义于 `src/types/`（session / auth /
> model / trace.ts），形状字段行内联要点。信封公共字段（v / sessionId /
> instanceId / workspace）见 §3，不逐条重复。

### 15.1 chat 族（3）

#### `chat.send`

发送用户消息（新输入 → ChatPort.sendMessage）。路由：会话作用域命令，信封
sessionId 必填（`draft:true` 建会话链省略）；无专属结果帧，回执走 chat 事件流。

| 字段 | 类型 | 可选性 | 登记版本 | 语义 |
|---|---|---|---|---|
| `text` | `string` | 必填 | v0 | 用户消息文本 |
| `draft` | `boolean` | 可选 | v0.2 引入 / v0.5 定形登记（§14.3） | 草稿建会话标记：true 且信封 sessionId 省略 → daemon 新建会话聚合落库（首条用户消息即建会话）；sessionId 携带时忽略；缺省 = 既有会话内发送 |
| `model` | `string` | 可选 | v0.5 定形登记（§14.2） | 建会话模型：仅 `draft:true` 链消费（用户建会话前选定的模型，失败降级全局默认不阻断）；缺省 = 全局默认（不换模） |
| `mode` | `string` | 可选 | P1 会话模式微批（§18） | 建会话模式：仅 `draft:true` 链消费（草稿态唯一设置入口；建会话定格锁定，无 `mode.set` 命令——锁定 = 结构不可能非校验拒绝）；字符串透传（未知 mode 由 daemon 注册表 fallback `"default"`）；缺省 = `"default"`（旧客户端兼容） |
| `images` | `readonly string[]` | 可选 | v0.10（T9 图片上行） | 图片附件：base64 data URL 数组（`data:image/png;base64,…`，自包含免文件服务）；≤4 张、单张解码后 ≤2MB（超限 daemon 回中文错误不落消息）；daemon 解码后转 ImageContent[] 交引擎（`agent.prompt(input, images)`）；缺省 = 纯文本发送（additive） |

#### `chat.steer`

生成中注入消息（ChatPort.steer → SteerQueue.enqueue）。路由：信封 sessionId
必填。回执：`steer.queued` / `steer.drained` 事件；目标实例非运行中 →
`connection.error{code:"command.invalid_payload"}`（不落 Entry 不入队）。

| 字段 | 类型 | 可选性 | 登记版本 | 语义 |
|---|---|---|---|---|
| `text` | `string` | 必填 | v0 | 注入消息文本 |
| `instanceId` | `string` | 可选 | v0.3 | 目标实例（定向寻址，路由归 ChatService）；缺省 = 主实例（命令侧缺省路由：T10 起按 main kind 判别，非字面 "main"） |

#### `chat.abort`

中断当前生成（ChatPort.abort）。路由：信封 sessionId 必填。

| 字段 | 类型 | 可选性 | 登记版本 | 语义 |
|---|---|---|---|---|
| （无字段） | `EmptyPayload` | — | v0 | 空载荷 |

### 15.2 session 族（5）

#### `session.subscribe`

订阅会话事件流（v0.2 起按会话订阅：连接只收该会话 + 系统级事件帧；v0.3
起可携带 tier 档位，重复 subscribe 换 tier = 幂等更新）。路由：信封
sessionId **必填**。回执：daemon 重推该会话全量 `session.snapshot`（快照恢复
公式，§4 D-4）。

| 字段 | 类型 | 可选性 | 登记版本 | 语义 |
|---|---|---|---|---|
| `tier` | `"full" \| "monitor"` | 可选 | v0.3 | 订阅档位：full = 全量（缺省）；monitor = 3 事件白名单（chat.turn.started / chat.turn.completed / chat.message.completed） |

#### `session.unsubscribe`

退订会话事件流（只关流不回推）。路由：信封 sessionId 必填。

| 字段 | 类型 | 可选性 | 登记版本 | 语义 |
|---|---|---|---|---|
| （无字段） | `EmptyPayload` | — | v0 | 空载荷 |

#### `session.list`

会话清单查询。路由：全局命令（信封 sessionId 省略）。结果帧：
`session.list.result`（点对点，§16.2）。

| 字段 | 类型 | 可选性 | 登记版本 | 语义 |
|---|---|---|---|---|
| （无字段） | `EmptyPayload` | — | v0.2 | 空载荷 |

#### `session.loadHistory`

分页历史回溯（AD-1）：返回 beforeEntryId 之前的更早历史（时间升序）。
路由：信封 sessionId **必填**。结果帧：`session.loadHistory.result`
（点对点，§16.2）。

| 字段 | 类型 | 可选性 | 登记版本 | 语义 |
|---|---|---|---|---|
| `beforeEntryId` | `string` | 必填 | v0.2 | 游标：当前最早 entry id；首页 = 尾窗最早 entry id（快照 DTO 下发） |
| `limit` | `number` | 可选 | v0.2 | 缺省 50（分页大小），上限 200（防滥用） |

#### `session.delete`

删除会话（payload 空，路由位在信封；daemon 顺序：取消全部执行 → 删库 →
注册表移除 → 广播 `session.list_changed{deleted}`）。路由：信封 sessionId
**必填**。

| 字段 | 类型 | 可选性 | 登记版本 | 语义 |
|---|---|---|---|---|
| （无字段） | `EmptyPayload` | — | v0.2 | 空载荷（目标会话在信封 sessionId） |

### 15.3 agent 族（6）

#### `agent.kill`

用户终止实例（抽屉 kill 两步确认后发送）。正常路径回执 `agent.killed`
事件（单一终态）；目标不存在 / 已终态 → `connection.error` 回执。

| 字段 | 类型 | 可选性 | 登记版本 | 语义 |
|---|---|---|---|---|
| `agentId` | `string` | 必填 | v0.1 | 目标实例 id（instanceId ≡ agentId 同一标识空间，§10.1） |

#### `agent.subscribe`

订阅实例全流（v0.1 通路语义：订阅表 + 全广播，不做事件过滤，§10.6-①）。

| 字段 | 类型 | 可选性 | 登记版本 | 语义 |
|---|---|---|---|---|
| `agentId` | `string` | 必填 | v0.1 | 目标实例 id |

#### `agent.unsubscribe`

退订实例全流（v0.1 通路语义）。

| 字段 | 类型 | 可选性 | 登记版本 | 语义 |
|---|---|---|---|---|
| `agentId` | `string` | 必填 | v0.1 | 目标实例 id |

#### `agent.config.list`

资源配置读面（v0.6，M6 智能体配置页：profile kind 维三类资源——tool/skill
启停差异行 + model 槽位）。路由：全局命令（信封 sessionId 省略）。结果帧：
`agent.config.list.result`（点对点，§16.4）。缺省无记录 = 启用（零配置兼容
现状，存量零迁移）。

| 字段 | 类型 | 可选性 | 登记版本 | 语义 |
|---|---|---|---|---|
| `profileKind` | `"main-session" \| "subagent-worker"` | 可选 | v0.6 | 目标 kind：缺省 = 全部 kind（双块，main-session 在前序固定）；携带 = 单块 |

#### `agent.config.set_enabled`

资源启停写面（v0.6）。路由：全局命令。回执：`agent.config.set_enabled.result`
点对点（点对点，§16.4）+ applied 时 `agent.config.changed` 广播（§16.4，
deamon 级全局——信封 sessionId = SYSTEM_SESSION_ID）。model 型语义 = 槽位
set/clear：enabled=true 设 name 为槽位模型（先经合并目录校验，目录外 →
skipped reason=unknown-model）；enabled=false 清槽（name 忽略）。tool/skill
名在全集外 → skipped reason=unknown-name（不落库）。

只读 kind 写面拒绝（agent-roster 批）：profileKind 携带只读系统派生 kind
（`"orchestrator"` / `"subagent-kg-writer"`）→ `connection.error { code:
"agent.config.read_only" }`（连接保持）——系统派生形态无用户可写面，硬层
拒绝不依赖前端表现；其余未知 kind 仍 `command.invalid_payload`。

| 字段 | 类型 | 可选性 | 登记版本 | 语义 |
|---|---|---|---|---|
| `profileKind` | `"main-session" \| "subagent-worker"` | 必填 | v0.6 | 目标 kind |
| `resourceType` | `"tool" \| "skill" \| "model" \| "thinking"` | 必填 | v0.6 | 资源类型（model/thinking = 槽位语义非启停；thinking = v0.11 批内补登 T1.3：槽位语义同 model，set/clear，零档位校验） |
| `name` | `string` | 必填 | v0.6 | 资源名（model/thinking 型 = "provider/model-id" / 档位字符串；clear 时忽略） |
| `enabled` | `boolean` | 必填 | v0.6 | tool/skill = 启停；model = set（true）/ clear（false）槽位 |

#### `agent.base_prompt.get`

base 段系统提示词读面（base prompt 批；agent 页「查看 base 提示词」入口）。
路由：全局命令（信封 sessionId 省略）。结果帧：`agent.base_prompt.get.result`
（点对点，§16.4）。base 段 = profile 静态声明 prompt（系统提示三段组装的
第①段，无工具/技能清单——动态两段由 SystemPromptAssembler 运行期拼入，
不在本读面）；静态不随 toggle 变化，故为独立懒查询（不并入
`agent.config.list.result`，避免 changed 重拉携带大文本）。系统派生两
kind 同可读（写面只读≠读面拒绝；kg-writer = SUBAGENT base + 图谱产出型
后缀，profile 声明单源）。

| 字段 | 类型 | 可选性 | 登记版本 | 语义 |
|---|---|---|---|---|
| `profileKind` | `"main-session" \| "subagent-worker" \| "orchestrator" \| "subagent-kg-writer"` | 必填 | v0.11 | 目标 kind（四值全可读） |

### 15.4 model + config 族（9）

#### `model.set`

运行期切换模型（per-session，下一 turn 生效）。路由：信封 sessionId **必填**。
回执：`model.changed` 广播（§16.6）。

| 字段 | 类型 | 可选性 | 登记版本 | 语义 |
|---|---|---|---|---|
| `model` | `string` | 必填 | v0.2 | "provider/model-id" 完整 id |

#### `model.get`

查询会话当前模型与全局默认关系。路由：信封 sessionId **必填**。结果帧：
`model.get.result`（点对点，§16.6）。

| 字段 | 类型 | 可选性 | 登记版本 | 语义 |
|---|---|---|---|---|
| （无字段） | `EmptyPayload` | — | v0.2 | 空载荷 |

#### `model.catalog`

合并模型目录查询（4h 缓存口径）。路由：全局命令。结果帧：
`model.catalog.result`（点对点，§16.6）。

| 字段 | 类型 | 可选性 | 登记版本 | 语义 |
|---|---|---|---|---|
| （无字段） | `EmptyPayload` | — | v0.2 | 空载荷 |

#### `model.catalog_refresh`

绕过 4h 缓存强制拉远端目录（失败降级 builtin，结果含 degraded 明细）。
路由：全局命令。结果帧：`model.catalog_refresh.result`（点对点，§16.6）。

| 字段 | 类型 | 可选性 | 登记版本 | 语义 |
|---|---|---|---|---|
| （无字段） | `EmptyPayload` | — | v0.2 | 空载荷 |

#### `model.set_default`

设置全局默认模型（SQLite 读面）。路由：全局命令（无信封 sessionId）。
结果帧：`model.set_default.result`（点对点，§16.6）。

| 字段 | 类型 | 可选性 | 登记版本 | 语义 |
|---|---|---|---|---|
| `model` | `string` | 必填 | v0.2 | "provider/model-id" 完整 id |

#### `model.get_default`

查询全局默认模型。路由：全局命令。结果帧：`model.get_default.result`
（点对点，§16.6）。

| 字段 | 类型 | 可选性 | 登记版本 | 语义 |
|---|---|---|---|---|
| （无字段） | `EmptyPayload` | — | v0.2 | 空载荷 |

#### `model.set_thinking_default`

设置全局默认推理强度（R7 全局兜底批：与 model.set_default 同构，SQLite
读面）。路由：全局命令（无信封 sessionId）。结果帧：
`model.set_thinking_default.result`（点对点，§16.6）。档位字符串透传
（AD-2，SoT 在 pi-ai）；`null` = 清除（回退未配置态——各 agent 未配槽位
→ 默认关）。

| 字段 | 类型 | 可选性 | 登记版本 | 语义 |
|---|---|---|---|---|
| `level` | `string \| null` | 必填 | R7 | 档位字符串（透传）或 null（清除） |

#### `config.set_compaction`

设置压缩参数（token 绝对值；SQLite KV 单键 JSON）。路由：全局命令（无信封
sessionId）。结果帧：`config.set_compaction.result`（点对点，§16.6）。

| 字段 | 类型 | 可选性 | 登记版本 | 语义 |
|---|---|---|---|---|
| `reserveTokens` | `number` | 必填 | config | 压缩预留余量（contextTokens > contextWindow - reserveTokens 触发） |
| `keepRecentTokens` | `number` | 必填 | config | 压缩后保留的最近 token 数（尾部保留窗） |

#### `config.get_compaction`

查询压缩参数。路由：全局命令。结果帧：`config.get_compaction.result`
（点对点，§16.6）。

| 字段 | 类型 | 可选性 | 登记版本 | 语义 |
|---|---|---|---|---|
| （无字段） | `EmptyPayload` | — | config | 空载荷 |

### 15.5 auth 族（4）

#### `auth.list`

provider 全集 × 凭据状态查询（脱敏）。路由：全局命令。结果帧：
`auth.list.result`（点对点，§16.6）。

| 字段 | 类型 | 可选性 | 登记版本 | 语义 |
|---|---|---|---|---|
| （无字段） | `EmptyPayload` | — | v0.2 | 空载荷 |

#### `auth.set_key`

录入 provider API key（daemon 写 `~/.helix/auth.json`，0600 + 文件锁）。
路由：全局命令。结果帧：`auth.set_key.result`（点对点，§16.6）。

| 字段 | 类型 | 可选性 | 登记版本 | 语义 |
|---|---|---|---|---|
| `providerId` | `string` | 必填 | v0.2 | provider 标识 |
| `apiKey` | `string` | 必填 | v0.2 | 明文 key（空串 = 协议层 `command.invalid_payload` 拒绝） |

#### `auth.delete_key`

删除 provider 凭据。路由：全局命令。结果帧：`auth.delete_key.result`
（点对点，§16.6）。

| 字段 | 类型 | 可选性 | 登记版本 | 语义 |
|---|---|---|---|---|
| `providerId` | `string` | 必填 | v0.2 | provider 标识 |

#### `auth.verify`

连通验证（不缓存，每次真实请求 provider 最小探活；fail 为正常结果非
error）。路由：全局命令。结果帧：`auth.verify.result`（点对点，§16.6）。

| 字段 | 类型 | 可选性 | 登记版本 | 语义 |
|---|---|---|---|---|
| `providerId` | `string` | 必填 | v0.2 | provider 标识 |

### 15.6 trace 族（1）

#### `trace.query`

会话历史事件查询（连接私有读面——直查 domain_events，目标可为冷会话，
不触发懒加载）。路由：目标会话在 **payload.sessionId**；信封 sessionId 位
**不消费**。结果帧：`trace.query.result`（点对点，§16.7）；校验失败 →
`connection.error{code:"command.invalid_payload"}`（连接保持）。

| 字段 | 类型 | 可选性 | 登记版本 | 语义 |
|---|---|---|---|---|
| `sessionId` | `string` | 必填 | v0.4 | 目标会话（非空 string） |
| `instanceIds` | `string[]` | 可选 | v0.4 | 实例多选：缺省 = 全部实例；空数组 = 空结果（显式语义，非「全部」） |
| `agentKind` | `"main" \| "subagent"` | 可选 | v0.4 | 实例种类过滤 |
| `types` | `string[]` | 可选 | v0.4 | 事件类型多选：缺省 = 全部类型；空数组 = 空结果（同 instanceIds 口径） |
| `timeRange` | `TraceTimeRange`（`{ from?: string; to?: string }`） | 可选 | v0.4 | 时间窗（ISO 8601 文本，含起含止；from > to = 校验拒绝） |
| `page` | `TraceQueryPageInput`（`{ limit?: number; beforeId?: number }`） | 可选 | v0.4 | 分页：limit 缺省 50、上限 200（超限钳到 200 不报错；非正整数拒绝）；beforeId = id 游标（返回 id < beforeId 的更早页） |

### 15.7 web 族（3；v0.7 T4 联网状态图标 + v0.9 T7 显式启动通路）

#### `web.status`

CDP 连接状态读面（v0.7：daemon BrowserPort 单例连接——lazy 连接、断线回
idle 自动重连）。路由：全局命令（信封 sessionId 省略）。结果帧：
`web.status.result`（点对点，§16.8）。

| 字段 | 类型 | 可选性 | 登记版本 | 语义 |
|---|---|---|---|---|
| （无字段） | `EmptyPayload` | — | v0.7 | 空载荷（无参查询） |

#### `web.stop`

手动停止写面（v0.7）：关全部受管 tab → 断 CDP 连接 → 回 idle（幂等，
未连接时安全 no-op）。路由：全局命令。回执：`web.stop.result` 点对点
（§16.8）+ 状态回流经 `web.status.changed` 广播（§16.8，daemon 级
全局——信封 sessionId = SYSTEM_SESSION_ID，由 BrowserPort
onStatusChange 事件源触发，handler 不重复广播）。

| 字段 | 类型 | 可选性 | 登记版本 | 语义 |
|---|---|---|---|---|
| （无字段） | `EmptyPayload` | — | v0.7 | 空载荷（无参停止） |

#### `web.start`

显式启动写面（v0.9，T7 CDP 显式启动通路）：用户知情触发 lazy connect
（首次连接 Chrome 可能弹授权框，不应由 LLM 静默预热）。已连接时幂等
（connect() no-op）。路由：全局命令（信封 sessionId 省略）。回执：
`web.start.result` 点对点（§16.8）+ 状态回流经 `web.status.changed` 广播
（§16.8，daemon 级全局——单一事件源纪律，handler 不重复广播）。

| 字段 | 类型 | 可选性 | 登记版本 | 语义 |
|---|---|---|---|---|
| （无字段） | `EmptyPayload` | — | v0.9 | 空载荷（无参启动） |

### 15.8 thinking 族（1；v0.11 thinking 批①，iter-20260823-6ps5 T1.1）

#### `thinking.set`

会话 thinking 档覆盖写面（v0.11，thinking 批①；仿 `model.set` 形态）：
信封 sessionId **必填**（per-session 路由，AD-4），下一 turn 生效。level 为
pi-ai ThinkingLevel **字符串透传**（AD-2：helix 不维护第二份档位枚举，SoT
在 pi-ai，协议层不校验未知档位——引擎按能力过滤，全链不支持 →
`thinking.changed.effective = null`，不报错）。合法值含 `"off"`（**显式关**，
iter-20260823 后续批升格：effective=null、后续请求不带 reasoning——引擎
解析链在能力适配 clamp 前短路，off:null 模型不被钳成支持档）；未配置
（无覆盖无槽位）= **默认关**（不传 reasoning，pi-ai 显式关思考；无 medium
兜底）——off 与未配置的区分仅在 override 位（`"off"` vs `null`），请求行为
等价（均不带 reasoning）。`chat.send` 零字段（AD-4①：thinking 是会话状态
非逐消息参数）。生效回执 = `thinking.changed` 广播（§16.5；`model.set`
成功后同样补发一次——换模只改 effective 不改 override，消除 stale 档位）。

| 字段 | 类型 | 可选性 | 登记版本 | 语义 |
|---|---|---|---|---|
| `level` | `string` | 必填 | v0.11 | pi-ai ThinkingLevel 字符串透传（如 `"medium"` / `"high"` / `"off"` 显式关） |

### 15.9 kg 族（6+5+2+1+1+1+1；kg 批 + kg-bootstrap 批 + kg 维护批 + kg.health 批 + kg 评审批 + kg.candidates.list 批 + code.review.create 批，iter-20260825-11fo T5.3 / iter-20260829-ys7q T3.2 / C1 / W2-E / W2-F / 台账读面三件套 / code-review v1.5）

> 本族为 kg 批（v0.11 后 additive 微批，版本位不 bump，§14/§18 同构先例；
> 批次注记见 §19）登记的 P-1 数据面六命令。全局命令（信封 sessionId
> 省略）；后五命令携带**必填 `project`**（项目名 = workspace 一级目录名，
> 或绝对路径——daemon 单点解析，跨项目不串数据；无法解析 →
> `KG_E_PARAM`）。结果回执 = `kg.*.result` 点对点结果帧（§16.9）；
> O-6 轮询裁决零推送事件——索引进度走 `kg.index.status` 命令轮询。错误码
> `KG_E_PARAM` / `KG_E_NOT_FOUND` / `KG_E_STATE` / `KG_E_REBUILD_FAILED`
>（§19 登记；发 error 帧连接保持）。响应形状逐字段契约 =
> `docs/iterations/iter-20260825-11fo/development/contracts/kg-viewer-api.md`。

#### `kg.list`

节点列表+搜索（F5.1；三路过滤可叠加）。结果 = `kg.list.result`
（`{total, matched, nodes}`；total=项目内全部节点数，matched=过滤后命中数）。

| 字段 | 类型 | 可选性 | 登记版本 | 语义 |
|---|---|---|---|---|
| `project` | `string` | 必填 | kg 批 | 项目名或绝对路径（daemon 单点解析） |
| `kind` | `"rule" \| "entity"` | 可选 | kg 批 | 类型过滤 |
| `status` | `"draft" \| "confirmed" \| "superseded"` | 可选 | kg 批 | 状态过滤 |
| `q` | `string` | 可选 | kg 批 | name/digest 子串搜索 |

#### `kg.node.detail`

节点详情（F5.2 六段聚合：desc/rules/anchors/relations/supersede/log）。结果 =
`kg.node.detail.result`（payload 即六段详情本体）。`id` 不存在 →
`KG_E_NOT_FOUND`。

| 字段 | 类型 | 可选性 | 登记版本 | 语义 |
|---|---|---|---|---|
| `project` | `string` | 必填 | kg 批 | 项目名或绝对路径 |
| `id` | `string` | 必填 | kg 批 | 目标节点 id（来自 kg.list 行的 data-id 跳转） |

#### `kg.change.report`

知识变化报告（F5.3；按迭代聚合四类条目，数据源 = T5.1 KgReportService）。
结果 = `kg.change.report.result`（payload 即报告本体）。

| 字段 | 类型 | 可选性 | 登记版本 | 语义 |
|---|---|---|---|---|
| `project` | `string` | 必填 | kg 批 | 项目名或绝对路径 |
| `iterationId` | `string` | 可选 | kg 批 | 缺省 = 当前迭代（库内最近一次变更所属迭代） |

#### `kg.node.confirm`

draft 审阅转正（F5.4；**页面唯一写动作**，走 F2.3 KgWriteService 非旁路
直写）。仅 `status=draft` 可转正（非 draft → `KG_E_STATE`；id 不存在 →
`KG_E_NOT_FOUND`）；change_log 追加「草稿转正（页面人工确认）」。结果 =
`kg.node.confirm.result`（`{applied:true, node}` 翻转后状态回读）。

| 字段 | 类型 | 可选性 | 登记版本 | 语义 |
|---|---|---|---|---|
| `project` | `string` | 必填 | kg 批 | 项目名或绝对路径 |
| `id` | `string` | 必填 | kg 批 | 目标 draft 节点 id |

#### `kg.index.status`

索引状态面板（F5.5；四态互斥 absent/building/synced/degraded，O-6 轮询
通道本体）。`rebuild:true` 触发构建/重建（纯 codegraph 机械动作无知识层写，
AD-10；absent 态触发即首次构建 B1）；触发失败 → `KG_E_REBUILD_FAILED`。
结果 = `kg.index.status.result`（payload 即四态面板本体）。

| 字段 | 类型 | 可选性 | 登记版本 | 语义 |
|---|---|---|---|---|
| `project` | `string` | 必填 | kg 批 | 项目名或绝对路径 |
| `rebuild` | `boolean` | 可选 | kg 批 | true = 触发构建/重建（absent 态即首次构建） |

#### `kg.projects`

workspace 项目列表（F5.0；/project 单页 master-detail 左栏数据源）。无参
（workspace 根 = daemon 启动 cwd，TR-AD-6 零 env 键）。宽松口径（V-3 用户
裁决）：一级目录全部入列，排除清单（`docs`/`.helix`/`.worktrees`/隐藏/
`node_modules`/文件项）为唯一过滤；未建索引目录必须返回（status=absent）。
只读命令；冷启动构建入口是 `kg.index.status`。结果 = `kg.projects.result`
（`{projects}`）。

（无字段）

#### `kg.bootstrap.create`

发起 bootstrap 任务（CL-1 F1.1/F1.2，iter-20260829-ys7q T3.2 kg-bootstrap
批）。后端准入机械复核（索引 synced/degraded ∧ nodeCount==0 ∧ 无非终态
kg-bootstrap job——不信赖前端；未过 → `kg.bootstrap.not_eligible`，message
带原因 `index_absent` / `index_building` / `knowledge_not_empty` /
`task_running`（P0① 双启动防护：已有非终态同类型 job 拒绝，终态后可再发））→ 调
createTask 同一 API
（type="kg-bootstrap"、projects=[project]、params={projectRoot, scope?}、
stages 策略 fixed 由 manifest 生成三行、createdBy="page"——与 chat
task_create 工具同源，AD-7）。createTask 校验失败 → `task.validation_failed`
透传。结果 = `kg.bootstrap.create.result`（`{ok:true, jobId}`）。

| 字段 | 类型 | 可选性 | 登记版本 | 语义 |
|---|---|---|---|---|
| `project` | `string` | 必填 | kg-bootstrap 批 | 项目名或绝对路径（daemon 单点解析 + 准入复核） |
| `scope` | `string` | 可选 | kg-bootstrap 批 | 范围参数收窄（进 job.params.scope） |

#### `kg.bootstrap.produce`

bootstrap 产出呈现读面（CL-4 F4.1：任务→阶段→批次三级分组，nodes.
origin_batch_id → batch 行 → stage/job 行 + layer 列驱动；无 origin_batch_id
的日常落账节点不进本查询；absent 项目 → 空 groups 不建库）。结果 =
`kg.bootstrap.produce.result`（`{groups}`）。

| 字段 | 类型 | 可选性 | 登记版本 | 语义 |
|---|---|---|---|---|
| `project` | `string` | 必填 | kg-bootstrap 批 | 项目名或绝对路径 |

#### `kg.node.update`

节点修正写面（一）（CL-4 F4.2：内联编辑 digest/正文保存即 updateNode，
节点保持 confirmed；走 KgWriteService 唯一写入口 + change_log 记理由）。
digest/body 至少携带其一（空 patch → `task.validation_failed`）；节点不
存在 → `kg.node.not_found`。结果 = `kg.node.update.result`（`{ok:true,
node}`——修改后状态回读，payload 即产出条目投影）。

| 字段 | 类型 | 可选性 | 登记版本 | 语义 |
|---|---|---|---|---|
| `project` | `string` | 必填 | kg-bootstrap 批 | 项目名或绝对路径 |
| `nodeId` | `string` | 必填 | kg-bootstrap 批 | 目标节点 id（仅 data-id 键，AD-16） |
| `digest` | `string` | 可选 | kg-bootstrap 批 | 修订摘要（≤2 行） |
| `body` | `string` | 可选 | kg-bootstrap 批 | 修订正文 |

#### `kg.node.supersede`

节点修正写面（二）（CL-4 F4.2：superseded 留史 + change_log 记理由，
动作按钮消失；无转正无否决）。reason 必填非空——前端空理由拦截 +
后端 `task.validation_failed` 双防线；节点不存在 → `kg.node.not_found`。
结果 = `kg.node.supersede.result`（`{ok:true}`）。

| 字段 | 类型 | 可选性 | 登记版本 | 语义 |
|---|---|---|---|---|
| `project` | `string` | 必填 | kg-bootstrap 批 | 项目名或绝对路径 |
| `nodeId` | `string` | 必填 | kg-bootstrap 批 | 目标节点 id |
| `reason` | `string` | 必填 | kg-bootstrap 批 | 推翻理由（进 change_log 审计链） |

#### `kg.bootstrap.impact`

受影响连带只读推导（CL-4 F4.3：edges 表中指向被修正节点（target）的
source 引用方集合，去重、排除 superseded；不落库零自动写——update/
supersede 成功后前端调用刷新「受影响待复核」标记）。结果 =
`kg.bootstrap.impact.result`（`{affected, count}`）。

| 字段 | 类型 | 可选性 | 登记版本 | 语义 |
|---|---|---|---|---|
| `project` | `string` | 必填 | kg-bootstrap 批 | 项目名或绝对路径 |
| `nodeId` | `string` | 必填 | kg-bootstrap 批 | 被修正（update/supersede）的节点 id |

#### `kg.graph.purge`

清空图谱（C1 kg 维护批）：清空本项目 kg 库**全部内容**——知识面
（nodes/edges/anchor_decl/materialized_anchors/change_log）与符号面
（files/symbols/contains_edges）及 meta（含 sync 基准戳与 seq 发号计数
器）全量清零，索引态复位 absent（范围决策：全量清 + 索引态复位——清
symbols 留 meta 基线会让 sync 误判无变化不再导入，状态机破窗）；不动
`.codegraph`（那是 `kg.index.delete` 的职责，两命令职责严格分层）。
安全门禁：存在运行中（running/pending）kg-bootstrap 任务时拒绝 →
`kg.graph.purge_blocked`（防 done 任务悬挂引用）。结果 =
`kg.graph.purge.result`（`{purged, nodesRemoved, symbolsRemoved,
filesRemoved}`）。

| 字段 | 类型 | 可选性 | 登记版本 | 语义 |
|---|---|---|---|---|
| `project` | `string` | 必填 | kg 维护批 | 项目名或绝对路径（daemon 单点解析） |

#### `kg.index.delete`

删除索引（C1 kg 维护批）：删除项目 `.codegraph` 目录 + kg 索引态复位
absent（清符号面同步基准：files/symbols/contains_edges + meta
sync:baseline/sync:degraded；**知识层不动**——nodes/edges/change_log 等
保留，下次 `kg.index.status {rebuild:true}` 重建索引后符号面自动恢复）。
联动：删除时停掉该项目 fs-watch watcher（KgFsWatchService.stopWatching
接缝）；重建成功经既有 onSynced 钩子自动重挂。结果 =
`kg.index.delete.result`（`{deleted, state, watcherStopped}`）。

| 字段 | 类型 | 可选性 | 登记版本 | 语义 |
|---|---|---|---|---|
| `project` | `string` | 必填 | kg 维护批 | 项目名或绝对路径（daemon 单点解析） |

#### `kg.health`

结构体检看板读面（W2-E 轨一，设计 kg-driven-dev-loop-design D5 + R15）：
findConflicts / findOrphans / orphan 合计计数 / 索引状态 / candidates 四态
计数五项聚合——纯只读零写路径；absent 项目短路返回空态（读面不建库）。
结果 = `kg.health.result`（`KgHealthDto`）。

| 字段 | 类型 | 可选性 | 登记版本 | 语义 |
|---|---|---|---|---|
| `project` | `string` | 必填 | kg.health 批 | 项目名或绝对路径（daemon 单点解析） |

#### `kg.review.create`

发起 kg-review 语义体检任务（W2-F 轨二，设计 kg-driven-dev-loop-design D5
+ R21/R23）。准入从简（与 bootstrap 一次性语义不同）：索引存在即可，
**允许反复发起**（终态后可再发）——体检面向存量图谱，知识层非空恰是
评审对象；未建索引 → `kg.review.not_eligible`（message 带原因
`index_absent`）。P0① 并发禁入同口径：该项目存在非终态 kg-review job →
`kg.review.not_eligible`（message 带原因 `task_running`，仅禁并发不绑一
次性）。过检 → 调
createTask 同一 API（type="kg-review"、projects=[project]、
params={projectRoot}、stages 策略 fixed 由 manifest 生成三行（L0 结构面
预检 / L1 规则册逐节点评审 / L2 实体册逐节点评审）、createdBy="page"——
与 kg.bootstrap.create / chat task_create 同源）。createTask 校验失败 →
`task.validation_failed` 透传。结果 = `kg.review.create.result`
（`{ok:true, jobId}`）。产出纪律：评审只提 candidates 台账（内容问题不
直改节点），唯一例外 = scene 缺失节点可 updateNode 直补（R23 元数据
补全不是内容推翻）；禁止直改 body/digest、禁止 supersede（推翻权在人审）。

#### `kg.candidates.list`

候选台账列表读面（台账读面三件套之三：P-1 台账查看面板数据面；只读零
裁决——本轮无页面裁决写命令，裁决归 kg-review 人审 / decideCandidate 写面）。
candidates 表 status 过滤 + limit/offset 分页，缺省全量最新在前（rowid 序）；
行含 body 全文（选中行展开详情数据源）。absent 项目 → `KG_E_NOT_FOUND`
（读面绝不新建库文件，kg.list 同先例）；unbound 防御 = 空集结果非报错。
结果 = `kg.candidates.list.result`（`KgCandidatesListDto`）。

| 字段 | 类型 | 可选性 | 登记版本 | 语义 |
|---|---|---|---|---|
| `project` | `string` | 必填 | kg.candidates.list 批 | 项目名或绝对路径（daemon 单点解析） |
| `status` | `"pending" \| "deferred" \| "applied" \| "discarded"` | 可选 | kg.candidates.list 批 | 状态过滤（缺省全量） |
| `limit` | `number` | 可选 | kg.candidates.list 批 | 行数上限 |
| `offset` | `number` | 可选 | kg.candidates.list 批 | 跳过行数（分页） |

| 字段 | 类型 | 可选性 | 登记版本 | 语义 |
|---|---|---|---|---|
| `project` | `string` | 必填 | kg 评审批 | 项目名或绝对路径（daemon 单点解析 + 准入复核） |

#### `code.review.create`

发起 code-review 代码评审任务（code-review v1.5，P-1 体检区双入口之代码
评审；设计 code-review-task-design D4）。**无准入门槛**（与 kg.review.create
唯一语义差：评审对象是代码不是图谱，不要求 .helix-kg 索引存在——无
index_absent 分支）；允许反复发起（终态后可再发）。P0① 并发禁入同口径：
该项目存在非终态 code-review job → `task.task_running`（仅禁并发不绑一
次性）。过检 → 调 createTask 同一 API（type="code-review"、
projects=[project]、params={projectRoot}、stages 策略 fixed 由 manifest
生成三行（盘点分批 / 分批评审 / 汇总报告）、createdBy="page"——与
kg.review.create / chat task_create 同源）。createTask 校验失败 →
`task.validation_failed` 透传。结果 = `code.review.create.result`
（`{ok:true, jobId}`，挂既有 kg 通道点对点回执）。产出纪律：发现只进
任务报告与 closure（kind="issue"），不进 candidates 台账；可泛化为
规则的少量发现才以 sediment 申报。

| 字段 | 类型 | 可选性 | 登记版本 | 语义 |
|---|---|---|---|---|
| `project` | `string` | 必填 | code.review.create 批 | 项目名或绝对路径（daemon 单点解析；无索引准入门槛） |

### 15.10 workspace 族（2；workspace 批，W1 workspace 绑定闭环）

> 本族为 workspace 批（v0.11 后 additive 微批，版本位不 bump，§19 同构
> 先例；批次注记见 §20）登记的绑定闭环两面。全局命令（信封 sessionId
> 省略）。语义：workspace 从「daemon 启动 cwd 装配期常量」改为「运行时
> 显式绑定」——未绑定态启动 → `workspace.get` 门禁判定 → `workspace.open`
> 绑定（daemon 单点校验 + KV 持久化 + kg 栈重建 + `workspace_changed`
> 广播）。无 close/unbind 命令（v1 裁决：切换 = open 另一 root）。结果
> 回执 = §16.10 两结果帧；错误码 `WORKSPACE_E_INVALID_ROOT` /
> `WORKSPACE_E_ACTIVE_AGENT`（§7；发 error 帧连接保持）。

#### `workspace.get`

绑定门禁读面（无参；前端启动分流依据：current 非 null → 主壳，null →
选择工作空间页）。结果 = `workspace.get.result`（`{current, recents,
notice?}`；recents MRU 上限 8，get 时惰性探测标 valid）。

（无字段）

#### `workspace.open`

显式绑定写面。daemon 校验（§3.3 单点）：realpath 规范化（消 symlink
双写）+ 存在且为目录且可读 + 危险根拒绝（文件系统根 / 主目录——扫描
面失控，引导选具体目录）；存在运行中会话/智能体时拒绝（F2 裁决 v1
禁止切换）。幂等：同 root 重复 open = 状态零变 + 仍广播一次
`workspace_changed`。CLI 形态例外：终端站位 = 显式选择（启动即等价
已 open(cwd)，不持久化）。结果 = `workspace.open.result`
（`{root, projects}`；projects 复用 kg.projects 项目行 DTO 口径）。

| 字段 | 类型 | 可选性 | 登记版本 | 语义 |
|---|---|---|---|---|
| `root` | `string` | 必填 | workspace 批 | 待绑定的工作空间根（daemon realpath 规范化 + 危险根校验） |

### 15.11 task 族（10；task 批 + task.retry 批，iter-20260829-ys7q T1.5 P-2 任务页数据面）

> 本族为 task 批（v0.11 后 additive 微批，版本位不 bump，§19/§20 同构
> 先例；批次注记见 §21）登记的 P-2 任务页十命令（task.retry 为后续 additive
> 增补——任务级人工复活，见 §21 增补注记）。全局命令（信封 sessionId
> 省略——任务为 daemon 级实体非会话作用域）。**零内容干预（AD-2）：本族
> 清单即全集**——无 steer/批次重试/内容编辑命令（机械 grep 断言守护；
> task.retry 是 job 级生命周期复活而非批次重试/内容干预，AD-2 语义保持）；
> 任务创建不经本族（§8.2：创建命令按任务类型各有宿主）。结果回执 =
> 点对点结果帧（`task.*.result`，types/task.ts 窄化接口——**不入
> EVENT_TYPES 目录**，契约 §0 计数 57→58 仅 task.changed；信封 sessionId =
> SYSTEM_SESSION_ID、channel = notification）。错误码词表 = 契约 task-api
> §4（§7 登记；发 error 帧连接保持；状态判断收口引擎 T1.3，handler 透传）。
> 响应形状逐字段契约 = 本迭代 `development/contracts/task-api.md`。

#### `task.list`

任务列表（F3.1；全局平铺；**服务端排序 = 运行中置顶 + 创建时间倒序**）。
结果 = `task.list.result`（`{tasks: TaskSummaryDto[]}`，DTO 见 types/task.ts
——裸 id 纪律 AD-4：title 服务端组装，前端不拼文案）。

| 字段 | 类型 | 可选性 | 登记版本 | 语义 |
|---|---|---|---|---|
| `status` | `TaskStatus`（六态枚举） | 可选 | task 批 | 状态过滤器（服务端生效；越界 → command.invalid_payload） |
| `project` | `string` | 可选 | task 批 | 项目过滤器（AD-8：项目标签之一；服务端生效） |

#### `task.detail`

任务详情（F3.2/F3.3：阶段条 + 当前阶段批次 + 实例 plan + 叙述句）。
结果 = `task.detail.result`（`{task: TaskDetailDto}`）。jobId 不存在 →
`task.not_found`。

| 字段 | 类型 | 可选性 | 登记版本 | 语义 |
|---|---|---|---|---|
| `jobId` | `string` | 必填 | task 批 | 目标任务（join 键，来自 task.list 行 data-id） |

#### `task.artifacts`

结果查询（F3.4，只读：各阶段 stage.artifact 文字报告——形状 `{ summary: string, body?: string }`，body 为 code-review 批 additive 扩展的阶段产物全文（markdown），未携带即缺省；与 kg 零耦合）。
节点详情/修正转 /project 页（AD-10）。结果 = `task.artifacts.result`
（`{artifacts: TaskArtifactsDto}`）。

| 字段 | 类型 | 可选性 | 登记版本 | 语义 |
|---|---|---|---|---|
| `jobId` | `string` | 必填 | task 批 | 目标任务 |

#### `task.subscribe`

连接级订阅（F3.2 WS 实时推送；机械定义：连接级订阅集合——携带 jobId 加入
集合，无 jobId = 全任务通配；`task.changed` 按连接过滤投递，断连清表）。
结果 = `{ok: true}`。

| 字段 | 类型 | 可选性 | 登记版本 | 语义 |
|---|---|---|---|---|
| `jobId` | `string` | 可选 | task 批 | 缺省 = 订阅全部任务变更（通配档） |

#### `task.unsubscribe`

退订（对称语义：携带 jobId 移除该订阅，无 jobId = 清空订阅集与通配档）。
结果 = `{ok: true}`。

| 字段 | 类型 | 可选性 | 登记版本 | 语义 |
|---|---|---|---|---|
| `jobId` | `string` | 可选 | task 批 | 缺省 = 清空全部任务订阅 |

#### `task.pause`

暂停（F3.5；仅 running → paused 合法，O-2：停派新批次 + 在跑自然收口；
非法态 → `task.invalid_state` 引擎透传）。结果 = `{ok: true, status}`
（status = 引擎成功后置状态）；成功即广播 `task.changed`
（§16.1，O-7 逐迁移）。

| 字段 | 类型 | 可选性 | 登记版本 | 语义 |
|---|---|---|---|---|
| `jobId` | `string` | 必填 | task 批 | 目标任务 |

#### `task.resume`

恢复（仅 paused → running；与断点恢复同路径）。结果 = `{ok: true,
status}`；成功即广播 `task.changed`。

| 字段 | 类型 | 可选性 | 登记版本 | 语义 |
|---|---|---|---|---|
| `jobId` | `string` | 必填 | task 批 | 目标任务 |

#### `task.cancel`

取消（pending/running/paused → cancelled 终态；在跑批次 SIGTERM）。结果 =
`{ok: true, status}`；成功即广播 `task.changed`。

| 字段 | 类型 | 可选性 | 登记版本 | 语义 |
|---|---|---|---|---|
| `jobId` | `string` | 必填 | task 批 | 目标任务 |

#### `task.retry`

人工重试（task.retry 批 additive：**仅 failed → running 复活**——批次重试
预算归零留痕（此前失败次数入 retryNote）+ failed 阶段重开 running + 清
error + 重开编排；已 done 阶段/批次不动。token 耗尽换 key 后续跑场景，
不浪费已耗 token；其余状态 → `task.invalid_state` 引擎透传）。结果 =
`{ok: true, status}`；成功即广播 `task.changed`。

| 字段 | 类型 | 可选性 | 登记版本 | 语义 |
|---|---|---|---|---|
| `jobId` | `string` | 必填 | task.retry 批 | 目标任务（failed 终态） |

#### `task.delete`

任务删除（F3.6，人工操作：**仅终态 done/failed/cancelled 可删**，运行中
删除 → `task.invalid_state`——判断收口引擎，handler 透传；清理 job/stage/
batch + 各批次实例 work_item，不触 kg 产出）。结果 = `{ok: true}`。

| 字段 | 类型 | 可选性 | 登记版本 | 语义 |
|---|---|---|---|---|
| `jobId` | `string` | 必填 | task 批 | 目标任务（终态） |

## 16. 事件 payload 形状总登记（S→C，78 事件全集）

> **计数声明：78 事件全集**（16.1 notification 3〔含 task.changed〕 +
> 16.2 session 5〔含 main-session plan 批 session.plan.changed〕 +
> 16.3 chat 12〔含 engine.retrying 网络重试批 + error entry 批 error.entry〕 + 16.4 agent 15〔含 park/resume 批 2 + base prompt 批 1〕 + 16.5 thinking·compaction·usage 5 +
> 16.6 model 13 + 16.7 trace 1 + 16.8 web 4 + 16.9 kg 6+5+2+1+1+1+1 + 16.10 workspace 3
> ）——与 `EVENT_TYPES` 常量恰等（守护断言③口径）。
> 子节划分 == `src/events/` 族文件划分 == `EVENT_CHANNELS` 通道值域
>（三面同构，守护断言⑤口径）；auth 族 4 结果帧按 `EVENT_CHANNELS` 登记挂
> **model 通道**（§16.6 内）；task 批 task.changed 挂既有 **notification
> 通道**（不新增 Channel 值，契约 task-api §0）。登记锚格式同 §15
>（`#### \`<type>\`` 锚 + payload 字段表）。类型权威源 =
> `packages/protocol/src/events/`（task 批 DTO/事件 = `src/types/task.ts`，
> §15.11 注记），文档与其逐项对齐（AD-1）。点对点结果帧（model/auth 族
> `*.result` 9 +
> `trace.query.result` + agent.config 族两结果帧（v0.6）+ web 族两结果帧
> （v0.7）+ kg 族六结果帧（kg 批）+ workspace 族两结果帧（workspace 批）
> + task 族十结果帧（task 批 9 + task.retry 批 1，不入本目录——契约 §0 计数，types/task.ts
> 窄化接口供出））
> 仅发发起命令的连接，不经 EventStream 广播（TR-AD-21 先例）。

### 16.1 notification 族（3；信封 sessionId = SYSTEM_SESSION_ID）

#### `connection.welcome`

握手通过回执（notification 通道，会话无关系统事件）。

| 字段 | 类型 | 可选性 | 登记版本 | 语义 |
|---|---|---|---|---|
| `sessionId` | `string` | 必填 | v0 | 当前会话 id |
| `model` | `string` | 必填 | v0 | 当前模型（展示用徽标） |
| `agentState` | `AgentStateDto` | 必填 | v0 | 主实例状态（§6） |
| `draft` | `boolean` | 可选 | v0.5 定形登记（§14.1） | 草稿标记：true = 当前会话是零条目内存草稿（未落盘、不进清单；握手不 attach 不推快照）；缺省 = 现状握手（attach + 立即快照） |
| `mode` | `string` | 可选 | P1 会话模式微批（§18） | daemon 当前模式面：草稿握手 = 草稿暂存模式（前端 header 模式选择器恢复基准）；已建会话握手 = session.mode 定格值（与 `draft` 字段同构——同为「当前会话」投影）；缺省 = 未携带（旧 daemon 兼容，读侧按 `"default"` 兜底） |

#### `connection.error`

握手拒绝 / 命令错误回执（notification 通道）。

| 字段 | 类型 | 可选性 | 登记版本 | 语义 |
|---|---|---|---|---|
| `code` | `ErrorCode` | 必填 | v0 | 错误码（全集见 §7） |
| `message` | `string` | 必填 | v0 | 错误描述（中文说明） |

#### `task.changed`

任务状态变更广播（task 批，T1.5；O-7 裁决：**逐状态迁移推送、轻负载**
——引擎每次 job/stage/batch 行 status 迁移即推一帧，不合并去抖；前端
收到后按 `changed` 面重拉 detail/list，保真优先）。daemon 级全局帧（
信封 sessionId = SYSTEM_SESSION_ID），但投递**按连接级任务订阅表过滤**
（task.subscribe 登记：订阅该 jobId 或通配才收，§15.11）——不沿用
kg 族零推送口径，亦不经会话订阅路由。

| 字段 | 类型 | 可选性 | 登记版本 | 语义 |
|---|---|---|---|---|
| `jobId` | `string` | 必填 | task 批 | 变更任务（join 键） |
| `changed` | `"job" \| "stage" \| "batch" \| "work_item"` | 必填 | task 批 | 变更面（stage/batch/work_item 级变更前端按需重拉 detail） |
| `status` | `string` | 可选 | task 批 | job 级变更携带新状态（六态 wire 值） |
| `syncHint` | `string` | 可选 | W2-D | kg sync 提示（R13：job 终态且 pending_sync 台账有未提示行时随行一帧——机器只记录只提醒，sync 永远人确认；服务层人读文案前端直渲 toast） |

### 16.2 session 族（5；main-session plan 批 +1）

#### `session.snapshot`

全量快照（握手后 / 重连后；AD-16 快照+增量；v0.2 尾窗口径 additive，§11.5）。

| 字段 | 类型 | 可选性 | 登记版本 | 语义 |
|---|---|---|---|---|
| `snapshot` | `SessionSnapshotDto` | 必填 | v0 | 全量快照（§6；additive 扩展 §10.5 / §11.5） |
| `snapshot.thinking` | `{ override: string \| null; effective: string \| null }` | 可选 | v0.11 | 会话 thinking 覆盖/生效双位（thinking 批③ F-8 修复：SessionStateView → wire 接通；切换会话/重连/重启恢复后 UI 与引擎一致；null = 无覆盖 / 全链不支持不传参；缺省 = 未携带，旧剧本兼容） |
| `snapshot.mode` | `string` | 可选 | P1 会话模式微批（§18） | 会话模式回带：建会话时定格（chat.send draft 链 mode 透传落库；此后无写路径，快照只读回带）；缺省 = 未携带（旧剧本兼容，读侧按 `"default"` 兜底） |
| `snapshot.plan` | `WorkItemDto[] \| null` | 可选 | main-session plan 批 | 主会话工作台账全行（seq 升序）：instanceId 维度 = sessionId（主会话 plan 三工具写面落 work_item 表）；重连/恢复种子，增量面 = `session.plan.changed`；携带时 null = 无台账（轻量任务未建）；缺省 = 未携带（旧 daemon 兼容，读侧保持现值） |
| `snapshot.ledger` | `TaskBatchLedgerDto \| null` | 可选 | main-session plan 批 | 台账计数摘要（`{ total, done, inProgress }`；与 `snapshot.plan` 同源同 null 语义，服务端从 plan 行组装——前端零拼装）；缺省 = 未携带 |

#### `session.plan.changed`

主会话工作台账变更广播（main-session plan 批）：主会话 plan 三工具
（`plan_create` / `plan_update` / `plan_read`）执行成功后由 daemon 装配层
发布——信封 sessionId = 台账归属会话（per-session 订阅路由，与
`model.changed` 同构）。plan/ledger 复用 task 域批次 DTO 形状
（`WorkItemDto` / `TaskBatchLedgerDto`，§15.11 注记同源）；无台账 = 双
null（null 语义与 task 批次行同构，非空数组）。台账行清理随 session
删除写链（deleteSession 顺带清 work_item——防孤儿）。

| 字段 | 类型 | 可选性 | 登记版本 | 语义 |
|---|---|---|---|---|
| `sessionId` | `string` | 必填 | main-session plan 批 | 台账归属会话（instanceId 维度 = sessionId，跨重启稳定） |
| `plan` | `WorkItemDto[] \| null` | 必填 | main-session plan 批 | 台账全行（seq 升序；`{ seq, content, status: pending/in_progress/done/abandoned, note }`）；null = 无台账 |
| `ledger` | `TaskBatchLedgerDto \| null` | 必填 | main-session plan 批 | 计数摘要（`{ total, done, inProgress }`；与 plan 同源同 null 语义，服务端组装） |

#### `session.list_changed`

会话清单变化广播（新建 / 删除 / 运行态变化 / 标题更新触发）。

| 字段 | 类型 | 可选性 | 登记版本 | 语义 |
|---|---|---|---|---|
| `kind` | `"created" \| "deleted" \| "state_changed"` | 必填 | v0.2 | 变化种类 |
| `sessionId` | `string` | 可选 | v0.2 | 目标会话；列表级批量变化可省略 |
| `session` | `SessionMeta` | 可选 | v0.2 | created/state_changed 携带最新元数据（同 session.list 元素形状：`{ sessionId, title, lastActivityAt, runState, loaded }`） |

#### `session.list.result`

会话清单命令结果（点对点回执；信封 sessionId = SYSTEM_SESSION_ID）。

| 字段 | 类型 | 可选性 | 登记版本 | 语义 |
|---|---|---|---|---|
| `sessions` | `SessionMeta[]` | 必填 | v0.2 | 会话清单（按 lastActivityAt 降序） |

#### `session.loadHistory.result`

分页历史命令结果（点对点回执；信封 sessionId = 目标会话 id）。

| 字段 | 类型 | 可选性 | 登记版本 | 语义 |
|---|---|---|---|---|
| `entries` | `EntryDto[]` | 必填 | v0.2 | beforeEntryId 之前的更早历史（时间升序） |
| `hasMore` | `boolean` | 必填 | v0.2 | 是否还有更早页 |
| `nextCursor` | `string \| null` | 必填 | v0.2 | 下一页游标（无更早页 = null） |

### 16.3 chat 族（12；error entry 批 +1）

#### `chat.stream.delta`

| 字段 | 类型 | 可选性 | 登记版本 | 语义 |
|---|---|---|---|---|
| `messageId` | `string` | 必填 | v0 | 所属消息 id |
| `delta` | `string` | 必填 | v0 | 流式增量文本（中间态，**不落盘**，AD-16） |

#### `chat.turn.started`

| 字段 | 类型 | 可选性 | 登记版本 | 语义 |
|---|---|---|---|---|
| `turnId` | `string` | 必填 | v0 | 轮次里程碑（落盘事件） |

#### `chat.turn.completed`

| 字段 | 类型 | 可选性 | 登记版本 | 语义 |
|---|---|---|---|---|
| `turnId` | `string` | 必填 | v0 | 轮次 id |
| `reason` | `TurnCompletionReason`（`"completed" \| "aborted"`） | 必填 | v0 | 结束原因（正常完成 / 中断） |

#### `chat.message.completed`

| 字段 | 类型 | 可选性 | 登记版本 | 语义 |
|---|---|---|---|---|
| `entry` | `EntryDto` | 必填 | v0 | 完成消息（kind="message" 且含最终 content；落盘事件） |
| `entry.images` | `readonly string[]` | 可选 | v0.10（T9 图片下行） | 仅 user 消息携带（chat.send.images 透传）：base64 data URL 数组，气泡缩略图渲染依据；缺省 = 纯文本旧形态 |
| `entry.source` | `"user" \| "closure" \| "progress"` | 可选 | v0.11（T11a 批内补登） | 注入来源（helix 自有三值枚举，AD-2 字符串透传原则不适用）：user=用户 steer；closure=SubAgent 收口注入（AD-8）；progress=周期进展报告（injectClosure 同通道）；缺省 = 老数据按 user 渲染；session.snapshot 载荷（投影重建）同构 |

#### `steer.queued`

| 字段 | 类型 | 可选性 | 登记版本 | 语义 |
|---|---|---|---|---|
| `entryId` | `string` | 必填 | v0 | 入队消息 entry id（前端「STEER·已入队」徽标依据） |
| `source` | `"user" \| "closure" \| "progress"` | 可选 | v0.11（T11a 批内补登） | 注入来源（与 entry.source 同枚举同语义）；缺省 = 老事件按 user |

#### `steer.drained`

| 字段 | 类型 | 可选性 | 登记版本 | 语义 |
|---|---|---|---|---|
| `entryId` | `string` | 必填 | v0 | turn 边界 drain 注入（徽标转「已注入·本轮结束」依据） |
| `source` | `"user" \| "closure" \| "progress"` | 可选 | v0.11（T11a 批内补登） | 注入来源（与入队时同源透传）；缺省 = 老事件按 user |

#### `tool.call.started`

| 字段 | 类型 | 可选性 | 登记版本 | 语义 |
|---|---|---|---|---|
| `entry` | `EntryDto` | 必填 | v0 | 工具调用开始（tool-call 变体，state="running"） |

#### `tool.call.result`

| 字段 | 类型 | 可选性 | 登记版本 | 语义 |
|---|---|---|---|---|
| `entry` | `EntryDto` | 必填 | v0 | 工具调用结果（tool-call 变体，state="done"\|"error"，含 result 与 durationMs） |
| `entry.images` | `readonly string[]` | 可选 | v0.10（T9 图片下行） | 工具结果附带图片（如 browser screenshot 截图）：base64 data URL 数组，工具卡缩略图渲染依据；缺省 = 无图旧形态；session.snapshot 载荷（投影重建）同构 |

#### `agent.state.changed`

| 字段 | 类型 | 可选性 | 登记版本 | 语义 |
|---|---|---|---|---|
| `state` | `AgentStateDto` | 必填 | v0 | agent 生命周期状态变更（chat 通道主线状态） |

#### `engine.error`

引擎/模型调用失败透传（终验热修：provider 错误不崩会话，经此帧下发；
reducer 现归类走 chat 消费路径）。

| 字段 | 类型 | 可选性 | 登记版本 | 语义 |
|---|---|---|---|---|
| `message` | `string` | 必填 | v0（热修） | 错误描述（provider 原文透传；前端错误卡片正文） |

#### `engine.retrying`

LLM 调用瞬时失败进入退避重试（P2 ⑦ 网络重试批）：等待期可见反馈帧——
前端状态行「网络重试中（第 N/3 次，约 Xs 后）」数据源。瞬态帧不落盘：
流恢复（`chat.stream.delta`）/ `engine.error` / 轮次终制由前端清除；退避
耗尽仍走既有 `engine.error` 语义，本帧不改变任何收口语义。SubAgent 实例
的同类领域事件只落 domain_events（trace 数据面），WS 帧由 mapper 守卫
抑制（与 `engine.error` 同口径，不弹主聊天流）。

#### `error.entry`

引擎/模型失败的错误条目落时间轴（error entry 批）：entry 为 `kind="error"`
变体（EntryDto 第五变体），携带完整条目——与 `engine.error` 同失败链并存：
`engine.error` 是瞬态反馈帧（不落盘，state.engineError 内存卡），本帧是
落盘条目帧（进会话 entries）——前端据本帧把瞬态卡转正为原位红条（同一
错误不双显；瞬态卡清除时机 = 本帧到达，`chat.turn.started` 清除保留作兜底）。
刷新/切换后经 session.snapshot 的 entries 原位可见。SubAgent 实例的同类
领域事件只落 domain_events（trace 数据面），WS 帧由 mapper 守卫抑制（与
`engine.error` 同口径，不弹主聊天流）。

| 字段 | 类型 | 可选性 | 登记版本 | 语义 |
|---|---|---|---|---|
| `entry` | `ErrorEntryDto` | 必填 | error entry 批 | 错误条目（kind="error" 变体：id/instanceId/message/turnId/createdAt；turnId = 出错轮次，原位锚） |


| 字段 | 类型 | 可选性 | 登记版本 | 语义 |
|---|---|---|---|---|
| `attempt` | `number` | 必填 | 网络重试批 | 即将执行的重试序号（1 起，最大 = totalAttempts） |
| `totalAttempts` | `number` | 必填 | 网络重试批 | 重试总次数（退避序列长度） |
| `waitMs` | `number` | 必填 | 网络重试批 | 本次重试前等待毫秒数 |
| `message` | `string` | 必填 | 网络重试批 | 触发重试的 provider 错误原文（领域数据不 i18n） |

### 16.4 agent 族（15）

#### `agent.spawned`

spawn 工具秒回出卡（不等执行，AD-8 异步交付）。

| 字段 | 类型 | 可选性 | 登记版本 | 语义 |
|---|---|---|---|---|
| `agentId` | `string` | 必填 | v0.1 | 新实例 id |
| `task` | `string` | 必填 | v0.1 | 任务描述 |
| `profileKind` | `string` | 必填 | v0.1 | profile 种类 |
| `model` | `string` | 可选 | v0.1 | "provider/model-id"；缺省继承当前模型（AD-6） |
| `anchorEntryId` | `string \| null` | 可选 | v0.3 | spawn 锚（卡片插入位权威 entry id；null = 流首；缺省不携带 = 主实例；计算规则见 §12.1） |

#### `agent.queued`

| 字段 | 类型 | 可选性 | 登记版本 | 语义 |
|---|---|---|---|---|
| `agentId` | `string` | 必填 | v0.1 | 实例 id |
| `position` | `number` | 必填 | v0.1 | FIFO 队列位置（随出队递减重发） |

#### `agent.started`

| 字段 | 类型 | 可选性 | 登记版本 | 语义 |
|---|---|---|---|---|
| `agentId` | `string` | 必填 | v0.1 | 实例 id（出队 / 预算内直跑，卡片 running 态） |

#### `agent.stalled`

| 字段 | 类型 | 可选性 | 登记版本 | 语义 |
|---|---|---|---|---|
| `agentId` | `string` | 必填 | v0.1 | 实例 id |
| `idleMs` | `number` | 必填 | v0.1 | idle 毫秒数（超阈值警示不自动杀；可再次发生，非状态迁移） |

#### `agent.completed`

| 字段 | 类型 | 可选性 | 登记版本 | 语义 |
|---|---|---|---|---|
| `agentId` | `string` | 必填 | v0.1 | 实例 id |
| `closure` | `ClosureDto` | 必填 | v0.1 | 自然收口 done（线格式全字段必发，§10.4） |

#### `agent.failed`

| 字段 | 类型 | 可选性 | 登记版本 | 语义 |
|---|---|---|---|---|
| `agentId` | `string` | 必填 | v0.1 | 实例 id |
| `error` | `string` | 必填 | v0.1 | 错误描述 |
| `closure` | `ClosureDto` | 必填 | v0.1 | 崩溃/异常收口（closure.status="failed"） |

#### `agent.killed`

| 字段 | 类型 | 可选性 | 登记版本 | 语义 |
|---|---|---|---|---|
| `agentId` | `string` | 必填 | v0.1 | 实例 id |
| `closure` | `ClosureDto` | 必填 | v0.1 | 用户 kill 收口（closure.status="failed"，lifecycle terminated） |

#### `agent.parked`

实例挂起（park/resume 批，设计稿 park-resume §5；**非终态**——不写 closure、
不触发收口链、不注入主线。子进程检测 PARK 标记进入挂起等待时广播；
parked 不占并发预算，恢复等价新派发排队）。

| 字段 | 类型 | 可选性 | 登记版本 | 语义 |
|---|---|---|---|---|
| `agentId` | `string` | 必填 | park/resume 批 | 实例 id |
| `reason` | `"user" \| "taskPause"` | 必填 | park/resume 批 | 挂起原因（taskPause=任务暂停链，后续波次接线；链 B 网络自动挂起已裁删） |
| `parkedAt` | `string` | 必填 | park/resume 批 | 挂起时刻（ISO 8601） |
| `summary` | `{ progress: string, next: string }` | 可选 | park/resume 批 | PARK 标记摘要（progress=当前进展一句话，next=恢复后第一步；缺席 = 子进程未携带） |

#### `agent.resumed`

挂起实例恢复（同一实例同一会话从断点继续；预算内直恢复与排队空位后恢复
两路径均广播）。`InstanceState` 同批 additive 扩 `parked` 值（非终态）。

| 字段 | 类型 | 可选性 | 登记版本 | 语义 |
|---|---|---|---|---|
| `agentId` | `string` | 必填 | park/resume 批 | 实例 id |

#### `agent.instantiated`

实例化时刻 profile 快照落盘（**只落盘不广播**，AF-6；登记供 trace.query
结果类型化与守护一致性）。

| 字段 | 类型 | 可选性 | 登记版本 | 语义 |
|---|---|---|---|---|
| `instanceId` | `string` | 必填 | v0.4 | 实例 id（T10 起 = agent-<唯一串>；历史行 "main" \| agent-N = legacy 只读兼容） |
| `profileKind` | `string` | 必填 | v0.4 | profile 种类（自由字符串，无注册表） |
| `thinkingLevel` | `string` | 可选 | v0.11（后续批改可选） | SubAgent spawn 解析的 thinkingLevel 快照（thinking 批④：自身 profile 槽位，无兜底——未配置 = 默认关，AD-6；字符串透传 AD-2） |
| `profileSnapshot` | `TraceProfileSnapshot` | 必填 | v0.4 | 注入快照（systemPrompt 全文 + tools + model + compaction? + hooks?，§13.2） |

#### `agent.model.changed`

运行期换模的模型时间线落盘（**只落盘不广播**，AF-6；from/to 与
`model.changed` 广播帧 previous/model 同源同值）。

| 字段 | 类型 | 可选性 | 登记版本 | 语义 |
|---|---|---|---|---|
| `instanceId` | `string` | 必填 | v0.4 | 实例 id（当前仅主实例） |
| `from` | `string` | 必填 | v0.4 | 旧模型标识（"provider/model-id"） |
| `to` | `string` | 必填 | v0.4 | 新模型标识 |

#### `agent.config.list.result`

资源配置读面命令结果（点对点回执；信封 sessionId = SYSTEM_SESSION_ID；
全局命令，v0.6）。skills 行含 source 标签；diagnostics = 扫描诊断（坏文件
上抛不炸）；model 槽位未设 = null（JSON 序列化面钉死 null 非 undefined）。

| 字段 | 类型 | 可选性 | 登记版本 | 语义 |
|---|---|---|---|---|
| `profiles` | `AgentConfigProfileBlock[]` | 必填 | v0.6 | 配置块清单：携带 profileKind 请求 = 单块；缺省 = 两块（main-session 在前） |
| `profiles[].profileKind` | `"main-session" \| "subagent-worker"` | 必填 | v0.6 | 归属 kind |
| `profiles[].tools` | `{ name, enabled, snippet }[]` | 必填 | v0.6 | tools 全集 + 启停态（缺省无记录 = 启用） |
| `profiles[].tools[].snippet` | `string` | 必填 | v0.6 | 工具一句话说明（daemon ToolPromptSnippets 注册表同源；M6 T4 批内补登；注册表外名 = 空串） |
| `profiles[].skills` | `{ name, description, filePath, source, enabled }[]` | 必填 | v0.6 | 扫描全集 + 启停态（source = user/project/builtin 三层目录标签；v0.8 扩 builtin——daemon 随仓内置技能，不可禁用读面恒 enabled=true） |
| `profiles[].diagnostics` | `{ code, message, path, source }[]` | 必填 | v0.6 | 扫描诊断（坏文件上抛不炸） |
| `profiles[].model` | `string \| null` | 必填 | v0.6 | model 槽位现值（未设 = null） |
| `profiles[].thinkingLevel` | `string \| null` | 必填 | v0.11 | thinking 槽位现值（未配置 = null；v0.11 批内补登 T1.3） |
| `system` | `AgentConfigSystemBlock[]` | 可选 | agent-roster 批 | 只读系统派生块（可见不可编辑）：缺省全量请求时携带（orchestrator 在前序固定）；单 kind 过滤请求不携带；旧客户端可选字段不感知 |
| `system[].profileKind` | `"orchestrator" \| "subagent-kg-writer"` | 必填 | agent-roster 批 | 系统派生 kind（不在写面枚举——写面携带 → `agent.config.read_only` 拒绝） |
| `system[].tools` | `{ name, snippet }[]` | 必填 | agent-roster 批 | 工具清单纯展示（orchestrator = 声明全集；kg-writer = subagent-worker 当前生效集 + pinnedTools，随 worker toggle 动态跟随；无启停位——清单即生效集） |
| `system[].derivedFrom` | `"subagent-worker"` | 可选 | agent-roster 批 | 派生说明位：kg-writer = 派生自 subagent-worker；orchestrator 不携带 |
| `system[].pinnedTools` | `string[]` | 可选 | agent-roster 批 | 派生面恒在工具（kg-writer = ["kg-update"]；orchestrator 不携带） |

#### `agent.config.changed`

资源配置变更广播（v0.6）：daemon 级全局配置——信封 sessionId =
SYSTEM_SESSION_ID，订阅无关全连接下发（与 session.list_changed 同构）。
skills/tools 同构；model 型 name = 模型 id 或 null（clear）。

| 字段 | 类型 | 可选性 | 登记版本 | 语义 |
|---|---|---|---|---|
| `profileKind` | `"main-session" \| "subagent-worker"` | 必填 | v0.6 | 变更归属 kind |
| `resourceType` | `"tool" \| "skill" \| "model" \| "thinking"` | 必填 | v0.6 | 资源类型（thinking = v0.11 批内补登 T1.3） |
| `name` | `string \| null` | 必填 | v0.6 | tools/skills = 资源名；model = 模型 id 或 null（clear） |
| `enabled` | `boolean` | 必填 | v0.6 | tool/skill = 新启停态；model = true（槽位已设）/ false（槽位已清） |

#### `agent.config.set_enabled.result`

启停写面命令结果（点对点回执；全局命令，v0.6）。payload 为判别联合：

| 字段 | 类型 | 可选性 | 登记版本 | 语义 |
|---|---|---|---|---|
| `status` | `"applied" \| "skipped"` | 必填 | v0.6 | 结果判别位 |
| `reason` | `string` | skipped 分支必填 | v0.6 | 跳过原因：unknown-name（tool/skill 名不在全集，不落库）/ unknown-model（目录外模型，ModelService.setModel 先例）等 |

#### `agent.base_prompt.get.result`

base 段系统提示词读面回执（点对点；全局命令，base prompt 批）。payload：

| 字段 | 类型 | 可选性 | 登记版本 | 语义 |
|---|---|---|---|---|
| `profileKind` | `"main-session" \| "subagent-worker" \| "orchestrator" \| "subagent-kg-writer"` | 必填 | v0.11 | 目标 kind |
| `basePrompt` | `string` | 必填 | v0.11 | base 段系统提示词全文（profile 静态声明；工具/技能两段为运行期动态拼入不在本面——生效全量提示词走 trace 快照面观察） |

### 16.5 thinking · compaction · usage 通道族（5）

#### `thinking.stream.delta`

| 字段 | 类型 | 可选性 | 登记版本 | 语义 |
|---|---|---|---|---|
| `instanceId` | `string` | 必填 | v0.1 | 归属实例 |
| `delta` | `string` | 必填 | v0.1 | thinking 流式增量（中间态不落盘，TR-AD-5） |

#### `thinking.completed`

| 字段 | 类型 | 可选性 | 登记版本 | 语义 |
|---|---|---|---|---|
| `entry` | `ThinkingEntryDto` | 必填 | v0.1 | thinking 完成落 Entry（§10.5） |

#### `compaction.completed`

| 字段 | 类型 | 可选性 | 登记版本 | 语义 |
|---|---|---|---|---|
| `entry` | `CompactionEntryDto` | 必填 | v0.1 | compaction 完成（含 usage，AD-9③；§10.5） |
| `tailKept` | `number` | 可选 | v0.2 | 压缩后保留的尾部条目数（尾窗口径对账） |
| `filesCompacted` | `number` | 可选 | v0.2 | 纳入压缩的上下文文件数 |

#### `usage.recorded`

| 字段 | 类型 | 可选性 | 登记版本 | 语义 |
|---|---|---|---|---|
| `instanceId` | `string` | 必填 | v0.1 | 归属实例 |
| `usage` | `UsageDto` | 必填 | v0.1 | 七字段用量（§10.5） |
| `source` | `"turn" \| "compaction"` | 必填 | v0.1 | 来源（turn 完成 / compaction 摘要调用完成；流式中不发） |
| `turnId` | `string` | 可选 | v0.11 | 入账轮次 id（additive，轮末 token 用量显示面）：source=turn 且主线轮次在飞时携带；compaction/SubAgent 入账不携带；缺省 = 旧 daemon 未携带 |

#### `thinking.changed`

会话 thinking 档覆盖生效广播（v0.11，thinking 批①；仿 `model.changed` 广播链：
daemon 处理 `thinking.set` 后经 domain_events 单写队列落盘（TR-AD-5）并广播；
换模（`model.set`）成功后补发一帧——override 不变、effective 按新模型能力
重算，消除 stale 档位；引擎未实现观测面不发）。挂 thinking 族
（type 前缀 == channel 不变量）。前端语义：滑块位置/强调 = `effective`；
`override ≠ effective` 时显示「xhigh → high（模型能力所限）」轻提示（F1.3）。
字符串透传（AD-2：不维护第二份档位枚举；`"off"` = 显式关合法值）。

| 字段 | 类型 | 可选性 | 登记版本 | 语义 |
|---|---|---|---|---|
| `override` | `string \| null` | 必填 | v0.11 | 会话覆盖意图（用户拖到的档）；null = 无覆盖 |
| `effective` | `string \| null` | 必填 | v0.11 | 引擎按当前模型能力解析的生效档；null = 全链不支持（不传参，provider 默认） |

### 16.6 model 族（13；含 model/auth 9 结果帧 + config 2 结果帧——auth/config 结果帧按 EVENT_CHANNELS 挂 model 通道）

#### `model.changed`

运行期换模生效广播（下一 turn 生效）。

| 字段 | 类型 | 可选性 | 登记版本 | 语义 |
|---|---|---|---|---|
| `sessionId` | `string` | 必填 | v0.2 | 目标会话（信封同步携带；payload 内嵌一份供消费者免读信封） |
| `model` | `string` | 必填 | v0.2 | 新模型（"provider/model-id"） |
| `previous` | `string` | 必填 | v0.2 | 旧模型 |
| `effective` | `"next-turn"` | 必填 | v0.2 | 生效时点（恒为下一 turn） |

#### `model.get.result`

会话当前模型命令结果（点对点回执；信封 sessionId = 目标会话 id）。

| 字段 | 类型 | 可选性 | 登记版本 | 语义 |
|---|---|---|---|---|
| `model` | `string` | 必填 | v0.2 | 会话当前模型 |
| `isDefault` | `boolean` | 必填 | v0.2 | 会话模型是否即全局默认 |
| `defaultModel` | `string` | 必填 | v0.2 | 全局默认模型 |

#### `model.catalog.result`

合并目录快照命令结果（点对点回执；信封 sessionId = SYSTEM_SESSION_ID）。

| 字段 | 类型 | 可选性 | 登记版本 | 语义 |
|---|---|---|---|---|
| `models` | `CatalogModel[]` | 必填 | v0.2 | 合并目录（`{ id, providerId, contextWindow, cost, ... }`，types/model.ts） |
| `models[].reasoning` | `boolean` | 必填 | v0.11 | pi-ai Model.reasoning 防腐映射（thinking 批②；false → UI 禁用推理控件） |
| `models[].thinkingLevels` | `string[]` | 必填 | v0.11 | pi-ai thinkingLevelMap 非 null 键集派生（升序；reasoning=false 时为空数组；字符串透传 AD-2） |
| `refreshedAt` | `number` | 必填 | v0.2 | 上次远端核对时间（epoch ms；无 overlay 历史 → 0） |
| `source` | `"cache" \| "builtin" \| "remote"` | 必填 | v0.2 | 快照数据来源 |

#### `model.catalog_refresh.result`

强制刷新快照 + 降级明细（点对点回执；全局命令）。

| 字段 | 类型 | 可选性 | 登记版本 | 语义 |
|---|---|---|---|---|
| `models` | `CatalogModel[]` | 必填 | v0.2 | 同 `model.catalog.result` |
| `refreshedAt` | `number` | 必填 | v0.2 | 同上 |
| `source` | `"cache" \| "builtin" \| "remote"` | 必填 | v0.2 | 同上 |
| `degraded` | `string[]` | 必填 | v0.2 | 拉取失败的 provider 明细（全部成功 = 空数组；快照仍可用） |

#### `model.set_default.result`

| 字段 | 类型 | 可选性 | 登记版本 | 语义 |
|---|---|---|---|---|
| `previous` | `string` | 必填 | v0.2 | 变更前全局默认 |

#### `model.get_default.result`

| 字段 | 类型 | 可选性 | 登记版本 | 语义 |
|---|---|---|---|---|
| `model` | `string` | 必填 | v0.2 | 全局默认模型（SQLite 读面，builtin 兜底） |
| `thinkingDefault` | `string \| null` | 可选 | R7 | 全局默认推理强度（null = 未配置；旧 daemon 不携带按 null 处理） |

#### `model.set_thinking_default.result`

| 字段 | 类型 | 可选性 | 登记版本 | 语义 |
|---|---|---|---|---|
| `previous` | `string \| null` | 必填 | R7 | 变更前全局默认推理强度（null = 未配置） |

#### `config.get_compaction.result`

| 字段 | 类型 | 可选性 | 登记版本 | 语义 |
|---|---|---|---|---|
| `reserveTokens` | `number` | 必填 | config | 压缩预留余量 |
| `keepRecentTokens` | `number` | 必填 | config | 保留最近 token 数 |

#### `config.set_compaction.result`

| 字段 | 类型 | 可选性 | 登记版本 | 语义 |
|---|---|---|---|---|
| `reserveTokens` | `number` | 必填 | config | 写后的压缩预留余量 |
| `keepRecentTokens` | `number` | 必填 | config | 写后的保留最近 token 数 |

#### `auth.list.result`

| 字段 | 类型 | 可选性 | 登记版本 | 语义 |
|---|---|---|---|---|
| `providers` | `AuthProviderInfo[]` | 必填 | v0.2 | provider 全集 × 凭据状态（脱敏：`{ providerId, configured, keyMasked?, verifiedAt?, ... }`，types/auth.ts） |

#### `auth.set_key.result`

| 字段 | 类型 | 可选性 | 登记版本 | 语义 |
|---|---|---|---|---|
| `keyMasked` | `string` | 必填 | v0.2 | 写入回执（掩码形式，如 `····7f3a`） |

#### `auth.delete_key.result`

| 字段 | 类型 | 可选性 | 登记版本 | 语义 |
|---|---|---|---|---|
| （无字段） | `Record<string, never>` | — | v0.2 | 成功回执即帧本身（无数据体） |

#### `auth.verify.result`

连通验证回执（点对点；fail 为正常结果非 error）。payload 为判别联合：

| 字段 | 类型 | 可选性 | 登记版本 | 语义 |
|---|---|---|---|---|
| `status` | `"ok" \| "fail"` | 必填 | v0.2 | 验证结果判别位 |
| `latencyMs` | `number` | ok 分支必填 | v0.2 | 探活延迟（status="ok" 时存在） |
| `reason` | `string` | fail 分支必填 | v0.2 | 失败原因（status="fail" 时存在） |

### 16.7 trace 族（1）

#### `trace.query.result`

trace 查询命令结果（点对点回执；信封 sessionId = 目标会话 id；channel =
"trace"）。语义判据（含起含止 / 空数组即空结果 / limit 钳制 / hasMore /
total / 模型同源）见 §13.4。

| 字段 | 类型 | 可选性 | 登记版本 | 语义 |
|---|---|---|---|---|
| `filterEcho` | `TraceQueryFilterEcho` | 必填 | v0.4 | 实际生效过滤条件回显（normalize 后形态；缺省维归一 null） |
| `instances` | `TraceInstanceRecord[]` | 必填 | v0.4 | 实例面板摘要块（会话级 fold，不受 events 过滤维影响） |
| `events` | `TraceEventRow[]` | 必填 | v0.4 | 本页事件行（id 降序 = 最新在前） |
| `page.loaded` | `number` | 必填 | v0.4 | 本页实载行数 |
| `page.total` | `number` | 必填 | v0.4 | 同过滤条件（不含游标/限量）总行数 |
| `page.hasMore` | `boolean` | 必填 | v0.4 | rows.length === limit（恰整除时末页多一次空载，记录在案） |

### 16.8 web 族（4；v0.7 T4 联网状态图标 + v0.9 T7 显式启动通路）

#### `web.status.result`

CDP 连接状态查询命令结果（点对点回执；信封 sessionId = SYSTEM_SESSION_ID；
全局命令，v0.7）。域形状与 daemon BrowserPort 的 BrowserStatus / TabInfo
对齐；idle/error（缓存已清）时 browser 缺席；tabs 恒为数组（未连接 = 空）。

| 字段 | 类型 | 可选性 | 登记版本 | 语义 |
|---|---|---|---|---|
| `state` | `"idle" \| "connecting" \| "connected" \| "error"` | 必填 | v0.7 | 连接状态四态 |
| `browser` | `{ id, label, port }` | 可选 | v0.7 | 已连接浏览器标识（connected 时携带；idle/error 缺席） |
| `tabCount` | `number` | 必填 | v0.7 | 受管 tab 数（managedTabs 口径，非浏览器全部 tab） |
| `error` | `string` | 可选 | v0.7 | state="error" 时的最近错误说明 |
| `tabs` | `WebTabDto[]`（`{ tabId, ownerId, url, title, lastAccessed }`） | 必填 | v0.7 | 受管 tab 清单快照（未连接 = 空数组；lastAccessed = epoch ms） |

#### `web.stop.result`

手动停止写面命令结果（点对点回执；全局命令，v0.7）。幂等——未连接时
stop 安全 no-op 仍 applied。

| 字段 | 类型 | 可选性 | 登记版本 | 语义 |
|---|---|---|---|---|
| `status` | `"applied"` | 必填 | v0.7 | 结果判别位（停止已执行） |

#### `web.status.changed`

CDP 连接状态变更广播（v0.7）：daemon 级全局——信封 sessionId =
SYSTEM_SESSION_ID，订阅无关全连接下发（与 agent.config.changed 同构）。
触发时机 = 连接成功/断开/tab 增减/error 四时机（BrowserPort
onStatusChange 事件源）。payload 与 `web.status.result` 同形状（含
tabs——popover 清单实时数据源）。

| 字段 | 类型 | 可选性 | 登记版本 | 语义 |
|---|---|---|---|---|
| `state` | `"idle" \| "connecting" \| "connected" \| "error"` | 必填 | v0.7 | 连接状态四态 |
| `browser` | `{ id, label, port }` | 可选 | v0.7 | 已连接浏览器标识（connected 时携带；idle/error 缺席） |
| `tabCount` | `number` | 必填 | v0.7 | 受管 tab 数（managedTabs 口径） |
| `error` | `string` | 可选 | v0.7 | state="error" 时的最近错误说明 |
| `tabs` | `WebTabDto[]`（`{ tabId, ownerId, url, title, lastAccessed }`） | 必填 | v0.7 | 受管 tab 清单快照（popover 实时数据源） |

#### `web.start.result`

显式启动写面命令结果（v0.9，T7；点对点回执；信封 sessionId =
SYSTEM_SESSION_ID；全局命令）。两判别：applied = 建连成功/已连接幂等
（BrowserPort.connect() 幂等语义直通）；skipped = 未发现可用浏览器，
reason 含引导用户开 remote debugging 的说明（daemon browser-discovery
错误文案同源）。状态回流（idle → connecting → connected/error）经
`web.status.changed` 广播，不在本帧重复。

| 字段 | 类型 | 可选性 | 登记版本 | 语义 |
|---|---|---|---|---|
| `status` | `"applied" \| "skipped"` | 必填 | v0.9 | 结果判别位 |
| `reason` | `string` | 可选 | v0.9 | status="skipped" 时携带：未发现可用浏览器的说明 + remote debugging 引导 |

### 16.9 kg 族（6+5+2+1+1+1+1；kg 批 + kg-bootstrap 批 + kg 维护批 + kg.health 批 + kg 评审批 + kg.candidates.list 批 + code.review.create 批，iter-20260825-11fo T5.3 / iter-20260829-ys7q T3.2 / C1 / W2-E / W2-F / 台账读面三件套 / code-review v1.5）

> 六命令的点对点回执结果帧（TR-AD-21 模式；仅发发起命令的连接，不经
> EventStream 广播）。信封 sessionId = SYSTEM_SESSION_ID、channel =
> "kg"。O-6 轮询裁决零推送事件——本族无广播事件，索引进度走
> `kg.index.status` 命令轮询。命令面登记见 §15.9；响应形状逐字段契约 =
> `docs/iterations/iter-20260825-11fo/development/contracts/kg-viewer-api.md`。
> DTO 定义 = `src/types/kg.ts`（KgProjectRow / KgNodeListRow / KgNodeDetailDto /
> KgChangeReportDto / KgIndexStatusDto；AD-16 引用规范数据层强制：人类可读
> 字段无 TR-n/E-n 裸 id）。错误回执走 connection.error（§19 四个
> KG_E_* 错误码；连接保持）。

#### `kg.projects.result`

workspace 项目列表命令结果（点对点回执；只读；宽松口径全入列含 absent）。

| 字段 | 类型 | 可选性 | 登记版本 | 语义 |
|---|---|---|---|---|
| `projects` | `KgProjectRow[]`（`{ name, path, status, symbolCount?, nodeCount?, syncedAt?, degradedNote?, bootstrapRunning?, reviewRunning? }`） | 必填 | kg 批 | name/path = project 入参两形态；status 四态；synced 态携带计数与时间，degraded 态携带说明；bootstrapRunning（P0① 批）= 该项目存在非终态 kg-bootstrap job（缺省 = 无，旧 daemon 兼容）——入口卡 running 态数据源；reviewRunning 同规 = 非终态 kg-review job——体检面板「发起语义体检」钮运行态数据源 |

#### `kg.list.result`

节点列表+搜索命令结果（三路过滤叠加；q×kind×status）。

| 字段 | 类型 | 可选性 | 登记版本 | 语义 |
|---|---|---|---|---|
| `total` | `number` | 必填 | kg 批 | 项目内全部节点数（过滤前） |
| `matched` | `number` | 必填 | kg 批 | 过滤后命中数 |
| `nodes` | `KgNodeListRow[]`（`{ id, name, kind, domain, status, digest }`） | 必填 | kg 批 | 列表行（id 仅 data-id 跳转；domain null = 未声明） |

#### `kg.node.detail.result`

节点详情六段聚合命令结果（payload 即详情本体）。

| 字段 | 类型 | 可选性 | 登记版本 | 语义 |
|---|---|---|---|---|
| `id` / `name` / `kind` / `domain` / `status` / `digest` | 基础字段 | 必填 | kg 批 | 节点基础（domain null = 未声明） |
| `desc` | `string` | 必填 | kg 批 | 描述（body 叙述段） |
| `rules` | `string[]` | 必填 | kg 批 | 规则条目（body 列表条目行） |
| `anchors` | `KgAnchorRow[]`（`{ symbol?, path, line?, state }`） | 必填 | kg 批 | 锚点：state=ok/dead（⚠ 失效）/stale（? 长期无命中，启发式） |
| `relations` | `KgRelationRow[]`（`{ verb, peer: KgNodeRefDto }`） | 必填 | kg 批 | 关系（对方节点引用可跳转） |
| `supersede.history` | `KgNodeRefDto[]` | 必填 | kg 批 | 取代链历史项（旧→新） |
| `supersede.current` | `KgNodeRefDto` | 必填 | kg 批 | 现行项 |
| `log` | `KgLogRow[]`（`{ date, iterationId, eventText }`） | 必填 | kg 批 | 变更日志，最新在上 |

#### `kg.change.report.result`

知识变化报告命令结果（payload 即报告本体；四类条目）。

| 字段 | 类型 | 可选性 | 登记版本 | 语义 |
|---|---|---|---|---|
| `iterationId` | `string` | 必填 | kg 批 | 聚合迭代 id（缺省入参 = 当前迭代回显） |
| `entries` | `KgReportEntryDto[]`（`{ kind, sev, label, body, refs, options }`） | 必填 | kg 批 | 四类：dead_anchor/rule_conflict/suspect_stale/knowledge_change；body 事件导向因果叙述（疑似类含限定词） |

#### `kg.node.confirm.result`

draft 审阅转正命令结果（页面唯一写动作回执；翻转后状态回读）。

| 字段 | 类型 | 可选性 | 登记版本 | 语义 |
|---|---|---|---|---|
| `applied` | `true` | 必填 | kg 批 | 结果判别位（恒 true；失败走 error 帧） |
| `node` | `KgNodeListRow` | 必填 | kg 批 | 翻转后节点行（status=confirmed） |

#### `kg.index.status.result`

索引状态面板命令结果（四态互斥；轮询通道本体）。

| 字段 | 类型 | 可选性 | 登记版本 | 语义 |
|---|---|---|---|---|
| `state` | `"absent" \| "building" \| "synced" \| "degraded"` | 必填 | kg 批 | 索引四态 |
| `progress` | `{ done, total }` | 可选 | kg 批 | building 态符号进度（sync 管道单事务不可分，暂缺省） |
| `syncedAt` | `string` | 可选 | kg 批 | synced 态完成时间（ISO） |
| `symbolCount` | `number` | 可选 | kg 批 | synced 态符号计数 |
| `degradedNote` | `string` | 可选 | kg 批 | degraded 态影响说明 |
| `orphanNote` | `string` | 可选 | W2-D | R14：手动 sync（rebuild=true）后 orphan>0 随行体检提示行（只提示不处置；服务层人读文案前端直渲 toast 副行） |

#### `kg.bootstrap.create.result`

bootstrap 任务创建回执（点对点；T3.2 kg-bootstrap 批）。

| 字段 | 类型 | 可选性 | 登记版本 | 语义 |
|---|---|---|---|---|
| `ok` | `true` | 必填 | kg-bootstrap 批 | 判别位（失败走 connection.error） |
| `jobId` | `string` | 必填 | kg-bootstrap 批 | 任务 id（前端引导「前往『任务』页观察」） |

#### `kg.bootstrap.produce.result`

产出三级分组回执（点对点；payload 即分组本体）。

| 字段 | 类型 | 可选性 | 登记版本 | 语义 |
|---|---|---|---|---|
| `groups` | `KgProduceGroupDto[]` | 必填 | kg-bootstrap 批 | 任务→阶段→批次分组（jobId/title/stages{layer,name,batches{batchId,scope,nodes}}）；node = KgProduceNodeDto（nodeId/name/kind/status/digest/body/anchors/rationale/origin/supersedeReason?） |

#### `kg.node.update.result`

节点修改回执（点对点；节点保持 confirmed）。

| 字段 | 类型 | 可选性 | 登记版本 | 语义 |
|---|---|---|---|---|
| `ok` | `true` | 必填 | kg-bootstrap 批 | 判别位 |
| `node` | `KgProduceNodeDto` | 必填 | kg-bootstrap 批 | 修改后状态回读（产出条目投影） |

#### `kg.node.supersede.result`

节点 supersede 回执（点对点；留史降档）。

| 字段 | 类型 | 可选性 | 登记版本 | 语义 |
|---|---|---|---|---|
| `ok` | `true` | 必填 | kg-bootstrap 批 | 判别位（change_log 已记理由） |

#### `kg.bootstrap.impact.result`

受影响连带推导回执（点对点；只读零写）。

| 字段 | 类型 | 可选性 | 登记版本 | 语义 |
|---|---|---|---|---|
| `affected` | `KgNodeRefLiteDto[]`（`{ nodeId, name, kind, digestFirstLine }`） | 必填 | kg-bootstrap 批 | 引用方集合（AD-16 同规；nodeId 仅 data-id 键） |
| `count` | `number` | 必填 | kg-bootstrap 批 | 引用方计数（toast 告知数量） |

#### `kg.graph.purge.result`

清空图谱回执（C1 kg 维护批，点对点；全表清零计数 + 索引态已复位 absent）。

| 字段 | 类型 | 可选性 | 登记版本 | 语义 |
|---|---|---|---|---|
| `purged` | `true` | 必填 | kg 维护批 | 判别位（kg 库已全量清零） |
| `nodesRemoved` | `number` | 必填 | kg 维护批 | 清除的知识节点行数（含 superseded 留史行） |
| `symbolsRemoved` | `number` | 必填 | kg 维护批 | 清除的符号行数（符号面基准一并清零） |
| `filesRemoved` | `number` | 必填 | kg 维护批 | 清除的文件基准行数 |

#### `kg.index.delete.result`

删除索引回执（C1 kg 维护批，点对点；.codegraph 已删 + 状态复位 absent +
watcher 已停）。

| 字段 | 类型 | 可选性 | 登记版本 | 语义 |
|---|---|---|---|---|
| `deleted` | `true` | 必填 | kg 维护批 | 判别位（.codegraph 目录已删除） |
| `state` | `"absent"` | 必填 | kg 维护批 | 删除后索引态（恒 absent——状态机自洽断言位） |
| `watcherStopped` | `boolean` | 必填 | kg 维护批 | fs-watch watcher 已停（stopWatching 接缝消费确认） |

#### `kg.health.result`

结构体检读面回执（W2-E kg.health 批，点对点；payload = `KgHealthDto`——
conflicts / orphans / orphanCount / index / candidates 五项聚合）。

| 字段 | 类型 | 可选性 | 登记版本 | 语义 |
|---|---|---|---|---|
| `conflicts` | `KgHealthConflictDto[]`（`{ kind, summary }`） | 必填 | kg.health 批 | 逻辑冲突条目（mutual_governs / self_loop / unknown_verb；summary 人读） |
| `orphans` | `KgHealthOrphanDto[]`（`{ kind, summary }`） | 必填 | kg.health 批 | 孤儿条目（dead_anchor / orphan_node；summary 人读） |
| `orphanCount` | `number` | 必填 | kg.health 批 | 孤儿+腐烂锚合计计数（徽章数据源） |
| `index` | `KgIndexStatusDto` | 必填 | kg.health 批 | 索引状态（kg.index.status 数据复用） |
| `candidates` | `KgHealthCandidatesDto`（`{ pending, deferred, applied, discarded }`） | 必填 | kg.health 批 | candidates 台账四态计数 |

#### `kg.review.create.result`

体检任务创建回执（W2-F kg 评审批，点对点；前端引导「前往『任务』页观察 →」）。

| 字段 | 类型 | 可选性 | 登记版本 | 语义 |
|---|---|---|---|---|
| `ok` | `true` | 必填 | kg 评审批 | 判别位（失败走 connection.error） |
| `jobId` | `string` | 必填 | kg 评审批 | 任务 id（kg-review 任务；产出走 candidates 台账人审） |

#### `kg.candidates.list.result`

候选台账列表回执（kg.candidates.list 批，点对点；payload = `KgCandidatesListDto`——
status 过滤后行集 + 全集计数；unbound = 空集非报错）。

| 字段 | 类型 | 可选性 | 登记版本 | 语义 |
|---|---|---|---|---|
| `total` | `number` | 必填 | kg.candidates.list 批 | 过滤后全集计数（分页不改变） |
| `rows` | `KgCandidateRowDto[]`（`{ id, title, status, kind, targetNode, deferAge, createdAt, body }`） | 必填 | kg.candidates.list 批 | 台账行（最新在前；body 全文——选中行展开详情数据源；targetNode = 修改/废弃候选的目标节点定位，新增候选 null） |

#### `code.review.create.result`

代码评审任务创建回执（code.review.create 批，点对点，挂既有 kg 通道；
kg.review.create.result 同形）。

| 字段 | 类型 | 可选性 | 登记版本 | 语义 |
|---|---|---|---|---|
| `ok` | `true` | 必填 | code.review.create 批 | 判别位（失败走 connection.error） |
| `jobId` | `string` | 必填 | code.review.create 批 | 任务 id（code-review 任务；产出走任务报告/阶段产物，不进台账） |

### 16.10 workspace 族（3；workspace 批，W1 workspace 绑定闭环）

> 两命令点对点回执 + 一广播。信封 sessionId = SYSTEM_SESSION_ID、channel
> = "workspace"。命令面登记见 §15.10。DTO 定义 = `src/types/workspace.ts`
>（WorkspaceRecent）；projects 行复用 `src/types/kg.ts` KgProjectRow。错误
> 回执走 connection.error（§7 三码：WORKSPACE_E_INVALID_ROOT /
> WORKSPACE_E_ACTIVE_AGENT / workspace.unbound；连接保持）。

#### `workspace.get.result`

绑定门禁读面命令结果（点对点回执；快照语义）。

| 字段 | 类型 | 可选性 | 登记版本 | 语义 |
|---|---|---|---|---|
| `current` | `{ root: string } \| null` | 必填 | workspace 批 | 当前绑定（realpath 规范形）；null = 未绑定 |
| `recents` | `WorkspaceRecent[]`（`{ root, name, lastUsedAt, valid }`） | 必填 | workspace 批 | 最近使用（MRU 序上限 8；valid = get 时惰性探测，失效不删除） |
| `notice` | `string` | 可选 | workspace 批 | 降级说明（恢复失败等；无降级缺席） |

#### `workspace.open.result`

绑定写面命令结果（点对点回执）。

| 字段 | 类型 | 可选性 | 登记版本 | 语义 |
|---|---|---|---|---|
| `root` | `string` | 必填 | workspace 批 | 绑定后的规范形根 |
| `projects` | `KgProjectRow[]` | 必填 | workspace 批 | 新 root 一层扫描项目行（宽松口径含 absent；与 kg.projects 同 DTO 口径） |

#### `workspace_changed`

绑定变更广播（open 成功/同 root 幂等重开均广播一次——前端各域刷新依据；
全连接下发，信封 sessionId = SYSTEM_SESSION_ID）。

| 字段 | 类型 | 可选性 | 登记版本 | 语义 |
|---|---|---|---|---|
| `root` | `string` | 必填 | workspace 批 | 变更后绑定根（规范形） |

## 17. SoT 声明与守护口径（v0.5 收口）

### 17.1 SoT 声明

**本文档是 Helix WS 契约的唯一事实源（SoT）**：27 命令 / 47 事件的 payload
形状全部登记正文（§15 / §16），仓外契约文档（iter-20260816-6q6f /
iter-20260819-erio 的 `development/contracts/`）降为**历史定形档案**，不再
作为实现规范依据——§12 起「契约 SoT 归本文档」的口头声明自此由机械口径
兜底（AD-4 选项 B 全量回迁收口）。类型权威源 = `packages/protocol` TS 定义
（仓内禁止平行手写协议类型，AD-8 / AG-13）；文档与类型逐项对齐，运行时
行为零变更（AD-1）。

### 17.2 登记纪律（TR-AD-26 ①② 律）

- **① payload 形状正文登记律**：新增 / 变更命令·事件·payload 字段（含
  additive 可选字段，TR-AD-23① 口径）必须**同 commit** 在 §15/§16 落
  `#### \`<type>\`` 锚 + 字段行（含可选性、缺省语义与登记版本）；禁止委托
  仓外文档或「以代码为文档」。新增命令/事件不同步登记即守护红（断言②③）。
- **② 版本位单点律**：`PROTOCOL_VERSION` 唯一定义于
  `packages/protocol/src/envelope.ts`；任何脚本 / 文档 / 测试引用版本一律
  从单点读或由断言守护，禁止手写字面量（perf-a11y `V = "0.3"` 漂移为
  登记在案反例，F(2).1 已修为单点读取）。
- 版本批次语义（一次定形、批次集合标记非协商位）归 TR-AD-23②：§14 微批
  字段（welcome.draft / chat.send.model / chat.send.draft）随 v0.5 批次
  定形登记，本批零新增命令/事件（22/40 计数不变）。

### 17.3 sot-consistency 断言口径（五条）

落位 `packages/protocol/test/type-surface/sot-consistency.test.ts`
（T2.4；断言粒度 = presence 级，文档 ↔ 代码不一致即红）：

1. **版本位一致**：本文档标题行与 §3 代码块中的版本字面量 ==
   `PROTOCOL_VERSION` 导出值（防版本字面量漂移的文档面复发）。
2. **类型 presence**：`COMMAND_TYPES` / `EVENT_TYPES` 每个字面量在 §15/§16
   有对应 `#### \`<type>\`` 登记锚（新增命令/事件不登记即红）。
3. **计数一致**：§15/§16 计数声明行（22 命令全集 / 40 事件全集）== 常量
   目录长度（后续演进随断言同步）。
4. **additive 字段 presence**：v0.3/v0.4/§14 批次新增可选字段
   （anchorEntryId / tier / instanceId / draft / model）在登记表中有字段行
   （防 draft 零登记复发）。
5. **通道归属一致**：§16 各族小节内的事件 type 集合 == `EVENT_CHANNELS`
   对应通道值域（防文档族结构与代码类型学漂移）。

### 17.4 生成式基建边界（AD-4 选项 C 转池声明）

字段级逐形状 diff（文档表 ↔ TS 接口全字段等价比较）属**生成式文档工具**
（AD-4 选项 C），已裁决**转池不做**；本期断言粒度 = 类型 presence + 版本位
+ 计数 + 关键字段 presence（§17.3），以最小成本把 SoT 声明变成红绿事实。


> **§17.5 起的批次登记（v0.5–v0.11，含当前批 §17.11）与 §18–§23 additive
> 微批备案已迁 PROTOCOL-CHANGELOG.md**（原节号保留；§17.4 为本节末尾）。
> 登记纪律（批次备案同 commit 落 CHANGELOG）见 §17.2。
