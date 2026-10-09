/**
 * StewardActivityService —— 管家活动账 application service（M3-d1 感知兑现批：
 * 一个索引、一个账本、三个出口——本文件是「账本」）。
 *
 * 统一条目模型 {at, domain, attribution, text}：
 * - domain 六值：task | session | agent | surface | cli | notify（域标签归组）；
 * - attribution 三值：user | steward | system（CAND-607 selfRef 并入解决——
 *   管家自产动作（分诊汇报/notify）标 steward，不再混入 system 面）；
 * - text 恒白话一句（TR-249 铁律延伸到账目/呈现/投影面：禁术语/UUID/英文
 *   报错原文——六类 ring 条目的技术原文不直入账，逐类转白话句）。
 *
 * 数据源（管道冻结——零新采集面）：
 * - ring 六类条目沉淀：StewardPerceptionService.pushRing 经 onRingEntry 回调
 *   入账（agent 终态/周期进展/任务终态/分诊摄入/表面事件/回合终态——ring 是
 *   既有内存索引，账本只是它的落盘投影）；
 * - notify 记账：组合根在 emitNotify 出口旁挂 recordNotify（记账不触发——
 *   通知链行为零改动，账本只「记」不「发」）。
 *
 * 三个出口：
 * - 落盘回看/清理（时间线查询面）：store 行式落盘 + 时间窗查询 + clear；
 *   store 缺席/失败 = 纯内存降级（记录不丢、回看降级内存窗）；
 * - ask 对话投影：recent(n) 白话条目 → StewardService context_snapshot 段
 *   （感知第一次闭环——失败静默降级在消费面 buildSnapshotSafely 收口）；
 * - 实时帧：emit 逐条发出（组合根接 EventStream.broadcastStewardActivity，
 *   与 feed/notify 同订阅闸——时间线呈现面实时冒条目）。
 *
 * cli: 域标签：CliAdapter stdin 输入经组合根旁挂 noteCliSession（当前会话
 * 登记 CLI 来源）——该会话的账目条目 domain 归组 "cli"（呈现归组用，E-20
 * CliAdapter 侧识别会话来源）。
 *
 * 防自激：本服务纯记账（落盘 + 内存镜像 + emit 帧），零领域事件发布、零
 * 通知链触发——感知管道冻结语义保持。
 */
import type { StewardActivityEntryView, StewardActivityPayload } from "@helix/protocol";
import type { StewardActivityStorePort } from "../ports/outbound/StewardActivityStorePort";
import type { PerceptionRingEntry } from "./StewardPerceptionService";

/** 内存近期镜像滚动上限（投影/降级窗——与 ring 200 同量级）。 */
export const ACTIVITY_LEDGER_MEMORY_LIMIT = 200;

/** 白话卫生：剥除十六进制/UUID 形态串（含 0x 前缀——≥8 位十六进制，
 *  id/指纹不进白话句）。 */
const HEX_RUN = /(0x)?[0-9a-fA-F]{8,}/g;

/** 中日韩兼容表意字符探测（纯 ASCII/英文残句判定——英文报错原文不进白话句）。 */
const CJK = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;

/** 白话句内文截断上限（单条内文；整句在消费面另有预算）。 */
const PLAIN_TALK_MAX_CHARS = 60;

/**
 * 白话卫生（纯函数导出供单测）：剥除十六进制/UUID 形态串 + 空白归一 +
 * 截断省略号；卫生后为空或无中文残句（纯英文报错原文——TR-249 禁入）
 * 返回 ""——调用方回退固定白话句。
 */
export function plainTalkOf(text: string, maxChars: number = PLAIN_TALK_MAX_CHARS): string {
  const stripped = text.replace(HEX_RUN, "").replace(/\s+/g, " ").trim();
  if (stripped === "" || !CJK.test(stripped)) return "";
  return [...stripped].length <= maxChars ? stripped : `${[...stripped].slice(0, maxChars).join("")}…`;
}

/** 白话句拼装：正文在场追加冒号段（内文先过白话卫生）；缺席 = 纯固定句。 */
function plainSentence(prefix: string, body: string | undefined, maxChars: number = PLAIN_TALK_MAX_CHARS): string {
  const plain = body === undefined ? "" : plainTalkOf(body, maxChars);
  return plain === "" ? prefix : `${prefix}：${plain}`;
}

/** 任务终态白话尾词（status → 白话——与 onJobTerminal 机械短讯同词单源口径）。 */
function taskTerminalVerb(statusLike: string): string {
  if (statusLike.includes("fail")) return "失败了";
  if (statusLike.includes("cancel")) return "被停掉了";
  return "完成了";
}

/** 表面事件 kind → 白话句（E-251 词汇表成员逐 kind 映射；未知 kind 兜底句）。 */
const SURFACE_KIND_PHRASES: Record<string, string> = {
  activated: "打开了应用界面",
  navigated: "切换到了别的页面",
  user_click: "在界面上点了一下",
  user_input: "在界面上输入了内容",
  idle: "界面有一会儿没动静了",
  error: "界面出了点状况",
};

/**
 * ring 条目 → 活动账统一条目（纯函数导出供单测——转换与归一规则单源）：
 * - domain 归组：agent 终态→agent / 周期进展与回合终态→session / 任务终态与
 *   分诊摄入→task / 表面事件→surface；CLI 来源会话整体改归 cli（呈现归组）；
 * - attribution 归一：agent/progress/task.terminal/turn=system（机械动作）、
 *   task.diagnosed=steward（管家分诊自产——CAND-607）、surface=origin 三值
 *   （E-251 三原语；缺席缺省 user——M0 shell 页面事件恒 user）；
 * - text：逐类白话句（技术原文/UUID 不入账——TR-249 延伸）。
 */
export function ringEntryToActivity(
  entry: PerceptionRingEntry,
  isCliSession: (sessionId: string) => boolean,
): StewardActivityEntryView {
  const cli = isCliSession(entry.sessionId);
  let domain: StewardActivityEntryView["domain"];
  let attribution: StewardActivityEntryView["attribution"];
  let text: string;
  switch (entry.kind) {
    case "agent.completed":
      domain = "agent";
      attribution = "system";
      text = plainSentence("后台有个帮手干完了一件事", entry.text);
      break;
    case "agent.failed":
      domain = "agent";
      attribution = "system";
      text = plainSentence("后台有个帮手没能完成任务", entry.text);
      break;
    case "agent.killed":
      domain = "agent";
      attribution = "system";
      text = "后台有个帮手被停掉了";
      break;
    case "progress.ping":
      domain = cli ? "cli" : "session";
      attribution = "system";
      text = plainSentence("工作有了新进展", entry.text);
      break;
    case "task.terminal": {
      domain = "task";
      attribution = "system";
      const verb = taskTerminalVerb(entry.text);
      const title = entry.title !== undefined && entry.title.trim() !== "" ? plainTalkOf(entry.title, 24) : "";
      text = title === "" ? `后台任务${verb}` : `「${title}」${verb}`;
      break;
    }
    case "task.diagnosed":
      domain = "task";
      attribution = "steward";
      text = plainSentence("管家汇报了最新情况", entry.text);
      break;
    case "surface.event":
      domain = "surface";
      attribution = entry.origin ?? "user";
      text = SURFACE_KIND_PHRASES[entry.surfaceKind ?? ""] ?? "界面有了新动静";
      break;
    case "turn.completed":
      domain = cli ? "cli" : "session";
      attribution = "system";
      text = cli ? "终端里的对话回完了" : "有一个对话回完了";
      break;
  }
  return { at: entry.at, domain, attribution, text };
}

/** notify 发出 → 活动账条目（纯函数导出供单测——title/body 已是白话面）。 */
export function notifyToActivity(payload: { at: number; title: string; body: string }): StewardActivityEntryView {
  const title = plainTalkOf(payload.title, 24);
  const body = plainTalkOf(payload.body, PLAIN_TALK_MAX_CHARS);
  return {
    at: payload.at,
    domain: "notify",
    attribution: "steward",
    text: title === "" || body === "" ? "管家发了一条通知" : `管家通知「${title}」：${body}`,
  };
}

export interface StewardActivityDeps {
  /** 落盘写面（SqliteActivityLedgerStore；缺席/抛错 = 纯内存降级）。 */
  readonly store?: StewardActivityStorePort;
  /** 实时帧出口（组合根接 EventStream.broadcastStewardActivity；缺席 = 零帧）。 */
  readonly emit?: (payload: StewardActivityPayload) => void;
  /** 时钟（缺省 Date.now——测试注入）。 */
  readonly clock?: () => number;
  readonly logger?: { warn(message: string): void };
}

export class StewardActivityService {
  private readonly deps: StewardActivityDeps;
  private readonly now: () => number;
  /** 近期镜像（最旧→最新；投影与降级窗）。 */
  private recentEntries: StewardActivityEntryView[] = [];
  /** CLI 来源会话登记表（CliAdapter stdin 输入经组合根登记——呈现归组用）。 */
  private readonly cliSessions = new Set<string>();
  /** 实时帧连接内单调序号。 */
  private seq = 0;
  /** 落盘降级标记（首错 warn 一次——不逐条刷日志）。 */
  private storeDegraded = false;

  constructor(deps: StewardActivityDeps) {
    this.deps = deps;
    this.now = deps.clock ?? (() => Date.now());
  }

  /** CLI 来源会话登记（组合根接 CliAdapter stdin 输入旁挂——该会话条目归组 cli）。 */
  noteCliSession(sessionId: string): void {
    if (sessionId !== "") this.cliSessions.add(sessionId);
  }

  /** ring 条目沉淀（StewardPerceptionService.onRingEntry 接线——零新采集）。 */
  recordRingEntry(entry: PerceptionRingEntry): void {
    this.record(ringEntryToActivity(entry, (sid) => this.cliSessions.has(sid)));
  }

  /** notify 记账（组合根 emitNotify 出口旁挂——记账不触发）。 */
  recordNotify(payload: { title: string; body: string }): void {
    this.record(notifyToActivity({ at: this.now(), title: payload.title, body: payload.body }));
  }

  /** 近期条目（最旧→最新，取最近 count 条——ask 投影数据源）。 */
  recent(count: number): readonly StewardActivityEntryView[] {
    return count >= this.recentEntries.length ? [...this.recentEntries] : this.recentEntries.slice(-count);
  }

  /** 时间窗查询（at 降序最新在前——时间线查询面；store 缺席降级内存窗）。 */
  listWindow(query: { sinceMs: number; untilMs?: number; limit: number }): readonly StewardActivityEntryView[] {
    try {
      if (this.deps.store !== undefined) return this.deps.store.listWindow(query);
    } catch (err) {
      this.deps.logger?.warn(`管家活动账查询失败（降级内存窗）：${(err as Error).message}`);
    }
    const until = query.untilMs ?? Number.MAX_SAFE_INTEGER;
    return this.recentEntries
      .filter((e) => e.at >= query.sinceMs && e.at < until)
      .slice(-query.limit)
      .reverse();
  }

  /** 清理（落盘 + 内存镜像同清；store 失败静默——内存面保证清理语义成立）。 */
  clear(): void {
    this.recentEntries = [];
    try {
      this.deps.store?.clear();
    } catch (err) {
      this.deps.logger?.warn(`管家活动账清理失败（落盘面）：${(err as Error).message}`);
    }
  }

  /** 落账单点：内存镜像 + 落盘 + 实时帧（三面同条目）。 */
  private record(entry: StewardActivityEntryView): void {
    this.recentEntries.push(entry);
    if (this.recentEntries.length > ACTIVITY_LEDGER_MEMORY_LIMIT) {
      this.recentEntries = this.recentEntries.slice(-ACTIVITY_LEDGER_MEMORY_LIMIT);
    }
    try {
      this.deps.store?.append(entry);
      this.storeDegraded = false;
    } catch (err) {
      if (!this.storeDegraded) {
        this.storeDegraded = true;
        this.deps.logger?.warn(`管家活动账落盘降级（纯内存，重启即失）：${(err as Error).message}`);
      }
    }
    this.seq += 1;
    this.deps.emit?.({ ...entry, seq: this.seq });
  }
}
