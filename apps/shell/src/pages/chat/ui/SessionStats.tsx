/**
 * header 统计徽标 + usage popover（F3.3/F3.4，CL-3 核心；hud-popover 载体
 * 首实现：popover-fill + blur + 10px 圆角，registry 载体规范零新组件族）。
 *
 * 数据面（TR-AD-5 纯投影）：
 * - 徽标 = usage.total 聚合投影。流式中冻结由 reducer 结构保证（delta 分支
 *   不触碰 usage），组件零防御逻辑；值变更（usage.recorded/快照到达）触发
 *   0.6s flash 辉光渐隐（opacity 动效层，reduced-motion 关）。
 * - popover 行 = deriveUsageRows(state) 纯函数（instances join 账目 + main +
 *   compaction 独立行）；合计行与徽标同一状态源派生，数字天然自洽。
 *
 * 交互面：徽标点击 toggle（aria-expanded）；popover 点外部 / Esc 关闭；
 * SubAgent 行尾 → onOpenInstance 抽屉回调（T4.3 接线，当前占位）；compaction
 * 行 → 锚点滚动到最后一条 compaction 里程碑条。
 */
import { Fragment, memo, useEffect, useRef, useState } from "react";
import type { CompactionEntryDto } from "@helix/protocol";
import { useI18n } from "@/shared/i18n";
import { fmtTokens } from "@/shared/lib/format";
import { cn } from "@/shared/lib/cn";
import { selectIsGenerating, useSession } from "@/entities/session/SessionContext";
import { MAIN_INSTANCE_ID, type SessionState } from "@/entities/session/model/session-reducer";

// ── 行派生（纯函数，单一状态源）────────────────────────────

/** 状态 chip 值（SubAgent/compaction = 协议 InstanceState 字面量；idle = main 空闲） */
export type UsageChipState = "queued" | "running" | "done" | "failed" | "cancelled" | "idle";

export interface UsageRow {
  /** 行 id（main / agentId / "compaction"） */
  id: string;
  /** kind 标签 i18n key（chat.stats.kind*） */
  kindKey: string;
  model: string;
  tokens: number;
  cost: number;
  chip: UsageChipState;
  /** chip 文案（SubAgent/compaction 用协议状态字面量——领域词汇；main 由渲染层取词条） */
  chipLabel: string;
  /** 行下 sub 说明（cache/reasoning/compact 归属） */
  sub?: { key: "cacheSub" | "reasoningSub" | "compactSub"; vars: Record<string, string> };
  /** 行尾动作：SubAgent → 抽屉（T4.3）；compaction → 锚点滚动 */
  action?: { type: "drawer"; instanceId: string } | { type: "compaction" };
}

/** 账目行投影（F3.4）：main 行 + instances 卡片行（spawn 时序）+ compaction
 *  独立行（usage.compaction 小计 + 最近里程碑 before→after 归属说明 sub）。
 *  合计 = state.usage.total = Σ行（reducer addUsage 结构保证，数字自洽）。 */
export function deriveUsageRows(s: SessionState): UsageRow[] {
  const rows: UsageRow[] = [];

  // main 行：reasoning sub（Q-11③：main 行 reasoning 维度）；chip 随生成态
  const mainUsage = s.usage.byInstance[MAIN_INSTANCE_ID];
  const generating = selectIsGenerating(s);
  rows.push({
    id: MAIN_INSTANCE_ID,
    kindKey: "chat.stats.kindMain",
    model: s.model,
    tokens: mainUsage?.totalTokens ?? 0,
    cost: mainUsage?.cost ?? 0,
    chip: generating ? "running" : "idle",
    chipLabel: "",
    sub:
      mainUsage && mainUsage.reasoning > 0
        ? { key: "reasoningSub", vars: { n: fmtTokens(mainUsage.reasoning) } }
        : undefined,
  });

  // SubAgent 行：卡片状态机 join 账目小计；done 行 cache R/W sub（Q-11③）；
  // model 缺省继承当前模型（AD-6）
  for (const card of s.instances) {
    const u = s.usage.byInstance[card.instanceId];
    const doneCache =
      card.state === "done" && u && u.cacheRead + u.cacheWrite > 0
        ? { key: "cacheSub" as const, vars: { r: fmtTokens(u.cacheRead), w: fmtTokens(u.cacheWrite) } }
        : undefined;
    rows.push({
      id: card.instanceId,
      kindKey: "chat.stats.kindSub",
      model: card.model ?? s.model,
      tokens: u?.totalTokens ?? 0,
      cost: u?.cost ?? 0,
      chip: card.state,
      chipLabel: card.state,
      sub: doneCache,
      action: { type: "drawer", instanceId: card.instanceId },
    });
  }

  // compaction 独立行：账目 compaction 小计 + 最近里程碑 before→after 说明
  // （归属 main 的摘要调用；行出现 = 会话发生过 compaction）
  const lastCompact = [...s.entries].reverse().find((e): e is CompactionEntryDto => e.kind === "compaction");
  if (lastCompact) {
    const cu = s.usage.compaction;
    rows.push({
      id: "compaction",
      kindKey: "chat.stats.kindCompact",
      model: s.model, // 摘要调用由 main 发起，模型随会话（DTO 无模型字段）
      tokens: cu.totalTokens,
      cost: cu.cost,
      chip: "done",
      chipLabel: "done",
      sub: {
        key: "compactSub",
        vars: { before: fmtTokens(lastCompact.tokensBefore), after: fmtTokens(lastCompact.tokensAfter) },
      },
      action: { type: "compaction" },
    });
  }
  return rows;
}

// ── 徽标（F3.3）────────────────────────────────────────────

/** 统计徽标。值变更触发 flash：key 递增重挂辉光层，opacity 0.6s 渐隐
 *  （reduced-motion 由 CSS 关停，层常驻 opacity:0 无残留）。 */
export const StatsBadge = memo(function StatsBadge({
  open,
  onToggle,
}: {
  open: boolean;
  onToggle: () => void;
}) {
  const { t } = useI18n();
  const { state } = useSession();
  const total = state.usage.total;
  // 值标识（totalTokens:cost）——引用每帧皆新，值比较驱动 flash
  const valueKey = `${total.totalTokens}:${total.cost}`;
  const [flashSeq, setFlashSeq] = useState(0);
  const prevRef = useRef(valueKey);
  useEffect(() => {
    if (prevRef.current === valueKey) return;
    prevRef.current = valueKey;
    setFlashSeq((n) => n + 1);
  }, [valueKey]);

  return (
    <button
      className="stats-btn"
      type="button"
      aria-expanded={open}
      aria-haspopup="dialog"
      onClick={onToggle}
    >
      <span className="sb-dot" aria-hidden="true" />
      <span className="sb-text">
        {t("chat.stats.badge", {
          tokens: fmtTokens(total.totalTokens),
          cost: total.cost.toFixed(2),
        })}
      </span>
      {flashSeq > 0 && (
        <span key={flashSeq} className="sb-flash" data-flash="on" aria-hidden="true" />
      )}
    </button>
  );
});

// ── popover（F3.4；hud-popover 首实现）─────────────────────

const CHIP_CLASS: Record<UsageChipState, string> = {
  done: "st-done",
  running: "st-running",
  failed: "st-failed",
  queued: "",
  cancelled: "",
  idle: "",
};

const CHIP_DOT: Record<UsageChipState, string> = {
  done: "hud-dot-ok",
  running: "hud-dot-accent hud-dot-pulse",
  failed: "hud-dot-error",
  queued: "hud-dot-idle",
  cancelled: "hud-dot-idle",
  idle: "hud-dot-idle",
};

/** 锚点滚动：compaction 行 → 消息流内最后一条 compaction 里程碑条
 *  （reduced-motion 下直跳不平滑）。 */
function scrollToLastCompaction(): void {
  const bars = document.querySelectorAll('.fb-wrap[data-kind="compaction"]');
  const el = bars[bars.length - 1];
  if (!(el instanceof HTMLElement)) return;
  const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
  el.scrollIntoView({ behavior: reduced ? "auto" : "smooth", block: "center" });
}

export const UsagePopover = memo(function UsagePopover({
  onClose,
  onOpenInstance,
}: {
  onClose: () => void;
  /** SubAgent 行尾跳抽屉（T4.3 接线；当前占位）——payload = instanceId */
  onOpenInstance?: (instanceId: string) => void;
}) {
  const { t } = useI18n();
  const { state } = useSession();
  const rootRef = useRef<HTMLDivElement | null>(null);

  // 开合状态机（F3.4）：点外部（popover 与徽标之外）/ Esc 关闭；popover 内部
  // 点击不关（行尾动作自带 onClose），徽标自身点击交给 toggle 不在此关
  useEffect(() => {
    const onDocClick = (e: MouseEvent) => {
      const target = e.target as Element | null;
      if (target && typeof target.closest === "function" && target.closest(".stats-btn, .stats-pop")) return;
      onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("click", onDocClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("click", onDocClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  const rows = deriveUsageRows(state);
  const total = state.usage.total;

  return (
    <div className="stats-pop open" role="dialog" aria-label={t("chat.stats.popTitle")} ref={rootRef}>
      <div className="sp-title">
        <span>{t("chat.stats.popTitle")}</span>
        <span className="total">
          {t("chat.stats.total", {
            tokens: fmtTokens(total.totalTokens),
            cost: total.cost.toFixed(2),
          })}
        </span>
      </div>
      <div className="sp-rows">
        {rows.map((row) => {
          const label = row.id === MAIN_INSTANCE_ID
            ? t(row.chip === "running" ? "chat.stats.mainRunning" : "chat.stats.mainIdle")
            : row.chipLabel;
          const inner = (
            <>
              <span className="kind">
                <span className={cn("hud-dot", CHIP_DOT[row.chip])} aria-hidden="true" />
                <span className="nm">
                  {row.id}
                  <span className="nm-sub"> · {t(row.kindKey)}</span>
                </span>
              </span>
              <span className="model">{row.model}</span>
              <span className="nums">
                <span className="tok">{fmtTokens(row.tokens)}</span>
                <span className="cost">${row.cost.toFixed(2)}</span>
              </span>
              <span className={cn("sp-state", CHIP_CLASS[row.chip])}>{label}</span>
            </>
          );
          return (
            <Fragment key={row.id}>
              {row.action ? (
                <button
                  className="sp-row"
                  type="button"
                  data-row-id={row.id}
                  onClick={() => {
                    if (row.action!.type === "drawer") onOpenInstance?.(row.action!.instanceId);
                    else scrollToLastCompaction();
                    onClose();
                  }}
                >
                  {inner}
                </button>
              ) : (
                <div className="sp-row" data-row-id={row.id}>
                  {inner}
                </div>
              )}
              {row.sub && <div className="sp-sub">{t(`chat.stats.${row.sub.key}`, row.sub.vars)}</div>}
            </Fragment>
          );
        })}
      </div>
      <div className="sp-foot">
        <span className="hud-dot hud-dot-idle" aria-hidden="true" />
        {t("chat.stats.footNote")}
      </div>
    </div>
  );
});
