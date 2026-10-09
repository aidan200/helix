/**
 * 管家活动时间线页（/steward/activity，M3-d1 感知兑现批——「活动」呈现面）。
 *
 * 数据面双路（选最窄路径后的形态：additive 两帧 + 两命令，复用 steward 订阅闸）：
 * - 查询：steward.activity.list {range} → steward.activity.result 点对点回执
 *   （时间窗：今天/昨天/本周/全部；条目 = 活动账统一模型 {at,domain,attribution,text}）；
 * - 实时：steward.activity 广播帧（活动账落账即发，feed/notify 同订阅闸）→
 *   在窗条目实时冒头（当前窗口匹配才入列——不切窗不乱入）。
 *
 * 呈现：域标签 chip + 归因徽标 + 相对时间 + 白话一句（TR-249 延伸——账本
 * 侧已收口，本页零再加工）；「清空记录」两段式 armed 确认（记忆页删除同构）。
 *
 * 页面壳：AppLayout（StewardMemoryPage 同构）；不进 IconRail 六位（低频不占
 * 常驻导航——入口 = StewardPanel 头部活动钮）。纯视觉零语音（TR-250——
 * 时间线条目无任何播报/语音出口）。
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { Activity, RotateCcw, Trash2 } from "lucide-react";
import type { StewardActivityDomain, StewardActivityEntryView, StewardActivityRange } from "@helix/protocol";
import { useSession } from "@/entities/session/SessionContext";
import { useI18n } from "@/shared/i18n";
import { cn } from "@/shared/lib/cn";
import { relativeTimeSpan } from "@/shared/lib/format";
import AppLayout from "@/widgets/app-layout/ui/AppLayout";
import { useArmedConfirm } from "@/shared/lib/useArmedConfirm";

/** 时间窗档位。 */
const RANGES: readonly StewardActivityRange[] = ["today", "yesterday", "this_week", "all"];

/** 时间窗 → 窗口下界（本地时区零点/周一零点——daemon handler 同口径）。 */
function rangeSince(range: StewardActivityRange, nowMs: number): number {
  const d = new Date(nowMs);
  d.setHours(0, 0, 0, 0);
  const today0 = d.getTime();
  if (range === "yesterday") return today0 - 86_400_000;
  if (range === "this_week") return today0 - ((d.getDay() + 6) % 7) * 86_400_000;
  if (range === "all") return 0;
  return today0;
}

/** 列表长度上限（呈现面自律——清一屏可读量级）。 */
const LIST_MAX = 500;

const StewardActivityPage = function StewardActivityPage({ path }: { path: string }) {
  const { t } = useI18n();
  const { sendStewardActivityList, sendStewardActivityClear, subscribeStewardFrames } = useSession() as {
    sendStewardActivityList?: (range?: StewardActivityRange, limit?: number) => boolean;
    sendStewardActivityClear?: () => boolean;
    subscribeStewardFrames?: (listener: (e: { type: string; payload: unknown }) => void) => () => void;
  };
  const [range, setRange] = useState<StewardActivityRange>("today");
  const [entries, setEntries] = useState<readonly StewardActivityEntryView[] | null>(null);
  /** 实时帧在窗判定用时钟快照（窗口随时间推进——渲染时重算即可）。 */
  const rangeRef = useRef(range);
  rangeRef.current = range;
  const { armed: armedClear, confirm: confirmClear } = useArmedConfirm();

  // 查询面：挂载/切窗 → steward.activity.list（回执整表替换——权威面）。
  useEffect(() => {
    if (sendStewardActivityList === undefined) return;
    sendStewardActivityList(range);
    setEntries(null); // 切窗回到加载态（回执权威覆盖）
  }, [sendStewardActivityList, range]);

  // 帧消费：查询回执（整表替换）+ 实时条目（在窗才入列——新条目插头）。
  useEffect(() => {
    if (subscribeStewardFrames === undefined) return;
    return subscribeStewardFrames((event) => {
      if (event.type === "steward.activity.result") {
        const payload = event.payload as { entries?: unknown };
        if (Array.isArray(payload.entries)) {
          setEntries(payload.entries as StewardActivityEntryView[]);
        }
        return;
      }
      if (event.type === "steward.activity") {
        const payload = event.payload as { at?: unknown; domain?: unknown; attribution?: unknown; text?: unknown };
        if (typeof payload.at !== "number" || typeof payload.text !== "string") return;
        if (typeof payload.domain !== "string" || typeof payload.attribution !== "string") return;
        const entry: StewardActivityEntryView = {
          at: payload.at,
          domain: payload.domain as StewardActivityEntryView["domain"],
          attribution: payload.attribution as StewardActivityEntryView["attribution"],
          text: payload.text,
        };
        const since = rangeSince(rangeRef.current, Date.now());
        if (entry.at < since) return; // 不在当前窗口（如「今天」档收到昨日迟到帧）
        setEntries((prev) => {
          const next = [entry, ...(prev ?? [])];
          return next.length > LIST_MAX ? next.slice(0, LIST_MAX) : next;
        });
      }
    });
  }, [subscribeStewardFrames]);

  const rows = useMemo(() => entries ?? [], [entries]);

  const domainLabel = (d: string): string => {
    const key: Record<StewardActivityDomain, string> = {
      task: "domainTask",
      session: "domainSession",
      agent: "domainAgent",
      surface: "domainSurface",
      cli: "domainCli",
      notify: "domainNotify",
    };
    const k = key[d as StewardActivityDomain];
    return k === undefined ? d : t(`steward.activity.${k}`);
  };

  const attributionLabel = (a: string): string => {
    if (a === "user") return t("steward.activity.attributionUser");
    if (a === "steward") return t("steward.activity.attributionSteward");
    if (a === "system") return t("steward.activity.attributionSystem");
    return a;
  };

  const timeLabel = (at: number): string => {
    const span = relativeTimeSpan(at, Date.now());
    switch (span.key) {
      case "justNow":
        return t("steward.memory.justNow");
      case "minutes":
        return t("chat.sidebar.timeMinutes", { n: span.n });
      case "hours":
        return t("chat.sidebar.timeHours", { n: span.n });
      case "yesterday":
        return t("chat.sidebar.timeYesterday");
      default:
        return t("chat.sidebar.timeDays", { n: span.n });
    }
  };

  const onClear = (): void => {
    confirmClear("activity-log", () => {
      sendStewardActivityClear?.();
    });
  };

  return (
    <div data-steward-activity-page={path}>
      <AppLayout headerLeft={<h1 className="tb-title">{t("steward.activity.pageTitle")}</h1>}>
        <div className="pg" data-activity-page-body>
          {/* 头部：时间窗档位 + 刷新 + 清空（两段式 armed） */}
          <div className="toolbar" data-activity-page-head>
            <div className="toolbar-row">
              {RANGES.map((r) => (
                <button
                  key={r}
                  className={cn("hud-btn sm", range === r ? "hud-btn-cyan" : "hud-btn-ghost")}
                  type="button"
                  data-activity-range={r}
                  onClick={() => setRange(r)}
                >
                  {t(
                    r === "today"
                      ? "steward.activity.rangeToday"
                      : r === "yesterday"
                        ? "steward.activity.rangeYesterday"
                        : r === "this_week"
                          ? "steward.activity.rangeThisWeek"
                          : "steward.activity.rangeAll",
                  )}
                </button>
              ))}
              <button
                className="hud-btn hud-btn-ghost sm"
                type="button"
                data-activity-refresh
                onClick={() => sendStewardActivityList?.(range)}
              >
                <RotateCcw size={14} strokeWidth={1.75} aria-hidden="true" />
                {t("steward.activity.refresh")}
              </button>
              <button
                className={cn("hud-btn sm", armedClear === "activity-log" ? "hud-btn-danger" : "hud-btn-ghost")}
                type="button"
                data-activity-clear
                data-armed={armedClear === "activity-log" ? "1" : undefined}
                disabled={sendStewardActivityClear === undefined}
                onClick={onClear}
              >
                <Trash2 size={14} strokeWidth={1.75} aria-hidden="true" />
                {armedClear === "activity-log" ? t("steward.activity.clearArmed") : t("steward.activity.clear")}
              </button>
              <span className="hud-chip" data-activity-live-badge>
                <Activity size={12} strokeWidth={1.75} aria-hidden="true" />
                {t("steward.activity.live")}
              </span>
            </div>
          </div>

          {/* 列表：一屏一行（相对时间 + 域 chip + 归因徽标 + 白话句） */}
          {entries === null && (
            <p className="ag-note" data-activity-loading>
              {t("steward.activity.loading")}
            </p>
          )}
          {entries !== null && rows.length === 0 && (
            <p className="ag-note" data-activity-empty>
              {t("steward.activity.empty")}
            </p>
          )}
          <div className="memory-list" data-activity-list>
            {rows.map((e, i) => (
              <div className="memory-item" key={`${e.at}-${i}`} data-activity-item={i}>
                <div className="memory-main">
                  <span className="memory-text" data-activity-item-text={i}>
                    {e.text}
                  </span>
                  <span className="memory-flags">
                    <span className="hud-chip" data-activity-item-domain={i}>
                      {domainLabel(e.domain)}
                    </span>
                    <span className={cn("hud-chip", e.attribution === "steward" && "memory-chip-pinned")} data-activity-item-attribution={i}>
                      {attributionLabel(e.attribution)}
                    </span>
                  </span>
                </div>
                <div className="memory-sub">
                  <span className="memory-meta" data-activity-item-time={i}>
                    {timeLabel(e.at)}
                  </span>
                </div>
              </div>
            ))}
          </div>
        </div>
      </AppLayout>
    </div>
  );
};

export default StewardActivityPage;
