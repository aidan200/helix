# Helix WS 协议 v0

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
  │ ── { v:0, type:"hello",                   │  校验 token（与 ~/.helix/dev-token 比对）
  │      payload:{ token, protocolVersion:0 } │  校验 protocolVersion = 0
  │    } ───────────────────────────────────→ │
  │                                           │
  │ ←─ { v:0, type:"connection.welcome",      │  通过：sessionId / model / agentState
  │      payload:{ sessionId, model,          │
  │               agentState } } ────────────│
  │ ←─ { v:0, type:"session.snapshot",        │  随后立即推全量快照
  │      payload:{ snapshot: SessionSnapshotDto } } │
  │                                           │
  │ ←─ { v:0, type:"connection.error",        │  拒绝：先发 error 帧再 close
  │      payload:{ code, message } } ────────│
```

- **重连恢复 = 快照 + 增量**（AD-16）：重连后重新握手 → 收快照重建投影 → 续增量；首连空会话 = `snapshot.entries` 为空数组。
- **拒绝三分支**（TP-CL6-5）：无 `token` 字段 → `auth.missing_token`；token 与 `~/.helix/dev-token` 不符 → `auth.invalid_token`；`protocolVersion ≠ 0`（含信封 `v ≠ 0`）→ `protocol.version_unsupported`。
- 客户端浏览器侧获取 dev token 的机制已由 T1.6 钉死：daemon HTTP 端点 `GET /helix-dev-token`（见 §9）。

## 3. 统一信封

```ts
export const PROTOCOL_VERSION = 0 as const;

export interface WorkspaceRoute { workspaceId?: string }

export interface Envelope<T = unknown> {
  v: typeof PROTOCOL_VERSION;   // 版本位：v0 恒为 0（AD-9）
  type: string;                 // 目录名，具体信封接口以字面量收窄
  payload: T;                   // 载荷形状由 type 决定
  workspace?: WorkspaceRoute;   // 预留字段位，通常不携带
}
```

- 具体命令/事件信封（`ChatSendCommand`、`ChatStreamDeltaEvent`…）继承
  `Envelope<载荷>` 并以 `type` 字面量收窄；联合（`CommandEnvelope` /
  `EventEnvelope`）即**判别式联合**——两端 `switch(frame.type)` 直接窄化
  payload，无需运行时 type-guard。
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
| `steer.queued` | `SteerQueuedPayload` | `{ entryId }` | 消息入 steer 队列（前端徽标「STEER·已入队」依据） |
| `steer.drained` | `SteerDrainedPayload` | `{ entryId }` | turn 边界 drain 注入（徽标转「已注入·本轮结束」依据） |
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
}
```

## 7. 错误码表

`ErrorCode`（connection.error.payload.code 取值全集）：

| code | 场景 | 连接处置 |
|---|---|---|
| `auth.missing_token` | 握手：无 token 字段 | 发 error 帧后 **close** |
| `auth.invalid_token` | 握手：token 与 dev-token 不符 | 发 error 帧后 **close** |
| `protocol.version_unsupported` | 握手：protocolVersion ≠ 0 | 发 error 帧后 **close** |
| `command.unknown` | 命令：未知 type | 发 error 帧，**连接保持** |
| `command.invalid_payload` | 命令：payload 不符 | 发 error 帧，**连接保持** |
| （连接层异常） | 非 WS 帧垃圾数据等 | 不发帧直接 close，前端走重连状态机 |

- **daemon 实现超集注记（D-3）**：daemon 握手期**同时校验**信封 `v ≠ 0` 与
  `hello.protocolVersion ≠ 0`，两者均以 `protocol.version_unsupported` 同码拒绝
  （实现严于本文档仅列 `protocolVersion` 的口径，属良性收紧）。

## 8. 版本与演进

- 版本位内建（AD-9）：`v: 0`；协议不兼容变更时 bump `PROTOCOL_VERSION`
  并同步本包类型与本文档，旧版本以 `protocol.version_unsupported` 拒绝。
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
- **其他 Origin**（任意外部站点）→ 403（防恶意网页窃取 token 接管本机 agent）。

两种前端形态共用同一机制（AG-13 同源基线的自然延伸）：

| 形态 | token 获取 | 前端资源来源 |
|---|---|---|
| vite dev（开发期） | `fetch("http://127.0.0.1:{port}/helix-dev-token")`（跨端口 fetch，ACAO 反射放行） | vite dev server |
| static-serve（生产形态） | 同一端点（同源 fetch，无 CORS 问题） | daemon `staticDir` 构建产物 |

选型说明：契约草案曾以「vite dev 插件读文件注入 env」为首选，T1.6 落地时定稿为
**daemon 端点方案**——两种形态同一通路、零 vite 侧插件代码、生产/开发行为一致；
WS 连接本身不受 CORS 约束（浏览器允许跨源 WS），仅 token 的 HTTP 获取需上述
Origin 规则。v0 不做 token 过期/轮换通知（daemon 重启 = token 重写，前端握手
失败即重新拉取）。
