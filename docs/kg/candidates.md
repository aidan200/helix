# 候选台账（candidates）

## pending

### SPEC-iter-20260815-6tss-1
- changeType: 新增
- scope: domain
- project: helix
- reason: 可复用 e2e harness 基座：mock-init（addInitScript 替换 window.WebSocket 实现剧本回放注入，保留 OPEN/CONNECTING 静态常量防 readyState 门控吞帧；vite HMR 透传原生）/ protocol（帧构造类型直引 @helix/protocol，mock 与真实协议零漂移）/ scenarios（S1/S2/S3/S5/S7 剧本）/ MockController / style-utils（token 通道变量派生值断言 + transition 收敛 poll + 圆角四角展开）。TS3（真 daemon + FakeLLM E 层）与 TS4（重启恢复）及后续迭代表现验证直接同构迁移：仅将 fake WebSocket 换成真连接 + daemon 装配。候选落点建议：testing-rules 新 TR-TEST 条目（表现验证 mock 挂点与契约等价纪律）或并入 TR-TEST-3 正文扩展——由终验人审裁决（proposedId SPEC-iter-20260815-6tss-1 为临时号，正式号以人审签发为准）
- evidence: worktree commit 51b46ff（分支 dev-iter-20260815-6tss）：e2e/ 18 文件 +1663 行（harness 7 模块 + 6 个 fidelity spec + playwright.config.ts），git diff 对 apps/packages 生产源码 0 改动；TS2 29/29 用例连跑 5+ 次稳定（evidence/e2e/CL-7-fidelity-suite-green-*.txt）；mock 帧构造类型直引 packages/protocol/src，与真实协议不漂移（AG-13 两端同源结构性保证）
- implementationStatus: 完整实现
- implementedCode: e2e/harness/{mock-init,protocol,scenarios,mock-session,fixtures,style-utils,evidence}.ts（commit 51b46ff）
- sourceTask: verification/test-plan TS1+TS2 闭环（phase-tester agt_BACKRMZ8V746，2026-08-15，DONE 29/29 绿）
- createdIn: iter-20260815-6tss

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

## deferred

## applied

## discarded
