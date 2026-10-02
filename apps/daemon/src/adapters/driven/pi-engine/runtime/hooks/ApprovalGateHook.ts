import type { BeforeToolCallContext, BeforeToolCallResult } from "@earendil-works/pi-agent-core";
import type { HookSet } from "../HookSet";

/**
 * ApprovalGateHook —— pi 通道审批闸（暂停四态 POC 落地批）。
 *
 * 机制（POC 15/15 验证，temp/pi-loop-pause-poc）：beforeToolCall 阻塞闸
 * ——命中策略的工具调用挂起（Promise 未决即挂起工具执行，loop 无超时），
 * 经 onPaused 发射暂停凭据，等 resume() 提交决策；abort signal 经
 * raceAbort 唤醒（pi 设计内路径：agent-loop 钩子返回后立即检查
 * signal.aborted → "Operation aborted" 工具结果，不挂死）。
 *
 * 四态能力面（EngineResumeDecision ↔ pi BeforeToolCallResult）：
 * - approve  → 返回 undefined（放行执行）；
 * - reject   → 返回 { block, reason }（拒绝文案成为错误工具回执，模型知情）；
 * - approveWith / resolve → **pi 能力面外**（BeforeToolCallResult 仅
 *   block/reason/terminate，无参数改写与结果伪造钩子）——映射点显式报错，
 *   不静默降级（loop 通道原生支持这两态；通道能力差异经此暴露，不藏）。
 *
 * 挂闸期 steer 语义：pi 原生队列只入队，turn 边界 drain（POC S4 验证）——
 * 本钩子无需额外处理。
 */
export interface ApprovalGatePausedInfo {
  /** 暂停凭据（resume 面入参——一次性）。 */
  readonly pauseToken: string;
  readonly toolCallId: string;
  readonly toolName: string;
  /** 挂闸调用参数 JSON 摘要（审批提示展示面，截断 200 字符）。 */
  readonly argsSummary: string;
  /** 挂闸调用原始参数（审批闸接线批：桥提取 command/reason 发卡片）。 */
  readonly args: unknown;
}

/** 钩子层决策（适配器层 EngineResumeDecision → 此处的映射产物）。 */
export type ApprovalGateDecision = { readonly kind: "approve" } | { readonly kind: "reject"; readonly text: string };

export interface ApprovalGateDeps {
  /** 挂闸策略：返回 true 的工具调用挂闸（逐调用询问，可按 args 细化）。 */
  readonly shouldGate: (toolName: string, args: unknown) => boolean;
  /** 挂闸通知（发射 engine_paused 的面——适配器注入 listener 转发）。 */
  readonly onPaused: (info: ApprovalGatePausedInfo) => void;
  /** token 生成器（缺省 crypto.randomUUID；测试注入确定性序号）。 */
  readonly generateToken?: () => string;
}

/** 参数摘要：JSON 截断 200 字符（展示面，不追求完整）。 */
function summarizeArgs(args: unknown): string {
  try {
    const json = JSON.stringify(args) ?? "null";
    return json.length > 200 ? `${json.slice(0, 200)}…` : json;
  } catch {
    return "(unserializable args)";
  }
}

const ABORTED = Symbol("approval-gate-aborted");

/** raceAbort：决策 promise 与 abort signal 竞速（POC 同款——永不挂死）。 */
function raceAbort<T>(decision: Promise<T>, signal?: AbortSignal): Promise<T | typeof ABORTED> {
  if (signal === undefined) return decision;
  return new Promise<T | typeof ABORTED>((resolve) => {
    const onAbort = () => resolve(ABORTED);
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener("abort", onAbort, { once: true });
    decision.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      () => {
        signal.removeEventListener("abort", onAbort);
        resolve(ABORTED); // 决策异常面防御：按唤醒处理交 loop 收口
      },
    );
  });
}

export class ApprovalGateHook implements HookSet {
  static readonly hookName = "approval-gate";

  get name(): string {
    return ApprovalGateHook.hookName;
  }

  private readonly deps: ApprovalGateDeps;
  /** 挂闸凭据 → 决策 resolver（挂起面——abort 唤醒即清理）。 */
  private readonly pending = new Map<string, (decision: ApprovalGateDecision) => void>();

  constructor(deps: ApprovalGateDeps) {
    this.deps = deps;
  }

  async beforeToolCall(
    context: BeforeToolCallContext,
    signal?: AbortSignal,
  ): Promise<BeforeToolCallResult | undefined> {
    const toolName = context.toolCall.name;
    if (!this.deps.shouldGate(toolName, context.args)) return undefined; // 直通：零开销
    const pauseToken = this.deps.generateToken ? this.deps.generateToken() : crypto.randomUUID();
    const decision = new Promise<ApprovalGateDecision>((resolve) => this.pending.set(pauseToken, resolve));
    this.deps.onPaused({
      pauseToken,
      toolCallId: context.toolCall.id,
      toolName,
      argsSummary: summarizeArgs(context.args),
      args: context.args,
    });
    const outcome = await raceAbort(decision, signal);
    this.pending.delete(pauseToken); // 任意出口清理（决策/abort 同面）
    if (outcome === ABORTED) {
      // POC S3：返回 undefined → loop 检查 signal.aborted 产出 "Operation aborted"
      // 工具结果（pi 设计内路径）；闸内不留残留状态，同 token 再 resume 即 unknown。
      return undefined;
    }
    if (outcome.kind === "approve") return undefined;
    return { block: true, reason: outcome.text };
  }

  /** 挂闸凭据提交决策（适配器 resume 面 → 此处；契约防御：非 approve/reject 形态拒绝）。 */
  resume(pauseToken: string, decision: ApprovalGateDecision): void {
    const resolve = this.pending.get(pauseToken);
    if (resolve === undefined) {
      throw new Error(`审批闸未知 pauseToken：${pauseToken}（已过期或伪造——run 中止/已裁决的凭据不可复用）`);
    }
    if (decision.kind !== "approve" && decision.kind !== "reject") {
      throw new Error(`审批闸不接受决策形态 ${String((decision as { kind?: string }).kind)}（钩子契约仅 approve/reject）`);
    }
    resolve(decision);
  }
}
