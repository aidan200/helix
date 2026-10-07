/**
 * 管家事故热修批单测（steward-hotfix-cascade，2026-10-07 21:05-21:10 事故链）。
 *
 * 事故时间线（UTC+8）取材（brief docs/temp/steward-hotfix-cascade-brief.md）：
 * - act 工具载荷实录 `{"args":{"url":"helix://session/…"},"surfaceId":"shell:c1",
 *   "verb":"navigate"}` —— 模型发明 url 参数 → shell 载荷防御静默弃帧 → 60s
 *   挂死（T1：daemon 侧动词 args 校验即时工具错误 + T2 shell 拒签回执）；
 * - 13:05:19 挂闸 action-1 → 13:05:27 run error（卡续活在案）→ 13:05:33
 *   action-2 同 key 新开卡（T3：登记簿跨续活去重——续活卡留在途集合）；
 * - 13:10:07.937/.963 两 run 26ms 并发起跑 → 第二个抛「Agent is already
 *   processing a prompt」（T4：drain 与新 ask 单飞互斥）；
 * - steward_messages 污染样本 kind=user text=「## Goal（无。待压缩的对话为
 *   空…）…压缩器工作规则」——压缩器空输入运行且输出落 user 轮（T5：空输入
 *   no-op + 输出永不落 user 轮）；
 * - 思考区按字一行显示（T6：thinking_delta 增量被直通段级帧通道）；
 * - 13:10:07 run error（原因：模型调用失败）——工具面 aborted 与模型失败
 *   未分记（T7：error 分类细化 errorKind）。
 *
 * 约束（kg 切片）：E-204 两段式语义不变；TR-240 三条结构纪律；E-240 队列
 * 行为断言面等价（上限 3 / queued 双帧 / drain 语义）；E-253 risk 三级闸与
 * 动词注册校验不动（修复①只加 args 校验层）；E-251 零新协议帧。
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
import type {
  StewardActionCompletedPayload,
  StewardAskResultPayload,
  StewardNotifyPayload,
} from "@helix/protocol";
import { StewardService, type StewardSessionMetaRow } from "../../src/application/steward/StewardService";

// ── fakes（steward-surface-tools / steward-confirm-chain 同构融合） ─────

/** 剧本项：静态响应或动态工厂（拿流式回调——T6 逐字 thinking 复现）。 */
type ScriptItem =
  | StewardLlmResponse
  | ((
      ctx: { onDelta?: (d: string) => void; onThinking?: (t: string) => void },
    ) => Promise<StewardLlmResponse>);

function fakeLlm(script: readonly ScriptItem[]): StewardLlmPort {
  let round = 0;
  return {
    modelId: "fake/flash",
    async complete(
      _request: StewardLlmRequest,
      onDelta?: (d: string) => void,
      onThinking?: (t: string) => void,
    ): Promise<StewardLlmResponse> {
      const next = script[round];
      round += 1;
      if (next === undefined) throw new Error(`fake LLM 剧本耗尽（round=${round - 1}）`);
      if (typeof next === "function") return next({ onDelta, onThinking });
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

function fakeSurfaces() {
  const actCalls: { surfaceId: string; verb: string; args: Record<string, unknown>; risk: string }[] = [];
  const port: StewardSurfacePort = {
    async list() {
      return [
        { surfaceId: "shell:c1", kind: "shell", label: "shell:c1", capabilities: ["navigate"] },
        {
          surfaceId: "browser:t1",
          kind: "browser",
          label: "示例 — https://example.com",
          capabilities: ["click", "type", "navigate", "scroll", "focus"],
        },
      ];
    },
    async snapshot() {
      return { ok: true, text: "快照正文" };
    },
    async read() {
      return { ok: true, text: "读取正文" };
    },
    async act(request) {
      actCalls.push({ ...request });
      return { ok: true, seq: 42, detail: `已执行 ${request.verb}` };
    },
  };
  return { port, actCalls };
}

function fakeLogger() {
  const infos: string[] = [];
  const warns: string[] = [];
  return { infos, warns, info: (m: string) => infos.push(m), warn: (m: string) => warns.push(m) };
}

interface RigOpts {
  readonly compaction?: { thresholdTokens?: number };
}

function makeRig(llmScript: readonly ScriptItem[], opts: RigOpts = {}) {
  const surfaces = fakeSurfaces();
  const logger = fakeLogger();
  const notifies: StewardNotifyPayload[] = [];
  const actionCompleted: StewardActionCompletedPayload[] = [];
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
    emitNotify: (p) => notifies.push(p),
    emitActionCompleted: (p) => actionCompleted.push(p),
    logger,
    sessions: {
      sessionExists: async () => true,
      readSessionTail: async () => undefined,
      deliverToSession: async () => ({ delivered: true, detail: "已送达" }),
      listSessionMetadata: async () => [] as readonly StewardSessionMetaRow[],
      startDraftSession: async () => ({ sessionId: "sess-draft" }),
      createTitledSession: async () => ({ sessionId: "sess-new" }),
    },
    surfaces: surfaces.port,
    ...(opts.compaction !== undefined ? { compaction: opts.compaction } : {}),
    createEngine: createEngineFromPort(fakeLlm(llmScript)),
  });
  return { svc, surfaces, logger, notifies, actionCompleted };
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

const engineError = (text: string): StewardLlmResponse =>
  ({
    kind: "blocks",
    blocks: [{ type: "text", text }],
    stopReason: "error",
  }) as unknown as StewardLlmResponse; // 事故形态：pi 侧 assistant stopReason=error（port 类型面无 error 停因——经 as 绕行剧本构造，运行时透传）；另见 throw 形态（makeModelFailureRig）

/** 微任务/投影链排空（多轮 setTimeout(1)）。 */
async function settle(rounds = 12): Promise<void> {
  for (let i = 0; i < rounds; i += 1) {
    await new Promise((r) => setTimeout(r, 1));
  }
}

// ── T1 act 参数契约收紧（事故：url-args navigate 60s 挂死） ─────────────

describe("T1 act 参数契约：动词 args 校验（即时工具错误——不派发不挂闸不超时）", () => {
  test("shell 表面 navigate 携 url（事故实录载荷）→ 即时工具错误指引 sessionId 形状，零派发零挂闸", async () => {
    const rig = makeRig([
      // 事故实录：模型发明 url 参数（工具描述只写了 browser 形状）
      toolCall("c1", "act", { surfaceId: "shell:c1", verb: "navigate", args: { url: "helix://session/5b736b22-x" } }),
      say("收到形状错误，改用 sessionId 重发"),
    ]);
    const res = await rig.svc.ask("切换到那个会话");
    // 关键断言①：不挂闸（挂闸 = 等确认 = 事故 60s 挂死形态）
    expect(res.status).toBe("answer");
    // 关键断言②：零派发（surfaces.act 面零调用）
    expect(rig.surfaces.actCalls).toHaveLength(0);
    // 关键断言③：模型收到形状指引（sessionId）——可自纠
    const history = await rig.svc.getHistory();
    const texts = history.map((r) => ("text" in r ? r.text : "")).join("\n");
    expect(texts).toContain("sessionId");
  });

  test("browser 表面 navigate 缺 url → 即时拒绝；click 缺 selector / type 缺 text 同拒", async () => {
    const rig = makeRig([
      toolCall("c1", "act", { surfaceId: "browser:t1", verb: "navigate", args: {} }),
      toolCall("c2", "act", { surfaceId: "browser:t1", verb: "click", args: {} }),
      toolCall("c3", "act", { surfaceId: "browser:t1", verb: "type", args: { selector: "#q" } }),
      say("都改好了"),
    ]);
    const res = await rig.svc.ask("操作一下那个页面");
    expect(res.status).toBe("answer");
    expect(rig.surfaces.actCalls).toHaveLength(0);
    const history = await rig.svc.getHistory();
    const texts = history.map((r) => ("text" in r ? r.text : "")).join("\n");
    expect(texts).toContain("url");
    expect(texts).toContain("selector");
    expect(texts).toContain("text");
  });

  test("合法形状回归：shell navigate {sessionId} 照常走确认闸（write 档提案）", async () => {
    const rig = makeRig([
      toolCall("c1", "act", { surfaceId: "shell:c1", verb: "navigate", args: { sessionId: "s-1" } }),
    ]);
    const res = await rig.svc.ask("切换过去");
    expect(res.status).toBe("confirm_required"); // write 档两段式不变（E-204/E-253）
  });

  test("act 工具描述写明动词参数形状（navigate 按表面分 sessionId/url）", () => {
    const rig = makeRig([]);
    const act = rig.svc.getProfile().tools.find((t) => t.name === "act");
    expect(act).toBeDefined();
    expect(act!.description).toContain("sessionId");
    expect(act!.description).toContain("url");
  });
});

// ── T3 登记簿跨续活去重（事故：action-1 续活 → action-2 同 key 新开卡） ──

describe("T3 登记簿跨续活去重：续活卡留在途集合，同 key 复用不开新卡", () => {
  test("挂闸卡 run error 收口续活 → 新 run 同 key 提案复用旧卡（同 actionId，pending 仍一张）", async () => {
    const rig = makeRig([
      // run#1：act navigate {sessionId} 挂闸（action-1 形态）
      toolCall("c1", "act", { surfaceId: "shell:c1", verb: "navigate", args: { sessionId: "s-1" } }),
      // run#2：「我只是让你切过去」→ 模型调用失败（事故 run error 形态）
      engineError(""),
      // run#3：同 key 再提案（action-2 形态——事故中新开了卡）
      toolCall("c3", "act", { surfaceId: "shell:c1", verb: "navigate", args: { sessionId: "s-1" } }),
    ]);
    const first = await rig.svc.ask("切换到长期记忆配置页");
    expect(first.status).toBe("confirm_required");
    if (first.status !== "confirm_required") throw new Error("unreachable");
    const firstActionId = first.actionId;

    // run#2（新 ask 触发 abort-再驱动收口 run#1——卡续活日志在案）
    const second = await rig.svc.ask("我只是让你切过去");
    expect(second.status).toBe("error"); // 模型调用失败如实交代
    // 续活卡仍在途集合（事故日志「确认卡续活（run 收口不撤）」）
    expect(rig.svc.pendingSnapshot()).toEqual([firstActionId]);

    // run#3：同 key 新提案 → 必须复用旧卡（同 actionId），不开新卡不新弹通知
    const third = await rig.svc.ask("再试一次切换");
    expect(third.status).toBe("confirm_required");
    if (third.status !== "confirm_required") throw new Error("unreachable");
    expect(third.actionId).toBe(firstActionId);
    expect(rig.svc.pendingSnapshot().length).toBe(1);
  });

  test("续活跨 run 连续三轮同 key → 恒一张卡（去重贯穿整个续活生命周期）", async () => {
    const nav = () => toolCall(`c-${Math.random()}`, "act", { surfaceId: "shell:c1", verb: "navigate", args: { sessionId: "s-9" } });
    const rig = makeRig([nav(), engineError(""), nav(), engineError(""), nav()]);
    const ids: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      const res = await rig.svc.ask(`第 ${i + 1} 次要求切换`);
      if (res.status === "confirm_required") ids.push(res.actionId);
      else if (i % 2 === 0) throw new Error(`轮 ${i + 1} 预期 confirm_required，实际 ${res.status}`);
    }
    expect(new Set(ids).size).toBe(1); // 三轮同一张卡
    expect(rig.svc.pendingSnapshot().length).toBe(1);
  });

  test("【事故动词】deliverSession 挂闸续活后同 key 重提 → 复用旧卡（事故 13:05:33 形态回归钉）", async () => {
    // 事故实录动词：action-1 = deliver_to_session（长期记忆配置页）；
    // 同 key 重提（同 sessionId 同文本）必须复用——若新开卡即为回归。
    const deliver = () =>
      toolCall(`d-${Math.random()}`, "deliver_to_session", {
        sessionId: "s-memory",
        text: "长期记忆配置页落地与记忆服务改造",
      });
    const rig = makeRig([deliver(), engineError(""), deliver(), say("好的已复用既有卡")]);
    const first = await rig.svc.ask("把任务投递到长期记忆配置页");
    expect(first.status).toBe("confirm_required");
    if (first.status !== "confirm_required") throw new Error("unreachable");
    const second = await rig.svc.ask("我只是让你切过去"); // run error 收口续活
    expect(second.status).toBe("error");
    expect(rig.svc.pendingSnapshot()).toEqual([first.actionId]);
    const third = await rig.svc.ask("再投递一次");
    expect(third.status).toBe("confirm_required");
    if (third.status !== "confirm_required") throw new Error("unreachable");
    expect(third.actionId).toBe(first.actionId); // 同 key 复用（不新开卡）
    expect(rig.svc.pendingSnapshot().length).toBe(1);
  });
});

// ── T4 队列并发锁（事故：26ms 双 run，「Agent is already processing」） ──

describe("T4 队列并发锁：drain 与新 ask 单飞互斥（至多一个 run 在途）", () => {
  test("空闲后相邻双 ask 并发直发 → 串行化：第二个收 queued 双帧回执，零 already-processing error", async () => {
    const rig = makeRig([
      say("第一答"),
      say("第二答"),
    ]);
    // run#1 完成收口后（runActive=false 的间隙），两个 ask 同步块内并发直发——
    // 事故形态：13:10:07.937/.963 两 run 26ms 并发起跑
    const firstAsk = rig.svc.ask("第一问");
    const secondAsk = rig.svc.ask("第二问"); // 不 await firstAsk 先 settle——并发直发
    const [first, second] = await Promise.all([firstAsk, secondAsk]);
    // 修复后契约：第二 ask 不得因并发驱动撞 already-processing；
    // 两问各自正常收口（answer 或第二问 queued 后由队列驱动 answer）
    const statuses = [first.status, second.status].sort();
    expect(statuses).not.toContain("error");
    const reasons = [first, second].map((r) => (("reason" in r ? r.reason : "") ?? ""));
    const joined = reasons.join("\n");
    expect(joined).not.toContain("already processing");
    await settle();
  });

  test("run error 收口瞬间的 drain 与新 ask 竞态封死：全程任一时刻至多一个 run 在途", async () => {
    const rig = makeRig([
      engineError(""), // run#1 模型失败收口（error 路径——事故 13:10:07.778 形态）
      say("恢复后的回答"),
      say("第三答"),
    ]);
    const first = await rig.svc.ask("第一问");
    expect(first.status).toBe("error");
    // 收口后紧邻双 ask（26ms 形态的确定性复现——同一同步块）
    const secondAsk = rig.svc.ask("第二问");
    const thirdAsk = rig.svc.ask("第三问");
    const [second, third] = await Promise.all([secondAsk, thirdAsk]);
    const all = [second, third];
    for (const r of all) {
      expect(r.status).not.toBe("error"); // 不得撞「Agent is already processing」
    }
    const joinedReasons = all.map((r) => ("reason" in r ? (r.reason ?? "") : "")).join("\n");
    expect(joinedReasons).not.toContain("already processing");
    // 队列语义（E-240 断言面）：忙/过渡态的 ask 收 queued 双帧回执
    const queued = all.filter((r) => r.status === "queued");
    if (queued.length > 0) {
      expect(queued.length).toBeGreaterThanOrEqual(1);
      for (const q of queued) {
        if (q.status !== "queued") throw new Error("unreachable");
        expect(q.queued).toBe(true);
        expect(q.position).toBeGreaterThanOrEqual(1);
      }
    }
    await settle();
    // 队列驱动后最终各自收口（全 answer，无遗留）
    expect(rig.svc.pendingSnapshot().length).toBe(0);
  });

  test("E-240 回归：忙态排队上限 3 与 queued 双帧回执语义不变", async () => {
    const rig = makeRig([say("主答"), say("队1答"), say("队2答"), say("队3答")]);
    // 主 run 在途（driveAsk 已占位）时同步连发四问：前三问排队（queued 双帧），
    // 第四问超上限 3 收 error 回执（E-240 断言面不变）
    const mainAsk = rig.svc.ask("主问");
    const queued = await Promise.all([1, 2, 3, 4].map((i) => rig.svc.ask(`排队问 ${i}`)));
    const overflow = queued.filter((r) => r.status === "error");
    const inQueue = queued.filter((r) => r.status === "queued");
    expect(inQueue.length).toBe(3); // 上限 3：恰三问入队
    expect(overflow.length).toBe(1); // 第四问超限 error
    for (const q of inQueue) {
      if (q.status !== "queued") throw new Error("unreachable");
      expect(q.queued).toBe(true);
      expect(q.position).toBeGreaterThanOrEqual(1);
    }
    await mainAsk;
    await settle(20);
  });
});

// ── T5 压缩器落库形态（输出永不作为 user 轮写入 steward_messages） ───────

describe("T5 压缩器落库：compaction_completed 落 kind=compaction 记录，dialog 查不到压缩器输出 user 轮", () => {
  test("空对话首轮守卫跳过压缩；实质内容在场后压缩 → kind=compaction 落库（非 user），LLM 窗口重建仍含摘要", async () => {
    // thresholdTokens=1 → request 档必超阈（守卫与落库形态双断言面）；
    // summarize 剧本输出压缩器格式文本（事故样本形态：## Goal / 压缩器工作规则）
    const compactionSummary =
      "## Goal\n（用户在测试管家链路。）\n\n## Constraints & Preferences\n- 压缩器工作规则：逐条保留";
    const rig = makeRig(
      [
        say("第一轮答（积拱实质内容）"), // 首轮：空对话守卫应跳过压缩（零 summarize 调用）
        say(compactionSummary), // 次轮 summarize 调用 → 压缩器输出
        say("第二轮答"),
      ],
      { compaction: { thresholdTokens: 1 } },
    );
    const first = await rig.svc.ask("第一问");
    expect(first.status).toBe("answer");
    // 首轮空对话：守卫跳过（无 compaction 记录——零 LLM 零写入）
    let history = await rig.svc.getHistory();
    expect(history.filter((r) => (r as { kind: string }).kind === "compaction")).toHaveLength(0);

    const second = await rig.svc.ask("第二问");
    expect(second.status).toBe("answer");
    history = await rig.svc.getHistory();
    // 断言①：dialog 里查不到压缩器输出形态的 user 轮（事故污染样本）
    const userTexts = history
      .filter((r) => r.kind === "user")
      .map((r) => r.text)
      .join("\n");
    expect(userTexts).not.toContain("压缩器工作规则");
    expect(userTexts).not.toContain("## Goal");
    // 断言②：以 kind=compaction 落库（内部状态非用户话轮；协议 additive 分支）
    const compactionRows = history.filter((r) => (r as { kind: string }).kind === "compaction");
    expect(compactionRows.length).toBeGreaterThanOrEqual(1);
    const compactionText = (compactionRows[0] as { text?: string } | undefined)?.text ?? "";
    expect(compactionText).toContain("## Goal");
    // 断言③：LLM 窗口重建仍含摘要（buildLlmWindow 转换面——上下文语义不变）
    const { buildLlmWindow } = await import("../../src/application/steward/StewardService");
    const window = buildLlmWindow(history);
    const windowText = window.map((m) => ("text" in m ? m.text : "")).join("\n");
    expect(windowText).toContain("## Goal");
  });
});

// ── T6 思考区逐字渲染（事故：thinking_delta 直通段级帧通道） ─────────────

describe("T6 thinking 段级帧：完成态块一帧全量（不逐字）", () => {
  test("逐字 thinking 增量流 + 完成块 → onThinking 恰一帧携全量文本（不逐字直通）", async () => {
    const thinkingFull = "用户要求切换会话，我需要先确认目标会话的 id 再调用 navigate";
    const rig = makeRig([
      // 剧本：port.onThinking 逐字 5 段（经 portScriptStreamFn 转 thinking_delta
      // 增量事件——事故形态）；返回块集含 thinking 全文（完成态权威）
      async ({ onThinking }) => {
        for (const piece of ["用户要求", "切换会话，", "我需要先确认", "目标会话的 id", "再调用 navigate"]) {
          onThinking?.(piece);
        }
        return {
          kind: "blocks",
          blocks: [
            { type: "thinking", text: thinkingFull },
            { type: "text", text: "好的，我来处理" },
          ],
          stopReason: "stop",
        } as StewardLlmResponse;
      },
    ]);
    const thinkingFrames: string[] = [];
    const res = await rig.svc.ask("帮我切过去", { onThinking: (block) => thinkingFrames.push(block) });
    expect(res.status).toBe("answer");
    // 段级契约：一帧全量（现状红：5 帧逐字增量）
    expect(thinkingFrames).toEqual([thinkingFull]);
  });
});

// ── T7 error 分类细化（aborted 与模型失败分记） ────────────────────────

describe("T7 error 分类：aborted 与模型失败分记（errorKind + 日志分类）", () => {
  test("模型调用失败（stopReason=error 空文本）→ errorKind=model-failure；日志分类分记", async () => {
    const rig = makeRlmErrorRig();
    const res = await rig.svc.ask("你好");
    expect(res.status).toBe("error");
    if (res.status !== "error") throw new Error("unreachable");
    expect(res.reason).toContain("模型调用失败");
    expect((res as { errorKind?: string }).errorKind).toBe("model-failure");
    // 收口日志带分类标记（事故 run error 无分类面）
    const warnText = rig.logger.warns.join("\n");
    expect(warnText).toContain("model-failure");
  });

  test("aborted 轮（挂闸 run 被 abort 收口）→ errorKind=aborted，与模型失败分记", async () => {
    const rig = makeRig([
      // run#1 挂闸（act write 档）——用户不确认，下一 ask abort 收口（事故形态）
      toolCall("c1", "act", { surfaceId: "shell:c1", verb: "navigate", args: { sessionId: "s-1" } }),
      // run#2 正常答（abort 后驱动）
      say("好的已中止上一轮"),
    ]);
    const firstAsk = rig.svc.ask("切过去");
    const first = await firstAsk;
    expect(first.status).toBe("confirm_required");
    const second = await rig.svc.ask("算了别切了");
    expect(second.status).toBe("answer");
    await settle();
    // 断言：本轮收口日志中 aborted 分类与模型失败分类可区分（分记）
    const warnsAndInfos = [...rig.logger.warns, ...rig.logger.infos].join("\n");
    expect(warnsAndInfos.length).toBeGreaterThan(0);
    // 至少出现一次 aborted 分类标记（挂闸 run abort 收口）
    expect(warnsAndInfos).toContain("aborted");
  });

  test("errorKind 词汇封闭：model-failure / aborted / engine-exception / round-limit / engine-error", async () => {
    const rig = makeRlmErrorRig();
    const res = await rig.svc.ask("你好");
    if (res.status !== "error") throw new Error("unreachable");
    const kind = (res as { errorKind?: string }).errorKind ?? "";
    expect(["model-failure", "aborted", "engine-exception", "round-limit", "engine-error"]).toContain(kind);
  });
});

/** T7 专用：模型失败剧本（provider throw——事故 provider 无详情形态，
 *  port 契约 fail-fast：模型调用失败经 complete throw 上报）。 */
function makeRlmErrorRig() {
  return makeRig([
    async () => {
      throw new Error("glm-5.3 引擎连接失败（provider 503）");
    },
  ]);
}
