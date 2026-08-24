# P1 会话模式框架 — 计划文档

> 状态：已确认（对话式设计评审，用户逐点拍板）
> 日期：2026-08-24

## 背景与动机（traceability）

现状问题（探查报告见对话）：
1. chat header 右上模型徽标在草稿态显示「本地所选 ?? 全局默认模型」，但全局默认只是构造期 fallback，main-session 槽位已配时被遮蔽 → 显示与实际脱节；
2. header 左侧 "main-session" chip 是静态 i18n 词条，无数据绑定；
3. session 与 agent 的绑定关系是硬编码（SessionRegistry 建会话固定 profileKind="main-session"），无模式概念。

用户目标（原话摘要）：
- 「删除默认模型的逻辑」→ 修订为：**保留默认模型**，但存储从独占表迁通用 KV 表（用户：「为了一个配置独占一个 sqlite 表有点多余了，应该创建一个专门的运行时配置的 kv 结构表」）。
- 新增「模式」概念：session 一对一绑定模式；默认模式 "default" = main agent 绑定 main-session。新会话直接显示 main agent 配置的模型和推理等级。
- 模式可切换，**仅草稿态（首条消息前）可切，且是设置模式的唯一入口**；开始对话后锁定（结构化实现：无第二条写路径）。
- 扩展性要求：第二模式 = 阶段迭代（design/build/verify 三阶段 agent + 上下文交接摘要 + 欢迎词）；第三模式 = 动态工作流编排（编排者 agent + 循环/并行/分支/节点退出，node = agent 或逻辑节点）。**本期只做 P1 框架 + default 模式**，P2/P3 后续迭代。

## 关键设计决策（用户拍板记录）

| # | 决策 | 用户原话锚点 |
|---|------|--------------|
| D1 | 默认模型保留，存储迁 `runtime_config` KV 表 | 「创建一个专门的运行时配置的 kv 结构表，便于扩展」 |
| D2 | Port 层一步到位抽 `RuntimeConfigPort`（路 B） | 「2、B」 |
| D3 | 模式切换：仅草稿态、唯一入口、建会话后锁定 | 「仅草稿可切换，也是设置模式的唯一入口」 |
| D4 | mode 随 `chat.send{draft:true, mode}` 透传，无独立 `mode.set` 命令（锁定语义 = 结构不可能，非校验拒绝） | 设计推导，用户认可 |
| D5 | 交接摘要时机倾向 T1（切换时收口生成）——P2 定 | 「我的倾向是 T1」后用户未反对，P2 再确认 |
| D6 | 过程信息生命周期 = 临时（session 级），持久化归未来「项目知识图谱」 | 「过程信息的生命周期是临时的，仅用于某个模式的某个 session 中，一旦结束了就不需要了，需要持久化的信息都在知识图谱」 |

## 架构约束（含对未来 P2/P3 的指导）

1. **过程空间边界（D6）**：phase 迭代空间 / workflow 工作流空间 = daemon session 聚合内临时态（内存+事件流），会话结束销毁；不落 workspace 文件、不建持久表。跨会话沉淀走知识图谱（未来概念）。
2. **P1 不做 last_mode**（最小实现；KV 表结构已支持将来加键）。
3. P-3 模型菜单、composer thinking picker、SubAgent 解析链、AgentPage 本期不动。
4. 锁定语义：session.mode 建会话时定格落库，此后无任何写路径（快照只读回带）。
5. ModeSpec schema 需能表达三模式（single/staged/orchestrated）而不返工。

## 协议形状（P1 定稿）

```ts
// protocol：模式注册表（常量，daemon/前端共享）
interface ModeSpec {
  id: string;                    // "default" | ...
  kind: "single" | "staged" | "orchestrated";
  profileKind: string;           // single/orchestrated 的绑定
  stages?: readonly StageSpec[]; // staged 模式（P2）
}
interface StageSpec { id: string; profileKind: string; welcomeKey?: string }

MODES = [{ id: "default", kind: "single", profileKind: "main-session" }]
```

- `chat.send` draft payload 增可选 `mode`（缺省 "default"，旧客户端兼容）。
- `session.snapshot` / `connection.welcome` 增可选 `mode` 字段（additive，protocol 版本按既有惯例处理）。
- `session_state` 表增 `mode` 列（additive，建会话定格）。

## 任务分解（SDD 派工）

| id | 任务 | 验收标准 |
|----|------|----------|
| T1 | runtime_config KV 表 + RuntimeConfigPort + 迁移 | ① 建表 SQL 落 sqlite-session，走 WriteQueue 单写通道；② RuntimeConfigPort + 实现替换 DefaultModelPort/DefaultModelStore（组合根装配更新，DefaultModelPort 文件删除）；③ 旧 default_model 表数据迁移进 KV（幂等，测试覆盖）；④ DefaultModelStore 集成测试改写后全绿 |
| T2 | protocol 模式注册表 + 帧字段 | ① ModeSpec/StageSpec/MODES 常量（TS 类型 + 单测）；② chat.send draft payload.mode 可选字段；③ 快照/welcome additive mode；④ protocol 单测更新全绿 |
| T3 | daemon 建会话链消费 mode | ① 模式注册表单点（domain 或 application 层，含未知 mode fallback "default"）；② startDraftSession 按 mode 解析 profileKind；③ 热草稿复用条件加「mode 一致」，不一致丢弃重建；④ session.mode 落库 + 快照回带；⑤ 建会后无写路径（锁定）；⑥ daemon 测试覆盖含 mode 透传/不匹配重建/缺省 default |
| T4 | shell 前端 | ① header "main-session" 静态 chip → 模式选择器（草稿可切/已建只读显示 session.mode）；② 草稿徽标链 = 本地暂存 ?? 当前模式 profileKind 槽位模型 ?? 全局默认；③ thinking picker 草稿刻度基准换槽位模型能力位；④ chat.send draft 带 mode；⑤ 切模式丢弃本地 draft model/thinking 暂存；⑥ shell 测试更新全绿 |
| T5 | 全链路 verify | ① daemon+shell 全测试绿；② tsc 零错；③ DefaultModelPort/default_model 残留 grep 清零（迁移代码除外）；④ 守护测试（AG-*）对齐 |

依赖：T2 → T3 → T4；T1 独立可并行。T5 收尾。

## 涉及知识节点（完成后提议同步，不自行写入）

- TR-AD-24 系（模型解析链——全局兑底存储表述）
- E-AgentProfile（AD-3 修订段——默认模型兜底表述）
- CL-1/AD-2（配置落点——default_model → runtime_config）
- 新候选：会话模式机制（含 D6 过程信息边界原则）
