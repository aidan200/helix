# Brief — task-20260828-idxstatus：kg.index.status 冷启动 building 可见性修复

## 项目位置

- 仓库：/Users/siyong/AI_Project/helix（bun workspaces；daemon = apps/daemon，测试 `bun test apps/daemon`）
- 你只改 daemon 侧三个点：service 两个文件 + 一个集成测试文件。**不碰 shell、不碰 protocol、不碰 port 接口形状**。

## 背景（用户报告的 bug）

P-1 项目页点「构建索引」冷启动（B1）时，页面看起来"没反应、状态是假的"。根因链：

1. 前端 CTA 发 `kg.index.status {project, rebuild:true}`，daemon handler `handleKgIndexStatus` 内 `await ctx.kg.indexStatus(project, true)` → `KgSyncService.triggerManual` **全程阻塞**（首建可能数分钟），完成后才回 synced 帧。
2. 同时前端进入 building 态按 O-6 每 750ms 轮询 `kg.index.status {project}`（无 rebuild）。
3. `KgViewerService.indexStatus` 非 rebuild 分支先走 `hasIndex` 短路：冷启动时 `.helix-kg/kg.db` 要到 sync 管道末尾 `applySync` 才创建，所以构建期间轮询全部拿到 `{state:"absent"}`。
4. 前端 reducer 见到 absent →「触发未生效，退回 absent 态」；之后 synced 回执到达时主区已不在 building，不再翻转——卡在 absent。

正确语义：构建进行中（含首次、库文件尚未创建）轮询必须回 **building**。

## 约束（kg 架构铁律，来自 docs/kg）

- **A8「读面绝不新建库文件」**：`KgSyncService.getStatus` 触库连接即建库，这就是 `indexStatus` 里 hasIndex 短路存在的原因。你的修复**不得**让 absent 项目的读面轮询触达任何读 port（现有测试 `kg.projects … absent 不建库（A8）`、`kg.index.status … delta 无库 → absent 且不建库` 必须保持绿）。
- 分层纪律：application 不 import adapters（TR-AD-1）；handlers 只转发不决策。
- 最小实现：不加 progress 上报、不改 `getStatus` 语义、不改 `KnowledgeGraphPort`/`CodegraphEnginePort`。

## 任务

### 1. `apps/daemon/src/application/services/kg/KgSyncService.ts`

新增只读方法（纯内存，不触库）：

```ts
/** 构建中判定（纯内存读面——indexStatus 的 absent 短路前置用，不触库保 A8）。 */
isBuilding(projectRoot: string): boolean {
  return this.states.get(projectRoot)?.running === true;
}
```

### 2. `apps/daemon/src/application/services/kg/KgViewerService.ts`

`indexStatus(project, rebuild)` 非 rebuild 分支，在 hasIndex 短路**之前**插入 building 判定：

```ts
if (rebuild) {
  …现状不变…
} else if (this.deps.sync.isBuilding(projectRoot)) {
  // 构建进行中（含冷启动首建、库文件尚未创建）——先于 absent 短路
  return { ok: true, value: { state: "building" } };
} else if (!this.deps.project.hasIndex(projectRoot)) {
  …现状不变…
}
```

`{ state: "building" }` 是 `KgIndexStatusView` 既有合法形状（statusView 已产出），无需新类型。

### 3. 集成测试 `apps/daemon/test/integration/kg-handlers.test.ts`

现有测试 `kg.index.status：四态透传 + rebuild building + 知识层零写 + absent 冷启动（A5/A9）` 末尾的 delta 冷启动段，当前写法是 `await rig.client.kg("kg.index.status", { project: "delta", rebuild: true })` 一步到位，**覆盖不到**本次修复的竞态。改造为（参照同测试内 alpha rebuild 段的 fireAndForget + 轮询写法）：

- rebuild 前断言 delta 无库（现有，保留）；
- `fireAndForget` 发 delta rebuild；
- 轮询发 `kg.index.status {project:"delta"}`，断言在 3s 内观察到 `building` 帧——且观察时 `.helix-kg/kg.db` 可能尚不存在（引擎 fake delayMs=150×2 提供窗口；可在观察到 building 时顺便断言 `existsSync(kg.db) === false`，若时序不允许则只断 building 帧存在，不要 flaky）；
- `until` 等最终 `synced` 帧 + 库文件出现（现有断言保留）；
- 全程 delta 的非 rebuild 轮询不再出现把 absent 当终态的断言（修复前轮询只会回 absent）。

注意：同文件 A8 断言（`kg.projects` 测试里 delta 读面不建库、`kg.list` delta → KG_E_NOT_FOUND）不得受影响——它们走的是无构建的纯读面。

## 验收标准（闭环逐条应答）

1. `KgSyncService.isBuilding` 存在且纯内存（不触 graph/store/engine）。
2. 冷启动构建期间（kg.db 未创建）无 rebuild 的 `kg.index.status` 轮询回 `building` 而非 `absent`。
3. 无构建进行时，absent 项目轮询仍回 `absent` 且不建库（A8 不回归）。
4. `bun test apps/daemon` 全绿（至少 kg 相关测试文件全绿；若仓内有与本次无关的既存红，说明并给出证据）。
5. `cd apps/daemon && bunx tsc --noEmit`（或仓根 `bun run typecheck` 的 daemon 段）无新增错误。

## 报告要求

闭环 submit_result 传 taskId=task-20260828-idxstatus；acceptance 逐条 ✓/✗ + 证据（测试输出摘录）；findings 必填（无发现给 []）。
