import { describe, expect, test } from "bun:test";
import { encodeLine, parseChildLine } from "../../src/adapters/driven/subagent/transport/wire";
import type { ChildOutboundLine } from "../../src/adapters/driven/subagent/transport/wire";
import { SubagentLauncher } from "../../src/adapters/driven/subagent/SubagentLauncher";
import type { AgentProfile } from "../../src/adapters/driven/pi-engine/runtime/AgentProfile";
import type { BashFactLineItem } from "../../src/adapters/driven/subagent/transport/wire";

/**
 * U0b SubAgent bash 写感知上报线（照 file-write 先例 E-128 同构）：
 * - wire：ChildOutboundLine additive 增型 {type:"bash-fact"}——子进程内
 *   exec 前后快照差集算毕上行（单行、无 stdout 协议膨胀）；
 * - 父侧分派：SubagentLauncher.onChildLine case → deps.onBashFact 回调
 *   （→ 组合根补 instanceId/sessionId 归属后 registry.recordMany）。
 */

describe("wire：bash-fact 行编解码", () => {
  test("编码→解码往返：facts 数组逐字段保留（path/confidence/at）", () => {
    const line: ChildOutboundLine = {
      type: "bash-fact",
      instanceId: "agent-7",
      facts: [
        { path: "/ws/proj/src/a.ts", confidence: "inferred", at: 1789089873_123 },
        { path: "/ws/proj/new.txt", confidence: "uncertain", at: 1789089874_001 },
      ],
    };
    expect(parseChildLine(encodeLine(line))).toEqual(line);
  });

  test("空 facts 数组形态（防御——wrap 层不产但协议可表达）往返", () => {
    const line: ChildOutboundLine = { type: "bash-fact", instanceId: "agent-1", facts: [] };
    expect(parseChildLine(encodeLine(line))).toEqual(line);
  });
});

describe("父侧分派：SubagentLauncher.onChildLine bash-fact case", () => {
  function makeLauncher(onBashFact: (instanceId: string, facts: readonly BashFactLineItem[]) => void): SubagentLauncher {
    const profile: AgentProfile = {
      kind: "test-subagent",
      systemPrompt: "test",
      tools: [],
      lifecycle: { mode: "single-shot" },
      hooks: [],
    };
    return new SubagentLauncher({
      profile,
      model: { id: "m", provider: "p", api: {} } as never,
      apiKeys: {},
      toolCwd: "/ws",
      onBashFact,
    });
  }

  test("bash-fact 行 → onBashFact(instanceId, facts)；onLine 观测面同达", () => {
    const received: { id: string; facts: readonly BashFactLineItem[] }[] = [];
    const observed: ChildOutboundLine[] = [];
    const launcher = makeLauncher((id, facts) => received.push({ id, facts }));
    (launcher as unknown as { deps: { onLine?: (id: string, line: ChildOutboundLine) => void } }).deps.onLine = (
      _id,
      line,
    ) => observed.push(line);
    const dispatch = (
      launcher as unknown as { onChildLine: (id: string, line: ChildOutboundLine) => void }
    ).onChildLine.bind(launcher);

    const facts: readonly BashFactLineItem[] = [{ path: "/ws/p/a.ts", confidence: "inferred", at: 1 }];
    dispatch("agent-7", { type: "bash-fact", instanceId: "agent-7", facts });
    expect(received).toEqual([{ id: "agent-7", facts }]);
    expect(observed.map((l) => l.type)).toEqual(["bash-fact"]);
  });

  test("onBashFact 未注入（容缺）→ 分派 no-op 不抛", () => {
    const launcher = makeLauncher(() => {});
    (launcher as unknown as { deps: { onBashFact?: unknown } }).deps.onBashFact = undefined;
    const dispatch = (
      launcher as unknown as { onChildLine: (id: string, line: ChildOutboundLine) => void }
    ).onChildLine.bind(launcher);
    expect(() =>
      dispatch("agent-1", { type: "bash-fact", instanceId: "agent-1", facts: [{ path: "/x", confidence: "inferred", at: 1 }] }),
    ).not.toThrow();
  });
});
