import { describe, expect, test } from "bun:test";
import type { AgentEngineEvent } from "../../src/application/ports/outbound/AgentEnginePort";
import {
  runGoldenScenario,
  startedCountAtLeast,
  type GoldenScenario,
} from "../helpers/golden/GoldenScenario";

/**
 * pi 通道 golden 行为锚（原 Phase 5 双引擎对齐七景——loop 通道退役批转
 * pi 专属回归；断言值 = 双引擎时代逐景核定的 pi 侧行为基线，漂移即红）。
 *
 * 锚面：批语义（受控完成序/sequential 逐枚交错）、steer 交错（批后边界
 * one-at-a-time drain）、abort 善后（signal 响应三形态/闭包延迟起跑合成
 * 配对/阻塞闸窗内 abort）、terminate 防火墙（停工具循环、剧本尾轮不消费）。
 */
const toolEnds = (events: readonly AgentEngineEvent[]) =>
  events.filter((e): e is Extract<AgentEngineEvent, { type: "tool_execution_end" }> => e.type === "tool_execution_end");
const endOrder = (events: readonly AgentEngineEvent[]) => toolEnds(events).map((e) => e.toolName);
const toolResults = (events: readonly AgentEngineEvent[]) =>
  events.filter((e): e is Extract<AgentEngineEvent, { type: "message_end" }> => e.type === "message_end" && e.role === "toolResult");
const assistantEnds = (events: readonly AgentEngineEvent[]) =>
  events.filter((e): e is Extract<AgentEngineEvent, { type: "message_end" }> => e.type === "message_end" && e.role === "assistant");
const steerDrains = (events: readonly AgentEngineEvent[]) =>
  events.filter((e): e is Extract<AgentEngineEvent, { type: "message_start" }> => e.type === "message_start" && e.role === "user" && e.source === "steer-drain");

describe("pi 引擎 golden 行为锚：UC-01/02/04/08/09/11/15", () => {
  test("UC-01 并行批 happy path（3 枚全放行，受控完成序 B→A→C）", async () => {
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
    };
    const { pi } = await runGoldenScenario(sc);
    // 受控延迟完成序（真实完成序非确定——受控剧本下确定；升 pi 后漂移即红）
    expect(endOrder(pi.events)).toEqual(["toolB", "toolA", "toolC"]);
    // 入账：3 条 toolResult 全配对 + 首尾 assistant（批轮 + 终答轮）
    expect(toolResults(pi.events)).toHaveLength(3);
    expect(assistantEnds(pi.events)).toHaveLength(2);
    expect(pi.events.at(-1)?.type).toBe("agent_end");
  });

  test("UC-02 混批含一枚 sequential → 全批 sequential（逐枚交错）", async () => {
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
    };
    const { pi } = await runGoldenScenario(sc);
    // sequential 逐枚交错：started(A) → end(A) → started(B) → end(B)
    //（事件序 start/end 交错位——pi sequential 不整批 preflight started）
    const starts = pi.events.filter((e) => e.type === "tool_execution_start");
    const ends = toolEnds(pi.events);
    const idx = (arr: readonly AgentEngineEvent[], name: string) =>
      arr.findIndex((e) => ("toolName" in e ? e.toolName === name : -1));
    const seq = [
      idx(pi.events, "toolA") >= 0 ? starts.findIndex((e) => e.type === "tool_execution_start" && e.toolName === "toolA") : -1,
    ];
    void seq;
    const posStartA = pi.events.findIndex((e) => e.type === "tool_execution_start" && e.toolName === "toolA");
    const posEndA = pi.events.findIndex((e) => e.type === "tool_execution_end" && e.toolName === "toolA");
    const posStartB = pi.events.findIndex((e) => e.type === "tool_execution_start" && e.toolName === "toolB");
    const posEndB = pi.events.findIndex((e) => e.type === "tool_execution_end" && e.toolName === "toolB");
    expect(posStartA).toBeGreaterThan(-1);
    expect(posEndA).toBeGreaterThan(posStartA);
    expect(posStartB).toBeGreaterThan(posEndA); // B 的 started 在 A 的 end 之后（逐枚交错——非整批并发）
    expect(posEndB).toBeGreaterThan(posStartB);
    expect(starts.map((e) => (e.type === "tool_execution_start" ? e.toolName : ""))).toEqual(["toolA", "toolB"]); // started 源序
    expect(toolResults(pi.events)).toHaveLength(2);
    void ends;
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
    };
    const { pi } = await runGoldenScenario(sc);
    // 批后边界逐轮各投一条（one-at-a-time R2.3）：两轮 steer-drain user 消息
    expect(steerDrains(pi.events)).toHaveLength(2);
    // 终答剧本全消费：批轮 assistant 帧（toolCall 内容无文本增量——text=""）
    // 后接两轮注入作答
    expect(assistantEnds(pi.events).map((e) => e.text)).toEqual(["", "先答注入一", "再答注入二"]);
  });

  test("UC-08 批并发期 abort（A 快收/B 忽略慢完/C 抛错——D3/R4.4 批收口等全）", async () => {
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
      piAbortedTail: true, // pi abort 后补打一轮循环由 streamFn 立返 aborted 硬出口
      abortOnExecute: "toolC", // 确定性时点：C 执行体真正起跑时 abort（pi 闭包延迟起跑——started ≠ 执行中）
      tools: [
        { name: "toolA", outcome: "ok", text: "A 快收结果", delayMs: 40, onSignal: "resolve-early" },
        { name: "toolB", outcome: "ok", text: "B 忽略 signal 慢完成", delayMs: 20, onSignal: "ignore" },
        { name: "toolC", outcome: "ok", text: "C 收 signal 抛错", delayMs: 40, onSignal: "throw" },
      ],
    };
    const { pi } = await runGoldenScenario(sc);
    // 批收口等全（B settle）后才收口：3 条 tool_execution_end 齐全（零孤儿 G-B）
    const ends = toolEnds(pi.events);
    expect(ends).toHaveLength(3);
    // A：signal 早收真实结果照记；B：忽略 signal 慢完真实结果照记（R4.4）
    expect(ends.find((e) => e.toolName === "toolA")?.isError).toBe(false);
    expect(ends.find((e) => e.toolName === "toolA")?.result).toBe("A 快收结果");
    expect(ends.find((e) => e.toolName === "toolB")?.isError).toBe(false);
    expect(ends.find((e) => e.toolName === "toolB")?.result).toBe("B 忽略 signal 慢完成");
    // C：不地Err——abort 在 onExecute 同步触发，而 signal 监听器挂在 abort
    // 之后（已 aborted 的 signal 新挂 listener 不触发——DOM 语义），race 走
    // done 路径正常返回文本（原双引擎时代两侧同构即此田——同一 helper）；
    // 若 abort 晚于监听器挂接才置位，才会走 throw→isError 路径
    expect(ends.find((e) => e.toolName === "toolC")?.isError).toBe(false);
    expect(ends.find((e) => e.toolName === "toolC")?.result).toBe("C 收 signal 抛错");
    // 3 条 toolResult 全配对 + abort 尾轮（assistant aborted 帧）后 agent_end
    expect(toolResults(pi.events)).toHaveLength(3);
    expect(pi.events.at(-1)?.type).toBe("agent_end");
  });

  test("UC-09 批 preflight 期 abort（C 前置位闸触点 abort——闭包延迟起跑全合成）", async () => {
    let gateReached = false;
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
        gateReached = true;
      },
      piGateAborts: true, // 闸触点即 abort（preflight 期——C 前置位，不依赖计时竞态）
    };
    const { pi } = await runGoldenScenario(sc);
    expect(gateReached).toBe(true); // 触点确实到达（阻塞钩子窗内 abort）
    // pi 延迟起跑（Promise.all 闭包）：abort 后 A/B/C 闭包起跑查全合成
    // "Operation aborted"（TR-227 已裁决形态——与「放行即起跑」相对）
    const ends = toolEnds(pi.events);
    expect(ends).toHaveLength(3); // 合成配对齐全（零孤儿）
    for (const e of ends) {
      expect(e.result).toBe("Operation aborted");
    }
    expect(ends.find((e) => e.toolName === "toolC")?.isError).toBe(true);
    expect(pi.events.at(-1)?.type).toBe("agent_end"); // run 收口不挂死
  });

  test("UC-11 全批 terminate → 防火墙收口（pi 形态：停工具循环，无 engine_error）", async () => {
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
    };
    const { pi } = await runGoldenScenario(sc);
    // 防火墙零续跑：第二轮剧本（text）未被消费——仅工具轮一条 assistant 终答
    expect(assistantEnds(pi.events)).toHaveLength(1);
    // pi 形态：不设 engine_error（仅停工具循环——R5 差异面在 pi 侧的既知形态）
    expect(pi.events.some((e) => e.type === "engine_error")).toBe(false);
    // terminate 提示不进结果文本（content 同文）+ 2 条配对
    const ends = toolEnds(pi.events);
    expect(ends).toHaveLength(2);
    expect(ends.find((e) => e.toolName === "fwA")?.isError).toBe(false);
    expect(ends.find((e) => e.toolName === "fwA")?.result).toBe("A 终止因");
    expect(pi.events.at(-1)?.type).toBe("agent_end");
  });

  test("UC-15 阻塞闸窗内 abort → 闸醒后置检查合成配对、run 收口不挂死", async () => {
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
      piOnGate: () => undefined, // 占位（真体在下方闭包注入）
      piGatePreDelayMs: 8, // 名义时窗：A（1ms）若已起跑应完成——pi 延迟起跑语义下实际仍合成（断言锚定该形态）
    };
    // 闸触点 0ms 后 abort（闸 6ms 阻塞窗内——确定性时点）
    const { buildPiSide } = await import("../helpers/golden/GoldenScenario");
    let engine: import("../../src/adapters/driven/pi-engine/PiAgentEngineAdapter").PiAgentEngineAdapter | undefined;
    const side = buildPiSide({
      ...sc,
      piOnGate: () => {
        setTimeout(() => engine?.abort(), 0);
      },
    });
    engine = side.engine;
    await engine.start(sc.prompt, side.listener); // 不挂死即通过（abort 唤醒链）
    const ends = toolEnds(side.events);
    expect(ends).toHaveLength(2); // 合成配对齐全（零孤儿）
    // pi 延迟起跑：abort 后 A/B 闭包起跑查合成（TR-227 形态——与 UC-09 同族）
    for (const e of ends) {
      expect(e.result).toBe("Operation aborted");
    }
    expect(ends.find((e) => e.toolName === "toolB")?.isError).toBe(true);
    expect(side.events.at(-1)?.type).toBe("agent_end"); // run 收口
  });
});
