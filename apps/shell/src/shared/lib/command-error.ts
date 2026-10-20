/**
 * daemon commandError 消息尾缀归因单源（TR-145 契约 / TR-84 尾缀过滤）。
 *
 * daemon `WsServerAdapter.commandError` 是「（命令 <type>）」尾缀的**单一构造点**；
 * shell 侧多处按该尾缀做跨命令归因（只消费本写面/本页族的错误帧，他命令拒绝
 * 不误收口）。此解析面曾以字面正则散落十来处拷贝——daemon 改尾缀格式/语言时
 * 必须同步全部拷贝且无编译期信号。收敛到本文件单点后，同步面只剩这一处
 * （daemon 侧构造点的在场断言见 command-error.test.ts 的跨包契约钉子）。
 *
 * 无尾缀（旧 daemon）→ undefined：调用方按既有容忍策略处理（宁误交代不静默）。
 */
const COMMAND_TAIL = /\uFF08\u547D\u4EE4 ([\w.]+)\uFF09\s*$/;

/** 从 connection.error 人读 message 提取命令 type（无尾缀 → undefined）。 */
export function commandOfConnectionError(message: string): string | undefined {
  return COMMAND_TAIL.exec(message)?.[1];
}
