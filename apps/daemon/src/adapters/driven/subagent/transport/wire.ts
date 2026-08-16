import type { AgentEngineEvent } from "../../../../application/ports/outbound/AgentEnginePort";
import type { InstanceClosurePayload } from "../../../../domain/events/DomainEvent";

/**
 * SubAgent 子进程 stdio JSON 线协议（O-7 候选 A 形态，v1 StdioJsonRpcTransport
 * 同构最小集）。逐行 JSON（`\n` 分帧），双向各一条流：
 *
 * - 子 → 父（stdout）：started（含 pid + 透传 model 回显，F-14 深度相等断言点）
 *   / event（引擎事件逐条上行，AgentEngineEvent 形状）/ closure（五字段收口）
 *   / crash（子进程异常说明）/ log（诊断行，非致命）。
 * - 父 → 子（stdin）：send（steer 注入消息，AD-7⑤）。
 *
 * kill 不走 JSON 消息——父侧直接发 OS 信号（O-6 序列：SIGTERM 进程组 →
 * grace 超时 SIGKILL 进程组），见 ChildProcessTransport。
 */

/** 子进程 → 父进程的 stdout 行。 */
export type ChildOutboundLine =
  | { readonly type: "started"; readonly instanceId: string; readonly pid: number; readonly model: unknown }
  | { readonly type: "event"; readonly instanceId: string; readonly event: AgentEngineEvent }
  | { readonly type: "closure"; readonly instanceId: string; readonly closure: InstanceClosurePayload }
  | { readonly type: "crash"; readonly instanceId: string; readonly error: string }
  | { readonly type: "log"; readonly instanceId: string; readonly text: string };

/** 父进程 → 子进程的 stdin 行（当前仅 send——steer 注入）。 */
export interface SendLine {
  readonly type: "send";
  readonly text: string;
}

/** 行编码（JSON + 换行分帧）。 */
export function encodeLine<T>(obj: T): string {
  return JSON.stringify(obj) + "\n";
}

/** 子 → 父行解码：非 JSON / 缺 type 字段 → undefined（调用方按 log 丢弃）。 */
export function parseChildLine(raw: string): ChildOutboundLine | undefined {
  try {
    const parsed = JSON.parse(raw) as { type?: unknown };
    if (typeof parsed?.type === "string") return parsed as ChildOutboundLine;
  } catch {
    /* 非法行按 undefined 处理 */
  }
  return undefined;
}

/** 父 → 子 send 行解码：非 send 形状 → undefined（子进程按 log 忽略）。 */
export function parseSendLine(raw: string): SendLine | undefined {
  try {
    const parsed = JSON.parse(raw) as { type?: unknown; text?: unknown };
    if (parsed?.type === "send" && typeof parsed.text === "string") {
      return { type: "send", text: parsed.text };
    }
  } catch {
    /* 非法行按 undefined 处理 */
  }
  return undefined;
}
