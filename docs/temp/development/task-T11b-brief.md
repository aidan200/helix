# T11b Brief — shell closure/steer source 显示区分（⑤ 显示段）

## 项目定位

- 仓库：`/Users/siyong/AI_Project/helix`，主动 `apps/shell`（chat-stream 渲染），附带一行 protocol/daemon additive 跟随。
- 前置：T11a 已合流（2ce08a4）——`SteerSource = "user"|"closure"|"progress"` 已贯通 steer.queued/drained 载荷、MessageEntryDto.source、steer_queue 表。
- 测试命令：`bunx vitest run apps/shell`、`bun run test:protocol`、typecheck。

## 需求（traceability）

用户决策：closure 注入与 steer 在显示上区分（⑤ 方向已确认「按照你的逻辑来」；T11a 协议段完成，本任务落地显示段）。

## 已查明现状（探查 + T11a 边界声明）

- 主时间轴（widgets/chat-stream/ui/MessageFlow.tsx:44-58）：定向 steer → DirectedSteer 细条；其余 → MessageBubble；steer 徽标 = MessageBubble.tsx:14-26 SteerBadge（queued=violet 脉冲「已入队」/drained=「已注入」）。
- closure 注入 idle 时 = 普通 user 气泡零标记；running 时 = steer 徽标气泡与用户 steer 同形——现在 Entry.source / steer 事件 source 可用。
- **T11a 边界**：实时 `chat.message.completed` 帧不带 entry.source（仅快照 DTO 带）——idle closure 注入的实时区分需补 `MessageCompletedPayload.source`（additive 一行透传 + EnvelopeMapper + PROTOCOL.md 补登）。

## 改动点（最小实现）

### 1. protocol/daemon 跟随（小）

- `MessageCompletedPayload` 加 `source?: SteerSource`（additive，批内补登不 bump）；daemon EnvelopeMapper message.completed case 透传；PROTOCOL.md §16.3 字段行 + §17.11 补登；sot 守护测试跟随。

### 2. shell 显示

- `MessageBubble`/`SteerBadge`：source 驱动的徽标变体——`source="closure"` → CLOSURE 徽标（与 user steer 的 violet 脉冲视觉分离；样式新族最小集）；`source="progress"` → PROGRESS 徽标；user/缺省 → 既有 steer 徽标不变（老数据缺省按 user，T11a 口径）。
- 快照消费（consumers/snapshot.ts / chat.ts 对账链）把 entry.source 带到渲染 props；steer.queued/drained 事件 source 更新对账条目。
- i18n zh/en 新增徽标文案（chat 段）。
- ClosureCard（抽屉）不动——本任务只管主时间轴注入内容的区分。

### 3. 测试（TDD）

- MessageBubble 渲染测试：source=closure/progress/user/缺省四态徽标断言（先红后绿）。
- 快照/事件消费链测试跟随。
- 受影响 e2e（CL 系列 steer/closure 剧本）跟随。

## 验收标准

1. 主时间轴 closure 注入气泡带 CLOSURE 徽标，与用户 steer 徽标视觉可区分（测试钉）。
2. progress 注入带 PROGRESS 徽标（测试钉）。
3. 用户 steer / 缺省 source（老数据）渲染与现状一致（回归钉）。
4. 实时帧（idle closure 注入）即时带 source 区分（MessageCompletedPayload.source 透传测试钉）。
5. `bunx vitest run apps/shell` + `test:protocol` + typecheck 全绿。

## 报告要求

- submit_result 传 taskId=T11b；acceptance[] 逐条应答；findings[] 必填（无发现传 []）。
