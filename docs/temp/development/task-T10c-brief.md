# T10c Brief — 实例 ID 统一（方案 A）：shell 段 + 常量最终退役

## 项目定位

- 仓库：`/Users/siyong/AI_Project/helix`，动 `apps/shell`（主体）+ `packages/common`/`packages/protocol`（常量退役收尾）。前置：T10a（daemon，668a522）与 T10b（协议契约文档）已合流。
- 测试命令：`bunx vitest run apps/shell`、`bun run test:protocol`、typecheck。
- 增量 commit 纪律；隔离 worktree（helix-t10c）。

## 需求（traceability）

用户决策：所有实例（含 main）instanceId 统一 `agent-<唯一串>`，"main"/subagent 区分由 kind 承载（理由：未来一个 session 可能多个 main agent）。daemon 已按此实现（T10a），本任务把 shell 侧判别从 instanceId 值判等改为 kind 判别，并完成 MAIN_INSTANCE_ID 常量最终退役。

## 改动点（最小实现）

### 1. shell kind 判别改造

- `apps/shell/src/entities/session/model/state.ts:32` 的 MAIN_INSTANCE_ID 镜像删除。
- 全 shell grep `MAIN_INSTANCE_ID` 与 `=== "main"`/`!== "main"` 值判等消费点（explader 清单：consumers/snapshot.ts 主流/抽屉分流、consumers/chat.ts、consumers/thinking-usage.ts F1.6 分流、session-reducer.ts、widgets/chat-stream/ui/MessageFlow.tsx 定向 steer 判定 instanceId≠main、SubAgentCard/抽屉等）——逐点改 kind 判别（AgentInstanceDto.kind / 条目携带的 kind 信息）。
- **读侧兼容**：历史快照/事件中 instanceId 缺省或字面 "main" 的条目仍按主流渲染（legacy 推断：缺省或 "main" → 视为 main kind）——判别 helper 单点封装（如 `isMainChannel(instanceId)`：kind===main 或 legacy 值），不留散落字面量。
- 渲染显示：主实例相关的 id 显示（若 shell 有显示 main id 的位置）跟随现状（主实例卡片/主时间轴无 id 显示则无此面；SubAgentCard 显示 agent-<hex> 原文即可）。

### 2. 常量最终退役

- shell 零消费后：删 `packages/common/src/constants.ts:19` 的 MAIN_INSTANCE_ID 与 `packages/protocol/src/envelope.ts:33` 的 re-export（grep 全仓零消费为前提；若 protocol 测试仍用字面 "main" 造 legacy 数据，改用本地常量）。
- PROTOCOL.md §17.11 补登段追加一句：常量已退役，legacy 判别由读侧 helper 承担（若 T10b 已有等义表述则不改）。

### 3. 测试跟随

- shell 测试中 "main" 字面断言/seed 数据跟随（legacy 场景保留但走 helper）；snapshot/reducer 测试补两钉：新形态（kind=main + agent-<hex> id）分流主流；legacy 形态（缺省/"main"）仍主流。
- protocol/common 常量删除后 `bun run test:protocol` 跟随。

## 验收标准

1. shell 内 MAIN_INSTANCE_ID import 零残留、`=== "main"`/`!== "main"` 值判等零散落（grep 证据；legacy helper 单点除外）。
2. 全仓 `MAIN_INSTANCE_ID` 符号零残留（common/protocol 定义删除后 grep 证据）。
3. 新形态（kind=main）分流主流、legacy 形态（"main"/缺省）分流主流（两钉测试）。
4. `bunx vitest run apps/shell` + `test:protocol` + typecheck 全绿；`bun test apps/daemon` 无回归。

## 报告要求

- submit_result 传 taskId=T10c；acceptance[] 逐条应答；findings[] 必填（无发现传 []）。
