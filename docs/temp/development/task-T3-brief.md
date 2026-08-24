# T3 Brief: daemon 建会话链消费 mode

## 背景定位

helix P1「会话模式框架」。T2 已落地协议面（main 上已合并，commit 460b048）：`packages/protocol/src/modes.ts` 提供 `MODES` / `ModeId` / `DEFAULT_MODE_ID`（恰一条 `default/single/main-session`）；`chat.send` payload 增可选 `mode`；`SessionSnapshotDto` / `ConnectionWelcomePayload` 增可选 `mode`。T1 已落地 KV 存储（commit 2390c1a，`DefaultModelPort` 签名未动）——本任务**不碰存储层**。

本任务把 mode 从协议面接进 daemon 建会话链。设计核心（计划文档 D4）：**锁定语义 = 结构不可能**——mode 只在草稿建会话链消费（`chat.send{draft:true, mode}`），建会话定格落库，此后无任何写路径；不设 `mode.set` 命令。

## 任务目标

1. **模式注册表消费单点**：daemon 内一个纯函数/常量模块（建议 domain 或 application 层），从 `@helix/protocol` import `MODES`/`DEFAULT_MODE_ID` 解析 `profileKindOf(mode)`——未知/缺省 mode → fallback `DEFAULT_MODE_ID`。**勿另建平行注册表**（T2 约定）。放 domain 层则不得 import protocol（查 kg 架构规则：domain 禁 pi 与 protocol，仅 @helix/common 白名单）——若冲突则放 application 层并在报告说明。
2. **透传链**：`handlers/chat.ts` handleChatSend 草稿分支提取 `payload.mode`（校验 string 非空，缺省 undefined）→ `SessionDirectoryPort.startDraftSession` 签名加 mode 参数（`SessionRegistry.ts:244`）。
3. **建会话按 mode 解析 profileKind**：
   - 热草稿复用条件（现状：`sessions.get(currentId)` 零条目即复用，`SessionRegistry.ts:249-258`）**加一条**：热草稿 main 实例的 profileKind === 目标 mode 的 profileKind 才复用；不一致 → 丢弃热草稿（零条目无成本）走 `createFresh` 按新 mode 构造。
   - `createFresh` → `buildRuntime` → main 实例创建（`SessionRegistry.ts:637-646` 现硬编码 `profileKind:"main-session"`）与 `engineFor` 的槽位 kind（`buildSessionStack.ts:375-386` 现硬编码 `modelSlot("main-session")`/`thinkingSlot("main-session")`）**统一从 mode 解析的 profileKind 取值**（default 模式下值不变，行为零变化，但字面量参数化）。
4. **session.mode 落库**：`session_state` 表加 `mode` 列（schema additive 迁移，sqlite-session）；Session 聚合 + 建会话定格 + `load` 冷恢复（旧行无值 → default）。落库点注意「daemon 收首条消息才 INSERT」的既有时序（write-through 投影），mode 随首行一起进。
5. **快照/welcome 回带**：`SessionStateView`/snapshot 构造（`buildView`/`snapshotFrame`）带 mode；welcome（`WsServerAdapter.ts:311-317`）= 当前会话的 mode。草稿态 welcome（isDraft 分支不推快照）mode 不携带（undefined，前端回落 default）——P1 语义：草稿模式是纯前端状态，daemon 不知情；报告里确认此取舍。
6. **非草稿链 mode 忽略**：信封带 sessionId 的 chat.send 即使 payload 有 mode 也忽略（协议注释已声明）——测试钉死，防第二条写路径。

## 边界（不要做）

- 不动 shell 前端（T4）。
- 不动 T1 存储层、模型/thinking 解析链语义（仅字面量参数化）。
- 不加 mode.set 命令、不做阶段切换（P2）。
- 不 bump 协议版本（T5 决策）。

## 工作方式

- **直接在主仓 `/Users/siyong/AI_Project/helix` 工作并提交 commit，不要开 git worktree**（前两个任务开 worktree 增加了合并成本；主仓当前 clean，你只管自己的改动）。
- TDD：新行为先写失败测试。
- 项目有 CodeGraph 索引（projectPath=helix）。

## 验收标准（闭环逐条应答）

1. 注册表消费单点就位（import protocol MODES/DEFAULT_MODE_ID，未知 mode fallback），有单测。
2. chat.send draft 链 mode 透传到 startDraftSession（handler → port → registry），非草稿链忽略有测试钉死。
3. 热草稿复用条件含 profileKind 一致性；不一致重建有测试。
4. session.mode 落库 + 冷恢复旧行 default + 快照/welcome 回带，各有效果测试。
5. engineFor/实例创建的 "main-session" 字面量参数化为 mode 解析值（default 下行为不变，既有测试保持绿）。
6. `bun test apps/daemon`（在 apps/daemon 或仓根）全绿 + `bunx tsc -p apps/daemon --noEmit` 零错。

## 报告要求

submit_result 传 taskId="T3"；acceptance 逐条应答；findings 必填（改动文件清单、注册表单点落位与分层取舍、welcome 草稿态取舍确认、任何与设计的偏差）。
