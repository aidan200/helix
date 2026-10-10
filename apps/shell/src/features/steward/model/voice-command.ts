/**
 * voice-command —— 管家语音口令纯函数面（B2 全局语音批，D3=b；设计稿
 * docs/temp/helix-steward-global-redesign.md §3.4 语音口令）。
 *
 * 零新协议帧：前端本地解析 final 转写整句，调既有 steward.confirm /
 * steward.cancel（经 useStewardActions）。两段纯函数（AG-14 零 React 零 IO）：
 * - parseVoiceCommand：整句成句判据（trim + 尾句读容忍后**全等**口令形态）——
 *   聊天句中夹带的「确认」二字不触发（防误触主闸）；不设「全部确认」（写
 *   操作授权禁语音批量放行，批量走鼠标）；编号 1-99（阿拉伯/中文数字）；
 * - resolveVoiceCommand：口令 → 整句定稿时卡栈快照裁决（绑定时刻 = 说话
 *   那一刻的卡栈）：栈顶指认取 awaiting 态 seq 最大卡（accepted/done 自动
 *   跳过——不可能被二次确认）；编号指认过期/不存在 → notFound（彼时无此
 *   卡）；全部取消一次撤销全部 awaiting 卡。
 *
 * 回读文案归消费端（i18n），本面只返回结构化结果。
 */

import {
  matchStewardStopPhrase,
  matchStewardConfirmPhrase,
  matchStewardCancelPhrase,
  matchStewardCancelAllPhrase,
  normalizeStewardPhrase,
} from "@helix/protocol";

/** 卡栈快照（useStewardActions StewardActionCard 的裁决投影）。 */
export interface VoiceCardSnapshot {
  readonly actionId: string;
  readonly agentId: string;
  /** 到手编号（1 起单调，永不重排）。 */
  readonly seq: number;
  readonly state: "awaiting" | "accepted" | "done";
  /** 卡种（memory 通知卡无 daemon 侧 pending——口令裁决不可指认/取消）。 */
  readonly kind?: "action" | "memory";
}

/** 口令形态（解析产物；kind 与回读动作一一对应）。alias = 口语应答词命中
 *  （protocol 单源词族——好的/行/可以/不要了/都不要了等，闸门对应修复批）：
 *  有待确认卡时当口令消费（与 daemon 漏斗同源词族同径），无卡时由消费方
 *  （Layer dispatchAfterGate）按聊天句透传——口语词不是显式命令，无卡不当
 *  「没有待确认的卡片」误报（显式口令「确认/取消/全部取消」仍是 strict，
 *  无卡照旧明示）。 */
export type VoiceCommand = { readonly alias?: boolean } & (
  | { readonly kind: "confirm"; readonly target: "top" }
  | { readonly kind: "cancel"; readonly target: "top" }
  | { readonly kind: "confirm"; readonly target: { readonly seq: number } }
  | { readonly kind: "cancel"; readonly target: { readonly seq: number } }
  | { readonly kind: "cancelAll" }
);

/** 口令裁决的动作对象（快照投影——state 对消费端无义，剥离）。 */
export interface VoiceCardTarget {
  readonly actionId: string;
  readonly agentId: string;
  readonly seq: number;
}

/** 口令裁决结果：targets = 待执行动作对象（空即零动作）；reason 驱动回读文案。 */
export type VoiceCommandResult =
  | { readonly kind: "confirm" | "cancel"; readonly targets: readonly [VoiceCardTarget] }
  | { readonly kind: "cancelAll"; readonly targets: readonly VoiceCardTarget[] }
  | { readonly kind: "none"; readonly reason: "noCards" | "notFound" | "settled"; readonly seq?: number };

/** 中文数字 1-99 解析（一~九十九；不匹配返回 null）。 */
function parseCnNumber(s: string): number | null {
  const digits: Record<string, number> = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
  if (s === "十") return 10;
  const tenAt = s.indexOf("十");
  if (tenAt === -1) {
    if (s.length !== 1) return null;
    return digits[s] ?? null;
  }
  const head = s.slice(0, tenAt);
  const tail = s.slice(tenAt + "十".length);
  const tens = head === "" ? 1 : digits[head];
  if (tens === undefined) return null;
  if (tail === "") return tens * 10;
  const ones = digits[tail];
  if (ones === undefined || tail.length !== 1) return null;
  return tens * 10 + ones;
}

/** 编号段解析（阿拉伯 1-99 或中文数字；不匹配 null）。 */
function parseSeq(raw: string): number | null {
  if (/^[1-9][0-9]?$/.test(raw)) return Number(raw);
  return parseCnNumber(raw);
}

/** 尾句读容忍（。！？!?，,；;——整句口令常带收尾语气）。 */
function stripTailPunct(s: string): string {
  return s.replace(/[。！？!?，,；;~～]+$/u, "");
}

/**
 * 整句口令解析：非口令句（含夹带「确认」的聊天句、整句「全部确认」）→ null。
 * strict 显式口令（确认/取消/编号/全部取消）不带 alias；protocol 单源词族
 * 口语应答词（闸门对应修复批）命中 → 带 alias 的 top 口令（无卡透传归
 * 消费方，解析层只识别不裁决）。不设「全部确认」（写操作授权禁语音批量
 * 放行）。
 */
export function parseVoiceCommand(rawText: string): VoiceCommand | null {
  const text = stripTailPunct(rawText.trim());
  if (text === "") return null;

  if (text === "全部取消") return { kind: "cancelAll" };
  // 不设「全部确认」（写操作授权禁语音批量放行）——不匹配任何口令
  if (text === "全部确认" || text === "都确认") return null;

  const seqMatch = /^(确认|取消)(?:第)?([0-9一二三四五六七八九十]+)号$/u.exec(text);
  if (seqMatch !== null) {
    const seq = parseSeq(seqMatch[2]!);
    if (seq === null || seq < 1 || seq > 99) return null;
    return { kind: seqMatch[1] === "确认" ? "confirm" : "cancel", target: { seq } };
  }
  if (text === "确认") return { kind: "confirm", target: "top" };
  if (text === "取消") return { kind: "cancel", target: "top" };

  // ── 口语应答词（protocol 单源词族——闸门对应修复批）：全等命中即同意图
  //    口令，带 alias 位（消费方裁决无卡透传）；归一口径与 daemon 路由同源
  //    （normalizeStewardPhrase——尾部句读容忍）。「确认/取消/全部取消」已
  //    strict 命中在前，此处只会命中词族其余词，无冲突。──
  const normalized = normalizeStewardPhrase(text);
  if (matchStewardConfirmPhrase(normalized)) return { kind: "confirm", target: "top", alias: true };
  if (matchStewardCancelPhrase(normalized)) return { kind: "cancel", target: "top", alias: true };
  if (matchStewardCancelAllPhrase(normalized)) return { kind: "cancelAll", alias: true };
  return null;
}

/**
 * 口令 → 卡栈快照裁决（绑定时刻 = 调用方的整句定稿时点）：
 * - 栈顶 = awaiting 态 seq 最大卡；全部跳过 accepted/done；
 * - 编号卡非 awaiting → settled（已被处理，不可二次确认/取消）。
 */
export function resolveVoiceCommand(command: VoiceCommand, cards: readonly VoiceCardSnapshot[]): VoiceCommandResult {
  // memory 通知卡无 daemon 侧 pending——口令面整面不可见（指认/栈顶/全部
  // 取消均跳过，避免对不存在的 action 发 cancel）
  const actionable = cards.filter((c) => c.kind !== "memory");
  if (command.kind === "cancelAll") {
    const targets = actionable.filter((c) => c.state === "awaiting").map(project);
    if (targets.length === 0) return { kind: "none", reason: "noCards" };
    return { kind: "cancelAll", targets };
  }
  if (command.target === "top") {
    const awaiting = actionable.filter((c) => c.state === "awaiting");
    if (awaiting.length === 0) return { kind: "none", reason: "noCards" };
    const top = awaiting.reduce((a, b) => (b.seq > a.seq ? b : a));
    return { kind: command.kind, targets: [project(top)] };
  }
  const seq = command.target.seq;
  const hit = actionable.find((c) => c.seq === seq);
  if (hit === undefined) return { kind: "none", reason: "notFound", seq };
  if (hit.state !== "awaiting") return { kind: "none", reason: "settled", seq };
  return { kind: command.kind, targets: [project(hit)] };
}

/** 快照 → 动作对象投影（剥 state）。 */
function project(card: VoiceCardSnapshot): VoiceCardTarget {
  return { actionId: card.actionId, agentId: card.agentId, seq: card.seq };
}

// ── 意图门控打断：停止意图快通道（批 3b 起单源 @helix/protocol stewardPhrases）──
// 需求：打断从「有人声就打断」收紧为「识别出停止意图才打断」——快通道是
// 机械零成本层：停止词全等命中即真停。与卡栈口令族（parseVoiceCommand）
// 正交：这里只判「这句话是不是让管家闭嘴」，不产生卡栈动作。
// 词表已与 daemon 路由面单源化（批 3b 前双端 7/6 词分叉）；14 词全停词表
// 经用户裁决扩充。变体（先停一下/停下来/暂停）仍不收录——宁缺勿滥，误停
// 代价（打断播报但用户非停止意图）高于漏停（播完短内容）。

/** 停止意图快通道判定（全等 + 尾句读容忍）：interim（流式部分文本）与
 *  final 两级共用；夹带句（「先停一下」）不命中。 */
export function isStopIntentPhrase(rawText: string): boolean {
  return matchStewardStopPhrase(rawText);
}
