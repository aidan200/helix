# T1 Brief: runtime_config KV 表 + RuntimeConfigPort + 默认模型迁移

## 背景定位

helix daemon（`apps/daemon`，DDD 六边形）。现状：全局默认模型存 SQLite `default_model` 独占单行表，经 `DefaultModelPort`（`apps/daemon/src/application/ports/outbound/DefaultModelPort.ts`）+ `DefaultModelStore`（`apps/daemon/src/adapters/driven/sqlite-session/DefaultModelStore.ts`）存取，写面走 `WriteQueue.saveDefaultModel()`（`sqlite-session/WriteQueue.ts:245-247`）。用户决策：独占表多余，改通用运行时配置 KV 表；port 层一步到位抽 `RuntimeConfigPort`（路 B），DefaultModel 语义成为 KV 上第一个键的包装。

## 任务目标

1. 新表 `runtime_config(key TEXT PRIMARY KEY, value TEXT NOT NULL)`，建表落 sqlite-session 现有 schema/迁移机制（找同类建表先例，如 resource_state）。
2. 新 port `application/ports/outbound/RuntimeConfigPort.ts`：通用 `get(key: string): string | undefined` / `set(key: string, value: string): Promise<void>`（若查现状后有更贴合的形状，可在 brief 报告里说明理由）。port 文件只放接口（架构规则）。
3. 新实现（sqlite-session 内，读写均走 WriteQueue 单写通道——写语句只准在 WriteQueue 内，这是 AG-06 类约束；读面可用 WriteQueue 暴露的 database 连接）。
4. 默认模型迁移：`RuntimeConfigPort` 之上保留默认模型语义包装（组合根注入 fallback `DEFAULT_MODEL_ID`，现状在 `pi-engine/model-provider.ts`），消费方（`buildSessionStack.ts:208/229/375-378/415/423`、`container.ts:303/426/504`、`ModelService.ts:82/109/127-133`）**调用面尽量不动或最小改动**——推荐保留 `DefaultModelPort` 的调用签名风格，把实现换成 KV 包装；具体取舍你判断后报告。
5. 数据迁移：启动时若旧 `default_model` 表存在且有值、KV 中无 `default_model` 键 → 写入 KV，旧表 drop 或保留不管（选其一并说明）。幂等，挂现有 legacy 迁移链（`container.ts:303` 附近有 config.json → default_model 先例）。
6. 旧 `DefaultModelStore`/`DefaultModelPort`/`WriteQueue.saveDefaultModel` 按新形态退役或改写；`apps/daemon/test/integration/default-model.test.ts` 改写覆盖：KV 读写、fallback 兜底、旧表迁移幂等。

## 边界（不要做）

- 不动 shell 前端任何代码。
- 不动 `model.get_default`/`model.set_default` 命令语义（ModelService 行为不变，只换存储底座）。
- 不加 `last_mode` 等新键（本期最小面）。
- 不改 resource_state/auth/models-store 等其他存储。

## 全局约束

- DDD 分层单向依赖；adapter 之间禁互引；pi 库 import 只在允许域。
- WriteQueue 单写通道纪律：所有写语句只在 WriteQueue 内。
- 测试先行（TDD）：新行为先写失败测试。

## 验收标准（闭环逐条应答）

1. `runtime_config` 表建表 + WriteQueue 写通道 job 落地，有测试覆盖 KV set/get。
2. `RuntimeConfigPort` 接口文件就位，实现经组合根装配替换默认模型旧实现，`grep -r "DefaultModelStore" apps/daemon/src` 结果符合新形态（保留/退役与否与报告一致）。
3. 旧表 → KV 迁移幂等且有集成测试。
4. `apps/daemon` 相关测试全绿（至少 default-model 集成测试 + 你新增的测试）。

## 报告要求

submit_result 含 acceptance 逐条应答 + findings（改动文件清单、接口形状决策理由、迁移策略选择）。
