/**
 * StewardService 自动沉淀管线单测（管家记忆 B5 批：静默化 + 近三轮 LLM 提取；
 * 取代 B4a 的判官判增量 + 确认卡方案）。
 *
 * 断言面：
 * 1. 主钩子：answer 轮收口 → LLM 提取一次（输入 = 近三轮 user/assistant 文本，
 *    旧→新）；error 轮零提取；
 * 2. 增量分流：LLM 返「无」→ 零入库零通知；返记忆句 → 静默入库
 *    （source=auto-sediment）+ memory_written 通知（added/updated 随回执），
 *    全程零确认卡（无 pending 可 confirm）；
 * 3. money 闸：零订阅 → 零 LLM 提取调用（水位仍推进）；
 * 4. 水位：存量缺省（lastJudgedAt 缺席 → 回落 lastActiveAt）零打扰；
 *    判定后推进；clear 重置；
 * 5. 兜底：clearHistory 前补判未判定尾部（重启后未 ask 直接新对话场景）；
 * 6. 降级：记忆不可用推水位静默跳过；LLM 提取抛错不推水位（下轮重试）、
 *    入库失败水位已推（best-effort）；
 * 7. remember 工具直写（B5 摘闸）：LLM 轮内调 remember → 不挂确认闸 →
 *    直接入库 + 通知，toolResult 回灌 LLM 续轮。
 */
import { describe, expect, test } from "bun:test";
import { createEngineFromPort } from "../helpers/steward/portScriptEngine";
import type { RuntimeConfigPort } from "../../src/application/ports/outbound/RuntimeConfigPort";
import type { StewardLlmPort, StewardLlmRequest, StewardLlmResponse } from "../../src/application/ports/outbound/StewardLlmPort";
import type { StewardMemoryWrittenPayload } from "@helix/protocol";
import { StewardService } from "../../src/application/steward/StewardService";
import { StewardDialogMemory } from "../../src/application/steward/StewardDialogMemory";
import { fakeDialogStore } from "./helpers/fake-steward-dialog-store";
import type { StewardMemoryService } from "../../src/application/steward/StewardMemoryService";

// ── fakes ─────────────────────────────────────────────────

function fakeConfig(initial: Record<string, string> = {}): RuntimeConfigPort & { kv: Map<string, string> } {
  const kv = new Map(Object.entries(initial));
  return {
    kv,
    get: (key) => kv.get(key),
    set: async (key, value) => {
      kv.set(key, value);
    },
  };
}

function fakeLlm(script: readonly StewardLlmResponse[]): StewardLlmPort & { calls: StewardLlmRequest[] } {
  const calls: StewardLlmRequest[] = [];
  return {
    modelId: "deepseek/deepseek-v4-flash",
    calls,
    async complete(request: StewardLlmRequest): Promise<StewardLlmResponse> {
      calls.push(request);
      const next = script[calls.length - 1];
      if (next === undefined) throw new Error("fake LLM 剧本耗尽");
      return next;
    },
  };
}

/** 记忆服务 fake（remember 收集面；returned.updated 可控驱动通知 mode）。 */
function fakeMemory(opts: { available?: boolean; rememberFails?: boolean; updated?: boolean } = {}) {
  const remembers: { text: string; kind: string; source: string }[] = [];
  const memory = {
    remembers,
    remember: async (text: string, kind: "fact" | "preference", source: string) => {
      if (opts.rememberFails) throw new Error("嵌入端点 503");
      remembers.push({ text, kind, source });
      return { id: remembers.length, updated: opts.updated ?? false };
    },
    isAvailable: () => opts.available ?? true,
    recallSection: async () => undefined,
    getMemoryState: () => ({
      enabled: true,
      available: true,
      endpoint: { id: "ep-1", name: "Ollama", model: "bge-m3", hasApiKey: false },
      judgeEndpoint: null,
      entryCount: remembers.length,
      dim: 3,
    }),
    setMemoryConfig: async () => ({ ok: true as const }),
    listEntries: () => [],
    appendMemoryEntry: async () => ({ ok: true as const }),
    updateMemoryEntry: async () => ({ ok: true as const }),
    forgetEntry: () => true,
  };
  return { memory: memory as unknown as StewardMemoryService, remembers };
}

function makeService(opts: {
  llm: StewardLlmPort;
  config: RuntimeConfigPort & { kv: Map<string, string> };
  memory?: StewardMemoryService;
  feedSubscribers?: boolean;
  now?: () => number;
  /** 共享/种子对话存储（缺省新建——跨「重启」实例共享同库语义）。 */
  dialogStore?: ReturnType<typeof fakeDialogStore>;
}) {
  const notes: StewardMemoryWrittenPayload[] = [];
  const dialog = new StewardDialogMemory(
    opts.dialogStore ?? fakeDialogStore(),
    opts.now !== undefined ? { now: opts.now } : {},
  );
  const svc = new StewardService({
    llm: opts.llm,
    createEngine: createEngineFromPort(opts.llm),
    orchestration: { status: () => [], send: () => ({ delivered: true, detail: "ok" }) },
    tasks: { listTasks: () => [] },
    config: opts.config,
    dialog,
    feedGate: { hasStewardSubscribers: () => opts.feedSubscribers ?? true },
    emitFeed: () => {},
    emitMemoryWritten: (payload) => notes.push(payload),
    ...(opts.memory !== undefined ? { memory: opts.memory } : {}),
    ...(opts.now !== undefined ? { clock: opts.now } : {}),
  });
  return { svc, notes, dialog };
}

const answer = (text: string): StewardLlmResponse => ({ kind: "blocks", blocks: [{ type: "text", text: text }], stopReason: "stop" });

describe("管家记忆 B5：自动沉淀静默化管线（近三轮 LLM 提取）", () => {
  test("① 主钩子：answer 轮收口 → LLM 提取一次（输入含近三轮 user+assistant）；error 轮零提取", async () => {
    const { memory, remembers } = fakeMemory();
    const { svc } = makeService({
      llm: fakeLlm([answer("好的，记下了"), answer("用户希望 shell 测试用 vitest")]),
      config: fakeConfig({ "steward.enabled": "1" }),
      memory,
    });
    const result = await svc.ask("以后别用 bun test 跑 shell 测试", {});
    expect(result.status).toBe("answer");
    await svc.flushSediment();
    expect(remembers).toHaveLength(1);
    // 提取输入 = 近三轮文本（ask 主答 1 次 + 提取 1 次 = 2 次调用）
    const llm = (svc as unknown as { deps: { llm: { calls: StewardLlmRequest[] } } });
    expect(llm.deps.llm.calls).toHaveLength(2);
    const extract1 = llm.deps.llm.calls[1]!.messages[0] as { text: string };
    expect(extract1.text).toContain("以后别用 bun test");
    expect(extract1.text).toContain("好的，记下了");

    // error 轮（LLM 剧本耗尽 → error 收口）→ 零提取
    const { memory: mem2, remembers: r2 } = fakeMemory();
    const { svc: svc2 } = makeService({
      llm: fakeLlm([]),
      config: fakeConfig({ "steward.enabled": "1" }),
      memory: mem2,
    });
    const failed = await svc2.ask("随便一句", {});
    expect(failed.status).toBe("error");
    await svc2.flushSediment();
    expect(r2).toHaveLength(0);
  });

  test("② 增量分流：LLM 返「无」→ 零入库零通知；返记忆句 → 静默入库 + memory_written（mode 随 updated）；零确认卡", async () => {
    // 无增量：静默
    const { memory: noMem, remembers: noR } = fakeMemory();
    const { svc: noSvc, notes: noNotes } = makeService({
      llm: fakeLlm([answer("嗯"), answer("无")]),
      config: fakeConfig({ "steward.enabled": "1" }),
      memory: noMem,
    });
    await noSvc.ask("今天天气不错", {});
    await noSvc.flushSediment();
    expect(noR).toHaveLength(0);
    expect(noNotes).toHaveLength(0);

    // 有增量：静默入库 + 通知（新增态）
    const { memory, remembers } = fakeMemory({ updated: false });
    const { svc, notes } = makeService({
      llm: fakeLlm([answer("好的"), answer("用户偏好 shell 测试用 vitest")]),
      config: fakeConfig({ "steward.enabled": "1" }),
      memory,
    });
    await svc.ask("以后别用 bun test", {});
    await svc.flushSediment();
    expect(remembers).toHaveLength(1);
    expect(remembers[0]!.source).toBe("auto-sediment");
    expect(remembers[0]!.text).toBe("用户偏好 shell 测试用 vitest");
    expect(notes).toHaveLength(1);
    expect(notes[0]!.mode).toBe("added");
    expect(notes[0]!.text).toBe("用户偏好 shell 测试用 vitest");
    // 零确认卡：无 pending 动作可确认
    const confirmNone = await svc.confirm("任意-action-id");
    expect(confirmNone.status).toBe("error");

    // 更新态通知
    const { memory: updMem } = fakeMemory({ updated: true });
    const { svc: updSvc, notes: updNotes } = makeService({
      llm: fakeLlm([answer("好"), answer("用户偏好测试要简洁")]),
      config: fakeConfig({ "steward.enabled": "1" }),
      memory: updMem,
    });
    await updSvc.ask("回复再简洁一点", {});
    await updSvc.flushSediment();
    expect(updNotes).toHaveLength(1);
    expect(updNotes[0]!.mode).toBe("updated");
  });

  test("③ money 闸：零订阅 → 零提取调用（水位仍推进——下轮不重复判定）", async () => {
    const { memory, remembers } = fakeMemory();
    const { svc } = makeService({
      llm: fakeLlm([answer("嗯"), answer("嗯")]),
      config: fakeConfig({ "steward.enabled": "1" }),
      memory,
      feedSubscribers: false,
    });
    await svc.ask("以后别用 bun test", {});
    await svc.flushSediment();
    const llm = (svc as unknown as { deps: { llm: { calls: StewardLlmRequest[] } } });
    expect(llm.deps.llm.calls).toHaveLength(1); // 只有主答，零提取
    expect(remembers).toHaveLength(0);
    // 订阅恢复后新轮正常提取（旧轮不重判）
    const { svc: svc2, notes } = makeService({
      llm: fakeLlm([answer("嗯"), answer("用户偏好回复简洁")]),
      config: fakeConfig({ "steward.enabled": "1" }),
      memory,
    });
    await svc2.ask("以后回复要简洁", {});
    await svc2.flushSediment();
    expect(notes).toHaveLength(1);
  });

  test("④ 水位：存量缺省回落 lastActiveAt 零打扰；判定后推进；clear 重置", async () => {
    const store = fakeDialogStore();
    store.replaceAll([{ kind: "user", text: "历史偏好：用 vitest", at: 1000 }], 1001);
    const config = fakeConfig({ "steward.enabled": "1" });
    const { memory } = fakeMemory();
    const now = () => 2000;
    const { svc, dialog } = makeService({
      llm: fakeLlm([answer("嗯"), answer("用户偏好 vitest")]),
      config,
      memory,
      now,
      dialogStore: store,
    });
    await svc.ask("新偏好：别用 bun test", {});
    await svc.flushSediment();
    expect(dialog.judgedWatermark()).toBe(2000);
    await svc.clearHistory();
    expect(dialog.judgedWatermark()).toBe(0);
  });

  test("⑤ 兜底：clearHistory 前补判未判定尾部（重启后未 ask 直接新对话）；await 防水位竞态", async () => {
    const store = fakeDialogStore();
    store.replaceAll([{ kind: "user", text: "尾部偏好：别用 bun test", at: 1000 }], 1001);
    store.setWatermark(500);
    const config = fakeConfig({ "steward.enabled": "1" });
    const { memory, remembers } = fakeMemory();
    const { svc, dialog } = makeService({
      llm: fakeLlm([answer("用户偏好不用 bun test")]),
      config,
      memory,
      now: () => 2000,
      dialogStore: store,
    });
    await svc.clearHistory();
    // 尾部补判已入库（静默路径——提取输入含尾部轮）
    expect(remembers).toHaveLength(1);
    expect(remembers[0]!.text).toBe("用户偏好不用 bun test");
    expect(dialog.judgedWatermark()).toBe(0);
  });

  test("⑥ 降级：记忆不可用推水位跳过；LLM 提取抛错不推水位（下轮重试）；入库失败水位已推", async () => {
    // 不可用：零提取零入库 + 水位推进
    const { memory: offMem } = fakeMemory({ available: false });
    const now = () => 3000;
    const { svc: offSvc, dialog: offDialog } = makeService({
      llm: fakeLlm([answer("嗯"), answer("用户偏好 x")]),
      config: fakeConfig({ "steward.enabled": "1" }),
      memory: offMem,
      now,
    });
    await offSvc.ask("以后别用 bun test", {});
    await offSvc.flushSediment();
    expect(offDialog.judgedWatermark()).toBe(3000);

    // 提取 LLM 抛错：水位不推进（下轮重试面）
    const { memory: failMem } = fakeMemory();
    const { svc: failSvc, dialog: failDialog } = makeService({
      llm: fakeLlm([answer("嗯")]), // 剧本只配主答——提取调用即抛「剧本耗尽」
      config: fakeConfig({ "steward.enabled": "1" }),
      memory: failMem,
      now,
    });
    await failSvc.ask("以后回复要简洁", {});
    await failSvc.flushSediment();
    expect(failDialog.judgedWatermark()).toBe(0);

    // 入库失败（remember 抛错）：水位已推（best-effort，不重试本轮）
    const { memory: storeFailMem } = fakeMemory({ rememberFails: true });
    const { svc: sfSvc, dialog: sfDialog, notes: sfNotes } = makeService({
      llm: fakeLlm([answer("嗯"), answer("用户偏好 y")]),
      config: fakeConfig({ "steward.enabled": "1" }),
      memory: storeFailMem,
      now,
    });
    await sfSvc.ask("记住我的偏好 y", {});
    await sfSvc.flushSediment();
    expect(sfDialog.judgedWatermark()).toBe(3000);
    expect(sfNotes).toHaveLength(0); // 入库失败零通知
  });

  test("⑦ remember 工具直写（摘闸）：LLM 轮内调 remember → 无确认闸直接入库 + 通知，回执回灌续轮", async () => {
    const { memory, remembers } = fakeMemory();
    const { svc, notes } = makeService({
      // 剧本：①轮内 remember 工具调用 ②终答 ③（轮末沉淀提取——终答轮已有
      // remember 工具沉淀，提取句重复走两段查重，此处 fake 无库返回新增；
      // 剧本配「无」跳过避免断言干扰）
      llm: fakeLlm([
        { kind: "blocks", blocks: [{ type: "toolCall", id: "c1", name: "remember", args: { text: "用户偏好深色主题", kind: "preference" } }], stopReason: "toolUse" },
        answer("好的，我记住了你的主题偏好"),
        answer("无"),
      ]),
      config: fakeConfig({ "steward.enabled": "1" }),
      memory,
    });
    const result = await svc.ask("以后都用深色主题", {});
    // 摘闸语义：不挂确认——直接 answer 收口（不是 confirm_required）
    expect(result.status).toBe("answer");
    expect(remembers).toHaveLength(1);
    expect(remembers[0]!.source).toBe("steward-turn");
    expect(notes).toHaveLength(1);
    expect(notes[0]!.mode).toBe("added");
    expect(notes[0]!.text).toBe("用户偏好深色主题");
  });

  test("⑧ 近三轮滑动窗：第 4 轮提取输入不含第 1 轮", async () => {
    const { memory } = fakeMemory();
    const config = fakeConfig({ "steward.enabled": "1" });
    let t = 1_000;
    const { svc } = makeService({
      llm: fakeLlm([
        answer("答1"), answer("无"), // 轮 1（无增量）
        answer("答2"), answer("无"), // 轮 2
        answer("答3"), answer("无"), // 轮 3
        answer("答4"), answer("无"), // 轮 4
      ]),
      config,
      memory,
      now: () => (t += 10), // 递增时钟：轮间水位单调推进（同毫秒会被水位防御拦）
    });
    await svc.ask("第一轮", {});
    await svc.flushSediment();
    await svc.ask("第二轮", {});
    await svc.flushSediment();
    await svc.ask("第三轮", {});
    await svc.flushSediment();
    await svc.ask("第四轮", {});
    await svc.flushSediment();
    const llm = (svc as unknown as { deps: { llm: { calls: StewardLlmRequest[] } } });
    const extract4 = llm.deps.llm.calls[7]!; // 第 4 轮提取调用（8 次中第 8）
    const extractFirst = extract4.messages[0] as { text: string };
    expect(extractFirst.text).toContain("第二轮");
    expect(extractFirst.text).toContain("第三轮");
    expect(extractFirst.text).toContain("第四轮");
    expect(extractFirst.text).not.toContain("第一轮");
  });
});
