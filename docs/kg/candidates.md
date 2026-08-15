# 候选台账（candidates）

## pending

## deferred

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
- deferHistory: [iter-20260815-6tss]

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
