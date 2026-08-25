# TEMPLATE-USAGE —— 段库目录 + 硬约束声明（AD-18）

> 模板体系 = **段库 + LLM 装配 + 三条硬约束**（architecture.md §7）。本文档是
> 段库的人类面目录与硬约束声明，**不是装配规则表**——装配由 LLM 按任务实况
> 选段（派发时 MainAgent 组 brief，收口时 SubAgent 同策略组 report）；任务形态
> 是开放集合，僵死模板致错配（F-23 教训：agent 为填段执行段外动作）。
> 机械事实源：段目录 = `catalog.ts`（提示词携带与存在性测试同源）；硬约束
> 校验 = `validate.ts`（纯函数，判据见下）。

## 段库目录

| 场景 | 段文件 | 段名 | 用途 |
|---|---|---|---|
| brief | brief/task-goal.md | 任务目标 | 声明任务要交付什么——可验收的目标句式（硬约束①三要素之一，不可省） |
| brief | brief/background.md | 背景 | 任务上下文与现状事实（为什么做/已知约束）；无实义内容时整段省略 |
| brief | brief/kg-constraint-slice.md | kg 约束切片 | 图谱约束注入区：digest+指针切片 + supersede 协议行（T3.3 附着渲染同格式） |
| brief | brief/scope-clamp.md | 范围钳制 | 明确不做什么的边界清单，防段外动作（F-23 教训；硬约束①三要素之二，不可省） |
| brief | brief/test-requirements.md | 测试要求 | TDD 先写失败测试：测试点清单/层级/运行方式/红绿判定 |
| brief | brief/completion-criteria.md | 完成标准 | 验收条件+交付物+闭环要求——完成判定要素的载体段（硬约束①三要素之三，不可省） |
| report | report/summary.md | summary | 一句话结论+关键证据（硬约束②必含；summary 足够决策要不要深入） |
| report | report/deviation.md | deviation | 与设计/架构的偏差及理由；无偏差时整段省略（显式「无」可选） |
| report | report/findings.md | findings | 新知识候选+supersede 声明+理由——kg 落账输入；无发现必须显式写「无」（硬约束②必含） |
| report | report/tests.md | tests 执行记录 | 真实执行的测试命令与结果（红→绿证据链） |
| kg-change-report | kg-change-report/stale-anchor.md | 失效锚点 | 机械确定性检出的锚失效条目（符号消亡→物化锚孤儿），陈述句 |
| kg-change-report | kg-change-report/rule-conflict.md | 规则冲突 | 机械确定性检出的逻辑冲突条目（如双向 governs 矛盾），陈述句 |
| kg-change-report | kg-change-report/suspect-stale.md | 疑似过时 | 活跃度错位启发排序条目——必须标「疑似」非结论（启发式不可下结论） |
| kg-change-report | kg-change-report/knowledge-change.md | 知识变化 | 本迭代「代码改动→知识变化」因果叙述段（事件导向/因果链完整/带行动项） |

## 三条硬约束（LLM 不可裁）

分界：LLM 判断「这个任务需要哪些段」，不判断「闭环协议要不要守」——机制层
（submit_result 唯一闭环信号/findings 必填）不在模板可裁剪范围；硬约束段是
plan_mark_done 闭环检查的机械判据。质量不在此判（归验证期人审，AD-6）。

1. brief 必含「任务目标+范围钳制+完成判定」三要素（完成判定由「完成标准」段承载），缺一任务不成立
2. report 必含 summary+findings；findings 无发现时必须显式写「无」，不得缺失、留空或用「（无内容）」类占位
3. 空段省略不占位——无实义内容的段整段省略，不得输出「（无内容）/待补充」类占位行

**机械判据**（`validate.ts`，可测等价定义已在测试固化）：

- 段存在性 = ATX 标题行（`## 段名`）+ 标题下有非空内容；三要素标题判据按
  源文档实际用词收窄枚举（「范围钳制/范围锥制」拼写变体同判；完成判定由
  「完成标准/完成判定/验收」任一标题承载）；
- findings 显式「无」= 段存在且正文非空非占位（「无」「无发现」「「无」」
  均合法）；段缺失 / 正文空白 / 「（无内容）」类占位 = violation；
- 空段 = 二级及以下标题的正文区全空白或仅占位行（一级标题为文档题名不作
  段判；嵌套子段有内容不算父段空）。

## 装配示例（参考格式，非强制）

以下示例展示一次「brief 装配」的选段结果：六段中选了四段（背景与测试要求按
实况补入，此处省略空段——若某段无实义内容，正确做法是整段不出现）：

```md
## 任务目标

交付附着预算裁剪纯逻辑：符号域优先于路径域保留，全局域永不占预算。

## kg 约束切片

📎 本次任务命中以下知识节点（digest+指针，详情经 kg get 获取）：
- **附着匹配三段分工** [rule] — 动作层按 oldText 精确匹配，span 兜底保守不猜
  ↳ kg get TR-AD-8

若本次改动推翻此节点，随改动提交 supersede（kg-update）

## 范围钳制

- 不做：预算参数 UI 化（归 skills 页下迭代）；
- 不深入：TokenEstimator 改造（他人领地，留接口）。

## 完成标准

- 验收：超预算场景符号域节点保留、路径域被裁剪、全局域零出现；
- 交付物：domain/kg/attachment/budget.ts；
- 闭环：报告含 summary+findings（无发现显式写「无」）。
```

report / kg-change-report 场景同理按实况选段；各段的条目句式见段文件本身。
