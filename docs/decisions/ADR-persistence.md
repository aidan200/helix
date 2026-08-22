# ADR：daemon 持久化域（SQLite 单写通道 / 分仓 FIFO / 守护式 schema 演进）

> 来源：daemon src 注释考古迁档（注释清理批，容器见 `apps/daemon/src/adapters/driven/sqlite-session/`）。
> 活规则锚：AD-16（状态即事件 + write-through）、AD-17（贫血行模型）、AG-06（唯一写点）、TR-AD-13（同队列原子写）。

## 背景

daemon 的领域状态（会话聚合 + 生命周期 + 工具记录）与领域事件流需要落 SQLite（`<home>/helix.db`，WAL 模式）。写路径如果散落在各 adapter 会有三重风险：并发写冲突、事件行与状态行的顺序不可保证、测试无法对「落盘了什么」做单一断言面。

## 取舍

- **单写通道（AG-06）**：`new Database` / `exec` / 全部 INSERT-UPDATE-DELETE 只允许出现在 `WriteQueue.ts` 与 `schema.ts` 的 DDL 内。读面共用同一连接做只读 SELECT。代价是所有写经一层队列间接；收益是写序唯一权威、崩溃窗口可推理。
- **write-through 语义（AD-16/F(8).1 收口）**：service 只产领域事件；持久化 = 事件行 + 状态整体（快照 + 生命周期 + 工具记录）经同一 FIFO 落盘，`await` 返回时已可查（非批量延迟）。流式 delta 不进队列（由调用方保证，无入口）。
- **分仓 FIFO（每会话独立仓位）**：按 `session_id` 路由——仓内严格 FIFO（同会话事件行先于状态行、删除行晚于一切写），仓间互不阻塞（A 会话写高峰不队头阻塞 B 会话）；无会话维 job（报告文件/默认模型/资源差异行）走全局链。删除入本会话仓尾部：此前已入队的写全部先落盘，删除不会被早到的状态写复活。
- **贫血行模型（AD-17 第 4/5 条）**：`rows/` 目录只放与表一一对应的纯数据形状，domain 不 import 该目录；充血↔贫血转换只在 `RowMapper`，JSON 序列化在此收口。`updated_at` 取映射时刻墙钟（投影元数据，非领域数据，不经 ClockPort）。
- **不做迁移框架**：v0 建表即用（IF NOT EXISTS 幂等）；旧库升级走「守护式列级演进」而非版本表。取舍依据：迭代边界内列只增不改义，框架是过度设计。

## 演进史

1. **初版（单仓 FIFO）**：WriteQueue 单链全局串行——简单正确，但多会话后 A 会话长写阻塞 B 会话读后写。
2. **分仓化**：引入 `sessionTails` 分仓 + 全局链，仓内/仓间顺序语义如上；`architecture-feedback #19` 将该结构定档。
3. **实例列引入**：`domain_events.agent_instance_id` / `tool_calls.instance_id` 列与复合 PK（agent_lifecycle 单列 PK → (session_id, instance_id)）。SQLite 无法 ALTER 主键，走守护式重建（rename→create→copy→drop，事务包裹）；旧行 instance_id 回填 `'main'`。NOT NULL 补列强制 DEFAULT 恰与旧行回填机制吻合：存量行自动落 `'main'`（主实例固定 id），新行恒显式写入。
4. **closure 双产物表**：`closure_records` 记录行（closure 五字段 + findings JSON，每收口一行追加重语义）+ `<home>/reports/<session>/<agentId>.md` 文件产物（tmp 写 + rename 原子替换，与 SQLite 写同链串行——崩溃不留半文件，TR-AD-13）。
5. **全局单行/差异表**：`default_model`（AD-2 auth 分层：经常变的状态不进 JSON，进 SQLite；id 固定 1 行，CHECK 钉死单值）；`resource_state`（profile kind 维启停差异行，主键 (profile_kind, resource_type, name)；缺省无记录 = 启用——零配置兼容现状、存量零迁移；model 槽位原子替换 = 同 job 内先清后插，防主键含 name 遗留旧行破坏单行不变式）。
6. **图片列**：`tool_calls.images`（data URL 数组 JSON 文本；可空无默认——旧行 NULL = 无图，读取侧 undefined 前向兼容）。
7. **轻量元数据读面**：`session_state` 经 json_extract 只取首条 entry 的 role/text（session.list 读面不随会话体量线性传输）；首条非 user entry（理论不可达）防御 null。
