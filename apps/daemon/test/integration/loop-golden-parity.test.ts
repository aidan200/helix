import { describe, expect, test } from "bun:test";
import type { AgentEngineEvent } from "../../src/application/ports/outbound/AgentEnginePort";
import type { LoopAgentEngineAdapter } from "../../src/adapters/driven/loop/LoopAgentEngineAdapter";
import {
  assertGoldenParity,
  runGoldenScenario,
  buildLoopSide,
  startedCountAtLeast,
  type GoldenScenario,
} from "../helpers/golden/GoldenParity";

/**
 * helix-loop Phase 5 golden transcript 对齐（设计 §8 主仪器；语义定稿 §5
 * UC-01/02/04/08/09/11/15 七景）。同一输入经 pi 引擎（PiAgentEngineAdapter +
 * mock StreamFn）与 loop 引擎（LoopAgentEngineAdapter + mock LoopStreamFn）
 * 跑同一剧本，录制 AgentEngineEvent 序列做 D6 分类对齐：
 *
 * 断言分类（每景注释——Phase 6 切换验收复用）：
 * - 【完成序/集合等价】tool_execution_end 跨枚完成序非确定（D6 裁决）——
 *   按 toolCallId 集合等价 + per-tool 声明载荷比较；
 * - 【源序/严格序列】turn/message/tool_execution_start/agent_end 等骨架串
 *   逐位相等；
 * - 【入账类/按 turn 分组】message_start/end(toolResult) 条数（pi parallel
 *   形态：end 完成序 → toolResult 源序 → turn_end——loop 适配器 turn.finished
 *   收口批发射对齐）；
 * - 【声明偏差（已裁决）】每景显式登记 trim/跳过项 + 理由——未声明偏差即红。
 */
const R5_DEVATIONS = [
  "R5.2/R5.4（有意偏差，已裁决）：loop 防火墙 terminate 枚 isError=true + 显式 engine_error——pi terminate 不设 isError、无错误事件（pi 全批 terminate 后仅停工具循环）",
];

describe("golden parity：UC-01/02/04/08/09/11/15（pi × helix-loop 双实现等价）", () => {
  test("UC-01 并行批 happy path（3 枚全放行，完成序 B→A→C）", async () => {
    const sc: GoldenScenario = {
      name: "UC-01",
      prompt: "并行跑三个",
      rounds: [
        {
          kind: "batch",
          calls: [
            { id: "c-a", name: "toolA", args: {} },
            { id: "c-b", name: "toolB", args: {} },
            { id: "c-c", name: "toolC", args: {} },
          ],
        },
        { kind: "text", text: "三枚都完成了" },
      ],
      tools: [
        { name: "toolA", outcome: "ok", text: "A 的结果", delayMs: 14 },
        { name: "toolB", outcome: "ok", text: "B 的结果", delayMs: 2 },
        { name: "toolC", outcome: "ok", text: "C 的结果", delayMs: 26 },
      ],
      align: {
        notes: [
          "完成序类集合等价：B(2ms)→A(14ms)→C(26ms) 受控延迟确定序（D6——真实完成序非确定，集合等价断言）",
          "源序类严格序列：started 源序 A,B,C + toolResult 消息源序 A,B,C + turn/agent 骨架逐位相等",
        ],
      },
    };
    const { pi, loop } = await runGoldenScenario(sc);
    // 完成序受控断言（两侧同序——B→A→C；集合等价由 align 承接）
    const endOrder = (events: readonly AgentEngineEvent[]) =>
      events.filter((e) => e.type === "tool_execution_end").map((e) => (e.type === "tool_execution_end" ? e.toolName : ""));
    expect(endOrder(pi.events)).toEqual(["toolB", "toolA", "toolC"]);
    expect(endOrder(loop.events)).toEqual(["toolB", "toolA", "toolC"]);
    assertGoldenParity(sc, pi.events, loop.events);
  });

  test("UC-02 混批含一枚 sequential → 全批 sequential", async () => {
    const sc: GoldenScenario = {
      name: "UC-02",
      prompt: "跑混批",
      rounds: [
        {
          kind: "batch",
          calls: [
            { id: "c-a", name: "toolA", args: {} },
            { id: "c-b", name: "toolB", args: {} },
          ],
        },
        { kind: "text", text: "顺序批完成" },
      ],
      tools: [
        { name: "toolA", outcome: "ok", text: "A 的结果", delayMs: 10, executionMode: "parallel" },
        { name: "toolB", outcome: "ok", text: "B 的结果", delayMs: 1, executionMode: "sequential" }, // 批内任一 sequential → 全批 sequential（R1.2）
      ],
      align: {
        notes: [
          "R1.4/TR-227（声明偏差，已裁决）：loop preflight 全批源序发 started（A,B 先于任何完成）；pi sequential 逐枚交错（started(B) 在 end(A) 后）——started 发射时点差异被完成序/入账类分类吸收，源序类只断 started 源序 A,B",
          "入账类：pi sequential 逐枚 toolResult 消息（end(A)→msg(A)→…）；loop turn.finished 收口批源序——形态差异入分类注释，条数+文本等价",
        ],
      },
    };
    const { pi, loop } = await runGoldenScenario(sc);
    // loop 侧 started 全批源序（TR-227 裁决形态）；pi 侧逐枚交错
    const piStarts = pi.events.filter((e) => e.type === "tool_execution_start").map((e) => (e.type === "tool_execution_start" ? e.toolName : ""));
    const loopStarts = loop.events.filter((e) => e.type === "tool_execution_start").map((e) => (e.type === "tool_execution_start" ? e.toolName : ""));
    expect(piStarts).toEqual(["toolA", "toolB"]); // pi sequential: started(A) end(A) msg(A) started(B)
    expect(loopStarts).toEqual(["toolA", "toolB"]); // loop: preflight started(A) started(B)（源序一致——分类面）
    assertGoldenParity(sc, pi.events, loop.events);
  });

  test("UC-04 长批内两条 steer → one-at-a-time 逐轮各投一条", async () => {
    const sc: GoldenScenario = {
      name: "UC-04",
      prompt: "跑批期间我插两句话",
      rounds: [
        { kind: "batch", calls: [{ id: "c-1", name: "slow", args: {} }] },
        { kind: "text", text: "先答注入一" },
        { kind: "text", text: "再答注入二" },
      ],
      tools: [{ name: "slow", outcome: "ok", text: "slow 完成", delayMs: 30 }],
      actions: [
        { when: (events, fired) => fired === 0 && startedCountAtLeast(1)(events), do: { kind: "steer", text: "注入一" } },
        { when: (_events, fired) => fired === 1, do: { kind: "steer", text: "注入二" } },
      ],
      align: {
        notes: [
          "源序类：批后边界逐轮各投一条（one-at-a-time R2.3）——turn_end{1} → turn_start → message_start(user, steer-drain)×各自轮；两侧 user 消息 source 判别同构（pi adapter steeredTexts / loop adapter 同机制）",
        ],
      },
    };
    const { pi, loop } = await runGoldenScenario(sc);
    assertGoldenParity(sc, pi.events, loop.events);
    // 双注入逐轮各投一条（R2.3）：两轮 steer-drain user 消息
    const drains = (events: readonly AgentEngineEvent[]) =>
      events.filter((e) => e.type === "message_start" && e.role === "user" && e.source === "steer-drain");
    expect(drains(pi.events)).toHaveLength(2);
    expect(drains(loop.events)).toHaveLength(2);
  });

  test("UC-08 批并发期 abort（全部已启动：A 快收/B 忽略慢完/C 抛错）", async () => {
    const sc: GoldenScenario = {
      name: "UC-08",
      prompt: "跑批后我会打断",
      rounds: [
        {
          kind: "batch",
          calls: [
            { id: "c-a", name: "toolA", args: {} },
            { id: "c-b", name: "toolB", args: {} },
            { id: "c-c", name: "toolC", args: {} },
          ],
        },
      ],
      piAbortedTail: true, // D8：pi abort 后多走一轮循环由 streamFn 立返 aborted 才硬出口
      abortOnExecute: "toolC", // 确定性时点：C 执行体真正起跑时 abort（pi 闭包延迟起跑——started ≠ 执行中）
      tools: [
        { name: "toolA", outcome: "ok", text: "A 快收结果", delayMs: 40, onSignal: "resolve-early" },
        { name: "toolB", outcome: "ok", text: "B 忽略 signal 慢完成", delayMs: 20, onSignal: "ignore" },
        { name: "toolC", outcome: "ok", text: "C 收 signal 抛错", delayMs: 40, onSignal: "throw" },
      ],
      align: {
        trimPiAbortDrainTurn: true,
        normalizeLoopResult: (toolName, text) =>
          toolName === "toolC" ? text.replace(/^工具执行异常：/, "") : text, // ToolRegistry 异常归一前缀（pi 裸 message）
        notes: [
          "完成序类（集合等价）：A signal 早收真实结果 / B 忽略 signal 慢完真实结果 / C 抛错转 error 结果（两侧同构；loop 异常归一前缀归一）",
          "D8（声明偏差，已裁决）：pi abort 后补打一次 streamFn（abort drain turn 四连帧）——trim；loop 顶部直收不打（现役契约）",
          "D3/R4.2/R4.4：批收口等全部在飞枚 settle（B 慢完真实结果照记）",
          "入账类：3 条 toolResult 全配对（G-B 零孤儿——两侧同）；agent_end.messageCount=6 两侧对齐（loop E-198 标记消息计入）",
        ],
      },
    };
    const { pi, loop } = await runGoldenScenario(sc);
    // 批收口等全（B settle）后才收口：3 条 tool_execution_end 齐全
    expect(pi.events.filter((e) => e.type === "tool_execution_end")).toHaveLength(3);
    expect(loop.events.filter((e) => e.type === "tool_execution_end")).toHaveLength(3);
    assertGoldenParity(sc, pi.events, loop.events);
  });

  test("UC-09 批 preflight 期 abort（C 前置位 abort：pi 延迟起跑全合成 / loop 放行即起跑真实照记）", async () => {
    let loopAborted = false;
    let piAborted = false;
    const sc: GoldenScenario = {
      name: "UC-09",
      prompt: "第三枚前置位我会打断",
      rounds: [
        {
          kind: "batch",
          calls: [
            { id: "c-a", name: "toolA", args: {} },
            { id: "c-b", name: "toolB", args: {} },
            { id: "c-c", name: "toolC", args: {} },
          ],
        },
      ],
      piAbortedTail: true,
      tools: [
        { name: "toolA", outcome: "ok", text: "A 的结果", delayMs: 3 },
        { name: "toolB", outcome: "ok", text: "B 的结果", delayMs: 5 },
        { name: "toolC", outcome: "ok", text: "C 的结果", delayMs: 1 },
      ],
      piBlockTool: "toolC",
      piOnGate: () => {
        piAborted = true;
      },
      piGateAborts: true, // 闸触点即 abort（preflight 期——C 前置位）
      loopBlockTool: "toolC",
      loopOnGate: () => {
        loopAborted = true;
      },
      loopGateAborts: true,
      align: {
        trimPiAbortDrainTurn: true,
        toolEnd: {
          "toolA": { result: false, isError: false, reason: "TR-227 裁决「放行即起跑」：loop A/B 已在飞真实结果照记（R4.4）；pi 延迟起跑（Promise.all 后）闭包起跑查全合成 Operation aborted——identity 比较" },
          "toolB": { result: false, isError: false, reason: "同 toolA（放行即起跑 vs 延迟起跑——已裁决形态差异）" },
          "toolC": { result: false, reason: "合成中断文案差异：pi \"Operation aborted\" vs loop E-198 常量（LOOP_INTERRUPTED_TOOL_RESULT_TEXT）——isError 两侧均 true" },
        },
        notes: [
          "D8：pi abort 后补打 drain turn——trim",
          "G-B 零孤儿：两侧 3 条 tool_execution_end 全配对（loop 合成配对、pi 闭包起跑查合成）——pi 瞬态孤儿不可学（R4.5）在此形态下不可见（pi 事件面同样全配对）",
          "abort 触点确定性：两侧 C 的 preflight 钩子内触发（gate 触点回调）——不依赖计时竞态",
        ],
      },
    };
    const { pi, loop } = await runGoldenScenario(sc);
    expect(piAborted).toBe(true); // 触点确实到达（pi 阻塞钩子）
    expect(loopAborted).toBe(true); // 触点确实到达（loop 观察闸）
    // loop 侧 A/B 真实结果照记（放行即起跑——R4.4）；C 合成配对（isError）
    const loopEnds = loop.events.filter((e) => e.type === "tool_execution_end") as { toolName: string; isError: boolean; result: string }[];
    expect(loopEnds.find((e) => e.toolName === "toolA")?.isError).toBe(false);
    expect(loopEnds.find((e) => e.toolName === "toolA")?.result).toBe("A 的结果");
    expect(loopEnds.find((e) => e.toolName === "toolC")?.isError).toBe(true);
    assertGoldenParity(sc, pi.events, loop.events);
  });

  test("UC-11 全批 terminate → 防火墙收口（helix 差异：不 poll steer/followUp）", async () => {
    const sc: GoldenScenario = {
      name: "UC-11",
      prompt: "两枚都会拒",
      rounds: [
        {
          kind: "batch",
          calls: [
            { id: "c-a", name: "fwA", args: {} },
            { id: "c-b", name: "fwB", args: {} },
          ],
        },
        { kind: "text", text: "不应到达（防火墙零续跑）" },
      ],
      tools: [
        { name: "fwA", outcome: "terminate", text: "A 终止因", delayMs: 1 },
        { name: "fwB", outcome: "terminate", text: "B 终止因", delayMs: 6 },
      ],
      align: {
        dropLoopEngineError: true,
        toolEnd: {
          "fwA": { isError: false, reason: R5_DEVATIONS[0]! },
          "fwB": { isError: false, reason: R5_DEVATIONS[0]! },
        },
        notes: [
          "R5.2/R5.4（声明偏差，已裁决）：loop 全批 terminate → run 终态 error（engine_error + agent_end，零续跑不 poll 队列——pi 对照：pi 仅停工具循环，steer/followUp 仍可续轮）；pi 侧无 engine_error——drop",
          "结果文本：pi terminate 提示不进结果文本（content 同文）；loop dispatched terminate 文本=reason 同文——result 可比",
        ],
      },
    };
    const { pi, loop } = await runGoldenScenario(sc);
    // loop 防火墙零续跑：第二轮剧本（text）未被消费——无第二条 assistant 终答
    const loopAssistantEnds = loop.events.filter((e) => e.type === "message_end" && e.role === "assistant");
    expect(loopAssistantEnds).toHaveLength(1); // 仅工具轮 assistant
    expect(loop.events.some((e) => e.type === "engine_error")).toBe(true);
    assertGoldenParity(sc, pi.events, loop.events);
  });

  test("UC-15 暂停期 abort → resumeWith 惰性化（pi 无暂停面——阻塞 beforeToolCall 最近似对照）", async () => {
    // 两侧特殊驱动（loop 挂闸 settle paused 后 abort；pi 阻塞钩子窗内 abort）
    let loopGateReached = false;
    const sc: GoldenScenario = {
      name: "UC-15",
      prompt: "第二枚要确认，等确认时我打断",
      rounds: [
        {
          kind: "batch",
          calls: [
            { id: "c-a", name: "toolA", args: {} },
            { id: "c-b", name: "toolB", args: {} },
          ],
        },
      ],
      piAbortedTail: true,
      tools: [
        { name: "toolA", outcome: "ok", text: "A 的结果", delayMs: 1 },
        { name: "toolB", outcome: "ok", text: "B 的结果", delayMs: 1 },
      ],
      piBlockTool: "toolB",
      piOnGate: () => undefined, // 占位（真体在下方闭包注入——见 buildPiSide 后重跑）
      piGatePreDelayMs: 8, // A（1ms）先完成，B 的阻塞窗内 abort
      loopPauseTool: "toolB",
      align: {
        trimPiAbortDrainTurn: true,
        dropLoopEnginePaused: true,
        toolEnd: {
          "toolA": { result: false, isError: false, reason: "TR-227「放行即起跑 vs pi 延迟起跑」同族（UC-09 已登记）：loop A 已在飞真实结果照记；pi A 闭包未起跑即 abort → 起跑查合成 Operation aborted" },
          "toolB": { result: false, reason: "暂停期 abort 配对文案差异：pi 阻塞 beforeToolCall 后置检查合成 \"Operation aborted\"；loop 挂闸枚 R4.8 合成 E-198 中断常量——isError 两侧均 true" },
        },
        notes: [
          "设计 §7.4（声明偏差）：loop 暂停面（engine_paused + resume 可选位）是 helix 独有 additive——pi 无暂停面，以阻塞 beforeToolCall 为最近似对照；engine_paused drop",
          "D8：pi abort 后补打 drain turn——trim",
          "D5 惰性化（loop-only 断言）：abort 后 resume(approve) 幂等无副作用零新事件——见本用例尾部断言",
        ],
      },
    };
    // pi 侧：正常驱动（阻塞钩子内 8ms 后 abort——A 已完成）
    const piSide = await (async () => {
      const { buildPiSide } = await import("../helpers/golden/GoldenParity");
      let engine: import("../../src/adapters/driven/pi-engine/PiAgentEngineAdapter").PiAgentEngineAdapter | undefined;
      const side = buildPiSide({
        ...sc,
        piOnGate: () => {
          setTimeout(() => engine?.abort(), 0);
        },
      });
      engine = side.engine as import("../../src/adapters/driven/pi-engine/PiAgentEngineAdapter").PiAgentEngineAdapter;
      await engine.start(sc.prompt, side.listener);
      return side;
    })();
    // loop 侧：start → paused settle → abort → 后台续链收口 → resume 惰性化断言
    const loop = buildLoopSide({
      ...sc,
      loopOnGate: () => {
        loopGateReached = true;
      },
    });
    await loop.engine.start(sc.prompt, loop.listener); // paused settle 即 resolve（R6.3）
    expect(loopGateReached).toBe(false); // loop 侧挂闸不走观察闸（pauseTool 分支）
    const pausedEvent = loop.events.find((e) => e.type === "engine_paused");
    expect(pausedEvent).toMatchObject({ toolName: "toolB" });
    loop.engine.abort();
    await new Promise((r) => setTimeout(r, 20)); // 后台续链：B 合成配对 + run.finished(aborted) → agent_end
    expect(loop.events.some((e) => e.type === "agent_end")).toBe(true);
    // D5 惰性化：abort 后 resume(approve) 幂等——零新事件
    const countBefore = loop.events.length;
    const token = pausedEvent !== undefined && pausedEvent.type === "engine_paused" ? pausedEvent.pauseToken : "";
    await (loop.engine as LoopAgentEngineAdapter).resume?.(token, { kind: "approve" });
    expect(loop.events.length).toBe(countBefore);
    assertGoldenParity(sc, piSide.events, loop.events);
  });
});
