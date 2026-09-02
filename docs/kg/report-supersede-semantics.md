# 「修改 vs 取代」语义展开设计（report-supersede-semantics）

> 状态：**设计稿，待用户裁决**（本文件只产出设计，不实施）。
> 触发：体检产出呈现「修改和取代逻辑重复」的用户反馈（2026-09）。
> 管辖域：kg 知识生命周期（supersede 通道）· 变化报告（F3.3 四类条目）· 候选台账（candidates）。
> 关联节点：E-10（supersede 链）、E-39（kg.db 表模型）、E-41（SqliteKnowledgeStore 写落库契约）、E-45（kg 验证期检查）、TR-46（候选台账落账链路）、E-50（kg 双工具）、TR-34（KgWriteService 写契约）。
> 关联代码：`apps/daemon/src/application/services/kg/KgReportService.ts`、`apps/daemon/src/domain/kg/supersede.ts`、`apps/daemon/src/adapters/driven/sqlite-kg/SqliteKnowledgeStore.ts`、`apps/daemon/src/application/services/scheduler/ClosureRecorder.ts`、`apps/daemon/src/adapters/driven/sqlite-kg/schema.ts`、`apps/daemon/resources/skills/kg-review/SKILL.md`。

---

## 1. 背景与问题实证

用户反馈「体检产出呈现『修改和取代逻辑重复』」。调查确认三处机制（可直接引用为结论）：

### 机制①：supersede+replacement 一个事务写两行 change_log，报告逐行生成镜像叙述

`SqliteKnowledgeStore.applySupersede`（`SqliteKnowledgeStore.ts:212-247`）在单事务内：

- 行 230：`appendChangeLog(db, iterationId, "supersede", op.nodeId, op.nodeId, op.reason, taskId)` —— **翻态行**（`node_id`=被取代者，`supersede_of`=自身，挂入自身历史链）；
- 行 245：`appendChangeLog(db, iterationId, "createNode", replacementId, op.nodeId, op.reason, taskId)` —— **新建行**（`node_id`=新号，`supersede_of`=被取代者，新节点挂旧链）。

两行携带**同一 reason**。`KgReportService.buildChangeReport`（`KgReportService.ts:124-139`）对 change_log **逐行**调用 `knowledgeChangeBody` 生成叙述条目：

- supersede 行 → 「本迭代以「reason」为由推翻了规则「旧」——旧知识进入取代链，不再约束后续实现。」（`KgReportService.ts:164-167`）
- createNode 行 → 「本迭代以「reason」为由新增了规则「新」（digest）接替规则「旧」——过时知识完成事后修正（AD-5）。」（`KgReportService.ts:153-160`）

**实证**：`.helix-kg/kg.db` change_log seq 933/934（TR-43 被 TR-50 取代，两行 reason 前缀一致）；测试 `kg-report-service.test.ts:173-187`「⑤ knowledge_change 因果叙述：五 op 各有叙述」明确断言 supersede+replacement 产出**两条独立条目**（一条含 reason「写路径口径已演进」+ 被取代节点 refs，一条含接替者名「新写路径规则」）。

**用户感知**：同一变更在报告里出现两条并排叙述，reason 重复出现两次，且叙述用词（「推翻了」vs「新增了…接替…」）看起来像「既修改又取代」两件不同的事。

### 机制②：E-10「终态不可原地改」使「修改」类候选落地必走新号替换，与「废弃」处置动作同型

`supersedeTransition`（`domain/kg/supersede.ts:11-16`）：`draft/confirmed → superseded` 是唯一合法迁移，superseded 是终态（再翻拒绝，落库层附「再推翻走 replacement 新号」）。`KgWriteService` 的 `updateNode` op 仅限 scene 等元数据补全（E-50 描述），**内容改动一律走候选人审 → 落地时 supersede 旧号 + createNode 新号**。

**实证**：CAND-2（`修改：TR-43`）人审 applied 后的落地 = supersede TR-43 + createNode TR-50（seq 933/934）；随后 TR-50 承接链中间态收口再次 supersede + createNode TR-51（seq 937/935）。「修改」的每一次内容演进，在处置层都表现为「翻态 + 新号」——与「废弃」候选（supersede 旧号，replacement 可缺省）走**同一通道**，仅区别在 replacement 有无。

**用户感知**：既然修改和废弃的处置动作同型（都是「取代旧号」），台账/报告中「修改」与「废弃」的边界不清，修改被读成「取代」。

### 机制③：台账存在同 targetNode 重复候选（本库 E-59/E-85 各 2 条 pending），findings 管道无机械去重

`SqliteKnowledgeStore` 的 proposeCandidate 落库（`SqliteKnowledgeStore.ts:308-329`）为**纯 INSERT**（自动发号 CAND-<seq>），无 upsert、无查重。`ClosureRecorder.mapFindingsToOps`（`ClosureRecorder.ts:285-287`）把 SubAgent closure findings 的每条 sediment 条目机械映射为一条 proposeCandidate op——同一节点在不同批次/不同轮次被重复评审发现时，**逐次各落一条 pending**。

**实证**：`.helix-kg/kg.db` candidates 表：CAND-19 与 CAND-20 均为 `修改：E-59`（pending，reason 各异：正文 broadcastAgentCon 段 / digest「六个系统广播帧」过期）；CAND-24 与 CAND-28 均为 `修改：E-85`（pending）。`kg-review/SKILL.md` 重跑幂等段（line 72）仅提示「重跑批次先查本批已提候选，避免同批重复落账」——纯 LLM 自觉，无机械层兜底。

**用户感知**：审核面同一节点出现多条同型候选，人审需要人工辨认是否为同一问题。

---

## 2. 语义模型：修改 vs 废弃（三层一致定义）

核心设计决定：**「修改」与「废弃」不是处置通道的两种动作，而是同一 supersede 通道的两种语义标签**——区分维度 = **被取代节点是否有后继（replacement）**。三层各自给出与此一致的定义：

| 层 | 修改（内容演进，节点有后继） | 废弃（整体失效，无后继） |
|---|---|---|
| **候选层**（审核面：candidates 台账） | `changeType:"修改"`：节点知识主题仍成立，但与代码现实不一致（过期/矛盾/结构不合规），需同主题新版本 | `changeType:"废弃"`：节点知识主题整体失效（规则废除/实体消亡），需解除约束力，无后继版本 |
| **处置层**（E-10 通道：落地动作） | `supersede 旧号 + createNode replacement 新号`（新号承接内容演进；E-10 终态不可原地改，故必走新号） | `supersede 旧号`（replacement 缺省；审计链保留翻态行） |
| **报告层**（通知面：knowledge_change 条目） | **有后继的取代** → 聚合单条「演进」叙述（旧 → 新，内容修正） | **无后继的取代** → 聚合单条「废弃」叙述（旧号失效，不再约束） |

要点：

1. **处置动作同型是既成事实，不是缺陷**——E-10 的审计不变式（supersede 只翻 status 不换号、id 永不回收、推翻理由进 change_log 审计链）要求「任何内容变更都表现为取代」。语义区分不放在**落库动作**上（动作不变），而放在**语义标签**上（replacement 存在性），并由**报告层叙述**显式表达。
2. **候选层与处置层的一一映射**：`修改 → supersede+replacement`（replacement 必填）；`废弃 → supersede`（replacement 缺省）。映射在**人审裁决时**兑现（decideCandidate applied 的落地动作），不改变 findings 管道与候选结构。
3. **报告层聚合**：把机制①造成的「一变更两条目」收敛为「一变更一条目」，叙述按语义标签区分「演进/废弃」，让用户一眼读到「这是修改（有后继）」还是「这是废弃（无后继）」。
4. **审计链不变式**：change_log 的双行（翻态行 + 新建行）是审计链的物理事实（E-10/E-41），**聚合只发生在报告装配层，不合并落库行**——任何方案不得改动 applySupersede 的双行写入。

---

## 3. 报告装配：change_log 双行 → 单条聚合叙述

### 3.1 合并键（不改 DDL 前提下的机械配对）

change_log 无事务 id 列（`schema.ts:73-82`），配对依据字段组合推导。在**同一 iteration_id 内**：

- **supersede 翻态行** S：`op=supersede, node_id=N, supersede_of=N`（翻态行挂自身链）；
- **createNode replacement 行** C：`op=createNode, supersede_of=N`（新号挂旧链），且 `C.node_id ≠ N`（新号）。

配对条件（全部满足才合并）：

1. `C.supersede_of = S.node_id`；
2. `S.supersede_of = S.node_id`（确认 S 是翻态行而非普通 createNode）；
3. `S.iteration_id = C.iteration_id`（同迭代——applySupersede 内两行同 op.iterationId，天然满足）；
4. `S.reason = C.reason`（双保险：同一事务同一 reason；防不同事务巧合碰撞）。

配对结果：

- **命中** → 单条聚合条目（语义 = 修改/演进，见 3.2）；
- **supersede 行无配对** → 单条「废弃」条目（无 replacement 的 supersede，如 L0 批次自我修正的 TR-6~TR-12 翻态行）；
- **createNode 行（supersede_of 非空）无配对 supersede 行** → 理论不可达（applySupersede 双行同事务），防御性降级为单条普通新增叙述（现有 `createNode` 分支）。

链式多次演进（TR-43→TR-50→TR-51）每代独立配对（每代 = 一对 supersede 行 + createNode 行），互不串扰。

### 3.2 叙述模板（报告层 knowledge_change 单条聚合）

按配对结果分三型（保持 AD-5「事件导向/因果链完整」与 AD-16 引用规范——refs 聚合双节点）：

- **演进（有后继）**：「本迭代以「reason」为由将规则「旧名」演进为「新名」（新 digest 首行）——内容随代码现实完成修正，旧号留史入取代链。」
  - refs.nodes = [旧节点, 新节点]（两条 refs，替代现有 createNode 分支的「接替」叙述 + supersede 分支叙述两条）
- **废弃（无后继）**：「本迭代以「reason」为由废弃了规则「旧名」——知识主题整体失效，不再约束后续实现，旧号留史入取代链。」
  - refs.nodes = [旧节点]
- **防御降级**：不满足配对的单行，走现有单行叙述（现状保持）。

实施落点（实施阶段）：`KgReportService.buildChangeReport` 的 knowledge_change 循环（`KgReportService.ts:124-139`）从「逐行 push」改为「先按合并键分组配对、再逐组 push」；`knowledgeChangeBody` 新增聚合分支（或抽 `knowledgeChangeGroupBody`）；测试 `kg-report-service.test.ts:173-187` 断言从「两条独立条目」改「一条聚合条目 + 双 refs」。

### 3.3 四类条目与台账的分工边界（通知面 vs 审核面）

| 面 | 载体 | 语义 | 行动项 |
|---|---|---|---|
| **通知面**（变化报告） | rule_conflict / dead_anchor / suspect_stale / knowledge_change 四类条目 | 已完成事实：机械检查检出（前三类）+ 变更流水叙述（knowledge_change）——「这个迭代发生了什么」 | **不携带**（AD-5：报告=通知面非审核面；`KgReportService.ts:12-16` 头注释明示；条目无 options） |
| **审核面**（候选台账） | candidates 表 pending 行 | 待裁决建议：内容过期/矛盾/废弃的候选——「还有什么待你决定」 | 裁决权在人审（decideCandidate：applied/discarded/deferred） |

分工不变量：**报告永远不替代台账、台账永远不替代报告**。knowledge_change 条目叙述的是「已经落库的事实」（含人审 applied 后的 supersede 落地），而同一问题在裁决前只存在于台账 pending——报告聚合只影响已落库事实的呈现密度，不改变「发现问题 → 提候选 → 人审 → 落地」的闭环位置。`kg-change-report` 模板段库中 knowledge-change.md 的「行动项：待人审事项（draft 转正/supersede 确认，需要你决定）」是 **LLM 装配任务报告时的指引**（kg-change-report 场景段库），与 KgReportService 机械数据面（无行动项）并存不冲突——聚合方案只改数据面的条目形状，模板段库在实施时同步更新叙述句式示例即可。

---

## 4. 台账去重：同 targetNode+changeType 的机械策略

### 4.1 现状与目标

现状：proposeCandidate 纯 INSERT，同 `(targetNode, changeType)` 的 pending 候选逐次堆积（E-59/E-85 实证）。目标：**机械层保证同一问题的候选不重复堆积**，同时不误伤「同一节点不同问题」（不同 reason/evidence）与「同节点不同 changeType」（修改与废弃语义不同）。

### 4.2 两个落点

**落账层去重（recommended 主案）**——`SqliteKnowledgeStore.applyProposeCandidate` 落库前查重：

- 查重键：`(title/targetNode, changeType)`。注意 candidates 表当前**无独立 targetNode/changeType 列**（`schema.ts:128-143`：id/formal_id/kind/title/body/status/...）——targetNode 与 changeType 平铺在 `title`（「修改：E-59」）与 `body`（changeType 首行）。机械解析 = 从 title 前缀（`修改：`/`废弃：`/`新增`）与 body 首行提取，或实施阶段在 candidates 表补列（列演进走 `ensureSchemaEvolved` ALTER 补列，见 E-39）。
- 命中处理三选（决策点 D4）：
  - A1 **skip**：保留既有候选，新提丢弃并 warn 可观测（最简）；
  - A2 **合并**：既有候选 body 追加新 reason/evidence（保留最早 created_at，信息不丢）；
  - A3 **skip+提示**：跳过落账但向上游返回结构化提示（重复定位）。
- 状态范围：**pending + deferred 都算「未决」**——deferred 非终态（可再裁决），同一问题 defer 后重提不得堆积新行；applied/discarded 为终态，不挡新提（新问题新候选）。

**报告层合并（辅助案）**——只合并呈现（3.2 的聚合）或台账展示层按 `(targetNode, changeType, status)` 折叠重复 pending 行。**不解决堆积**：人审面数据仍冗余，且 LLM 重跑时依然逐次落账（库内堆积持续增长）。只能作为落账层去重的补充展示，不能单独根治机制③。

### 4.3 对 defer 语义的影响

- 去重键覆盖 deferred：`defer` 是「暂缓裁决」而非「问题已处理」，同一问题 defer 后重提应命中既有 deferred 候选（skip 或合并），**不产生新 pending 行**——defer_age 计数与软上限警告（`SqliteKnowledgeStore.ts:359-369`）不受影响（既有一行按既有流程推进）。
- 终态（applied/discarded）不参与查重：同节点同问题已裁决后，新发现（如代码再次漂移）是新问题，新开候选正确。
- 查询实现注意：查重 SQL 需覆盖 `status IN ('pending','deferred')`，且按 `(title 归一化, status)` 或 `(targetNode, changeType)` 索引——量级小（台账行数少），顺序扫描 + title 前缀匹配即可，无需新索引（决策点 D1 可选）。

### 4.4 存量重复处置（E-59/E-85 各 2 条 pending）

存量重复不随新逻辑自动消失（已落库行）。处置二选（决策点 D8）：

- 人审 decideCandidate 逐条裁决（重复中一条 applied/discarded，另一条 discarded 注明重复）——零代码；
- 一次性脚本合并（保留最早行、追加 evidence、其余 discarded）——机械但需动库，走 scripts/oneoff 惯例（T5.2）。

---

## 5. 方案对比与推荐

### 方案 A（推荐）：报告层聚合 supersede 双行 + 落账层查重去重

- **内容**：3.2 的聚合叙述（治机制①呈现）+ 4.2 的落账层查重（治机制③堆积）+ 语义标签「演进/废弃」区分（治机制②混淆）。
- **优点**：三处机制一次同解；**零 DDL 变更**（合并键用现有列推导，查重用 title/body 解析或可选补列）；审计链不动（双行 change_log 保留，仅装配层聚合）；改动面收敛在 KgReportService + SqliteKnowledgeStore.applyProposeCandidate + 对应测试。
- **风险**：
  - 合并键无事务 id，依赖字段组合推导——同迭代同 reason 不同事务碰撞概率低但非零；缓解 = reason 一致 + supersede_of 双向校验 + 防御性降级（不满足配对即退化为两条单行叙述，不丢信息）。
  - 查重键解析（title 前缀）对历史脏数据（title 不规范）可能漏判——缓解 = body 首行 changeType 兜底 + 人审存量清理（D8）。
  - 聚合改变现有测试断言（kg-report-service.test.ts:173-187）——预期内，属实施配套。

### 方案 B（最小改动）：仅报告层聚合

- **内容**：只做 3.2 聚合（机制①+②的呈现），台账维持现状（LLM 自觉 + 人审去重）。
- **优点**：改动最小（仅 KgReportService + 测试）；风险面最窄。
- **缺点**：机制③不解决——审核面重复 pending 持续堆积（用户反馈的「重复」只解决呈现一半，审核面照旧重复）；依赖人审手工辨认。
- **适用**：若用户判定台账重复可接受（量小、人审可辨），此案可先行。

### 方案 C（彻底但重）：DDL 加固（change_log.transaction_id + candidates 唯一约束）

- **内容**：change_log 加 `transaction_id` 列（合并键机械确定，不再推导）；candidates 加 `(target_node, change_type)` 列 + 部分唯一约束（status 未决时唯一）；`ensureSchemaEvolved` 补列 + 存量迁移。
- **优点**：合并与去重由库层约束强制，机械确定性最高；跨迭代/跨会话追踪同事务操作成为可能。
- **缺点**：动 E-39 表模型（schema.ts DDL + 演进守护 + 存量数据迁移 + 相关测试）；与「supersede 双行审计链」的既有设计叠加后复杂度上升；本任务范围钳制明确不改 DDL。收益相对方案 A 是边际性（报告聚合与落账层查重已覆盖用户痛点）。
- **适用**：作为后续增强候选（未来需要事务级审计查询时再评估），本期不推荐。

### 推荐结论

**方案 A**：三处机制同解、零 DDL、审计链不动，是用户反馈（呈现重复 + 审核堆积）的最小完备解。风险均有机械缓解。方案 B 可作 A 的前置增量（先聚合呈现、台账去重随后），方案 C 留作未来增强。

---

## 6. 实施落点（实施阶段，本任务不执行）

| 落点 | 改动 |
|---|---|
| `KgReportService.ts` | buildChangeReport knowledge_change 循环改「分组配对 → 逐组叙述」；knowledgeChangeBody 增聚合分支（演进/废弃/降级三型） |
| `SqliteKnowledgeStore.ts` | applyProposeCandidate 落库前查重（pending+deferred 命中 skip/合并）；可选 candidates 补 target_node/change_type 列 |
| `ClosureRecorder.ts` | （若选 A2 合并）无改动——查重在落库层；findings 管道结构不变 |
| `kg-review/SKILL.md` | 重跑幂等段（line 72）从「LLM 自觉查批」升级为「机械去重兜底 + 仍建议批内自查」 |
| 测试 | kg-report-service.test.ts:173-187 断言改单条聚合；新增 kg-supersede-report 聚合用例、proposeCandidate 查重用例（pending 命中/deferred 命中/终态不挡） |
| `kg-change-report` 模板段库 | knowledge-change.md 叙述句式示例同步（演进/废弃分型） |

---

## 7. 决策点清单（需用户裁决）

| # | 决策点 | 选项 | 建议 |
|---|---|---|---|
| D1 | 合并键实现 | ①现有列推导（iteration_id+supersede_of+reason，零 DDL）；②change_log 补 transaction_id 列（方案 C 前奏） | ①（零 DDL，碰撞有防御降级） |
| D2 | 语义映射 | 确认「修改 → supersede+replacement（replacement 必填）、废弃 → supersede（replacement 缺省）」作为处置层唯一映射；废弃是否允许携带 replacement（如「废弃但精华内容并入新节点」） | 严格二义（废弃无 replacement）；「精华迁移」属修改语义（演进为新节点） |
| D3 | 台账查重键 | ①title 前缀解析（零 DDL）；②candidates 补 target_node/change_type 列（ensureSchemaEvolved 补列） | ②更稳（列语义明确、查询可索引），代价是补列演进；量小时①可先行 |
| D4 | 查重命中处理 | A1 skip / A2 合并 reason / A3 skip+结构化提示 | A2 或 A1（A2 信息不丢，A1 最简；取决于用户对 evidence 保留的偏好） |
| D5 | 报告条目形态 | ①label 保持「知识变化」，body 分「演进/废弃」句；②label 细分「知识演进」「知识废弃」 | ①（label 封闭集少动，句首词已区分） |
| D6 | 双行 change_log 落库 | 确认保留（审计链不变式，聚合只在装配层） | 保留（无选项，机制不变） |
| D7 | defer 与查重交互 | 确认 deferred 候选参与查重（未决 = 命中），终态（applied/discarded）不挡新提 | 确认（defer 是暂缓不是结案） |
| D8 | 存量重复（E-59/E-85 各 2 条 pending） | ①人审 decideCandidate 逐条清理（零代码）；②一次性脚本合并（保最早行、追 evidence、余 discarded） | ①（量小，人审顺手裁决；②留给未来批量场景） |

---

## 8. 与既有知识节点描述的关系声明

本设计**不推翻**以下节点描述（代码现实未变，仅语义展开与呈现层设计）：

- **E-10（supersede 链）**：处置层事实不变——supersede 只翻 status 不换号、终态后不可原地改、再推翻走 replacement 新号。本设计将其呈现层含义显式化：修改 = 有后继的取代、废弃 = 无后继的取代，均走同一 supersede 通道。若实施落地，建议实施阶段在 E-10 正文补一句「报告层按 replacement 存在性区分演进/废弃叙述」（kg-update 协议，本任务不执行）。
- **E-39 / E-41**：无 DDL 变更（方案 A 下）、applySupersede 双行写入不变。若决策点 D1②/D3②选择补列，则属实施阶段 E-39 表模型的演进，需走 ensureSchemaEvolved 与 kg-update。
- **TR-46（findings 落账链路）**：findings 结构化 schema 与映射不变；本设计在其上追加**落账层查重语义**（同 targetNode+changeType 未决候选不重复落账）——若实施，TR-46 描述需补充「findings 管道机械去重」一句（kg-update 协议，本任务不执行）。
- **E-45（验证期检查）**：不涉及（验证只列不修，本设计不触碰 verify 面）。

以上声明仅供决策上下文，**不构成 kg-update 执行**；实施阶段按 R23 附着块协议随改动提交 supersede/updateNode。

---

## 9. 范围钳制（本任务）

- 只产出本设计文档，**不改任何代码/测试/skill/templates/DDL**；
- 不做实现、不做台账与迭代锚落地联动（用户已裁决搁置/不做）；
- 不动主工作树其他文件；本文档单独 commit。
