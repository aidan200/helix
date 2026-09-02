# 知识节点退役清理通道（领域设计）

> 状态：设计稿（待用户裁决，未实施）
> 范围：仅本文档；不改代码 / DDL / 测试 / skill，不执行 kg-update，不动 E-10 节点本体
> 相关节点：E-10（supersede 链）、E-39（kg.db 单库表模型）、E-41（SqliteKnowledgeStore 写落库契约）、E-9（锚）、TR-20（SQLite 单写面）、TR-21（kg 知识层唯一写入口）、TR-33（kg 写面不变式）、TR-34（KgWriteService 写契约）

---

## 0. 背景与现状

**用户裁决**：superseded 留史（审计链）机制**保留**，但用户需要**清理权限**——知识库随沉淀增大，无用知识需有删除入口。

**现况事实**（均经代码与库内数据核实，2026-09）：

| 面 | 现状 |
| --- | --- |
| 写面 op | 八类：createNode / updateNode / supersede / declareAnchors / addEdge / batchCreateNodes / proposeCandidate / decideCandidate——**无 delete**（TR-34 判别式联合） |
| 清理能力 | 唯一清理是 `kg.graph.purge` 整库清空（KgMaintenanceService.purge → store.purgeAll 九表全清 + meta 归零；UI 两步确认 + daemon 机械复核门禁：运行中 kg-bootstrap 任务拒绝） |
| 库内存量 | nodes：confirmed 121 / draft 5 / superseded 15；seq 计数器 seq:rule=53、seq:entity=88、seq:candidate=28 |
| 引用现状 | edges 表**零**引用 superseded 节点；candidates.applied_node_id 3 条（CAND-1→TR-23、CAND-2→TR-51、CAND-3→E-45）全部指向现行节点，当前无悬挂 |
| 引用约束 | edges / anchor_decl / materialized_anchors / candidates 均**无 DB 级外键**（schema 无 FOREIGN KEY 声明，SQLite FK 默认关闭）——全部为应用层软引用，删除不触发任何 DB 级联 |
| 审计链载体 | change_log 表（AUTOINCREMENT seq + op/node_id/supersede_of/reason/ts），是库内审计界面（AD-9）；**supersede 链由 change_log.supersede_of 承载（不在 edges 表）**；kg.change.report（F5.3）依赖 change_log |

**设计目标**：为 superseded（及悬空 draft）节点提供**用户显式清理入口**——单节点与批量两种粒度，级联处置全部软引用，不破坏审计链语义（或按用户裁决取舍），保持生命周期单通道。

---

## 1. 领域决策：物理 DELETE vs 新终态 archived

### 1.1 两方案对比

| 维度 | A. 物理 DELETE（行删除 + 审计链处置） | B. 新终态 archived（软删/标记） |
| --- | --- | --- |
| 存储效果 | 行真正消失，库体积回落，无用知识彻底删除 | 行仍在，仅 status 翻转；体积不降——「清理」诉求（删无用知识）不满足 |
| 恢复能力 | 无恢复（除非 change_log 保留留史可追溯） | 可恢复（改回 superseded/confirmed 需新通道） |
| 对 E-10 修订幅度 | **大**：E-10 核心不变式「id 永不回收、不物理删」被打破，需加例外条款（见 1.3） | **小**：不物理删不变式保留，但状态机/DDL/类型/读面全部新增一个终态值 |
| 状态机影响 | 不变（draft/confirmed → superseded 仍唯一迁移；superseded 仍不可再翻）；新增的是「退役通道」而非状态迁移 | 新增迁移 superseded → archived（supersedeTransition 扩）、NodeStatus 扩四值、nodes.status CHECK 扩、TR-33 status 枚举扩 |
| 读面影响 | 小：getNode 对已删 id 返回 null（既有语义）；链查询需兜底「已删除」渲染 | 中：所有读面过滤条件（快照/反查/搜索/计数）加 archived 排除项（E-42 现过滤 superseded，需同步扩） |
| 审计语义 | change_log 可保留 → 审计链完整（谁在何时清了什么）；可同清 → 彻底抹除 | 审计链天然完整（行在），但「留史」变成「留尸」——与用户「无用知识删除」诉求相悖 |
| 误删防护 | 依赖两步确认 + 门禁 + 审计留史 | 天然有恢复余地 |
| 实施复杂度 | 中（单事务多表 DELETE + 级联 + 校验扩） | 中高（状态机 + DDL CHECK + 类型 + 全读面过滤同步） |

### 1.2 推荐：物理 DELETE（方案 A）

理由：

1. **用户诉求是「无用知识删除」**——archived 只是换标签，行与体积不动，「清理」名不副实；
2. **留史价值已由 supersede 机制承担**：被推翻的知识在被 supersede 时已把理由写进 change_log 审计链；退役清理是**链尾终态**的物理处置，不是对留史机制的绕过——「superseded 留史机制保留」与「superseded 可清理」在时序上不冲突（先留史，后按用户意志清行）；
3. **supersede 生命周期通道本身不受影响**：draft/confirmed → superseded 唯一迁移、replacement 新号挂链等状态机行为逐字节不变——退役是 superseded **之后**的可选人工通道，不是新状态。

### 1.3 对 E-10 的修订幅度声明（设计倾向，待用户裁决）

> **本文档设计结论：若采纳方案 A（物理 DELETE），E-10 需要修订，修订幅度如下。本声明仅为设计文档内的决策点标注，不执行 kg-update——实施阶段由用户裁决后走 supersede 协议。**

E-10 现文核心不变式：「supersede 不可原地改」「旧知识留史可查」「**id 永不回收**」「**不物理删**」「superseded 是终态」。方案 A 的修订语义：

- **「不物理删」→ 修订为「不物理删是默认态；经用户显式退役通道（retire）可物理删除」**：supersede 状态机行为（翻 status 不换号、replacement 新号挂链）不变，新增独立退役通道只对 superseded（及悬空 draft）开放；
- **「id 永不回收」→ 修订为「id 永不回收（seq 单调只增，空洞不复用）；退役删除不降低计数器、不主动复用」**：见 1.4 核实结论；
- **「superseded 是终态」→ 修订为「superseded 是状态机终态（不可再翻 status）；可经退役通道物理清除」**：状态机终态与「可被外部清除」不冲突——清除不是状态迁移。

修订面清单（实施阶段落点，本设计不实现）：E-10 节点本体（supersede 链）、TR-21（写入口 op 面）、TR-34（八类 op 判别式 → 九类）、TR-33（status/op 枚举扩）、E-39（如选 change_log 同清则涉及表语义）、E-41（落库分支）。若用户裁决方案 B，则 E-10 修订幅度转为状态机扩展（1.1 表），本设计不展开。

### 1.4 删除后 id 复用问题（meta seq 单调只增——已核实）

**核实结论（代码 + 库内数据）**：

- `allocateSeq`（SqliteKnowledgeStore）：事务内 `currentSeq + 1` 后立即落库（`setSeq` upsert meta），注释明示「计数器只增，+1 后立即落库防复用」；
- `bumpSeq`（显式保号迁移通道）：仅在 `seq > currentSeq` 时抬升，**只增不减**；非数字尾缀显式 id 不推进计数器（后续自动发号不回卷撞号）；
- `purgeAll`：唯一将 seq 计数器归零的路径——但它同时清空全部历史行，「重新发号自 TR-1/E-1 起」无复用冲突面（代码注释原文）；
- 现库值：seq:rule=53、seq:entity=88（nodes 总数 141 = 53 + 88，与「只增不发虚号」自洽）。

**结论**：**单节点物理删除后，id 空洞不复用**——计数器继续单调推进，新节点 id 永不含被删号段（除非走显式保号 createNode 迁移通道手动指定被删 id，该通道本就存在且删除后无冲突；设计建议：不主动复用，保持「id 永不回收」的可观测语义，仅文档声明保号通道可复用但不推荐）。**方案 A 不引入 id 复用问题**，E-10「id 永不回收」修订幅度因此可控（1.3）。

---

## 2. 级联策略矩阵

删除目标 = 单个节点（单节点通道）或一组节点（批量通道，同矩阵逐节点应用）。**全部级联在同一个 BEGIN IMMEDIATE 事务内完成**（继承 writeKnowledge 单 op 单事务纪律，E-41；零部分落库）。

| 表 | 引用列 | 处置 | 理由 |
| --- | --- | --- | --- |
| nodes | 被删节点行 | **DELETE** | 清理目标本体 |
| edges | src_id / dst_id | **级联 DELETE**（src 或 dst 命中即删该边，同事务） | 边无独立生命周期，悬挂边破坏图谱完整性；现库无 superseded 出边/入边（数据核实），影响面小 |
| anchor_decl | node_id | **级联 DELETE** | 锚声明随节点消亡；声明离开节点无意义 |
| materialized_anchors | node_id | **级联 DELETE**（含 orphan=1 行） | 物化锚随节点消亡；orphan 行是「符号消亡的活跃节点锚」检出输入（T5.1），节点本体已删则孤儿锚无宿主，一并清除 |
| change_log | node_id / supersede_of | **默认保留（审计），可选同清（决策点 D2）** | 见下 |
| candidates | applied_node_id | **置 NULL（保留候选行）；可选保留悬挂 + 读面兜底（决策点 D6）** | candidate 是独立台账（R2/R3），applied 裁决记录不因节点删除而抹除；applied_node_id 变悬挂 → 置 NULL 表示「formal 节点已退役」，formal_id 语义降级为「曾签发」 |
| meta | seq:* | **不动** | 计数器只增不回退（1.4），id 空洞不复用 |

### 2.1 change_log 处置详解（决策点 D2）

change_log 是被删节点唯一的审计留存载体（supersede 链、kg.change.report 的数据源）：

- **保留（设计默认）**：审计链完整——「谁、何时、以何 op、为何删除了节点」可查；被删节点的 createNode / supersede / retire 行全部留存，node_id 指向已不存在行，读面渲染为「已删除 <id>」。**代价**：审计行残留（15 个 superseded 节点现共 43 行 change_log——数据核实：每个 2~4 行），体积压缩不完全。
- **同清**：彻底抹除该节点的全部痕迹——满足「无用知识删除」的极致诉求。**代价**：审计链断裂（kg.change.report 出现无主行），且与「superseded 留史机制保留」的用户裁决张力最大。**不推荐**，除非用户明确要求「清理=彻底遗忘」。

**设计默认：保留**。理由：用户裁决「superseded 留史（审计链）机制保留」——退役通道应继承该语义（删内容、留史痕），而非推翻它。

### 2.2 supersede 链读面兜底（保留 change_log 时必做）

supersede 链由 change_log.supersede_of 双向游走组装（E-42 buildSupersedeChain，older/newer 方向 + 步数上限 128 + 环防护）。被删节点在链上时：

- older 方向：本节点 create 行 supersede_of 指向已删节点 → 链环节点 getNode 返回 null；
- newer 方向：他节点 create 行 supersede_of=已删节点 → 同上。

**读面兜底要求**：getNode 详情与 kg-viewer 详情面板的链渲染需对「链上节点已删除」做降档处理——渲染「已删除 <id>」（无 name/无跳转），不抛错、不中断链展示。当前 getNode 对不存在 id 返回 null（E-42 既有语义），聚合层需将 null 链环节点降档为占位。**实施阶段落点**：SqliteKnowledgeGraph.buildSupersedeChain / getNode 聚合 + kg-detail-pane 链渲染。

### 2.3 批量通道的级联语义

批量清理（一键清全部 superseded）逐节点应用同一矩阵，**整批单事务**（继承 batchCreateNodes 先例：先全量校验（全部目标 id 存在 + 状态可清），后单事务执行，任一项失败整批回滚零部分落库——O-5）。change_log 处置同 D2（批量时每节点逐条记账，可含批量 op 单行汇总 + 明细行两种记账形态，决策点 D5 附议）。

---

## 3. 入口与门禁

### 3.1 UI 入口

| 入口 | 落点 | 行为 |
| --- | --- | --- |
| 单节点清理（superseded） | 已取代折叠区行（kg-viewer P2③：status=all 视图折叠组内行）+ 节点详情面板（kg-detail-pane） | 行 hover「清理」按钮 / 详情页危险区「清理此节点」→ 两步确认 → 触发删除 |
| 单节点清理（draft） | draft 段行 + 节点详情面板 | 同上；文案区分「删除草稿」（草稿无审计价值，确认文案更轻） |
| 批量清理 | 已取代折叠组头部「清理全部已取代（N）」按钮（kg-viewer P2③ 折叠组） | 两步确认 + **影响面预览**（将删 N 节点 / 级联 M 边 / 审计留史提示）→ 触发批量删除 |
| 入口可见性 | superseded 折叠组内行与 draft 段行 | 仅对应 status 可见；confirmed 行**不出现**清理入口（必须先 supersede，见 §4） |

**两步确认先例（kg.graph.purge）**：kg-index-panel 内联 confirm box（`kgv-confirm-box`：确认文案 + 确认/取消按钮），且 daemon 侧机械复核「UI 两步确认不信赖」（handlers/kg.ts 注释）——清理通道沿用同一模式：**前端两步确认是体验层，门禁判定必须在 service/落库层机械执行**。

### 3.2 agent 工具 op（kg-update 新 op 形态）

两形态对比（决策点 D5）：

| 形态 | 落点 | 优劣 |
| --- | --- | --- |
| **A. 知识层 op `deleteNode`（推荐）** | KnowledgeWriteOp 判别式扩第九类（TR-34）、validateKnowledgeWriteOp 扩（TR-33）、kg-update 工具 op 枚举扩、SqliteKnowledgeStore 落库分支（级联同事务） | 生命周期语义留在写面：change_log 自动记账（op='deleteNode'）、错误码复用（KG_E_ID 目标不存在 / KG_E_STATE 状态不可清 / KG_E_INTERNAL）；批量 = 循环调用或 batchDeleteNodes（batch 先例） |
| B. 维护面命令（kg.graph.delete_nodes） | KgMaintenanceService 扩（同 purge 先例） | 更贴近「维护操作」语义、天然批量；但绕开写入口校验链（TR-21 唯一写入口约束），且不进 change_log 自动记账（需手工补账） |

**设计倾向：A**——kg 知识层唯一写入口（TR-21）是全部写 op 的纪律面，退役清理是生命周期语义的一部分（§1.3 修订面），应进写面而非另开维护旁路；批量入口在 A 上叠加（kg-update 加 `batchDeleteNodes` 或工具层循环，循环与批量并存且结果等价——batchCreateNodes 先例 CL-2-T14）。

op 载荷建议形态（实施阶段细化）：

```ts
{ kind: "deleteNode", nodeId: NodeId, reason: string, iterationId?: string, taskId?: string }
// 批量：{ kind: "batchDeleteNodes", nodeIds: NodeId[], reason: string, ... }
```

- `reason` 必填（对齐 supersede 的「理由必填双防线」先例，handlers/kg.ts kg.node.supersede）；`reason` 与迭代/任务元数据入 change_log（D2 保留时）。
- 校验器新增叶子校验（TR-33 扩展）：nodeId 形态（isValidNodeRef 同构）、reason 非空、**状态门禁**（仅 superseded / 悬空 draft 可清，见 §4）——状态门禁在落库层以 KG_E_STATE 兜底（同 supersede 先例：校验层前置 + 落库层事务内复核）。

### 3.3 批量清理（一键清全部 superseded）

- 入口：折叠组头部按钮（3.1）+ kg-update 工具 `batchDeleteNodes`（带 nodeIds 显式清单，不接受「全部」通配——通配语义留给 UI 层组装清单，工具面保持显式）；
- 门禁：两步确认（UI）→ 影响面预览（前端由 kg.list 数据组装：N 个节点 + 级联引用计数）→ daemon 机械复核（状态可清集合 + reason 必填）→ 整批单事务；
- **任务门禁（决策点 D7）**：复用 purge 门禁先例（PURGE_GATE_STATUSES = running/pending 的 kg-bootstrap 任务存在时拒绝，kg.graph.purge_blocked 词表）——保守默认**复用**，防批量清理与任务产出批次在节点集上竞争；单节点清理是否也过此门禁（建议：单节点同步检查，成本低）。

### 3.4 门禁汇总（service/落库层机械执行，不信赖 UI）

| 门禁 | 判定 | 错误码 |
| --- | --- | --- |
| id 形态 | isValidNodeRef（TR-n/E-n + 保号复合形态） | KG_E_SCHEMA |
| 目标存在 | nodes 行存在 | KG_E_ID |
| 状态可清 | status ∈ {superseded} ∪ {draft 且悬空（决策点 D3 细化）}；confirmed → KG_E_STATE「必须先 supersede」 | KG_E_STATE |
| reason 必填 | 非空字符串（双防线：校验器 + 落库） | KG_E_SCHEMA |
| 任务门禁（批量） | 运行中/pending kg-bootstrap 任务（同 purge） | kg.graph.purge_blocked（复用词表或新增） |
| 不可逆 | 无 undo；误删恢复依赖 change_log 留史（D2 保留时） | — |
| 幂等 | 目标不存在 → KG_E_ID（不静默成功——显式反馈，防重复点按误判） | KG_E_ID |

---

## 4. 可清理范围判定

| 状态 | 可清？ | 判定与理由 |
| --- | --- | --- |
| **superseded** | **可清（核心纳入项）** | 状态机终态、留史已入审计链；用户裁决明确指向它。唯一前置：reason 必填 + 两步确认 |
| **draft（悬空）** | **可清（设计纳入，决策点 D3）** | 悬空定义（建议）：无物化锚 ∧ 无出/入 edges ∧ 无 supersede 链环节点（change_log 无 supersede_of 关联）——即「从未落地到任何代码挂接面」的纯草稿。现库 5 条 draft（TR-40/41/42/47/48）需实施时逐条按此判定。草稿无审计价值（未 confirm 未发布），删除最无争议 |
| draft（非悬空：有锚/被引用/在链上） | 可清但**强制影响面提示**（决策点 D3 附议） | 有锚说明曾被附着管线使用；被引用说明有依赖。允许清（草稿无正式价值），但 UI 预览必须展示将级联的影响 |
| **confirmed** | **不可直接清** | 必须**先 supersede 再清**——保持生命周期单通道：`create → confirm → supersede →（可选）retire`。confirmed 直接删除会绕开审计链（无「被推翻」记录就消失），破坏 E-10 语义。落库层以 KG_E_STATE 机械拒绝 |

**生命周期单通道表述（修订后）**：

```
createNode → draft/confirmed ──supersede──→ superseded（终态，留史）
    │                            │
    └── updateNode（元数据）      └──deleteNode（retire，用户显式清理，物理删）
```

confirmed 到删除之间**必经 supersede**——这正是「superseded 留史机制保留」与「清理权限」两条用户裁决的接缝：留史发生在 supersede 时刻，清理发生在留史之后。

---

## 5. 决策点清单（需用户裁决）

| # | 决策项 | 设计倾向 | 影响面 |
| --- | --- | --- | --- |
| D1 | 物理 DELETE vs archived 软删 | **物理 DELETE**（§1.2） | E-10 修订幅度、存储效果、恢复能力 |
| D2 | change_log 处置：保留审计 vs 同清 | **保留**（§2.1） | 审计链完整性、体积压缩程度 |
| D3 | draft 是否纳入清理范围（悬空必清 / 非悬空提示后清） | **纳入**（§4） | 可清集合边界 |
| D4 | 是否要批量入口（一键清全部 superseded） | **要**（§3.3；现库 15 行，批量价值明确） | UI + 批量 op 形态 |
| D5 | 批量 op 形态：deleteNode 知识层 op（+batchDeleteNodes）vs 维护面命令 | **deleteNode / batchDeleteNodes 知识层 op**（§3.2） | TR-21/TR-33/TR-34 修订面 |
| D6 | candidates.applied_node_id 悬挂处置：置 NULL vs 保留悬挂+读面兜底 | **置 NULL**（§2） | candidate 台账语义 |
| D7 | 批量清理是否复用 purge 任务门禁（运行中 bootstrap 拒绝） | **复用**（§3.3） | 与任务产出的并发安全 |
| D8 | 显式保号通道是否允许复用被删 id | **允许但不主动**（§1.4） | id 可观测语义 |
| D9 | E-10 修订幅度确认：物理删例外条款（§1.3） | 采纳方案 A 时修订 | E-10 supersede 申报（实施阶段执行） |

---

## 6. 实施落点映射（仅列位置，本设计不实现）

| 层 | 落点 | 改动 |
| --- | --- | --- |
| domain | `domain/kg/types.ts` | KnowledgeWriteOp 扩 `deleteNode`/`batchDeleteNodes` kind（九/十类）、NodeStatus 不变（方案 A 无新态） |
| domain | `domain/kg/supersede.ts` | 不变（退役非状态迁移）；如方案 B 则扩 archived |
| application | `KgWriteService.ts` | validateKnowledgeWriteOp 扩：nodeId 形态、reason 必填、状态门禁（TR-33） |
| driven | `SqliteKnowledgeStore.ts` | writeKnowledge 扩 deleteNode 分支：级联 DELETE（§2 矩阵）同事务 + change_log 记账 |
| driven | `tools/kg-update/KgUpdateTool.ts` | op 枚举扩 deleteNode/batchDeleteNodes + 参数 schema |
| driving | `ws-server/handlers/kg.ts` + `shared/api/commands.ts` | kg.node.delete / kg.graph.batch_delete 命令帧 + 门禁复核 |
| shell | `kg-viewer.tsx`（折叠区行/组头）、`kg-detail-pane.tsx`（危险区） | 清理入口 + 两步确认 + 影响面预览 |
| shell | `SqliteKnowledgeGraph.ts`（读面） | 链渲染「已删除 <id>」兜底（D2 保留时必做） |
| 知识层 | E-10（及 TR-21/TR-33/TR-34 连带） | 用户裁决后走 supersede 协议（§1.3） |

---

## 7. 附：本设计未覆盖 / 明确不做

- 不做 change_log 表本身的归档/压缩（D2 裁决同清时才涉及表语义）；
- 不做「回收站/软删除后定时物理清」类两级通道（超出用户裁决范围，D1 若选 archived 再议）；
- 不做 confirmed 直删（§4 机械拒绝，生命周期单通道是硬约束）；
- 不动 E-10 节点本体与主工作树其他文件（本设计仅文档）。
