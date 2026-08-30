# Helix WS 协议 v0.11

> 当前版本位 `PROTOCOL_VERSION = "0.11"`（envelope.ts）；§1–§9 为 v0 基线，
> §10–§14 为 v0.1–v0.4 演进登记与微批备案（历史批）；
> §15–§17 为现状全集总登记（28 命令 / 48 事件 payload 形状）与 SoT 守护口径
>（v0.11 = 当前，见 §17.11）。

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
| `task.not_found` | task 批：jobId 不存在（detail/artifacts/生命周期命令） | 发 error 帧，**连接保持** |
| `task.invalid_state` | task 批：生命周期/删除的非法当前态（判断收口引擎 T1.3，handler 透传） | 发 error 帧，**连接保持** |
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

## 10. v0.1 additive 演进（协议 v0.1；版本位不 bump）

> 本章为 v0.1 additive 追加（集成契约 `contracts/protocol-v0.1.md`；迭代
> iter-20260816-uzvg）。**版本位不 bump**：`PROTOCOL_VERSION = 0` 保持
> （0.1 语义；破坏性变更才 bump，TR-AD-18）。§1–§9 为 v0 基线，**零改动**：
> 既有 5 命令 / 12 事件的 type 字面量与 payload 形状一律不动，全部新成员
> 只追加；既有消费方（daemon / shell / e2e harness）不改动仍编译通过
> （additive 兼容）。

### 10.1 标识空间与 instanceId 缺省语义（AD-3）

- **instanceId ≡ agentId**：同一标识空间的两个视角——编排事件族（`agent.*`）
  用字段名 `agentId`；通道事件（thinking / compaction / usage）与 Entry 归属
  用字段名 `instanceId`。前端 reducer 统一按同一 id 处理。
- **分配格式（O-4 裁决建议，T1.2 定稿；T10 统一改写，见 §17.11）**：本批
  登记 = 主实例固定 `main`；SubAgent = `agent-N`（daemon 内递增序号；
  持久化基线取 `agent_lifecycle` 已有 max(N)+1，重启不重复、剧本可预期）。
  **现行契约（T10 实例 ID 统一后）**：所有实例（含 main）instanceId =
  `agent-<唯一串>`（daemon 单点生成，session id 同款 UUID hex 形态）；
  main/subagent 区分由 kind 承载（`AgentInstanceDto.kind` / trace 面
  `agentKind`），instanceId 值判等退役；历史行/历史帧字面 `"main"` =
  legacy 主实例（只读兼容，读侧推断）。
- **信封 `instanceId?`**（§3 信封新增可选字段，**仅事件侧使用**）：
  **现行契约（T10 起）：daemon 写侧全实例显式携带**——main 实例的事件/
  DTO 同样携带 `agent-<唯一串>`，不再依赖省略优化；**缺省或字面 `"main"`
  = legacy 主实例（读侧推断语义，兼容历史事件/历史快照；写侧不再产出）**。
  本批登记形态（历史）：v0 事件族（`chat.stream.delta` 等）主线事件
  不携带即归属主线；v0.1 通道族主线事件（`usage.recorded` /
  `compaction.completed` / `thinking.completed` / `thinking.stream.delta`）
  由 daemon 显式携带 `instanceId: "main"`（线格式两种形态均合法，
  前端等价处理）；SubAgent 实例的事件携带对应 instanceId，前端按 id 分流投影
  （主线增量进消息流；SubAgent 增量只更新卡片 streaming 摘要行，不进消息流）。
  命令不携带实例维度（`agentId` 在 payload 内）。
  （v0.2 措辞修正回填：本条原文「主线事件缺省不挂 instanceId」对 v0.1
  通道族不精确——OI-5 处置，iter-20260816-6q6f T1.2。T10 契约改写备案：
  「缺省 = 主实例」降格为读侧 legacy 推断，写侧全实例显式携带——
  §17.11 T10 批内补登。）

### 10.2 命令目录 v0.1（5 → 8）

新增 3 个编排命令（payload 均为 `{ agentId: string }`）：

| type | payload 类型 | payload | 语义 | 错误模型 |
|---|---|---|---|---|
| `agent.kill` | `AgentKillPayload` | `{ agentId }` | 用户终止实例（抽屉 kill 两步确认后发送） | 目标不存在 / 已终态 → `connection.error` 回执（message 中文说明）；正常 → `agent.killed` 事件 |
| `agent.subscribe` | `AgentSubscribePayload` | `{ agentId }` | 订阅实例全流（v0.1 通路语义，§10.6-①） | 同 `session.subscribe` 现状口径 |
| `agent.unsubscribe` | `AgentUnsubscribePayload` | `{ agentId }` | 退订实例全流（同上） | 同上 |

- 完整命令目录（8 个）：§4 的 5 个（`chat.send` / `chat.steer` / `chat.abort` /
  `session.subscribe` / `session.unsubscribe`）+ 上述 3 个。
- 联合类型 `CommandEnvelope` 与目录常量 `COMMAND_TYPES` 同步扩（三层一致性
  由守护测试守护：类型级双向 Equal + switch 穷尽 + 运行时目录恰等）。

### 10.3 事件目录 v0.1（12 → 23）

**编排生命周期族（7 个）**：

| type | payload 类型 | payload | 语义 |
|---|---|---|---|
| `agent.spawned` | `AgentSpawnedPayload` | `{ agentId, task, profileKind, model? }` | spawn 工具秒回出卡（不等执行） |
| `agent.queued` | `AgentQueuedPayload` | `{ agentId, position }` | 超限入队；position 随出队递减重发 |
| `agent.started` | `AgentStartedPayload` | `{ agentId }` | 出队 / 预算内直跑 |
| `agent.stalled` | `AgentStalledPayload` | `{ agentId, idleMs }` | idle>阈值无事件增量（警示不自动杀；可再次发生） |
| `agent.completed` | `AgentCompletedPayload` | `{ agentId, closure }` | 自然收口 done |
| `agent.failed` | `AgentFailedPayload` | `{ agentId, error, closure }` | 崩溃/异常收口 failed（closure.status="failed"） |
| `agent.killed` | `AgentKilledPayload` | `{ agentId, closure }` | 用户 kill 收口（closure.status="failed"，lifecycle terminated） |

**通道族（4 个）**：

| type | payload 类型 | payload | 语义 |
|---|---|---|---|
| `thinking.stream.delta` | `ThinkingStreamDeltaPayload` | `{ instanceId, delta }` | thinking 流式增量（中间态不落盘，TR-AD-5） |
| `thinking.completed` | `ThinkingCompletedPayload` | `{ entry: ThinkingEntryDto }` | thinking 完成落 Entry |
| `compaction.completed` | `CompactionCompletedPayload` | `{ entry: CompactionEntryDto }` | compaction 完成（含 usage） |
| `usage.recorded` | `UsageRecordedPayload` | `{ instanceId, usage: UsageDto, source: "turn"\|"compaction" }` | turn 完成 / compaction 摘要调用完成（流式中不发） |

- 三个终态事件（completed / failed / killed）都携带完整 `ClosureDto`
  （前端卡片 / 抽屉 closure 卡同源同构）。
- 完整事件目录（23 个）：§5 的 12 个 + 上述 11 个；`EventEnvelope` 联合与
  `EVENT_TYPES` 常量同步扩（三层一致性守护同上）。
- 命名说明：计划文字中的「agent.running」统一为 **`agent.started`**（与架构
  §3、test-design S1、原型状态模型一致——`agent.started` 触发卡片 running 态）。

### 10.4 ClosureDto（AD-8，承接 v1 结构）

```ts
interface ClosureDto {
  status: "done" | "failed";
  summary: string;
  reportPath?: string | null;   // 缺失字段显式 null（全字段必发纪律，test-design §4.3）
  findings?: unknown[] | null;  // v2 重生长时接 kg；本迭代透传
  taskId?: string | null;
}
```

- 类型层为 `?: ... | null`；**线格式全字段必发**——缺失时显式发 `null`，
  不允许字段缺席（daemon 侧义务）。

### 10.5 EntryDto 联合与快照 additive 字段

- **EntryDto 四成员**：`message | tool-call | thinking | compaction`
  （v0 的 message / tool-call 两变体形状不动）；`MessageEntryDto` /
  `ToolCallEntryDto` 增可选 `instanceId?: string`（T10 起写侧显式携带；
  缺省 = legacy 主实例读侧推断，兼容历史快照）。
- **ThinkingEntryDto**：`{ kind:"thinking", id, instanceId, text, durationMs,
  reasoningTokens, createdAt }`（text = 完成态全文；流式走
  `thinking.stream.delta`）。
- **CompactionEntryDto**：`{ kind:"compaction", id, instanceId, tokensBefore,
  tokensAfter, summary, usage: UsageDto, createdAt }`（tokensAfter = 压缩后
  上下文 tokens，原型「340k→20k」的 20k；usage = 摘要调用成本，AD-9③）。
- **SessionSnapshotDto 增可选字段**：`instances?: AgentInstanceDto[]`（重启
  恢复卡片 / 抽屉骨架）与 `usage?: SessionUsageDto`（账目聚合）；缺省 =
  未携带（旧剧本兼容）。
- **AgentInstanceDto**：`{ instanceId, kind: "main"|"subagent", profileKind,
  state: InstanceState, task?, model?, queuedPosition?, createdAt, closure?,
  usage? }`；主/子区分由 `kind` 承载（T10 起主实例 instanceId =
  `agent-<唯一串>`；历史快照字面 `"main"` = legacy 只读兼容）；
  `queuedPosition` 仅 state=queued 携带。
- **InstanceState** = `"queued" | "running" | "done" | "failed" | "cancelled"`
  （cancelled 仅重启恢复时 queued 收口使用，AD-10）。
- **UsageDto 七字段**（pi Usage 防腐映射，cost 拍平为 number）：`{ input,
  output, cacheRead, cacheWrite, reasoning, totalTokens, cost }`；
  **SessionUsageDto** = `{ total: UsageDto, compaction: UsageDto }`（total =
  各实例行合计徽标值，数字自洽；compaction = 摘要小计独立行 + 归属说明）。
- 落盘不涉协议：持久化走领域事件与行模型（TR-AD-14 兜底），协议 DTO 不直接落盘。

### 10.6 v0.1 设计取舍记录（三条）

1. **订阅路由最小化**：`agent.subscribe` / `agent.unsubscribe` 为**通路语义**
   （daemon 记录订阅表、EventStream 数据结构加 instance 维度），但**不做事件
   过滤**——全部事件广播携带 instanceId，前端按 id 分流投影；按需过滤路由
   （F-3⑤ 完整体）留 M3 多会话时兑现。理由：M2 单用户本地，全广播零带宽
   压力；避免 daemon 侧路由复杂度先于多会话需求。
2. **kill 终态语义**：kill → `agent.killed`（closure failed）**单一终态事件**；
   卡片渲染 failed 态 + 「terminated」lifecycle 交代（P-2），不引入独立
   killed 卡片态（卡片状态机四态不变）。
3. **stalled 可重复**：`agent.stalled` 非状态迁移（实例仍 running），可随
   idle 持续再次推送；前端仅 running 态显示徽标。

## 11. v0.2 登记批（协议 v0.2；一次 bump）

> 本章为 v0.2 登记（迭代 iter-20260816-6q6f T1.2；集成契约
> `development/contracts/protocol-v0.2-envelope.md` + `session-commands.md` +
> `model-auth-commands.md`——三契约为历史定形档案（仓外参考）；实现规范以
> 本文档为准（§15/§16 现状全集 + 本节演进备案））。
> **版本位 bump**：`PROTOCOL_VERSION = "0.2"`（§10 的「版本位不 bump」口径
> 至 v0.1 为止；v0.2 起版本位为字符串）。handshake 严格单值 fail-fast：
> `protocolVersion ≠ "0.2"` 即 `protocol.version_unsupported` 拒绝。

### 11.1 帧信封分型（envelope.ts）

- C→S `CommandFrame` / S→C `EventFrame`（v0 的共用 `Envelope` 拆分）。
- **命令信封 sessionId 路由位**（AD-4，可选）：会话作用域命令必填
  （chat.* / session.loadHistory / session.delete / session.subscribe /
  model.set / model.get），全局命令（session.list / model 默认值与目录 /
  auth.*）省略。
- **事件信封 sessionId + channel**（AD-3/AD-4，类型层可选、v0.2 daemon
  运行时必发）：sessionId = 事件归属会话（会话无关系统事件用
  `SYSTEM_SESSION_ID` 占位）；channel = 事件类型学通道（§11.3）。
- **兼容红线（信封兼容读）**：新增字段全部可选 + 帧版本位取值域
  `FrameVersion = 0 | "0.2"`（0 = v0/v0.1 历史帧）——v0/v0.1 形态帧与
  payload 语义零变更（§10.1 各族 payload 原样）。

### 11.2 常量导出（OI 收口）

| 常量 | 值 | 说明 |
|---|---|---|
| `PROTOCOL_VERSION` | `"0.2"` | handshake 协商；harness V 字面量收敛（F-2⑭） |
| `SYSTEM_SESSION_ID` | `"__system__"` | 会话无关系统事件（connection.*）sessionId 占位 |

（`MAIN_INSTANCE_ID`（`"main"`）已随 T10 实例 ID 统一 T10c 退役：定义与
re-export 同批删除，legacy 判别由读侧 helper 承担，见 §17.11。）

### 11.3 事件类型学（八族 + 系统通道）

`channel` 判别字段按事件登记（events.ts 字面量 + `EVENT_CHANNELS` 运行时
目录，daemon 下发侧单点消费）：chat（v0 chat 族 10，含 engine.error 热修）/
agent（编排族 7）/ thinking（2）/ usage（1）/ compaction（1）/ session
（snapshot + 新增 `session.list_changed`）/ model（新增 `model.changed`）/
interaction（占位，无事件挂靠）/ notification（connection.* 系统事件）。

### 11.4 命令目录 v0.2（8 → 21）

新增 13：session 族 `session.list` / `session.loadHistory` / `session.delete`
（+ `session.subscribe` 升级为按会话订阅：信封 sessionId 必填，payload 保持
空）；model 族 `model.set` / `model.get` / `model.catalog` /
`model.catalog_refresh` / `model.set_default` / `model.get_default`；auth 族
`auth.list` / `auth.set_key` / `auth.delete_key` / `auth.verify`。
payload/响应形状总登记见 §15.2/§15.4/§15.5 与 §16.2/§16.6（契约 B/C 降为历史
定形档案）；daemon 行为由 T2.1/T2.2/T2.3 落地
（登记期未知实现 → `command.unimplemented` 占位回执，新错误码见 §7 注）。

### 11.5 DTO additive 扩展

- `SessionSnapshotDto`：`tail?` / `totalEntries?` / `tailStartCursor?`
  （AD-1 尾窗口径；尾窗只作用于主时间轴，per-instance channel 分组
  `instances[].channels?` 完整保留——F-14⑤ 硬约束）。
- `AgentInstanceDto`：`channels?: InstanceChannelHistory`；`queuedPosition?`
  （OI-4）与 `model?`（OI-3）v0.1 已登记，v0.2 起快照填充口径成立。
- `CompactionCompletedPayload`：`tailKept?` / `filesCompacted?`
  （命名定稿，OI 收口）。

## 12. v0.3 登记批（协议 v0.3；一次 bump）

> 本章为 v0.3 补登（历史对齐：实现于迭代 iter-20260818-mq5a，当期集成契约
> 为该迭代 `development/contracts/contract-v0.3.md`；本章起契约 SoT 归本文档，
> CL-2）。**版本位 bump**：`PROTOCOL_VERSION = "0.3"`（envelope.ts）——版本位
> 是批次集合标记非协商位（Q-1c 单仓同发一步替换，仓内无 "0.2" 帧存量；
> `FrameVersion = 0 | "0.3"`）。handshake 严格单值 fail-fast：
> `protocolVersion ≠ "0.3"` 即 `protocol.version_unsupported` 拒绝。
> 三处全部为 additive 可选字段扩展（TR-AD-18：只增不改、可选字段带缺省语义）：
> **零新增事件类型**（`EVENT_TYPES` 37 / `EVENT_CHANNELS` 计数不动）、
> **零新增命令对**（`COMMAND_TYPES` 21 不动；TR-AD-23① 可选参数优先于新命令对）。

### 12.1 spawn 锚点 anchorEntryId（AgentInstanceDto / AgentSpawnedPayload 扩展）

```ts
// types/agent.ts — AgentInstanceDto 新增
anchorEntryId?: string | null;

// events.ts — AgentSpawnedPayload 新增（增量分发点，与快照同源供给）
anchorEntryId?: string | null;
```

- **语义**：spawn 锚 = 卡片插入位的权威 entry id（复用 EntryDto.id 体系）。
  `null` = 流首锚点（有效值：spawn 前无任何 main/compaction entry，卡片渲染
  流首）；缺省不携带 = 主实例（kind=main，无卡片无锚）。daemon 组装期权威
  计算（派生值不持久化，无第二事实源）；快照（`session.snapshot` 的 instances
  清单）与增量分发点（`agent.spawned` 帧）同源供给——同聚合状态多次组装同值。
- **计算规则（机械判定）**：
  1. **实例已有 Entry** → anchor = 实例首条非 compaction 归属 Entry 之前、按
     聚合顺序最后一条 main 归属或 compaction entry 的 id；范围内无 → `null`
     （流首）。首 Entry 之后新增的 main entry 不影响锚（append-only）。
  2. **实例尚无 Entry**（spawn 后未产出首 Entry）→ anchor = spawn 时刻聚合内
     最后一条 main/compaction entry 的 id（无 → null）；随实例视图携带，
     不按当前尾部重算。
  3. **主实例**（kind=main）→ 不携带（undefined）。
- 恢复重放边界（记录在案）：重启恢复后仍无 Entry 的实例，spawn 时值不可
  重建，退化为规则 1 的尾部推导值（best-effort；实例首 Entry 到达后锚即
  稳定，不另建持久化事实源）。

### 12.2 monitor 档订阅 tier（SessionSubscribePayload 扩展）

```ts
// commands.ts — SessionSubscribePayload（原 EmptyPayload 形态仍合法）
export interface SessionSubscribePayload {
  /** 订阅档位（v0.3，Q-2b②）：缺省 full（既有语义不变） */
  tier?: "full" | "monitor";
}
```

- 信封 `sessionId` 必填不变（v0.2 路由位，§11.1）；`session.unsubscribe`
  保持 `EmptyPayload` 不动。同一连接对同一会话重复 subscribe 换 tier =
  **幂等更新**（不新增命令对、不报错）。
- **monitor 档白名单（Q-2a 消息档，机械定义）**：连接只收
  `chat.turn.started` / `chat.turn.completed` / `chat.message.completed`
  三个事件类型；其余 session 订阅面事件（`chat.stream.delta`、`tool.call.*`、
  `agent.*`、`thinking.*`、`compaction.completed`、`steer.queued/drained`、
  `usage.recorded` 等）不进 monitor 档；full 档全量照旧。过滤位置 = daemon
  事件分发层**一处完成**。系统级事件（`connection.*`、`session.list_changed`
  等非 per-session 帧）不受 tier 影响。
- **快照回推（daemon 既有行为明示）**：daemon 对任意档位的 subscribe 均重推
  该会话全量快照（快照恢复公式，§4 D-4 注记的按会话化延伸）。
- **连接级隔离**：daemon 每连接维护 `Map<sessionId, tier>`；N 连接 = N 独立
  表；断连即丢，daemon 不持跨连接状态。
- **ack 形态**：沿既有命令回执通道（点对点 result），形态不变、不携带
  tier 回显。

### 12.3 steer 定向寻址 instanceId（ChatSteerPayload 扩展）

```ts
// commands.ts — ChatSteerPayload 扩展
export interface ChatSteerPayload {
  text: string;
  /** 目标实例（v0.3，可选）：缺省 = 主实例（命令侧缺省路由语义；T10 起主实例 id = agent-<唯一串>） */
  instanceId?: string;
}
```

- **路由**：`instanceId` 缺省 → 主实例 SteerQueue（既有路径零改动；T10 起
  「主实例」按该会话 main kind 实例判别，非字面 `"main"` 值判等）；携带 →
  `AgentOrchestrationPort.send` 同链路，路由判定归 ChatService（TR-AD-9），
  WsServerAdapter 只透传。`steer.queued` 帧的 instanceId 挂**信封位**
  （`EventFrame.instanceId`，路由权威），payload（SteerQueuedPayload）零变更。
- **干预消息一律落 Entry（Q-3a）**：定向 steer 落主时间轴 Entry
  （role=user、标注目标实例 id），**不双写实例 channel**（单事实源）；
  恢复重放完整保留（主轴 Entry 在尾窗/翻页内）。
- **错误模型**：目标为非运行中实例（queued/completed/failed/killed/unknown）
  → `connection.error` 点对点回执（`code="command.invalid_payload"`，与
  agent.kill 目标不存在/已终态同码同形态，错误码面零新增）；非运行中
  **不落 Entry 不入队**（先判定后落账：send 判定 → Entry → steer.queued
  事件）。目标主实例仍走既有 lifecycle 判定（行为不变、无回执升级）。

## 13. v0.4 登记批（协议 v0.4；一次 bump）

> 本章为 v0.4 登记（迭代 iter-20260819-erio：契约 T2.1 定形、版本位 T3.2
> 统一升位；集成契约 `development/contracts/contract-v0.4.md` 为历史定形
> 档案（仓外参考）；实现规范以本文档为准（§15/§16 现状全集 + 本节演进备案），
> 字段形状与 packages/protocol 实际类型逐项对齐）。**版本位 bump**：`PROTOCOL_VERSION = "0.4"`（envelope.ts）——
> 批次集合标记非协商位（Q-1c 单仓同发一步替换，仓内无 `"0.3"` 帧存量；
> `FrameVersion = 0 | "0.4"`）。handshake 严格单值 fail-fast：
> `protocolVersion ≠ "0.4"` 即 `protocol.version_unsupported` 拒绝。
> 全部为 additive 扩展（TR-AD-18：只增不改、可选字段带缺省语义）：
> **命令目录 21 → 22**（+`trace.query`）、**事件目录 37 → 40**
>（+`trace.query.result` / +`agent.instantiated` / +`agent.model.changed`）、
> Channel 联合 +`"trace"` 族。计数口径校准：早期文书「37→39」漏计结果帧
> `trace.query.result`——结果帧先例（`session.list.result` 等 11 帧）全部
> 登记 `EVENT_TYPES`，本帧同构登记，以 **40** 为准。

### 13.1 命令 `trace.query`（C→S；会话历史事件查询）

```ts
// commands.ts — v0.4 新增（契约 v0.4 §1）
export interface TraceQueryPayload {
  sessionId: string;                    // 目标会话（必填，非空 string）
  instanceIds?: string[];               // 缺省 = 全部实例；空数组 = 空结果（显式语义）
  agentKind?: "main" | "subagent";
  types?: string[];                     // 缺省 = 全部类型；空数组 = 空结果（同口径）
  timeRange?: { from?: string; to?: string };  // ISO 8601，含起含止；from > to = 校验拒绝
  page?: {
    limit?: number;                     // 缺省 50；上限鉗制 MAX_PAGE = 200（超限鉗到 200 不报错）；非正整数拒绝
    beforeId?: number;                  // id 游标：返回 id < beforeId 的更早页
  };
}
```

- **路由**：目标会话在 **payload.sessionId**；信封 sessionId 位**不消费**——
  trace 读面直查 domain_events（连接私有读面），目标可以是冷会话（不触发
  懒加载、不要求热运行时）。
- **校验失败回执**：既有错误帧模式 `connection.error`
  （`code = "command.invalid_payload"`，消息中文说明，点对点，连接保持）。
- **id 游标**（AF-3：domain_events.id AUTOINCREMENT 单调）：
  `WHERE id < beforeId ORDER BY id DESC LIMIT ?`；翻页遍历拼接后 id 集合与
  全量查询相等（不重不漏）。

### 13.2 结果帧 `trace.query.result`（S→C，点对点）

```ts
// events.ts — v0.4 新增（契约 v0.4 §1.3）
export interface TraceQueryResultPayload {
  filterEcho: TraceQueryFilterEcho;     // 实际生效过滤回显（normalize 后；缺省维归一 null）
  instances: TraceInstanceRecord[];     // 实例面板摘要块（会话级，不受 events 过滤维影响）
  events: TraceEventRow[];              // 本页事件行（id 降序 = 最新在前）
  page: {
    loaded: number;                     // 本页实载行数
    total: number;                      // 同过滤条件（不含游标/限量）总行数
    hasMore: boolean;                   // rows.length === limit（恰整除时末页多一次空载，记录在案）
  };
}
```

- **点对点**：结果帧经 sendNow 直发发起连接（TR-AD-21 结果帧先例），**不经
  EventStream 广播**；信封 `sessionId` = 目标会话 id；`channel = "trace"`
  （v0.4 新族）。
- **filterEcho**（AF-5）：缺省维归一为 `null`（区别于「未传」，消除歧义）；
  并发一致性靠前端单飞 + 丢弃 filter 不匹配的迟到结果，**不加 requestId**。
- **面板独立**（AF-5）：`instances` 块恒为全会话 fold（不受 events 过滤维
  影响；`eventCount` = COUNT GROUP BY 同口径）。
- 共享形状定义在 `types/trace.ts`（AG-13 单点）：`TraceEventRow`（
  `{ id, ts, sessionId, instanceId, agentKind, type, payload }`，id =
  domain_events.id 游标锚，ts = ISO 8601 毫秒文本）、`TraceInstanceRecord`
  （生命周期 status 四态 / startedAt·endedAt 退化链 / `snapshotMissing`
  降级标记 / `modelTimeline` 升序 fold / `currentModel` 派生）、
  `TraceProfileSnapshot`（systemPrompt 组装全文 + tools + model +
  compaction? + hooks?——「当时注入了什么」的回溯本体）、
  `TraceQueryFilterEcho` / `TraceModelChange`。

### 13.3 事件 `agent.instantiated` / `agent.model.changed`（S→C 登记；只落盘不广播）

```ts
// events.ts — v0.4 新增（契约 v0.4 §2/§3）
export interface AgentInstantiatedPayload {
  instanceId: string;                   // T10 起 = agent-<唯一串>（历史行 "main" | agent-N = legacy）
  profileKind: string;                  // "main-session" | "subagent-worker"（自由字符串，无注册表）
  profileSnapshot: TraceProfileSnapshot;
}

export interface AgentModelChangedPayload {
  instanceId: string;                   // 当前仅主实例（model.set 是 per-session 主实例操作）
  from: string;                         // "provider/model-id"，与 model.changed 广播帧 previous 同源同值
  to: string;
}
```

- **发布时点**：`agent.instantiated`——主实例在会话**转正**（T4 修正：
  零条目内存草稿获首个用户条目时恰好一次发布；原「会话创建即发布」
  废弃——内存草稿不写 domain_events，trace 查询面无幻影）；SubAgent 在
  SchedulerService.spawn，与 `agent.spawned` 同批紧随其后，
  snapshot.model = spawn 时刻**两级链求值结果**（profile.model ??
  subagent-worker kind 槽位 ?? 全局兜底，AD-3 联动；T12 砍 spawn 会话
  快照级——SubAgent 只认自身 profile 链，不继承会话当前模型）。`agent.model.changed`——
  ChatService.setModel（engine.setModel 成功后同点发布）；from = 切换前
  引擎观测值（未暴露时回退全局默认，与 ModelService previous 口径一致）。
- **只落盘不广播**（AF-6）：经既有 publish → fan-out → WriteQueue 落
  domain_events（零 schema 改动）；DtoMapper 零 case → default → null；
  SessionProjection 显式 no-op（零投影且**不触发** write-through 状态写——
  否则草稿会话被提前落库，破坏「首条消息才落库」语义）；恢复重放
  RestoreService switch default 天然忽略；trace 页经 §13.1 查询面直读历史。
- **channel 归属**（AF-6）：两事件挂 `agent` 族（与 `agent.spawned` 同族）；
  `trace.query.result` 挂新 `trace` 族。
- **降级**：本迭代前创建的历史实例无 instantiated 事件 → 面板
  `snapshotMissing = true`（不 throw）。
- **与 v0.2 `model.changed` 广播帧的关系**：广播帧是会话换模生效通知
  （channel=model，前端徽标）；`agent.model.changed` 是实例模型时间线落盘
  （trace 数据面）——双通道各有单一职责，同源（同一次 setModel）同时点产生。

### 13.4 语义判据（机械判定）与守护同步

- **含起含止**：`ts >= from && ts <= to`（ISO 8601 同格式文本字典序比较）。
- **空数组即空结果**：`instanceIds=[]` / `types=[]` ⇒ `events=[]`、`total=0`
  （不展开为「全部」）。
- **limit 鉗制**：> 200 鉗到 200（不报错）；缺省 50；非正整数/非整数拒绝。
- **hasMore**：`rows.length === limit`（可能还有更早页；恰整除边界多一次
  空载收口）。
- **total**：同过滤 WHERE（不含游标与限量）的 COUNT。
- **模型同源**：SubAgent instantiated 的 snapshot.model 与该实例 launch
  实际使用模型同源同时点（spawn 时刻两级链求值）。
- 守护同步（type-surface.test.ts / exports.test.ts）：目录计数断言 22/40、
  roster(agent) +2、roster("trace") 新族、三新帧样例构造断言——既有
  命令/事件/帧形态零变更（additive 纪律，守护全绿即证）。

## 14. v0.4 后 additive 微批（T4：welcome.draft + chat.send.model + chat.send.draft 补登；版本位不 bump）

> 本批为内存草稿「不可见 + 转正」语义（bug1/bug4 daemon 侧）的协议面
> additive 登记（TR-AD-23①：可选字段带缺省语义，旧客户端忽略行为不变）。
>
> **收敛说明（v0.5 收口）**：本节三字段随 v0.5 批次一次定形登记
>（TR-AD-23②「版本一次定形」）——正文形状以 §15.1（`chat.send` 的
> draft/model 字段行）与 §16.1（`connection.welcome` 的 draft 字段行）为
> 准；本节保留为演进备案（何时/为何引入），不再承担形状登记职责。

### 14.1 `ConnectionWelcomePayload.draft?: boolean`（events.ts）

- `true` = 握手时当前会话是**零条目内存草稿**（未落盘、不进 session.list
  清单）；此时 daemon 握手**不 attach 该会话、不立即推 session.snapshot**
  （连接仍注册——draft 建会话链的 subscribeSession/快照推送照常可用），
  前端按草稿态显示。
- 缺省 = 现状握手（attach 当前会话 + 立即推快照，重连恢复 = 快照+增量
  语义不变）。

### 14.2 `ChatSendPayload.model?: string`（commands.ts）

- 仅 `draft:true` 建会话链消费：用户建会话前选定的模型——daemon 在建
  会话/复用后、首条消息发送前 `setModel`（引擎不支持等失败 → 降级全局
  默认，不阻断）；缺省 = 全局默认（不换模）。

### 14.3 `ChatSendPayload.draft?: boolean`（commands.ts；v0.4 内补登记，F(2).3）

- `draft:true` 且信封 sessionId 省略 → daemon 新建会话聚合落库（首条用户
  消息即建会话）；sessionId 携带时忽略本标记（既有会话内发送）。
  缺省 = 不触发建会话链（既有会话内发送，现状语义不变）。
  （字段本身 v0.2 引入——commands.ts 注明「契约 B §1.5 定稿」，§11 登记批
  未逐字段展开；本行为 v0.4 内补登记，零行为变更。）

### 14.4 配套 daemon 语义（本批同发）

- 零条目内存草稿双面不可见：不进 `session.list` 清单、`createFresh` 不再
  写 `agent.instantiated`（发布点推迟到转正，见 §13.3 修正）；
- `chat.send{draft:true}` 命中零条目当前草稿 → 同 id 转正复用（不裂变
  新会话）；转正恰好一次 `agent.instantiated` + `list_changed{created}`
  （draft 链显式广播与补广播去重，不双发）。

## 15. 命令 payload 形状总登记（C→S，54 命令全集）

> **计数声明：54 命令全集**（15.1 chat 3 + 15.2 session 5 + 15.3 agent 5 +
> 15.4 model 6 + 15.5 auth 4 + 15.6 trace 1 + 15.7 web 3 + 15.8 thinking 1 +
> 15.9 kg 6+5+2+1+1 + 15.10 workspace 2 + 15.11 task 9）——与 `COMMAND_TYPES` 常量恰等
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

### 15.3 agent 族（5）

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

| 字段 | 类型 | 可选性 | 登记版本 | 语义 |
|---|---|---|---|---|
| `profileKind` | `"main-session" \| "subagent-worker"` | 必填 | v0.6 | 目标 kind |
| `resourceType` | `"tool" \| "skill" \| "model" \| "thinking"` | 必填 | v0.6 | 资源类型（model/thinking = 槽位语义非启停；thinking = v0.11 批内补登 T1.3：槽位语义同 model，set/clear，零档位校验） |
| `name` | `string` | 必填 | v0.6 | 资源名（model/thinking 型 = "provider/model-id" / 档位字符串；clear 时忽略） |
| `enabled` | `boolean` | 必填 | v0.6 | tool/skill = 启停；model = set（true）/ clear（false）槽位 |

### 15.4 model 族（6）

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

### 15.9 kg 族（6+5+2+1+1；kg 批 + kg-bootstrap 批 + kg 维护批 + kg.health 批 + kg 评审批，iter-20260825-11fo T5.3 / iter-20260829-ys7q T3.2 / C1 / W2-E / W2-F）

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
批）。后端准入机械复核（索引 synced/degraded ∧ nodeCount==0——不信赖前端；
未过 → `kg.bootstrap.not_eligible`，message 带原因 `index_absent` /
`index_building` / `knowledge_not_empty`）→ 调 createTask 同一 API
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
**允许反复发起**——体检面向存量图谱，知识层非空恰是评审对象；未建索引
→ `kg.review.not_eligible`（message 带原因 `index_absent`）。过检 → 调
createTask 同一 API（type="kg-review"、projects=[project]、
params={projectRoot}、stages 策略 fixed 由 manifest 生成三行（L0 结构面
预检 / L1 规则册逐节点评审 / L2 实体册逐节点评审）、createdBy="page"——
与 kg.bootstrap.create / chat task_create 同源）。createTask 校验失败 →
`task.validation_failed` 透传。结果 = `kg.review.create.result`
（`{ok:true, jobId}`）。产出纪律：评审只提 candidates 台账（内容问题不
直改节点），唯一例外 = scene 缺失节点可 updateNode 直补（R23 元数据
补全不是内容推翻）；禁止直改 body/digest、禁止 supersede（推翻权在人审）。

| 字段 | 类型 | 可选性 | 登记版本 | 语义 |
|---|---|---|---|---|
| `project` | `string` | 必填 | kg 评审批 | 项目名或绝对路径（daemon 单点解析 + 准入复核） |

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

### 15.11 task 族（9；task 批，iter-20260829-ys7q T1.5 P-2 任务页数据面）

> 本族为 task 批（v0.11 后 additive 微批，版本位不 bump，§19/§20 同构
> 先例；批次注记见 §21）登记的 P-2 任务页九命令。全局命令（信封 sessionId
> 省略——任务为 daemon 级实体非会话作用域）。**零内容干预（AD-2）：本族
> 清单即全集**——无 steer/批次重试/内容编辑命令（机械 grep 断言守护）；
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

结果查询（F3.4，只读：各阶段 stage.artifact + 产出节点人类可读投影）。
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

#### `task.delete`

任务删除（F3.6，人工操作：**仅终态 done/failed/cancelled 可删**，运行中
删除 → `task.invalid_state`——判断收口引擎，handler 透传；清理 job/stage/
batch + 各批次实例 work_item，不触 kg 产出）。结果 = `{ok: true}`。

| 字段 | 类型 | 可选性 | 登记版本 | 语义 |
|---|---|---|---|---|
| `jobId` | `string` | 必填 | task 批 | 目标任务（终态） |

## 16. 事件 payload 形状总登记（S→C，67 事件全集）

> **计数声明：67 事件全集**（16.1 notification 3〔含 task.changed〕 +
> 16.2 session 4 +
> 16.3 chat 10 + 16.4 agent 12 + 16.5 thinking·compaction·usage 5 +
> 16.6 model 10 + 16.7 trace 1 + 16.8 web 4 + 16.9 kg 6+5+2+1+1 + 16.10 workspace 3
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
> + task 族九结果帧（task 批，不入本目录——契约 §0 计数，types/task.ts
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

### 16.2 session 族（4）

#### `session.snapshot`

全量快照（握手后 / 重连后；AD-16 快照+增量；v0.2 尾窗口径 additive，§11.5）。

| 字段 | 类型 | 可选性 | 登记版本 | 语义 |
|---|---|---|---|---|
| `snapshot` | `SessionSnapshotDto` | 必填 | v0 | 全量快照（§6；additive 扩展 §10.5 / §11.5） |
| `snapshot.thinking` | `{ override: string \| null; effective: string \| null }` | 可选 | v0.11 | 会话 thinking 覆盖/生效双位（thinking 批③ F-8 修复：SessionStateView → wire 接通；切换会话/重连/重启恢复后 UI 与引擎一致；null = 无覆盖 / 全链不支持不传参；缺省 = 未携带，旧剧本兼容） |
| `snapshot.mode` | `string` | 可选 | P1 会话模式微批（§18） | 会话模式回带：建会话时定格（chat.send draft 链 mode 透传落库；此后无写路径，快照只读回带）；缺省 = 未携带（旧剧本兼容，读侧按 `"default"` 兜底） |

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

### 16.3 chat 族（10）

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

### 16.4 agent 族（12）

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

### 16.6 model 族（10；含 model/auth 9 结果帧——auth 结果帧按 EVENT_CHANNELS 挂 model 通道）

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

### 16.9 kg 族（6+5+2+1+1；kg 批 + kg-bootstrap 批 + kg 维护批 + kg.health 批 + kg 评审批，iter-20260825-11fo T5.3 / iter-20260829-ys7q T3.2 / C1 / W2-E / W2-F）

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
| `projects` | `KgProjectRow[]`（`{ name, path, status, symbolCount?, nodeCount?, syncedAt?, degradedNote? }`） | 必填 | kg 批 | name/path = project 入参两形态；status 四态；synced 态携带计数与时间，degraded 态携带说明 |

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

### 17.5 v0.5 批次登记

v0.5 = payload 全量回迁（§15/§16 新增，13 命令 + 11 结果帧仓外委托清零）
+ SoT 守护口径（本节）+ §14 微批字段随批次定形；**零新增命令/事件**
（`COMMAND_TYPES` 22 / `EVENT_TYPES` 40 计数不变，additive 纪律）。版本位
`"0.4" → "0.5"`（envelope.ts 单点；批次集合标记非协商位，Q-1c 单仓同发
一步替换，运行时代码与测试零 `"0.4"` 残留——豁免：§1–§13 演进备案节的
历史版本登记字面量合法保留）；`FrameVersion = 0 | "0.5"`。handshake 严格
单值 fail-fast：`protocolVersion ≠ "0.5"` 即 `protocol.version_unsupported`
拒绝。（v0.6 起 v0.5 转为历史批。）

### 17.6 v0.6 批次登记

v0.6 = agent.config 族 additive 一次定形（M6 智能体配置页，TR-AD-23①：
新增 2 命令 agent.config.list / agent.config.set_enabled + 3 事件
agent.config.changed（广播）/ agent.config.list.result /
agent.config.set_enabled.result（点对点结果帧）——**零改既有命令/事件形状**
（`COMMAND_TYPES` 22 → 24 / `EVENT_TYPES` 40 → 43）。版本位 `"0.5" → "0.6"`
（envelope.ts 单点；批次集合标记非协商位，Q-1c 单仓同发一步替换，运行时
代码与测试零 `"0.5"` 残留——豁免：§1–§13/§17.5 演进备案节的历史版本登记
字面量合法保留）；`FrameVersion = 0 | "0.6"`。handshake 严格单值 fail-fast：
`protocolVersion ≠ "0.6"` 即 `protocol.version_unsupported` 拒绝。语义：
配置单元 = profile kind（main-session / subagent-worker），缺省无记录 = 启用；
model 型 set_enabled 走槽位 set/clear 语义（非启停），写前先经合并目录
校验（unknown-model 回执）。（v0.7 起 v0.6 转为历史批。）

**批内补登（M6 T4，同版本不破面）**：`agent.config.list.result` 的
`profiles[].tools` 行补必填 `snippet` 字段（一句话说明，daemon
ToolPromptSnippets 注册表同源；注册表外名 = 空串）。v0.6 未出仓（T3/T4
同迭代合入），补登不构成既有形状变更；四面同步面 = 协议类型 + PROTOCOL.md
§16.4 字段行 + sot ④ presence + daemon DTO 映射。

### 17.7 v0.7 批次登记

v0.7 = web 族 additive 一次定形（T4 联网状态图标，TR-AD-23①：新增 2 命令
web.status / web.stop + 3 事件 web.status.result / web.stop.result（点对点
结果帧）/ web.status.changed（广播）——**零改既有命令/事件形状**
（`COMMAND_TYPES` 24 → 26 / `EVENT_TYPES` 43 → 46）。channel 新族 `web`
additive 登记（envelope.ts Channel 联合 + EVENT_CHANNELS 目录，不动分发器，
TR-AD-18 同构口径）。版本位 `"0.6" → "0.7"`（envelope.ts 单点；批次集合
标记非协商位，Q-1c 单仓同发一步替换，运行时代码与测试零 `"0.6"` 残留——
豁免：§1–§13/§17.5/§17.6 演进备案节的历史版本登记字面量合法保留）；
`FrameVersion = 0 | "0.7"`。handshake 严格单值 fail-fast：
`protocolVersion ≠ "0.7"` 即 `protocol.version_unsupported` 拒绝。语义：
状态读面（web.status → web.status.result 点对点）+ 停止写面（web.stop →
web.stop.result 点对点 + web.status.changed 广播回流）+ 状态变更广播
（BrowserPort onStatusChange 四时机，SYSTEM_SESSION_ID 全连接下发）；
changed 广播 payload 与 status.result 同形状含 tabs（popover 实时清单）。

### 17.8 v0.8 批次登记

v0.8 = SKILL.md 内置第三源（T5，TR-AD-23① additive 口径）：`agent.config.list.result`
的 `profiles[].skills[].source` 与 `profiles[].diagnostics[].source` 字面量联合
`"user" | "project"` → `"user" | "project" | "builtin"`（daemon 随仓
resources/skills 内置技能——产品不可删改，set_enabled 对其返回
skipped(builtin-immutable) 不落禁用记录，读面恒 enabled=true）。**零新增
命令/事件**（`COMMAND_TYPES` 26 / `EVENT_TYPES` 46 计数不变），零改既有
命令/事件其它形状。版本位 `"0.7" → "0.8"`（envelope.ts 单点；批次集合
标记非协商位，Q-1c 单仓同发一步替换，运行时代码与测试零 `"0.7"` 残留——
豁免：§1–§13/§17.5/§17.6/§17.7 演进备案节的历史版本登记字面量合法保留）；
`FrameVersion = 0 | "0.8"`。handshake 严格单值 fail-fast：
`protocolVersion ≠ "0.8"` 即 `protocol.version_unsupported` 拒绝。
（v0.9 起 v0.8 转为历史批。）

### 17.9 v0.9 批次登记

v0.9 = CDP 显式启动通路（T7，TR-AD-23① additive 口径）：新增 1 命令
`web.start`（显式启动写面——用户知情触发 lazy connect，首次连接 Chrome
可能弹授权框的人侧预热入口）+ 1 事件 `web.start.result`（点对点回执，
applied/skipped 两判别；skipped 时 reason 含引导用户开 remote debugging
的说明）——**零改既有命令/事件形状**（`COMMAND_TYPES` 26 → 27 /
`EVENT_TYPES` 46 → 47）。状态回流（idle → connecting → connected/error）
走既有 `web.status.changed` 广播链（单一事件源纪律），零新增广播帧。
版本位 `"0.8" → "0.9"`（envelope.ts 单点；批次集合标记非协商位，Q-1c
单仓同发一步替换，运行时代码与测试零 `"0.8"` 残留——豁免：§1–§13/
§17.5/§17.6/§17.7/§17.8 演进备案节的历史版本登记字面量合法保留）；
`FrameVersion = 0 | "0.9"`。handshake 严格单值 fail-fast：
`protocolVersion ≠ "0.9"` 即 `protocol.version_unsupported` 拒绝。
（v0.10 起 v0.9 转为历史批。）

### 17.10 v0.10 批次登记

v0.10 = 图片上下行 additive（T9，TR-AD-23① 口径沿 v0.8 先例——纯可选
字段、零计数变化）：三处可选字段——`ChatSendPayload.images`（上行：用户
发图给 LLM，daemon 解码转 pi ImageContent[] 经 `agent.prompt(input,
images)` 注入模型）+ `MessageEntryDto.images`（下行：user 消息气泡缩略图，
chat.send.images 透传落盘）+ `ToolCallEntryDto.images`（下行：工具结果
附带截图，browser screenshot 读文件转 data URL）。**零新增命令/事件**
（`COMMAND_TYPES` 27 / `EVENT_TYPES` 47 计数不变），零改既有命令/事件
其它形状；对应事件帧载荷（chat.message.completed / tool.call.result 的
entry 内嵌字段）与 session.snapshot 载荷（投影重建）同构透传。线格式裁决：
全链 **base64 data URL**（`data:image/png;base64,…`）自包含免文件服务；
防护：数量 ≤4、单张解码后 ≤2MB（daemon ChatService 校验，超限中文报错
不落消息；browser screenshot 超 2MB 自动 jpeg 重截/降质，失败缺省不炸）。
非目标（记档）：steer 带图 / assistant 产图 / 媒体落盘重构。版本位
`"0.9" → "0.10"`（envelope.ts 单点；批次集合标记非协商位，Q-1c 单仓
同发一步替换，运行时代码与测试零 `"0.9"` 残留——豁免：§1–§13/§17.5–
§17.9 演进备案节的历史版本登记字面量合法保留）；`FrameVersion = 0 |
"0.10"`。handshake 严格单值 fail-fast：`protocolVersion ≠ "0.10"` 即
`protocol.version_unsupported` 拒绝。
（v0.11 起 v0.10 转为历史批。）

### 17.11 v0.11 批次登记

v0.11 = thinking 批 additive 四块（iter-20260823-6ps5 T1.1；AD-2/AD-4；
集成契约 = development/contracts/thinking-protocol.md）：① 新增 1 命令
`thinking.set`（会话 thinking 档覆盖写面——仿 `model.set` 形态，信封
sessionId 必填 per-session，payload `{ level: string }`，下一 turn 生效；
无关闭态）+ 1 事件 `thinking.changed`（广播，payload `{ override:
string|null, effective: string|null }` 双位——override = 覆盖意图 /
effective = 引擎按模型能力解析的生效档，null = 全链不支持不传参；仿
`model.changed` 广播链，挂 thinking 族）——`chat.send` **零字段**
（AD-4①：thinking 是会话状态非逐消息参数，引擎 turn 开始读解析结果）；
② `CatalogModel` additive 两字段 `reasoning: boolean` + `thinkingLevels:
string[]`（pi-ai Model.reasoning / thinkingLevelMap 非 null 键集防腐映射，
TR-AD-7 边界内合法；UI 不自判能力，TR-AD-42）；④ `AgentInstantiatedPayload`
additive + `thinkingLevel: string`（SubAgent spawn 解析快照，自身 profile
槽位 > 兜底 medium，AD-6；只落盘不广播语义不变，AF-6）。③ SessionStateView
快照读面扩字段首登物理位置在 daemon SessionPort（无同名重复定义）；wire 面
（`SessionSnapshotDto` + 快照帧映射）由本节末修复批补登接通。字符串透传红线（AD-2）：全部新字段类型 `string`，protocol 包内
**不维护第二份 ThinkingLevel 枚举**（SoT 在 pi-ai）。零改既有命令/事件
形状（`COMMAND_TYPES` 27 → 28 / `EVENT_TYPES` 47 → 48）。版本位
`"0.10" → "0.11"`（envelope.ts 单点；批次集合标记非协商位，Q-1c 单仓
同发一步替换，运行时代码与测试零 `"0.10"` 残留——豁免：§1–§13/§17.5–
§17.10 演进备案节的历史版本登记字面量合法保留）；`FrameVersion = 0 |
"0.11"`。handshake 严格单值 fail-fast：`protocolVersion ≠ "0.11"` 即
`protocol.version_unsupported` 拒绝。

**批内补登（T1.3，同版本不破面——M6 T4 先例）**：agent.config 族配置资源
载荷扩 thinking 槽位维（AD-6：E-智能体配置资源扩可选 thinkingLevel）——
`AgentConfigProfileBlock` additive + `thinkingLevel: string | null`（未配置
= null）；`agent.config.set_enabled` / `agent.config.changed` 的
`resourceType` 联合 additive + `"thinking"`（槽位语义同 model：set/clear，
helix 不做档位校验）。零新增命令/事件 type（`COMMAND_TYPES` 28 /
`EVENT_TYPES` 48 不变）。

**批内补登（修复批 F-6/F-8，同版本不破面）**：③ wire 面接通——
`SessionSnapshotDto` additive + `thinking?: { override: string|null;
effective: string|null }`（T1.2 起 daemon SessionStateView 已携带，快照帧
DTO/映射断环补齐；§16.2 字段行补登 + sot ④ presence 断言）；T1.3 文档登记
遗漏回填——§15.3/§16.4 `resourceType` 字段行类型联合补 `"thinking"`、
§16.4 `agent.config.list.result` 补 `profiles[].thinkingLevel` 字段行
（代码面 T1.3 已正确，纯文档补登）。零新增命令/事件 type，版本位不再
bump。

**批内补登（默认关 + off 升格 + 换模重播，同版本不破面）**：①
thinking 默认语义变更——`thinking.set` payload.level 合法值补登 `"off"`
（**显式关**：引擎解析链在能力适配 clamp 前短路 → `thinking.changed.
effective = null`、后续请求不带 reasoning；off:null 模型不被钳成支持档，
语义反转反例）；未配置（无覆盖无槽位）= **默认关**（不传 reasoning，
pi-ai 显式关思考；删 medium 兜底，D 方案）——off 与未配置请求行为等价，
区分仅在 override 位（`"off"` vs `null`）；§15.8 语义段已同步。②
`AgentInstantiatedPayload.thinkingLevel` 必填 → **可选**（Sub spawn 快照
自身 profile 槽位无兜底，未配置 → 缺席 = 默认关；只落盘不广播语义不变，
§16.4 字段行同步）。③ 换模重播落地——`model.set` 成功后补发一帧
`thinking.changed`（override 不变、effective 按新模型重算，§16.5 既登
语义的实现补齐；引擎未实现观测面不发）。命令/事件面零变更，版本位
不再 bump。

**批内补登（T11a closure/steer source 贯通，同版本不破面——M6 T4 /
T1.3 先例）**：closure 注入与用户 steer 的消息类型区分落到协议面——
① `steer.queued` / `steer.drained` 载荷补登可选 `source`（三值枚举
`"user" \| "closure" \| "progress"`：用户 steer / SubAgent 收口注入
（AD-8）/ 周期进展报告——进展报告与 closure 同走 injectClosure 通道，
同源区分）；② `MessageEntryDto.source` 同枚举补登（idle 时 closure
注入落的普通 user Entry 快照可见；daemon Entry 物种 ↔ SQLite
steer_queue.source 列全线贯通，老行/老事件缺省 = undefined，消费侧按
user 渲染）。零新增命令/事件 type，计数不变（28/48），版本位不 bump。

**批内补登（T11b 实时帧透传补齐，同版本不破面）**：daemon
`message.completed` 领域事件载荷补登可选 `source`（同三值枚举），
EnvelopeMapper 透传进 `chat.message.completed` 帧 `entry.source`——
§16.3 字段行 T11a 已登，本批补实现面（idle closure/progress 注入的
实时区分，不再仅靠快照对账）。additive 可选位，版本位不 bump。

**批内补登（T10 实例 ID 统一，同版本不破面——wire 行为对旧客户端
additive）**：实例 ID 统一三要点——① **唯一串格式**：所有实例（含
main）instanceId = `agent-<唯一串>`（daemon 单点生成，session id 同款
`crypto.randomUUID()` hex 形态，重启/恢复零撞号；废除主实例专用 `"main"`
与 `agent-N` 序号基线）；② **kind 判别**：main/subagent 区分由 kind
承载（`AgentInstanceDto.kind` / trace 面 `agentKind`），instanceId 值判等
退役；③ **legacy `"main"` 只读兼容**：历史行/历史帧中 instanceId 缺省或
字面 `"main"` 由读侧推断为主实例（§10.1 读侧推断语义），写侧不再产出。
写侧从「main 省略/字面 `"main"`」改为「全实例显式携带 `agent-<唯一串>`」
（事件信封/EntryDto/快照面），对旧客户端为 additive（读侧推断保留，不破
读侧），版本位不 bump。`MAIN_INSTANCE_ID` 常量本批保留（legacy 判别 +
shell 旧消费，shell 段 T10c 摘除后整体退役）；**T10c 已完成退役**：
@helix/common 定义与 protocol re-export 同批删除（全仓零残留），legacy
判别由读侧 helper 承担（protocol projection `isMainInstance` / shell
entities/session `isMainChannel` / daemon domain `isMainInstanceId`，各自
单点持有 legacy 字面）。

## 18. v0.11 后 additive 微批（P1 会话模式框架 T2：模式注册表 + mode 三字段；版本位不 bump）

> 本批为 P1 会话模式框架（mode-framework-p1 计划，T2）的协议面 additive
> 登记。**版本位不 bump**（`PROTOCOL_VERSION = "0.11"` 保持）：三处扩展全部
> 为可选字段 + 新增纯常量模块，旧客户端零破坏（additive 纪律，TR-AD-23①）。
> 版本位 bump 的机械跟随（shell 握手字面量 / daemon protocol-import 断言 /
> e2e 断言）属 P1 批次收尾（T5）决策空间——Q-1c「版本位是批次集合标记
> 非协商位」要求单仓同发一步替换，T2 仅落协议面，daemon（T3）/shell（T4）
> 消费未落齐前不升位（§14 v0.4 后微批同构先例）。

### 18.1 模式注册表（`src/modes.ts` 新模块，daemon/前端共享常量单点）

```ts
export interface StageSpec { id: string; profileKind: string; welcomeKey?: string }
export interface ModeSpec {
  id: string;                    // "default" | ...
  kind: "single" | "staged" | "orchestrated";
  profileKind: string;           // single/orchestrated 的绑定
  stages?: readonly StageSpec[]; // staged 模式（P2 预留）
}
export const MODES = [{ id: "default", kind: "single", profileKind: "main-session" }]
  as const satisfies readonly ModeSpec[];
export type ModeId = (typeof MODES)[number]["id"];   // 类型级保障：注册表派生联合
export const DEFAULT_MODE_ID: ModeId = "default";     // 缺省/fallback 语义单点
```

- session 一对一绑定模式：草稿态可切（`chat.send{draft:true, mode}` 唯一写
  入口）、建会话定格锁定——**无 `mode.set` 命令**（锁定语义 = 结构不可能，
  非校验拒绝）。
- schema 表达三模式不返工：single（default：main agent 绑 main-session 槽
  位）/ staged（P2 phase：design/build/verify 三阶段 agent，`stages` 预留）/
  orchestrated（P3 workflow：编排者 agent 绑编排者槽位）。
- mode 的 wire 面一律 `string`（AD-2 字符串透传同构）：协议面不校验注册表
  成员资格，未知 mode 由 daemon 模式注册表单点 fallback `"default"`（T3）。

### 18.2 三处 additive 可选字段（形状正文登记位 = §15.1 / §16.1 / §16.2）

- `ChatSendPayload.mode?: string`（§15.1）：仅 `draft:true` 建会话链消费；
  缺省 = `"default"`（旧客户端兼容）。
- `ConnectionWelcomePayload.mode?: string`（§16.1）：daemon 当前模式面——
  草稿握手 = 草稿暂存模式；已建会话握手 = session.mode 定格值。与 `draft`
  字段同构（welcome 本就是「当前会话」投影；前端 header 模式选择器草稿
  重连恢复的数据源）。缺省 = 未携带（旧 daemon 兼容，按 `"default"` 兜底）。
- `SessionSnapshotDto.mode?: string`（§16.2 `snapshot.mode` 字段行）：建
  会话定格值回带（此后无任何写路径，快照只读）。缺省 = 未携带（旧剧本
  兼容，读侧按 `"default"` 兜底）。

### 18.3 消费侧（T3/T4 落地；本批仅登记语义，协议包零 IO）

- daemon（T3）：模式注册表单点（消费 `MODES`）+ 未知 mode fallback
  `"default"` + 建会话按 mode 解析 profileKind + session.mode 落库/快照
  回带 + 建会后无写路径（锁定）。
- shell（T4）：header 模式选择器（草稿可切/已建只读显示 session.mode）+
  `chat.send` draft 带 mode。

## 19. kg 批（iter-20260825-11fo T5.3：P-1 图谱查看页数据面六命令族；v0.1 additive 批次语义——版本位不 bump）

> 本批为项目知识图谱（kg）迭代 P-1 数据面的协议面登记（T5.3）：
> **6 命令**（§15.9 kg 族：`kg.projects` / `kg.list` / `kg.node.detail` /
> `kg.change.report` / `kg.node.confirm` / `kg.index.status`——后五者携带
> 必填 `project` 按项目作用域，register V-2/V-3 开发期用户裁决）+
> **6 事件**（§16.9 kg 族：对应六命令的点对点回执结果帧，kg 新通道）+
> **4 错误码**（`KG_E_PARAM` / `KG_E_NOT_FOUND` / `KG_E_STATE` /
> `KG_E_REBUILD_FAILED`，connection.error 载荷、连接保持）。
> **版本位不 bump**（`PROTOCOL_VERSION = "0.11"` 保持）：全部为新增面
> （新增命令 type / 新增事件 type / 新增错误码值 / 新增 channel 值），
> 旧客户端零破坏（additive 纪律，TR-AD-23①；§14/§18 微批同构先例；
> 契约文档注记的「v0.1 additive」指此语义，非版本位回退）。
>
> - 计数演进：命令 28 → 34；事件 48 → 54（守护断言③同步扩）。
> - O-6 轮询裁决：索引进度**零推送事件**——本批六事件全部为命令点对点
>   回执（TR-AD-21），非广播；前端轮询 `kg.index.status` 获取进度变化。
> - 响应形状逐字段契约 =
>   `docs/iterations/iter-20260825-11fo/development/contracts/kg-viewer-api.md`
>   （T5.3 daemon 数据面与 T5.4 shell 前端的共同约定；本节只登记存在性
>   与通道归属，字段表见 §15.9/§16.9）。
> - daemon 行为由 T5.3 落地（handlers/kg.ts + KgViewerService；未装配面
>   回 `command.unimplemented`——trace.ts 先例）。

## 20. workspace 批（W1 workspace 绑定闭环：workspace 选择门禁与绑定；v0.11 后 additive 微批——版本位不 bump）

> 本批为 workspace 绑定闭环的协议面登记（W1 daemon+protocol 切片）：
> **2 命令**（§15.10 workspace 族：`workspace.get` 门禁读面 /
> `workspace.open` 显式绑定写面）+ **3 事件**（§16.10 workspace 族：两命令
> 点对点回执结果帧 + `workspace_changed` 绑定变更广播，workspace 新通道）+
> **3 错误码**（`WORKSPACE_E_INVALID_ROOT` / `WORKSPACE_E_ACTIVE_AGENT` /
> `workspace.unbound`，connection.error 载荷、连接保持）。
> **版本位不 bump**（`PROTOCOL_VERSION = "0.11"` 保持）：全部为新增面
> （新增命令/事件 type、新增错误码值、新增 channel 值），旧客户端零破坏
> （additive 纪律，TR-AD-23①；§19 kg 批同构先例）。
>
> - 计数演进：命令 34 → 36；事件 54 → 57（守护断言③同步扩）。
> - 语义源：设计稿 `helix/docs/temp/workspace-feature-design-candidate.md`
>   §3（workspace 从「daemon 启动 cwd 装配期常量」改为「运行时显式绑定」；
>   零静默猜测——不存在推导出来的 workspace）。无 close/unbind 命令
>   （v1 裁决：切换 = open 另一 root）；F2 裁决 v1：运行中 agent 时禁止
>   切换（`WORKSPACE_E_ACTIVE_AGENT`）。
> - 防御契约：未绑定态 kg 读面回空集结果（kg.projects → []，非报错）、
>   会话创建被拒（`workspace.unbound` + 指引文案）——门禁前端本不发这些
>   请求，此为防御。
> - CLI 例外条款：CLI 形态终端站位 = 显式选择（启动等价已 open(cwd)，
>   不持久化——桌面 current/recents 只由桌面 open 写）；desktop/sidecar
>   形态恒经绑定，无 cwd 兼容缺省。

## 21. task 批（iter-20260829-ys7q T1.5：P-2 任务页数据面九命令族；v0.11 后 additive 微批——版本位不 bump）

> 本批为任务页（P-2）数据面的协议面登记（T1.5）：
> **9 命令**（§15.11 task 族：`task.list` / `task.detail` / `task.artifacts` /
> `task.subscribe` / `task.unsubscribe` / `task.pause` / `task.resume` /
> `task.cancel` / `task.delete`——全局命令，任务为 daemon 级实体）+
> **1 事件**（§16.1 内 `task.changed`：O-7 逐迁移轻负载广播，挂既有
> **notification 通道，不新增 Channel 值**——契约 task-api §0；九命令结果帧
> 为点对点回执**不入 EVENT_TYPES 目录**，types/task.ts 窄化接口供出）+
> **4 错误码**（`task.type_unknown` / `task.validation_failed` /
> `task.not_found` / `task.invalid_state`，§7 登记、连接保持）。
> **版本位不 bump**（`PROTOCOL_VERSION = "0.11"` 保持）：全部为新增面
> （新增命令 type / 新增事件 type / 新增错误码值），旧客户端零破坏
> （additive 纪律，TR-AD-23①；§19/§20 同构先例）。
>
> - 计数演进：命令 36 → 45；事件 57 → 58（守护断言③同步扩）。
> - 零内容干预（AD-2）：本族清单即全集——无 steer/批次重试/内容编辑命令
>   （机械 grep 断言守护，§15.11）；任务创建不经本族（按任务类型各有宿主：
>   /project 入口 `kg.bootstrap.create`（T3.2）与 chat 工具 task_create
>   （T2.4），架构 §8.2）。
> - task.changed 投送（O-7 裁决）：引擎每次 job/stage/batch 行 status 迁移
>   即推一帧 `{jobId, changed, status?}`；连接级订阅表过滤（task.subscribe
>   登记、断连清表；agent.subscribe 通路先例不沿用——本批为真过滤）。
>   T1.5 接线面 = 生命周期命令（pause/resume/cancel 成功即广播）；stage/
>   batch 级迁移的触发归编排侧（T2.2 经同一 EventStream.broadcastTaskChanged
>   通路），创建（T2.4 工具面）同。
> - 状态枚举 wire 值 = 后端状态机原值（六态 pending/running/paused/done/
>   failed/cancelled）；前端展示映射（pending→装配中、done→已完成）只在
>   展示层，wire 不出第二套词表。
> - 响应形状逐字段契约 =
>   `docs/iterations/iter-20260829-ys7q/development/contracts/task-api.md`
>   （T1.5 daemon 协议面与 T3.1 shell 前端的共同约定；本节只登记存在性
>   与通道归属，字段表见 §15.11/§16.1）。
> - daemon 行为由 T1.5 落地（handlers/task.ts + TaskQueryService/
>   TaskEnginePort 回口；未装配面回 `command.unimplemented`——kg.ts 先例；
>   状态判断收口引擎 T1.3，handler 透传 task.invalid_state）。

## 22. kg 维护批（C1：清空图谱 kg.graph.purge + 删除索引 kg.index.delete；v0.11 后 additive 微批——版本位不 bump）

> 本批为 kg 库维护两命令的协议面登记（C1）：**2 命令**（§15.9 kg 族：
> `kg.graph.purge` 清空本项目 kg 库全部内容 / `kg.index.delete` 删除
> `.codegraph` 索引目录——两命令职责严格分层：purge 不动 `.codegraph`，
> index-delete 不动知识层）+ **2 事件**（§16.9 kg 族：两命令点对点回执
> 结果帧，挂既有 kg 通道）+ **1 错误码**（`kg.graph.purge_blocked`：
> 运行中（running/pending）kg-bootstrap 任务存在时拒绝清空，connection.error
> 载荷、连接保持）。**版本位不 bump**（`PROTOCOL_VERSION = "0.11"` 保持）：
> 全部为新增面（新增命令 type / 新增事件 type / 新增错误码值），旧客户端
> 零破坏（additive 纪律，TR-AD-23①；§19/§20/§21 同构先例）。
>
> - 计数演进：命令 50 → 52；事件 63 → 65（守护断言③同步扩）。
> - 范围决策（purge）：全量清（知识面 + 符号面 + meta 基准/发号计数器）
>   + 索引态复位 absent——清 symbols 留 meta 基线会让 sync 误判无变化
>   不再导入（状态机破窗）；清后下一次 triggerManual 重建符号面，bootstrap
>   准入经「索引 synced ∧ 知识层空」恢复 eligible。
> - 联动（index-delete）：删除时消费 KgFsWatchService.stopWatching 接缝停
>   per-project watcher；重建成功经既有 onSynced 钩子自动重挂。
> - 安全：purge 门禁在 daemon service 侧机械复核（不信赖前端）；UI 侧
>   两步确认（危险操作文案含「不可恢复」）。
> - daemon 行为由 C1 落地（handlers/kg.ts + KgMaintenanceService；未装配面
>   回 `command.unimplemented`——kg 族既有先例）。

## 23. kg 评审批（W2-F 轨二语义体检任务 kg-review：kg.review.create 发起入口；v0.11 后 additive 微批——版本位不 bump）

> 本批为轨二语义体检任务（设计 kg-driven-dev-loop-design D5 + R21/R23：
> 专门 skill + 任务类型，对标 kg-bootstrap 形态走任务系统派发，LLM 逐节点
> 评审「节点内容 vs 代码现实是否一致」）的协议面登记：**1 命令**
>（§15.9 kg 族：`kg.review.create` 发起体检任务，准入从简 = 索引存在即可、
> 允许反复发起——与 bootstrap 一次性语义不同，体检面向存量图谱）+ **1
> 事件**（§16.9 kg 族：`kg.review.create.result` 点对点回执，挂既有 kg
> 通道）+ **1 错误码**（`kg.review.not_eligible`：未建索引拒绝，
> connection.error 载荷、连接保持）。**版本位不 bump**
>（`PROTOCOL_VERSION = "0.11"` 保持）：全部为新增面（additive 纪律，
> TR-AD-23①；§22 同构先例）。
>
> - 计数演进：命令 52 → 53；事件 65 → 66（守护断言③同步扩）。
> - 产出纪律（硬）：内容过期/矛盾只提 candidates 台账人审（不直改节点）；
>   唯一例外 = scene 缺失节点可 updateNode 直补（R23：元数据补全不是内容
>   推翻）；禁止直改 body/digest、禁止 supersede（推翻权在人审）。
> - 发起宿主：看板入口按钮（W2-E 看板面并行交付；命令名冻结 =
>   `kg.review.create`）。daemon 行为由 W2-F 落地（handlers/kg.ts +
>   KgReviewService；未装配面回 `command.unimplemented`——kg 族既有先例）。
