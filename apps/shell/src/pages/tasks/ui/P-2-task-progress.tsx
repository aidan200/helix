/**
 * P-2 任务页进度 tab（T3.1；R-4/R-5）：通用阶段条（stage 行驱动——
 * 序号/✓/●/✕ + 阶段名 + 四态子行，连接线随完成态着色；bootstrap 三阶段
 * 与开放阶段同构零特例）+ 批次节按 stageSeq 分组渲染（每阶段一个小节头：
 * 阶段名 + 状态徽章 + 阶段子行，批次卡归位其下；运行中阶段小节高亮；
 * detail.stages 提供分组顺序与阶段信息——daemon 返回跨阶段全量批次）。
 * 批次卡：范围粗体 + 状态徽章 + retryCount>0 warning 徽数与重试原因 note
 * + 实例徽标（P1-⑥：agent- 短形态，title 持全 id——哪个 agent 在做哪个
 * 批次一眼可见）+ 实例 plan：进度行（ledger 服务端计数）+ 「正在：…」+ 可
 * 展开四态工作台账，abandoned 带理由；未建台账实例如实显「无台账」；
 * 待启动批次队列文案。
 */
import { Fragment } from "react";
import type { TaskBatchDto, TaskDetailDto, TaskStageDto, WorkItemDto } from "@helix/protocol";
import { cn } from "@/shared/lib/cn";
import { EmptyPanel, PhaseBadge, ProgressTrack, fmtInstance } from "./P-2-task-atoms";

type T = (key: string, vars?: Record<string, string | number>) => string;

/** 阶段子行（四态：已完成 / 进行中·批次 x/y / 失败 / 待启动）。 */
function stageSub(stage: TaskStageDto, detail: TaskDetailDto, t: T): string {
  if (stage.status === "done") return t("tk.stageSub.done");
  if (stage.status === "running") {
    const p = detail.progress;
    const batches =
      p !== null && p.batchesTotal > 0
        ? t("tk.stageSub.runningBatches", { done: p.batchesDone, total: p.batchesTotal })
        : "";
    return `${t("tk.stageSub.running")}${batches}`;
  }
  if (stage.status === "failed") return t("tk.stageSub.failed");
  return t("tk.stageSub.pending");
}

/** 通用阶段条（stage 行驱动；连接线 done 着色）。 */
function StageBar({ detail, t }: { detail: TaskDetailDto; t: T }) {
  return (
    <div className="tk-stagebar" data-tk-stagebar>
      {detail.stages.map((stage, i) => (
        <Fragment key={stage.seq}>
          <div className={cn("tk-stage", stage.status)} data-tk-stage={stage.status} data-stage-seq={stage.seq}>
            <span className="tk-stage-ic" aria-hidden="true">
              {stage.status === "done" ? "✓" : stage.status === "failed" ? "✕" : stage.status === "running" ? "●" : stage.seq}
            </span>
            <div style={{ minWidth: 0 }}>
              <div className="tk-stage-name">{stage.name}</div>
              <div className="tk-stage-sub">{stageSub(stage, detail, t)}</div>
            </div>
          </div>
          {i < detail.stages.length - 1 && <div className={cn("tk-stage-conn", stage.status === "done" && "done")} />}
        </Fragment>
      ))}
    </div>
  );
}

/** work item 图标（✓done / ●in_progress / ○pending / ✕abandoned）。 */
function workItemIcon(status: WorkItemDto["status"]): string {
  if (status === "done") return "✓";
  if (status === "in_progress") return "●";
  if (status === "abandoned") return "✕";
  return "○";
}

/** 单批次卡（R-5 + P1-⑥：范围/状态/重试/实例徽标/ledger 进度/正在/台账/无台账）。 */
function BatchCard({
  batch,
  open,
  t,
  onToggle,
}: {
  batch: TaskBatchDto;
  open: boolean;
  t: T;
  onToggle: (batchId: string) => void;
}) {
  const plan = batch.plan;
  const ledger = batch.ledger;
  // 计数摘要服务端收口（AD-4② 同规）：前端零拼装，直接消费 ledger
  const done = ledger?.done ?? 0;
  const ratio = ledger !== null && ledger.total > 0 ? done / ledger.total : 0;
  const doing = plan?.find((w) => w.status === "in_progress");
  return (
    <div className={cn("tk-batch", batch.status === "failed" && "failed")} data-tk-batch data-id={batch.batchId}>
      <div className="tk-b-top">
        <span className="tk-b-scope">{batch.scope}</span>
        <PhaseBadge kind="batch" status={batch.status} label={t(`tk.batch.${batch.status}`)} />
        {batch.instanceId !== null && (
          <span className="tk-b-inst" data-tk-instance title={batch.instanceId}>
            {fmtInstance(batch.instanceId)}
          </span>
        )}
        {batch.retryCount > 0 && (
          <span className="tk-b-retry" data-tk-retry>
            {t("tk.retry", { n: batch.retryCount })}
          </span>
        )}
      </div>
      {batch.status === "pending" ? (
        <div className="tk-b-note" data-tk-batch-queued>
          {t("tk.batchPlan.queue")}
        </div>
      ) : ledger !== null ? (
        <>
          <div className="tk-b-plan">
            <ProgressTrack ratio={ratio} />
            <span className="tk-b-plan-t">{t("tk.batchPlan.doneCount", { done, total: ledger.total })}</span>
          </div>
          {doing !== undefined && (
            <div className="tk-b-current" data-tk-doing>
              <span className="ing">{t("tk.batchPlan.doing")}</span>
              {doing.content}
            </div>
          )}
          <button
            type="button"
            className="tk-b-toggle"
            data-tk-plan-toggle
            data-plan-open={open ? "on" : "off"}
            onClick={() => onToggle(batch.batchId)}
          >
            {open ? t("tk.batchPlan.open") : t("tk.batchPlan.closed")}
          </button>
          {open && (
            <div className="tk-plan-items" data-tk-plan-items>
              {plan?.map((w) => (
                <div key={w.seq} className={cn("tk-pi", w.status)} data-tk-work={w.status}>
                  <span className="tk-pi-ic" aria-hidden="true">
                    {workItemIcon(w.status)}
                  </span>
                  <span className="tk-pi-c">
                    {w.content}
                    {w.note !== null && <span className="tk-pi-n"> {w.note}</span>}
                  </span>
                </div>
              ))}
            </div>
          )}
        </>
      ) : (
        // 未派发或轻量实例未建台账（终态清理后同构）→ 如实呈现，不虚构 0/0
        <div className="tk-b-note" data-tk-plan-none>
          {t("tk.batchPlan.none")}
        </div>
      )}
      {batch.retryNote !== null && (
        <div className="tk-b-note" data-tk-retry-note>
          {batch.retryNote}
        </div>
      )}
    </div>
  );
}

/** 进度 tab 主体（阶段条 + 批次节）。 */
export default function TaskProgressPane({
  detail,
  planOpen,
  t,
  onPlanToggle,
}: {
  detail: TaskDetailDto;
  planOpen: Record<string, boolean>;
  t: T;
  onPlanToggle: (batchId: string) => void;
}) {
  return (
    <>
      <StageBar detail={detail} t={t} />
      <div className="tk-sec">
        <div className="tk-sec-h">{t("tk.batches")}</div>
        {detail.batches.length === 0 ? (
          <EmptyPanel marker="batches" title={t("tk.noBatches.title")} sub={t("tk.noBatches.sub")} />
        ) : (
          detail.stages.map((stage) => {
            const stageBatches = detail.batches.filter((b) => b.stageSeq === stage.seq);
            return (
              <div
                key={stage.seq}
                className={cn("tk-stagegrp", stage.status === "running" && "running")}
                data-tk-stage-group
                data-stage-seq={stage.seq}
                data-stage-status={stage.status}
              >
                <div className="tk-stagegrp-h" data-tk-stage-group-h>
                  <span className="tk-stagegrp-name">{stage.name}</span>
                  <PhaseBadge kind="stage" status={stage.status} label={t(`tk.stage.${stage.status}`)} />
                  <span className="tk-stagegrp-sub">{stageSub(stage, detail, t)}</span>
                </div>
                {stageBatches.map((b) => (
                  <BatchCard key={b.batchId} batch={b} open={planOpen[b.batchId] === true} t={t} onToggle={onPlanToggle} />
                ))}
              </div>
            );
          })
        )}
      </div>
    </>
  );
}
