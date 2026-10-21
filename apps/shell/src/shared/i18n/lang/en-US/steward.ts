/** en-US 词条分片：steward 域（barrel 见 ../en-US.ts）。
 *
 * 业务域分片重构（体量门）：词条自原 en-US.ts 原样迁移（零改写）；
 * 结构一致性由 `satisfies Pick<Translations, 域名>` 编译期兜底。
 */
import type { Translations } from "../zh-CN";

export const steward = {
  steward: {
    title: "Text Steward",
    close: "Close",
    stateOn: "Active",
    stateOff: "Off",
    disabledTitle: "Steward is off",
    disabledHint: "The steward switch is off by default; enable it in Settings → General to ask about global state here. Write actions need confirmation.",
    feedTitle: "Event feed",
    feedEmpty: "No events yet",
    thinking: "Thinking…",
    // ── Process-feedback UI batch: activity status text (tool phase) ──
    activityTool: "Running {name}…",
    // ── Orb tool-badge batch: orb tool line prefix (panel keeps activityTool) ──
    activityToolPrefix: "Running",
    // ── A1 work-memory batch: process visibility (thinking fold / tool rows / new chat) ──
    thinkingLabel: "Reasoning",
    newChat: "New chat",
    newChatTitle: "Clear the current conversation (steward memory and display reset together)",
    activity: {
      openTitle: "View activity timeline",
      pageTitle: "Steward activity",
      rangeToday: "Today",
      rangeYesterday: "Yesterday",
      rangeThisWeek: "This week",
      rangeAll: "All",
      refresh: "Refresh",
      clear: "Clear log",
      clearArmed: "Confirm clear",
      empty: "No activity in this time range yet",
      loading: "Loading activity…",
      live: "Live",
      domainTask: "Task",
      domainSession: "Session",
      domainAgent: "Agent",
      domainSurface: "Surface",
      domainCli: "Terminal",
      domainNotify: "Notice",
      attributionUser: "Me",
      attributionSteward: "Steward",
      attributionSystem: "System",
    },
    memory: {
      pageTitle: "Steward memory",
      openTitle: "Manage long-term memory",
      searchPlaceholder: "Search memory…",
      stats: "{count} entries · {dim}d",
      statsFaded: "Faded {count}",
      statsPinned: "Pinned {count}",
      add: "Add",
      addModalTitle: "Add memory",
      addModalSub: "Saved entries are vectorized via the current endpoint; manually added entries never fade",
      textLabel: "Memory text",
      kindLabel: "Kind",
      emptyTextErr: "Memory text must not be empty",
      empty: "No memory entries",
      vectorizing: "Vectorizing…",
      unavailable: "Memory disabled or endpoint not ready (Settings → General → Long-term memory)",
      justNow: "Just now",
      source: {
        manual: "Manual",
        stewardTurn: "Conversation",
        sessionSummary: "Session summary",
        sessionProgress: "Session progress",
        autoSediment: "Auto-saved",
      },
      // ── Domain dimension batch: business domain (badge/filter/append tagging) ──
      domain: {
        habit: "Habit",
        general: "General",
        project: "Project",
      },
      domainLabel: "Domain",
      projectLabel: "Project",
      projectPlaceholder: "Project directory name (e.g. helix)",
      filterKindAll: "All kinds",
      filterDomainAll: "All domains",
      // ── Forgetting batch: filter/sort/pagination/faded/pin ──
      filterAll: "All",
      filterActive: "Active",
      filterFaded: "Faded",
      filterPinned: "Pinned",
      sortUpdated: "Recently updated",
      sortCreated: "Oldest first",
      sortRecalled: "Most recalled",
      fadedChip: "Fading",
      pinnedChip: "Pinned",
      pinAction: "Pin",
      unpinAction: "Unpin",
      restoreAction: "Restore",
      recalledNever: "Never recalled",
      recalledTimes: "Recalled {n}×",
      lastRecalled: "Last recalled {span}",
      pageSizeLabel: "Per page",
      pageRange: "{from}–{to} of {total}",
    },
    inputPlaceholder: "Ask the steward: what is running now?",
    send: "Send",
    // Manual-stop batch: in-flight stop button + stopped ack copy ({count} interpolation)
    stop: "Stop",
    stoppedNotice: "Stopped the current processing",
    stoppedNoticeDropped: "Stopped the current processing ({count} queued input(s) dropped)",
    // L1 queue batch: queued ack copy ({position} interpolation)
    askQueued: "Queued (position {position}) — starts right after the current reply finishes",
    // M3-a (CAND-601): proactive report live-frame copy — byte-identical to the
    // daemon work-memory record (replay parity: the record is always Chinese, so
    // en mirrors zh verbatim by design)
    proactiveTitle: "【主动汇报】{title}",
    proactiveSuggestion: "建议：{label}（点按才动）",
    memoryAdded: "Saved to long-term memory",
    memoryUpdated: "Memory updated (overwritten)",
    confirmTitle: "Write action needs confirmation",
    confirmTarget: "Target",
    confirmBody: "Message",
    confirmYes: "Confirm",
    confirmNo: "Dismiss",
    // ── B1 global confirm stack (bottom-left ConfirmStack) + navigate toast ──
    cardAccepted: "Accepted…",
    cardDone: "Done",
    cardMore: "{n} more",
    actionDone: "Action completed",
    actionFailed: "Action failed",
    // ── Voice mode (V3a: dual-mode switch + talk loop panel face; text mode never speaks) ──
    voice: {
      // ── B2 global voice batch: orb layer (StewardVoiceLayer) ──
      welcome: "I'm listening.",
      orbLabel: "Steward voice",
      orbMuted: "Mic muted; tap to unmute",
      orbStopRead: "Tap to stop reading",
      // ── Orb health badges batch: top-left TTS queue count + top-right degraded chips ──
      orbQueueBadge: "TTS queue: {n}",
      orbHealthJudge: "Judge",
      orbHealthTts: "TTS",
      orbHealthStt: "STT",
      orbHealthLlm: "Model",
      orbHealthTitle: "Voice chain degraded: {list}",
      cmdConfirmOk: "Confirmed {target}",
      cmdCancelOk: "Cancelled {target}",
      cmdNoCards: "No cards awaiting confirmation",
      cmdNotFound: "No card #{n}",
      cmdSettled: "Card #{n} was already handled",
      cmdCancelAllOk: "Cancelled {n} pending cards",
      // ── ③ Voice outreach (voice-loop batch): short announce on card pop (active voice session only) ──
      cardPending: "A delivery is waiting for your confirmation",
      // ── M3-c voiceprint batch: plain-language reject at the authorization gate ──
      inputVoiceprintReject: "Voiceprint not matched (similarity {pct}%, threshold {th}%)",
      inputJudgeReject: "Not directed at the steward",
      inputAsrFail: "Transcription failed",
      // batch 3b retired: bargeInQueued/bargeInVerifySkip (queue interjection + skip notice) per ruling #2
    },
  },
} satisfies Pick<Translations, "steward">;
