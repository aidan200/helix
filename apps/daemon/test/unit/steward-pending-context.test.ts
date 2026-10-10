/**
 * 管家语音交互闭环批 ① 对话注入在途卡状态（治「补充话语被当新指令」；TDD 红→绿）。
 *
 * 事故定性（2026-10-06 22:16）：action-1 弹卡后 run 收口（卡静挂），用户补说
 * 「暂时显示F七八号」——LLM 无在途卡感知，被理解为非投递；再补「现在投递的
 * 应该是另一个对话」又被理解为**新投递**弹 action-2。根因：ask 链 LLM 路径
 * 零在途提案上下文。
 *
 * 断言面（brief ① 测试要求逐条）：
 * 1. pending 在场时 ask → 每 run 动态 systemPrompt 含「在途提案」段与
 *    displayTarget 短名（deliver 卡带标题）；
 * 2. pending 空时不含该段；
 * 3. 集成：在途卡在场，用户说「就是那个会话」类对齐语 → LLM 直答不起新提案
 *    （pending 集不涨）。
 *
 * 与 TR-240 口令路由的层次：词表（STEWARD_CONFIRM_PHRASES 全等匹配）是零 LLM
 * 快路径（ask 入口先行，本文件钉其不被绕开）；本项是 LLM 路径的上下文增强
 * ——词表外的补充话语（「就是那个会话」）靠系统提示对齐，两者叠加不冲突。
 */
import { describe, expect, test } from "bun:test";
import { createEngineFromPort } from "../helpers/steward/portScriptEngine";
import type { StewardLlmPort, StewardLlmRequest, StewardLlmResponse } from "../../src/application/ports/outbound/StewardLlmPort";
import type { RuntimeConfigPort } from "../../src/application/ports/outbound/RuntimeConfigPort";
import {
  StewardService,
  buildPendingProposalsSection,
  assembleStewardSystemPrompt,
} from "../../src/application/steward/StewardService";
import { StewardDialogMemory } from "../../src/application/steward/StewardDialogMemory";
import { fakeDialogStore } from "./helpers/fake-steward-dialog-store";

function fakeLlm(script: readonly StewardLlmResponse[]): StewardLlmPort {
  let round = 0;
  return {
    modelId: "fake/flash",
    async complete(_request: StewardLlmRequest): Promise<StewardLlmResponse> {
      const next = script[round];
      round += 1;
      if (next === undefined) throw new Error(`fake LLM 剧本耗尽（round=${round - 1}）`);
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

const fakeSessions = {
  listSessionMetadata: async () => [] as never[],
  startDraftSession: async () => ({ sessionId: "sess-new" }),
  createTitledSession: async () => ({ sessionId: "sess-new" }),
  sessionExists: async () => true,
  sessionTitleOf: async (sessionId: string) => (sessionId === "sess-4f782ae8" ? "F7-8 端口排查" : undefined),
  deliverToSession: async () => ({ delivered: true, detail: "已投递" }),
  readSessionTail: async () => undefined,
};

/** 探针装配：捕获 createEngine 首建 systemPrompt + setSystemPrompt 每轮刷新值。 */
function makeService(llm: StewardLlmPort) {
  const prompts: string[] = [];
  const innerCreate = createEngineFromPort(llm);
  const svc = new StewardService({
    llm,
    orchestration: {
      status: () => [{ agentId: "agent-1", state: "running", displayState: "active", profileKind: "subagent-worker" } as never],
      send: () => ({ delivered: true, detail: "已投递" }),
    } as never,
    tasks: { listTasks: () => [] },
    config: fakeConfig({ "steward.enabled": "1" }),
    dialog: new StewardDialogMemory(fakeDialogStore()),
    feedGate: { hasStewardSubscribers: () => false },
    emitFeed: () => undefined,
    sessions: fakeSessions as never,
    createEngine: (engineOpts) => {
      prompts.push(engineOpts.systemPrompt);
      const inner = innerCreate(engineOpts);
      return {
        start: (input: string, listener: unknown, images?: readonly string[]) => inner.start(input, listener as never, images),
        steer: (text: string) => inner.steer(text),
        abort: () => inner.abort(),
        isStreaming: () => inner.isStreaming(),
        ...(inner.resume !== undefined
          ? { resume: (t: string, d: never) => inner.resume!(t, d) }
          : {}),
        ...(inner.setSystemPrompt !== undefined
          ? { setSystemPrompt: (t: string) => { prompts.push(t); return inner.setSystemPrompt!(t); } }
          : {}),
      };
    },
  });
  return { svc, prompts };
}

async function settle(rounds = 8): Promise<void> {
  for (let i = 0; i < rounds; i += 1) {
    await new Promise((r) => setTimeout(r, 1));
  }
}

const toolCall = (name: string, args: Record<string, unknown>): StewardLlmResponse => ({
  kind: "blocks",
  blocks: [{ type: "toolCall", id: `call-${name}`, name, args }],
  stopReason: "toolUse",
});
const answer = (text: string): StewardLlmResponse => ({
  kind: "blocks",
  blocks: [{ type: "text", text }],
  stopReason: "stop",
});

// ── 纯函数 ─────────────────────────────────────────────

describe("① buildPendingProposalsSection（在途提案段纯函数）", () => {
  test("空集 → undefined（零段注入）", () => {
    expect(buildPendingProposalsSection([])).toBeUndefined();
  });

  test("多卡 → 段含各 displayTarget 与对齐引导语", () => {
    const section = buildPendingProposalsSection([
      { kind: "deliverSession", displayTarget: "F7-8 端口排查" },
      { kind: "send", displayTarget: "agent-1" },
    ])!;
    expect(section).toContain("在途提案");
    expect(section).toContain("F7-8 端口排查");
    expect(section).toContain("agent-1");
    expect(section).toContain("不要");
  });

  test("assembleStewardSystemPrompt 第二段 additive（缺席 = 原样一段；记忆批：召回注入段已退役，本函数只剩快照+在途提案两段）", () => {
    const one = assembleStewardSystemPrompt("snap");
    const two = assembleStewardSystemPrompt("snap", "<pending_proposals>x</pending_proposals>");
    expect(one).not.toContain("pending_proposals");
    expect(two).toContain("pending_proposals");
    expect(two.startsWith(one.slice(0, 20))).toBe(true);
  });
});

// ── 服务集成 ───────────────────────────────────────────

describe("① ask 链在途提案注入（LLM 路径上下文增强——词表快路径叠加不冲突）", () => {
  test("pending 在场时下一轮 ask 的 systemPrompt 含在途摘要（deliver 卡带标题）", async () => {
    const llm = fakeLlm([
      toolCall("deliver_to_session", { sessionId: "sess-4f782ae8", text: "暂时显示F七八号" }),
      answer("好的，那个投递还在等你确认"),
    ]);
    const { svc, prompts } = makeService(llm);
    const first = await svc.ask("投递到那个会话");
    expect(first.status).toBe("confirm_required");
    await settle(3);

    const second = await svc.ask("就是那个会话");
    expect(second.status).toBe("answer");
    const lastPrompt = prompts[prompts.length - 1] ?? "";
    expect(lastPrompt).toContain("在途提案");
    expect(lastPrompt).toContain("F7-8 端口排查");
  });

  test("pending 空时 systemPrompt 不含在途段", async () => {
    const llm = fakeLlm([answer("直答")]);
    const { svc, prompts } = makeService(llm);
    const r = await svc.ask("随便问问");
    expect(r.status).toBe("answer");
    expect((prompts[prompts.length - 1] ?? "").includes("在途提案")).toBe(false);
  });

  test("集成：在途卡在场，对齐语「就是那个会话」不再起新提案（pending 集不涨）", async () => {
    const llm = fakeLlm([
      toolCall("deliver_to_session", { sessionId: "sess-4f782ae8", text: "暂时显示F七八号" }),
      answer("就是刚才那张投递卡——内容是「暂时显示F七八号」，等你确认或说要改到哪里"),
    ]);
    const { svc, prompts } = makeService(llm);
    const first = await svc.ask("投递到那个会话");
    if (first.status !== "confirm_required") throw new Error("unreachable");
    await settle(3);

    const second = await svc.ask("现在投递的应该是另一个对话");
    expect(second.status).toBe("answer"); // LLM 直答对齐——不再弹新卡
    expect(svc.pendingSnapshot().length).toBe(1); // 在途集不涨（治 action-2 复发）
    expect((prompts[prompts.length - 1] ?? "").includes("在途提案")).toBe(true);
  });

  test("口令词表快路径不被绕开：pending 在场时「确认执行」零 LLM 直达确认", async () => {
    const llm = fakeLlm([
      toolCall("deliver_to_session", { sessionId: "sess-4f782ae8", text: "暂时显示F七八号" }),
      answer("不应到达的剧本轮"),
    ]);
    const { svc } = makeService(llm);
    const first = await svc.ask("投递到那个会话");
    if (first.status !== "confirm_required") throw new Error("unreachable");
    const receipt = await svc.ask("确认执行");
    expect(receipt.status).toBe("answer");
    if (receipt.status !== "answer") throw new Error("unreachable");
    expect(receipt.text).toContain("马上投递"); // 口令路由回执（④口语化）——零新 LLM 轮
    expect(svc.pendingSnapshot().length).toBe(0);
  });
});
