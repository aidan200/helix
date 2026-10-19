/**
 * 管家消费面四泛型工具单测（M2 批，设计 D4/D3/D7）：
 * - surface_list / snapshot / read：只读直行（零确认）；
 * - act：risk 三级闸——read 免确认直行 / write 走 steward.confirmations
 *   两段式（propose→用户确认→执行，未确认不执行）/ destructive 强制确认；
 * - 【突变验证①】私造动词（frobnicate）必须被拒——不派发任何动作；
 * - 【突变验证②】destructive 豁免路径必须失败——豁免旗标直行尝试被整单
 *   拒绝（执行面零调用）；
 * - risk 降级（write 动词谎报 read）拒绝。
 */
import { describe, expect, test } from "bun:test";
import { createEngineFromPort } from "../helpers/steward/portScriptEngine";
import type {
  StewardLlmPort,
  StewardLlmRequest,
  StewardLlmResponse,
} from "../../src/application/ports/outbound/StewardLlmPort";
import type { RuntimeConfigPort } from "../../src/application/ports/outbound/RuntimeConfigPort";
import type { StewardSurfacePort } from "../../src/application/ports/outbound/StewardSurfacePort";
import type { StewardActionCompletedPayload } from "@helix/protocol";
import {
  StewardService,
  type StewardSessionMetaRow,
} from "../../src/application/steward/StewardService";

// ── fakes（steward-confirm-two-phase.test 同构） ──────────────

function fakeLlm(script: readonly StewardLlmResponse[]): StewardLlmPort {
  let round = 0;
  return {
    modelId: "deepseek/deepseek-v4-flash",
    async complete(_request: StewardLlmRequest): Promise<StewardLlmResponse> {
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

const toolCall = (id: string, name: string, args: Record<string, unknown>): StewardLlmResponse => ({
  kind: "blocks",
  blocks: [{ type: "toolCall", id, name, args }],
  stopReason: "toolUse",
});

const say = (text: string): StewardLlmResponse => ({
  kind: "blocks",
  blocks: [{ type: "text", text }],
  stopReason: "stop",
});

/** 表面能力面 fake（执行管道 spy——act 未确认不执行的判据）。 */
function fakeSurfaces() {
  const actCalls: { surfaceId: string; verb: string; args: Record<string, unknown>; risk: string }[] = [];
  const listCalls: number[] = [];
  const snapshotCalls: string[] = [];
  const readCalls: { surfaceId: string; selector?: string; maxChars?: number }[] = [];
  const port: StewardSurfacePort = {
    async list() {
      listCalls.push(1);
      return [
        { surfaceId: "browser:t1", kind: "browser", label: "示例 — https://example.com", capabilities: ["click", "type", "navigate", "scroll", "focus"] },
      ];
    },
    async snapshot(surfaceId) {
      snapshotCalls.push(surfaceId);
      return { ok: true, text: `快照：${surfaceId}（示例正文）` };
    },
    async read(surfaceId, opts) {
      readCalls.push({ surfaceId, ...opts });
      return { ok: true, text: `读取：${surfaceId}（正文内容）` };
    },
    async act(request) {
      actCalls.push({ ...request });
      return { ok: true, seq: 42, detail: `已执行 ${request.verb}` };
    },
  };
  return { port, actCalls, listCalls, snapshotCalls, readCalls };
}

interface Rig {
  svc: StewardService;
  surfaces: ReturnType<typeof fakeSurfaces>;
}

function makeRig(llmScript: readonly StewardLlmResponse[]): Rig {
  const surfaces = fakeSurfaces();
  const svc = new StewardService({
    llm: fakeLlm(llmScript),
    orchestration: {
      status: () => [],
      send: () => ({ delivered: false, detail: "表面工具面零递话" }),
    },
    tasks: { listTasks: () => [] },
    config: fakeConfig({ "steward.enabled": "1" }),
    feedGate: { hasStewardSubscribers: () => true },
    emitFeed: () => {},
    sessions: {
      sessionExists: async () => true,
      readSessionTail: async () => undefined,
      deliverToSession: async () => ({ delivered: true, detail: "已送达" }),
      listSessionMetadata: async () => [] as readonly StewardSessionMetaRow[],
      startDraftSession: async () => ({ sessionId: "sess-draft" }),
      createTitledSession: async () => ({ sessionId: "sess-new" }),
    },
    surfaces: surfaces.port,
    createEngine: createEngineFromPort(fakeLlm(llmScript)),
  });
  return { svc, surfaces };
}

describe("管家四泛型工具：注册面与只读直行（D4）", () => {
  test("surface_list / snapshot / read / act 在注册面（现 10 工具之外新增）", () => {
    const rig = makeRig([]);
    const names = rig.svc.getProfile().tools.map((t) => t.name);
    for (const name of ["surface_list", "snapshot", "read", "act"]) {
      expect(names.includes(name), `缺工具：${name}`).toBe(true);
    }
  });

  test("surface_list 动态发现表面与能力（零确认直行）", async () => {
    const rig = makeRig([toolCall("c1", "surface_list", {}), say("这是表面清单")]);
    const res = await rig.svc.ask("看看现在有哪些表面");
    expect(res.status).toBe("answer");
    expect(rig.surfaces.listCalls).toHaveLength(1);
  });

  test("snapshot / read 直行（read 类免确认）", async () => {
    const rig = makeRig([
      toolCall("c1", "snapshot", { surfaceId: "browser:t1" }),
      toolCall("c2", "read", { surfaceId: "browser:t1", selector: "main", max_chars: 500 }),
      say("读完了"),
    ]);
    const res = await rig.svc.ask("看看那个页面");
    expect(res.status).toBe("answer");
    expect(rig.surfaces.snapshotCalls).toEqual(["browser:t1"]);
    expect(rig.surfaces.readCalls).toEqual([{ surfaceId: "browser:t1", selector: "main", maxChars: 500 }]);
    expect(rig.surfaces.actCalls).toHaveLength(0); // 只读面零动作
  });
});

describe("act 工具：risk 三级闸（D3——risk 挂动作不挂宿主）", () => {
  test("read 档（scroll）免确认直行：经引擎 approve 面直接执行并回执", async () => {
    const rig = makeRig([
      toolCall("c1", "act", { surfaceId: "browser:t1", verb: "scroll", args: { y: 500 } }),
      say("滚动完成"),
    ]);
    const res = await rig.svc.ask("往下滚一屏");
    expect(res.status).toBe("answer");
    expect(rig.surfaces.actCalls).toEqual([
      { surfaceId: "browser:t1", verb: "scroll", args: { y: 500 }, risk: "read" },
    ]);
  });

  test("write 档（click）走 steward.confirmations 两段式：propose→确认→执行；未确认不执行", async () => {
    const rig = makeRig([
      toolCall("c1", "act", { surfaceId: "browser:t1", verb: "click", args: { selector: "#submit" } }),
    ]);
    const res = await rig.svc.ask("帮我点提交");
    expect(res.status).toBe("confirm_required");
    if (res.status !== "confirm_required") throw new Error("unreachable");
    expect(res.actionId).toContain("steward-action-");
    // 未确认 = 零执行（propose 只挂闸）
    expect(rig.surfaces.actCalls).toHaveLength(0);
    const completed: StewardActionCompletedPayload[] = [];
    const confirmed = await rig.svc.confirm(res.actionId, (p) => completed.push(p));
    expect(confirmed.status).toBe("accepted");
    await new Promise((r) => setTimeout(r, 10));
    expect(rig.surfaces.actCalls).toEqual([
      { surfaceId: "browser:t1", verb: "click", args: { selector: "#submit" }, risk: "write" },
    ]);
    expect(completed).toHaveLength(1);
    expect(completed[0]!.ok).toBe(true);
    expect(completed[0]!.detail).toContain("seq=42"); // 执行回执带序列号回流
  });

  test("destructive 档强制确认：不直行，走同一确认闸", async () => {
    const rig = makeRig([
      toolCall("c1", "act", { surfaceId: "browser:t1", verb: "click", args: { selector: "#delete" }, risk: "destructive" }),
    ]);
    const res = await rig.svc.ask("删掉它");
    expect(res.status).toBe("confirm_required");
    expect(rig.surfaces.actCalls).toHaveLength(0);
  });

  test("取消即零执行（steward.cancel 作废 pending）", async () => {
    const rig = makeRig([
      toolCall("c1", "act", { surfaceId: "browser:t1", verb: "click", args: { selector: "#submit" } }),
    ]);
    const res = await rig.svc.ask("帮我点提交");
    if (res.status !== "confirm_required") throw new Error("expect confirm_required");
    rig.svc.cancel(res.actionId);
    const confirmed = await rig.svc.confirm(res.actionId);
    expect(confirmed.status).toBe("error");
    expect(rig.surfaces.actCalls).toHaveLength(0);
  });
});

describe("act 工具：突变验证（私造动词拒绝 / destructive 豁免失败）", () => {
  test("【突变①】私造动词 frobnicate 被拒：执行面零调用 + 拒绝理由回灌", async () => {
    const rig = makeRig([
      toolCall("c1", "act", { surfaceId: "browser:t1", verb: "frobnicate", args: {} }),
      say("明白"),
    ]);
    const res = await rig.svc.ask("随便做点什么");
    expect(res.status).toBe("answer");
    expect(rig.surfaces.actCalls).toHaveLength(0); // 私造动词不派发
    const history = await rig.svc.getHistory();
    const texts = history.map((r) => r.text ?? "").join("\n");
    expect(texts).toContain("frobnicate"); // 拒绝理由带私造动词名（模型知情）
  });

  test("【突变②】destructive 豁免路径必须失败：豁免旗标直行尝试被整单拒绝（零执行）", async () => {
    const rig = makeRig([
      toolCall("c1", "act", {
        surfaceId: "browser:t1",
        verb: "click",
        args: { selector: "#delete", auto_confirm: true }, // 豁免尝试（突变注入——schema 开面内走私）
        risk: "destructive",
      }),
      say("明白"),
    ]);
    const res = await rig.svc.ask("删掉它，不用问我");
    expect(res.status).toBe("answer");
    expect(rig.surfaces.actCalls).toHaveLength(0); // 豁免失败=不执行
    const history = await rig.svc.getHistory();
    const texts = history.map((r) => r.text ?? "").join("\n");
    expect(texts).toContain("不可豁免");
  });

  test("risk 降级拒绝：write 动词谎报 read 不放行（risk 挂动作，档序守护）", async () => {
    const rig = makeRig([
      toolCall("c1", "act", { surfaceId: "browser:t1", verb: "click", args: { selector: "#a" }, risk: "read" }),
      say("明白"),
    ]);
    const res = await rig.svc.ask("点一下");
    expect(res.status).toBe("answer");
    expect(rig.surfaces.actCalls).toHaveLength(0);
    const history = await rig.svc.getHistory();
    const texts = history.map((r) => r.text ?? "").join("\n");
    expect(texts).toContain("降级");
  });

  test("write 动词带豁免旗标同样拒绝（M2 无豁免面——未确认恒不执行）", async () => {
    const rig = makeRig([
      toolCall("c1", "act", {
        surfaceId: "browser:t1",
        verb: "click",
        args: { selector: "#submit", skip_confirmation: true },
      }),
      say("明白"),
    ]);
    const res = await rig.svc.ask("帮我点提交，别问了");
    expect(res.status).toBe("answer");
    expect(rig.surfaces.actCalls).toHaveLength(0);
    const history = await rig.svc.getHistory();
    expect(history.map((r) => r.text ?? "").join("\n")).toContain("不可执行");
  });
});

// ── 五写工具 execute 防绕过（评审 F1：与 act「write/destructive 本执行面
//    不直行」同姿态——execute 直调不得执行写动作，未确认零执行防火墙） ──

describe("五写工具 execute：挂闸动作不直行（防绕过确认闸）", () => {
  interface GatedRig {
    svc: StewardService;
    tools: ReturnType<typeof captureTools>;
    sends: { agentId: string; message: string }[];
  }
  const captureTools = () => {
    const tools: import("../../src/application/ports/outbound/StewardToolSpec").StewardToolSpec[] = [];
    return tools;
  };
  function makeGatedRig(): GatedRig {
    const tools = captureTools();
    const sends: { agentId: string; message: string }[] = [];
    const svc = new StewardService({
      llm: fakeLlm([say("ok")]),
      orchestration: {
        status: () => [
          { agentId: "agent-1", state: "running", displayState: "active", profileKind: "subagent-worker", task: "干活" },
        ],
        send: (agentId, message) => {
          sends.push({ agentId, message });
          return { delivered: true, detail: "已投递" };
        },
      },
      tasks: { listTasks: () => [] },
      config: fakeConfig({ "steward.enabled": "1" }),
      feedGate: { hasStewardSubscribers: () => true },
      emitFeed: () => {},
      sessions: {
        sessionExists: async () => true,
        readSessionTail: async () => undefined,
        deliverToSession: async () => ({ delivered: true, detail: "已送达" }),
        listSessionMetadata: async () => [],
        startDraftSession: async () => ({ sessionId: "sess-draft" }),
        createTitledSession: async () => ({ sessionId: "sess-new" }),
      },
      createEngine: (options) => {
        tools.push(...options.tools);
        return createEngineFromPort(fakeLlm([say("ok")]))(options);
      },
    });
    return { svc, tools, sends };
  }
  const toolOf = (rig: GatedRig, name: string) => {
    const found = rig.tools.find((t) => t.name === name);
    if (found === undefined) throw new Error(`未捕获工具：${name}`);
    return found;
  };

  test("propose_send execute 直调不执行递话（拒绝 + 零 send）", async () => {
    const rig = makeGatedRig();
    await rig.svc.ask("warm"); // createEngine 落地工具面
    const result = await toolOf(rig, "propose_send").execute(
      { agentId: "agent-1", message: "直调递话" },
      { toolCallId: "t-direct" },
    );
    expect(result.isError).toBe(true);
    expect(result.text).toContain("确认闸");
    expect(rig.sends).toHaveLength(0); // 未确认零执行防火墙
  });

  test("deliver_to_session execute 直调不执行投递", async () => {
    const rig = makeGatedRig();
    await rig.svc.ask("warm");
    const result = await toolOf(rig, "deliver_to_session").execute(
      { sessionId: "sess-1", text: "直调投递" },
      { toolCallId: "t-direct" },
    );
    expect(result.isError).toBe(true);
    expect(result.text).toContain("确认闸");
  });
});
