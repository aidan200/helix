# 热修记录 — 2026-08-20：草稿会话生命周期（不可见+转正）+ trace 页显示批次

## 缺陷（用户实测，四 bug + 三显示问题同批）

草稿会话从未设计生命周期，四个 bug 同根因：

1. **空草稿被"保存"**：会话列表为空时新建草稿（零输入），切到 trace 页后空草稿出现在清单里。
2. **删除会话自动开草稿**：期望无会话态（用户后续裁决：草稿即统一的无会话表示，不另设 none 态）。
3. **流式串台**：会话 A 流式中 new 草稿（零输入），A 的流式输出显示在草稿里。
4. **草稿无模型徽标/下拉**：顶栏徽标条件 `state.model &&` 在草稿态（model=""）不渲染。

显示问题：trace 页原型残留（右下角 DemoConsole 五态切换器 + 说明文案 + 路由文本）；详情列表无滚动容器无限延伸；折叠/展开符号位置偏移。

## 根因链

1. **bug1**：daemon「恒有当前会话」的内存草稿两面泄漏——`listSessions` 合并零条目热会话（title 空串）；`createFresh` 即写 `agent.instantiated` domain_events（trace 查询面可见幻影）。trace 页进页补发 `session.list` 时幻影入清单。
2. **bug2**：`SessionContext.deleteSession` 硬编码删除活跃后 `dispatch(session/new-draft)`——「无会话态」在模型中不存在。
3. **bug3 双重缺陷**：① `frame.ts` 后台路由守卫要求 `activeId !== null`（v0.1 假设「activeId null 仅首连前」被草稿态打破），旧会话帧绕过路由直写草稿 store；② `subscription-ledger` 对 welcome 自动 attach 的会话不登记 tiers，`newDraft()` 发不出降档命令，daemon 持续全量推流。
4. **bug4**：草稿态 `state.model` 为空 + `modelConfig.defaultModel` 仅菜单/模型页打开时才加载 → fallback 链断裂。

## 修复（方案 = 用户定稿：恒有会话不变，内存草稿「不可见 + 转正」）

| 面 | 改动 |
|---|---|
| daemon | `listSessions` 跳过零条目热会话；`createFresh` 不再发 instantiated；转正单点 `promoteDraft`（首个用户条目恰好一次 instantiated + created 补广播去重）；`startDraftSession` 命中零条目当前草稿 → 同 id 转正复用不裂变；握手命中内存草稿 → `welcome.draft:true` + 不 attach 不推快照 |
| 协议 | additive 两字段（TR-AD-23①）：`ConnectionWelcomePayload.draft?`、`ChatSendPayload.model?`（draft 建会话前选定模型） |
| daemon 模型链 | draft 建会话后、首条消息前 `setModel`；同模型短路零事件；异模型先 promoteDraft 再 setModel（保 instantiated → model.changed 次序，T4b 追修 e2e 回归） |
| shell 串台 | `frame.ts` 守卫去 `activeId!==null` + model 配置族前置；`ledger` welcome attach 静默登记 full 档 |
| shell 草稿态 | welcome draft 标记 → 草稿态（sessionId=null）；`ui/set-draft-model` 本地暂存随首条消息上送；顶栏草稿徽标 = `state.model \|\| defaultModel` + defaultModel 未载时自动拉取（fallback 加载链） |
| trace 页 | DemoConsole 全链移除（组件/dev 管道/样式/i18n 7 键）；原型残留文案（trace.sub/route）清除；应用式固定壳高度链（页面不出窗口，仅结果框 `.p1-tbody` 内滚自适应；实例面板固定栏+列表自滚；上下文卡限高 42%）；chevron 12px 居中方盒 |

## 测试

- daemon 453/0、shell 284/0、protocol 33/0、typecheck 三包零错
- e2e 全量 27/0（含 CL-5 trace E 层 4/4、F 层 fidelity 5/5——R-P1-1 断言按固定壳新裁决改写）
- TDD evidence：docs/temp/evidence/（red/green 各任务）；新增用例 30+（draft 转正 14、串台 3、徽标/命令 13+、T4b 次序 5）

## 边界备案

- 忽略 `welcome.draft` 的旧客户端草稿握手后不再自动 attach（须显式 subscribe）——additive 设计代价；
- draft 复用路径下 `set_default` 后建会话不隐式换新默认（model 字段即为此设）；
- 零条目会话定向 steer 落盘不触发转正（稀有路径，未处理）；
- e2e 五态驱动段随 DemoConsole 移除改道（断言面已由 TracePage.test.tsx 单测覆盖）；
- `CL-5-prototype-fidelity` R-P4-4「施工牌」失败经 stash 验证为**存量问题**，与本批无关。
