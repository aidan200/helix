# T11a Brief — closure/steer source 区分（协议 + daemon 段）

## 项目定位

- 仓库：`/Users/siyong/AI_Project/helix`，动 `packages/protocol` + `apps/daemon`。shell 消费段归后续 T11b。
- 测试命令：`bun run test`（daemon）、`bun run test:protocol`、typecheck。

## 需求（traceability）

用户决策（原话）：「这个可以按照你的逻辑来」——按探查报告方向落地 closure 注入与用户 steer 的消息类型区分：

- closure 的**终态语义**已有独立类型（agent.completed/failed/killed + ClosureDto），不动。
- closure 的**注入内容**当前复用 steer 通道无判别：`source: "closure"` 标记止于 daemon 内存 SteerQueue，不进事件/协议 DTO/SQLite。本任务把 source 贯通到协议面与持久化。

## 已查明的现状（探查报告事实，可直接引用）

- `ChatService.steer`（ChatService.ts:270-282）→ `applySteer(text, now)`（source=undefined=user）——与 closure 注入 running 分支（ChatService.ts:317，`applySteer(text, now, "closure")`）逐行同构，差异只有 source 参数，但该参数不进 Entry/事件/DB。
- `Session.applySteer`（Session.ts:75-81）→ user+isSteer Entry + `SteerQueue.enqueue({entryId, text, source})`（SteerQueue.ts:17 内存项有 source）。
- 事件：`steer.queued`/`steer.drained` 载荷仅 `{entryId}`（events/chat.ts:36-43；EnvelopeMapper.ts:143-149 只透 entryId）。
- DTO：`MessageEntryDto`（types/chat.ts:22-32）只有 steerState/instanceId，无 source。
- DB：`steer_queue` 表（schema.ts:58-62）无 source 列。
- **周期进展报告**（SchedulerService.ts:600）也走 injectClosure 通道——source 枚举需含 "progress"。需查明 ChatService.injectClosure 当前被 closure 与 progress 两条调用链共用的事实，injectClosure 增加 source 参数（port 签名扩展，调用方 ClosureRecorder 传 "closure"、进展报告链传 "progress"）。
- idle 时 closure 注入走 sendMessage 落普通 user Entry——扩面后该 Entry 也需带 source（appendUserEntry/Entry 物种加 source 字段，持久化随行）。

## 改动点（最小实现）

### 1. protocol（additive，遵循 T1 先例：批内补登不 bump 版本，PROTOCOL.md §15/§16 相关段补登）

- `SteerQueuedPayload` / `SteerDrainedPayload` 加 `source?: "user" | "closure" | "progress"`（可选 additive）。
- `MessageEntryDto` 加同名可选 `source` 字段。
- `EnvelopeMapper` steer 两事件透传 source。
- 协议测试（type-surface / sot 守护）跟随。

### 2. daemon

- `Entry` 物种（domain/session/Entry.ts）加 `source?: "user" | "closure" | "progress"`；`Session.pushEntry/steerEntry/appendUserEntry` 贯通；`applySteer` 的 source 参数落 Entry + 事件载荷。
- `ChatService.injectClosure(message, source)` 签名扩展（默认 "closure"；进展报告调用点传 "progress"——先查明进展报告实际调用链再定传参点）。
- `steer.queued`/`steer.drained` 发布载荷带 source（ChatService steer/drainSteerTurn）。
- SQLite：`steer_queue` 表加 `source` 列（schema 迁移按仓库既有迁移模式——先查 schema.ts 版本/迁移机制）；SteerQueue 持久化/恢复（restoreFrom）携带 source。
- 快照/EntryDtoMapper 把 Entry.source 透传到 MessageEntryDto。

### 3. 纪律

- AD-2 字符串透传原则不适用于 source（这是 helix 自有枚举，协议面定死三值）。
- 老数据兼容：source 缺省（老行/老事件）= undefined，shell 按 user 渲染（T11b 域）。
- TDD：先改 daemon 集成测试（steer/closure 注入事件载荷断言）+ 协议 sot 测试看红，再实现。

## 验收标准

1. closure 注入（running）→ steer.queued 载荷 source="closure"；用户 steer → source="user"（或缺省按 user）（测试钉）。
2. 进展报告注入 → source="progress"（测试钉）。
3. idle 时 closure 注入的 user Entry 带 source="closure" 且快照 DTO 可见（测试钉）。
4. steer_queue 表 source 列持久化 + 冷恢复后 source 不丢（测试钉）。
5. PROTOCOL.md 批内补登完成；`bun run test` + `test:protocol` + typecheck 全绿。

## 报告要求

- submit_result 传 taskId=T11a；acceptance[] 逐条应答；findings[] 必填（无发现传 []）。
