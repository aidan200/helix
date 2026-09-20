/**
 * ToolRegistry —— loop 域工具注册表（helix-loop L0 批；设计 §5：
 * 「loop 只管编排，执行委派注册表」——CoreToolExecutor E-46 精神的 domain 面）。
 *
 * 注册与分发同域；注册面与声明面分离：
 * - register：name → handler + schema 投影（LLM function calling 面）；
 * - hidden 工具（如 steward_confirm——面板触发执行原语，非 LLM 可见）注册
 *   进注册表但不进 llmTools() 投影（E-46「注册面恒宽、声明面管控谁可见」
 *   的 W-R6 同构）；
 * - dispatch：按名执行 → LoopToolOutcome 归一（异常转 isError result 不抛出
 *   ——调用方决定记录与回注）。
 */
import type { LoopToolHandler, LoopToolSchema } from "./LoopTypes";

export interface LoopToolRegistration {
  /** 工具名（LLM function calling 名）。 */
  readonly name: string;
  readonly description: string;
  readonly parameters: Record<string, unknown>;
  readonly handler: LoopToolHandler;
  /** true = 不进 LLM 工具投影（面板/外部触发执行原语——注册面恒宽、
   *  声明面管控谁可见，W-R6 同构）。 */
  readonly hiddenFromLlm?: boolean;
}

/** 未知工具的归一结果（wire 防御——模型可自纠）。 */
export interface LoopDispatchFailure {
  readonly ok: false;
  readonly reason: "unknown";
  readonly available: readonly string[];
}

export interface LoopDispatchSuccess {
  readonly ok: true;
  readonly outcome: Awaited<ReturnType<LoopToolHandler>>;
}

export class ToolRegistry {
  private readonly tools = new Map<string, LoopToolRegistration>();

  /** 注册（后注册者胜——CoreToolExecutor F-20「内置无特权」同口径）。 */
  register(tool: LoopToolRegistration): void {
    this.tools.set(tool.name, tool);
  }

  /** LLM 工具面投影（hidden 排除；注册序稳定）。 */
  llmTools(): readonly LoopToolSchema[] {
    const out: LoopToolSchema[] = [];
    for (const tool of this.tools.values()) {
      if (tool.hiddenFromLlm === true) continue;
      out.push({ name: tool.name, description: tool.description, parameters: tool.parameters });
    }
    return out;
  }

  /** 注册名全集（含 hidden——dispatch 可达面）。 */
  names(): readonly string[] {
    return [...this.tools.keys()];
  }

  /** 按名执行（异常归一 isError result 不抛；未知工具 → unknown 判别）。 */
  async dispatch(
    name: string,
    args: Record<string, unknown>,
    context: Parameters<LoopToolHandler>[1],
  ): Promise<LoopDispatchSuccess | LoopDispatchFailure> {
    const tool = this.tools.get(name);
    if (tool === undefined) {
      return { ok: false, reason: "unknown", available: this.names() };
    }
    try {
      const outcome = await tool.handler(args, context);
      return { ok: true, outcome };
    } catch (err) {
      return {
        ok: true,
        outcome: { kind: "result", text: `工具执行异常：${(err as Error).message}`, isError: true },
      };
    }
  }
}
