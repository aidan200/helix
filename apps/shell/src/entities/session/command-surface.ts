/**
 * entities/session —— SessionContext 命令/订阅面注册表（M38 注册表化）。
 *
 * 原「接口声明 + useCallback + value 对象 + deps 数组」四点联动收敛为单一
 * 登记点：COMMAND_SURFACE（命令面，键 = SessionContextValue 方法名，值 =
 * deps → 方法实现 的工厂）与 LISTEN_SURFACE（订阅面，键 = subscribe* 方法名，
 * 值 = 帧匹配谓词）。SessionContextValue 的命令/订阅面类型由注册表键派生，
 * provider 侧一次性构建整个面后摊入 context value——新增域命令 = 本文件追加
 * 一条注册表项，不再存在漏登 value 对象 / 漏登 deps 数组的结构性缺陷面。
 *
 * 纪律：纯工厂模块——无 React / 无 IO（IO 全部经 deps 注入）；命令帧形状
 * 一律走 shared/api/commands 构造器（E-84 契约不改形状）；FSD 归属
 * entities/session（TR-23）。
 */
import type {
  AgentBasePromptGetPayload,
  AgentSkillContentGetPayload,
  AgentSkillCreatePayload,
  AgentConfigSetEnabledPayload,
  CodeReviewCreatePayload,
  CommandEnvelope,
  EventEnvelope,
  McpServerInput,
  KgBootstrapCreatePayload,
  KgCandidatesListPayload,
  KgChangeReportPayload,
  KgGraphPurgePayload,
  KgHealthPayload,
  KgIndexDeletePayload,
  KgIndexStatusPayload,
  KgListPayload,
  KgNodeConfirmPayload,
  KgNodeDetailPayload,
  KgReviewCreatePayload,
  TaskArtifactsPayload,
  TaskDetailPayload,
  TaskListPayload,
  TraceQueryPayload,
  DiffGetPayload,
} from "@helix/protocol";
import {
  agentBasePromptGetCommand,
  agentKillCommand,
  agentSkillContentGetCommand,
  agentSkillCreateCommand,
  agentConfigListCommand,
  agentConfigSetEnabledCommand,
  agentSubscribeCommand,
  agentUnsubscribeCommand,
  authDeleteKeyCommand,
  authListCommand,
  authSetKeyCommand,
  authVerifyCommand,
  chatAbortCommand,
  chatSendCommand,
  chatSendDraftCommand,
  chatSteerCommand,
  codeReviewCreateCommand,
  configGetCompactionCommand,
  configSetCompactionCommand,
  configGetSchedulingCommand,
  configSetSchedulingCommand,
  configGetPortCommand,
  configSetPortCommand,
  diffGetCommand,
  kgBootstrapCreateCommand,
  kgCandidatesListCommand,
  kgChangeReportCommand,
  kgGraphPurgeCommand,
  kgHealthCommand,
  kgIndexDeleteCommand,
  kgIndexStatusCommand,
  kgListCommand,
  kgNodeConfirmCommand,
  kgNodeDetailCommand,
  kgProjectsCommand,
  kgReviewCreateCommand,
  modelCatalogCommand,
  modelCatalogRefreshCommand,
  modelGetDefaultCommand,
  modelSetCommand,
  modelSetDefaultCommand,
  modelSetThinkingDefaultCommand,
  sessionDeleteCommand,
  sessionListCommand,
  sessionLoadHistoryCommand,
  taskArtifactsCommand,
  taskCancelCommand,
  taskDeleteCommand,
  taskDetailCommand,
  taskListCommand,
  taskPauseCommand,
  taskResumeCommand,
  taskRetryCommand,
  taskSubscribeCommand,
  taskUnsubscribeCommand,
  thinkingSetCommand,
  traceQueryCommand,
  webStartCommand,
  webStopCommand,
  mcpServersAddCommand,
  mcpServersListCommand,
  mcpServersRemoveCommand,
  mcpServersTestCommand,
  mcpServersUpdateCommand,
  mcpToolsListCommand,
  workspaceGetCommand,
  workspaceOpenCommand,
} from "@/shared/api/commands";
import type { SessionAction, TopologyState } from "./model/state";
import { selectCanLoadEarlier } from "./model/topology";
import type { SubscriptionLedger } from "./model/subscription-ledger";

/**
 * 命令面工厂依赖面（provider 注入的全部 IO/读取缝；全部经 ref 间接取值，
 * 工厂产物天然稳定——原实现所有 useCallback 均为零 deps 即证）。
 */
export interface CommandSurfaceDeps {
  /** 出站命令帧发送（client.send；返回 false = 未连接发送失败）。 */
  readonly send: (cmd: CommandEnvelope) => boolean;
  /** 拓扑根 reducer action 派发（ui/* / session/* / model/* / conn/* 族）。 */
  readonly dispatch: (action: SessionAction) => void;
  /** 读当前拓扑（命令构造读点：活跃会话 id / 分页游标 / modelConfig 态）。 */
  readonly getTopology: () => TopologyState;
  /** 读 v0.3 订阅图簿记（全图订阅生命周期唯一权威）。 */
  readonly getLedger: () => SubscriptionLedger;
  /** 读当前生成态（submit 发送语义分流：空闲 turn / 生成中 steer）。 */
  readonly isGenerating: () => boolean;
  /** 手动重试连接（SM-2；client.retry 透传）。 */
  readonly retryConnection: () => void;
}

/** 命令面工厂形态：deps → 方法实现。 */
type CommandFactory = (deps: CommandSurfaceDeps) => (...args: never[]) => unknown;

/**
 * 命令面注册表（唯一登记点）：键 = SessionContextValue 方法名，值 = 工厂。
 * 按域分组（组注释标域）；新增域命令在本表追加一条即完成全部登记。
 */
export const COMMAND_SURFACE = {
  // ── 草稿 / 发送面 ─────────────────────────────────────────
  setDraft: ({ dispatch }) =>
    (text: string) => dispatch({ type: "ui/set-draft", text }),
  /** 提交输入：生成中自动转 steer（F(7).3），否则 chat.send（草稿 = draft:true 建会话）。
   *  T9（v0.10）：images 可选（base64 data URL，≤4 张）——仅 turn 模式透传
   *  chat.send；steer 带图非目标（生成中附件钮禁用，防御性忽略）。
   *  M9（#2.18，TR-84）：send 返回值必消费——先发出站帧，成功才 dispatch
   *  ui/send（清草稿 / steer echo）；conn=connected 但 socket 断线窗口内
   *  send=false → 草稿原样保留（恢复 = 未清）+ 返回 false（调用侧 err toast
   *  交代，deleteSession 先例）。 */
  submit: (deps) =>
    (raw: string, images?: string[]): boolean => {
      const text = raw.trim();
      if (!text) return false;
      const mode = deps.isGenerating() ? "steer" : "turn";
      const { sessionId } = deps.getTopology().active;
      let ok: boolean;
      if (mode === "steer") {
        // 生成中注入：活跃会话信封（理论上必有会话；防御性缺省 = daemon 当前会话）
        ok = deps.send(chatSteerCommand(text, sessionId ?? undefined));
      } else if (sessionId === null) {
        // 草稿首条消息（契约 B §1.5）：无信封 sessionId + draft:true →
        // daemon 建聚合 + list_changed{created} + 订阅切换 + 新会话快照回推。
        // T3（bug4）：草稿所选模型（ui/set-draft-model 本地暂存）随首条上送；
        // 未选（空串）→ 不携带 model（daemon 用全局默认）。
        // P1 T4：草稿所选模式随首条上送；default 不带（协议缺省，减帧噪音）——
        // 构造器 chatSendDraftCommand 统一裁决
        const active = deps.getTopology().active;
        const draftModel = active.model;
        ok = deps.send(
          chatSendDraftCommand(
            text,
            draftModel === "" ? undefined : draftModel,
            images,
            active.mode,
          ),
        );
      } else {
        ok = deps.send(chatSendCommand(text, sessionId, images));
      }
      if (!ok) return false; // 未连接：草稿/附件未清，echo 未入坞——零静默丢消息
      deps.dispatch({ type: "ui/send", text, mode, ts: Date.now() });
      return true;
    },
  /** 图片附件入草稿（T9）：chips 预览数据源；≤4 上限预检在组件侧 */
  attachImages: ({ dispatch }) =>
    (images: string[]) => dispatch({ type: "ui/attach-images", images }),
  /** 移除第 index 张附件（T9；chips 移除钮） */
  removeAttachment: ({ dispatch }) =>
    (index: number) => dispatch({ type: "ui/remove-attachment", index }),

  // ── 连接 / 会话生命周期面 ─────────────────────────────────
  /** 失败卡「重试连接」（仅 error 态有意义；SM-2 手动重试路径） */
  retry: (deps) =>
    () => {
      deps.dispatch({ type: "conn/manual-retry" });
      deps.retryConnection();
    },
  /** 中断当前生成（chat.abort 信封 sessionId；T3.2 停止按钮消费） */
  abort: (deps) =>
    () => {
      const { sessionId } = deps.getTopology().active;
      if (sessionId !== null) deps.send(chatAbortCommand(sessionId));
    },
  /** 切换会话（unsubscribe 旧 + subscribe 新 + 尾窗重建 loading→success） */
  switchSession: (deps) =>
    (sessionId: string) => {
      const prev = deps.getTopology().active.sessionId;
      if (prev === sessionId) return;
      // v0.3 先升后降（契约 §2.3 / Q-2b③）：subscribe(new, full) 立即发；旧活跃
      // 降档 subscribe(old, monitor) 挂起至 ack（session.snapshot 帧到达，见
      // provider onFrame 快照分支）——瞬时双 full 窗口内旧会话帧不丢。subscribe
      // 触发 daemon 重推目标全量快照（尾窗）→ loading 骨架转 success（P-1s）
      for (const cmd of deps.getLedger().switchTo(sessionId)) {
        deps.send(cmd);
      }
      deps.dispatch({ type: "session/switch-started", sessionId });
    },
  /** 新建草稿（F(1.2).1）：unsubscribe 旧会话 + 活跃 store 置草稿态（零建会话
   *  帧——首条消息发送时才 chat.send{draft:true}）；旧会话转后台照常执行 */
  newDraft: (deps) =>
    () => {
      const prev = deps.getTopology().active.sessionId;
      if (prev === null) return; // 已在草稿：原样（无帧无动作）
      // 旧活跃即降 monitor（v0.3：后台照跑 + 未读徽标语义；取代旧 unsubscribe）
      for (const cmd of deps.getLedger().newDraft()) {
        deps.send(cmd);
      }
      deps.dispatch({ type: "session/new-draft" });
    },
  /** 草稿模式切换（P1 T4；D3/D4 唯一写入口）：纯前端零 daemon 交互——
   *  ui/set-draft-mode 本地置 mode + 丢弃 draft model/thinking 暂存；
   *  mode 随首条 chat.send{draft:true, mode} 上送，建会话后快照收权锁定 */
  setDraftMode: ({ dispatch }) =>
    (mode: string) => dispatch({ type: "ui/set-draft-mode", mode }),
  /** 删除会话（F(1.2).4）：发 session.delete（daemon 取消全部执行 → 删库 →
   *  list_changed{deleted}）；删活跃会话则本地先切草稿态（视图即转空态）。
   *  返回 send 结果（M51：调用侧 toast 结果驱动——false = 未连接发送失败） */
  deleteSession: (deps) =>
    (sessionId: string): boolean => {
      // daemon 顺序：取消全部执行 → 删库 → list_changed{deleted}（前端零权威：
      // 卡片移除由事件驱动）；删的是活跃会话 → 本地先切草稿态（原型 F(1.2).4：
      // 视图即转空态，不等事件）
      if (deps.getTopology().active.sessionId === sessionId) {
        deps.getLedger().dropActive(); // 订阅簿记活跃位置零（退订归 deleted 帧驱动）
        deps.dispatch({ type: "session/new-draft" });
      }
      return deps.send(sessionDeleteCommand(sessionId));
    },
  /** 滚动到顶加载更早历史（selectCanLoadEarlier 门控；发 session.loadHistory） */
  loadEarlierHistory: (deps) =>
    () => {
      const active = deps.getTopology().active;
      if (!selectCanLoadEarlier(active)) return; // hasMore=false 禁用 / 在途去重
      const cursor = active.history.nextCursor;
      if (cursor === null || active.sessionId === null) return;
      deps.send(sessionLoadHistoryCommand(active.sessionId, cursor));
      deps.dispatch({ type: "ui/load-earlier" });
    },
  /** 拉取会话清单（session.list 全局命令；结果 = session.list.result 点对点回推） */
  requestSessionList: (deps) =>
    () => {
      deps.send(sessionListCommand());
    },

  // ── toast 消费面 ─────────────────────────────────────────
  consumeRestoreToast: ({ dispatch }) =>
    () => dispatch({ type: "ui/consume-restore-toast" }),
  /** spawn 秒回 toast 消费（ChatPage 渲染后置空；F1.5，v0.1） */
  consumeSpawnToast: ({ dispatch }) =>
    () => dispatch({ type: "ui/consume-spawn-toast" }),
  /** kill toast 消费（ChatPage 渲染后置空；agent.killed 终止链末端，T4.3） */
  consumeKillToast: ({ dispatch }) =>
    () => dispatch({ type: "ui/consume-kill-toast" }),

  // ── 实例面（agent.kill/subscribe/unsubscribe + 抽屉定向 steer）──
  /** agent.kill 命令（抽屉两步确认后发送；终态回流经 agent.killed 事件，契约 §4） */
  killInstance: (deps) =>
    (agentId: string) => sendAgentCommand(deps, "agent.kill", agentId),
  /** agent.subscribe（抽屉打开；v0.1 通路语义，契约 §8-1） */
  subscribeInstance: (deps) =>
    (agentId: string) => sendAgentCommand(deps, "agent.subscribe", agentId),
  /** agent.unsubscribe（抽屉关闭/换订） */
  unsubscribeInstance: (deps) =>
    (agentId: string) => sendAgentCommand(deps, "agent.unsubscribe", agentId),
  /** 抽屉定向 steer（CL-3 F(3.3).3，契约 v0.3 §3.3）：chat.steer 携带
   *  instanceId 定向寻址 + 本地 echo 双投影（主轴细条 + 实例 channel 标记）；
   *  发送即清空无阻塞态——失败回执（connection.error）走既有错误提示通道 */
  steerInstance: (deps) =>
    (raw: string, instanceId: string) => {
      // echo 先进共享 store（双处立即可见）再发出站帧；草稿无会话上下文 =
      // 零帧零动作（抽屉在正常流中不会处于草稿态，防御分支）
      const text = raw.trim();
      if (text === "") return;
      const { sessionId } = deps.getTopology().active;
      if (sessionId === null) return;
      deps.dispatch({ type: "ui/steer-instance", text, instanceId, ts: Date.now() });
      deps.send(chatSteerCommand(text, sessionId, instanceId));
    },

  // ── model / auth 命令面板（契约 C；T3.3 P-3/P-4）──
  // 命令发送同刻 dispatch started action（in-flight 锁定 + 乐观面；结果帧
  // 到达由 model-config 消费者接管）
  /** 会话模型运行期切换（P-3 选中即切 / 重置为默认；下一 turn 生效）。 */
  setSessionModel: (deps) =>
    (model: string) => {
      const { sessionId } = deps.getTopology().active;
      if (sessionId === null) {
        // 草稿无会话上下文（T3，bug4）：本地暂存（ui/set-draft-model）——
        // 徽标即时反映，随首条 chat.send{draft:true, model} 上送生效
        deps.dispatch({ type: "ui/set-draft-model", model });
        return;
      }
      deps.send(modelSetCommand(model, sessionId));
    },
  /** 会话 thinking 档覆盖（thinking 批①，T2.1 P-1 滑块选档；下一 turn 生效；
   *  草稿态本地暂存——draft-model 先例对齐，快照建会话后补发 thinking.set）。 */
  setSessionThinking: (deps) =>
    (level: string) => {
      // 仿 setSessionModel 三段先例——命令发送（thinkingSetCommand 信封
      // sessionId）+ 草稿本地暂存（ui/set-draft-thinking；chat.send 零字段 →
      // 转正补发见 provider onFrame 快照分支）+ 生效回执 thinking.changed
      // 广播消费（consumers/thinking-level.ts）
      const { sessionId } = deps.getTopology().active;
      if (sessionId === null) {
        deps.dispatch({ type: "ui/set-draft-thinking", level });
        return;
      }
      deps.send(thinkingSetCommand(level, sessionId));
    },
  /** 目录 + 全局默认拉取（P-3 打开 / P-4 进入；未请求态才发，重复打开零重发）。 */
  requestModelConfig: (deps) =>
    () => {
      const mc = deps.getTopology().modelConfig;
      if (mc.catalog === null) deps.send(modelCatalogCommand());
      if (mc.defaultModel === "") deps.send(modelGetDefaultCommand());
    },
  /** provider 凭据清单拉取（P-4 进入；auth.list 全局命令）。 */
  requestAuthList: (deps) =>
    () => {
      deps.send(authListCommand());
    },
  /** 目录强制刷新（P-4 刷新按钮；绕过 4h 缓存）。send 失败（未连接）即回滚
   *  in-flight + 返回 false（TR-84：调用侧 err toast 交代）。 */
  refreshModelCatalog: (deps) =>
    (): boolean => {
      if (deps.getTopology().modelConfig.catalogRefreshing) return true; // 在途去重
      deps.dispatch({ type: "model/catalog-refresh-started" });
      const ok = deps.send(modelCatalogRefreshCommand());
      if (!ok) deps.dispatch({ type: "model/catalog-refresh-aborted" });
      return ok;
    },
  /** 全局默认写入（P-4 选择器；乐观更新 + 回执锁定）。send 失败回滚乐观值
   *  （恢复发送前旧默认）+ 清锁定 + 返回 false。 */
  setDefaultModel: (deps) =>
    (model: string): boolean => {
      const prev = deps.getTopology().modelConfig.defaultModel;
      deps.dispatch({ type: "model/set-default-started", model }); // 乐观更新（选择器即时反映）
      const ok = deps.send(modelSetDefaultCommand(model));
      if (!ok) deps.dispatch({ type: "model/set-default-aborted", model: prev });
      return ok;
    },
  /** R7：全局默认推理强度（null = 清除）。 */
  setThinkingDefault: (deps) =>
    (level: string | null) => {
      // R7 全局兜底批：null = 清除回未配置态
      deps.dispatch({ type: "model/set-thinking-default-started", level });
      deps.send(modelSetThinkingDefaultCommand(level));
    },
  /** 压缩参数拉取（通用配置分区进入；未请求态才发）。 */
  requestCompactionConfig: (deps) =>
    () => {
      if (deps.getTopology().modelConfig.compaction === null) {
        deps.send(configGetCompactionCommand());
      }
    },
  /** 压缩参数写入（通用配置分区；result 帧驱动更新，无乐观更新）。 */
  setCompactionConfig: (deps) =>
    (reserveTokens: number, keepRecentTokens: number) => {
      deps.send(configSetCompactionCommand(reserveTokens, keepRecentTokens));
    },
  /** 调度预算拉取（通用配置分区进入；未请求态才发；config 瘦身批）。 */
  requestSchedulingConfig: (deps) =>
    () => {
      if (deps.getTopology().modelConfig.scheduling === null) {
        deps.send(configGetSchedulingCommand());
      }
    },
  /** 调度预算写入（下一次预算判定即生效，无需重启）。 */
  setSchedulingConfig: (deps) =>
    (maxConcurrent: number, maxQueued: number) => {
      deps.send(configSetSchedulingCommand(maxConcurrent, maxQueued));
    },
  /** 端口配置拉取（通用配置分区进入；未请求态才发；config 瘦身批）。 */
  requestPortConfig: (deps) =>
    () => {
      if (deps.getTopology().modelConfig.port === null) {
        deps.send(configGetPortCommand());
      }
    },
  /** 端口写入（下次启动生效；argv --port 本次运行优先）。 */
  setPortConfig: (deps) =>
    (port: number) => {
      deps.send(configSetPortCommand(port));
    },
  /** 连通验证（P-4 测试连通；started 先清旧态）。send 失败清 in-flight +
   *  恢复发送前凭据条目 + 返回 false。 */
  verifyProvider: (deps) =>
    (providerId: string): boolean => {
      const prev = deps.getTopology().modelConfig.auth[providerId];
      deps.dispatch({ type: "model/verify-started", providerId }); // 先清旧态置 verifying
      const ok = deps.send(authVerifyCommand(providerId));
      if (!ok) deps.dispatch({ type: "model/verify-aborted", providerId, prev });
      return ok;
    },
  /** key 保存（P-4 弹层；写 ~/.helix/auth.json）。send 失败清 in-flight + 返回 false。 */
  setProviderKey: (deps) =>
    (providerId: string, apiKey: string): boolean => {
      deps.dispatch({ type: "model/set-key-started", providerId });
      const ok = deps.send(authSetKeyCommand(providerId, apiKey));
      if (!ok) deps.dispatch({ type: "model/set-key-aborted" });
      return ok;
    },
  /** key 删除（P-4 两段式二击；回执后转未配置）。send 失败清 in-flight + 返回 false。 */
  deleteProviderKey: (deps) =>
    (providerId: string): boolean => {
      deps.dispatch({ type: "model/delete-key-started", providerId });
      const ok = deps.send(authDeleteKeyCommand(providerId));
      if (!ok) deps.dispatch({ type: "model/delete-key-aborted" });
      return ok;
    },
  /** 写面失败 toast 消费（F5 批：connection.error 清在途 → writeError →
   *  ModelsSettingsSection err toast 渲染后置空；spawnToast 先例）。 */
  consumeModelConfigError: ({ dispatch }) =>
    () => dispatch({ type: "model/consume-error" }),

  // ── trace 查询面（CL-5，T2.2；连接私有读面）──
  /** 发送 trace.query（点对点回执；send 失败返回 false）。单飞纪律在页面侧。 */
  sendTraceQuery: (deps) =>
    (payload: TraceQueryPayload) => deps.send(traceQueryCommand(payload)),

  // ── diff 查询面（T3+T4 diff 批；轮次 diff 详情读面）──
  /** 发送 diff.get（session 作用域——信封 sessionId 必填，草稿态无会话
   *  返回 false；点对点回执 diff.get.result 经 subscribeDiffFrames 转发）。
   *  单飞纪律在 DiffOverlay（开窗即查，窗口内不重复发）。 */
  sendDiffGet: (deps) =>
    (payload: DiffGetPayload) => {
      const { sessionId } = deps.getTopology().active;
      return sessionId === null ? false : deps.send(diffGetCommand(payload, sessionId));
    },

  // ── agent.config 查询/写面（M6 T4 智能体页；连接私有读面同构）──
  /** 发送 agent.config.list（全 kind；点对点回执；send 失败返回 false）。 */
  sendAgentConfigList: (deps) =>
    () => deps.send(agentConfigListCommand()),
  /** 发送 agent.config.set_enabled（回执 applied/skipped + applied 时
   *  agent.config.changed 广播 → 拓扑 revision 递增）。 */
  sendAgentConfigSetEnabled: (deps) =>
    (payload: AgentConfigSetEnabledPayload) => deps.send(agentConfigSetEnabledCommand(payload)),
  /** 发送 agent.base_prompt.get（base prompt 批：base 段系统提示词懒查询；
   *  回执 agent.base_prompt.get.result 点对点，经 subscribeAgentConfigFrames
   *  同一转发链到页面 reducer）。 */
  sendAgentBasePromptGet: (deps) =>
    (payload: AgentBasePromptGetPayload) => deps.send(agentBasePromptGetCommand(payload)),
  /** 发送 agent.skill_content.get（skill-content 批：skill 正文懒查询；
   *  回执 agent.skill_content.get.result 点对点，经 subscribeAgentConfigFrames
   *  同一转发链到页面 reducer）。 */
  sendAgentSkillContentGet: (deps) =>
    (payload: AgentSkillContentGetPayload) => deps.send(agentSkillContentGetCommand(payload)),
  /** 发送 agent.skill.create（skills 添加批：用户级技能创建写面；
 *  回执 agent.skill.create.result 点对点，经 subscribeAgentConfigFrames
 *  同一转发链；applied 后页面重拉 agent.config.list 收口）。 */
  sendAgentSkillCreate: (deps) =>
    (payload: AgentSkillCreatePayload) => deps.send(agentSkillCreateCommand(payload)),

  // ── web 族联网状态面（T4，契约 v0.7；IconRail 联网钮）──
  /** 发送 web.stop（停止并清理；回执 applied + 状态回 idle 经
   *  web.status.changed 广播写 topology.webStatus）。 */
  sendWebStop: (deps) =>
    () => deps.send(webStopCommand()),
  /** 发送 web.start（v0.9，T7 显式启动通路；回执 applied/skipped 点对点 +
   *  状态回 connected 经 web.status.changed 广播写 topology.webStatus）。 */
  sendWebStart: (deps) =>
    () => deps.send(webStartCommand()),

  // ── mcp 族六命令面（mcp 批：MCP server 标准接入；设置页 MCP 分区）──
  /** 发送 mcp.servers.list（配置+运行态读面；点对点回执）。 */
  sendMcpServersList: (deps) =>
    () => deps.send(mcpServersListCommand()),
  /** 发送 mcp.servers.add（新增 server；applied/connect_failed 两判别回执）。 */
  sendMcpServersAdd: (deps) =>
    (payload: McpServerInput) => deps.send(mcpServersAddCommand(payload)),
  /** 发送 mcp.servers.update（按 name 覆盖重连）。 */
  sendMcpServersUpdate: (deps) =>
    (payload: McpServerInput) => deps.send(mcpServersUpdateCommand(payload)),
  /** 发送 mcp.servers.remove（断连+落盘；stopped 广播经 mcp.status.changed）。 */
  sendMcpServersRemove: (deps) =>
    (payload: { name: string }) => deps.send(mcpServersRemoveCommand(payload)),
  /** 发送 mcp.servers.test（试连不落盘；applied/failed 两判别）。 */
  sendMcpServersTest: (deps) =>
    (payload: McpServerInput) => deps.send(mcpServersTestCommand(payload)),
  /** 发送 mcp.tools.list（指定 server 工具清单）。 */
  sendMcpToolsList: (deps) =>
    (payload: { server: string }) => deps.send(mcpToolsListCommand(payload)),

  // ── kg 族六命令面（iter-20260825-11fo T5.4，P-1 图谱页；连接私有读面）──
  /** 发送 kg.projects（左栏项目列表；点对点回执；send 失败返回 false）。 */
  sendKgProjects: (deps) =>
    () => deps.send(kgProjectsCommand()),
  /** 发送 kg.list（节点列表+搜索；三路过滤可叠加）。 */
  sendKgList: (deps) =>
    (payload: KgListPayload) => deps.send(kgListCommand(payload)),
  /** 发送 kg.node.detail（六段聚合详情）。 */
  sendKgNodeDetail: (deps) =>
    (payload: KgNodeDetailPayload) => deps.send(kgNodeDetailCommand(payload)),
  /** 发送 kg.change.report（知识变化报告；缺省当前迭代）。 */
  sendKgChangeReport: (deps) =>
    (payload: KgChangeReportPayload) => deps.send(kgChangeReportCommand(payload)),
  /** 发送 kg.node.confirm（页面唯一写：draft 转正；回执翻转后状态回读）。 */
  sendKgNodeConfirm: (deps) =>
    (payload: KgNodeConfirmPayload) => deps.send(kgNodeConfirmCommand(payload)),
  /** 发送 kg.index.status（索引四态；rebuild:true 触发构建，O-6 轮询通道）。 */
  sendKgIndexStatus: (deps) =>
    (payload: KgIndexStatusPayload) => deps.send(kgIndexStatusCommand(payload)),
  // ── kg-bootstrap 批五命令面（iter-20260829-ys7q T3.2，/project 页 bootstrap 数据面）──
  /** 发送 kg.bootstrap.create（CL-1：后端准入复核 + createTask 同源 createdBy="page"）。 */
  sendKgBootstrapCreate: (deps) =>
    (payload: KgBootstrapCreatePayload) => deps.send(kgBootstrapCreateCommand(payload)),
  // ── kg 维护批两命令面（C1，契约 PROTOCOL-CHANGELOG.md §22）──
  /** 发送 kg.graph.purge（清空图谱；危险操作——UI 两步确认，daemon 门禁复核）。 */
  sendKgGraphPurge: (deps) =>
    (payload: KgGraphPurgePayload) => deps.send(kgGraphPurgeCommand(payload)),
  /** 发送 kg.index.delete（删除索引；停 watcher + 删 .codegraph + 状态复位 absent）。 */
  sendKgIndexDelete: (deps) =>
    (payload: KgIndexDeletePayload) => deps.send(kgIndexDeleteCommand(payload)),
  // ── kg.health 批 + kg 评审批命令面（W2-E 体检看板 / W2-F 轨二发起入口）──
  /** 发送 kg.health（五项读面聚合；只列不修零写路径，absent 短路空态）。 */
  sendKgHealth: (deps) =>
    (payload: KgHealthPayload) => deps.send(kgHealthCommand(payload)),
  /** 发送 kg.review.create（发起语义体检任务；准入从简 = 索引存在即可，允许反复发起）。 */
  sendKgReviewCreate: (deps) =>
    (payload: KgReviewCreatePayload) => deps.send(kgReviewCreateCommand(payload)),
  /** 发送 code.review.create（发起代码评审任务，code-review v1.5；无准入门槛，允许反复发起）。 */
  sendCodeReviewCreate: (deps) =>
    (payload: CodeReviewCreatePayload) => deps.send(codeReviewCreateCommand(payload)),
  /** 发送 kg.candidates.list（候选台账列表读面；status 四态过滤，行含 body 全文；只读零裁决）。 */
  sendKgCandidatesList: (deps) =>
    (payload: KgCandidatesListPayload) => deps.send(kgCandidatesListCommand(payload)),

  // ── task 族九命令面（iter-20260829-ys7q T3.1，P-2 任务页；连接私有读面）──
  /** 发送 task.list（全局平铺；服务端运行中置顶+创建时间倒序）。 */
  sendTaskList: (deps) =>
    (payload: TaskListPayload = {}) => deps.send(taskListCommand(payload)),
  /** 发送 task.detail（阶段条 + 批次 + 实例 plan + 叙述句）。 */
  sendTaskDetail: (deps) =>
    (payload: TaskDetailPayload) => deps.send(taskDetailCommand(payload)),
  /** 发送 task.artifacts（阶段产物只读投影）。 */
  sendTaskArtifacts: (deps) =>
    (payload: TaskArtifactsPayload) => deps.send(taskArtifactsCommand(payload)),
  /** 发送 task.subscribe（连接级订阅；缺省 = 订阅全部任务变更）。 */
  sendTaskSubscribe: (deps) =>
    () => deps.send(taskSubscribeCommand()),
  /** 发送 task.unsubscribe（页面卸载语义位；当前无消费面，对称保留）。 */
  sendTaskUnsubscribe: (deps) =>
    () => deps.send(taskUnsubscribeCommand()),
  /** 发送 task.pause（仅 running→paused 合法）。 */
  sendTaskPause: (deps) =>
    (jobId: string) => deps.send(taskPauseCommand(jobId)),
  /** 发送 task.resume（仅 paused→running）。 */
  sendTaskResume: (deps) =>
    (jobId: string) => deps.send(taskResumeCommand(jobId)),
  /** 发送 task.cancel（pending/running/paused→cancelled 终态）。 */
  sendTaskCancel: (deps) =>
    (jobId: string) => deps.send(taskCancelCommand(jobId)),
  /** 发送 task.retry（仅 failed→running 人工复活；批次预算归零留痕 + failed 阶段重开）。 */
  sendTaskRetry: (deps) =>
    (jobId: string) => deps.send(taskRetryCommand(jobId)),
  /** 发送 task.delete（仅终态；清任务域记录不触 kg 产出）。 */
  sendTaskDelete: (deps) =>
    (jobId: string) => deps.send(taskDeleteCommand(jobId)),

  // ── workspace 族门禁面（W3；契约 PROTOCOL.md §15.10/§16.10）──
  /** 发送 workspace.get（门禁读面；连接就绪自动发一次，重连重发——
   *  webStatus 先例。entities/workspace 状态机消费回执分流 main/gate）。 */
  sendWorkspaceGet: (deps) =>
    () => deps.send(workspaceGetCommand()),
  /** 发送 workspace.open（显式绑定写面；daemon 单点校验，失败回
   *  connection.error 结构化错误码供选择页行内展示）。 */
  sendWorkspaceOpen: (deps) =>
    (root: string) => deps.send(workspaceOpenCommand(root)),
} satisfies Record<string, CommandFactory>;

/** agent 实例三命令共享出站实现（模块内助手，不占注册表键位）。
 *  M9（#2.18）：帧形状走 shared/api/commands 构造器（协议单源 TR-15，
 *  不再内联裸帧字面）。 */
function sendAgentCommand(
  deps: CommandSurfaceDeps,
  type: "agent.kill" | "agent.subscribe" | "agent.unsubscribe",
  agentId: string,
): void {
  deps.send(
    type === "agent.kill"
      ? agentKillCommand(agentId)
      : type === "agent.subscribe"
        ? agentSubscribeCommand(agentId)
        : agentUnsubscribeCommand(agentId),
  );
}

/** 命令面类型（SessionContextValue 方法面由注册表键派生——注册表项即唯一登记点）。 */
export type CommandSurface = {
  readonly [K in keyof typeof COMMAND_SURFACE]: ReturnType<(typeof COMMAND_SURFACE)[K]>;
};

/** 一次性构建整个命令面（deps 全经 ref 间接取值，产物引用天然稳定）。 */
export function buildCommandSurface(deps: CommandSurfaceDeps): CommandSurface {
  const out: Record<string, unknown> = {};
  for (const [key, factory] of Object.entries(COMMAND_SURFACE)) {
    out[key] = factory(deps);
  }
  return out as CommandSurface;
}

// ── 订阅面注册表（连接私有回执/广播转发；M38）──────────────────
// 键 = subscribe* 方法名；值 = 帧匹配谓词（命中即转发本域听众集）。provider
// onFrame 按本表驱动转发（顺序 = 声明顺序），订阅方法由键统一派生——新增域
// 订阅面 = 本表追加一条，听众集/转发分支/方法登记零手工联动。

/** 帧监听器形态（页面私有 reducer 消费，会话 store 零写入）。 */
export type FrameListener = (e: EventEnvelope) => void;

/** 订阅面域声明：帧匹配谓词（按 event.type 判定）。 */
interface ListenDomainSpec {
  readonly match: (type: string) => boolean;
}

export const LISTEN_SURFACE = {
  /** 订阅 trace 族点对点回执（trace.query.result；另转发 connection.error
   *  供在途查询错误态判定——关联靠页面单飞：仅在 pending 非空时消费）。 */
  subscribeTraceFrames: {
    match: (type) => type === "trace.query.result" || type === "connection.error",
  },
  /** 订阅 diff 族点对点回执（diff.get.result；connection.error 一并转发
   *  供 DiffOverlay 在途错误态判定——trace 族先例同构。diff.changed 广播
   *  走 consumers/diff 真消费，不经此转发）。 */
  subscribeDiffFrames: {
    match: (type) => type === "diff.get.result" || type === "connection.error",
  },
  /** 订阅 agent.config 族点对点回执（list.result / set_enabled.result /
   *  base_prompt.get.result / skill_content.get.result；changed 广播走拓扑级
   *  消费，不在此转发）。connection.error 一并转发——set_enabled 写面 daemon
   *  失败回执清在途（F5 批 #2；单飞门控消费，trace 族先例）。 */
  subscribeAgentConfigFrames: {
    match: (type) =>
      type === "agent.config.list.result" ||
      type === "agent.config.set_enabled.result" ||
      type === "agent.base_prompt.get.result" ||
      type === "agent.skill_content.get.result" ||
      type === "agent.skill.create.result" ||
      type === "connection.error",
  },
  /** 订阅 kg 族点对点回执（kg.*.result + code.review.create.result——评审回执
   *  挂既有 kg 通道，E-99；F5 批 #5 补登，TR-89 双登记纪律；O-6 零推送事件，
   *  回执全走此处；connection.error 一并转发——bootstrap 入口/写面在途错误
   *  判定靠页面单飞门控，task 族先例）。 */
  subscribeKgFrames: {
    match: (type) =>
      type === "connection.error" ||
      type === "code.review.create.result" ||
      (type.startsWith("kg.") && type.endsWith(".result")),
  },
  /** 订阅 task 族帧（task.*.result 点对点回执 + task.changed 广播 +
   *  connection.error——生命周期在途错误判定，页面单飞门控消费）。 */
  subscribeTaskFrames: {
    match: (type) =>
      type === "task.changed" ||
      type === "connection.error" ||
      (type.startsWith("task.") && type.endsWith(".result")),
  },
  /** 订阅 workspace 族帧（get/open 两结果帧 + workspace_changed 广播 +
   *  connection.error——open 在途时才消费，trace 单飞先例）。 */
  subscribeWorkspaceFrames: {
    match: (type) =>
      type === "workspace.get.result" ||
      type === "workspace.open.result" ||
      type === "workspace_changed" ||
      type === "connection.error",
  },
  /** 订阅 mcp 族帧（mcp.*.result 点对点回执 + mcp.status.changed 全局
   *  广播 + connection.error——写面在途错误判定，页面单飞门控消费）。 */
  subscribeMcpFrames: {
    match: (type) =>
      type === "mcp.status.changed" ||
      type === "connection.error" ||
      (type.startsWith("mcp.") && type.endsWith(".result")),
  },
} satisfies Record<string, ListenDomainSpec>;

/** 订阅面域键。 */
export type ListenDomain = keyof typeof LISTEN_SURFACE;

/** 订阅面类型（subscribe*(listener) → 退订函数；由注册表键派生）。 */
export type ListenSurface = {
  readonly [K in ListenDomain]: (listener: FrameListener) => () => void;
};
