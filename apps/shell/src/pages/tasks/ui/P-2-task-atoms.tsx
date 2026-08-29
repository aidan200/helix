/**
 * P-2 任务页展示原子（T3.1）：徽章 / 进度条 / 骨架 / 空态面板。
 *
 * 纯展示（零数据面）：六态任务徽章经 hud-badge + st-* 语义修饰类（类名 =
 * wire 枚举，tasks-model taskStatusDisplay 单源）；类型徽章 violet 族；
 * kind 徽章按 rule/entity/contract 映射既有语义色、未知 kind 降档。
 * AD-4/AG-16：裸 id 零界面（jobId/batchId/nodeId 只进 data-id 属性）；
 * 文案全部经 t() 注入（组件源码零硬编码 CJK）。
 */
import type { ReactNode } from "react";
import type { TaskStatus } from "@helix/protocol";
import { cn } from "@/shared/lib/cn";
import { elapsedSpan, taskStatusDisplay } from "../model/tasks-model";

type T = (key: string, vars?: Record<string, string | number>) => string;

/** 六态任务徽章（running 带脉冲点；st-* 类名 = wire 枚举）。 */
export function TaskStatusBadge({ status, t }: { status: TaskStatus; t: T }) {
  const view = taskStatusDisplay(status);
  return (
    <span className={cn("hud-badge", view.badge)} data-task-status={status}>
      {status === "running" && <span className="tk-dot-run" aria-hidden="true" />}
      {t(view.labelKey)}
    </span>
  );
}

/** 任务类型徽章（机器类型 = skill 名；violet 族）。 */
export function TaskTypeBadge({ type }: { type: string }) {
  return (
    <span className="hud-badge tk-type-badge" data-task-type={type}>
      {type}
    </span>
  );
}

/** 阶段/批次四态徽章（pending/running/done/failed 复用六态类子集）。 */
export function PhaseBadge({
  status,
  label,
  kind,
}: {
  status: "pending" | "running" | "done" | "failed";
  label: string;
  kind: "stage" | "batch";
}) {
  return (
    <span className={cn("hud-badge", `st-${status}`)} data-phase={kind} data-phase-status={status}>
      {status === "running" && <span className="tk-dot-run" aria-hidden="true" />}
      {label}
    </span>
  );
}

/** kind 徽章（结果查询节点；rule=accent / entity=violet / contract=search）。 */
export function KindBadge({ kind }: { kind: string }) {
  const cls = kind === "rule" || kind === "entity" || kind === "contract" ? `tk-kind-${kind}` : "tk-kind-other";
  return (
    <span className={cn("hud-badge", cls)} data-node-kind={kind}>
      {kind}
    </span>
  );
}

/** 项目 chip 组（0..n 有才显示；AD-8）。 */
export function ProjectChips({ projects }: { projects: readonly string[] }) {
  if (projects.length === 0) return null;
  return (
    <>
      {projects.map((p) => (
        <span className="hud-chip" key={p} data-proj={p}>
          {p}
        </span>
      ))}
    </>
  );
}

/** 进度条（scaleX 填充；ok/err 语义变体；transform-only 动效）。 */
export function ProgressTrack({
  ratio,
  tone = "accent",
}: {
  ratio: number;
  tone?: "accent" | "ok" | "err";
}) {
  const clamped = Math.max(0, Math.min(1, ratio));
  return (
    <div className="tk-progress">
      <div
        className={cn("tk-progress-fill", tone === "accent" ? undefined : tone)}
        style={{ transform: `scaleX(${clamped})` }}
      />
    </div>
  );
}

/** 骨架（loading 态；与目标布局同构）。 */
export function TaskSkeleton({ lines = 4 }: { lines?: number }) {
  const widths = ["52%", "80%", "64%", "74%", "46%"];
  return (
    <div className="tk-skel" data-tk-skeleton>
      {Array.from({ length: lines }, (_, i) => (
        <div className="tk-skel-line" key={i} style={{ width: widths[i % widths.length] }} />
      ))}
    </div>
  );
}

/** 空态面板（列表空态/过滤无匹配/详情空/无产物共用骨架）。 */
export function EmptyPanel({
  title,
  sub,
  action,
  marker,
}: {
  title: string;
  sub: string;
  action?: ReactNode;
  marker: string;
}) {
  return (
    <div className="tk-empty" data-tk-empty={marker}>
      <div className="tk-empty-t">{title}</div>
      <div className="tk-empty-s">{sub}</div>
      {action}
    </div>
  );
}

/** ISO → 「MM-DD HH:mm」短格式（非法输入原样返回；ProjectPage 同款口径）。 */
export function fmtShort(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const p2 = (n: number) => String(n).padStart(2, "0");
  return `${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}`;
}

/** elapsedSpan 结构 → 展示串（i18n 组装点）。 */
export function fmtElapsed(ms: number, t: T): string {
  const span = elapsedSpan(ms);
  if (span.key === "sec") return t("tk.dur.sec", { n: span.n });
  if (span.key === "min") return t("tk.dur.min", { n: span.n });
  return t("tk.dur.hourMin", { h: span.h, m: span.m });
}
