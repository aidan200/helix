# T10b Brief — 实例 ID 统一（方案 A）：protocol wire 段

## 项目定位

- 仓库：`/Users/siyong/AI_Project/helix`，动 `packages/protocol`（+ `packages/common` 注释级）。daemon 已在 T10a 完成并合流（668a522）。
- 测试命令：`bun run test:protocol`、typecheck。
- 增量 commit 纪律；建议隔离 worktree（helix-t10b）。

## 背景（T10a 已完成的事实）

- 所有实例（含 main）instanceId = `agent-<唯一串>`（hex）；daemon 发布侧已显式携带 instanceId（Envelope/EntryDto/Snapshot 摘除 MAIN_INSTANCE_ID，commit d8ecb93）；持久化新增 `session_state.main_instance_id` 列；旧库 "main" 行只读兼容。
- 协议面当前残留：`packages/common/src/constants.ts:19` 的 `MAIN_INSTANCE_ID` 定义 + `packages/protocol/src/envelope.ts:33` re-export；PROTOCOL.md 中「instanceId 省略 = main」的契约表述；相关 sot/type-surface 测试。

## 改动点（最小实现）

### 1. PROTOCOL.md 契约文档

- 检索 PROTOCOL.md 所有「省略 instanceId = main / 主实例省略 instanceId」表述段（grep 省略/主实例），改写为现行契约：**所有实例（含 main）事件信封/DTO 显式携带 instanceId；历史事件/快照中 instanceId 缺省或字面 "main" = legacy 主实例（读侧推断，写侧不再产出）**。
- §17.11 风格批内补登一段（T10 ID 统一：agent-<唯一串> 格式、main_kind 判别、legacy "main" 只读兼容；版本不 bump——wire 行为对旧客户端为 additive，写侧从省略改为显式携带不破读侧）。
- envelope.ts `instanceId?: string` 的注释同步（缺省 = legacy 主实例推断）。

### 2. 常量去留

- `packages/common/src/constants.ts` 的 `MAIN_INSTANCE_ID` **保留定义**（加 legacy 注释：仅 shell 旧消费与 legacy 判别使用，shell 段 T10c 摘除后整体退役）——本任务不删（shell 仍 import，删了四包 typecheck 红）。
- protocol envelope.ts 的 re-export 保留，注释标 legacy。

### 3. 协议测试跟随

- type-surface / sot-consistency 测试中涉及「主实例省略 instanceId」的断言跟随（读侧推断保留断言，写侧显式携带若有断言则更新）。
- 若有 wire 帧形状断言依赖 main 省略优化，改钉「main 实例也携带 agent-<唯一串>」。

## 验收标准

1. PROTOCOL.md 无「省略 instanceId = main」作为现行写侧契约的残留（grep 证据；legacy 推断表述为读侧兼容语义）。
2. §17.11 批内补登段存在且含三要点（唯一串格式 / kind 判别 / legacy 只读兼容）。
3. `bun run test:protocol` 全绿 + typecheck 四包绿（MAIN_INSTANCE_ID 常量仍在、shell 编译不破）。

## 报告要求

- submit_result 传 taskId=T10b；acceptance[] 逐条应答；findings[] 必填（无发现传 []）。
