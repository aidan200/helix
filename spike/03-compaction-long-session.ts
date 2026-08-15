/**
 * 03-compaction-long-session：实测 compaction 长会话行为（必须真实长会话，无 --dry-run 捷径）。
 *
 * 记录点（brief 第 3 项）：
 * - DEFAULT_COMPACTION_SETTINGS 数值 + shouldCompact 触发公式实测；
 * - 真实长会话（多轮灌入）直到触发阈值（为加速触发使用显式缩小的有效窗口，如实记录实际触发值）；
 * - 压缩后 context 形态（CompactionEntry：summary / retainedTail / tokensBefore；buildSessionContext 重建后的消息形状）；
 * - 压缩前后行为连续性（压缩前埋入的专有代号，压缩后仅凭 summary 能否答出 + 会话可继续）；
 * - 本迭代建议参数。
 *
 * 复跑（真实 key，需网络，会产生真实 LLM 费用）：bun run 03-compaction-long-session.ts --home .home
 */
import {
  DEFAULT_COMPACTION_SETTINGS,
  buildSessionContext,
  calculateContextTokens,
  compact,
  estimateContextTokens,
  getLastAssistantUsage,
  prepareCompaction,
  shouldCompact,
} from "@earendil-works/pi-agent-core";
import type { AgentMessage, CompactionSettings, Entry } from "@earendil-works/pi-agent-core";
import { assembleAgent, buildModels, loadHomeConfig, makeLogger, parseSpikeArgs, resolveModel } from "./lib.ts";

const { home } = parseSpikeArgs(Bun.argv);
const config = loadHomeConfig(home);

const log = makeLogger("03");
const models = buildModels();
const model = resolveModel(models, config.model);
const REAL_CONTEXT_WINDOW = (model as any).contextWindow as number;

// 加速触发的实测参数（如实记录：真实窗口远大于此，spike 用有效窗口提前触发）
const EFFECTIVE_CONTEXT_WINDOW = 12_000;
const SPIKE_SETTINGS: CompactionSettings = { enabled: true, reserveTokens: 2_048, keepRecentTokens: 1_500 };

log.script("start", {
  model: `${model.provider}/${model.id}`,
  realContextWindow: REAL_CONTEXT_WINDOW,
  effectiveContextWindow: EFFECTIVE_CONTEXT_WINDOW,
  defaultSettings: DEFAULT_COMPACTION_SETTINGS,
  spikeSettings: SPIKE_SETTINGS,
  shouldCompactFormula: "contextTokens > contextWindow - reserveTokens",
});

const agent = assembleAgent({
  models,
  model,
  apiKeys: config.apiKeys,
  systemPrompt: "You are a spike test agent. Always follow user instructions exactly. Write plain text only.",
  tools: [],
  log,
});

/** transcript → Entry 树（message 链）。compaction 函数族吃 Entry[]，Agent 吐 AgentMessage[]。 */
function messagesToEntries(messages: AgentMessage[]): Entry[] {
  return messages.map((message, i) => ({
    type: "message" as const,
    id: `e${i}`,
    parentId: i === 0 ? null : `e${i - 1}`,
    seq: i,
    timestamp: (message as any).timestamp ?? Date.now(),
    message,
  }));
}

// ---- 长会话灌入：轮次 0 埋代号；之后每轮 ~250 词，直到 shouldCompact 为真 ----
const TOPICS = ["distributed consensus", "LSM trees", "type inference", "vector clocks", "WAL write paths", "compilers", "TCP congestion", "garbage collection", "CRDTs", "B-tree splits", "memory models", "streaming joins", "raft elections", "cache eviction", "spreadsheets", "regular expressions", "digital twins", "elevator scheduling", "hammock physics", "ink drying", "tides", "espresso shots", "cloud formation", "bridge resonance", "pixel shaders", "arrival frequencies"];
await agent.prompt(
  "Remember this for the whole conversation: my secret project codename is MARLIN-77. Reply with exactly one word: NOTED.",
);
await agent.waitForIdle();

let round = 0;
let tokensBefore = 0;
let entries = messagesToEntries(agent.state.messages);
for (;;) {
  const est = estimateContextTokens(agent.state.messages);
  const lastUsage = getLastAssistantUsage(entries);
  const usageTokens = lastUsage ? calculateContextTokens(lastUsage) : 0;
  log.script("round-measure", {
    round,
    estimateTokens: est.tokens,
    usageTokens,
    messageCount: agent.state.messages.length,
    threshold: EFFECTIVE_CONTEXT_WINDOW - SPIKE_SETTINGS.reserveTokens,
  });
  tokensBefore = est.tokens;
  if (shouldCompact(tokensBefore, EFFECTIVE_CONTEXT_WINDOW, SPIKE_SETTINGS)) {
    log.script("compaction-threshold-reached", { tokensBefore, round });
    break;
  }
  if (round >= 40) {
    log.script("abort-too-many-rounds", { round });
    process.exit(1);
  }
  const topic = TOPICS[round % TOPICS.length];
  await agent.prompt(`Write a technical paragraph of exactly 220 words about ${topic}. Plain text, no preamble, no lists.`);
  await agent.waitForIdle();
  entries = messagesToEntries(agent.state.messages);
  round++;
}

// ---- prepareCompaction + compact（真实 LLM 摘要调用） ----
const prepResult = prepareCompaction(entries, SPIKE_SETTINGS);
if (!prepResult.ok) {
  log.script("prepareCompaction-failed", { error: JSON.stringify(prepResult.error).slice(0, 200) });
  process.exit(1);
}
const prep = prepResult.value;
if (!prep) {
  log.script("prepareCompaction-undefined", {});
  process.exit(1);
}
log.script("prepareCompaction-ok", {
  messagesToSummarize: prep.messagesToSummarize.length,
  turnPrefixMessages: prep.turnPrefixMessages.length,
  retainedTail: prep.retainedTail.length,
  isSplitTurn: prep.isSplitTurn,
  tokensBefore: prep.tokensBefore,
  fileOps: { read: prep.fileOps.read.size, written: prep.fileOps.written.size, edited: prep.fileOps.edited.size },
});

const t0 = Date.now();
const compactResult = await compact(
  prep,
  models,
  model,
  "Preserve: any project names or codenames the user mentions, user preferences, and the current task. Be concise.",
  undefined,
  undefined,
);
if (!compactResult.ok) {
  log.script("compact-failed", { error: JSON.stringify(compactResult.error).slice(0, 200) });
  process.exit(1);
}
const cr = compactResult.value;
log.script("compact-ok", {
  durationMs: Date.now() - t0,
  summaryChars: cr.summary.length,
  summaryHead: cr.summary.slice(0, 300),
  retainedTailMessages: cr.retainedTail.length,
  tokensBefore: cr.tokensBefore,
  summaryUsage: cr.usage ? { input: cr.usage.input, output: cr.usage.output, cacheRead: cr.usage.cacheRead ?? 0 } : null,
});

// ---- 压缩后 context 形态：CompactionEntry + retainedTail → buildSessionContext ----
const compactionEntry: Entry = {
  type: "compaction",
  id: `c${entries.length}`,
  parentId: entries.at(-1)!.id,
  seq: entries.length,
  timestamp: Date.now(),
  summary: cr.summary,
  retainedTail: cr.retainedTail,
  tokensBefore: cr.tokensBefore,
  usage: cr.usage,
};
const postEntries: Entry[] = [
  compactionEntry,
  ...cr.retainedTail.map((message, i) => ({
    type: "message" as const,
    id: `r${i}`,
    parentId: i === 0 ? compactionEntry.id : `r${i - 1}`,
    seq: entries.length + 1 + i,
    timestamp: (message as any).timestamp ?? Date.now(),
    message,
  })),
];
const rebuilt = buildSessionContext(postEntries);
log.script("context-rebuilt", {
  messagesBefore: agent.state.messages.length,
  messagesAfter: rebuilt.messages.length,
  firstMessageRole: (rebuilt.messages[0] as any)?.role,
  firstMessageHead: JSON.stringify((rebuilt.messages[0] as any)?.content ?? "").slice(0, 200),
  postCompactionEstimateTokens: estimateContextTokens(rebuilt.messages).tokens,
});

// ---- 行为连续性：换上重建后的 transcript，问只存在于压缩历史里的事实 ----
agent.state.messages = rebuilt.messages;
await agent.prompt("What is my secret project codename? Answer with the codename only.");
await agent.waitForIdle();
const postAnswer = JSON.stringify((agent.state.messages.at(-1) as any)?.content ?? "");
const continuity = /MARLIN-77/i.test(postAnswer);
log.script("continuity-check", { answerHead: postAnswer.slice(0, 200), codenamePreserved: continuity });

// 会话仍可继续（压缩后非终局）
await agent.prompt("Now reply with exactly one word: CONTINUES");
await agent.waitForIdle();
const final = JSON.stringify((agent.state.messages.at(-1) as any)?.content ?? "");
log.script("session-continues", { head: final.slice(0, 120), ok: /CONTINUES/i.test(final) });

log.script("done", {
  conclusion: {
    defaultSettings: DEFAULT_COMPACTION_SETTINGS,
    spikeSettings: SPIKE_SETTINGS,
    triggeredAtTokens: tokensBefore,
    threshold: EFFECTIVE_CONTEXT_WINDOW - SPIKE_SETTINGS.reserveTokens,
    summaryModelUsage: cr.usage ? `${cr.usage.input}in/${cr.usage.output}out` : null,
    codenamePreservedThroughSummary: continuity,
  },
});
