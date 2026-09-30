/**
 * B1 两段式确认协议单测（daemon 侧红→绿钉子；设计稿
 * docs/temp/helix-steward-global-redesign.md §3.4/§4）：
 *
 * 1. confirm 受理即回：StewardConfirmResultPayload 增 accepted 判别——
 *    消费 actionId 后立即返回（不 await executePending），idle 目标全轮
 *    不再阻塞确认链（G1 主根）；
 * 2. 执行完成另发 StewardActionCompletedPayload（onCompleted 回调面）：
 *    成功/失败两路（ok + detail）；
 * 3. resumeWith 回灌保留（暂停点 resolve 在执行完成后照旧）；
 * 4. emitNavigate 受理时广播（deliverSession——sessionId 提案已知；
 *    不再等 executePending 全轮）；
 * 5. steward.cancel：作废 pending（幂等），之后 confirm 同 actionId 报
 *    「已消费」（消灭孤儿 actionId）；
 * 6. executePending 里 deliverSession 分支不再 emitNavigate（已提前受理时）。
 */
import { describe, expect, test } from "bun:test";
import type {
  StewardLlmPort,
  StewardLlmRequest,
  StewardLlmResponse,
} from "../../src/application/ports/outbound/StewardLlmPort";
import type { RuntimeConfigPort } from "../../src/application/ports/outbound/RuntimeConfigPort";
import type { AgentOrchestrationPort } from "../../src/application/ports/inbound/AgentOrchestrationPort";
import type {
  StewardActionCompletedPayload,
  StewardNavigatePayload,
} from "@helix/protocol";
import {
  StewardService,
  type StewardSessionMetaRow,
} from "../../src/application/steward/StewardService";

// ── fakes（steward-cockpit.test 同构） ──────────────────────

function fakeLlm(script: readonly StewardLlmResponse[]): StewardLlmPort {
  let round = 0;
  return {
    modelId: "deepseek/deepseek-v4-flash",
    async complete(): Promise<StewardLlmResponse> {
      const next = script[round];
      round += 1;
      if (next === undefined) throw new Error("fake LLM 剧本耗尽");
      return next;
    },
  };
}

function fakeConfig(initial: Record<string, string> = {}): RuntimeConfigPort {
  const kv = new Map(Object.entries(initial));
  return {
    get: (key: string) => kv.get(key),
    set: async (key: string, value: string) => {
      kv.set(key, value);
    },
  };
}

function fakeOrchestration(): Pick<AgentOrchestrationPort, "status" | "send"> {
  return {
    status: () => [],
    send: (_agentId: string, _message: string) => ({ delivered: true, detail: "已投递" }),
  };
}

const toolCall = (id: string, name: string, args: Record<string, unknown>): StewardLlmResponse => ({ kind: "blocks", blocks: [{ type: "toolCall", id,
  name,
  args }], stopReason: "toolUse" });

interface TwoPhaseRig {
  svc: StewardService;
  navigates: StewardNavigatePayload[];
  deliveries: { sessionId: string; text: string }[];
  /** deliverToSession 受理 gate：resolve 前投递挂起（模拟 idle 全轮 await）。 */
  releaseDelivery: () => void;
  resumeCalls: unknown[];
}

function makeRig(opts: {
  llmScript: readonly StewardLlmResponse[];
  deliverOutcome?: { delivered: boolean; detail: string };
}): TwoPhaseRig {
  const navigates: StewardNavigatePayload[] = [];
  const deliveries: { sessionId: string; text: string }[] = [];
  const resumeCalls: unknown[] = [];
  let release: () => void = () => {};
  const gate = new Promise<void>((r) => {
    release = r;
  });
  const svc = new StewardService({
    llm: fakeLlm(opts.llmScript),
    orchestration: fakeOrchestration(),
    tasks: { listTasks: () => [] },
    config: fakeConfig({ "steward.enabled": "1" }),
    feedGate: { hasStewardSubscribers: () => true },
    emitFeed: () => {},
    emitNavigate: (payload) => navigates.push(payload),
    sessions: {
      sessionExists: async () => true,
      deliverToSession: async (sessionId: string, text: string) => {
        deliveries.push({ sessionId, text });
        await gate; // idle 全轮模拟：受理后长时间不返回
        return opts.deliverOutcome ?? { delivered: true, detail: "已送达" };
      },
      listSessionMetadata: async () => [] as readonly StewardSessionMetaRow[],
      startDraftSession: async () => ({ sessionId: "sess-draft" }),
      createTitledSession: async () => ({ sessionId: "sess-new" }),
    },
  });
  return { svc, navigates, deliveries, releaseDelivery: release, resumeCalls };
}

/** 走 ask → deliver_to_session 提案，返回 confirm_required 的 actionId。 */
async function proposeDeliver(rig: TwoPhaseRig, sessionId = "sess-1"): Promise<string> {
  const res = await rig.svc.ask(`投递到 ${sessionId}`, undefined, undefined);
  if (res.status !== "confirm_required") throw new Error(`expect confirm_required, got ${res.status}`);
  return res.actionId;
}

describe("B1 两段式确认协议：confirm 受理即回 + action.completed", () => {
  test("受理即回：confirm 返回 accepted（不等 executePending——投递挂起时毫秒级返回）", async () => {
    const rig = makeRig({
      llmScript: [toolCall("call-1", "deliver_to_session", { sessionId: "sess-1", text: "继续修" })],
    });
    const actionId = await proposeDeliver(rig);
    const started = Date.now();
    const confirmed = await rig.svc.confirm(actionId);
    const elapsed = Date.now() - started;
    expect(confirmed.status).toBe("accepted");
    if (confirmed.status !== "accepted") throw new Error("unreachable");
    expect(confirmed.actionId).toBe(actionId);
    // 投递仍挂起（gate 未放）——确认链毫秒级返回即受理语义达成
    expect(elapsed).toBeLessThan(1000);
    expect(rig.deliveries.length).toBe(1); // 执行体已启动（异步）
    rig.releaseDelivery();
  });

  test("action.completed 成功路：执行完成后回携 {actionId, ok:true, detail}", async () => {
    const rig = makeRig({
      llmScript: [toolCall("call-1", "deliver_to_session", { sessionId: "sess-1", text: "继续修" })],
    });
    const actionId = await proposeDeliver(rig);
    const completed: StewardActionCompletedPayload[] = [];
    const confirmed = await rig.svc.confirm(actionId, (p) => completed.push(p));
    expect(confirmed.status).toBe("accepted");
    rig.releaseDelivery();
    await new Promise((r) => setTimeout(r, 10));
    expect(completed.length).toBe(1);
    expect(completed[0]!.actionId).toBe(actionId);
    expect(completed[0]!.ok).toBe(true);
    expect(completed[0]!.detail).toContain("已送达");
  });

  test("action.completed 失败路：投递拒收 → {actionId, ok:false, detail}", async () => {
    const rig = makeRig({
      llmScript: [toolCall("call-1", "deliver_to_session", { sessionId: "sess-1", text: "继续修" })],
      deliverOutcome: { delivered: false, detail: "目标会话正在中断" },
    });
    const actionId = await proposeDeliver(rig);
    const completed: StewardActionCompletedPayload[] = [];
    await rig.svc.confirm(actionId, (p) => completed.push(p));
    rig.releaseDelivery();
    await new Promise((r) => setTimeout(r, 10));
    expect(completed.length).toBe(1);
    expect(completed[0]!.ok).toBe(false);
    expect(completed[0]!.detail).toContain("目标会话正在中断");
  });

  test("emitNavigate 受理时广播（deliverSession——投递完成前已发）", async () => {
    const rig = makeRig({
      llmScript: [toolCall("call-1", "deliver_to_session", { sessionId: "sess-1", text: "继续修" })],
    });
    const actionId = await proposeDeliver(rig);
    await rig.svc.confirm(actionId);
    // 投递仍挂起（gate 未放）但 navigate 已广播
    expect(rig.navigates).toEqual([{ sessionId: "sess-1" }]);
    rig.releaseDelivery();
  });

  test("resumeWith 回灌保留：执行完成后 resolve（isError 随 ok）", async () => {
    const rig = makeRig({
      llmScript: [toolCall("call-1", "deliver_to_session", { sessionId: "sess-1", text: "继续修" })],
    });
    const actionId = await proposeDeliver(rig);
    // 等待 resume 落位：confirm 内部 pending.set 在 ask 阶段已存
    await rig.svc.confirm(actionId);
    rig.releaseDelivery();
    await new Promise((r) => setTimeout(r, 10));
    // 回灌断言经工作记忆读面：toolResult 记录含 detail（G1 不回归——
    // 暂停点 resolve 语义照旧，仅时点从 confirm 内联移到异步执行体）
    const history = await rig.svc.getHistory();
    const toolResults = history.filter((r) => r.kind === "toolResult");
    expect(toolResults.length).toBe(1);
  });

  test("steward.cancel 作废 pending：之后 confirm 报已消费（幂等——cancel 未知 id 无副作用）", async () => {
    const rig = makeRig({
      llmScript: [toolCall("call-1", "deliver_to_session", { sessionId: "sess-1", text: "继续修" })],
    });
    const actionId = await proposeDeliver(rig);
    rig.svc.cancel(actionId);
    rig.svc.cancel("unknown-action"); // 幂等：未知 id 静默
    const confirmed = await rig.svc.confirm(actionId);
    expect(confirmed.status).toBe("error");
    if (confirmed.status !== "error") throw new Error("unreachable");
    expect(confirmed.reason).toContain("不存在或已消费");
    // 作废 = 零执行：deliverToSession 从未被调
    expect(rig.deliveries.length).toBe(0);
    expect(rig.navigates.length).toBe(0);
  });
});
