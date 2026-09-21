import { describe, expect, test } from "bun:test";
import { encodeLine, parseChildLine } from "../../src/adapters/driven/subagent/transport/wire";
import type { ChildOutboundLine } from "../../src/adapters/driven/subagent/transport/wire";
import { SubagentLauncher } from "../../src/adapters/driven/subagent/SubagentLauncher";
import type { AgentProfile } from "../../src/adapters/driven/pi-engine/runtime/AgentProfile";
import type { WorkItemData } from "../../src/application/ports/outbound/WorkLedgerPort";

/**
 * SubAgent 抽屉 plan 面——子进程 plan-changed 上报线（file-write/bash-fact
 * 增型同构）：
 * - wire：ChildOutboundLine additive 增型 {type:"plan-changed"}（instanceId +
 *   rows 全行——DTO 转换归父侧单源）编解码往返；
 * - 父侧分派：SubagentLauncher.onChildLine case → deps.onPlanChange 回调注入
 *   （→ 装配层广播 session.plan.changed，payload 携 instanceId）；
 * - 未接 onPlanChange（任务栈 launcher）→ 静默无动作（缺省 no-op 兼容）。
 */

const ROWS: readonly WorkItemData[] = [
  { instanceId: "agent-7", seq: 1, content: "读链路", status: "done", note: "wire 已读", updatedAt: "2026-02-01T00:00:00Z" },
  { instanceId: "agent-7", seq: 2, content: "写实现", status: "in_progress", note: null, updatedAt: "2026-02-01T00:01:00Z" },
];

describe("wire：plan-changed 行编解码", () => {
  test("编码→解码往返：instanceId/rows 逐字段保留（含 note null 形态）", () => {
    const line: ChildOutboundLine = { type: "plan-changed", instanceId: "agent-7", rows: ROWS };
    expect(parseChildLine(encodeLine(line))).toEqual(line);
  });

  test("空行数组形态往返（清场帧同形——观察面即问责面）", () => {
    const line: ChildOutboundLine = { type: "plan-changed", instanceId: "agent-7", rows: [] };
    expect(parseChildLine(encodeLine(line))).toEqual(line);
  });
});

describe("父侧分派：SubagentLauncher.onChildLine plan-changed case", () => {
  function makeLauncher(
    onPlanChange?: (instanceId: string, rows: readonly WorkItemData[]) => void,
  ): SubagentLauncher {
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
      ...(onPlanChange !== undefined ? { onPlanChange } : {}),
    });
  }

  const dispatchOf = (launcher: SubagentLauncher) =>
    (launcher as unknown as { onChildLine: (id: string, line: ChildOutboundLine) => void }).onChildLine.bind(
      launcher,
    );

  test("plan-changed 行 → onPlanChange(instanceId, rows)；onLine 观测面同达", () => {
    const received: { id: string; rows: readonly WorkItemData[] }[] = [];
    const observed: ChildOutboundLine[] = [];
    const launcher = makeLauncher((id, rows) => received.push({ id, rows }));
    (launcher as unknown as { deps: { onLine?: (id: string, line: ChildOutboundLine) => void } }).deps.onLine = (
      _id,
      line,
    ) => observed.push(line);
    dispatchOf(launcher)("agent-7", { type: "plan-changed", instanceId: "agent-7", rows: ROWS });
    expect(received).toEqual([{ id: "agent-7", rows: ROWS }]);
    expect(observed).toEqual([{ type: "plan-changed", instanceId: "agent-7", rows: ROWS }]);
  });

  test("未接 onPlanChange → 静默无动作（任务栈 launcher 兼容；不抛错）", () => {
    const launcher = makeLauncher();
    expect(() =>
      dispatchOf(launcher)("agent-7", { type: "plan-changed", instanceId: "agent-7", rows: ROWS }),
    ).not.toThrow();
  });
});
