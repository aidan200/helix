import { describe, expect, test } from "bun:test";
import { buildOrchestrationFacade } from "../../src/infrastructure/assembly/buildDrivingAdapters";
import type { WriteMode } from "../../src/domain/agent/AgentInstance";

/**
 * 编排门面适配层透传钉死（code-review 低危波次实测坑）：
 * port spawn 第 4 参 options（U3 writes 写面声明）曾被适配层整个丢弃——
 * 少参箭头函数赋多参接口在 TS 协变下合法，isolated 静默退化 shared，
 * provisioner 零参与、实例 bash 自建散乱 worktree（helix-g1 / helix-wt-cr8
 * / helix-worktrees / tmp 四种落点并存）。
 *
 * 红→绿：修复前 spawn 调用到达 scheduler 时 options 恒 undefined；
 * 修复后原样透传。
 */

interface SpawnCapture {
  sessionId: string;
  task: string;
  profileKind?: string;
  model?: string;
  reportIntervalMs?: number;
  options?: { writes?: WriteMode };
}

const mkHarness = () => {
  const spawnCalls: SpawnCapture[] = [];
  const facade = buildOrchestrationFacade({
    registry: { currentSessionId: () => "sess-test" } as never,
    scheduler: {
      spawn: (
        sessionId: string,
        task: string,
        profileKind?: string,
        model?: string,
        reportIntervalMs?: number,
        options?: { writes?: WriteMode },
      ) => {
        spawnCalls.push({ sessionId, task, profileKind, model, reportIntervalMs, options });
        return { status: "running" as const, agentId: "agent-stub" };
      },
      send: () => ({ status: "sent" as const }),
      status: () => [],
      kill: () => ({ status: "killed" as const }),
      inspect: () => null,
      park: () => ({ status: "parked" as const }),
      resume: () => ({ status: "running" as const }),
    } as never,
    resolveSubagentModelId: () => "model-stub",
  });
  return { facade, spawnCalls };
};

describe("buildOrchestrationFacade spawn 透传", () => {
  test("writes=isolated 原样到达 scheduler（U3 写面声明不被适配层吞掉）", () => {
    const { facade, spawnCalls } = mkHarness();
    facade.spawn("do something", "subagent-worker", 600_000, { writes: "isolated" });
    expect(spawnCalls).toHaveLength(1);
    const call = spawnCalls[0]!;
    expect(call.sessionId).toBe("sess-test");
    expect(call.task).toBe("do something");
    expect(call.profileKind).toBe("subagent-worker");
    expect(call.model).toBe("model-stub");
    expect(call.reportIntervalMs).toBe(600_000);
    expect(call.options).toEqual({ writes: "isolated" });
  });

  test("writes=readonly 同样透传；缺省 options 时 scheduler 收到 undefined（≡ shared）", () => {
    const { facade, spawnCalls } = mkHarness();
    facade.spawn("readonly task", undefined, undefined, { writes: "readonly" });
    facade.spawn("plain task");
    expect(spawnCalls[0]!.options).toEqual({ writes: "readonly" });
    expect(spawnCalls[1]!.options).toBeUndefined();
  });
});
