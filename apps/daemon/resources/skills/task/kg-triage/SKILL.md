---
name: kg-triage
description: 对项目待办面（候选台账 pending/deferred + 孤儿锚残量）做即时裁决——LLM 全局视角裁决 applied/discarded/deferred，高置信直接落库、拿不准升级人审；选中项目发起无交互裁决任务时
task:
  paramsSchema:
    projectRoot: { type: string, required: true }
    dryRun: { type: boolean }
  stages:
    strategy: fixed
    list:
      - { name: 待办面聚合与分派决策, kind: plan }
      - { name: 条目裁决与落库, kind: execute }
  confirm: required
  plan: enforced
  projects: { min: 1, max: 1 }
---

# kg-triage：待办面即时裁决 SOP

你在执行一个 kg-triage 任务：对**恰好一个项目**（`projectRoot`）的知识图谱**待办面**做即时裁决——把「事实判断类待办」从人审通道迁入自动裁决，人只兜底真正的例外。按固定两阶段推进——待办面聚合与分派决策 → 条目裁决与落库。阶段行已由引擎按本文件 frontmatter 冻结，不议、不增删。

与 kg-review（全库体检，O(全库)）、kg-bootstrap（一次性建库）不同：triage 是**待办面驱动**的 O(待办条目) 轻任务，允许反复发起（待办面非空即可）。L0 机械重定位（E-228）已在 sync 管道内消化了 rename 类孤儿锚——**你的裁决对象只是它消化不了的残量**。

**worktree 豁免（W-R5 同款）：本任务类型不开 worktree，主工作树执行**——裁决对象是主仓 kg 库与代码现实，隔离副本各持一套库会裁错对象。

**dry-run（params.dryRun=true）：只产裁决报告零落库**——首次启用校准、定期质量抽查用；报告逐条写「条目 → 决定 → 证据 → （若非 dry-run）将执行的 op」。

## 阶段一：待办面聚合与分派决策（plan，编排直执）

1. **两路查询合并待办面**：
   - 候选台账：`kg.candidates.list`（status=pending）+（status=deferred）——deferred 条目重复裁决合法（defer_age 递增）；
   - 孤儿锚残量：体检三检查的 findOrphans dead_anchor 清单（`/project` 页体检面板同源）——每条含 tombstone 四元组 + evidence 断链快照 + 节点 digest。
2. **分派决策**：待办 ≤20 条 → **单批直派**（一个批次实例做完）；>20 → `ceil(n/30)` 批，按「同目标节点/同文件域聚簇」切批（裁决上下文局部性优先，不是均匀切）。
3. **产出**：批次计划 + 每批 brief。批次 brief 必含：本批条目全文、**全局节点清单压缩面**（全部 active 节点 id+name+kind+digest 一行——查重与冲突判定的视野基础，各批共享编排面聚合的同一份，不各自重拉）、升级判据清单（见下）、证据纪律。

## 阶段二：条目裁决与落库（execute，批次执行）

### 裁决口径

**候选条目**（每条必落一个决定，禁止跳过）：

| 判断 | 动作 |
|---|---|
| 采纳-新增 | `createNode`（**confirmed**，不经 draft；带 scene/锚/why 段，R6 写作规范）→ `decideCandidate(applied, appliedNodeId=新节点)` |
| 采纳-修改/废弃 | `updateNode` 或 `supersede`（修改/废弃按候选 targetNode 落地）→ `decideCandidate(applied, appliedNodeId)` |
| 判断错误/无沉淀价值 | `decideCandidate(discarded, reason=反证事实)` |
| 命中升级判据 | `decideCandidate(deferred)` + 报告升级条目（理由） |

**孤儿锚残量条目**（L0 消化不了的形态1 消亡/低置信迁移/节点零附着）：

| 判断 | 动作 |
|---|---|
| 符号消亡且知识整体过时 | `supersede`（可选 replacement） |
| 知识仍有效，锚可重挂（新符号有代码证据） | `declareAnchors`（**全集替换纪律 TR-150**：补锚必带全集）→ 旧 tombstone `prune` |
| 知识有效但无需代码附着（节点有边） | `prune`（该 tombstone） |
| 拿不准 | tombstone 保留不动 + 报告升级条目 |

### 升级人审判据（命中任一 → 不自动裁决，逐条核对）

1. **证据缺失**：无法引用成立的代码事实（找不到去向、file:line 与索引不符）；
2. **冲突**：与既有节点语义矛盾（findConflicts 面）、与同批其他条目互斥；
3. **影响面大**：目标为 L0 层节点；被 ≥3 条边引用节点的 supersede；domain=business 节点（事实源在业务决策不在代码，LLM 无从验证）；
4. **索引态异常**：索引 degraded/building → 锚类条目整批搁置（建议 rebuild 后重跑）；
5. **预算**：单批自动裁决（applied 路径）上限 30 条，超出条目强制 deferred。

### 硬约束

- **证据纪律**：每条裁决（含 discarded）必须引用代码事实（file:line / 符号 / 候选自证反例）——理由走 `auto:` 前缀落 decision_reason，构成事后审计面（TR-34 可见性同源）；
- **裁决落地 = confirmed + 溯源**：applied 产出的新节点直接 confirmed；change_log 的 taskId（本任务）+ `auto:` 前缀 reason 即 autoAdjudicated 标记，不加新状态机字段；
- **禁直改 body/digest**（与 kg-review 同规）：applied 的修改落地走 updateNode/supersede 由本任务执行——这是与体检的唯一差异（体检只提候选，triage 落地候选）；
- **批次产出必带 taskId/originBatchId**：接线层机械注入，LLM 无需透传。

## 完成标准

- 待办面三计数（pending + deferred + dead_anchor）收敛为 0 或仅剩升级条目；
- 裁决报告落 summary.md 固定落点：消化率（applied+discarded+prune/输入）、逐条裁决表（条目 → 决定 → 证据）、升级清单（理由）、dry-run 时附将执行 op 清单；
- findings 无新沉淀时显式写「无」。
