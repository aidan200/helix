# 迭代索引

> 每条迭代记录 2-3 行描述（讲清主体改动，尽量精简）。
> 具体过程文档在 workspace（草稿），此处只存索引描述。

## iter-20260815-6tss — iter-20260815-6tss 底座成熟度 M0：helix 首迭代（WS daemon + 浏览器聊天闭环，CL-1~CL-8）
- 主体：主体：主体：主体：验证两轮全绿（F 29 + E 7 + 重启 3 E2E、单测 175/37、typecheck 零错）；终验审计通过（生产就绪四基线 + 架构审计 + L3 复核 19/19），用户批准全部裁决。kg 沉淀终态：25 节点/42 边（新增 TR-TEST-5/TR-AD-13/14，修正 TR-AD-2/7/TR-TEST-1/2，补录 TR-AD-10/11/12），孤儿 0 / anchor 92% / pending 清空。遗留：优化机会清单 20 项（M2 首批：compaction 失败注入 + a11y token 调优）。
- 状态：已沉淀

## iter-20260816-uzvg — iter-20260816-uzvg — helix M2：SubAgent 同构化 + thinking/token 补齐 + 工程卫生批次（CL-1~4 / AD-1~10）
- 主体：主体：主体：- 主体：M2 SubAgent 同构化落地（调度器预算/排队/closure 双通道 + SubAgent 抽屉 + thinking/compaction/usage 三通道 + 重启恢复语义）；验证 F 层 63 / E 层 14 全绿；终验通过（生产就绪四基线 + 全局审计 + L3 复核 29 节点），用户批准全部裁决（候选 7 apply + 7 discard、OI-3 走契约 §9 登记路径、TR-AD-20 补落）。kg 终态：36 节点 / pending 清空。遗留：优化机会 16 项归 M3（session-reducer 拆分、TR-AD-15/19 行为面补齐、CI/依赖审计基建）。
- 状态：已沉淀

## iter-20260816-6q6f — iter-20260816-6q6f — helix M3：多会话面板线 + 模型模块 + 契约 v0.2（CL-1~4 / AD-1~4 落地 + M5 热修）
- 主体：主体：主体：M3 面板线落地（CL-1 多会话管理 / CL-2 核心面板聚合 / CL-3 模型模块 auth+目录+切换 / CL-4 工程批次）+ 契约 v0.2（统一信封 sessionId 路由 + 八族 37 事件 + 点对点结果帧）+ AD-1~4 落地（尾窗分页/模型模块/事件分发/SessionRegistry）+ M5 热修六提交（T5.1 多会话切换串台 critical 修复）；验证两轮全绿（Round-1 F 36/E 19×2，Round-2 M5 复核 F 91/E 20×2 零回退）；终验通过（生产就绪四基线 PASS + 全局审计 PASS-with-notes + L3 复核 20 节点 19 一致），用户批准 18 条候选裁决（apply：撤边界×2/落地定稿/文本修订/新增 TR-AD-21·22 + E-模型目录·E-认证凭据；AD-1~4 决策档案入 docs/kg/decisions.md——kg A-1 模型决策非图节点，溯源由 TR derivedFrom 承载）。kg 终态 40 节点 / pending 清空。遗留：优化机会清单 17 项（vite/vitest dev 依赖升级、暗主题 text-dim 对比度、backlog #58 四项转下迭代）。
- 状态：已沉淀

## iter-20260818-mq5a — helix M4：SubAgent spawn 锚点 + monitor 档订阅 + 定向 steer + 多页面导航（CL-1~7 / AD-1~5）
- 主体：主体：主体：M4 SubAgent 交互面落地：spawn 锚点（anchorEntryId 组装期派生不落库）+ monitor 档订阅（连接级 tier + 白名单单点）+ 定向 steer（agent_send 通道复用 + 同构落 Entry）+ 多页面导航框架（页面域/会话域分离）；契约 v0.3 一次定形（三处 additive 零新命令对）+ 工程卫生批次（audit:assert/a11y 判据化 + TMPDIR 卫生预检）。验证 F 层 118/0 + E 层 21/1 known-flake + 契约对齐 8 组同构 + 还原度 19/19；终验通过（生产就绪四基线 LCP 0.11s/CLS 0.0849/双主题对比度全过/零漏洞 + 全局审计 0 BLOCKER + L3 复核 19 节点 18 一致），用户批准全部裁决。kg 终态：41 节点 / 锚定 58.5%→68.3% / TR-TEST-6 外补落库（撞号走 6q6f 决策 A 同款 direct-write+discard 留痕）+ 六节点补锚 / pending 清空。遗留：优化机会 16 项，含 P0 三项（终验后用户实测发现 SubAgent 真机 7 连败：A engine_error 错误透传接线 + B closure 摘要并入错误原因 + C 模型解析链改 profile>会话>全局默认，用户裁决转下迭代；另 PROTOCOL.md v0.3 升版、拆分候选、E 层 flake 收尾）。
- 状态：已沉淀

## iter-20260819-erio — SubAgent 可观测性（P0 可靠性修复 + trace 页完整版 + 契约 v0.4）
- 主体：主体：主体：M5 SubAgent 可观测性：P0 三项真机修复（engine.error 呈现面通路 + closure 兜底原因 + spawn 模型三级解析链 TR-AD-24 落库）+ trace 页完整版（P-1，trace.query 命令族 + agent.instantiated/model.changed 落盘事件）+ PROTOCOL.md v0.4 收口。验证全绿：E 层 27/0 零 flake、CL-5 E2E 10/10、fidelity 8/8、契约类型层零漂移；终验生产就绪四项 PASS、全局审计 PASS-with-notes 无阻塞、L3 复核 15/15。
- 状态：已沉淀

## iter-20260820-qhv8 — 工程治理批次（审计冻结→拆分→契约 SoT v0.5→清理→测试基建）
- 主体：主体：主体：纯工程治理批（零功能零 UI）：五热点拆分（type-surface 1582→15 文件、SchedulerService/DtoMapper/WsServerAdapter/events 拆分 + F-8 解环）+ 契约 SoT v0.5 收口（payload 全量回迁 + sot 五断言 + mock 织密）+ 死代码清理 + dev 升级 latest；退出基线全绿（daemon 453/0、shell 305/0、protocol 38/0、E 层 27/0、F 层 123/0、audit:assert ①-④）。终验：生产就绪四项全过、L3 复核 29 节点（6 文本漂移修正落库）、kg 裁决 17 候选清空（新增 TR-TEST-7 解环验证纪律），优化池移交 20+2 热点/N7-N11。
- 状态：已沉淀

## iter-20260821-dg90 — 技术债偿还批次（H0 e2e 闸 + H1 快赢 + H2 结构 + H3 投资）
- 主体：主体：技术债偿还批次：H0 e2e 终验入口闸基线落档；H1 快赢（吞错 5 处消除、竞态剧本常驻、types.ts 删除）；H2 结构（SessionRegistry 六台账收敛、container 738→443 拆 assembly/、createTestDaemon 两形态、ChatService 767→589 薄路由四族）；H3 投资（projection 三域纯函数迁 protocol 单源、fake 镜像段退役、注释考古 720 行迁 5 ADR、packages/common 落地 + AG-15 守护）。终验：生产就绪四项全绿；L3 复核 37 节点全处理；kg 裁决 15 候选清空（14 apply 含 TR-AD-29/30/31 新增 + 1 discard），节点 48→51。
- 状态：已沉淀

## iter-20260823-6ps5 — CL-1 用户按任务调节推理强度（P-1 chat 滑块 / P-2 profile 字段，协议 v0.11 thinking 批）
- 主体：协议 v0.11 thinking 批（thinking.set/changed 命令族 + CatalogModel 能力位 + 快照/agent.instantiated/agent.config thinking 槽位 additive）；daemon 主会话解析链（引擎覆盖>槽位>兜底 medium + 能力 clamp + 跨冷恢复）与 SubAgent 两级链（profile.thinkingLevel ?? medium + env 定格透传）；shell P-1 composer 滑块（PEAK 特效/双主题/能力驱动刻度）+ P-2 profile 推理级别字段。验证全绿（E2E 5/5 + 回归 31/31 + 契约四方同构 + 还原度 14/14）；终验生产就绪四项全过 + 全局审计 GO + L3 复核 36 节点全覆盖（39 confirm）；kg 台账 20 候选裁决清零（7 apply + 13 直写先例，TR-AD-43/44 签发），终态 65 节点/pending=0；PROTOCOL.md 版本位机械修；遗留 0 critical/important，优化机会 18 项（kg 工具链 rebuild 清空复核戳 + propose 路径 bug 为首）。
- 状态：已沉淀

## task-20260824-thinking-unify — thinking 语义修订 + closure/steer 区分 + 实例 ID 统一（默认模式三批联作）
- 主体：默认模式三批：①thinking 语义修订（默认关 D 方案 + off 升格显式关——clamp 前短路防 off:null 升档反转 + setModel 重播 thinking.changed + P-1 OFF 第 0 刻度 + P-2 on/off 开关 + defaultLevelFor 中位档 + scope/note 文案删除 + SubAgent 模型链 T12 两级化砍 spawn 会话继承）；②closure/steer 消息类型区分（SteerSource user/closure/progress 三值贯通协议/Entry/steer_queue/实时帧 + 主时间轴 CLOSURE/PROGRESS 徽标变体）；③实例 ID 统一方案 A（agent-<hex 唯一串> 含 main、kind 判别替代值判等、seq/agentSeqOf/maxAgentSeq 退役、MAIN_INSTANCE_ID 全仓退役、wire 归属编码一致性修复——R4 红点根因）。修复：模型菜单选中即关（B 方案推翻 2015f0e）；daemon 测试 TMPDIR 泄漏清零（4 泄漏源）。验证：daemon 872 / protocol 87 / shell 478 / E 层 e2e 31/31 / typecheck 四包全绿。
- 状态：已沉淀
