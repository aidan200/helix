# Helix WS 协议 v0.4

> 当前版本位 `PROTOCOL_VERSION = "0.4"`（envelope.ts）；§1–§9 为 v0 基线，
> §10–§13 为 v0.1–v0.4 演进登记（v0.4 = 当前，见 §13）。

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
  │ ── { v:"0.4", type:"hello",               │  校验 token（与 ~/.helix/dev-token 比对）
  │      payload:{ token,                     │  校验 protocolVersion = "0.4"
  │             protocolVersion:"0.4" } } ───→ │
  │                                           │
  │ ←─ { v:"0.4", type:"connection.welcome",  │  通过：sessionId / model / agentState
  │      payload:{ sessionId, model,          │
  │               agentState } } ────────────│
  │ ←─ { v:"0.4", type:"session.snapshot",    │  随后立即推全量快照
  │      payload:{ snapshot: SessionSnapshotDto } } │
  │                                           │
  │ ←─ { v:"0.4", type:"connection.error",    │  拒绝：先发 error 帧再 close
  │      payload:{ code, message } } ────────│
```

- **重连恢复 = 快照 + 增量**（AD-16）：重连后重新握手 → 收快照重建投影 → 续增量；首连空会话 = `snapshot.entries` 为空数组。
- **草稿握手分支（T4，§14.1）**：当前会话为零条目内存草稿时 welcome 携带 `draft:true`，不 attach 不推快照；真实会话握手维持上图时序。
- **拒绝三分支**（TP-CL6-5）：无 `token` 字段 → `auth.missing_token`；token 与 `~/.helix/dev-token` 不符 → `auth.invalid_token`；`protocolVersion ≠ "0.4"`（含信封 `v ≠ "0.4"`）→ `protocol.version_unsupported`。
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
| `protocol.version_unsupported` | 握手：protocolVersion ≠ 当前版本位（"0.4"） | 发 error 帧后 **close** |
| `command.unknown` | 命令：未知 type | 发 error 帧，**连接保持** |
| `command.invalid_payload` | 命令：payload 不符 | 发 error 帧，**连接保持** |
| （连接层异常） | 非 WS 帧垃圾数据等 | 不发帧直接 close，前端走重连状态机 |

- **daemon 实现超集注记（D-3）**：daemon 握手期**同时校验**信封 `v` 与
  `hello.protocolVersion` 不等于当前版本位（"0.4"），两者均以
  `protocol.version_unsupported` 同码拒绝（实现严于本文档仅列
  `protocolVersion` 的口径，属良性收紧）。

## 8. 版本与演进

- 版本位内建（AD-9）：`v: "0.4"`（当前）；协议不兼容变更时 bump
  `PROTOCOL_VERSION` 并同步本包类型与本文档，旧版本以
  `protocol.version_unsupported` 拒绝。
- 演进登记：v0.1 additive（§10，未 bump 版本位）；v0.2 一次 bump、版本位转
  字符串（§11）；v0.3 三处 additive 可选字段扩展 + bump（§12）；
  **v0.4 = 当前**（§13：trace.query 命令族 + agent.instantiated /
  agent.model.changed 两落盘事件 additive 登记 + 版本位 `"0.3" → "0.4"`，
  批次集合标记非协商位）。
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
- **分配格式（O-4 裁决建议，T1.2 定稿）**：主实例固定 `main`；SubAgent =
  `agent-N`（daemon 内递增序号；持久化基线取 `agent_lifecycle` 已有
  max(N)+1，重启不重复、剧本可预期）。
- **信封 `instanceId?`**（§3 信封新增可选字段，**仅事件侧使用**）：
  **缺省 = 主实例（`main`）**——v0 事件族（`chat.stream.delta` 等）主线事件
  不携带即归属主线；v0.1 通道族主线事件（`usage.recorded` /
  `compaction.completed` / `thinking.completed` / `thinking.stream.delta`）
  由 daemon **显式携带 `instanceId: "main"`**（线格式两种形态均合法，
  前端等价处理）；SubAgent 实例的事件携带对应 instanceId，前端按 id 分流投影
  （主线增量进消息流；SubAgent 增量只更新卡片 streaming 摘要行，不进消息流）。
  命令不携带实例维度（`agentId` 在 payload 内）。
  （v0.2 措辞修正回填：本条原文「主线事件缺省不挂 instanceId」对 v0.1
  通道族不精确——OI-5 处置，iter-20260816-6q6f T1.2。）

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
  `ToolCallEntryDto` 增可选 `instanceId?: string`（缺省 = 主实例）。
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
  usage? }`；主实例 `instanceId = "main"`；`queuedPosition` 仅 state=queued 携带。
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
> `model-auth-commands.md`——实现规范以契约文档为准，本节为导读）。
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
| `MAIN_INSTANCE_ID` | `"main"` | 双侧手写收敛（F-2⑬；daemon 经 AgentInstance re-export，shell 随 T3.1） |
| `SYSTEM_SESSION_ID` | `"__system__"` | 会话无关系统事件（connection.*）sessionId 占位 |

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
payload/响应形状与错误模型见契约 B/C；daemon 行为由 T2.1/T2.2/T2.3 落地
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
  /** 目标实例（v0.3，可选）：缺省 = 主实例（既有语义不变） */
  instanceId?: string;
}
```

- **路由**：`instanceId` 缺省 → 主实例 SteerQueue（既有路径零改动）；携带 →
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
> 统一升位；集成契约 `development/contracts/contract-v0.4.md`——实现规范
> 以契约文档为准，本节为登记导读，字段形状与 packages/protocol 实际类型
> 逐项对齐）。**版本位 bump**：`PROTOCOL_VERSION = "0.4"`（envelope.ts）——
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
  instanceId: string;                   // "main" | agent-N
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
  snapshot.model = spawn 时刻**三级链求值结果**（profile.model ?? spawn
  会话快照 ?? 全局兜底，AD-3 联动）。`agent.model.changed`——
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
  实际使用模型同源同时点（spawn 时刻三级链求值）。
- 守护同步（type-surface.test.ts / exports.test.ts）：目录计数断言 22/40、
  roster(agent) +2、roster("trace") 新族、三新帧样例构造断言——既有
  命令/事件/帧形态零变更（additive 纪律，守护全绿即证）。

## 14. v0.4 后 additive 微批（T4：welcome.draft + chat.send.model；版本位不 bump）

> 本批为内存草稿「不可见 + 转正」语义（bug1/bug4 daemon 侧）的协议面
> additive 登记（TR-AD-23①：可选字段带缺省语义，旧客户端忽略行为不变）。

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

### 14.3 配套 daemon 语义（本批同发）

- 零条目内存草稿双面不可见：不进 `session.list` 清单、`createFresh` 不再
  写 `agent.instantiated`（发布点推迟到转正，见 §13.3 修正）；
- `chat.send{draft:true}` 命中零条目当前草稿 → 同 id 转正复用（不裂变
  新会话）；转正恰好一次 `agent.instantiated` + `list_changed{created}`
  （draft 链显式广播与补广播去重，不双发）。
