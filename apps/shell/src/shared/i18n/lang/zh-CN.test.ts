/**
 * i18n zh-CN 词条完备性测试（AG-16-②）：覆盖 prototype/review.md「P-1 文案
 * key 清单」全集（40+ key，含 theme.dark/light 双键与 tsFormat）；en-US
 * 结构随迁（键集合一致，内容不在本迭代范围）。
 */
import { describe, expect, it } from "vitest";
import { zhCN } from "./zh-CN";
import { enUS } from "./en-US";
import { t } from "@/shared/i18n";
import type { Translations } from "@/shared/i18n/types";

/** review.md「P-1 文案 key 清单」全集（逐行登记，缺一即失败）；v0.1 追加
 *  sa.card 与 sa.spawn 词条及 cancelled 恢复态（AD-10，无原型演示位、清单外新增）；
 *  T4.2 追加 think/compact/stats 词条（16 key，含清单外新增 mainRunning/
 *  mainIdle/kind* 展示键，沿 cancelled 先例）。 */
const REQUIRED_KEYS = [
  "chat.header.session",
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
  "chat.composer.enterHint",
  "chat.composer.projectionNote",
  "chat.steer.hint",
  "chat.steer.queued",
  "chat.steer.drained",
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
  "chat.theme.dark",
  "chat.theme.light",
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
  "chat.topbar.settingsTitle",
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
  "chat.settings.back",
  "chat.settings.title",
  // T3.4（CL-4 IconRail 导航壳 + 四占位页施工牌；review.md §6 R-P4-1/4）
  "chat.nav.railLabel",
  "chat.nav.plannedBadge",
  "chat.nav.pages.chat.label",
  "chat.nav.pages.models.label",
  "chat.nav.pages.skills.label",
  "chat.nav.pages.skills.preview",
  "chat.nav.pages.trace.label",
  "chat.nav.pages.trace.preview",
  "chat.nav.pages.project.label",
  "chat.nav.pages.project.preview",
  "chat.nav.pages.settings.label",
  "chat.nav.pages.settings.preview",
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

  it("zh-CN 词条不含多余分支（裁剪版，不搬 desk 全量）", () => {
    // P-1 只需要 chat.* 一族（header 名与发送 hint 等），顶层不应出现 desk 的
    // sidebar/settings/trace/kg 等非 P-1 命名空间。
    expect(Object.keys(zhCN)).toEqual(["chat"]);
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
