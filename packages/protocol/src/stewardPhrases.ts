/**
 * stewardPhrases —— 管家停止词表单源（DDD 重构批 3b：跨端词表单源化，TR-157 先例）。
 *
 * 背景：批 3b 前双端词表已漂移——daemon 路由表 7 词（含住嘴/stop，无「不用
 * 说了」）vs shell 意图窗 6 词（含「不用说了」，无住嘴/stop）；每词表扩充
 * 要双端手工同步（漏改即行为分叉）。
 *
 * 裁决定格（设计文档 §7 裁决 #1 乙 + #2）：
 * - **语音停止词全部全停**（说出口的停止表达 = abort 当前轮 + 清空 daemon
 *   队列）；轻停只留面板停止钮/静音钮；
 * - 批 3b 词表扩充（用户过目定案）：+先别说了/不要说了/别念了/别说话了/
 *   够了/停一下；「好了好了/等一下/等等」不收（日常歧义大，误触发更烦）；
 * - 停止词表是「插话不排队」语义下停止的唯一入口（词表外自然表达当环境音
 *   丢弃——裁决 #2），覆盖要够但收录标准仍是独立成句、语义无歧义。
 *
 * 归一口径：trim + 尾部标点剥除（语音转写常带句读；中部不改）——daemon
 * normalizePhrase 与 shell stripTailPunct 同构收编。
 */

/** 管家全停词表（14 词——daemon 路由/ask 停止 + shell barge-in 意图窗双端同源）。 */
export const STEWARD_STOP_PHRASES: readonly string[] = [
  // 停字族
  "停",
  "停下",
  "停止",
  "停一下",
  "stop",
  // 别字族
  "别说了",
  "先别说了",
  "不要说了",
  "不用说了",
  "别念了",
  "别说话了",
  // 强语气族
  "闭嘴",
  "住嘴",
  "够了",
];

/** 停止词归一（trim + 尾部标点剥除；中部不改）。 */
export function normalizeStewardPhrase(text: string): string {
  return text.trim().replace(/[。．.!！?？?，,、；;～~\s]+$/u, "");
}

/** 停止词判定（全等归一匹配；零 LLM 纯函数）。 */
export function matchStewardStopPhrase(text: string): boolean {
  return STEWARD_STOP_PHRASES.includes(normalizeStewardPhrase(text));
}

// ── 确认/取消词族单源（闸门对应修复批）：批 3b 只单源了停止词表，确认/取消
// 双端各自维护且不对等（shell 卡栈口令 1+1 词 vs daemon 漏斗 8+3 词）——同义
// 口语应答词（「好的」vs「确认」）走不同闸门出不同回应，对应关系错乱。单源
// 化后：daemon 漏斗路由与 shell 卡栈口令消费同一词族（各自语义层不变）；
// alias 消费规则（无卡时当聊天透传）归 shell 口令面 voice-command.ts。

/** 确认类口语词族（命中 = 确认意图；daemon 路由绑定最近 pending 卡，shell
 *  口令面有卡时绑定栈顶卡）。 */
export const STEWARD_CONFIRM_PHRASES: readonly string[] = [
  "确认",
  "确认执行",
  "执行",
  "执行吧",
  "做吧",
  "好的",
  "行",
  "可以",
];

/** 取消类口语词族（命中 = 放弃意图；语义同上分端消费）。 */
export const STEWARD_CANCEL_PHRASES: readonly string[] = ["取消", "不要了", "放弃"];

/** 全取消类口语词族（shell 卡栈专用：一次撤销全部 awaiting 卡；daemon 漏斗
 *  不消费——daemon 无卡栈编号语义）。 */
export const STEWARD_CANCEL_ALL_PHRASES: readonly string[] = ["全部取消", "都不要了", "全都不要了"];

/** 确认词族判定（全等归一匹配；零 LLM 纯函数）。 */
export function matchStewardConfirmPhrase(text: string): boolean {
  return STEWARD_CONFIRM_PHRASES.includes(normalizeStewardPhrase(text));
}

/** 取消词族判定（全等归一匹配；零 LLM 纯函数）。 */
export function matchStewardCancelPhrase(text: string): boolean {
  return STEWARD_CANCEL_PHRASES.includes(normalizeStewardPhrase(text));
}

/** 全取消词族判定（全等归一匹配；零 LLM 纯函数）。 */
export function matchStewardCancelAllPhrase(text: string): boolean {
  return STEWARD_CANCEL_ALL_PHRASES.includes(normalizeStewardPhrase(text));
}
