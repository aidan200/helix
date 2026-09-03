# code-review 任务类型设计（代码质量评审）

> 状态：草案（待评审）。本文全部论断均经代码探查核实，文件指针随文标注。
> 起源对话问题：kg-review 只覆盖「图谱内容 vs 代码现实」，设计合理性/逻辑问题/可简化/卫生性四类代码质量检查无承载——需要一个新任务类型。

## 1. 目标与非目标

**目标**：新增 `code-review` 任务类型——对单个项目做无人工交互的多 agent 代码质量评审，产出带 `file:line` 证据的发现报告；发现回流 chat 主会话，由人裁决后 LLM 执行修复。

**非目标（范围钳制）**：

- 不自动改代码——评审全程只读，修复是 chat 侧人在环的后续动作；
- 不进 kg candidates 台账——台账保持 kg 内容专用（applied 语义 = 图谱落账，套不上代码发现）；
- 不新增查询页/tab——结果复用 P-2 TasksPage 结果 tab + 报告文件；
- v1 不做 page 侧发起入口（chat 入口零成本先行）。

## 2. 现状事实清单（探查结论）

### 2.1 任务类型注册（零改动可承接新类型）

- 任务类型 = **builtin 层 skill** 的 frontmatter `task` 块：`apps/daemon/resources/skills/<name>/SKILL.md`，经 `TaskSkillRegistry.load()` 一次性入内存表（`adapters/driven/task-skill-registry/TaskSkillRegistry.ts`）；非法 manifest 只 warning 不入表。
- manifest 五段（`domain/task/manifest.ts` + `domain/task/types.ts`）：`paramsSchema`（仅 string/number/boolean/string[] + required，子集外一律拒绝）/ `stages`（fixed+list | free）/ `confirm`（required|skip）/ `plan`（enforced|optional）/ `projects`（min/max）。
- `TaskEngineService.createTask`（`application/services/task/TaskEngineService.ts:70`）：类型合法性 → 参数校验 → stage 行冻结插入 → `startOrchestrator`。**新类型 = 新增一个 skill 目录，引擎/注册表/编排全零改动。**

### 2.2 阶段产物（stage artifact）全链路

- 存储：`StageArtifact = { summary: string }`（`application/ports/outbound/TaskStorePort.ts:34`），stage 表 `artifact` JSON 文本列；`parseStageArtifact` 兼容读只取 summary、忽略多余 key（`rows/TaskRowMapper.ts:84`）——**存储层 additive 扩展天然安全**。
- 写面：编排者工具 `task_stage_artifact(stageSeq, summary)`（`adapters/driven/tools/task-ops/TaskOpsTools.ts:175`）→ `writeStageArtifact` → stage→done + artifact 一次落库（§4.6）。
- 读面：`task.artifacts` → `TaskQueryService.getTaskArtifacts` → 协议 `TaskArtifactsDto`（`packages/protocol/src/types/task.ts:133`，`artifact: { summary } | null`）→ `handlers/task.ts artifactsToDto` → 前端 `P-2-task-result.tsx` 纯文字渲染（阶段名 + 徽章 + summary）。
- **缺口 G1**：发现清单（N 条带 file:line 的 findings）塞不进单 summary 字符串；port/工具参数/协议 DTO/查询服务/handler/前端六处硬编码 `{ summary }`。

### 2.3 closure/findings 回流管线

- 批次收口注入（`ClosureRecorder.finalizeClosure:152`）：SteerQueue 注入**实例归属会话**——任务批次实例的归属会话是 `task:<jobId>`（编排会话），**不是用户的 chat 会话**。格式 = `agent-N closure: <status> — <summary>` + `详情: <reportPath> — 需要细节时 read`。
- findings 落账（`mapFindingsToOps:285`）：**仅 `kind="sediment"` 落 candidates 台账**；`deviation/issue/boundary` 等 kind 无落账语义（warn 跳过），只活在 closure/报告里。闭包截断时机械读旁路 `<instanceId>.findings.json` 恢复。
- 报告机制：SubAgent 按报告段库写 `HELIX_REPORT_PATH`（per-session 报告目录 `<instanceId>.md`，`SubagentLauncher.ts:248`），daemon 只透传路径。
- `closure_records` 有读面（`SessionRepositoryPort.ts:74`：按会话/实例过滤，findings 已解析为值 + reportPath）。
- **缺口 G2**：job 终态只广播 `task.changed` 到 UI（`onJobTerminal`，`container.ts:617`——仅 pending_sync 提示）；**无任何机械通道通知创建任务的 chat 会话**；`JobData` 无 origin sessionId 字段；MainAgent 工具面无任何任务结果读取工具（`MainSessionProfile.ts:93` 工具清单无 task 读面）。

### 2.4 发起入口

- chat 入口 = `task_create` 工具（`adapters/driven/tools/task-create/TaskCreateTool.ts`）：薄壳不维护类型清单（type 错误走引擎 `task.type_unknown`），**新类型零改动可用**；仅 MainAgent 生效集（AD-2）。「对话即确认」。
- page 入口 = **每类型专用 WS 命令**（无通用 task.create）：`kg.review.create` 模式 = `KgReviewService`（准入复核 + createTask 同源 + createdBy="page"）+ handler + 协议结果帧 + `kg-health-pane.tsx` 按钮（含 `hasActiveJob` 运行态检测）。TasksPage 零创建入口。

### 2.5 编排与批次执行

- OrchestratorProfile 工具 = bash/read/grep + agent_spawn + plan_read + kg(只读) + task 引擎回口六件；**无 write/edit/codegraph**（编排器不产码）。kickoff 经 `skillTextOf` 带 skill 全文；`plan=enforced` 时派发面机械追加 plan 硬约束段（`PLAN_HARD_CONSTRAINT_SEGMENT`）；批次成败机械判定（TR-31：closure + 台账全 resolve）。
- 批次 profile 分流 `dispatchProfileKindOf`（`TaskOrchestratorService.ts:62`）：`KG_PRODUCING_TASK_TYPES = {kg-bootstrap, kg-review}` → kg-writer；其余缺省 subagent-worker。专用 profile 的既有扩展点 = SubAgentKgWriterProfile 派生模式（`profiles/SubAgentKgWriterProfile.ts`：工具集增量 + prompt 后缀 + `buildSessionStack.subagentAssemblyFor` 按 kind 派发快照 + resource/EventStream 注册 kind）——code-review 立专用 profile 照此模板（见 D5）。
- worktree 隔离是**纯提示词纪律**（MainSessionProfile/SubAgentProfile 工程纪律段），无机械强制；只读评审无写冲突，不需要 worktree。
- **缺口 G3**：page 入口需按 kg.review.create 模式复制一族命令（v1 可缓）。**缺口 G4**：orchestrator 无 write 工具，任务级汇总报告无处写（D6 解决）。

## 3. 设计决策

### D1：新任务类型 `code-review`（skill 声明，引擎零改动）

新增 `apps/daemon/resources/skills/code-review/SKILL.md`：

```yaml
---
name: code-review
description: 对项目代码做质量评审（设计合理性/逻辑问题/可简化点/卫生性），按模块分批逐文件核对并产出带 file:line 证据的发现报告；发现经任务报告与 closure 回流、由人裁决修复，选中项目发起无交互多 agent 评审任务时
task:
  paramsSchema:
    projectRoot: { type: string, required: true }
    scope: { type: string }        # 可选聚焦范围（目录/模块/主题），缺省全项目
  stages:
    strategy: fixed
    list: [评审范围盘点与分批, 分批评审, 汇总报告]
  confirm: required
  plan: enforced
  projects: { min: 1, max: 1 }
---
```

SOP 骨架（对照 kg-review 结构，内容全部面向代码）：

- **执行形态**：同 kg-review——编排器划批次、派 SubAgent、机械判定收口；**不开 worktree、主树执行**（只读评审零写冲突）。
- **只读纪律**：批次走专用 `subagent-code-reviewer` profile（D5）——write/edit 机械摘除，代码写面关闭；报告与 findings 旁路文件经 bash 写 `HELIX_REPORT_PATH` / `HELIX_FINDINGS_PATH`（bash 保留用于 linter/测试等评审辅助）；发现问题不随手修（修复权在 chat 侧人审之后）。
- **评审口径（每模块四问）**：①设计合理性——架构分层/依赖方向/职责边界是否成立（对照 kg TR 族规则节点 + codegraph 调用现实）；②逻辑问题——错误处理/边界条件/并发与状态机漏洞/契约破坏；③可简化——重复代码/冗余抽象/死代码/过度设计；④卫生性——命名误导/注释与代码不符/超大函数/调试残留。
- **证据纪律（硬约束）**：每条发现必带 `file:line` + 符号名 + 严重度（**阻断/高/中/低**四级——阻断 = 正确性/数据安全直接受损必须立即修；高 = 明确缺陷或严重设计偏差；中 = 可维护性显著受损；低 = 卫生类建议）+ 一句话建议；**无证据的「感觉不好」不写入报告**（同 kg-review「台账不堆猜测」哲学）。
- **产出纪律**：findings 用 `kind="issue"` 携带（无落账语义，不进 kg 台账）；**唯一例外**——可泛化为知识规则的发现（如「本项目禁止 X 模式」）按 sediment 申报走既有台账人审。阶段产物 `task_stage_artifact`：summary 写统计（审了多少模块/发现多少/阻断高中低分布/已知缺口），body 写发现清单（见 D2）。
- **汇总阶段**：**orchestrator 自己写任务级总报告**（D6 赋予 write 能力后不再绕道「汇总批次」）——从各批次收口通知行收集 reportPath，read 全部批次报告与 findings.json，聚合写 `<任务报告目录>/summary.md`（任务级固定落点，kickoff 起跑信息携带目录路径，见 D6）。
- **完成判定**：模块零遗漏（评审计数 = 盘点底账）、发现条数如实（零发现写 0）、遗留清单显式写「无」、批次 plan 全 resolve。

### D2：stage artifact additive 扩展 `body` 字段（填 G1）

`StageArtifact` 扩为 `{ summary: string; body?: string }`——summary 仍是列表面一句话，body 承载 markdown 发现清单。additive 全链（存储层 mapper 兼容读已容忍多 key，只需让它读 body）：

| 层 | 文件 | 改动 |
|---|---|---|
| port | `application/ports/outbound/TaskStorePort.ts` | `StageArtifact` +`body?: string` |
| 存储 | `rows/TaskRowMapper.ts` | `parseStageArtifact` 读 body（缺省 undefined） |
| 工具 | `tools/task-ops/TaskOpsTools.ts` | `stageArtifactParameters` +body 可选；透传 |
| 引擎 | `TaskEngineService.writeStageArtifact` | 签名已是 StageArtifact 透传，预期零改 |
| 协议 | `packages/protocol/src/types/task.ts` | `TaskStageDto.artifact` / `TaskArtifactsDto.artifact` +`body?: string` |
| 查询 | `TaskQueryService.ts` | DTO + 组装透传 body |
| handler | `handlers/task.ts` | `artifactsToDto` / 详情 DTO 透传 |
| 前端 | `P-2-task-result.tsx` | body 存在时渲染（保留纯文字风格，按段留白）；i18n 键 |
| mock | `shared/api/tasks-mock.ts` | 兼容 |

不引入结构化 findings DTO——人类面保持「服务端组装文字」（AD-4），机器面（chat LLM）读报告文件/findings.json，双面各取所需不互相锁 schema。

### D3：chat 回流 = 通用报告查询面工具（填 G2；全任务类型受益）

不建机械注入通道，改为给 MainAgent 一个**任务报告查询工具**——任何任务类型（kg-bootstrap/kg-review/code-review/未来类型）的报告都能经对话被 chat agent 感知：用户问「评审结果怎么样」→ agent 查询 → 摘要 → 按需读全文 → 列给用户裁决修哪些 → 修复（直接改或派 SubAgent）。全程人在环，机器不自动修。

**新 MainAgent 只读工具 `task_report`**（多 op 单工具，kg/codegraph 同风格）：

- `list`：最近任务清单（jobId/type/title/status/终态时间/有无报告），可按 type/status 过滤——agent 的发现面；
- `get { jobId }`：stage artifacts（含 D2 的 body）+ 批次 closure 摘要行 + findings（issue 类）统计 + **报告路径清单**（汇总报告 + 各批次报告）；
- 报告全文不进工具回执——回路径，MainAgent 用既有 read 工具按需读（「summary 足够决策要不要深入」的 closure 哲学同构，token 经济）。

读面全部现成：`TaskQueryService`（list/detail/artifacts）+ `queryClosureRecords(task:<jobId>)`（closure_records 读面，`taskSessionIdOf` 可推导会话 id）。注册三处：`MainSessionProfile.tools` 声明 + CoreToolExecutor 条件注册 + buildSessionStack injected 过滤（taskCreate 同构）。

**被取代的原方案（备查）**：job 表加 `origin_session_id` 列 + 终态机械注入创建会话。查询面方案省掉 schema 演进且覆盖面更广（page 创建的任务同样可查）；代价是失去「任务完成主动推送到 chat」——后续若需要主动通知再单独立项（task.changed UI 广播已给人可见性）。

### D4：发起入口分期

- **v1**：仅 chat 入口（`task_create type="code-review"`，零改动）。「帮我评审一下 X 项目」对话即发起。
- **v1.5（已实施，2026-09-02）**：page 入口住 **P-1 项目页体检区**（kg-health-pane 轨二发起入口同区）——双类型入口并排：**知识图谱体检（kg-review）** 与 **代码评审（code-review）**，类型徽章区分。已落地：`code.review.create` 命令族（protocol 命令/事件目录 +1+1，错误码 `task.task_running` 入词表）+ `CodeReviewService`（KgReviewService 同构窄服务；**实施时裁决：无准入门槛**——评审对象是代码不是图谱，不要求 .helix-kg 索引存在，仅 `hasActiveJob("code-review")` 并发禁入）+ kg.projects 行 `codeReviewRunning` 标记（hasRunningCodeReviewJob 全链接线）+ shell 双入口 UI（KgViewer 单飞/回执消费 + KgHealthPane 并排区块 + 中英文案）。

### D5：专用 SubAgent profile `subagent-code-reviewer`（机械解耦，非 SOP 软约束）

与 kg 任务有 kg-writer 同构——code-review 批次不套用通用 worker，立专用 profile kind。既有扩展点全部现成（SubAgentKgWriterProfile 是模板）：

| 触点 | 文件 | 改动 |
|---|---|---|
| profile 声明 | 新增 `profiles/SubAgentCodeReviewerProfile.ts` | 由 SubAgentProfile 派生：tools **摘 write/edit**（评审批次的代码写面机械关闭），保留 bash/read/grep/codegraph/kg(只读)/plan 三件套；prompt = 通用版 + 评审纪律后缀（只读评审/证据纪律/findings kind=issue/报告经 bash 写 HELIX_REPORT_PATH） |
| 分流 | `TaskOrchestratorService.dispatchProfileKindOf` | `KG_PRODUCING_TASK_TYPES` 集合判断改为类型→kind 映射，code-review → subagent-code-reviewer |
| 快照装配 | `buildSessionStack.subagentAssemblyFor` | 按新 kind 派发生效集（worker 生效集 − write/edit + prompt 后缀；`computeKgWriterAssembly` 同构一个 compute 函数） |
| 资源/UI | `EventStream.ts` profileKind 联合类型、`handlers/resource.ts`（BASE_PROMPT_KINDS + system 块 + 模型槽位） | 注册第五 kind（kg-writer 第四 kind 先例；reviewer 独立模型槽位——评审模型可与执行模型不同配，这正是专用 profile 的附带收益） |

**诚实边界**：保留 bash 意味着写代码的逃生舱仍在（bash 可跑 sed/tee）——摘 write/edit 关掉的是「顺手的直接改码路径」并给出独立身份/提示词/模型槽位，不是形式化只读证明。彻底只读需摘 bash，但那样报告/findings 文件无处写、linter 跑不了， crippling 评审能力，不取。

### D6：orchestrator 增加 write 能力（汇总报告自己写，逻辑顺直）

原状 `OrchestratorProfile` 不持写面（「编排器不产码」注释 + profile 契约测试机械断言），导致任务级汇总报告无处写（缺口 G4）要绕道「汇总批次」。改为：

- `OrchestratorProfile.tools` **+`write`**（不加 edit——编排器写产物不改码）；profile 注释与契约测试同步改写（「编排器不产码」收窄为「不改项目代码」，write 用途 = 任务产物落盘）；
- **任务级汇总报告固定落点** = `<home>/reports/task:<jobId>/summary.md`（与批次报告同目录，`reportDirFor` 同源同式）；kickoff 起跑信息携带该目录路径——`TaskOrchestratorService` 装配面拼入（`paths.home + /reports/ + taskSessionIdOf(jobId)`，orchestrator 不需自己猜）；
- 纪律（profile prompt 一句）：write 仅用于任务报告目录内的产物文件，项目代码零写。

### D7：不做的几件事（显式排除）

- 不动 candidates 台账与 kind 词表；
- 不做 job 终态 → chat 会话的机械注入（D3 查询面取代；主动推送若需要后续单独立项）；
- 不做跨任务发现累积/去重存储（报告文件即档案——deleteTask 不清 closure_records 与报告目录，审计链自然保留）；
- 不改 kg-review 任何口径。

## 4. 改动清单汇总

| # | 改动 | 性质 |
|---|---|---|
| 1 | `apps/daemon/resources/skills/code-review/SKILL.md` | 新增，零代码 |
| 2 | StageArtifact `body` additive 九处（D2 表） | 跨栈 additive |
| 3 | MainAgent `task_report` 通用报告查询工具（D3：list/get 两 op，全任务类型通用） | 新工具三处注册 |
| 4 | `subagent-code-reviewer` 专用 profile（D5 表：声明/分流/快照装配/资源注册四处） | 新 profile kind |
| 5 | orchestrator +write + 汇总报告固定落点 + kickoff 携带报告目录（D6） | profile + 编排服务 |
| 6 | 契约文档同步（PROTOCOL.md / task-api 契约口径） | 文档 |

## 5. 报告与落盘链路（已核实，零新增需求）

任务类型区分与报告详细度现有机制已足够，code-review 直接继承：

| 层 | 机制 | 位置 |
|---|---|---|
| 类型区分 | job.type 列（= skill 名） | 任务四表 |
| 批次收口记录 | closure_records：session_id=task:<jobId> + agent_id + result/status/summary + report_path + findings(JSON 全文) + task_id；读面 `queryClosureRecords(sessionId, agentId?)` | helix.db |
| 批次报告全文 | `<home>/reports/task:<jobId>/<instanceId>.md`（+ `<instanceId>.findings.json` 旁路）——按任务目录物理隔离 | ~/.helix |
| 阶段产物 | stage.artifact（D2 扩展后含 body 发现清单） | 任务四表 |
| 档案保留 | deleteTask 只清任务四表 + plan 台账，**不清 closure_records 与报告目录**——评审档案跨任务删除保留 | — |

唯一新增 = 任务级汇总报告固定落点 `<home>/reports/task:<jobId>/summary.md`（D6：orchestrator 持 write 自己写，与批次报告同目录）。

## 6. 测试策略（TDD）

- **manifest 层**：code-review skill 装载入表 + 参数校验（scope 可选/projects 恰 1）——registry 测试现有 fake 面复用；
- **artifact body**：TaskRowMapper 兼容读（旧行无 body 不炸）→ 引擎落库 → task.artifacts 帧 → 前端渲染，逐层红绿；
- **orchestrator write**：profile 契约测试改写（工具集含 write、仍无 edit/kg-update）；kickoff 起跑信息含报告目录路径；纪律句存在性断言；
- **task_report**：list（过滤/空态）/get（artifacts 含 body + closure 摘要 + 报告路径清单；jobId 非法走统一错误面）；
- **E2E 冒烟**：小范围 scope 跑一次真实评审，验证报告落盘（批次 + 汇总 summary.md）+ 结果 tab + chat 经 task_report 感知全链。
- 注意 TR-62：SubAgent 进程内跑 daemon 测试须 `env -u` 洗涮 HELIX_* 变量。

## 7. 未决问题

无（严重度四级 = 阻断/高/中/低已裁决；v1.5 入口 = P-1 体检区双类型入口已裁决）。
