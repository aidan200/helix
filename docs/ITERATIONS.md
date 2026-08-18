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
