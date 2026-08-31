/**
 * park/resume 挂起协议纯数据面（设计稿 park-resume-design.md §2.2/§2.3，
 * ⑤ park/resume 批）。
 *
 * 协作式双保险的第一层：park = 经既有 steer 通道（stdin send 行）注入带
 * 协议标记的挂起指令，指令文本自带行为说明（完成当前工具调用后停止新动作、
 * 输出 PARK 标记结束本轮）；子进程 runtime 检测 assistant 文本中的
 * `<<<PARK {...} PARK>>>` 块 → 挂起等待 → 经 wire parked 行上报 → 等 RESUME
 * 注入 → 同一会话继续。第二层硬拦截见 child/ParkGuardHooks（beforeToolCall
 * 链——R12 预留位首个实例）。
 *
 * 指令判别约定：指令文本以不可误认的行首标记开头（[HELIX-PARK]/[HELIX-RESUME]），
 * 普通 steer 文本（含 LLM 输出中偶然出现的 PARK 字样）不以该标记开头即不判别。
 */

/** PARK 指令标记（stdin 行判别输入；调度器注入文本的行首固定前缀）。 */
export const PARK_INSTRUCTION_MARKER = "[HELIX-PARK]";

/** RESUME 指令标记（同上）。 */
export const RESUME_INSTRUCTION_MARKER = "[HELIX-RESUME]";

/**
 * 挂起指令文本（SchedulerService.park 经 runner.send 注入；行为说明自带）：
 * 完成当前工具调用后停止新动作，输出 PARK 标记结束本轮（progress/next 摘要
 * 写进对话历史——resume 时实例自己知道从哪继续，也是给人看的）。
 */
export const PARK_INSTRUCTION_TEXT =
  `${PARK_INSTRUCTION_MARKER} 系统挂起指令：请立即停止规划新动作。完成当前正在执行的工具调用后，` +
  `输出以下挂起标记并结束本轮（不要再调用任何工具、不要输出 closure 块）：\n` +
  "<<<PARK\n" +
  '{"progress":"当前进展一句话","next":"恢复后第一步要做什么"}\n' +
  "PARK>>>\n" +
  "输出该标记后你将进入挂起状态（会话保留、零消耗），直到收到恢复指令。";

/**
 * 恢复指令文本（SchedulerService.resume 经 runner.send 注入；steer 进对话
 * 队列——resume 驱动的新 run 以它为首条 user 消息，暂存消息随后一并 drain）。
 */
export const RESUME_INSTRUCTION_TEXT =
  `${RESUME_INSTRUCTION_MARKER} 系统恢复指令：会话已恢复，请从挂起点继续执行任务` +
  "（上一条 PARK 摘要即断点：按其中的 next 继续；如随后还有暂存消息一并遵照执行）。";

/** PARK 标记块解析结果（progress/next 一句话摘要；缺字段容错归一空串）。 */
export interface ParsedParkSummary {
  readonly progress: string;
  readonly next: string;
}

/**
 * 从 assistant 文本解析 `<<<PARK {...} PARK>>>` 块。
 * 无块 / 非 JSON 对象 → undefined（调用方按「未按协议挂起」处理——继续
 * 既有收口路径）；progress/next 非字符串或缺省 → 空串容错（摘要供人看，
 * 不因 LLM 措辞缺字段判协议失败）。
 */
export function parseParkBlock(text: string): ParsedParkSummary | undefined {
  const match = text.match(/<<<PARK\s*([\s\S]*?)\s*PARK>>>/);
  if (!match) return undefined;
  try {
    const raw = JSON.parse(match[1]!) as { progress?: unknown; next?: unknown };
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;
    return {
      progress: typeof raw.progress === "string" ? raw.progress : "",
      next: typeof raw.next === "string" ? raw.next : "",
    };
  } catch {
    return undefined;
  }
}

/** 文本是否挂起指令（stdin 行判别：行首标记前缀）。 */
export function isParkInstruction(text: string): boolean {
  return text.trimStart().startsWith(PARK_INSTRUCTION_MARKER);
}

/** 文本是否恢复指令（同上；挂起等待循环的唤醒输入）。 */
export function isResumeInstruction(text: string): boolean {
  return text.trimStart().startsWith(RESUME_INSTRUCTION_MARKER);
}
