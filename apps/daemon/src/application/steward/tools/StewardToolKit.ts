/**
 * StewardToolKit —— 管家工具面注册与执行体（DDD 重构批 3a：工具面抽取）。
 *
 * 定位：registerTools 16 工具（spec + 执行体 + 挂闸五件 + 表面四件 +
 * remember + kg 二件 + read_session）从 StewardService 150 行内联闭包
 * 收编本类——**加工具 = 类内加一条 spec.push + 一个执行体**（原三处散布：
 * TOOL_* 常量 + 注册点 + 执行体）；风险闸（gateWriteTool/gateSurfaceAct 的
 * read/write/destructive 三档）与 pendingActionOf* 提案构造同面内聚。
 *
 * 形态（批 3a 绞杀取舍）：deps 全量透传（StewardServiceDeps 子集消费）+
 * executePending 经 deps 注入（确认执行体归确认闸域共用——批 1 的
 * ProposalLedger 编排面）；模块级辅助函数（capToolResultText 等）与
 * TOOL_* spec 常量暂留 StewardService.ts（值 import 运行期安全——function
 * hoisted + const 运行期才访问；后续批次归位）。buildSnapshotSafely（prompt
 * 组装）不属工具面，留 StewardService。
 *
 * 为什么存在：工具面是管家能力扩张的主入口（kg 二件/read_session/表面
 * 四件历次新增都在 registerTools 内联），「加工具耗时且易漏」（排查清单
 * A-15 证据：16 工具三处散布）；收编后新增工具只动本类。
 */
import type { StewardToolSpec } from "../../ports/outbound/StewardToolSpec";
import type { StewardSurfaceActRequest } from "../../ports/outbound/StewardSurfacePort";
import { evaluateSurfaceRisk, surfaceRiskRank } from "../../surface/SurfaceRiskGate";
import {
  isSurfaceNamespaceKind,
  isSurfaceVerb,
  surfaceVerbRisk,
  validateSurfaceActArgs,
  type SurfaceRisk,
} from "@helix/protocol";
import type { StewardServiceDeps, GateToolContext, GateToolOutcome, PendingAction, StewardSessionMetaRow } from "../StewardService";
import {
  capToolResultText,
  capChars,
  displayTitleOf,
  compactInstanceRows,
  summarizeArgsLite,
  hasExemptionAffordance,
  formatActReceipt,
  TOOL_LIST_INSTANCES,
  TOOL_LIST_TASKS,
  TOOL_PROPOSE_SEND,
  TOOL_QUERY_RECENT_WORK,
  TOOL_READ_SESSION,
  TOOL_KG_SEARCH,
  TOOL_KG_GET,
  TOOL_CREATE_SESSION,
  TOOL_START_SESSION,
  TOOL_SPAWN_REVIEW_TASK,
  TOOL_DELIVER_TO_SESSION,
  TOOL_REMEMBER,
  TOOL_MEMORY_SEARCH,
  TOOL_SURFACE_LIST,
  TOOL_SNAPSHOT,
  TOOL_READ,
  TOOL_ACT,
  GATED_TOOLS,
  RECENT_WORK_LINES_MAX,
  RECENT_WORK_TITLE_MAX_CHARS,
  timeRangeWindow,
  fmtWhen,
  type TimeRange,
  DELIVER_TITLE_MAX_CHARS,
  INSTANCE_TASK_MAX_CHARS,
  INSTANCE_SUMMARY_MAX_CHARS,
} from "../StewardService";

/** 工具面窄依赖（StewardServiceDeps 全量透传 + 确认执行体注入）。 */
export interface StewardToolKitDeps extends StewardServiceDeps {
  /** 确认后执行体（approve 决策路径——confirm→executePending 同源动作体）。 */
  readonly executePending: (action: PendingAction) => Promise<{ ok: boolean; detail: string }>;
}

export class StewardToolKit {
  private readonly deps: StewardToolKitDeps;
  private readonly now: () => number;
  private readonly specs: StewardToolSpec[] = [];
  private readonly hiddenNames: string[] = [];

  constructor(deps: StewardToolKitDeps) {
    this.deps = deps;
    this.now = deps.clock ?? (() => Date.now());
    this.registerTools();
  }

  /** 工具面（createEngine 装配/getProfile 观测共用）。 */
  get toolSpecs(): readonly StewardToolSpec[] {
    return this.specs;
  }

  /** 隐藏面板原语名（不进引擎工具面）。 */
  get hiddenToolNames(): readonly string[] {
    return this.hiddenNames;
  }

  /**
   * 八工具注册 ToolRegistry（迁移即验证——runTool 大 if-else 链退役）：
   * - 只读三件（list_instances/list_tasks/query_recent_work）：handler 直查；
   * - 写注入四件（propose_send/deliver_to_session/create_session/
   *   spawn_review_task）：挂闸工具——beforeToolCallPause 暂停点（gateWriteTool
   *   前置校验 + PendingAction 构造），handler 为 approve 决策执行体（L0 管家
   *   走 confirm→resolve 路径，handler 供注册面完整性与未来自动化面）；
   * - steward_confirm：hidden 注册（面板确认原语——不进 LLM 工具投影，
   *   E-46「注册面恒宽、声明面管控谁可见」同构）。
   */
  private registerTools(): void {
    // 只读三件：直查执行体（结果过 capToolResultText 体量护栏）
    this.specs.push({
      ...TOOL_LIST_INSTANCES,
      execute: async () => {
        // A1-hotfix：list_instances 走紧凑投影（status() 全量单条可达 537KB）
        const rows = compactInstanceRows(this.deps.orchestration.status());
        return { text: capToolResultText(JSON.stringify(rows)) };
      },
    });
    this.specs.push({
      ...TOOL_LIST_TASKS,
      execute: async () => {
        const rows = this.deps.tasks.listTasks({}).map((t) => ({
          jobId: t.jobId,
          title: t.title,
          status: t.status,
          progress:
            t.progress === null
              ? null
              : `${t.progress.percent}%（${t.progress.batchesDone}/${t.progress.batchesTotal} 批次）`,
          error: t.error,
        }));
        return { text: capToolResultText(JSON.stringify(rows)) };
      },
    });
    this.specs.push({
      ...TOOL_QUERY_RECENT_WORK,
      execute: async (args) => ({ text: capToolResultText(await this.queryRecentWork(args as Record<string, unknown>)) }),
    });
    // progress 批 M3：read_session——只读深读面（与三件只读同族，不挂闸）。
    // sessions 源缺席 = 引导式降级（与 query_recent_work 同姿态）。
    this.specs.push({
      ...TOOL_READ_SESSION,
      execute: async (args) => ({ text: capToolResultText(await this.readSession(args as Record<string, unknown>)) }),
    });
    // 批A：kg 只读二件（kg_search/kg_get——项目知识问答，与只读族同族不挂
    // 闸）；全链路零写：注册面不含任何 kg 写原语（写面不进管家工具面）。
    this.specs.push({
      ...TOOL_KG_SEARCH,
      execute: async (args) => ({ text: capToolResultText(await this.kgSearchOf(args as Record<string, unknown>)) }),
    });
    this.specs.push({
      ...TOOL_KG_GET,
      execute: async (args) => ({ text: capToolResultText(await this.kgGetOf(args as Record<string, unknown>)) }),
    });
    // 写注入五件：挂闸工具（GATED_TOOLS 命中即 engine_paused）——execute 为
    // approve 决策执行体（重新过闸校验 + 执行——与 confirm 的 executePending
    // 同源动作体；L0 管家走 confirm→resolve 路径，execute 供未来自动化面）
    for (const [tool, actionOf] of [
      [TOOL_PROPOSE_SEND, this.pendingActionOfProposeSend.bind(this)],
      [TOOL_DELIVER_TO_SESSION, this.pendingActionOfDeliverToSession.bind(this)],
      [TOOL_CREATE_SESSION, this.pendingActionOfCreateSession.bind(this)],
      [TOOL_START_SESSION, this.pendingActionOfStartSession.bind(this)],
      [TOOL_SPAWN_REVIEW_TASK, this.pendingActionOfSpawnReview.bind(this)],
    ] as const) {
      void actionOf;
      this.specs.push({
        ...tool,
        execute: async (args) => {
          const gated = await this.gateWriteTool({ runId: "", toolCallId: "", toolName: tool.name, args: args as Record<string, unknown> });
          if (!gated.pause) {
            const outcome = gated.outcome;
            if (outcome !== undefined && outcome.kind === "terminate") {
              return { text: outcome.reason, terminate: true };
            }
            return { text: outcome !== undefined && outcome.kind === "result" ? outcome.text : "提案未通过校验（approve 不可达此路径）" };
          }
          const outcome = await this.deps.executePending(gated.action!);
          return { text: capToolResultText(outcome.detail), ...(outcome.ok ? {} : { isError: true }) };
        },
      });
    }
    // remember（B5 摘闸）：直接执行体——静默入库 + 通知，回执回灌续轮。
    this.specs.push({
      ...TOOL_REMEMBER,
      execute: async (args) => {
        const outcome = await this.directRemember(args as Record<string, unknown>);
        return outcome.kind === "terminate"
          ? { text: outcome.reason, terminate: true }
          : { text: outcome.text, ...(outcome.isError === true ? { isError: true } : {}) };
      },
    });
    // memory_search（记忆批·同轨换轨）：只读直行——机械召回注入退役后的
    // 管家记忆消费面。query 由管家 LLM 提炼重写（纪律在 STEWARD_SYSTEM_PROMPT
    // 长期记忆纪律段）；project scope 走 memoryProject 单源（原注入点同源）。
    // 降级三态：记忆未装配/未启用 → 引导文案；零命中/召回内部降级 → 零命中
    // 文案；命中 → recallSection 行文原文（header 已改「按检索意图」措辞）。
    this.specs.push({
      ...TOOL_MEMORY_SEARCH,
      execute: async (args) => {
        const query = (args as { query?: unknown }).query;
        if (typeof query !== "string" || query.trim() === "") {
          return { text: "memory_search 需要 query（非空——对用户话语的提炼重写，语义匹配用户偏好与工作状态类记忆）", isError: true };
        }
        const memory = this.deps.memory;
        if (memory === undefined || !memory.isAvailable()) {
          return {
            text: "长期记忆未启用或未配置（设置 → 通用 → 长期记忆）——本次无用户偏好/工作状态参考，按本轮指令继续。",
          };
        }
        // 服务层内部吞错降级 undefined（召回绝不炸主链路——原注入面同族纪律）
        const section = await memory.recallSection(query.trim(), this.deps.memoryProject?.());
        return {
          text:
            section ?? "无相关记忆命中——可换更贴近用户意图的措辞重试一次；确无命中则按本轮指令正常作答。",
        };
      },
    });
    // ── M2 四泛型工具（D4）：surface_list / snapshot / read 只读直行；
    //    act 挂闸（GATED_TOOLS）——read 档经引擎 approve 面直行执行体，
    //    write/destructive 走确认闸（本执行面不直行——防绕过）。
    this.specs.push({
      ...TOOL_SURFACE_LIST,
      execute: async () => {
        if (this.deps.surfaces === undefined) {
          return { text: "表面能力面未装配（daemon 装配缺 surfaces 源）", isError: true };
        }
        try {
          const rows = await this.deps.surfaces.list();
          return { text: capToolResultText(JSON.stringify(rows)) };
        } catch (err) {
          return { text: `表面清单读取失败：${(err as Error).message}`, isError: true };
        }
      },
    });
    this.specs.push({
      ...TOOL_SNAPSHOT,
      execute: async (args) => ({
        text: capToolResultText(await this.surfaceReadOf(args as Record<string, unknown>, "snapshot")),
      }),
    });
    this.specs.push({
      ...TOOL_READ,
      execute: async (args) => ({
        text: capToolResultText(await this.surfaceReadOf(args as Record<string, unknown>, "read")),
      }),
    });
    this.specs.push({
      ...TOOL_ACT,
      execute: async (args) => {
        const decision = await this.gateSurfaceAct(args as Record<string, unknown>);
        if (decision.kind === "refuse") return { text: decision.reason, isError: true };
        if (decision.kind === "proposal") {
          // 防绕过：write/destructive 不经用户确认恒不执行（包括自动化面）
          return {
            text: "write/destructive 动作须经确认闸（propose→用户确认→执行）——本执行面不直行",
            isError: true,
          };
        }
        try {
          const result = await this.deps.surfaces!.act(decision.request);
          return { text: capToolResultText(formatActReceipt(result)), ...(result.ok ? {} : { isError: true }) };
        } catch (err) {
          return { text: `表面动作执行异常：${(err as Error).message}`, isError: true };
        }
      },
    });
    // steward_confirm：面板确认原语（hidden——不进引擎工具面（LLM 不可见）；
    // actionId 单次消费语义与 handler 层 steward.confirm 命令等价，面板直调
    // svc.confirm——引擎轨道零注册）
    this.hiddenNames.push("steward_confirm");
  }

  // ── 确认闸暂停点（write 类工具挂闸——beforeToolCallPause 实现体） ──────

  /**
   * 写注入工具挂闸判定（前置校验 + PendingAction 构造——迁移前各 proposeXxx
   * 逻辑平移）：
   * - 校验失败（引导类）→ pause:false + outcome（toolResult 回灌循环继续）；
   * - 防火墙前置拒（propose_send 实例不运行）→ pause:false + terminate
   *   （run 错误收口直出回执，KV 无痕——与迁移前行为严格等价）；
   * - 校验通过 → pause:true + action（LoopEngine 发 run.paused，ask 收口
   *   confirm_required；confirm → resumeWith(resolve) 执行 + 回灌）。
   */
  async gateWriteTool(
    ctx: GateToolContext,
  ): Promise<
    | { pause: true; action: PendingAction }
    | { pause: false; approve?: true; outcome?: GateToolOutcome }
  > {
    const { toolName: name, args } = ctx;
    if (name === "act") {
      // M2 表面动作（risk 动态档）：read 直行（approve 放行工具执行）/
      // write·destructive 挂闸（同一 steward.confirmations 两段式）/
      // 拒（私造动词/risk 降档/豁免尝试）。
      const decision = await this.gateSurfaceAct(args);
      if (decision.kind === "refuse") return { pause: false, outcome: { kind: "result", text: decision.reason, isError: true } };
      if (decision.kind === "direct") return { pause: false, approve: true };
      return { pause: true, action: decision.action };
    }
    if (name === "propose_send") {
      const action = await this.pendingActionOfProposeSend(args);
      if ("guidance" in action) return { pause: false, outcome: action.outcome };
      if ("terminate" in action) return { pause: false, outcome: { kind: "terminate", reason: action.reason } };
      return { pause: true, action };
    }
    if (name === "deliver_to_session") {
      const gated = await this.pendingActionOfDeliverToSession(args);
      if ("guidance" in gated) return { pause: false, outcome: gated.outcome };
      return { pause: true, action: gated };
    }
    if (name === "create_session" || name === "start_session") {
      const gated = await this.pendingActionOfCreateSession(args, {
        requireInitialMessage: name === "start_session",
      });
      if ("guidance" in gated) return { pause: false, outcome: gated.outcome };
      return { pause: true, action: gated };
    }
    if (name === "spawn_review_task") {
      const gated = await this.pendingActionOfSpawnReview(args);
      if ("guidance" in gated) return { pause: false, outcome: gated.outcome };
      return { pause: true, action: gated };
    }
    return { pause: false };
  }

  /**
   * 表面动作闸判定（M2 risk 三级闸——D3 risk 挂动作）：
   * - 校验面：surfaceId/verb（封闭词汇表——私造动词拒）/risk（只可升档
   *   不可降档）；豁免旗标（auto_confirm/exempt 类）嗅探 → 闸面整单拒绝
   *   （【突变验证钉子】destructive 不可豁免）；
   * - 判定面（SurfaceRiskGate）：read → direct（approve 直行）；write/
   *   destructive → proposal（同一 steward.confirmations 两段式——
   *   propose→用户确认→执行）。
   */
  private async gateSurfaceAct(
    args: Record<string, unknown>,
  ): Promise<
    | { kind: "direct"; request: StewardSurfaceActRequest }
    | { kind: "proposal"; action: PendingAction }
    | { kind: "refuse"; reason: string }
  > {
    if (this.deps.surfaces === undefined) {
      return { kind: "refuse", reason: "表面能力面未装配（daemon 装配缺 surfaces 源）" };
    }
    const surfaceId = typeof args.surfaceId === "string" ? args.surfaceId.trim() : "";
    if (surfaceId === "") {
      return { kind: "refuse", reason: "参数缺失：surfaceId 必填（先用 surface_list 发现表面）" };
    }
    const verbRaw = args.verb;
    if (!isSurfaceVerb(verbRaw)) {
      return {
        kind: "refuse",
        reason: `动词未注册（verb=${String(verbRaw)}）——封闭词汇表 click/type/navigate/scroll/focus（缺词停下申报，不私造）`,
      };
    }
    const verb = verbRaw;
    const actionArgs =
      typeof args.args === "object" && args.args !== null && !Array.isArray(args.args)
        ? (args.args as Record<string, unknown>)
        : {};
    // ── act 参数契约收紧（事故热修批①）：动词 args 形状校验（按命名空间×
    //    动词——protocol 单源 validateSurfaceActArgs）。形状不合法 → 即时拒
    //    （模型收到正确形状指引可自纠），不挂闸不派发不等回执超时——治
    //    2026-10-07 事故「模型发明 url 参数 → shell 静默弃帧 → 60s 挂死」。
    //    动词注册校验/risk 三级闸不动（E-253 约束面）。──
    const nsRaw = surfaceId.split(":")[0] ?? "";
    if (isSurfaceNamespaceKind(nsRaw)) {
      const argsError = validateSurfaceActArgs(nsRaw, verb, actionArgs);
      if (argsError !== undefined) return { kind: "refuse", reason: argsError };
    }
    const floor = surfaceVerbRisk(verb);
    let risk: SurfaceRisk = floor;
    const riskRaw = args.risk;
    if (riskRaw !== undefined) {
      if (riskRaw !== "read" && riskRaw !== "write" && riskRaw !== "destructive") {
        return { kind: "refuse", reason: `risk 非法：${JSON.stringify(riskRaw)}（应为 read/write/destructive）` };
      }
      if (surfaceRiskRank(riskRaw) < surfaceRiskRank(floor)) {
        return {
          kind: "refuse",
          reason: `risk 降级拒绝：verb=${verb} 注册档=${floor}，请求=${riskRaw}（D3 risk 挂动作——只可升档）`,
        };
      }
      risk = riskRaw;
    }
    // 豁免尝试嗅探（top-level 与 args 内两处）——闸面拒绝不可豁免
    const exempt = hasExemptionAffordance(args) || hasExemptionAffordance(actionArgs);
    const decision = evaluateSurfaceRisk(risk, { exempt });
    if (decision.outcome === "reject") return { kind: "refuse", reason: decision.reason };
    const request: StewardSurfaceActRequest = { surfaceId, verb, args: actionArgs, risk };
    if (decision.outcome === "direct") return { kind: "direct", request };
    return {
      kind: "proposal",
      action: {
        kind: "surfaceAct",
        displayTarget: surfaceId,
        message: `表面动作提案：${verb} @ ${surfaceId}（risk=${risk}）：${summarizeArgsLite(actionArgs)}`,
        toolCall: { id: "", name: "act" },
        surfaceAct: request,
      },
    };
  }

  /** 只读工具执行体（snapshot/read——免确认直行）。 */
  private async surfaceReadOf(args: Record<string, unknown>, mode: "snapshot" | "read"): Promise<string> {
    if (this.deps.surfaces === undefined) return "表面能力面未装配（daemon 装配缺 surfaces 源）";
    const surfaceId = typeof args.surfaceId === "string" ? args.surfaceId.trim() : "";
    if (surfaceId === "") return "参数缺失：surfaceId 必填（先用 surface_list 发现表面）";
    try {
      const result =
        mode === "snapshot"
          ? await this.deps.surfaces.snapshot(surfaceId)
          : await this.deps.surfaces.read(surfaceId, {
              ...(typeof args.selector === "string" && args.selector !== "" ? { selector: args.selector } : {}),
              ...(typeof args.max_chars === "number" && Number.isFinite(args.max_chars) ? { maxChars: args.max_chars } : {}),
            });
      return result.ok ? result.text : `读取失败：${result.text}`;
    } catch (err) {
      return `表面读取异常：${(err as Error).message}`;
    }
  }

  /** propose_send 提案判定（参数校验 → 运行态校验 → PendingAction）。 */
  private async pendingActionOfProposeSend(
    args: Record<string, unknown>,
  ): Promise<PendingAction | { guidance: true; outcome: GateToolOutcome } | { terminate: true; reason: string }> {
    const agentId = typeof args.agentId === "string" ? args.agentId : "";
    const message = typeof args.message === "string" ? args.message : "";
    if (agentId === "" || message === "") {
      return {
        guidance: true,
        outcome: {
          kind: "result",
          text: capToolResultText("参数缺失：agentId 与 message 必填"),
          },
      };
    }
    // 提案校验：目标须存在且运行中（防火墙前置——终态实例递话必拒）
    const running = this.deps.orchestration.status(agentId).some((s) => s.state === "running");
    if (!running) {
      return {
        terminate: true,
        reason: `实例 ${agentId} 不存在或非运行中——递话提案拒绝（可让用户确认实例 id）`,
      };
    }
    return {
      kind: "send",
      displayTarget: agentId,
      message,
      toolCall: { id: "", name: "propose_send" },
      send: { agentId, message },
    };
  }

  /** start_session 提案判定（同 create_session 动作体，initial_message 必填兑底）。 */
  private async pendingActionOfStartSession(
    args: Record<string, unknown>,
  ): Promise<PendingAction | { guidance: true; outcome: GateToolOutcome }> {
    return this.pendingActionOfCreateSession(args, { requireInitialMessage: true });
  }

  /** deliver_to_session 提案判定（驾驶舱批逻辑平移：参数 → 装配面 → 会话存在性）。 */
  private async pendingActionOfDeliverToSession(
    args: Record<string, unknown>,
  ): Promise<PendingAction | { guidance: true; outcome: GateToolOutcome }> {
    const sessionId = typeof args["sessionId"] === "string" ? args["sessionId"].trim() : "";
    const text = typeof args["text"] === "string" ? args["text"] : "";
    if (sessionId === "" || text.trim() === "") {
      return this.guideOutcome("参数缺失：sessionId 与 text 必填（sessionId 可先用 query_recent_work 查询）");
    }
    if (this.deps.sessions === undefined) {
      return this.guideOutcome("会话投递面未装配——无法投递（请让用户在目标会话页直接输入）");
    }
    let exists: boolean;
    try {
      exists = await this.deps.sessions.sessionExists(sessionId);
    } catch (err) {
      return this.guideOutcome(`会话存在性校验失败：${(err as Error).message}`);
    }
    if (!exists) {
      return this.guideOutcome(
        `会话 ${sessionId} 不存在——请用 query_recent_work 查询近期会话拿正确的 sessionId（或与用户确认目标）`,
      );
    }
    // 语音闭环批 ④：提案期查短标题（displayTarget 念人类可读短名——确认卡/
    // 提醒/口令回执/在途摘要四消费面共用）；查询失败/缺席回退 sessionId。
    let displayTarget = sessionId;
    try {
      const title = await this.deps.sessions.sessionTitleOf?.(sessionId);
      if (title !== undefined && title !== "") displayTarget = capChars(title, DELIVER_TITLE_MAX_CHARS);
    } catch {
      // 标题查询失败是增强面降级（不阻断提案链）
    }
    return {
      kind: "deliverSession",
      displayTarget,
      message: text,
      toolCall: { id: "", name: "deliver_to_session" },
      deliverSession: { sessionId, text },
    };
  }

  /** create_session / start_session 提案判定（项目参数校验 → title 缺省生成 → initial_message 解析；start_session 必填服务端兑底）。 */
  private async pendingActionOfCreateSession(
    args: Record<string, unknown>,
    opts: { readonly requireInitialMessage?: boolean } = {},
  ): Promise<PendingAction | { guidance: true; outcome: GateToolOutcome }> {
    const titleRaw = typeof args["title"] === "string" ? args["title"].trim() : "";
    const project = typeof args["project"] === "string" && args["project"] !== "" ? args["project"] : undefined;
    const guidance = this.checkProjectArg(project);
    if (guidance !== undefined) {
      return this.guideOutcome(guidance);
    }
    if (this.deps.sessions === undefined) {
      return this.guideOutcome("会话创建面未装配——无法创建会话（请让用户在侧栏新建）");
    }
    const now = new Date(this.now());
    const p2 = (n: number) => String(n).padStart(2, "0");
    const title =
      titleRaw !== ""
        ? titleRaw
        : `${project !== undefined ? `${project} ` : ""}新会话 ${p2(now.getMonth() + 1)}-${p2(now.getDate())} ${p2(now.getHours())}:${p2(now.getMinutes())}`;
    // 带着话题开新会话：initial_message 全文进确认卡（确认前用户可审，写安全
    // 同 deliver_to_session 的「全文展示供确认」惯例）；原文透传零改写。
    // start_session = 必填兑底（schema required 之外的服务端二次防线——k3 级
    // 模型可选参数遵从弱，打回重提案而非静默建空会话）。
    const initialMessageRaw = typeof args["initial_message"] === "string" ? args["initial_message"].trim() : "";
    const initialMessage = initialMessageRaw !== "" ? initialMessageRaw : undefined;
    if (initialMessage === undefined && opts.requireInitialMessage === true) {
      return this.guideOutcome(
        "start_session 需要 initial_message（用户原话，不改写）——请带上用户想在新会话开始的话题重新提案；用户只要空会话时才用 create_session",
      );
    }
    return {
      kind: "createSession",
      displayTarget: "新会话",
      message:
        initialMessage !== undefined
          ? `将创建会话「${title}」并投递初始话题：${initialMessage}`
          : `将创建会话「${title}」`,
      toolCall: { id: "", name: "create_session" },
      createSession: initialMessage !== undefined ? { title, initialMessage } : { title },
    };
  }

  /** spawn_review_task 提案判定（review_type → 项目 → git 仓/.kg 索引三道校验）。 */
  private async pendingActionOfSpawnReview(
    args: Record<string, unknown>,
  ): Promise<PendingAction | { guidance: true; outcome: GateToolOutcome }> {
    const reviewTypeRaw = args["review_type"];
    const project = typeof args["project"] === "string" ? args["project"].trim() : "";
    const params =
      typeof args["params"] === "object" && args["params"] !== null && !Array.isArray(args["params"])
        ? (args["params"] as Record<string, unknown>)
        : {};
    if (reviewTypeRaw !== "code-review" && reviewTypeRaw !== "kg-review") {
      return this.guideOutcome(
        `review_type 非法：${JSON.stringify(reviewTypeRaw)}（应为 "code-review" 或 "kg-review"）`,
      );
    }
    const reviewType = reviewTypeRaw;
    if (project === "") {
      return this.guideOutcome("参数缺失：project 必填（目标项目名）");
    }
    const root = this.deps.projects?.resolve(project);
    if (root === undefined) {
      const known = "（项目解析面未装配，无法校验项目存在性）";
      return this.guideOutcome(
        this.deps.projects === undefined
          ? `无法校验项目 ${project}${known}`
          : `项目 ${project} 不在当前 workspace——请与用户确认项目名（可用清单中的项目）`,
      );
    }
    if (reviewType === "code-review" && this.deps.hasGitRepo !== undefined && !this.deps.hasGitRepo(root)) {
      return this.guideOutcome(`项目 ${project} 无 git 仓（${root}）——没有可评审的代码，需先初始化仓库`);
    }
    if (reviewType === "kg-review" && this.deps.projects !== undefined && !this.deps.projects.hasIndex(root)) {
      return this.guideOutcome(`项目 ${project} 未建知识图谱——需先 kg-bootstrap（我可以帮你创建该任务）`);
    }
    return {
      kind: "spawnReview",
      displayTarget: `${reviewType}@${project}`,
      message: `将对项目 ${project} 发起 ${reviewType}`,
      toolCall: { id: "", name: "spawn_review_task" },
      spawnReview: { reviewType, project, params },
    };
  }

  /** remember 直接执行体（B5 摘闸静默化：参数校验 → 可用性闸 → 两段查重
   *  入库 → memory_written 通知；回执回灌 LLM 续轮）。失败/不可用回执为
   *  引导文本（LLM 转述用户）——与旧 guideOutcome 语义同构。domain 维度批：
   *  domain 可选参数（enum habit|general|project），缺省按 kind 推导
   * （preference→habit、fact→general），显式传优先；入参透传至 remember
   * （一致性约束在写入单点裁定）。 */
  private async directRemember(args: Record<string, unknown>): Promise<GateToolOutcome> {
    const text = typeof args.text === "string" ? args.text.trim() : "";
    const kindRaw = args.kind;
    const domainRaw = args.domain;
    if (text === "") {
      return this.guideOutcome("参数缺失：text 必填（记忆文本）").outcome;
    }
    if (kindRaw !== undefined && kindRaw !== "fact" && kindRaw !== "preference") {
      return this.guideOutcome(`kind 非法：${JSON.stringify(kindRaw)}（应为 "fact" 或 "preference"）`).outcome;
    }
    if (domainRaw !== undefined && domainRaw !== "habit" && domainRaw !== "general" && domainRaw !== "project") {
      return this.guideOutcome(`domain 非法：${JSON.stringify(domainRaw)}（应为 "habit"、"general" 或 "project"）`).outcome;
    }
    const kind = (kindRaw as "fact" | "preference" | undefined) ?? "fact";
    // domain 维度批：显式传优先；缺省按 kind 推导（preference→habit、fact→general）
    const domain = (domainRaw as "habit" | "general" | "project" | undefined) ?? (kind === "preference" ? "habit" : "general");
    const memory = this.deps.memory;
    if (memory === undefined || !memory.isAvailable()) {
      return this.guideOutcome(
        "记忆功能未启用或未配置——本次不沉淀（用户可在 设置 → 通用 → 管家 开启记忆并配置嵌入端点）",
      ).outcome;
    }
    try {
      // 项目隔离批：项目上下文与召回同源（memoryProject 单项目 workspace
      // 口径；多项目/未绑定 → 不传）。domain 维度批：仅 domain=project 时
      // 作项目取名通道（habit/general 一致性约束强制 global——单点裁定）。
      const project = this.deps.memoryProject?.();
      const saved = await memory.remember(text, kind, "steward-turn", {
        domain,
        ...(project !== undefined ? { project } : {}),
      });
      this.deps.emitMemoryWritten?.({ text, mode: saved.updated ? "updated" : "added" });
      const detail = `${saved.updated ? "已更新记忆（语义重复，覆盖原条目）" : "已沉淀长期记忆"}（#${saved.id}）：${text}`;
      return { kind: "result", text: capToolResultText(detail) };
    } catch (err) {
      const detail = `记忆沉淀失败：${(err as Error).message}`;
      return { kind: "result", text: capToolResultText(detail) };
    }
  }

  /** 引导式工具结果（toolResult 回灌 LLM 循环继续可转述/自纠——迁移前
   *  toolErrorResult 的校验路径产物）。 */
  private guideOutcome(guidance: string): { guidance: true; outcome: GateToolOutcome } {
    return { guidance: true, outcome: { kind: "result", text: capToolResultText(guidance) } };
  }

  // ── A2：情景快照组装 ────────────────────────────────

  /** 近期工作查询（文本组装；会话源缺席/失败时降级提示，不抛错）。 */
  private async queryRecentWork(args: Record<string, unknown>): Promise<string> {
    const rangeRaw = args["time_range"];
    const range: TimeRange =
      rangeRaw === "today" || rangeRaw === "yesterday" || rangeRaw === "last_week" || rangeRaw === "this_week"
        ? rangeRaw
        : "this_week";
    const project = typeof args["project"] === "string" && args["project"] !== "" ? args["project"] : undefined;
    const titleContains =
      typeof args["title_contains"] === "string" && args["title_contains"] !== "" ? args["title_contains"] : undefined;
    const win = timeRangeWindow(range, this.now());
    const inWindow = (iso: string): boolean => {
      const t = Date.parse(iso);
      return !Number.isNaN(t) && t >= win.sinceMs && t < win.untilMs;
    };
    const sessionLines: string[] = [];
    let sessionTotal = 0;
    let sessionTotalAll = 0; // 窗口内全部会话数（未过 title_contains）——「无记录」短路判据
    if (this.deps.sessions !== undefined) {
      try {
        const rowsAll = (await this.deps.sessions.listSessionMetadata()).filter((r) => inWindow(r.updatedAt));
        // 显示标题口径（与快照/会话页同语义）：显式标题列优先，旧行 NULL
        // 回落首条用户消息截断推导（repo 层注释的消费侧兑现——L1 投影修复批）。
        // displayTitle 单源（displayTitleOf——TR-207 三消费面共用）
        const displayTitle = (r: StewardSessionMetaRow): string => displayTitleOf(r);
        // title_contains 过滤在投影前（计数同口径：段头【会话·N】= 过滤后
        // 剩余数；大小写不敏感包含匹配，判据 = 显示标题）。
        const rows =
          titleContains === undefined
            ? rowsAll
            : rowsAll.filter((r) => displayTitle(r).toLowerCase().includes(titleContains.toLowerCase()));
        sessionTotal = rows.length;
        sessionTotalAll = rowsAll.length;
        for (const r of rows.slice(0, RECENT_WORK_LINES_MAX)) {
          const title = capChars(displayTitle(r), RECENT_WORK_TITLE_MAX_CHARS);
          const scale = r.entryCount === null ? "" : ` · 约${r.entryCount}条消息`;
          // sid 完整不截断（deliver_to_session 参数源——prompt 路由行承诺
          // 「结果含 sessionId」由本行兑现；截断的 id 不可复制即不可用）。
          sessionLines.push(`「${title}」(sid: ${r.sessionId}) ${fmtWhen(r.createdAt)}~${fmtWhen(r.updatedAt)}${scale}`);
        }
        if (rows.length > RECENT_WORK_LINES_MAX) {
          sessionLines.push(`…另有 ${rows.length - RECENT_WORK_LINES_MAX} 个会话未列出`);
        }
        // 未命中可区分：有会话但无一匹配关键词时明说（不落入「无记录」误导）。
        if (titleContains !== undefined && rows.length === 0 && rowsAll.length > 0) {
          sessionLines.push(`（${rowsAll.length} 个会话均不含关键词「${titleContains}」）`);
        }
      } catch (err) {
        this.deps.logger?.warn(`query_recent_work 会话读面失败：${(err as Error).message}`);
      }
    }
    const taskRows = this.deps.tasks
      .listTasks({})
      .filter(
        (t) =>
          inWindow((t as unknown as { createdAt?: string }).createdAt ?? "") &&
          (project === undefined || (t as unknown as { projects?: readonly string[] }).projects?.includes(project)),
      );
    const taskLines = taskRows.slice(0, RECENT_WORK_LINES_MAX).map((t) => {
      const meta = t as unknown as { type?: string; createdAt?: string };
      const tail = t.error !== null && t.error !== "" ? capChars(t.error, 40) : t.progress === null ? "" : `${t.progress.percent}%`;
      const type = meta.type ?? "task";
      return `[${type}] ${capChars(t.title, RECENT_WORK_TITLE_MAX_CHARS)}——${t.status}${tail !== "" ? `（${tail}）` : ""}`;
    });
    if (taskRows.length > RECENT_WORK_LINES_MAX) {
      taskLines.push(`…另有 ${taskRows.length - RECENT_WORK_LINES_MAX} 个任务未列出`);
    }
    if (sessionTotalAll === 0 && taskRows.length === 0) {
      return `${win.zhLabel}（${win.label}）范围内无记录——没有会话与任务活动`;
    }
    const parts: string[] = [`【会话·${sessionTotal}】`];
    parts.push(...(sessionLines.length > 0 ? sessionLines : ["（无）"]));
    parts.push(`【任务·${taskRows.length}${project !== undefined ? ` · 项目 ${project}` : ""}】`);
    parts.push(...(taskLines.length > 0 ? taskLines : ["（无）"]));
    return parts.join("\n");
  }

  /** 项目参数校验（create_session 的可选 project；undefined = 无参数直过）。 */
  private checkProjectArg(project: string | undefined): string | undefined {
    if (project === undefined || this.deps.projects === undefined) return undefined;
    if (this.deps.projects.resolve(project) === undefined) {
      return `项目 ${project} 不在当前 workspace——请与用户确认项目名`;
    }
    return undefined;
  }

  // ── 批A：kg_search / kg_get（项目知识只读检索） ─────────

  /** kg scope 解析（E-212 纪律：必填显式 + 服务端兜底打回；缺省 = 当前项目
   *  口径（memoryProject 同源：workspace 绑定根 + 一级目录扫描的单项目判定
   *  ——不另造口径）：单项目 workspace → 该项目（与显式 project 同一解析路
   *  径）；多项目/未绑定/未注入 → 聚合兑底（root 缺省 = kg 项目域聚合，适配
   *  器逐项目分块带【项目】头））：返回 projectRoot 或引导文案（打回/降级
   *  均不抛错，与 query_recent_work 降级姿态同族）。 */
  private resolveKgScope(projectArg: unknown): { root?: string } | { guide: string } {
    const kg = this.deps.kg;
    if (kg === undefined) {
      return { guide: "知识图谱读面不可用（daemon 装配缺 kg 源）——项目知识暂无法检索，可建议用户直接查看项目文档" };
    }
    const explicit = typeof projectArg === "string" && projectArg.trim() !== "" ? projectArg.trim() : undefined;
    // 缺省 = 当前项目口径（memoryProject 同源）：单项目 workspace 解析出项目
    // 名后与显式 project 走同一解析路径（同一次序/同一引导文案）；多项目/
    // 未绑定/未注入 → undefined 聚合兑底。
    const project = explicit ?? this.deps.memoryProject?.();
    if (project === undefined) {
      const roots = kg.kgProjects();
      if (roots.length === 0) {
        return {
          guide:
            "当前 workspace 尚无项目知识索引（.helix-kg/kg.db 缺席）——项目知识检索需先建索引；可引导用户到知识图谱页建立索引，或如实告知查不到",
        };
      }
      // 聚合域（root 缺省）：适配器逐项目分块带【项目】头（空命中项目省略，
      // 单 kg 项目域原样渲染）——不在此按 kg 域计数窄化伪装「当前项目」。
      return {};
    }
    // 显式 project（或缺省解析出的当前项目）：workspace-scan/scanProjects
    // 口径解析（deps.projects 同源）
    if (this.deps.projects === undefined) {
      const hit = kg.kgProjects().find((root) => root.split("/").pop() === project);
      return hit !== undefined ? { root: hit } : { guide: `项目 ${project} 不在当前知识域——请与用户确认项目名` };
    }
    const root = this.deps.projects.resolve(project);
    if (root === undefined) return { guide: `项目 ${project} 不在当前 workspace——请与用户确认项目名` };
    if (!this.deps.projects.hasIndex(root)) {
      return { guide: `项目 ${project} 尚未建知识索引（.helix-kg 缺席）——可建议用户先建索引后再问，或如实告知查不到` };
    }
    return { root };
  }

  /** kg_search 工具体（只读）：关键词 → digest+指针摘要行；体量过
   *  capToolResultText 护栏由注册面兜底。 */
  private async kgSearchOf(args: Record<string, unknown>): Promise<string> {
    const q = typeof args["q"] === "string" ? args["q"].trim() : "";
    if (q === "") return "参数缺失：q 必填（关键词——知识节点名/摘要子串匹配）";
    const scope = this.resolveKgScope(args["project"]);
    if ("guide" in scope) return scope.guide;
    try {
      return await this.deps.kg!.search(q, scope.root);
    } catch (err) {
      this.deps.logger?.warn(`kg_search 读面失败：${(err as Error).message}`);
      return `知识检索失败：${(err as Error).message}`;
    }
  }

  /** kg_get 工具体（只读）：节点全量；id 非法/查无节点 = 引导类（实现体
   *  中文引导原文兜底转文本——不抛错不炸轮）。 */
  private async kgGetOf(args: Record<string, unknown>): Promise<string> {
    const nodeId = typeof args["nodeId"] === "string" ? args["nodeId"].trim() : "";
    if (nodeId === "") return "参数缺失：nodeId 必填（取自 kg_search 返回行的「kg get <id>」指针）";
    const scope = this.resolveKgScope(args["project"]);
    if ("guide" in scope) return scope.guide;
    try {
      return await this.deps.kg!.get(nodeId, scope.root);
    } catch (err) {
      return (err as Error).message;
    }
  }

  // ── progress 批 M3：read_session（会话尾部内容深读）────────

  /** 尾部条数缺省与上限（LLM 面体量面：缺省 6 上限 20；单条全文透传——
   *  2026-10-11 用户裁决：深读体量靠 offset 翻页控制不靠单条截断，
   *  capToolResultText 4000 总护栏兑底）。 */
  private static readonly READ_SESSION_TAIL_DEFAULT = 6;
  private static readonly READ_SESSION_TAIL_MAX = 20;

  /** read_session 工具体：meta 行定位（displayTitle 单源）→ 尾窗投影 →
   *  文本组装；offset 翻页（跳过最近 N 条读更早）；双失败径（meta 缺/尾读
   *  undefined）统一引导回 query_recent_work。 */
  private async readSession(args: Record<string, unknown>): Promise<string> {
    const sessionId = typeof args["sessionId"] === "string" ? args["sessionId"] : "";
    if (sessionId === "") {
      return "参数缺失：sessionId 必填（可先用 query_recent_work 查询，结果含 sessionId）";
    }
    const tailRaw = typeof args["tail"] === "number" ? args["tail"] : StewardToolKit.READ_SESSION_TAIL_DEFAULT;
    const tail = Math.min(
      Number.isInteger(tailRaw) && tailRaw > 0 ? tailRaw : StewardToolKit.READ_SESSION_TAIL_DEFAULT,
      StewardToolKit.READ_SESSION_TAIL_MAX,
    );
    const offsetRaw = typeof args["offset"] === "number" ? args["offset"] : 0;
    const offset = Number.isInteger(offsetRaw) && offsetRaw > 0 ? offsetRaw : 0;
    if (this.deps.sessions === undefined) {
      return "会话读面不可用（daemon 装配缺 sessions 源）";
    }
    try {
      const meta = (await this.deps.sessions.listSessionMetadata()).find((r) => r.sessionId === sessionId);
      const tailRows = await this.deps.sessions.readSessionTail(sessionId, tail, {
        entryOffset: offset,
        maxEntryChars: Infinity,
      });
      if (meta === undefined || tailRows === undefined) {
        return `会话 ${sessionId} 不存在——请用 query_recent_work 查询近期会话拿正确的 sessionId（或与用户确认目标）`;
      }
      const lines = [
        `${tailRows.length === 0 ? "（本窗口无消息——offset 越界或会话暂无消息，可减小 offset 或直接看最近窗口）" : `本窗口 ${tailRows.length} 条消息（旧→新${offset > 0 ? `，跳过了最近 ${offset} 条` : ""}）：`}`,
      ];
      for (const e of tailRows) {
        lines.push(`[${e.role}] ${e.text}`);
      }
      return `会话「${capChars(displayTitleOf(meta), RECENT_WORK_TITLE_MAX_CHARS)}」(sid: ${sessionId})\n${lines.join("\n")}`;
    } catch (err) {
      this.deps.logger?.warn(`read_session 读面失败：${(err as Error).message}`);
      return `会话 ${sessionId} 读取失败：${(err as Error).message}`;
    }
  }

}
