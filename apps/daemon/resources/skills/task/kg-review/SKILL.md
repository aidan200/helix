---
name: kg-review
description: 对项目知识图谱做语义体检（L0 结构面预检 → L1 规则册逐节点评审 → L2 实体册逐节点评审），逐节点核对「节点内容 vs 代码现实」；产出走 candidates 台账人审，选中项目发起无交互多 agent 体检任务时
task:
  paramsSchema:
    projectRoot: { type: string, required: true }
  stages:
    strategy: fixed
    list: [L0 结构面预检, L1 规则册逐节点评审, L2 实体册逐节点评审]
  confirm: required
  plan: enforced
  projects: { min: 1, max: 1 }
---

# kg-review：知识图谱语义体检 SOP

你在执行一个 kg-review 任务：对**恰好一个项目**（`projectRoot`）的存量知识图谱做语义体检——逐节点评审「节点内容 vs 代码现实是否一致」（v1 的 L3 语义复核在 v2 的重生；轨一 findConflicts/findOrphans 管结构，你管内容）。按固定三阶段推进——L0 结构面预检 → L1 规则册逐节点评审 → L2 实体册逐节点评审。阶段行已由引擎按本文件 frontmatter 冻结，不重议、不增删。

与 kg-bootstrap 的一次性语义不同：体检面向存量图谱，知识层非空恰是评审对象，任务允许反复发起（准入 = 索引存在即可）。执行形态同样是**无人工交互的多 agent 编排**：你划批次、装配批次 brief、派批次 SubAgent、读 closure 判成败、推进或重试。全程没有中途人审门——体检结论不直接生效，全部经 candidates 台账留待人审（见③产出纪律）。

**worktree 豁免（W-R5）：本任务类型不开 worktree，主工作树执行**——评审对象是主仓 kg 库与代码现实，隔离副本各持一套库会评错对象；批次 SubAgent 不适用通用开发任务的 worktree 隔离纪律。

## 数据源（三面交叉验证）

1. **kg 全量节点**：`kg search` 关键词检索（空 q 取全量 digest 行）→ `kg get` 节点全量（正文/锚/关系/变更日志）。评审对象 = 全部 active 节点（superseded 留史节点不评审）。
2. **codegraph 工具**（W1-B 已挂，只读）：`search` 按名定位符号、`node` 读符号/文件源码、`callers`/`callees` 查调用关系、`impact` 查改动影响面——验证节点描述的代码现实（锚还在不在、符号行为对不对）。索引缺失时工具会返回提示，此时降级用 read/grep，不要尝试自建索引。
3. **kg affected 锚反查**（W1-C 已建）：从锚文件/符号反查管辖节点——交叉验证锚覆盖是否漂移（节点声称管某文件，反查却查不到它 = 锚声明腐烂的语义面）。

## 评审口径（每个节点问四问）

对每一个 active 节点，依次问：

1. **描述的代码现实还成立吗**：经 codegraph 验证锚与符号——锚指向的文件/符号还存在吗？正文描述的行为与源码现状一致吗（签名/职责/调用关系变了没有）？不一致 = 内容过期。
2. **scene 适用场景缺失或不准吗**：scene 为空（存量节点未回填）或场景叙述与实际约束范围不符？
3. **与其他节点矛盾吗**：与相关节点（同域/有边相连/叙述同一对象）的口径冲突——两节点对同一事实给出不同结论？
4. **body 结构合规吗**（R6 写作规范全产线收束——bootstrap 产线与即时沉淀产线同规）：正文是完整自然语言（非电报体压缩语汇）？markdown 结构可读（段落/标题/列表自由组织）？**「为什么存在」段在吗**（来源与存在理由——它解决什么问题/约束什么）？缺失或不成段 = 结构不合规，发现走 candidate（人审处置重写），不直改 body。

## ③ 产出纪律（硬约束，逐条不可谈判）

- **内容过期/矛盾 → 只准提 candidate**：批次 SubAgent 的评审发现经 closure findings 上报（sediment 类），机械落 candidates 台账。findings 每条结构 = `{"kind":"sediment","changeType":"修改|废弃","targetNode":"<节点 id>","project":"<项目名>","reason":"...","evidence":"代码现实出处 file:line"}`——**`reason` 是台账裁决叙事的唯一来源，人审只看它决定改不改，必须按 TR-56 三要素自包含**：①事实描述——代码现实是什么、节点当前记的是什么、差异在哪（业务语言，锚点编号只作附注不作正文主线）；②决策的点——建议怎么改，一句话说清裁决对象；③决策后的效果——applied/不裁决各自的后果与风险。缺决策点与决策后效果的机器报告格式实锤造成人审无法裁决（2026-09-02 用户反馈）。内容过期/矛盾/body 不合规 → `changeType:"修改"`（targetNode=节点 id）；节点整体失效 → `changeType:"废弃"`（targetNode=节点 id）；`iterationId` 由接线层回落无需写；`project` 填目标项目目录名（多项目 workspace 必填）。编排主 agent 汇总阶段也可用 `proposeCandidate`（kind=sediment）直提。**推翻权在人审**——体检不替人做决定。
- **scene 缺失 → 可 updateNode 直接补 scene**：scene 是元数据补全不是内容推翻（R23），体检通道允许 `kg-update` 的 `updateNode` op 直补（仅限 scene 字段；scene 已存在但「不准」的判断属于内容问题，走 candidate 不直改）。
- **禁止直改 body/digest、禁止 supersede**：任何内容改写与节点推翻都只能以 candidate 形式进人审台账。体检产出**不带 layer**（layer 是 bootstrap 分层产出的属性；体检候选带 layer 会污染 bootstrap 准入口径 O-9）。
- **批次产出必带 taskId/origin_batchId**：由接线层机械注入（批次子进程上下文默认值，LLM 无需透传；显式传参仅用于覆盖）——任务→kg 审计链不依赖 LLM 自觉。

## ① 各阶段目标与验收

### L0 结构面预检（先跑，零 LLM 评审）

- **做什么**：先跑机械检查把结构问题列出来——findConflicts（逻辑冲突三类）+ findOrphans（腐烂锚 + 无锚无边孤儿）。这些是轨一看板的同源数据，体检任务把它们作为语义评审的起点上下文（腐烂锚节点是 L1/L2 评审的优先对象），不重复机械工具的劳动。
- **产出**：阶段 artifact 写机械问题清单（人类可读：多少冲突、多少孤儿、节点 id + name 叙述）——结构性发现本身也提 candidate（人审处置），不自作主张修。
- **验收**：机械检查全跑完，清单落阶段 artifact；结构问题逐条有 candidate 或明确记入遗留清单。

### L1 规则册逐节点评审（以 L0 清单为上下文）

- **做什么**：逐条评审全部规则节点（TR- 族）——四问逐条过：代码现实成立吗（规则约束的代码/架构还是这个形态吗）？scene 缺失或不准吗？与其他规则矛盾吗？body 结构合规吗（自然语言/markdown 结构/为什么存在段）？
- **验收**：规则节点零遗漏（评审数 = active 规则节点数）；每个发现按③纪律落账；scene 缺失的规则已直补。

### L2 实体册逐节点评审（以 L0 清单为上下文）

- **做什么**：逐条评审全部实体/契约节点（E- 族）——四问逐条过，重点验证符号域锚：经 codegraph `node`/`search` 核对 `path#symbol` 锚的符号还在不在、字段/行为描述与源码一致吗；关联描述（边）与调用现实一致吗（codegraph `callers`/`callees` 交叉）；body 结构合规吗（自然语言/markdown 结构/为什么存在段）。
- **验收**：实体节点零遗漏；符号级验证证据（哪个符号、哪个文件）写进发现 body——无证据的「感觉过期」不提 candidate（台账不堆猜测）。

## ② 批次划分原则

批次是评审的执行单元（stage 内自由展开，阶段本身已冻结）：

1. **按节点域/模块切批**：以 kg search 全量 digest 行为底账，按领域/前缀/模块分组切批；组边界不清时宁可多批，不硬合并。
2. **单批工作量有界**：一个批次的节点量应在一个 SubAgent 会话内可完成（每节点要做 codegraph 验证，评审成本远高于扫读）——太大就切小。
3. **层内批次可并行**：同阶段批次间无依赖，受全局预算约束（maxConcurrent=3），排队语义既有，不自行加塞。
4. **每批 scope 人类可读**：「L1 规则册：会话管理域规则（TR-x~TR-y，n 条）」而非「batch-1」。

**重跑幂等**：体检产出以 candidates 为主（台账天然可堆积，重提同问题由人审去重）；scene 直补是幂等写（同值重写无副作用）。重跑批次先查本批已提候选，避免同批重复落账。

## 批次 brief 装配模板

每份批次 brief 必含以下固定段（LLM 可扩不可裁）：

1. **范围段**：本批评审的节点清单（id + name + digest 首行）+ 目标阶段。
2. **L0 上下文段**：结构面预检清单中与本批节点相关的条目（腐烂锚/冲突涉及本批节点的优先评审）。
3. **评审口径段**：四问逐条列出 + 数据源三面用法（kg get 取全量 → codegraph 验证 → affected 锚反查交叉）+ 证据要求（发现必带代码出处 file:line / 符号名；结构不合规发现指明缺哪段/哪条）。
4. **产出纪律段**：③四条逐字列出（只提 candidate / scene 缺失可 updateNode 直补 / 禁直改 body/digest、禁 supersede / 不带 layer；taskId/origin_batchId 接线层机械注入无需透传）。
5. **plan 硬约束段**（本任务 plan=enforced，模板层强制 LLM 不可裁）：开工先 plan_create 写计划再动手；阶段转换必更新 plan 项状态；closure 时 plan 须全部 resolve（done 或 abandoned 带理由）；台账项状态迁移按 pending→in_progress→done/abandoned，不可跳迁。
6. **前序上下文段**（重跑/接力批次必含）：前序实例 plan 摘要 + 已提候选清单——从断点继续，不重复评审已覆盖节点。

## ⑤ 完成判定

任务级 done 的判据（全部满足才收口，缺项如实呈现不粉饰）：

1. **全节点过一遍**：active 规则 + 实体节点评审零遗漏（评审计数 = 节点底账计数，阶段 artifact 里两数并列）。
2. **candidates 落账条数如实呈现**：任务级汇总各阶段提出的候选条数（零发现 = 写 0 条，不编造）。
3. **遗留清单显式写「无」**：未评审节点/未处置结构问题/验证失败的节点逐项列出；确无遗留时显式写「无」——缺失（没写）不等于无。
4. **各批 closure resolve**：每个批次实例 plan 全部 resolve（done 或 abandoned 带理由）+ closure status 成功；失败批次在重试上限内收敛。
5. **阶段产物聚合完成**：每阶段 stage.artifact 已写——阶段摘要（人类可读：本阶段评审了多少节点、发现多少问题、scene 直补多少节点、有什么已知缺口）。
