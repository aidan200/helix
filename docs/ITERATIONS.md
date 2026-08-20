# 迭代索引

> 每条迭代记录 2-3 行描述（讲清主体改动，尽量精简）。
> 具体过程文档在 workspace（草稿），此处只存索引描述。

## iter-20260815-6tss — iter-20260815-6tss 底座成熟度 M0：helix 首迭代（WS daemon + 浏览器聊天闭环，CL-1~CL-8）
- 主体：主体：验证两轮全绿（F 29 + E 7 + 重启 3 E2E、单测 175/37、typecheck 零错）；终验审计通过（生产就绪四基线 + 架构审计 + L3 复核 19/19），用户批准全部裁决。kg 沉淀终态：25 节点/42 边（新增 TR-TEST-5/TR-AD-13/14，修正 TR-AD-2/7/TR-TEST-1/2，补录 TR-AD-10/11/12），孤儿 0 / anchor 92% / pending 清空。遗留：优化机会清单 20 项（M2 首批：compaction 失败注入 + a11y token 调优）。
- 状态：已沉淀

## iter-20260816-uzvg — iter-20260816-uzvg — helix M2：SubAgent 同构化 + thinking/token 补齐 + 工程卫生批次（CL-1~4 / AD-1~10）
- 主体：- 主体：M2 SubAgent 同构化落地（调度器预算/排队/closure 双通道 + SubAgent 抽屉 + thinking/compaction/usage 三通道 + 重启恢复语义）；验证 F 层 63 / E 层 14 全绿；终验通过（生产就绪四基线 + 全局审计 + L3 复核 29 节点），用户批准全部裁决（候选 7 apply + 7 discard、OI-3 走契约 §9 登记路径、TR-AD-20 补落）。kg 终态：36 节点 / pending 清空。遗留：优化机会 16 项归 M3（session-reducer 拆分、TR-AD-15/19 行为面补齐、CI/依赖审计基建）。
- 状态：已沉淀

## iter-20260816-6q6f — iter-20260816-6q6f — helix M3：多会话面板线 + 模型模块 + 契约 v0.2（CL-1~4 / AD-1~4 落地 + M5 热修）
- 主体：M3 面板线落地（CL-1 多会话管理 / CL-2 核心面板聚合 / CL-3 模型模块 auth+目录+切换 / CL-4 工程批次）+ 契约 v0.2（统一信封 sessionId 路由 + 八族 37 事件 + 点对点结果帧）+ AD-1~4 落地（尾窗分页/模型模块/事件分发/SessionRegistry）+ M5 热修六提交（T5.1 多会话切换串台 critical 修复）；验证两轮全绿（Round-1 F 36/E 19×2，Round-2 M5 复核 F 91/E 20×2 零回退）；终验通过（生产就绪四基线 PASS + 全局审计 PASS-with-notes + L3 复核 20 节点 19 一致），用户批准 18 条候选裁决（apply：撤边界×2/落地定稿/文本修订/新增 TR-AD-21·22 + E-模型目录·E-认证凭据；AD-1~4 决策档案入 docs/kg/decisions.md——kg A-1 模型决策非图节点，溯源由 TR derivedFrom 承载）。kg 终态 40 节点 / pending 清空。遗留：优化机会清单 17 项（vite/vitest dev 依赖升级、暗主题 text-dim 对比度、backlog #58 四项转下迭代）。
- 触及：TR-AD-5, TR-AD-6, E-认证凭据, E-模型目录, TR-AD-21, TR-AD-22, TR-AD-15, TR-AD-19, E-会话聚合, TR-AD-7, TR-AD-18, TR-AD-2, AD-1, AD-2, AD-3, AD-4
- 状态：已沉淀

## iter-20260818-mq5a — helix M4：SubAgent spawn 锚点 + monitor 档订阅 + 定向 steer + 多页面导航（CL-1~7 / AD-1~5）
- 主体：M4 SubAgent 交互面落地：spawn 锚点（anchorEntryId 组装期派生不落库）+ monitor 档订阅（连接级 tier + 白名单单点）+ 定向 steer（agent_send 通道复用 + 同构落 Entry）+ 多页面导航框架（页面域/会话域分离）；契约 v0.3 一次定形（三处 additive 零新命令对）+ 工程卫生批次（audit:assert/a11y 判据化 + TMPDIR 卫生预检）。验证 F 层 118/0 + E 层 21/1 known-flake + 契约对齐 8 组同构 + 还原度 19/19；终验通过（生产就绪四基线 LCP 0.11s/CLS 0.0849/双主题对比度全过/零漏洞 + 全局审计 0 BLOCKER + L3 复核 19 节点 18 一致），用户批准全部裁决。kg 终态：41 节点 / 锚定 58.5%→68.3% / TR-TEST-6 外补落库（撞号走 6q6f 决策 A 同款 direct-write+discard 留痕）+ 六节点补锚 / pending 清空。遗留：优化机会 16 项，含 P0 三项（终验后用户实测发现 SubAgent 真机 7 连败：A engine_error 错误透传接线 + B closure 摘要并入错误原因 + C 模型解析链改 profile>会话>全局默认，用户裁决转下迭代；另 PROTOCOL.md v0.3 升版、拆分候选、E 层 flake 收尾）。
- 触及：TR-TEST-6, TR-TEST-3, TR-AD-15, TR-AD-23, TR-AD-8, E-AgentInstance, E-SteerQueue
- 状态：已沉淀

## iter-20260819-erio — SubAgent 可观测性（P0 可靠性修复 + trace 页完整版 + 契约 v0.4）
- 主体：M5 SubAgent 可观测性：P0 三项真机修复（engine.error 呈现面通路 + closure 兜底原因 + spawn 模型三级解析链 TR-AD-24 落库）+ trace 页完整版（P-1，trace.query 命令族 + agent.instantiated/model.changed 落盘事件）+ PROTOCOL.md v0.4 收口。验证全绿：E 层 27/0 零 flake、CL-5 E2E 10/10、fidelity 8/8、契约类型层零漂移；终验生产就绪四项 PASS、全局审计 PASS-with-notes 无阻塞、L3 复核 15/15。
- 触及：TR-AD-23
- 状态：已沉淀
