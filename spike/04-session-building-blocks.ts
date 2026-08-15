/**
 * 04-session-building-blocks：session 积木可用性实测（Entry 树 + LaneRecord 双层日志）。
 *
 * 记录点（brief 第 4 项）：
 * - Entry 类型枚举（7 种）+ 树完整性（parentId 链）——内存与 JSONL 两态；
 * - LaneRecord 双层日志（9 种 record）+ getLog 混合全序 + 防重入语义；
 * - 内存/JSONL 持久化最小 API（create/append/读回）；NodeExecutionEnv 可直接作
 *   JsonlSessionRepo 的 fs（鸭子类型覆盖全部 12 方法，无需手写适配器）；
 * - 崩溃恢复读回语义：append-only 即写即落盘；findOpenOperations 0/1/2 = idle/suspended/corrupt；
 *   恢复粒度 = Entry 树全量 + LaneRecord 全量（含 steer 队列记录）+ buildSessionContext 重建 context。
 *
 * 纯结构操作，无 LLM、无网络、无 key。复跑：bun run 04-session-building-blocks.ts
 */
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  InMemorySessionRepo,
  JsonlSessionRepo,
  SessionError,
  buildSessionContext,
} from "@earendil-works/pi-agent-core";
import type { AgentMessage, Entry, LaneRecord } from "@earendil-works/pi-agent-core";
import { NodeExecutionEnv, makeLogger } from "./lib.ts";

const log = makeLogger("04");
log.script("start", { offline: true, llm: false, network: false });

const userMsg = (text: string): AgentMessage =>
  ({ role: "user", content: text, timestamp: Date.now() }) as AgentMessage;
const asstMsg = (text: string): AgentMessage =>
  ({ role: "assistant", content: [{ type: "text", text }], stopReason: "stop", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0 } }) as unknown as AgentMessage;

// ============ A. InMemory：Entry 类型枚举 + 树完整性 ============
{
  const repo = new InMemorySessionRepo();
  const session = await repo.create({});
  const entryIds: string[] = [];
  entryIds.push(await session.appendMessage(userMsg("第一轮：用户问题")));
  entryIds.push(await session.appendMessage(asstMsg("第一轮：助手回答")));
  entryIds.push(
    await session.appendEntry({ type: "model_change", id: "mc1", provider: "zai-coding-cn", modelId: "glm-5.3" }, "main"),
  );
  entryIds.push(await session.appendEntry({ type: "thinking_level_change", id: "tl1", thinkingLevel: "high" }, "main"));
  entryIds.push(await session.appendEntry({ type: "active_tools_change", id: "at1", activeToolNames: ["bash", "read"] }, "main"));
  entryIds.push(
    await session.appendEntry({ type: "compaction", id: "cp1", summary: "S1: 会话前半摘要…", retainedTail: [userMsg("尾部保留消息")], tokensBefore: 12345 }, "main"),
  );
  entryIds.push(
    await session.appendEntry({ type: "branch_summary", id: "bs1", fromId: entryIds[1], summary: "分支摘要" }, "main"),
  );
  entryIds.push(await session.appendCustomEntry("app.marker", { spike: true }));

  const entries = await session.findEntries({ order: "oldestFirst" });
  const types = [...new Set(entries.map((e) => e.type))].sort();
  // 树完整性：每个 entry 的 parentId 必须指向已存在的 entry（或 null=根）
  const byId = new Map(entries.map((e) => [e.id, e]));
  const broken = entries.filter((e) => e.parentId !== null && !byId.has(e.parentId));
  // 链完整性：沿 parentId 从叶子回溯必须可达根且步数=深度
  const leaf = entries.at(-1)!;
  const path: string[] = [];
  for (let cur: Entry | undefined = leaf; cur; ) {
    path.push(cur.id);
    cur = cur.parentId ? byId.get(cur.parentId) : undefined;
  }
  log.script("A.entry-tree", {
    appended: 8,
    entryTypes: types,
    expectedTypes: ["active_tools_change", "branch_summary", "compaction", "custom", "message", "model_change", "thinking_level_change"],
    brokenParentRefs: broken.length,
    leafToRootPathLen: path.length,
    chainIntact: path.length === entries.length && path.at(-1) === entries[0].id,
    laneLeaf: (await session.getLanes()).map((l) => ({ lane: l.lane, leafId: l.leafId?.slice(0, 12) })),
  });
}

// ============ B. LaneRecord 双层日志 + getLog 全序 + 防重入 ============
{
  const repo = new InMemorySessionRepo();
  const session = await repo.create({});
  const leafBefore = await session.getLeafId();
  await session.appendMessage(userMsg("带工具的一轮"));
  const records: LaneRecord[] = [
    {
      type: "operation_started", id: "op-1", lane: "main", sourceLeafId: leafBefore,
      intent: { kind: "run", originalPrompt: [userMsg("带工具的一轮")], initialMessages: [{ type: "message", id: "seed", message: userMsg("带工具的一轮") }] },
    },
    { type: "queue_enqueued", id: "q1", lane: "main", queue: "steer", runId: "op-1", target: { type: "message", id: "st1", message: userMsg("中途 steer 指令") } },
    { type: "tool_started", id: "t1", lane: "main", runId: "op-1", assistantEntryId: "e1", toolIndex: 0, toolCallId: "call_abc", toolName: "bash", effectiveArgs: { command: "echo hi" }, resultEntryId: "r1", replay: "safe" },
    { type: "usage", id: "u1", lane: "main", usage: { input: 100, output: 20, cacheRead: 0, cacheWrite: 0, cost: 0.001 }, cause: "assistant", runId: "op-1", entryId: "e1", attempt: 1, stopReason: "toolUse" },
    { type: "abort_requested", id: "ab1", lane: "main", runId: "op-1" },
    { type: "operation_finished", id: "of1", lane: "main", runId: "op-1", outcome: "aborted" },
  ];
  for (const r of records) await session.appendRecord(r as never);

  const steerRecords = await session.findRecords({ type: "queue_enqueued" });
  const ops = await session.findOpenOperations("main");
  const allRecords = await session.findRecords();
  const logItems = await session.getLog();
  const kinds = logItems.map((i) => (i.kind === "entry" ? `entry:${i.entry.type}` : i.kind === "record" ? `record:${i.record.type}` : i.kind === "lane" ? "lane" : `fact:${i.fact}`));
  // 防重入：lane 已有 open operation 时再 append operation_started 必须抛 SessionError
  let reopenRejected: string | null = null;
  try {
    await session.appendRecord({ type: "operation_started", id: "op-2", lane: "main", sourceLeafId: null, intent: { kind: "run", originalPrompt: [], initialMessages: [] } } as never);
  } catch (err) {
    reopenRejected = err instanceof SessionError ? `${err.code}: ${err.message.slice(0, 60)}` : String(err);
  }
  log.script("B.lane-records", {
    recordTypes: [...new Set(allRecords.map((r) => r.type))].sort(),
    steerQueueReadable: steerRecords.length === 1 && steerRecords[0].type === "queue_enqueued",
    openOpsAfterFinish: ops.length,
    logItemKinds: kinds,
    globalSeqMonotonic: logItems.every((i, idx) => idx === 0 || i.seq > logItems[idx - 1].seq),
    reopenRejected,
  });

  // 悬挂操作语义：operation_started 后无 finished（模拟崩溃前）
  const repo2 = new InMemorySessionRepo();
  const s2 = await repo2.create({});
  await s2.appendMessage(userMsg("悬挂轮"));
  await s2.appendRecord({ type: "operation_started", id: "op-x", lane: "main", sourceLeafId: null, intent: { kind: "run", originalPrompt: [], initialMessages: [] } } as never);
  const suspended = await s2.findOpenOperations("main");
  // 防重入：lane 已有悬挂 operation 时，第二个 operation_started 必须被拒
  let suspendedReopenRejected: string | null = null;
  try {
    await s2.appendRecord({ type: "operation_started", id: "op-y", lane: "main", sourceLeafId: null, intent: { kind: "run", originalPrompt: [], initialMessages: [] } } as never);
  } catch (err) {
    suspendedReopenRejected = err instanceof SessionError ? `${err.code}: ${err.message.slice(0, 60)}` : String(err);
  }
  log.script("B.suspended-op", {
    openOps: suspended.length,
    semantics: "0=idle / 1=suspended(可恢复) / 2=corrupt（types.d.ts findOpenOperations 文档）",
    suspendedReopenRejected,
  });
}

// ============ C+D. JSONL 持久化 + 崩溃恢复读回 ============
{
  const root = mkdtempSync(join(tmpdir(), "spike04-sessions-"));
  const workCwd = join(root, "proj");
  const env = new NodeExecutionEnv({ cwd: workCwd }); // NodeExecutionEnv 直接作 fs（12 方法鸭子覆盖）

  const repo = new JsonlSessionRepo({ fs: env as never, sessionsRoot: root });
  const session = await repo.create({ cwd: workCwd });
  await session.appendMessage(userMsg("JSONL 第一轮用户"));
  await session.appendMessage(asstMsg("JSONL 第一轮助手"));
  await session.appendCustomEntry("app.checkpoint", { n: 1 });
  await session.appendEntry({ type: "compaction", id: "cp-j1", summary: "J1 摘要", retainedTail: [userMsg("尾部消息")], tokensBefore: 5000 }, "main");
  // 崩溃模拟：operation_started + queue_enqueued(steer) 已落盘，但永远等不到 operation_finished
  await session.appendRecord({ type: "operation_started", id: "op-j", lane: "main", sourceLeafId: null, intent: { kind: "run", originalPrompt: [userMsg("JSONL 第二轮")], initialMessages: [] } } as never);
  await session.appendRecord({ type: "queue_enqueued", id: "q-j", lane: "main", queue: "steer", runId: "op-j", target: { type: "message", id: "st-j", message: userMsg("崩溃前 steer") } } as never);
  const wroteEntries = await session.findEntries();
  const jsonlPath = (await session.getMetadata()).path;

  // ---- “进程崩溃后重启”：新 repo 实例从同一 sessionsRoot 打开（replay append-only 日志） ----
  const repo2 = new JsonlSessionRepo({ fs: env as never, sessionsRoot: root });
  const listed = await repo2.list();
  const reopened = await repo2.open(listed[0]);
  const readBack = await reopened.findEntries({ order: "oldestFirst" });
  const readRecords = await reopened.findRecords();
  const suspended2 = await reopened.findOpenOperations("main");
  const steerBack = readRecords.filter((r) => r.type === "queue_enqueued");
  // 恢复粒度③：buildSessionContext 从 Entry 树重建 LLM context
  const rebuilt = buildSessionContext(readBack);

  // JSONL 物理形态（前 6 行）
  const rawLines = readFileSync(jsonlPath, "utf8").trim().split("\n");
  log.script("C.jsonl-persist", {
    sessionsListed: listed.length,
    jsonlPath: jsonlPath.replace(root, "<root>"),
    physicalLines: rawLines.length,
    headLines: rawLines.slice(0, 6).map((l) => l.slice(0, 130)),
    fsAdapter: "NodeExecutionEnv 直接作 JsonlSessionRepoFileSystem（Pick<FileSystem,12方法> 全覆盖，0 行适配代码）",
  });
  log.script("D.crash-recovery", {
    entriesBeforeCrash: wroteEntries.length,
    entriesReadBack: readBack.length,
    entriesRoundTrip: wroteEntries.length === readBack.length,
    entryTypesReadBack: [...new Set(readBack.map((e) => e.type))].sort(),
    recordsReadBack: readRecords.length,
    suspendedOperation: suspended2.length === 1 && suspended2[0].id === "op-j",
    steerQueueSurvivesCrash: steerBack.length === 1,
    rebuiltContextMessages: rebuilt.messages.length,
    rebuiltFirstRole: (rebuilt.messages[0] as { role?: string })?.role,
    writeMode: "appendMutation → fs.appendFile 逐条落盘（即写即持久，无显式 flush/drain 需求；drain 仅 fork/batch 用）",
  });
}

log.script("done", {
  conclusion: {
    entryEnum: "7 类：message/model_change/thinking_level_change/active_tools_change/compaction/branch_summary/custom（全部可经 appendEntry/appendCustomEntry 构造，parentId 链自动接 lane leaf）",
    laneRecordEnum: "9 类：operation_started/abort_requested/operation_finished/step_attempt/tool_started/queue_enqueued/queue_cancelled/write_deferred/usage",
    minimalApi: "Session: appendMessage/appendEntry/appendRecord/findEntries/findRecords/findOpenOperations/getLog；Repo: create/open/list/delete/fork",
    crashRecovery: "JSONL append-only 逐条落盘；重开=replay；恢复粒度=Entry 树全量+LaneRecord 全量（含 steer 队列）；findOpenOperations 0/1/2=idle/suspended/corrupt",
    guardRail: "同 lane 第二个 operation_started 抛 SessionError(storage) —— 防并发操作重入",
  },
});
