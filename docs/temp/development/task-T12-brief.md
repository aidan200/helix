# T12 Brief — SubAgent 模型链去 spawn 会话继承（③ 修复）

## 项目定位

- 仓库：`/Users/siyong/AI_Project/helix`，动 `apps/daemon` + `apps/shell`（P-2 文案）+ 协议/架构文档。
- 测试命令：`bun run test`、`bunx vitest run apps/shell`、typecheck。

## 需求（traceability）

用户决策（原话）：「3的逻辑，我觉得只需要subagent根据自己的profile来就行，没有spawn，也没有继承main session的选择。」

背景（已实证）：SubAgent thinking「不应用 P-2 配置」的根因是**语义稀释**——spawn 继承会话当前模型（`backfill.currentModelOf`），P-2 按「槽位模型 ?? 全局默认」预览配置的档位在该会话模型上被 `supportsThinkingLevel` 静默过滤成 OFF。修复 = 砍掉模型链的 spawn 会话快照级，SubAgent 模型只认自身 profile 链。砍后 P-2 预览基准与 spawn 实际模型天然同源，稀释消失。

## 现状链（探查事实）

- SubAgent 模型三级链（AD-3）：`SubAgentProfile.model` ?? `resourceService.modelSlot("subagent-worker")`（uiModelSlot）?? **spawn 会话快照（`backfill.currentModelOf?.(sessionId)`，buildSessionStack.ts:333 经 `scheduler.spawn(...)` 第四参传入 → launcher `spawnModelFor(id)`）** ?? 全局兜底（`defaultModel.current()` 解析）。
- `subagentSnapshotFor`（buildSessionStack.ts:267-282）的 `profileSnapshot.model` 同链（:275-279 含 spawnModel 级）——快照必须与 launch 实际同链同步改。
- thinking 链已是纯 profile（subagent-worker 槽位），不动。

## 改动点（最小实现）

### 1. daemon

- `buildSessionStack.ts:331-338`：`sessionOrchestration.spawn` 调用 `scheduler.spawn(sessionId, task, profileKind, backfill.currentModelOf?.(sessionId), reportIntervalMs)` —— 移除会话模型入参（传 undefined 或改签名，按最小 diff 与既有测试形态定）。
- `SubagentLauncher.resolveModelFor` / deps：删 `spawnModelFor` 级（链 = profile.model ?? uiModelSlot ?? 全局兜底）；`buildSessionStack.ts:225-227` 的 `spawnModelFor: (id) => backfill.spawnModelSource?.(id)` 装配删除；`backfill.spawnModelSource`/`currentModelOf` 若无其他消费方一并退役（grep 确认；`currentModelOf` 用于 spawn 透传 `AgentInstanceDto.model` 填充链——该填充语义改为解析后的实际模型）。
- `subagentSnapshotFor.profileSnapshot.model` 链同步删 spawnModel 级（与 launch 同源同时点纪律不变）。
- 注释/文档：buildSessionStack 内 AD-3 三级链注释、PROTOCOL.md 相关段、architecture 文档（docs/ 下若有 AD-3 三级链描述）改两级链陈述。

### 2. shell（P-2 文案）

- AgentPage subagent 卡模型槽位缺省项文案「跟随会话与全局默认」→「跟随全局默认」（i18n zh/en 对应键；main 卡文案不动）。
- P-2 thinking 字段若有「会话模型」相关提示残留一并核销（grep）。

### 3. 测试（TDD：先改测试看红）

- daemon：SubAgent 模型链测试（spawnModelFor/spawn 会话快照场景断言 → 删除或改为两级链）；`subagent-child.test.ts` / `subagent-thinking-chain.test.ts` 跟随；新增回归钉：会话模型=A 且 subagent-worker 槽位模型=B → spawn 用 B（不用 A）。
- shell：AgentPage 测试中文案断言跟随。
- e2e：grep e2e 下 spawn 模型继承相关断言跟随（T5 域外的新跟随，跑 CL 系列确认）。

## 验收标准

1. 会话当前模型=A、subagent-worker 模型槽位=B 时，spawn 的 SubAgent 用 B（不用 A）（测试钉）。
2. 模型槽位空 → 全局默认（不再经过会话快照级）（测试钉）。
3. `subagentSnapshotFor` 快照模型与 launch 实际模型同源（测试钉）。
4. P-2 subagent 卡缺省文案为「跟随全局默认」（测试钉 + grep 证据）。
5. `bun run test` + `test:shell` + typecheck 全绿；受影响 e2e spec 跟随并绿。

## 报告要求

- submit_result 传 taskId=T12；acceptance[] 逐条应答；findings[] 必填（无发现传 []）。
