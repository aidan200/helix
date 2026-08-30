# Brief — task-20260829-manualsync：kg 索引同步改纯手动（退役全部自动触发面）

## 项目位置

- 仓库：/Users/siyong/AI_Project/helix（bun workspaces；daemon = apps/daemon，测试 `bun test apps/daemon`）。
- 只动 daemon 侧；不碰 shell、不碰 protocol。

## 背景（用户裁决 2026-08-29）

索引构建改**纯手动**：不希望 daemon 启动/workspace 绑定/换绑时对全部项目自动触发 codegraph 首建（CPU 高峰 + 不请自来的 .codegraph 目录），也不要文件事件与 agent 写后通知自动驱动 sync。**唯一生产触发面 = 项目页「构建索引/重新构建」按钮 → `KgSyncService.triggerManual`**（含 getStatus/isBuilding 读面，已完成，不动）。

## 现状接线（探查结论，已核实）

- `container.ts` L312-314：`startSync = deps.skipKgSyncStartup ? no-op : startKgSyncBackground(...)`，由 `WorkspaceService.bind`（L318）在绑定/换绑时调用。
- `startKgSyncBackground`（`buildKnowledgeStack.ts` L180-216）：①对扫描到的每个项目 fire-and-forget `onStartup`（= 完整 sync，absent 项目自动 init 首建）；②启动 `FsWatchAdapter` 监听 workspace 根驱动 `onFsEvent`。
- `buildEditToolDeps`（同文件 L146+）：向 edit/edit-lines 工具注入 `notifyWrite` → 写后去抖 sync。附着注入（attachAfterEdit）是同函数的另一路，**必须保留**。
- `skipKgSyncStartup` 仅被 `test/helpers/createTestDaemon.ts` L129 使用。

## 任务

1. **container.ts**：`startSync` 恒为 no-op（`() => ({ stop: () => {} })`）；删除 `skipKgSyncStartup` 门控分支与该 deps 字段（含 `createTestDaemon.ts` 的注入点与 `kgSyncStartup` 选项，若类型/调用连锁报错一并清理）。`WorkspaceService` 与其 `startSync` 调用点不动。
2. **buildKnowledgeStack.ts**：删除 `startKgSyncBackground` 函数、`KgSyncBackground` 类型、`FsWatchAdapter` import。
3. **buildEditToolDeps**：不再注入 `notifyWrite`（EditTool/EditLinesTool 的该 deps 字段本身是 optional，工具层契约不动）；attachAfterEdit 附着注入保持不变。函数签名同步收窄（不再收 syncService 或收窄为不需要的形态——以调用点最简为准），`kg-attachment-wiring.test.ts` L244 等调用点同步修正。
4. **死代码清理**：`FsWatchAdapter` 生产面唯一消费者就是 startKgSyncBackground——删除 `apps/daemon/src/adapters/driven/fs-watch/` 目录与其专测 `apps/daemon/test/unit/kg-fswatch.test.ts`；删除 `apps/daemon/test/unit/kg-kgsync-background.test.ts`。删除前 `grep -rn` 确认无其他引用（含 smoke/scripts/e2e）。
5. **KgSyncService**：`notifyWrite`/`onFsEvent`/`onStartup` 方法与其行为单测（`kg-sync-service.test.ts`、`kg-sync-pipeline.test.ts`）**保留**（service 能力面与测试面不动）；只更新文件头 doc——生产唯一触发面 = 页面手动 `triggerManual`；启动/fs-watch/写后挂接按 2026-08-29 用户裁决退役（方法保留）。
6. **工具层测试不动**：`tools-edit-parity.test.ts` ⑨、`kg-attachment-wiring.test.ts` ① 是 EditTool 自身 notifyWrite 契约测试（自构 deps），与装配接线无关，保持绿即可。

## 约束

- 最小实现、分层纪律（application 不 import adapters）；不引入配置开关（用户已裁决，不留退路旗标）。
- `KgSyncService` 的 sync 管道语义（去抖/单飞/重试/四步事务）零改动。

## 验收标准（闭环逐条应答）

1. daemon 启动/绑定/换绑不再触发任何 sync（无 onStartup 调用面、无 fs-watch、无写后 sync 入队接线）。
2. `startKgSyncBackground`/`KgSyncBackground`/`FsWatchAdapter`/`skipKgSyncStartup` 全仓零残留（grep 证据）；对应三个测试文件已删。
3. edit 工具附着（📎 块）链路不回归（kg-attachment-wiring 测试绿）。
4. `bun test apps/daemon` 全绿；`cd apps/daemon && bunx tsc --noEmit` 零错误。
5. KgSyncService 文件头 doc 已更新为「生产唯一触发面 = 页面手动」。

## 报告要求

闭环 submit_result 传 taskId=task-20260829-manualsync；acceptance 逐条 ✓/✗ + 证据；findings 必填（无发现给 []）。
