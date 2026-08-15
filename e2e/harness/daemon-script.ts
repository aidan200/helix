/**
 * E 层 FakeLLM 剧本（TS3/TS4）—— Node 侧 fixture 与 Bun 侧 launcher 共享的
 * 纯数据契约（JSON 落盘，launcher 读取执行）。
 *
 * 对齐 apps/daemon/test/integration 的 makeFakeLLM / makeToolScriptedLLM 模式
 * （test-profile.test.ts / tools-loop.test.ts，M2 级 mock）：
 * - reply：纯文本剧本，可指定分片大小/间隔（制造可观测的流式窗口）；
 * - replyFromResult：基于真实工具结果续写（{last} = 最近一次 toolResult 文本，
 *   工具「执行与回注」为真——闭环成立的证明面）；
 * - tool：发起工具调用（真实执行走 CoreToolExecutor，tmp 沙箱 cwd）。
 *
 * 剧本随 daemon 进程重启从头消费（每个进程一份全新队列）。
 */

export interface ReplyTiming {
  /** 流式分片大小（字符）；>0 且 delayMs>0 才走逐段 delta 路径 */
  chunkSize?: number;
  /** 分片间隔 ms（制造流式窗口 / steer 可打入窗口） */
  chunkDelayMs?: number;
}

export type DaemonScriptEntry =
  | ({ kind: "reply"; text: string } & ReplyTiming)
  | ({ kind: "replyFromResult"; template: string } & ReplyTiming)
  | { kind: "tool"; toolName: string; args: Record<string, unknown> };

export interface DaemonScript {
  entries: DaemonScriptEntry[];
}

/** 便捷构造：慢速流式回复（默认分片，制造可断言的 streaming 窗口）。 */
export function slowReply(text: string, chunkDelayMs = 40, chunkSize = 8): DaemonScriptEntry {
  return { kind: "reply", text, chunkSize, chunkDelayMs };
}

/** 工具调用剧本条目。 */
export function toolCall(toolName: string, args: Record<string, unknown>): DaemonScriptEntry {
  return { kind: "tool", toolName, args };
}

/** 基于最近一次真实工具结果的续写（{last} 占位符替换）。 */
export function replyFromResult(template: string, timing: ReplyTiming = {}): DaemonScriptEntry {
  return { kind: "replyFromResult", template, ...timing };
}
