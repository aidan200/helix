/**
 * i18n zh-CN 词条完备性测试（AG-16-②）：覆盖 prototype/review.md「P-1 文案
 * key 清单」全集（40+ key，含 tsFormat；S1 应用壳统一：theme.dark/light 双键退役，
 * 主题切换单钮迁 IconRail 走 chat.nav.themeToggle）；en-US
 * 结构随迁（键集合一致，内容不在本迭代范围）。
 */
import { describe, expect, it } from "vitest";
import { zhCN } from "./zh-CN";
import { enUS } from "./en-US";
import { t } from "@/shared/i18n";
import type { Translations } from "./zh-CN";

/** review.md「P-1 文案 key 清单」全集（逐行登记，缺一即失败）；v0.1 追加
 *  sa.card 与 sa.spawn 词条及 cancelled 恢复态（AD-10，无原型演示位、清单外新增）；
 *  T4.2 追加 think/compact/stats 词条（16 key，含清单外新增 mainRunning/
 *  mainIdle/kind* 展示键，沿 cancelled 先例）；T8 输入区改造：composer.stop
 *  新增（停止钮），projectionNote 退役（脚注整行移除）。 */
const REQUIRED_KEYS = [
  "chat.header.modeTitle",
  "chat.mode.default",
  "chat.header.home",
  "chat.conn.connected",
  "chat.conn.connecting",
  "chat.conn.disconnected",
  "chat.conn.error",
  "chat.banner.reconnecting",
  "chat.banner.reconnectAttempt",
  "chat.banner.reconnectingAddr",
  "chat.overlay.connecting",
  "chat.overlay.addr",
  "chat.error.title",
  "chat.error.desc",
  "chat.error.retry",
  "chat.error.retryOk",
  "chat.error.retryOkSub",
  "chat.empty.title",
  "chat.empty.suggest.read",
  "chat.empty.suggest.test",
  "chat.empty.suggest.grep",
  "chat.composer.placeholder",
  "chat.composer.placeholderConnecting",
  "chat.composer.placeholderWaiting",
  "chat.composer.send",
  "chat.composer.stop",
  "chat.composer.enterHint",
  "chat.attach.button",
  "chat.attach.remove",
  "chat.attach.enlarge",
  "chat.attach.limit",
  "chat.attach.imageAlt",
  "chat.steer.hint",
  "chat.steer.queued",
  "chat.steer.drained",
  "chat.steer.directedChip",
  "chat.restore.toast",
  "chat.restore.toastSub",
  "chat.msg.you",
  "chat.msg.agent",
  "chat.tool.running",
  "chat.tool.done",
  "chat.tool.error",
  "chat.tool.args",
  "chat.tool.result",
  "chat.tool.resultFailed",
  "chat.tsFormat",
  "chat.sa.card.queued",
  "chat.sa.card.waiting",
  "chat.sa.card.queueFoot",
  "chat.sa.card.running",
  "chat.sa.card.channelSub",
  "chat.sa.card.doneBadge",
  "chat.sa.card.failedBadge",
  "chat.sa.card.cancelledBadge",
  "chat.sa.card.cancelledSub",
  "chat.sa.card.failedFoot",
  "chat.sa.card.injectedMain",
  "chat.sa.card.injectedMainNoTime",
  "chat.sa.card.openDrawer",
  "chat.sa.spawn.toast",
  "chat.sa.spawn.toastSub",
  "chat.think.streaming",
  "chat.think.done",
  "chat.compact.bar",
  "chat.compact.note",
  "chat.stats.badge",
  "chat.stats.popTitle",
  "chat.stats.total",
  "chat.stats.footNote",
  "chat.stats.cacheSub",
  "chat.stats.reasoningSub",
  "chat.stats.compactSub",
  "chat.stats.mainRunning",
  "chat.stats.mainIdle",
  "chat.stats.kindMain",
  "chat.stats.kindSub",
  "chat.stats.kindCompact",
  // T4.3（P-2 抽屉；review.md drawer 清单 20 key + 补齐 close/slot 两声明键）
  "chat.drawer.close",
  "chat.drawer.task",
  "chat.drawer.channel",
  "chat.drawer.kill",
  "chat.drawer.killConfirm",
  "chat.drawer.killedToast",
  "chat.drawer.killedToastSub",
  "chat.drawer.stalled",
  "chat.drawer.stalledLc",
  "chat.drawer.steerMark",
  "chat.drawer.steerToast",
  "chat.drawer.steerToastSub",
  "chat.drawer.queuedHint",
  "chat.drawer.steerTarget",
  "chat.drawer.steerPlaceholder",
  "chat.drawer.steerInputLabel",
  "chat.drawer.reportFoot",
  "chat.drawer.instanceMeta",
  "chat.drawer.slotDeclared",
  "chat.drawer.slotInherited",
  "chat.drawer.lc.spawned",
  "chat.drawer.lc.modelResolved",
  "chat.drawer.lc.crashed",
  "chat.drawer.lc.terminated",
  "chat.drawer.closure.title",
  // T3.2（P-1 工作台 + P-2 侧栏 + P-1s 两阶段/分页 + P-4 路由壳）
  "chat.sidebar.newSession",
  "chat.sidebar.sessions",
  "chat.sidebar.notSent",
  "chat.sidebar.draft",
  "chat.sidebar.runStreaming",
  "chat.sidebar.runSubagent",
  "chat.sidebar.runIdle",
  "chat.sidebar.collapse",
  "chat.sidebar.expand",
  "chat.sidebar.deleteTitle",
  "chat.sidebar.deleteConfirmText",
  "chat.sidebar.deleteConfirm",
  "chat.sidebar.deleteCancel",
  "chat.sidebar.deleteToast",
  "chat.sidebar.deleteToastSub",
  "chat.sidebar.timeJustNow",
  "chat.sidebar.timeMinutes",
  "chat.sidebar.timeHours",
  "chat.sidebar.timeYesterday",
  "chat.sidebar.timeDays",
  "chat.topbar.draftTitle",
  "chat.topbar.modelTitle",
  "chat.paging.status",
  "chat.paging.placeholder",
  "chat.paging.loadEarlier",
  "chat.paging.loadedCount",
  "chat.draftEmpty.title",
  "chat.draftEmpty.hint",
  "chat.rail.label",
  "chat.rail.open",
  "chat.rail.expand",
  "chat.rail.collapse",
  "chat.rail.typeSubagent",
  "chat.settings.title",
  "chat.settings.nav.label",
  "chat.settings.nav.models",
  // T3.4（CL-4 IconRail 导航壳 + 页签词条；彼时四页皆施工牌，现仅 project 占位；review.md §6 R-P4-1/4）
  "chat.nav.railLabel",
  "chat.nav.plannedBadge",
  "chat.nav.themeToggle",
  "chat.nav.pages.chat.label",
  "chat.nav.pages.skills.label",
  "chat.nav.pages.skills.preview",
  "chat.nav.pages.trace.label",
  "chat.nav.pages.project.label",
  "chat.nav.pages.project.preview",
  "chat.nav.pages.settings.label",
  // T4（契约 v0.7 web 族：IconRail 联网状态钮 + popover 文案）
  "chat.web.button",
  "chat.web.stateIdle",
  "chat.web.stateConnecting",
  "chat.web.stateConnected",
  "chat.web.stateError",
  "chat.web.connectedTitle",
  "chat.web.browserLabel",
  "chat.web.portLabel",
  "chat.web.tabCountLabel",
  "chat.web.tabsTitle",
  "chat.web.tabsEmpty",
  "chat.web.stop",
  "chat.web.start",
  "chat.web.starting",
  "chat.web.idleJustNow",
  "chat.web.idleMinutes",
  "chat.web.idleHours",
  // T2.2（CL-5 P-1 TracePage；原型 P-1-trace.html 文案清单）
  "trace.title",
  "trace.controls.ariaLabel",
  "trace.controls.range",
  "trace.controls.types",
  "trace.controls.typesGroup",
  "trace.controls.rangeAll",
  "trace.controls.range1h",
  "trace.controls.range15m",
  "trace.controls.range5m",
  // S3b（trace 页迁 AppLayout：sidebar 上下分区；控制条 session 下拉退役）
  "trace.sidebar.ariaLabel",
  "trace.sidebar.sessions",
  "trace.sidebar.sessionsEmpty",
  "trace.sidebar.pickSession",
  "trace.panel.ariaLabel",
  "trace.panel.title",
  "trace.panel.count",
  "trace.panel.all",
  "trace.panel.allSub",
  "trace.panel.eventCount",
  "trace.panel.empty",
  "trace.panel.mainName",
  "trace.panel.statusRunning",
  "trace.panel.statusCompleted",
  "trace.panel.statusFailed",
  "trace.panel.statusKilled",
  "trace.panel.timeRunning",
  "trace.ctx.ariaLabel",
  "trace.ctx.title",
  "trace.ctx.source",
  "trace.ctx.taskCite",
  "trace.ctx.model",
  "trace.ctx.tools",
  "trace.ctx.compaction",
  "trace.ctx.compactionValue",
  "trace.ctx.compactionOff",
  "trace.ctx.baseModel",
  "trace.ctx.prompt",
  "trace.ctx.promptChars",
  "trace.ctx.expand",
  "trace.ctx.collapse",
  "trace.ctx.timeline",
  "trace.ctx.current",
  "trace.ctx.compactionMilestone",
  "trace.ctx.compactionEvent",
  "trace.ctx.snapshotMissing",
  "trace.ctx.snapshotMissingHint",
  "trace.table.time",
  "trace.table.instance",
  "trace.table.type",
  "trace.table.summary",
  "trace.table.hit",
  "trace.table.copyJson",
  "trace.table.copied",
  "trace.table.copyFailed",
  "trace.table.payloadHead",
  "trace.paging.meta",
  "trace.paging.more",
  "trace.paging.allLoaded",
  "trace.state.emptySession",
  "trace.state.emptySessionHint",
  "trace.state.emptyFiltered",
  "trace.state.emptyFilteredHint",
  "trace.state.errorTitle",
  "trace.state.retry",
  "trace.state.connTitle",
  "trace.state.connDesc",
  "trace.state.reconnect",
  "trace.state.reconnectedToast",
  "trace.state.notConnected",
  // M6 T4（CL-skills 智能体页；规划 §三页面形态定稿文案）
  "agents.title",
  "agents.mainTitle",
  "agents.subTitle",
  "agents.modelLabel",
  "agents.modelFollowMain",
  "agents.modelFollowSub",
  "agents.modelNoteMain",
  "agents.modelNoteSub",
  "agents.toolsLabel",
  "agents.skillsLabel",
  "agents.skillsEmpty",
  "agents.skillSourceBuiltin",
  "agents.diagLabel",
  "agents.loading",
  "agents.errorTitle",
  "agents.retry",
  "agents.skippedToast",
  "agents.notConnected",
  "agents.switchOn",
  "agents.switchOff",
] as const;

function flatten(obj: unknown, prefix = ""): Map<string, string> {
  const out = new Map<string, string>();
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    const path = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === "object") {
      for (const [p, val] of flatten(v, path)) out.set(p, val);
    } else if (typeof v === "string") {
      out.set(path, v);
    }
  }
  return out;
}

describe("AG-16-② zh-CN 词条完备性", () => {
  const flat = flatten(zhCN);

  it("覆盖 review.md 全部 42 + 17（T4.1）+ 16（T4.2）个 v0.1 新 key（≥40 口径）", () => {
    expect(REQUIRED_KEYS.length).toBeGreaterThanOrEqual(40);
    const missing = REQUIRED_KEYS.filter((k) => !flat.has(k));
    expect(missing).toEqual([]);
  });

  it("全部词条值为非空字符串（占位空串不算覆盖）", () => {
    const empty = [...flat].filter(([, v]) => v.trim() === "").map(([k]) => k);
    expect(empty).toEqual([]);
  });

  it("zh-CN 词条只含 chat + trace + agents 三族（裁剪版，不搬 desk 全量）", () => {
    // P-1 工作台一族（chat.*）+ CL-5 TracePage 一族（trace.*，T2.2）+ M6 T4
    // 智能体页一族（agents.*）；顶层不应出现 desk 的 sidebar/settings/kg 等非本仓命名空间。
    expect(Object.keys(zhCN)).toEqual(["chat", "trace", "agents"]);
  });
});

describe("i18n 结构随迁（en-US）", () => {
  it("en-US 与 zh-CN 键集合一致（值内容不在本迭代范围）", () => {
    const zh = flatten(zhCN);
    const en = flatten(enUS as Translations);
    expect([...en.keys()].sort()).toEqual([...zh.keys()].sort());
  });
});

describe("t() 插值", () => {
  it("{n}/{addr}/{code} 变量替换；缺 key 回退 key 本身", () => {
    const translations = zhCN as unknown as Translations;
    expect(t(translations, "chat.banner.reconnectAttempt", { n: 3 })).toBe("第 3 次尝试");
    expect(t(translations, "chat.overlay.addr", { addr: "ws://127.0.0.1:7333" })).toBe(
      "ws://127.0.0.1:7333",
    );
    expect(t(translations, "chat.not.exists.key")).toBe("chat.not.exists.key");
  });
});

describe("OI-7 restore.toastSub 投影面枚举（T1.3）", () => {
  it("文案枚举快照重建四面投影：消息（entries 计数）+ 实例/通道/账目", () => {
    const translations = zhCN as unknown as Translations;
    const text = t(translations, "chat.restore.toastSub", { n: 42 });
    // 四面 = snapshot case 重建的 entries/instances/instanceChannels/usage；
    // {n} 仅承载 entries 计数（snapshot.ts restoreToast.count），其余三面枚举入文案
    expect(text).toContain("消息 42 条");
    expect(text).toContain("实例");
    expect(text).toContain("通道");
    expect(text).toContain("账目");
  });
});
