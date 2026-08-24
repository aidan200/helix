# T4 Brief: shell 模式选择器 + 草稿显示链换源

## 背景定位

helix P1「会话模式框架」前端面。协议契约已定（main 上 commit 460b048）：`@helix/protocol` 导出 `MODES`/`ModeId`/`DEFAULT_MODE_ID`；`chat.send` draft payload 可选 `mode`；`session.snapshot`/`connection.welcome` 可选 `mode`（草稿态 welcome 不带 mode）。

设计语义（计划文档 D3/D4）：草稿模式 = **纯前端状态**（切换零 daemon 交互）；`chat.send{draft:true, mode}` 是唯一上送点；建会话后 session.mode 快照回带，UI 只读锁定（无第二条写路径）。

## 任务目标

1. **header 模式选择器**：`widgets/top-bar/ui/P-1-top-bar.tsx` TopBarInfo 的 `t("chat.header.session")` 静态 chip（"main-session"）替换为模式显示/选择组件：
   - 草稿态（`state.sessionId === null`）：可切（下拉/popover，选项 = MODES），切换 = dispatch 本地 action，**同时丢弃本地 draft model/thinking 暂存**（会话将是新的，用户重选）；
   - 已建会话：只读显示 `state.mode`（快照/welcome 回带，缺省 default）；
   - `~/.helix` chip 保留不动。形态对齐现有 hud-chip 语言（可参考 model-badge 的 popover 模式，若嫌重可用简单 dropdown；本期仅 1 个选项，交互从简）。
2. **草稿 mode state**：session store（`entities/session/model/state.ts` SessionState 或草稿相关 slice）加 `draftMode`（初始 default）；快照到达转正时由快照 mode 收权；new draft 重置 default。reducer action + 既有 store 纪律（纯函数、AG-14）。
3. **chat.send draft 带 mode**：`SessionContext` sendMessage 草稿链（:345-353 附近）payload 加 `mode`——**非 default 才带**（default 走协议缺省，减少帧噪音）；`commands.ts` chatSendDraftCommand 构造器同步。
4. **草稿徽标链换源**：`TopBarActions` isDraftReady 分支现 `state.model || topology.modelConfig.defaultModel` → 改为 `state.model || 当前模式 profileKind 的模型槽位值 || topology.modelConfig.defaultModel`。槽位值数据源：**复用 agent.config 族结果帧**（AgentPage 在用的 profiles[].model 面）——先探查该帧现在被谁消费、存哪（`pages/skills/model/agent-config-model.ts` 是 AgentPage 本地面还是拓扑面）；若为 AgentPage 本地 store，则把「当前 profileKind 的 model/thinking 槽位」提升为 topology 级轻量读面（拓扑级消费者新增或扩展现有 agentConfig 面），connected 时拉一次 + revision 失效重拉。**不新建第三条平行配置读面**。
5. **thinking picker 草稿基准换源**：`ComposerThinkingPicker` 草稿态刻度/显示基于当前模式槽位模型的能力位（catalog 内 resolve 该 model id 的 thinkingLevels）；显示值 = 本地暂存 ?? 槽位 thinking ?? 默认关。已建会话行为不变（thinking.changed 权威）。
6. **i18n**：`chat.header.session` 词条退役（或改造为模式名词条），新增模式显示名词条（双语同步，zh-CN 是事实源结构）。
7. **测试**：top-bar、SessionContext/store reducer、ComposerThinkingPicker、commands 构造器等既有测试更新 + 新行为测试（草稿切换、切换丢弃暂存、快照收权锁定、send 带 mode）。

## 边界（不要做）

- 不动 apps/daemon（T3 并行在做）、不动 packages/protocol。
- 不动 P-3 模型菜单（ModelSwitchMenu）与 thinking.set 覆盖链的已建会话语义。
- 不动 AgentPage 本身的配置 UI。
- 不做 last_mode 持久化。

## 工作方式

- **在独立 git worktree 工作**（从 main 当前 HEAD `git worktree add /tmp/helix-wt-t4 -b task/t4-mode-selector` 类似），完成后在 worktree 内提交 commit 并报告 commit hash——MainAgent 负责合并。**不要直接改主仓**。
- TDD：新行为先写失败测试。
- CodeGraph 索引（projectPath=helix）可用于探查（索引在主仓，worktree 改动不影响你探查既有代码）。
- 测试：`cd <worktree> && bun test apps/shell`（若脚本不同以仓内脚本为准）+ `bunx tsc -p apps/shell --noEmit`。

## 验收标准（闭环逐条应答）

1. header 模式组件：草稿可切/已建只读，MODES 数据驱动，i18n 双语就位，有测试。
2. draftMode state：切换 action、快照收权、new draft 重置、切换丢弃 draft model/thinking 暂存，均有 reducer/组件测试。
3. chat.send draft payload 非 default 带 mode，构造器测试钉死；default 缺省不带。
4. 草稿徽标链三级回退（本地 ?? 槽位 ?? 全局默认）+ 槽位读面复用 agent.config 族（说明落位方案），测试覆盖。
5. thinking picker 草稿基准 = 槽位模型能力位 + 槽位 thinking 回退，测试覆盖。
6. shell 测试全绿 + tsc 零错；worktree 内 commit 已提交并报告 hash。

## 报告要求

submit_result 传 taskId="T4"；acceptance 逐条应答；findings 必填（改动文件清单、槽位读面落位方案与理由、worktree 路径与 commit hash、与设计的偏差）。
