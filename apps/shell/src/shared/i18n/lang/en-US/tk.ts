/** en-US 词条分片：tk 域（barrel 见 ../en-US.ts）。
 *
 * 业务域分片重构（体量门）：词条自原 en-US.ts 原样迁移（零改写）；
 * 结构一致性由 `satisfies Pick<Translations, 域名>` 编译期兜底。
 */
import type { Translations } from "../zh-CN";

export const tk = {
  // ── P-2 tasks page (T3.1; iter-20260829-ys7q; copy source = prototype/P-2-task.html + review.md R-1~R-9/R-19)──
  tk: {
    title: "Tasks",
    status: {
      pending: "Assembling",
      running: "Running",
      paused: "Paused",
      done: "Done",
      failed: "Failed",
      cancelled: "Cancelled",
    },
    stage: { pending: "Queued", running: "In progress", done: "Done", failed: "Failed" },
    batch: { pending: "Queued", running: "In progress", done: "Done", failed: "Failed" },
    filter: { all: "All", allProjects: "All projects" },
    countLine: "{n} tasks · running first",
    list: {
      progPending: "Assembling",
      progDone: "All done",
      progFailed: "Failed",
      progCancelled: "Cancelled",
      progRunning: "{stage} · batch {done}/{total}",
      progPaused: "{stage} · batch {done}/{total}",
      created: "Created {at}",
    },
    dur: {
      sec: "{n}s",
      min: "{n} min",
      hourMin: "{h}h {m}m",
      running: "Running for {dur}",
      final: "Ran {dur}",
      createdAgo: "Created {dur} ago",
    },
    emptyList: {
      title: "No tasks yet",
      sub: "Tasks start from a host context: pick a project on the Project page to create a kg-bootstrap task, or ask the MainAgent in a session. Created tasks appear here.",
      cta: "Open the Project page →",
    },
    emptyDetail: { title: "Nothing to show", sub: "Once created, tasks show stage progress, batch mid-states and results here." },
    noSelect: { title: "No task selected", sub: "Pick a task from the list to see stage progress, batch mid-states and results." },
    filterEmpty: {
      title: "No matching tasks",
      sub: "No tasks under the current status / project filters. Try adjusting them.",
      clear: "Clear filters",
    },
    head: { created: "Created {at}", srcPage: "From Project page", srcChat: "From session", goProject: "Open the Project page →" },
    act: { pause: "Pause", resume: "Resume", cancel: "Cancel", retry: "Retry", delete: "Delete" },
    confirm: {
      cancelText:
        "Cancel task \"{title}\"? In-flight batches wind down, completed stage output stays (confirmed knowledge), queued batches never start. Cancellation is irreversible.",
      cancelYes: "Confirm cancel",
      deleteText:
        "Delete task \"{title}\"? This clears all task-domain records for it (task / stage / batch rows and per-batch instance work ledgers) irreversibly; kg output (knowledge nodes) is untouched and remains viewable and fixable on the Project page.",
      deleteYes: "Confirm delete",
      back: "Back",
    },
    toast: {
      paused: "Task paused: current batch finishes, no new batches dispatched",
      resumed: "Task resumed: batch dispatch continues from the pause point",
      retried: "Task retried: failed batch budget reset, continuing from the failed stage (completed stages are not re-run)",
      cancelled: "Task cancelled: completed stage output kept (confirmed)",
      deleted: "Task deleted: {title} (task-domain records cleared, kg output kept)",
      failed: "Action failed: {msg}",
      sendFailed: "Send failed: daemon connection unavailable, retry later",
    },
    stageSub: {
      done: "Done",
      running: "In progress",
      runningBatches: " · batch {done}/{total}",
      failed: "Failed",
      pending: "Queued",
      prep: "Preparing (orchestrator-run)",
      toAggregate: "Awaiting aggregation (orchestrator-run)",
    },
    batches: "Batches",
    noBatches: {
      title: "Batches not yet divided",
      sub: "Once assembly finishes the orchestrator divides batches per stage; instance work ledgers appear here in real time.",
    },
    batchPlan: {
      doneCount: "{done}/{total} items done",
      doing: "Doing:",
      open: "Collapse ledger ▴",
      closed: "Expand ledger ▾",
      queue: "Queued: batch scope set, waiting for dispatch.",
      none: "No work ledger for this instance.",
    },
    retry: "Auto-retried {n} times",
    /** History prefix for retained retryNote once the batch is past the failure (done / re-dispatched running). */
    retryNoteHistory: "History: {note}",
    /** ⑤ 链 A：批次行实例徽标 parked 形态尾缀（「agent-3 · Parked (task paused)」）。 */
    instParked: "Parked (task paused)",
    result: {
      tabProgress: "Progress",
      tabResult: "Task Results",
      emptyTitle: "No stage output yet",
      emptySub: "When a stage completes, the orchestrator aggregates its output node set and summary here.",
      errorTitle: "Failed to load artifacts",
      errorSub: "Something went wrong while fetching stage output. You can retry.",
      retry: "Retry",
    },
  },
} satisfies Pick<Translations, "tk">;
