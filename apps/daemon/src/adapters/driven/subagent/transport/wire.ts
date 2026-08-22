import type { AgentEngineEvent } from "../../../../application/ports/outbound/AgentEnginePort";
import type { InstanceClosurePayload } from "../../../../domain/events/DomainEvent";

/**
 * SubAgent 子进程 stdio JSON 线协议（O-7 候选 A 形态，v1 StdioJsonRpcTransport
 * 同构最小集）。逐行 JSON（`\n` 分帧），双向各一条流：
 *
 * - 子 → 父（stdout）：started（含 pid + 透传 model 回显， 深度相等断言点）
 *   / event（引擎事件逐条上行，AgentEngineEvent 形状）/ closure（五字段收口）
 *   / crash（子进程异常说明）/ log（诊断行，非致命）
 *   / tool-req（H-3：RemoteBrowserPort 转发请求——方法名 + 位置参数数组，
 *   全 JSON 可序列化；白名单 12 个 browser 工具可达方法，管理面 4 方法不上线）。
 * - 父 → 子（stdin）：send（steer 注入消息，AD-7⑤）
 *   / tool-res（H-3：tool-req 回执，reqId 关联；ok 判别字段 value/error 互斥）。
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
  | { readonly type: "log"; readonly instanceId: string; readonly text: string }
  | {
      readonly type: "tool-req";
      readonly instanceId: string;
      readonly reqId: number;
      readonly method: string;
      readonly args: readonly unknown[];
    };

/** 父进程 → 子进程的 stdin 行（send = steer 注入）。 */
export interface SendLine {
  readonly type: "send";
  readonly text: string;
}

/** 父进程 → 子进程的 tool-req 回执（reqId 关联；ok:true 携 value，ok:false 携 error 文案）。 */
export type ToolResponseLine =
  | { readonly type: "tool-res"; readonly reqId: number; readonly ok: true; readonly value: unknown }
  | { readonly type: "tool-res"; readonly reqId: number; readonly ok: false; readonly error: string };

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

/**
 * 父 → 子行解码（原 parseSendLine 泛化，H-3）：send / tool-res 两型；
 * 非 JSON / 未知 type / 形状非法 → undefined（子进程按 log 忽略）。
 */
export function parseParentLine(raw: string): SendLine | ToolResponseLine | undefined {
  try {
    const parsed = JSON.parse(raw) as { type?: unknown; text?: unknown; reqId?: unknown; ok?: unknown; error?: unknown };
    if (parsed?.type === "send" && typeof parsed.text === "string") {
      return { type: "send", text: parsed.text };
    }
    if (parsed?.type === "tool-res" && typeof parsed.reqId === "number") {
      if (parsed.ok === true) return parsed as unknown as ToolResponseLine;
      if (parsed.ok === false && typeof parsed.error === "string") return parsed as unknown as ToolResponseLine;
    }
  } catch {
    /* 非法行按 undefined 处理 */
  }
  return undefined;
}

/** tool-res 出口截断默认上限（行 JSON 无流控——eval 大返回值保护，可注入）。 */
export const TOOL_RESULT_MAX_BYTES = 256 * 1024;

/**
 * daemon handler 出口 result 截断：JSON 序列化超 maxBytes → 字节严格封顶的
 * 截断字符串 + 标记尾（多字节字符截断处可能出现替换符，保护性语义不影响
 * 工具续作）；上限内原样透传。undefined 归一 null（tool-res value 显式化）。
 */
export function truncateToolResult(value: unknown, maxBytes: number = TOOL_RESULT_MAX_BYTES): unknown {
  if (value === undefined) return null;
  const json = JSON.stringify(value);
  const bytes = Buffer.byteLength(json, "utf8");
  if (bytes <= maxBytes) return value;
  const cut = Buffer.from(json, "utf8").subarray(0, maxBytes).toString("utf8");
  return `${cut}…[截断：原始 ${bytes} 字节超 ${maxBytes} 上限]`;
}
