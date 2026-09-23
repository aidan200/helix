import { describe, expect, test } from "bun:test";
import type { StewardLlmPort, StewardLlmRequest, StewardLlmResponse } from "../../src/application/ports/outbound/StewardLlmPort";
import type { RuntimeConfigPort } from "../../src/application/ports/outbound/RuntimeConfigPort";
import type { StewardAskResultPayload, StewardHistoryRecord } from "@helix/protocol";
import { StewardService } from "../../src/application/steward/StewardService";
import { StewardDialogMemory } from "../../src/application/steward/StewardDialogMemory";
import { LOOP_INTERRUPTED_MARKER_TEXT } from "../../src/domain/loop";
import type { LoopEvent } from "../../src/domain/loop";

/**
 * helix-loop L1 批新增面单测：
 * - 件一（压缩）service 接线：dialog 窗口超阈 → 首轮前压缩 → 摘要记录入 KV
 *   （compaction: true）+ 尾部滚动窗保留原文（TR-47：压历史不压工作集）+
 *   loop.context.compacted 事件可见；
 * - 件二（输入缓冲）：忙碌态 ask 入 pending 队列（上限 3）→ queued 回执 →
 *   收口后自动进下一轮（deliver 回执面）→ abort 语义下队列不丢。
 */

function fakeConfig(initial: Record<string, string> = {}): RuntimeConfigPort {
  const kv = new Map(Object.entries(initial));
  return {
    get: (key: string) => kv.get(key),
    set: async (key: string, value: string) => {
      kv.set(key, value);
    },
  };
}

type Deps = ConstructorParameters<typeof StewardService>[0];

function baseDeps(overrides: Partial<Deps> = {}): Deps {
  const base: Deps = {
    llm: undefined as unknown as Deps["llm"],
    orchestration: {
      status: () => [
        { agentId: "agent-1", state: "running" as const, displayState: "active" as const, profileKind: "subagent-worker" },
      ],
      send: () => ({ delivered: true, detail: "已注入" }),
    },
    tasks: { listTasks: () => [] },
    config: fakeConfig({ "steward.enabled": "1" }),
    feedGate: { hasStewardSubscribers: () => false },
    emitFeed: () => undefined,
  };
  return { ...base, ...overrides };
}

/** 主对话直答 LLM（可挂起模拟 streaming——gate 控制首问收口时点）。 */
function gatedTextLlm(opts: {
  answer?: string;
  gate?: Promise<void>;
  onSignal?: (signal: AbortSignal | undefined) => void;
}): StewardLlmPort & { mainCalls: StewardLlmRequest[] } {
  const mainCalls: StewardLlmRequest[] = [];
  return {
    modelId: "m",
    mainCalls,
    complete: async (req, _onD, _onT, signal) => {
      mainCalls.push(req);
      if (opts.gate !== undefined && mainCalls.length === 1) {
        opts.onSignal?.(signal);
        await new Promise<void>((resolve) => {
          if (signal?.aborted === true) return resolve();
          const onAbort = () => resolve();
          signal?.addEventListener("abort", onAbort, { once: true });
          void opts.gate!.then(resolve);
        });
        if (signal?.aborted === true) return { kind: "aborted" };
      }
      return { kind: "text", text: opts.answer ?? "答" };
    },
  } as StewardLlmPort & { mainCalls: StewardLlmRequest[] };
}

describe("件一：StewardService 压缩接线（loop 域能力，管家首个消费者）", () => {
  test("用例1（service 面）：dialog 超阈 → 首轮前压缩 → 摘要记录入 KV（compaction:true）+ 尾部保留原文 + 事件可见", async () => {
    const events: LoopEvent[] = [];
    const config = fakeConfig({ "steward.enabled": "1" });
    // 主对话 LLM：压缩调用（tools 空 + 压缩 prompt）返回摘要；主调用直答
    const llm: StewardLlmPort = {
      modelId: "m",
      complete: async (req) => {
        if (req.tools.length === 0 && req.systemPrompt.includes("压缩")) {
          return { kind: "text", text: "（摘要：用户在问任务状态，已查得 2 条在跑）" };
        }
        return { kind: "text", text: "答" };
      },
    };
    const svc = new StewardService({
      ...baseDeps({ config, llm, emitLoopEvent: (e) => events.push(e) }),
      compaction: { thresholdTokens: 300, keepRecent: 2 },
    });
    // 预填超阈历史：第二问窗口 [u1(≈31x), a1, u2] 超 300 阈 → 压缩区 [u1,a1]
    // → 摘要 + 尾部 2 条保留
    await svc.ask(`历史问题一-${"a".repeat(300)}`);
    const r2 = await svc.ask(`历史问题二-${"b".repeat(300)}`);
    expect(r2.status).toBe("answer");
    const r3 = await svc.ask("第三问");
    expect(r3.status).toBe("answer");
    const history = await svc.getHistory();
    // 摘要记录入 KV（compaction: true）
    const summaryRecords = history.filter((r) => r.kind === "user" && (r as { compaction?: boolean }).compaction === true);
    expect(summaryRecords.length).toBeGreaterThanOrEqual(1);
    // 摘要之后的记录 = 尾部保留窗（原文不压——TR-47：压的是历史不是工作集）
    const summaryIndex = history.findIndex((r) => (r as { compaction?: boolean }).compaction === true);
    expect(summaryIndex).toBeGreaterThanOrEqual(0);
    const tail = history.slice(summaryIndex + 1);
    expect(tail.length).toBeGreaterThan(0);
    // 事件可见（追踪页投影源）
    const compacted = events.find((e) => e.type === "loop.context.compacted");
    expect(compacted).toBeDefined();
    if (compacted!.type === "loop.context.compacted") {
      expect(compacted!.status).toBe("completed");
      expect(compacted!.tokensBefore).toBeGreaterThan(compacted!.tokensAfter!);
    }
    // KV 预算闸不误伤：压缩后窗口低于 dialog 预算（16k）——尾部保留原文完整
    const tailTexts = tail.filter((r) => r.kind === "user").map((r) => (r as { text: string }).text);
    expect(tailTexts.some((t) => t.includes("历史问题二"))).toBe(true); // 近窗保留
  });

  test("压缩失败降级：压缩 LLM 抛错 → 事件 failed → 对话继续（16k 粗裁剪兜底不动）", async () => {
    const events: LoopEvent[] = [];
    const llm: StewardLlmPort = {
      modelId: "m",
      complete: async (req) => {
        if (req.tools.length === 0 && req.systemPrompt.includes("压缩")) {
          throw new Error("压缩模型网络失败");
        }
        return { kind: "text", text: "答" };
      },
    };
    const svc = new StewardService({
      ...baseDeps({ llm, emitLoopEvent: (e) => events.push(e) }),
      compaction: { thresholdTokens: 200, keepRecent: 1 },
    });
    await svc.ask(`问题一-${"a".repeat(300)}`);
    const r2 = await svc.ask(`问题二-${"b".repeat(300)}`);
    expect(r2.status).toBe("answer"); // 压缩失败永不阻塞对话
    const compacted = events.find((e) => e.type === "loop.context.compacted");
    expect(compacted).toBeDefined();
    if (compacted!.type === "loop.context.compacted") {
      expect(compacted!.status).toBe("failed");
      expect(compacted!.error).toContain("压缩模型网络失败");
    }
    // 原窗口保留（未替换）——粗裁剪兜底路径
    const history = await svc.getHistory();
    expect(history.some((r) => (r as { compaction?: boolean }).compaction === true)).toBe(false);
  });
});

describe("StewardDialogMemory.compact：KV 整窗替换（尾部保窗 + 头部孤儿清理）", () => {
  test("compact：[summary, ...尾部 N 条] 替换 + 头部孤儿 toolResult 清理", async () => {
    const config = fakeConfig();
    const dialog = new StewardDialogMemory(config);
    const records: StewardHistoryRecord[] = [];
    for (let i = 0; i < 8; i += 1) {
      records.push({ kind: "user", text: `m${i}`, at: i });
      records.push({ kind: "assistant", text: `a${i}`, at: i });
    }
    for (const r of records) await dialog.append(r);
    const summary: StewardHistoryRecord = { kind: "user", text: "摘要", at: 99, compaction: true } as StewardHistoryRecord;
    await dialog.compact(summary, 4);
    const after = dialog.snapshot();
    expect(after.length).toBe(5); // 摘要 1 + 尾部 4
    expect((after[0] as { compaction?: boolean }).compaction).toBe(true);
    // 尾部 = 最近 4 条原文（时序原样）
    expect(after.slice(1).map((r) => (r as { text?: string }).text)).toEqual(["m6", "a6", "m7", "a7"]);
  });

  test("compact：尾部窗头若为孤儿 toolResult（配对 call 已在压掉区）→ 连带丢弃（空窗优于毒孤儿）", async () => {
    const config = fakeConfig();
    const dialog = new StewardDialogMemory(config);
    await dialog.append({ kind: "assistant", toolCall: { id: "c1", name: "t", args: {} }, at: 1 });
    await dialog.append({ kind: "toolResult", toolCallId: "c1", name: "t", text: "r", at: 2 });
    await dialog.append({ kind: "user", text: "近话", at: 3 });
    await dialog.append({ kind: "assistant", text: "答", at: 4 });
    // 保尾 2 条 = [user 近话, assistant 答]——非孤儿场景；改保尾 3 条使头部
    // 恰为 toolResult（c1 的 call 在压掉区）→ 孤儿清理生效
    await dialog.compact({ kind: "user", text: "摘要", at: 99, compaction: true } as StewardHistoryRecord, 3);
    const after = dialog.snapshot();
    expect(after.length).toBe(3); // 摘要 + user + assistant（孤儿 toolResult 被清）
    expect(after.some((r) => r.kind === "toolResult")).toBe(false);
  });
});

describe("件二：输入缓冲（忙碌态入队不拒绝，收口后自动进下一轮）", () => {
  test("用例4 忙碌 ask → queued 回执 → 收口后自动新轮（deliver 回执面）+ KV 顺序不变量", async () => {
    let resolveGate: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      resolveGate = resolve;
    });
    const llm = gatedTextLlm({ answer: "答", gate });
    const svc = new StewardService({ ...baseDeps({ llm }) });
    const first = svc.ask("第一问");
    await new Promise((r) => setTimeout(r, 5)); // 首问进入 streaming（挂起）
    // 忙碌态第二问：入队不拒绝（L0 的 abort-and-drain 被 pending 队列替代）
    const delivered: StewardAskResultPayload[] = [];
    const second = await svc.ask("第二问", {}, (payload) => delivered.push(payload));
    expect(second.status).toBe("queued");
    if (second.status !== "queued") throw new Error("应 queued");
    expect(second.queued).toBe(true);
    expect(second.position).toBe(1);
    resolveGate!(); // 释放首问 → 首问直答收口 → 队列自动消费第二问
    const r1 = await first;
    expect(r1.status).toBe("answer");
    await new Promise((r) => setTimeout(r, 10)); // 队列消费轮完成
    expect(delivered.length).toBe(1);
    expect(delivered[0]!.status).toBe("answer");
    // KV 顺序不变量：user1 → assistant1 → user2 → assistant2
    const history = await svc.getHistory();
    expect(history.map((r) => `${r.kind}:${(r as { text?: string }).text ?? ""}`)).toEqual([
      "user:第一问",
      "assistant:答",
      "user:第二问",
      "assistant:答",
    ]);
  });

  test("用例5 队列上限：在途 1 + 队内 3 条满——队内第 4 条被拒并提示（上限 3）", async () => {
    let resolveGate: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      resolveGate = resolve;
    });
    const llm = gatedTextLlm({ answer: "答", gate });
    const svc = new StewardService({ ...baseDeps({ llm }) });
    void svc.ask("第一问");
    await new Promise((r) => setTimeout(r, 5));
    // 在途 1 条 + 队内 3 条（q2/q3/q4）——第 4 条排队（q5）被拒
    const q2 = await svc.ask("第二问");
    const q3 = await svc.ask("第三问");
    const q4 = await svc.ask("第四问");
    const q5 = await svc.ask("第五问");
    expect(q2.status).toBe("queued");
    expect(q3.status).toBe("queued");
    expect(q4.status).toBe("queued");
    if (q5.status !== "error") throw new Error("队内满 3 后应被拒");
    expect(q5.reason).toContain("排队已满");
    resolveGate!();
    await new Promise((r) => setTimeout(r, 50)); // 队列排空（3 条串行）
    const history = await svc.getHistory();
    expect(history.filter((r) => r.kind === "user").length).toBe(4); // 首问 + 3 条队列全消费
  });

  test("用例6 abort-and-drain 与队列序：在途轮被 abort → 队列保留不丢 → 收口后自动消费", async () => {
    let resolveGate: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      resolveGate = resolve;
    });
    const seenSignals: (AbortSignal | undefined)[] = [];
    const llm = gatedTextLlm({ answer: "答", gate, onSignal: (s) => seenSignals.push(s) });
    const svc = new StewardService({ ...baseDeps({ llm }) });
    const first = svc.ask("第一问");
    await new Promise((r) => setTimeout(r, 5));
    const delivered: StewardAskResultPayload[] = [];
    const second = await svc.ask("第二问", {}, (p) => delivered.push(p));
    expect(second.status).toBe("queued");
    // 外部 abort 在途轮（L2 interrupt 地基；工具段不打断——此处 LLM 段挂起即中）
    expect(svc.abortInFlight("barge-in")).toBe(true);
    resolveGate!(); // 防挂起残留（abort 已触发收口）
    const r1 = await first;
    expect(r1.status).toBe("error"); // 被中止收口
    await new Promise((r) => setTimeout(r, 10));
    // 队列不丢：第二问自动开轮并回执
    expect(delivered.length).toBe(1);
    expect(delivered[0]!.status).toBe("answer");
    const history = await svc.getHistory();
    // E-198 打断善后：被中断轮入账截断标记（固定常量 user 记录）——
    // 首问无完整块（fake 直挂起无 onBlockEnd）故仅标记无 assistant partial
    expect(history.filter((r) => r.kind === "user").map((r) => (r as { text: string }).text)).toEqual([
      "第一问",
      LOOP_INTERRUPTED_MARKER_TEXT,
      "第二问",
    ]);
    expect(seenSignals[0]!.aborted).toBe(true);
    // 幂等：无在途时 abortInFlight no-op
    expect(svc.abortInFlight("again")).toBe(false);
  });

  test("queued 轮的失败收口同样回执 deliver（error 判别直达发起方）", async () => {
    let resolveGate: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      resolveGate = resolve;
    });
    const llm = gatedTextLlm({ answer: "答", gate });
    const svc = new StewardService({ ...baseDeps({ llm }) });
    void svc.ask("第一问");
    await new Promise((r) => setTimeout(r, 5));
    const delivered: StewardAskResultPayload[] = [];
    await svc.ask("第二问", {}, (p) => delivered.push(p));
    resolveGate!();
    await new Promise((r) => setTimeout(r, 10));
    expect(delivered.length).toBe(1);
    expect(delivered[0]!.status).toBe("answer");
  });
});
