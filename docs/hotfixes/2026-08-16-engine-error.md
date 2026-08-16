# 热修记录 — 2026-08-16：engine.error 透传链路（provider 失败静默无响应）

## 缺陷（P1，用户首次真实 LLM 联调暴露）

z.ai 429 限额场景下「对话无响应」。根因链：

1. **pi-ai 行为**：provider 失败（HTTP 429 等）不抛异常，规范化为**流内 error 帧**（`{type:"error", reason:"error", error:{stopReason:"error", errorMessage:"429: {...原文...}"}}`）——errorMessage 已含 provider 原文（`normalizeProviderError` 提取，实测确认 0.84.2 无丢文本）。
2. **helix 四层断点**（grep 零命中实证）：
   - adapter：只接 compaction 失败为 engine_error；主消息流 `stopReason=error` 无分类；
   - 协议：23 事件联合无 `engine.error`（DtoMapper :463 显式丢弃，v0 边界注记）；
   - reducer：无 case；UI：无错误卡片。
3. **表现**：error 消息（空 content）不投影 → turn 以 `reason=completed` 假完成 → 全零 usage 入账 → 前端静默。
4. **为何测试没拦**：E 层 FakeLLM 剧本不产 error 帧（mock 假信心，与 OI-3 同模式）。

## 修复（五点，additive）

| 层 | 改动 |
|---|---|
| 协议 | `engine.error{message}` 进事件联合（24 个；TR-AD-18 additive 纪律） |
| DtoMapper | `engine.error` 领域事件 → WS 帧（原丢弃分支作废） |
| adapter | `message_end(stopReason=error)` → `engine_error` 事件（`errorMessageOf` 提取 pi 归一化原文，缺省兜底文案） |
| ChatService | error 轮全零 usage 不入账（零成本非真实计费调用） |
| 前端 | reducer `engine.error` → `state.engineError`（瞬态：新轮 turn.started 清；快照/重连保留）+ `EngineErrorCard`（provider 原文透传，role=alert） |

## 测试

- 协议 type-surface/exports：23→24 双向一致（15/15）
- daemon 302/302（含 ws-dto-mapper engine.error 下发断言改写）
- shell 81/81（reducer engineError 槽位 3 例）
- **E 层新 spec** `CL-7-e2e-engine-error.spec.ts`：FakeLLM `errorReply` 剧本（与真实 pi-ai 失败帧逐字段同构）→ 错误卡可见 + 原文透传 + 会话不崩 + 下一轮恢复 ✅
- F 层全量 63/63 零回退
- **现场验证**：真 daemon + 真 z.ai 429 → `engine.error` 帧含完整限额原文下发，turn 正常收口

## 关联

- 契约 §9 终验登记追加（workspace 迭代产物）；kg 候选：TR-AD-18 修订（engine.error 通道 + error 轮账目语义）已 propose 落 pending。
- 用户侧：20:47 限额重置后正常对话；此前发送将看到错误卡片（预期行为）。
