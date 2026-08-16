# 迭代索引

> 每条迭代记录 2-3 行描述（讲清主体改动，尽量精简）。
> 具体过程文档在 workspace（草稿），此处只存索引描述。

## iter-20260815-6tss — iter-20260815-6tss 底座成熟度 M0：helix 首迭代（WS daemon + 浏览器聊天闭环，CL-1~CL-8）
- 主体：验证两轮全绿（F 29 + E 7 + 重启 3 E2E、单测 175/37、typecheck 零错）；终验审计通过（生产就绪四基线 + 架构审计 + L3 复核 19/19），用户批准全部裁决。kg 沉淀终态：25 节点/42 边（新增 TR-TEST-5/TR-AD-13/14，修正 TR-AD-2/7/TR-TEST-1/2，补录 TR-AD-10/11/12），孤儿 0 / anchor 92% / pending 清空。遗留：优化机会清单 20 项（M2 首批：compaction 失败注入 + a11y token 调优）。
- 状态：已沉淀

## iter-20260816-uzvg — iter-20260816-uzvg — helix M2：SubAgent 同构化 + thinking/token 补齐 + 工程卫生批次（CL-1~4 / AD-1~10）
- 主体：- 主体：M2 SubAgent 同构化落地（调度器预算/排队/closure 双通道 + SubAgent 抽屉 + thinking/compaction/usage 三通道 + 重启恢复语义）；验证 F 层 63 / E 层 14 全绿；终验生产就绪四基线达标 + 全局审计干净 + L3 复核 29 节点（19 一致/10 文本修正落库）+ TR-AD-20 补落（AD-2 覆盖）；遗留 4 项用户决策（OI-3 走契约 §9 登记路径）+ 优化机会 16 项归 M3。
- 触及：E-AgentInstance, E-会话聚合, E-ClosureRecord, TR-AD-1, TR-AD-15, TR-AD-18, TR-AD-19
- 状态：进行中
