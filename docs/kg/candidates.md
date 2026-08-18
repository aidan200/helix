# 候选台账（candidates）

## pending

## deferred

## applied

### TR-AD-2
- changeType: 修改
- targetNode: TR-AD-2
- scope: domain
- project: helix
- reason: L3 语义复核判不一致：TR-AD-2 规则文本漂移——①outbound 端口枚举不全（文本列 3 个，实际 6 个：AgentEnginePort/SessionRepositoryPort/ToolExecutorPort/EventPublisherPort/SystemPort/ClockPort）；②「由 driven adapter 实现」不普遍成立（EventPublisherPort 实现方在 driving 侧：EventStream.ts:24 / CliAdapter.ts:13；ClockPort 由组合根 container.ts:130 内联实现）；③PathsPort 定义后悬空（全仓零实现零消费，与架构审计 Minor 发现同源）。port 零实现与 inbound/outbound 分向核心约束本身成立，仅文本滞后。修正方向：规则文本改（枚举更新 + 实现方表述改为「由 adapter 或组合根实现」，PathsPort 处置联动架构审计裁决）
- evidence: final-verification/l3-review-rules.md TR-AD-2 详评；EventStream.ts:24、CliAdapter.ts:13、container.ts:130、ports/outbound/PathsPort.ts
- implementationStatus: 完整实现
- implementedCode: apps/daemon/src/application/ports/outbound/*（6 ports）；adapters/driving/ws-server/EventStream.ts:24；adapters/driving/cli/CliAdapter.ts:13；infrastructure/container.ts:130
- sourceTask: final-verification L3 语义复核·规则面（phase-reviewer agt_A3RMAK9S5SNP，2026-08-15，DONE 13 条复核 8 一致 5 不一致）
- createdIn: iter-20260815-6tss
- decisionLog: 终验决策 A-②（用户批准）：L3 语义复核判文本漂移——outbound 枚举补全 6 个、实现方表述改「driven/driving/组合根三类落位」、PathsPort 悬空注记；同步补 governs 边与代码锚（决策 E）

### TR-AD-7
- changeType: 修改
- targetNode: TR-AD-7
- scope: domain
- project: helix
- reason: L3 语义复核判不一致：TR-AD-7 单句「pi 库 import 只允许出现在 adapters/driven/pi-engine」与其自身工具条款矛盾——CoreToolExecutor/GrepTool（adapters/driven/tools/）运行时 import pi-agent-core/node 是工具封装条款（AD-10）的必然要求；守护测试 AG-04 实际口径已允许 pi-engine 与 tools 两目录，代码与守护一致、唯规则文本滞后。修正方向：规则文本改为「仅允许出现在 adapters/driven/pi-engine 与 adapters/driven/tools（工具接线域）」，与 TR-TEST-2 ① 同根因一次修正
- evidence: final-verification/l3-review-rules.md TR-AD-7 详评；CoreToolExecutor.ts:6,8,14 / GrepTool.ts:6-7；arch-guard.test.ts AG-04 describe 两目录口径
- implementationStatus: 完整实现
- implementedCode: adapters/driven/tools/CoreToolExecutor.ts:6-14；adapters/driven/tools/GrepTool.ts:6-7；test/arch-guard/arch-guard.test.ts AG-04
- sourceTask: final-verification L3 语义复核·规则面（phase-reviewer agt_A3RMAK9S5SNP，2026-08-15，DONE）
- createdIn: iter-20260815-6tss
- decisionLog: 终验决策 A-②（用户批准）：pi import 边界改为「pi-engine 与 driven/tools 工具接线域」两目录口径（与守护 AG-04 一致，消除与 AD-10 工具条款的自相矛盾）；联动 TR-TEST-2 同批修正

### TR-TEST-1
- changeType: 修改
- targetNode: TR-TEST-1
- scope: domain
- project: helix
- reason: L3 语义复核判不一致：TR-TEST-1 三处文本漂移——①「测试统一用 Bun test 运行器」过宽（daemon=bun test，shell=vitest，fidelity/e2e=Playwright 三轨实状）；②unit 层定义「domain 纯单测」滞后（test/unit 实含 infrastructure/adapter 模块单测 7 文件）；③fidelity 保真面「保留真 runtime/WS/持久化链路」与 F 层实现错位（F 层=浏览器侧 fake WebSocket 注入无 daemon；该描述现状更贴近 E 层=真 daemon+FakeLLM+真 WS+真持久化）。四层机制与 e2e 六步口径本身成立。修正方向：规则文本改（三处口径各一句）；F/E 层正式重定义与 SPEC-iter-20260815-6tss-1/2 终验裁决联动
- evidence: final-verification/l3-review-rules.md TR-TEST-1 详评；package.json:7,12；e2e/harness/{mock-init,fixtures}.ts 头注；apps/daemon/test/unit/*
- implementationStatus: 完整实现
- implementedCode: package.json test 脚本三轨；apps/daemon/test/unit/*；e2e/harness/*（F 层）；apps/daemon/test/e2e/launcher.ts（E 层）
- sourceTask: final-verification L3 语义复核·规则面（phase-reviewer agt_A3RMAK9S5SNP，2026-08-15，DONE）
- createdIn: iter-20260815-6tss
- decisionLog: 终验决策 A-②（用户批准）：三处口径修正——运行器三轨（bun test/vitest/Playwright）、unit 层含 infrastructure/adapter 模块单测、fidelity 保真面改为 F 层 fake WebSocket 注入 + e2e=E 层真 daemon 闭环

### TR-TEST-2
- changeType: 修改
- targetNode: TR-TEST-2
- scope: domain
- project: helix
- reason: L3 语义复核判不一致：TR-TEST-2 ①「pi 库 import 仅出现在 adapters/driven/pi-engine」与守护测试 AG-04 实际口径（pi-engine 与 tools 两目录）不一致——与 TR-AD-7 同根因，建议联动一次修正。四项守护机制本身（依赖方向扫描/port 零实现/写路径唯一/TestProfile 扩展公式）全部存在且实跑 27 pass 全绿
- evidence: final-verification/l3-review-rules.md TR-TEST-2 详评；arch-guard.test.ts AG-04 标题口径
- implementationStatus: 完整实现
- implementedCode: apps/daemon/test/arch-guard/arch-guard.test.ts（AG-01/02/04/06/10/11）+ apps/shell/src/tests/ag-scans.test.ts（AG-13/14/15/16）
- sourceTask: final-verification L3 语义复核·规则面（phase-reviewer agt_A3RMAK9S5SNP，2026-08-15，DONE）
- createdIn: iter-20260815-6tss
- decisionLog: 终验决策 A-②（用户批准）：①pi import 口径与 TR-AD-7 联动改两目录；其余三项守护机制表述不变（复核确认全部在位且实跑 27 pass）

### TR-TEST-5
- changeType: 新增
- scope: domain
- project: helix
- reason: 可复用 e2e harness 基座：mock-init（addInitScript 替换 window.WebSocket 实现剧本回放注入，保留 OPEN/CONNECTING 静态常量防 readyState 门控吞帧；vite HMR 透传原生）/ protocol（帧构造类型直引 @helix/protocol，mock 与真实协议零漂移）/ scenarios（S1/S2/S3/S5/S7 剧本）/ MockController / style-utils（token 通道变量派生值断言 + transition 收敛 poll + 圆角四角展开）。TS3（真 daemon + FakeLLM E 层）与 TS4（重启恢复）及后续迭代表现验证直接同构迁移：仅将 fake WebSocket 换成真连接 + daemon 装配。候选落点建议：testing-rules 新 TR-TEST 条目（表现验证 mock 挂点与契约等价纪律）或并入 TR-TEST-3 正文扩展——由终验人审裁决（proposedId SPEC-iter-20260815-6tss-1 为临时号，正式号以人审签发为准）
- evidence: worktree commit 51b46ff（分支 dev-iter-20260815-6tss）：e2e/ 18 文件 +1663 行（harness 7 模块 + 6 个 fidelity spec + playwright.config.ts），git diff 对 apps/packages 生产源码 0 改动；TS2 29/29 用例连跑 5+ 次稳定（evidence/e2e/CL-7-fidelity-suite-green-*.txt）；mock 帧构造类型直引 packages/protocol/src，与真实协议不漂移（AG-13 两端同源结构性保证）
- implementationStatus: 完整实现
- implementedCode: e2e/harness/{mock-init,protocol,scenarios,mock-session,fixtures,style-utils,evidence}.ts（commit 51b46ff）
- sourceTask: verification/test-plan TS1+TS2 闭环（phase-tester agt_BACKRMZ8V746，2026-08-15，DONE 29/29 绿）
- createdIn: iter-20260815-6tss
- decisionLog: 终验决策 A-①（用户批准 2026-08-15）：SPEC-1（F 层 mock harness）与 SPEC-2 合并落库为新条目 TR-TEST-5「表现验证双层装配纪律」；正文合并两层装配纪律，代码锚双向挂 harness 与 spec

### TR-AD-13
- changeType: 新增
- scope: domain
- project: helix
- reason: 终验决策 D（用户批准 2026-08-15）：architecture-feedback T1.8 标注「可沉淀」但从未进 kg 台账的两条设计模式级知识——WriteQueue 单写通道模式（跨项目可复用，产物文件写入通道/pi-session-backend 均有明确预期消费点）。终验人审裁决落库，正式号 TR-AD-13（临时号 SPEC-iter-20260815-6tss-3）
- evidence: development/architecture-feedback.md T1.8 实现反馈沉淀候选节 + task-T1.8-report.md
- implementationStatus: 完整实现
- implementedCode: apps/daemon/src/adapters/driven/sqlite-session/WriteQueue.ts
- sourceTask: final-verification 决策 D 执行（MainAgent，2026-08-15，用户批准终验报告 §七）
- createdIn: iter-20260815-6tss
- decisionLog: 终验决策 D（用户批准）：WriteQueue 单写通道模式落库 TR-AD-13（T1.8 可沉淀知识补账）

### TR-AD-14
- changeType: 新增
- scope: domain
- project: helix
- reason: 终验决策 D（用户批准 2026-08-15）：architecture-feedback T1.8 标注「可沉淀」但从未进 kg 台账的两条设计模式级知识——RowMapper 充血↔贫血转换模板（跨项目可复用，产物文件写入通道/pi-session-backend 均有明确预期消费点）。终验人审裁决落库，正式号 TR-AD-14（临时号 SPEC-iter-20260815-6tss-4）
- evidence: development/architecture-feedback.md T1.8 实现反馈沉淀候选节 + task-T1.8-report.md
- implementationStatus: 完整实现
- implementedCode: apps/daemon/src/adapters/driven/sqlite-session/rows/RowMapper.ts
- sourceTask: final-verification 决策 D 执行（MainAgent，2026-08-15，用户批准终验报告 §七）
- createdIn: iter-20260815-6tss
- decisionLog: 终验决策 D（用户批准）：RowMapper 充血↔贫血转换模板落库 TR-AD-14（T1.8 可沉淀知识补账）

### E-AgentInstance
- changeType: 修改
- targetNode: E-AgentInstance
- scope: E-AgentInstance 规则区状态机一行
- project: helix
- reason: L3 语义复核判不一致：节点文本把 kill（动作）列为状态机独立终态 killed；实现为 InstanceState 无 killed（AgentInstance.ts:33-35），running→仅 done|failed（:60-62），kill 收口=failed 单一终态（SchedulerService.ts:286-293 closure.status="failed"）。修正方向：文本改为「done/failed（kill 收口=failed 单一终态）」——改文本级，零改码/零改锚
- evidence: domain.md:196 文本 vs AgentInstance.ts:60-62/SchedulerService.ts:286-293/DomainEvent.ts:114-115 实现
- implementationStatus: 完整实现
- implementedCode: apps/daemon/src/domain/agent/AgentInstance.ts:33-35,57-63; apps/daemon/src/application/services/SchedulerService.ts:286-293
- sourceTask: final-verification L3 语义复核·实体面（phase-reviewer agt_0H70KD8HXWB9，2026-08-16，DONE 8 节点 5 一致 3 不一致）
- createdIn: iter-20260816-uzvg
- decisionLog: 终验决策 A（用户批准终验报告 §七，2026-08-16）：L3 语义复核判文本漂移——节点文本把 kill（动作）列为独立终态 killed；实现 kill 收口=failed 单一终态（AgentInstance.ts:60-62 / SchedulerService.ts:286-293）。修正：状态机行改「done/failed（kill 收口 = failed 单一终态，无独立 killed 态）」。改文本级，零改码零改锚。

### E-会话聚合
- changeType: 修改
- targetNode: E-会话聚合
- scope: E-会话聚合 描述区「M2 起…SubAgent Entry 亦入聚合」子句
- project: helix
- reason: L3 语义复核判不一致：「SubAgent Entry 亦入聚合」宣称 SubAgent 条目进聚合 Entry 树；实现中 SubAgent 内容只进 domain_events 挂 instanceId 事件行（SchedulerService.onInstanceEvent 转 tool.call.*/usage.recorded，抽屉读面=per-instance 事件流），聚合 Entry 树仅主实例（Session.ts:119 硬编码 MAIN_INSTANCE_ID）——与 AD-8 决策原文一致、与节点文本不符。修正方向：改为「SubAgent 内容以挂 instanceId 的领域事件入会话级存储（domain_events，trace 四维可查，抽屉消费）；聚合 Entry 树当前仅主实例（closure 注入以 isSteer entry、main 归属落树）」——改文本级
- evidence: domain.md:91 vs Session.ts:119 / RowMapper.ts:75 / SchedulerService.onInstanceEvent / decision-register.md AD-8
- implementationStatus: 完整实现
- implementedCode: apps/daemon/src/domain/session/Session.ts:119; apps/daemon/src/application/services/SchedulerService.ts onInstanceEvent; apps/daemon/src/adapters/driven/sqlite-session/rows/RowMapper.ts:75
- sourceTask: final-verification L3 语义复核·实体面（phase-reviewer agt_0H70KD8HXWB9，2026-08-16，DONE 8 节点 5 一致 3 不一致）
- createdIn: iter-20260816-uzvg
- decisionLog: 终验决策 A（用户批准终验报告 §七，2026-08-16）：L3 语义复核判文本漂移——「SubAgent Entry 亦入聚合」与实现及 AD-8 决策原文不符（SubAgent 内容走 domain_events 挂 instanceId 事件行，聚合 Entry 树仅主实例 Session.ts:119）。修正：载体表述改事件行口径 + 声明 v0.1 边界（SubAgent Entry 进聚合与恢复重放为 M3+ 子项，与 TR-AD-15 边界声明联动）。改文本级。

### E-ClosureRecord
- changeType: 修改
- targetNode: E-ClosureRecord
- scope: E-ClosureRecord 规则区 O-5 一句
- project: helix
- reason: L3 语义复核判不一致：节点规则行「reportPath 产物形态待开发裁决（O-5）」已过期——O-5 已在 T2.3 裁决双产物并实现（closure_records 记录行 + <home>/reports/<session>/<agentId>.md，container.ts:196 生产装配 reportsDir，green-t23 证据通过）。修正方向：改为「O-5 已裁决双产物：closure_records 行 + reports/<session>/<agentId>.md（reportsDir 未配置时不产文件，reportPath=null）」——改文本级
- evidence: domain.md:215 vs SchedulerService.ts 收口链①/container.ts:196/evidence/green-t23-closure-orchestration.md:28
- implementationStatus: 完整实现
- implementedCode: apps/daemon/src/application/services/SchedulerService.ts onInstanceClosure ①双产物; apps/daemon/src/infrastructure/container.ts:196
- sourceTask: final-verification L3 语义复核·实体面（phase-reviewer agt_0H70KD8HXWB9，2026-08-16，DONE 8 节点 5 一致 3 不一致）
- createdIn: iter-20260816-uzvg
- decisionLog: 终验决策 A（用户批准终验报告 §七，2026-08-16）：L3 语义复核判文本时效过期——「reportPath 产物形态待开发裁决（O-5）」已被 T2.3 裁决双产物并实现（closure_records 行 + reports/<session>/<agentId>.md，container.ts:196，green-t23 证据）。修正：改「已裁决（O-5 双产物）」+ reportsDir 未配置兜底语义。改文本级。

### TR-AD-1
- changeType: 修改
- targetNode: TR-AD-1
- scope: helix/docs/kg/architecture-rules.md TR-AD-1；写 daemon 代码、加 adapter 时的落位指引面
- project: helix
- reason: L3 语义复核判不一致（文本滞后，非实现违规）：①driven 清单漏 subagent（本迭代新增 driven adapter：SubagentLauncher+child 子进程+transport）；②services 清单漏 SchedulerService（另有 InstanceRunner.ts 内部接缝接口，规则未禁止）；③ports 列举未反映 inbound/outbound 双子目录现状（inbound 4 + outbound 6 文件）。核心断言（四层目录/单向依赖/domain framework-free/infrastructure 唯一全层装配点）由 AG-02 守护 pass 未失真。修正方向：driven 清单补 subagent；services 清单补 SchedulerService；ports 描述与 TR-AD-2 修正后双向清单对齐
- evidence: apps/daemon/src/adapters/driven/subagent/（目录树）；apps/daemon/src/application/services/ 实际 5 文件（含 SchedulerService.ts、InstanceRunner.ts）；apps/daemon/src/application/ports/{inbound,outbound}/（4+6 文件）
- implementationStatus: 部分实现
- implementedCode: helix/docs/kg/architecture-rules.md#TR-AD-1（规则段各层组件列举句）
- sourceTask: final-verification L3 语义复核·既有规则面（phase-reviewer agt_5WW40CXSS8SD，2026-08-16，DONE 9 节点 6 一致 3 不一致）
- createdIn: iter-20260816-uzvg
- decisionLog: 终验决策 A（用户批准终验报告 §七，2026-08-16）：L3 语义复核判组件清单滞后——driven 补 subagent（SubAgent 子进程 launcher/child/transport）、services 补 SchedulerService、ports 改 inbound/outbound 双向组织（对齐 TR-AD-2 修正后清单）。核心断言（四层/单向依赖/framework-free/组合根唯一全层装配点）由 AG-02 守护未失真。改文本级。

### TR-AD-15
- changeType: 修改
- targetNode: TR-AD-15
- scope: docs/kg/architecture-rules.md TR-AD-15 三层模型段与 UI 时间线段
- project: helix
- reason: 规则声称「聚合是全历史 Entry 树、跨实例持续追加」「重启后按 Entry 的 instanceId 归属恢复各实例全流」，现状 SubAgent Entry 不进聚合（数据只到 domain_events 领域事件层）、重启仅恢复实例骨架/closure/账目，前端 channelsFromSnapshot 已备 entriesByInstance 归流面但 daemon 侧无数据供给，且规则文本未声明该边界。修正方向：文本声明边界（行为面子项未兑现归后续迭代，与 OI-2 pendingSteer 归 M3 同款处理）；实现补齐（SubAgent Entry 进聚合+恢复重放进快照 entries）为 M3+ 优化机会不随本候选
- evidence: Session.ts:119；ChatService.ts:469-472；SchedulerService.ts:314-330；RowMapper.ts:75；restore-orchestration.test.ts:122-319；session-reducer.ts:485-510
- implementationStatus: 部分实现
- implementedCode: apps/daemon/src/domain/session/Session.ts:119（instanceId 写死 MAIN_INSTANCE_ID + 注释「SubAgent 追加路径 T2.x 接」）；SchedulerService.ts:314-330（SubAgent 工具调用只转领域事件不进聚合）
- sourceTask: final-verification L3 语义复核·新增/修订规则面（phase-reviewer agt_SJ9V8S3XEMC0，2026-08-16，DONE 12 节点 9 一致 3 不一致）
- createdIn: iter-20260816-uzvg
- decisionLog: 终验决策 A（用户批准终验报告 §七，2026-08-16）：L3 语义复核判 Important 未兑现面——「聚合跨实例持续追加」「重启恢复各实例全流」的行为面子项（SubAgent Entry 进聚合+恢复重放）未实现（Session.ts:119 写死 main）。修正：三层模型段与 UI 时间线段声明 v0.1 实现边界（SubAgent 内容走 domain_events 事件行、抽屉=per-instance 事件流；行为面补齐为 M3+ 子项与 OI-2 同批，届时撤边界）。机制面（instanceId 全链路/trace 四维/状态机一等操作）复核一致。改文本级。

### TR-AD-18
- changeType: 修改
- targetNode: TR-AD-18
- scope: docs/kg/architecture-rules.md TR-AD-18 compaction 段
- project: helix
- reason: 机制同路径成立（compactionHooks 无 kind 分支，AG-10 口径），但 SubAgentProfile 未声明 compaction 参数 → SubAgent 实例实际未装配，「同路径获得」易误读为实际获得；另 AgentProfile.ts:40 注释与实现矛盾放大误读。修正方向：TR-AD-18 措辞改为「同路径可装配（profile 声明即获得；SubAgent 当前未声明）」；同步修 AgentProfile.ts:40 注释（代码注释一行，随下迭代）
- evidence: AgentRuntime.ts:150-151（profile.compaction?.enabled 声明即装配，缺省不挂）；SubAgentProfile.ts:39-45（未声明 compaction 字段）；AgentProfile.ts:40（注释「缺省 DEFAULT_COMPACTION」与实现矛盾）
- implementationStatus: 部分实现
- implementedCode: apps/daemon/src/adapters/driven/pi-engine/runtime/AgentRuntime.ts:150-151
- sourceTask: final-verification L3 语义复核·新增/修订规则面（phase-reviewer agt_SJ9V8S3XEMC0，2026-08-16，DONE 12 节点 9 一致 3 不一致）
- createdIn: iter-20260816-uzvg
- decisionLog: 终验决策 A（用户批准终验报告 §七，2026-08-16）：L3 语义复核判 minor 措辞易误读——「主实例与 SubAgent 实例同路径获得 compaction」改为「同路径可装配（profile 声明即获得；SubAgentProfile 当前未声明，SubAgent 实例实际未装配）」（AgentRuntime.ts:150-151 + SubAgentProfile.ts:39-45）。三通道机制/协议 additive 纪律/守护面复核一致。改文本级；AgentProfile.ts:40 注释矛盾随下迭代优化项 #12。

### TR-AD-19
- changeType: 修改
- targetNode: TR-AD-19
- scope: docs/kg/architecture-rules.md TR-AD-19 恢复重建面段
- project: helix
- reason: 恢复重建面声称「Entry 树（含 thinking/compaction/各实例 Entry，按 instanceId 归属）→ 主线视图 + 抽屉全流」，其中「各实例 Entry」部分未兑现——重启后抽屉只有卡片骨架+closure 尾卡（主体恢复语义全对上）。与 TR-AD-15 候选同根因，修正方向随其联动：文本声明边界，两节点措辞同步修订
- evidence: RestoreService.ts:31-45（恢复面清单仅注册表/Entry 树（主实例）/账目/closure）；restore-orchestration.test.ts:122-319（断言面无全流）
- implementationStatus: 部分实现
- implementedCode: apps/daemon/src/application/services/RestoreService.ts:31-45（恢复面不含 SubAgent Entry 重放）
- sourceTask: final-verification L3 语义复核·新增/修订规则面（phase-reviewer agt_SJ9V8S3XEMC0，2026-08-16，DONE 12 节点 9 一致 3 不一致）
- createdIn: iter-20260816-uzvg
- decisionLog: 终验决策 A（用户批准终验报告 §七，2026-08-16）：L3 语义复核判 Important 未兑现面——恢复重建面「各实例 Entry→抽屉全流」与 TR-AD-15 同根因未兑现（RestoreService.ts:31-45 恢复面不含 SubAgent Entry 重放）。修正：恢复重建面段声明 v0.1 边界（重启后抽屉=卡片骨架+closure 尾卡，全流重放 M3+ 子项，引用 TR-AD-15 边界声明）。主体恢复语义（failed 收口/queued→cancelled/不自动续跑/三源）复核一致。改文本级。

### TR-AD-5
- changeType: 修改
- targetNode: TR-AD-5
- scope: apps/daemon WS 快照组装面 + SessionPort/SessionRegistry；docs/kg/architecture-rules.md TR-AD-5
- project: helix
- reason: TR-AD-5 修改（T5.1 热修沉淀，OI-VER-5 根因修复后的新边界）：新增 per-session 帧章纪律——system.getStatus() 是系统级/最近活跃会话投影读面，仅用于 welcome 单会话握手等自洽场景；per-session 帧（session.subscribe / draft 建会话快照）禁止用它盖章（多会话下 current ≠ 目标会话即串台）。per-session 帧章由 SessionStateView.agentState/model 随视图同源组装（SessionRegistry.buildView 从目标会话 runtime 直读）
- evidence: commit d3ed899；E 层 CL-1-e2e-switch-state-isolation 三面断言绿（R1 9.1s / R2 9.2s 双跑）；reviews/task-T5.1-review.md 通过
- implementationStatus: 完整实现
- implementedCode: WsServerAdapter.ts（sessionStamp）；SessionPort.ts（SessionStateView.agentState/model）；SessionRegistry.ts（buildView）；container.ts（getStatus 注释）
- sourceTask: task-T5.1-report.md（architecture-feedback「T5.1 热修 sediment 留档」节）
- createdIn: iter-20260816-6q6f
- decisionLog: 终验裁决（用户批准终验报告 §六 #7，2026-08-17）：T5.1 热修（OI-VER-5 critical 根因修复）沉淀 per-session 帧章纪律——新增段落 + anchors 扩 ws-server/switch-isolation + 反例补串台场景；规则本体不动。formalId=TR-AD-5。

### TR-AD-6
- changeType: 修改
- targetNode: TR-AD-6
- scope: docs/kg/architecture-rules.md TR-AD-6（config 清单句修订）
- project: helix
- reason: TR-AD-6 文本修订（G-3）：config.json 清单句——T2.3 瘦身后 provider API keys 迁 ~/.helix/auth.json、默认模型迁 SQLite default_model 表、ModelCatalog 缓存落盘（models-store.json）；TR-AD-6 正文中 config.json 内容清单句需同步修订（models 数据面迁出，config.json 仅剩 daemon 配置面）；新增 auth.json/models-store 路径必须经 paths.ts 单点派生（勿复制 container.ts:196 reports 旁路先例）
- evidence: t2.3-config-migration-notes.md（迁移映射 + 幂等断言）；config-migration.test；verification TS5 契约对齐三契约盖章
- implementationStatus: 完整实现
- implementedCode: config 读面瘦身（b820874）；auth-store.ts/model-catalog.ts 路径经 paths.ts
- sourceTask: task-T4.2-brief.md §5（G-3 候选材料，T2.3 落账 id 冲突留档）
- createdIn: iter-20260816-6q6f
- decisionLog: 终验裁决（用户批准终验报告 §六 #11，2026-08-17）：G-3 文本修订——config.json 清单句按 T2.3 瘦身后实况改写（模型数据面迁出，auth.json/models-store.json/default_model 表落位），新增路径单点派生要求；anchors 扩 auth-store/model-catalog。formalId=TR-AD-6。

### E-认证凭据
- changeType: 新增
- scope: docs/kg/domain.md（业务实体新增）
- project: helix
- reason: 新业务实体候选：E-认证凭据（auth.json，正式名待人审签发）——Record<providerId, type-tagged Credential 联合>（pi 生态格式等价）；0600 权限 + pid 文件锁 + 原子写；独立生命周期（key 增删/验证态）、唯一标识、多模块消费（auth 命令族 + 连通验证 verify + set_model apiKey 跟随 + E 层 seed 面与 E-模型目录关联）
- evidence: auth-store.test（类型级等价断言 + 0600 权限）；e2e/CL-3-e2e-model-chain（auth.json 0600 断言）；E 层 prepHome seed 先例（{provider:{type:api_key,key}}）
- implementationStatus: 完整实现
- implementedCode: apps/daemon/src/adapters/driven/infrastructure/auth-store.ts（0600+pid 锁+原子写）；路径经 paths.ts 单点派生
- sourceTask: verification/kg-inspection.md（entity 覆盖率审计候选 ②，建议终验落账）
- createdIn: iter-20260816-6q6f
- decisionLog: 终验裁决（用户批准终验报告 §六 #16，2026-08-17）：verification entity 覆盖率审计候选 ② 落库——新业务实体 E-认证凭据（四节完整），TR-AD-6/TR-AD-7/AD-2 联动。formalId=E-认证凭据。

### E-模型目录
- changeType: 新增
- scope: docs/kg/domain.md（业务实体新增）
- project: helix
- reason: 新业务实体候选：E-模型目录（ModelCatalog，正式名待人审签发）——builtin 39 providers 静态表 + pi.dev overlay 合并（ETag 条件刷新/4h 缓存）+ 落盘兜底（models-store.json）+ 防降级；独立生命周期（缓存刷新）、唯一标识（ETag/缓存文件）、多模块消费（daemon ModelCatalogPort/ModelService + shell P-3/P-4 + protocol model 族）。默认模型（SQLite default_model 表）为其附属状态，关系节提及即可
- evidence: model-catalog.test（builtin 39/overlay ETag 三分支/防降级/落盘兜底）；e2e/CL-3-e2e-model-chain；无外网单测覆盖（离线保缓存/兜底 builtin）
- implementationStatus: 完整实现
- implementedCode: apps/daemon/src/adapters/driven/pi-engine/model-catalog.ts；ModelCatalogPort；shell P-3/P-4 消费
- sourceTask: verification/kg-inspection.md（entity 覆盖率审计候选 ①，建议终验落账）
- createdIn: iter-20260816-6q6f
- decisionLog: 终验裁决（用户批准终验报告 §六 #15，2026-08-17）：verification entity 覆盖率审计候选 ① 落库——新业务实体 E-模型目录（四节完整），与 E-认证凭据/TR-AD-6/TR-AD-7 联动。formalId=E-模型目录。

### TR-AD-21
- changeType: 新增
- scope: packages/protocol 事件目录 + daemon WS 发帧面 + shell dispatcher（模式规则）
- project: helix
- reason: 点对点命令结果帧模式（三度同构，建议新 TR，正式号待人审签发）：命令结果 = 点对点结果帧（*.result 事件类型 + WsServerAdapter.sendNow 直发发起连接，不经 EventStream 广播）；状态变化 = 广播（EventStream 章印路由）。新增命令族直接套用：EVENT_TYPES/EVENT_CHANNELS/守护计数同步 + shell dispatcher 先 no-op 占位后接真消费。源决策 = 契约 B §2.3 机制注记 / AD-4
- evidence: T2.2 session 族 2 帧（session.list.result/loadHistory.result）+ 微批 model/auth 族 9 帧完全同构；契约 B/C 已回填；type-surface 守护计数同步；TS5 契约对齐 PASS
- implementationStatus: 完整实现
- implementedCode: WsServerAdapter.sendNow；EVENT_TYPES/EVENT_CHANNELS/exports 计数；shell dispatcher 占位→真消费两阶段
- sourceTask: architecture-feedback.md #41（T2.3-result-frames sediment 候选）
- createdIn: iter-20260816-6q6f
- decisionLog: 终验裁决（用户批准终验报告 §六 #13，2026-08-17）：点对点命令结果帧模式三度同构（T2.2×2 + 微批×9）规则化，签发新号 TR-AD-21。formalId=TR-AD-21。

### TR-AD-22
- changeType: 新增
- scope: daemon SessionProjection + shell dispatcher/store 拓扑（模式规则）
- project: helix
- reason: 事件分发两层拓扑模式（daemon/shell 同构，建议新 TR，正式号待人审签发）：daemon 侧 SessionProjection（fan-out 显式消费者 + 共享聚合访问器 + 幂等去重集 + persistedState 组合面，经 SessionRegistry 按会话实例化）与 shell 侧 dispatcher 两层（会话 store 级 SessionState 域 + 拓扑级 directory 消费者 TopologyState 域；三向路由：活跃完整 store / 后台轻量 store / 系统帧）完全同构——按 sessionId 分实例化，新增事件族 = additive 扩展面
- evidence: SessionProjection.ts 187 行（daemon）；dispatcher.ts 两层消费者（shell）；双端零漂移三层守护（type-surface 恰等 + dispatcher 全类型消费恰等 + routeCommand 21 case 对齐）；session-projection.test / session-store.test
- implementationStatus: 完整实现
- implementedCode: application/services/SessionProjection.ts；shell src shared/protocol dispatcher（会话 store 级 + 拓扑级两层消费者）+ 三向路由 dispatchFrame
- sourceTask: architecture-feedback.md #20/#23/#31（T2.1/T2.2/T3.1 sediment 候选）
- createdIn: iter-20260816-6q6f
- decisionLog: 终验裁决（用户批准终验报告 §六 #14，2026-08-17）：事件分发两层拓扑（daemon SessionProjection ↔ shell dispatcher/store 同构，#20/#23/#31 三度沉淀合并）规则化，签发新号 TR-AD-22。formalId=TR-AD-22。

### TR-AD-18-r2
- changeType: 修改
- targetNode: TR-AD-18
- scope: docs/kg/architecture-rules.md TR-AD-18（三通道与协议 additive 演进）或新条目；错误链路实现/评审/测试剧本编写时的规则依据面
- project: helix
- reason: 热修后新增设计事实：①provider 失败的协议形态——pi-ai 将 HTTP 失败规范化为流内 error 帧（非异常），errorMessage 含 provider 原文；引擎错误经 engine.error 事件透传前端（错误卡）；②error 轮语义——不产 assistant 气泡、turn 收口、全零 usage 不入账（零成本非真实计费）；③mock 契约等价的错误面——FakeLLM/剧本须覆盖 error 帧路径（TR-TEST-3 等价原则的错误维度，E 层 errorReply 剧本为断言面）。建议并入 TR-AD-18（三通道→含错误通道）或独立条目，由下迭代终验人审裁决
- evidence: docs/hotfixes/2026-08-16-engine-error.md；packages/protocol/src/events.ts（engine.error 第 24 事件）；PiAgentEngineAdapter.ts message_end stopReason=error 分支；ChatService.ts error 轮零账不入账；e2e/CL-7-e2e-engine-error.spec.ts（FakeLLM errorReply 剧本与真实 pi-ai 失败帧同构）；现场验证：真 z.ai 429 → engine.error 帧含 provider 原文
- implementationStatus: 完整实现
- sourceTask: post-iteration 热修（MainAgent，2026-08-16，docs/hotfixes/2026-08-16-engine-error.md；用户现场报障驱动）
- createdIn: iter-20260816-uzvg
- decisionLog: 终验裁决（用户批准终验报告 §六 #1，2026-08-17）：错误通道三设计事实并入 TR-AD-18（三通道→四通道，更名 + 错误轮语义段落）。因 formalId=TR-AD-18 与台账既有 applied 条目撞号（同节点二次修改超出 kg apply 流转支持面），按 desk 先例由 MainAgent 人审直写落盘（formalId=TR-AD-18，节点 id 稳定不变）。

### AD-3
- changeType: 修改
- targetNode: AD-3
- scope: apps/daemon 全链路；apps/shell src 与 e2e/ 零触碰
- project: helix
- reason: AD-3 daemon 侧落地（与既有 AD-3 类型登记候选同目标、不同实施面，终验合并裁决）：①SchedulerService 只产事件零聚合写（守护断言入集成测试）；②SessionProjection 会话投影消费者（SubAgent Entry 落聚合 instanceId 归属 + usageLedger 并入 + write-through 迁入）；③WS 统一信封 sessionId 路由 + EVENT_CHANNELS 章印；④恢复重放含 SubAgent 历史；⑤RowMapper/DtoMapper instanceId 行级对称透传。E 层断言定稿 daemon 级证据，E 层归 T4.2。
- evidence: SessionProjection.ts（新，187 行）；SchedulerService 零聚合写守护（test/integration/session-projection.test.ts ②）；EventStream 按 sessionId 路由；RestoreService.replaySubAgentHistory；bun test apps/daemon 313 pass；MainAgent 统一回归 F 65 / E 15 全绿
- implementationStatus: 完整实现
- implementedCode: apps/daemon/src/application/services/SessionProjection.ts（新）；SchedulerService.ts onInstanceEvent；EventStream.ts/WsServerAdapter.ts；DtoMapper.ts；RestoreService.ts；Session.ts；container.ts
- sourceTask: task-T2.1-report.md
- createdIn: iter-20260816-6q6f
- decisionLog: 终验裁决（用户批准终验报告 §六 #2，2026-08-17）：事件分发统一信封路由落地定稿落 docs/kg/decisions.md 决策档案 AD-3（上下文/选项/裁决与理由/结局四节，kg A-1 模型决策非图节点）。因 kind=decision 不在 kg apply block 流转支持面 + targetNode 无既有节点块，按 desk 先例由 MainAgent 人审直写落盘（formalId=AD-3）。

### CL-iter-20260816-6q6f-1786980800604
- changeType: 新增
- scope: verification 阶段回归取证（零生产代码改动，纯证据落盘）
- project: helix
- reason: M5 热修复批次六提交（d3ed899/c487c95/5959533/23f6043/55ac055/9936d48）Round-2 独立回归验收记录：F 层 91/91 全绿零回退 + E 层 20/20×2 双跑全绿（T5.1 switch-state-isolation 修复回归成立），T5.1-T5.6 修复要点全部应答（含 T5.6 dev 控件 grep 零残留复核）。作为迭代验收留痕候选供终验人审裁决。
- evidence: evidence/e2e/verification-r2-CL-all-f-20260817T152736Z.txt「M5 六提交复核要点应答」节 + 4 张 verification-r2-CL-1-f-shot-*.png；E 层配套 evidence/e2e/verification-r2-CL-e-layer-round{1,2}-*.txt
- implementationStatus: 完整实现
- implementedCode: e2e/CL-1-activity-rail-inline.spec.ts:31（T5.5 新剧本）；e2e/CL-3-model-menu.spec.ts:144,159（T5.3 断言）；worktree HEAD 9936d48
- sourceTask: development/task-TC6.1-report.md
- createdIn: iter-20260816-6q6f
- decisionLog: 终验裁决（用户批准终验报告 §六 #3，2026-08-17）：M5 六提交 Round-2 回归验收留痕——不立 kg 节点（非规则/实体/决策形态），留痕由 ITERATIONS.md 迭代条目 + verification-report Round-2 节 + evidence/e2e/verification-r2-* 承载。台账直接流转 applied。

### TR-AD-15-revoke
- changeType: 修改
- targetNode: TR-AD-15
- scope: docs/kg/architecture-rules.md TR-AD-15（撤 v0.1 边界段）
- project: helix
- reason: TR-AD-15 撤边界（#45 草案）：删去「v0.1 实现边界（M2 终验 L3 复核登记）……届时撤本边界声明」整段；规则本体（instanceId 全链路/机制同构/三层模型）不动，被会话投影强化。条件成就：①聚合 Entry 树已含 SubAgent 条目（Entry.instanceId 归属，Session.pushEntry 参数化）②恢复重放进快照 entries（RestoreService.replaySubAgentHistory，agent_kind=subagent 事件流补齐）③前端归流既有
- evidence: e2e/CL-1-e2e-restart-restore-all.spec.ts + e2e/CL-1-e2e-subagent-stream.spec.ts + session-projection.test ③；architecture-feedback #45 草案原文
- implementationStatus: 完整实现
- implementedCode: Session.pushEntry（instanceId 参数化）；RestoreService.replaySubAgentHistory
- sourceTask: task-T4.2-report.md（architecture-feedback #45 留档）
- createdIn: iter-20260816-6q6f
- decisionLog: 终验裁决（用户批准终验报告 §六 #4，2026-08-17）：撤 v0.1 边界段（条件成就：SubAgent Entry 进聚合 + 恢复重放，E 层证据在档）。因 formalId=TR-AD-15 与台账既有 applied 条目撞号（同节点二次修改超出 kg apply 流转支持面），按 desk 先例由 MainAgent 人审直写落盘（formalId=TR-AD-15，节点 id 稳定不变）。

### TR-AD-19-revoke
- changeType: 修改
- targetNode: TR-AD-19
- scope: docs/kg/architecture-rules.md TR-AD-19（恢复重建面撤 v0.1 边界）
- project: helix
- reason: TR-AD-19 撤边界（#46 草案）：恢复重建面删去括注「v0.1 边界：SubAgent Entry 未进聚合，抽屉全流重放为 M3+ 子项……重启后抽屉 = 卡片骨架 + closure 尾卡」，改写为「Entry 树（主实例主轴 + SubAgent per-instance channel）→ 主线视图 + 抽屉全流重放（SubAgent 历史含在内）」。规则本体（failed 收口不自动续跑/cancelled 区分/重试归编排层）不动
- evidence: e2e/CL-1-e2e-restart-restore-all.spec.ts（重启后抽屉历史可见）；session-registry.test ③（删除会话 queued→cancelled/running→kill 复用终态语义）；architecture-feedback #46 草案原文
- implementationStatus: 完整实现
- implementedCode: RestoreService.replaySubAgentHistory（agent_kind=subagent 事件流补齐重放）
- sourceTask: task-T4.2-report.md（architecture-feedback #46 留档）
- createdIn: iter-20260816-6q6f
- decisionLog: 终验裁决（用户批准终验报告 §六 #5，2026-08-17）：恢复重建面撤 v0.1 边界括注（与 TR-AD-15 联动）。因 formalId=TR-AD-19 与台账既有 applied 条目撞号（同节点二次修改超出 kg apply 流转支持面），按 desk 先例由 MainAgent 人审直写落盘（formalId=TR-AD-19，节点 id 稳定不变）。

### E-会话聚合-r2
- changeType: 修改
- targetNode: E-会话聚合
- scope: docs/kg/domain.md E-会话聚合（描述联动）
- project: helix
- reason: E-会话聚合 描述联动（#47 草案，三处联动之三）：domain.md E-会话聚合节「聚合 Entry 树 v0.1 仅主实例……见 TR-AD-15 边界声明」句改写为「聚合 Entry 树含主实例主轴 + SubAgent per-instance 归属条目（Entry.instanceId；经会话投影 SessionProjection 落树）；快照尾窗切法保留 per-instance channel 完整性（AD-1 硬约束）」。与 TR-AD-15/19 撤边界同批联动
- evidence: e2e/CL-1-e2e-multi-session.spec.ts；session-registry.test ④；architecture-feedback #47 草案原文
- implementationStatus: 完整实现
- implementedCode: Session.pushEntry；SessionProjection.ts；SessionRegistry.buildView（尾窗切法）
- sourceTask: task-T4.2-report.md（architecture-feedback #47 留档）
- createdIn: iter-20260816-6q6f
- decisionLog: 终验裁决（用户批准终验报告 §六 #6，2026-08-17）：描述联动（聚合 Entry 树含 SubAgent 归属条目，三处联动之三）。因 formalId=E-会话聚合 与台账既有 applied 条目撞号（同节点二次修改超出 kg apply 流转支持面），按 desk 先例由 MainAgent 人审直写落盘（formalId=E-会话聚合，节点 id 稳定不变）。

### AD-1-finalize
- changeType: 修改
- targetNode: AD-1
- scope: AD-1（尾窗+分页决策）落地形态回写
- project: helix
- reason: AD-1 落地定稿（task-T2.2 sediment 留档）：尾窗+分页参数定稿——快照尾窗 30 条（per-instance channel 完整性硬约束）；loadHistory 游标分页 50 上限 200；草稿建会话链 draft:true 标记；清单/历史结果 = 点对点结果帧（session.list.result / session.loadHistory.result，连接私有读面不广播，契约 B 已回填）；恢复重放含 SubAgent 历史（RestoreService.replaySubAgentHistory）
- evidence: 契约 B §1.3/§1.4/§2.3 已回填（verification TS5 契约对齐 PASS 盖章）；session-registry 集成断言；e2e/CL-1-e2e-multi-session.spec.ts 分页断言
- implementationStatus: 完整实现
- implementedCode: SessionRegistry（尾窗/卸载/收口）；EventStream/WsServerAdapter（点对点结果帧）
- sourceTask: task-T2.2-report.md（propose 落账阻断留档，OI-VER-1 ①）
- createdIn: iter-20260816-6q6f
- decisionLog: 终验裁决（用户批准终验报告 §六 #8，2026-08-17）：AD-1 落地定稿落 docs/kg/decisions.md 决策档案 AD-1（上下文/选项/裁决与理由/结局四节，kg A-1 模型决策非图节点；尾窗 30/分页 50 上限 200/点对点结果帧/恢复重放）。因 kind=decision 不在 kg apply 支持面 + targetNode 无既有节点块，按 desk 先例由 MainAgent 人审直写落盘（formalId=AD-1）。

### AD-2-finalize
- changeType: 修改
- targetNode: AD-2
- scope: AD-2（模型模块决策）落地形态回写
- project: helix
- reason: AD-2 落地定稿（task-T2.3 sediment 留档）：①auth.json（Record<providerId, Credential 联合>，0600+pid 锁+原子写，路径经 paths.ts 单点派生）②默认模型 SQLite 单写③ModelCatalog 自实现（builtin 39 静态表 + pi.dev overlay ETag 三分支/防降级/落盘兜底，零 pi-coding-agent，落位 driven 而非 application——AG-04 合规）④set_model 链：AgentState.model 直改（in-flight 不变，下一 turn 生效）⑤config 瘦身迁移幂等（skipConfig 重定义：真引擎模式 = options.engine 缺省，skipConfig 只跳过 config 读面）
- evidence: auth-store.test（类型级等价断言 + 0600）；model-catalog.test（ETag 三分支/防降级）；set_model 真引擎序列断言；config-migration.test 幂等；e2e/CL-3-e2e-model-chain（auth.json 0600 + builtin fallback）
- implementationStatus: 完整实现
- implementedCode: apps/daemon/src/adapters/driven/infrastructure/auth-store.ts；pi-engine/model-catalog.ts（driven 落位）；ModelService；SQLite default_model 表
- sourceTask: task-T2.3-report.md（propose 落账阻断留档，OI-VER-1 ②）
- createdIn: iter-20260816-6q6f
- decisionLog: 终验裁决（用户批准终验报告 §六 #9，2026-08-17）：AD-2 落地定稿落 docs/kg/decisions.md 决策档案 AD-2（上下文/选项/裁决与理由/结局四节，kg A-1 模型决策非图节点；auth.json 0600/SQLite 默认/ModelCatalog driven/set_model 链/config 瘦身）。因 kind=decision 不在 kg apply 支持面 + targetNode 无既有节点块，按 desk 先例由 MainAgent 人审直写落盘（formalId=AD-2）。

### AD-4-finalize
- changeType: 修改
- targetNode: AD-4
- scope: AD-4（SessionRegistry 决策）落地形态回写
- project: helix
- reason: AD-4 落地定稿（task-T2.2 sediment 留档）：SessionRegistry 落地形态——①生命周期（懒加载/30min 空闲卸载/执行中不卸载）②组合根工厂化（1:1 与 write-through 保持）③调度器多会话共用全局预算④启动全量元数据（restoreLatest 废弃）⑤草稿建会话链 20 字符命名⑥删除六表清行按序收口（whenSettled+settleTimeoutMs 5s 超时防御上界）⑦WriteQueue 分仓（chainKeyOf(session_id) 路由，仓间互不阻塞）⑧引擎多会话并发前提注入（DaemonOptions.engine 工厂形态）
- evidence: session-registry.test 全套（生命周期/删除收口/分仓）；调度器多会话共用预算集成断言；daemon 324 单测绿；E 层 CL-1-e2e-multi-session/restart-restore-all
- implementationStatus: 完整实现
- implementedCode: SessionRegistry.ts；container.ts（组合根工厂化 + engine 工厂注入）；WriteQueue（sessionTails 分仓）；SchedulerService（全局预算）
- sourceTask: task-T2.2-report.md（propose 落账阻断留档，OI-VER-1 ①）
- createdIn: iter-20260816-6q6f
- decisionLog: 终验裁决（用户批准终验报告 §六 #10，2026-08-17）：AD-4 落地定稿落 docs/kg/decisions.md 决策档案 AD-4（上下文/选项/裁决与理由/结局四节，kg A-1 模型决策非图节点；生命周期/工厂化/全局预算/删除收口/WriteQueue 分仓/引擎工厂）。因 kind=decision 不在 kg apply 支持面 + targetNode 无既有节点块，按 desk 先例由 MainAgent 人审直写落盘（formalId=AD-4）。

### TR-AD-7-r3
- changeType: 修改
- targetNode: TR-AD-7
- scope: docs/kg/architecture-rules.md TR-AD-7（模型能力来源句 + auth.json 格式句修订）
- project: helix
- reason: TR-AD-7 文本修订（G-3）：①模型能力来源句——模型目录来源 = builtin 39 providers 静态表 + pi.dev overlay 合并（自实现 ModelCatalog，零 pi-coding-agent 依赖），正文「模型能力来源」句需同步；②auth.json 格式句——Record<providerId, type-tagged Credential 联合>（pi 生态等价，0600+pid 锁），OAuth 类型面支持、登录流不做
- evidence: model-catalog.test（builtin 39/overlay/防降级/落盘兜底）；auth-store.test（Credential 联合类型级等价断言）
- implementationStatus: 完整实现
- implementedCode: pi-engine/model-catalog.ts（自实现，零 pi-coding-agent）；infrastructure/auth-store.ts
- sourceTask: task-T4.2-brief.md §5（G-3 候选材料，T2.3 落账 id 冲突留档——discarded 已有 TR-AD-7-r2）
- createdIn: iter-20260816-6q6f
- decisionLog: 终验裁决（用户批准终验报告 §六 #12，2026-08-17）：模型能力来源句 + auth.json 格式句修订（G-3）。因 formalId=TR-AD-7 与台账既有 applied 条目撞号（同节点二次修改超出 kg apply 流转支持面），按 desk 先例由 MainAgent 人审直写落盘（formalId=TR-AD-7，节点 id 稳定不变）。

### TR-AD-2-r3
- changeType: 修改
- targetNode: TR-AD-2
- scope: docs/kg/architecture-rules.md TR-AD-2（落位枚举补 infrastructure 形态）
- project: helix
- reason: TR-AD-2 落位枚举缺口（终验全局审计 N1）：AuthStorePort 实现落 infrastructure/auth-store.ts（独立模块），不属规则文本「三类落位」（driven/driving/组合根内联）任一，属第四形态「infrastructure 纯技术文件 port」（与 dev-token/config 同类）。实现是有意裁决（AG-06③ renameSync 白名单显式列名 + 组合根装配），规约文本未覆盖——修订 TR-AD-2 补第四类落位
- evidence: docs/kg/architecture-rules.md TR-AD-2 规则段「三类落位」句 vs apps/daemon/src/infrastructure/auth-store.ts:97（export class AuthStore implements AuthStorePort）+ arch-guard.test.ts AG-06③（renameSync 白名单 isAuthStore）；审计报告 §1.4 N1
- implementationStatus: 完整实现
- implementedCode: apps/daemon/src/infrastructure/auth-store.ts:1-244（AuthStore implements AuthStorePort）
- sourceTask: final-verification/architecture-audit-20260817.md（phase-architect findings，自动落账异常手动补）
- createdIn: iter-20260816-6q6f
- decisionLog: 终验裁决（用户批准终验报告 §六 #17，2026-08-17）：落位枚举补第四类（infrastructure 纯技术文件 port）。与 TR-AD-2-r4 同节点合并修订一次落盘。因 formalId=TR-AD-2 与台账既有 applied 条目撞号（同节点二次修改超出 kg apply 流转支持面），按 desk 先例由 MainAgent 人审直写落盘（formalId=TR-AD-2，节点 id 稳定不变）。

### TR-AD-2-r4
- changeType: 修改
- targetNode: TR-AD-2
- scope: docs/kg/architecture-rules.md TR-AD-2（outbound/inbound 端口枚举计数句）
- project: helix
- reason: TR-AD-2 端口枚举计数修订（L3 复核判不一致项）：正文「outbound port 生效 5 个」滞后于 T2.3 模型迁移实况——实际生效 8 个（9 文件 − PathsPort 悬空），新增 AuthStorePort/DefaultModelPort/ModelCatalogPort 三 outbound + inbound 新增 ModelPort/SessionDirectoryPort。核心断言（双向结构/AG-01 port 零实现/PathsPort 悬空注记）全部吻合，仅枚举清单滞后。与 TR-AD-2-r3（落位第四形态）同节点不同修订面，建议 apply 时合并修订
- evidence: docs/kg/architecture-rules.md TR-AD-2 规则段「出口端口生效 5 个」vs apps/daemon/src/application/ports/outbound/（9 文件）；arch-guard.test.ts:39 断言 ports 文件数 ≥9（守护已更新、文本未跟进）；bun test arch-guard 22/22 pass
- implementationStatus: 完整实现
- implementedCode: ports/outbound/AuthStorePort.ts（实现在 infrastructure/auth-store.ts:151）；ports/outbound/DefaultModelPort.ts（sqlite-session/DefaultModelStore.ts:13）；ports/outbound/ModelCatalogPort.ts（pi-engine/model-catalog.ts:117）；inbound 新增 ModelPort/SessionDirectoryPort
- sourceTask: reviews/l3-semantic-review-batch1.md（L3 复核批次 1 findings，自动落账 id 撞号手动另立）
- createdIn: iter-20260816-6q6f
- decisionLog: 终验裁决（用户批准终验报告 §六 #18，2026-08-17）：端口枚举计数修订（outbound 5→8 + inbound 新增 ModelPort/SessionDirectoryPort），与 TR-AD-2-r3 合并落盘于同一次 TR-AD-2 块修订。同上 MainAgent 直写（formalId=TR-AD-2）。

## discarded

### SPEC-iter-20260815-6tss-2
- changeType: 新增
- scope: domain
- project: helix
- reason: E 层 e2e 可复用装配（真 daemon + FakeLLM）：bun 子进程 launcher（stdout 控制行协议 + SIGTERM 优雅停机）+ Node 侧 DaemonProcess fixture（--home tmp / 端口管理 / 重启重试）+ 剧本 JSON 契约（reply/replyFromResult/tool + 流式分片制造可打入窗口）+ globalSetup（端口预检 + VITE_HELIX_PORT 烘焙 dist）。后续迭代浏览器级 E2E 改剧本即可扩展；真实 LLM 联调形态换 streamFnOverride 实现即可。候选落点建议：与 SPEC-iter-20260815-6tss-1（F 层 harness）合并为 testing-rules 表现验证装配条目——由终验人审裁决（临时号，正式号以人审签发为准）
- evidence: commit 70154fd（分支 dev-iter-20260815-6tss，12 文件 +1369 行，生产源码零触碰）；全量 npx playwright test -c playwright.e2e.config.ts → 6 绿 + 1 预期红（32s）；F 层回归 29 绿 / bun test apps/daemon 161 绿；--home tmp 隔离，真实 ~/.helix 零触碰
- implementationStatus: 完整实现
- implementedCode: e2e/harness/daemon-script.ts（剧本契约）+ e2e/harness/daemon-fixture.ts（DaemonProcess + e2e fixture）+ apps/daemon/test/e2e/launcher.ts（bun 侧装配）+ e2e/harness/e2e-global-setup.ts + playwright.e2e.config.ts
- sourceTask: verification/test-plan TS3+TS4 闭环（phase-tester agt_W239GDV2H5TH，2026-08-15，DONE_WITH_CONCERNS 6绿+1预期红）
- createdIn: iter-20260815-6tss
- decisionLog: 终验决策 A-①（用户批准 2026-08-15）：与 SPEC-iter-20260815-6tss-1 合并落库为 TR-TEST-5「表现验证双层装配纪律」——E 层装配纪律已并入 TR-TEST-5 正文（launcher/DaemonProcess/剧本契约/globalSetup），本条 discard 保留审计痕，知识不丢失

### TR-AD-2-r2
- changeType: 修改
- targetNode: TR-AD-2
- scope: helix/docs/kg/architecture-rules.md TR-AD-2；新增 port 时落位/归类决策的规则依据面
- project: helix
- reason: L3 语义复核判不一致（Important）：文本 outbound 清单列 SystemPort，实际自 9304a9d 起位于 ports/inbound/（组合根内联实现、driving ws-server 调用）；outbound 实际生效 5 个 + PathsPort（悬空豁免）。错位系上迭代修正 3155a7e 引入。附带：inbound 描述未涵盖 AgentOrchestrationPort 亦被 driven tools（编排三工具）调用、SystemPort 由组合根实现两个 M2 新形态。修正方向：outbound 清单改 5 个生效 port（去 SystemPort，PathsPort 豁免注记保留）；SystemPort 移 inbound 侧并注明实现方为组合根/生命周期侧；inbound 调用方补「编排三工具经 AgentOrchestrationPort 回口（TR-AD-16 同口径）」
- evidence: apps/daemon/src/application/ports/inbound/SystemPort.ts:13；infrastructure/container.ts（system 组合根内联实现）；ports/inbound/README.md；git show 3155a7e diff（清单为修正时新写未核对目录）；git log --follow ports/inbound/SystemPort.ts → 9304a9d 创建即 inbound
- implementationStatus: 部分实现
- implementedCode: helix/docs/kg/architecture-rules.md#TR-AD-2（规则段 outbound 清单句与 inbound 描述句）
- sourceTask: final-verification L3 语义复核·既有规则面（phase-reviewer agt_5WW40CXSS8SD，2026-08-16，DONE 9 节点 6 一致 3 不一致）
- createdIn: iter-20260816-uzvg
- decisionLog: 终验决策 A 执行记录（用户批准 2026-08-16）：修正内容已由 project_write_tech_rules 直接落库（architecture-rules.md TR-AD-2 现行文本 = outbound 生效 5 个 + SystemPort 归 inbound + M2 两新形态调用方），正式号 TR-AD-2 与上迭代 applied 台账条目撞号无法二次 apply——本条 discard 保留审计痕，修正事实以上迭代 TR-AD-2 applied 条目 + 本 decisionLog 为准。知识不丢失。

### TR-AD-7-r2
- changeType: 修改
- targetNode: TR-AD-7
- scope: helix/docs/kg/architecture-rules.md TR-AD-7；pi 库使用红线规则文本
- project: helix
- reason: L3 语义复核判不一致（Important）：①工具集文本「四内置+grep」过时——CoreToolExecutor 现为八工具（四内置 + grep + 编排三工具 agent_spawn/agent_send/agent_status）；②pi import 域文本两域 vs AG-04 白名单本迭代已扩三域（+adapters/driven/subagent：SubagentLauncher/ChildMain/scriptedEngine import pi 符号）——守护前进、文本未同步，「同口径」断言失效。修正方向：工具集清单补编排三工具；pi import 允许域补第三域 subagent，与 AG-04 恢复同口径
- evidence: apps/daemon/src/adapters/driven/tools/CoreToolExecutor.ts（八工具注册表）；tools/agent/AgentOrchestrationTools.ts:1-16（薄转投）；arch-guard.test.ts:106-126（AG-04 三域白名单）；grep pi → 13 文件全在 pi-engine/tools/subagent 三 driven 域
- implementationStatus: 部分实现
- implementedCode: helix/docs/kg/architecture-rules.md#TR-AD-7（规则段工具集句 + pi import 域句）
- sourceTask: final-verification L3 语义复核·既有规则面（phase-reviewer agt_5WW40CXSS8SD，2026-08-16，DONE 9 节点 6 一致 3 不一致）
- createdIn: iter-20260816-uzvg
- decisionLog: 终验决策 A 执行记录（用户批准 2026-08-16）：修正内容已由 project_write_tech_rules 直接落库（architecture-rules.md TR-AD-7 现行文本 = 八工具集 + pi import 三域含 subagent + 锚补 subagent 目录），正式号 TR-AD-7 与上迭代 applied 台账条目撞号——discard 留审计痕，修正事实以上迭代 TR-AD-7 applied 条目 + 本 decisionLog 为准。知识不丢失。

### TR-TEST-2-r2
- changeType: 修改
- targetNode: TR-TEST-2
- scope: docs/kg/testing-rules.md TR-TEST-2 规则段①款
- project: helix
- reason: 守护测试 AG-04 白名单已扩为 pi-engine/tools/subagent 三目录（T2.2 新增 subagent/ 为 pi driven 域子进程形态），规则文本仍写两目录——作为落位/评审判据会误判 subagent/ 内合法 pi import 为违规，且与守护测试口径分叉。修正方向：①款更新为「仅出现在 adapters/driven/pi-engine、adapters/driven/tools 与 adapters/driven/subagent（subagent/ 为 pi driven 域的子进程形态）」，与 TR-AD-7 修正候选同批
- evidence: arch-guard.test.ts:106-117（AG-04 allowedRoots = pi-engine/tools/subagent + 注释「白名单新增第三个 driven 根」）；SubagentLauncher.ts:2、ChildMain.ts:20、scriptedEngine.ts:2-4 共 5 处 pi import
- implementationStatus: 部分实现
- implementedCode: apps/daemon/test/arch-guard/arch-guard.test.ts:106-117
- sourceTask: final-verification L3 语义复核·新增/修订规则面（phase-reviewer agt_SJ9V8S3XEMC0，2026-08-16，DONE 12 节点 9 一致 3 不一致）
- createdIn: iter-20260816-uzvg
- decisionLog: 终验决策 A 执行记录（用户批准 2026-08-16）：修正内容已由 project_write_tech_rules 直接落库（testing-rules.md TR-TEST-2 ①款 = pi import 三根口径 pi-engine/tools/subagent，与 TR-AD-7 同批），正式号 TR-TEST-2 与上迭代 applied 条目撞号——discard 留审计痕，修正事实以上迭代 applied 条目 + 本 decisionLog 为准。知识不丢失。

### TR-TEST-5-r2
- changeType: 修改
- targetNode: TR-TEST-5
- scope: docs/kg/testing-rules.md TR-TEST-5 E 层段
- project: helix
- reason: 端口预检 fail-fast 实际在 globalSetup，DaemonProcess fixture 内是端口占用重试缓冲；同段后文已正确归属，属并列归属措辞错位。修正方向：文本微调为预检归 globalSetup、fixture 为重试缓冲（minor 措辞级）
- evidence: e2e/harness/e2e-global-setup.ts:3（预检 fail-fast 在 globalSetup）；e2e/harness/daemon-fixture.ts:96-104（fixture 内为端口占用重试缓冲）
- implementationStatus: 完整实现
- implementedCode: e2e/harness/e2e-global-setup.ts:3
- sourceTask: final-verification L3 语义复核·新增/修订规则面（phase-reviewer agt_SJ9V8S3XEMC0，2026-08-16，DONE 12 节点 9 一致 3 不一致）
- createdIn: iter-20260816-uzvg
- decisionLog: 终验决策 A 执行记录（用户批准 2026-08-16）：措辞修正已由 project_write_tech_rules 直接落库（testing-rules.md TR-TEST-5 E 层段 = fixture 端口占用重试缓冲、预检 fail-fast 归 globalSetup），正式号 TR-TEST-5 与上迭代 applied 条目撞号——discard 留审计痕。知识不丢失。

### TR-TEST-6
- changeType: 修改
- targetNode: TR-TEST-6
- scope: GC 正确性类检出
- project: helix
- reason: rotten-pointer: anchor → e2e/CL-4-teardown-residue.spec.ts (docs/kg/testing-rules.md)
- evidence: kg gc_report
- sourceTask: kg-gc
- createdIn: (gc-report)
- decisionLog: 终验决策 B（用户批准 2026-08-16）：rotten-pointer 候选为 dev→main 合并时序现象——合并后 gc_report correctness=0，锚 e2e/CL-4-teardown-residue.spec.ts 已可解析（kg-inspection §六预测兑现）。候选使命完成，按「合并自愈」discard。TR-AD-8 孤儿信号为该节点暂无入边（新规则），卫生类阈值内 PASS。

### TR-AD-8
- changeType: 修改
- targetNode: TR-AD-8
- scope: 级联校验（apply E-会话聚合）
- project: helix
- reason: 邻居 TR-AD-8 的锄点 apps/shell/src/ 符号解析失败（符号已消失？）
- evidence: kg apply 级联校验 @ iter-20260816-uzvg
- sourceTask: kg-apply
- createdIn: iter-20260816-uzvg
- decisionLog: 终验裁决（2026-08-16）：apply 级联校验误报——symbol-gone 针对的是目录级锚（apps/shell/src/ 等分层目录指针，非代码符号，codegraph 符号解析天然不含目录）。目录锚是 TR-AD-1/TR-AD-2/TR-AD-8 的既有语义形态（指层不指文件），非腐烂指针。discard；如后续需文件级锚精化列入优化项 #15（anchor 覆盖率回升）一并处理。

### TR-TEST-4
- changeType: 修改
- targetNode: TR-TEST-4
- scope: domain
- project: helix
- reason: L3 语义复核判轻度不一致（行为缺口非文本漂移）：E 层 daemon fixture 违反「测试结束清理 tmp」字面纪律——daemon-fixture.ts:16 导入 rmSync 未用，teardown（:266-268）只 stop() 不删 helix-e2e-home-* tmp 目录（每次 e2e 运行残留一套 home 含 helix.db/logs/sandbox）。隔离核心全部满足（mkdtemp tmp home/真实 ~/.helix 零触碰/端口预检 fail-fast/全 argv 传参）。修正方向：代码改——teardown 在全部 daemon 收尾后统一 rmSync(home,{recursive,force})（注意 TS4 重启场景同 home 复用语义），约 3 行；规则文本不动。终验阶段不改生产代码，建议随 pending 候选 apply（合并落 TR-TEST-5 时同批）或 M2 处理由人审裁决
- evidence: final-verification/l3-review-rules.md TR-TEST-4 详评；对照 integration/sqlite-persistence.test.ts:99,117,213,261 有 rmSync 清理
- implementationStatus: 部分实现
- implementedCode: e2e/harness/daemon-fixture.ts:16,80,266-268（teardown 缺 rmSync）
- sourceTask: final-verification L3 语义复核·规则面（phase-reviewer agt_A3RMAK9S5SNP，2026-08-15，DONE）
- createdIn: iter-20260815-6tss
- decisionLog: 终验决策 B（用户批准 2026-08-16）：deferred 候选的修正方向已由本迭代 T5.2 teardown 三件套完整兑现并固化为 TR-TEST-6（daemon-fixture teardown 统一 rmSync + 三面断言 + x2 连跑零残留，E 层 14 passed 证据）——「测试结束清理 tmp」字面纪律现为真实现。候选使命完成，discard 保留审计痕（上迭代 iter-20260815-6tss 遗留收口）。
- deferHistory: [iter-20260815-6tss]
