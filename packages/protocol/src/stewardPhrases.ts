/**
 * stewardPhrases —— 管家口令词族单源（跨端词表单源化，TR-157 先例）。
 *
 * **停止词族已整体退役**（Jev 停止意图判官单轨批）：停止判定单源全走判官
 * （零生成 token 分类判定），不再有停止词表——「停/别说了」类纯停止文本与
 * 自然停止表达统一经判官语义判定（daemon StewardIntentJudge 唯一判定面）。
 *
 * 保留面 = 确认/取消词族（卡栈口令用，与打断链正交，裁决明确保留）：
 * 裁决定格（设计文档 §7 裁决 #1 乙 + #2）：
 * - 确认/取消词族 daemon 漏斗路由与 shell 卡栈口令消费同一词族（各自语义层
 *   不变）；alias 消费规则（无卡时当聊天透传）归 shell 口令面 voice-command.ts；
 * - 归一口径：trim + 尾部标点剥除（语音转写常带句读；中部不改）——daemon
 *   normalizePhrase 与 shell stripTailPunct 同构收编。
 */

/** 口令词归一（trim + 尾部标点剥除；中部不改）——确认/取消/全取消词族匹配
 *  共用（停止词族已退役，本函数不再服务停止判定）。 */
export function normalizeStewardPhrase(text: string): string {
  return text.trim().replace(/[。．.!！?？，,、；;～~\s]+$/u, "");
}

// ── 确认/取消词族单源（闸门对应修复批）：双端同义口语应答词（「好的」vs
// 「确认」）走同一闸门出同一回应。单源化后：daemon 漏斗路由与 shell 卡栈
// 口令消费同一词族（各自语义层不变）。

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
