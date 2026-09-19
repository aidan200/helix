/**
 * StewardService —— V2.5 文本管家 application service（设计 §2 三分法 /
 * §5.2 权限分级 / §5.3 ①②层；文本形态架构验证——语音版 V3 直接套壳）。
 *
 * 三类能力（任务 brief 口径）：
 * ① 只读状态问答直达：LLM 循环（flash 级槽位独立配置）经 list_instances /
 *    list_tasks 只读工具取数 → answer 直答（决策收口 application 层，E-19
 *    handlers 只转发）；
 * ② 写注入唯一原语 = propose_send（agent_send 等价——AgentOrchestrationPort
 *    .send steer 注入通道）：**必须过确认闸**——LLM 只能提案（confirm_required
 *    回执携带 actionId + 全文），面板确认按钮 → confirm(actionId) 单次消费执行；
 *    未确认 = 零执行（§5.2 防火墙）；
 * ③ 事件 feed：agent 生命周期事件（wireEventFanout steward-feed-bridge 装配）
 *    → ①层粗筛（生命周期子集）→ ②层模板直出（中文文本行，不进 LLM——
 *    BroadcastService 先例同构）→ steward.feed 帧（仅已订阅连接，连接级闸门）。
 *
 * money gate（服务端权威）：steward.enabled ≠ "1" → ask 直接 error 判别，
 * 零 LLM 调用（RuntimeConfigPort KV 持久化，steward.set_config 写面）。
 *
 * 防自激循环（TR-169/TR-173 族纪律）：本服务订阅事件流只产出协议帧
 * （steward.feed——不 publish 领域事件），写注入只由离散用户动作（面板确认
 * 按钮）驱动——事件订阅面与写面无反馈边，结构上无环。
 *
 * 对话状态仅会话内（不持久化——任务范围钳制）：滚动窗口截尾，daemon 重启
 * 即清（与「不是第二个大脑」的上下文不分裂原则一致：只持全局状态摘要 +
 * 自身对话状态，工作上下文留在各 session/agent）。
 */
import type { DomainEvent } from "../../domain/events/DomainEvent";
import type {
  AgentCompletedPayload,
  AgentFailedPayload,
  AgentKilledPayload,
  AgentParkedPayload,
  AgentResumedPayload,
  AgentSpawnedPayload,
} from "../../domain/events/DomainEvent";
import type { StewardLlmPort, StewardLlmMessage, StewardLlmTool } from "../ports/outbound/StewardLlmPort";
import type { RuntimeConfigPort } from "../ports/outbound/RuntimeConfigPort";
import type { AgentOrchestrationPort } from "../ports/inbound/AgentOrchestrationPort";
import type {
  StewardAskResultPayload,
  StewardConfirmResultPayload,
  StewardFeedPayload,
} from "@helix/protocol";

/** feed ①层粗筛集合单源（agent 生命周期事件流子集；扩集合改此处 + 测试同步）。 */
export const STEWARD_FEED_EVENT_TYPES: ReadonlySet<string> = new Set([
  "agent.spawned",
  "agent.completed",
  "agent.failed",
  "agent.killed",
  "agent.parked",
  "agent.resumed",
]);

/** 工具轮上限（成本护栏：连环工具调用熔断——超限 error 判别，不无限循环）。 */
export const STEWARD_MAX_TOOL_ROUNDS = 6;

/** feed 文本行摘要截断上限（~80 字符——BroadcastService 先例同构）。 */
export const FEED_SUMMARY_MAX_CHARS = 80;

/** 会话内对话滚动窗口（条数；更早消息丢弃——防上下文无界增长）。 */
export const HISTORY_WINDOW = 24;

/** 管家开关 KV 键（RuntimeConfigPort；"1" = 开，其余 = 关——默认关）。 */
export const STEWARD_ENABLED_KEY = "steward.enabled";

/** 管家模型槽位 KV 键（"provider/model-id"；未设置 = adapter 默认 flash 级）。 */
export const STEWARD_MODEL_KEY = "steward.model";

/**
 * 系统提示词骨架（§2 三分法 + 拒绝清单——任务 brief 口径）。
 * 导出为常量供测试断言（prompt 骨架即行为契约的一部分）。
 */
export const STEWARD_SYSTEM_PROMPT = `你是 helix 的文本管家（Steward）——常驻的全局监控与对话助手，不是第二个有工作上下文的大脑。

职责三分法：
① 快问快答：全局状态问答（agent 实例清单/状态、任务清单与结果摘要）——先用工具取数，再直接回答。
② 递话：用户想向运行中的 agent 实例传达消息时——调用 propose_send 工具提案；系统会向用户请求确认（确认按钮），用户确认后才执行。每次只提案一条递话。
③ 拒绝越权：
- 不代答工作上下文问题（如「就按刚才聊的改」）——工作上下文留在各会话/agent，请建议用户把话递给持有该上下文的 agent（可提议 propose_send）。
- 不执行未过闸的写操作：唯一写原语 = propose_send，且必须等用户在面板确认后才执行。
- 不伪装用户身份、不代替用户做决策。

你只持有全局状态摘要与自身对话状态；回答用中文，简洁直答。`;

function truncateSummary(summary: string): string {
  if (summary.length <= FEED_SUMMARY_MAX_CHARS) return summary;
  return `${summary.slice(0, FEED_SUMMARY_MAX_CHARS)}…`;
}

/**
 * feed ②层模板直出（纯函数，测试单点）：生命周期六事件 → 中文文本行。
 * 非粗筛集合事件返回 undefined。
 */
export function buildFeedText(event: DomainEvent): string | undefined {
  switch (event.type) {
    case "agent.spawned": {
      const p = event.payload as AgentSpawnedPayload;
      return `${p.agentId} 已启动：${truncateSummary(p.task)}`;
    }
    case "agent.completed": {
      const p = event.payload as AgentCompletedPayload;
      return `${p.agentId} 已完成：${truncateSummary(p.closure.summary ?? "")}`;
    }
    case "agent.failed": {
      const p = event.payload as AgentFailedPayload;
      const reason = p.error !== undefined && p.error !== "" ? p.error : (p.closure.summary ?? "");
      return `${p.agentId} 失败：${truncateSummary(reason)}`;
    }
    case "agent.killed": {
      const p = event.payload as AgentKilledPayload;
      return `${p.agentId} 已终止：${truncateSummary(p.closure.summary ?? "")}`;
    }
    case "agent.parked": {
      const p = event.payload as AgentParkedPayload;
      return `${p.agentId} 已挂起（${p.reason === "user" ? "用户" : "任务暂停"}）`;
    }
    case "agent.resumed": {
      const p = event.payload as AgentResumedPayload;
      return `${p.agentId} 已恢复执行`;
    }
    default:
      return undefined;
  }
}

/** 任务清单读面窄接口（TaskQueryService.listTasks 注入）。 */
export interface StewardTasksSource {
  listTasks(filter: { status?: string }): readonly {
    jobId: string;
    title: string;
    status: string;
    progress: { stageName: string | null; batchesDone: number; batchesTotal: number; percent: number } | null;
    error: string | null;
  }[];
}

export interface StewardServiceDeps {
  readonly llm: StewardLlmPort;
  /** 编排面（status 只读 + send 写注入——agent_send 等价 steer 通道）。 */
  readonly orchestration: Pick<AgentOrchestrationPort, "status" | "send">;
  /** 任务清单只读面（TaskQueryService 注入）。 */
  readonly tasks: StewardTasksSource;
  /** 运行时配置 KV（开关 + 模型槽位持久化）。 */
  readonly config: RuntimeConfigPort;
  /** feed 闸门读面（EventStream 连接级 steward 订阅表窄接口）。 */
  readonly feedGate: { hasStewardSubscribers(): boolean };
  /** feed 帧出口（组合根接 EventStream.broadcastStewardFeed）。 */
  readonly emitFeed: (payload: StewardFeedPayload) => void;
  readonly logger?: { warn(message: string): void };
}

/** 待确认写动作（确认闸登记项；单次消费）。 */
interface PendingAction {
  readonly agentId: string;
  readonly message: string;
}

/** 工具声明（JSON Schema 面——flash 级模型的 function calling 契约）。 */
const TOOL_LIST_INSTANCES: StewardLlmTool = {
  name: "list_instances",
  description: "查询全部 agent 实例的状态清单（id、运行态、被指派任务、终态摘要）。",
  parameters: { type: "object", properties: {}, additionalProperties: false },
};

const TOOL_LIST_TASKS: StewardLlmTool = {
  name: "list_tasks",
  description: "查询任务清单（标题、状态、进度、错误）。",
  parameters: { type: "object", properties: {}, additionalProperties: false },
};

const TOOL_PROPOSE_SEND: StewardLlmTool = {
  name: "propose_send",
  description:
    "提案向运行中的 agent 实例递话（写操作——仅提案，系统会请求用户确认后才执行）。agentId 必须是当前运行中的实例。",
  parameters: {
    type: "object",
    properties: {
      agentId: { type: "string", description: "目标实例 id（如 agent-1；须运行中）" },
      message: { type: "string", description: "递话内容（将向用户全文展示以供确认）" },
    },
    required: ["agentId", "message"],
    additionalProperties: false,
  },
};

const STEWARD_TOOLS: readonly StewardLlmTool[] = [TOOL_LIST_INSTANCES, TOOL_LIST_TASKS, TOOL_PROPOSE_SEND];

export class StewardService {
  private readonly deps: StewardServiceDeps;
  /** 会话内对话滚动窗口（不持久化）。 */
  private history: StewardLlmMessage[] = [];
  /** 待确认写动作（actionId 单次消费）。 */
  private readonly pending = new Map<string, PendingAction>();
  private actionSeq = 0;
  private feedSeq = 0;

  constructor(deps: StewardServiceDeps) {
    this.deps = deps;
  }

  /**
   * 管家对话一轮（steward.ask 回执；可选 onDelta = 文本生成段增量回调，
   * V2.5 体验批——工具执行段静默不回调，终态以返回值为权威）。
   * money gate：开关关 → error 判别零 LLM 调用零 delta。
   */
  async ask(text: string, onDelta?: (chunk: string) => void): Promise<StewardAskResultPayload> {
    if (typeof text !== "string" || text.trim() === "") {
      return { status: "error", reason: "payload.text 应为非空 string" };
    }
    if (!this.isEnabled()) {
      return {
        status: "error",
        reason: "管家未开启：请在设置页 → 文本管家 区开启开关（开关关 = 零 LLM 调用）",
      };
    }
    this.pushHistory({ role: "user", text });
    for (let round = 0; round < STEWARD_MAX_TOOL_ROUNDS; round += 1) {
      let response;
      try {
        response = await this.deps.llm.complete(
          {
            systemPrompt: STEWARD_SYSTEM_PROMPT,
            messages: [...this.history],
            tools: STEWARD_TOOLS,
          },
          onDelta, // 文本生成段透传（工具轮 LLM 不产 text 增量 = 天然静默）
        );
      } catch (err) {
        this.deps.logger?.warn(`管家 LLM 调用失败：${(err as Error).message}`);
        return { status: "error", reason: `管家模型调用失败：${(err as Error).message}` };
      }
      if (response.kind === "text") {
        const answer = response.text.trim() === "" ? "（无回答）" : response.text;
        this.pushHistory({ role: "assistant", text: answer });
        return { status: "answer", text: answer };
      }
      // 工具轮：assistant 工具调用入史 + 执行只读面/过闸提案
      const outcome = await this.runTool(response.id, response.name, response.args);
      if (outcome !== undefined) return outcome;
    }
    return {
      status: "error",
      reason: `工具循环超限（>${STEWARD_MAX_TOOL_ROUNDS} 轮熔断）——请缩小问题范围或重试`,
    };
  }

  /** 确认闸放行（steward.confirm 回执）：单次消费 + 恰一次执行。 */
  async confirm(actionId: string): Promise<StewardConfirmResultPayload> {
    const action = this.pending.get(actionId);
    if (action === undefined) {
      return { status: "error", reason: `待确认动作不存在或已消费（actionId=${actionId}）` };
    }
    this.pending.delete(actionId); // 先消费（单次语义：执行失败也不可重放）
    const outcome = this.deps.orchestration.send(action.agentId, action.message);
    if (!outcome.delivered) {
      return { status: "error", reason: `递话未投递：${outcome.detail}` };
    }
    return { status: "ok", agentId: action.agentId, detail: outcome.detail };
  }

  /**
   * fanout 目标入口（wireEventFanout steward-feed-bridge 装配）：①层粗筛 +
   * 闸门 + ②层模板直出 + feed 帧。只产出协议帧，零领域事件发布（防自激）。
   */
  onDomainEvent(event: DomainEvent): void {
    if (!STEWARD_FEED_EVENT_TYPES.has(event.type)) return;
    if (!this.deps.feedGate.hasStewardSubscribers()) return; // 零订阅零推送
    const text = buildFeedText(event);
    if (text === undefined) return;
    const payload = event.payload as { agentId?: string };
    if (typeof payload.agentId !== "string" || payload.agentId === "") return;
    this.feedSeq += 1;
    this.deps.emitFeed({
      kind: event.type as StewardFeedPayload["kind"],
      agentId: payload.agentId,
      text,
      seq: this.feedSeq,
    });
  }

  /** 开关现态（money gate 读面）。 */
  isEnabled(): boolean {
    return this.deps.config.get(STEWARD_ENABLED_KEY) === "1";
  }

  /** 设置现态（steward.get_config / set_config 共用读面）。 */
  getConfig(): { enabled: boolean; model: string } {
    return {
      enabled: this.isEnabled(),
      model: this.deps.config.get(STEWARD_MODEL_KEY) ?? this.deps.llm.modelId,
    };
  }

  /** 设置写面（两槽位可选更新；model 格式校验 "provider/model-id"）。 */
  async setConfig(patch: { enabled?: boolean; model?: string }): Promise<{ ok: true } | { ok: false; error: string }> {
    if (patch.model !== undefined) {
      const model = patch.model.trim();
      if (model !== "" && !/^[^/\s]+\/[^/\s]+$/.test(model)) {
        return { ok: false, error: `模型格式非法：${model}（应为 "provider/model-id" 形态）` };
      }
      if (model !== "") await this.deps.config.set(STEWARD_MODEL_KEY, model);
    }
    if (patch.enabled !== undefined) {
      await this.deps.config.set(STEWARD_ENABLED_KEY, patch.enabled ? "1" : "0");
    }
    return { ok: true };
  }

  // ── 内部 ────────────────────────────────────────────────

  /** 执行单轮工具调用；返回非 undefined = 终止循环直出回执（提案/失败）。 */
  private async runTool(
    callId: string,
    name: string,
    args: Record<string, unknown>,
  ): Promise<StewardAskResultPayload | undefined> {
    if (name === "list_instances") {
      const rows = this.deps.orchestration.status().map((s) => ({
        agentId: s.agentId,
        state: s.state,
        displayState: s.displayState,
        task: s.task ?? null,
        summary: s.summary ?? null,
      }));
      this.pushHistory({ role: "assistant", toolCall: { id: callId, name, args } });
      this.pushHistory({ role: "toolResult", toolCallId: callId, name, text: JSON.stringify(rows) });
      return undefined;
    }
    if (name === "list_tasks") {
      const rows = this.deps.tasks.listTasks({}).map((t) => ({
        jobId: t.jobId,
        title: t.title,
        status: t.status,
        progress: t.progress === null ? null : `${t.progress.percent}%（${t.progress.batchesDone}/${t.progress.batchesTotal} 批次）`,
        error: t.error,
      }));
      this.pushHistory({ role: "assistant", toolCall: { id: callId, name, args } });
      this.pushHistory({ role: "toolResult", toolCallId: callId, name, text: JSON.stringify(rows) });
      return undefined;
    }
    if (name === "propose_send") {
      const agentId = typeof args.agentId === "string" ? args.agentId : "";
      const message = typeof args.message === "string" ? args.message : "";
      if (agentId === "" || message === "") {
        this.pushHistory({ role: "assistant", toolCall: { id: callId, name, args } });
        this.pushHistory({ role: "toolResult", toolCallId: callId, name, text: "参数缺失：agentId 与 message 必填" });
        return undefined;
      }
      // 提案校验：目标须存在且运行中（防火墙前置——终态实例递话必拒）
      const running = this.deps.orchestration.status(agentId).some((s) => s.state === "running");
      if (!running) {
        return { status: "error", reason: `实例 ${agentId} 不存在或非运行中——递话提案拒绝（可让用户确认实例 id）` };
      }
      this.actionSeq += 1;
      const actionId = `steward-action-${this.actionSeq}`;
      this.pending.set(actionId, { agentId, message });
      this.pushHistory({ role: "assistant", toolCall: { id: callId, name, args } });
      // 确认闸：不执行、不入工具结果（对话挂起待用户裁决——confirm 后用户可继续新 ask）
      return { status: "confirm_required", actionId, agentId, message };
    }
    // 未知工具（wire 防御）：toolResult 报错回灌，循环继续（模型可自纠）
    this.pushHistory({ role: "assistant", toolCall: { id: callId, name, args } });
    this.pushHistory({ role: "toolResult", toolCallId: callId, name, text: `未知工具 ${name}` });
    return undefined;
  }

  /** 对话历史滚动窗口维护（截尾保窗）。 */
  private pushHistory(message: StewardLlmMessage): void {
    this.history.push(message);
    if (this.history.length > HISTORY_WINDOW) {
      this.history = this.history.slice(-HISTORY_WINDOW);
    }
  }
}
