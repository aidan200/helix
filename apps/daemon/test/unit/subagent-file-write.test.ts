import { describe, expect, test } from "bun:test";
import { encodeLine, parseChildLine } from "../../src/adapters/driven/subagent/transport/wire";
import type { ChildOutboundLine } from "../../src/adapters/driven/subagent/transport/wire";
import { SubagentLauncher } from "../../src/adapters/driven/subagent/SubagentLauncher";
import type { AgentProfile } from "../../src/adapters/driven/pi-engine/runtime/AgentProfile";

/**
 * T2 轮次级内存态 diff——SubAgent 子进程 file-write 元数据上报线：
 * - wire：ChildOutboundLine additive 增型 {type:"file-write"}（只报元数据
 *   不报内容——stdout 管道安全）编解码往返；
 * - 父侧分派：SubagentLauncher.onChildLine case → deps.onFileWrite 回调注入
 *   （→ 组合根接 TurnDiffService.recordExternal）。
 */

describe("wire：file-write 行编解码", () => {
  test("编码→解码往返：instanceId/path/prevHash/prevSize/nextSize 逐字段保留", () => {
    const line: ChildOutboundLine = {
      type: "file-write",
      instanceId: "agent-7",
      path: "/ws/proj/src/a.ts",
      prevHash: "deadbeef",
      prevSize: 120,
      nextSize: 340,
    };
    const decoded = parseChildLine(encodeLine(line));
    expect(decoded).toEqual(line);
  });

  test("新文件形态（prevHash 为空内容指纹、prevSize=0）往返", () => {
    const line: ChildOutboundLine = {
      type: "file-write",
      instanceId: "agent-1",
      path: "/ws/proj/new.md",
      prevHash: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
      prevSize: 0,
      nextSize: 42,
    };
    expect(parseChildLine(encodeLine(line))).toEqual(line);
  });

  test("缺失 type / 非法 JSON → undefined（既有 parse 纪律同口径）", () => {
    expect(parseChildLine(JSON.stringify({ instanceId: "a", path: "/x" }))).toBeUndefined();
    expect(parseChildLine("not-json")).toBeUndefined();
  });
});

describe("父侧分派：SubagentLauncher.onChildLine file-write case", () => {
  function makeLauncher(onFileWrite: (instanceId: string, meta: { path: string; prevHash: string; prevSize: number; nextSize: number }) => void): SubagentLauncher {
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
      onFileWrite,
    });
  }

  test("file-write 行 → onFileWrite(instanceId, 元数据)；onLine 观测面同达", () => {
    const received: { id: string; meta: unknown }[] = [];
    const observed: ChildOutboundLine[] = [];
    const launcher = makeLauncher((id, meta) => received.push({ id, meta }));
    (launcher as unknown as { deps: { onLine?: (id: string, line: ChildOutboundLine) => void } }).deps.onLine = (
      _id,
      line,
    ) => observed.push(line);
    const dispatch = (
      launcher as unknown as { onChildLine: (id: string, line: ChildOutboundLine) => void }
    ).onChildLine.bind(launcher);

    dispatch("agent-7", {
      type: "file-write",
      instanceId: "agent-7",
      path: "/ws/p/src/a.ts",
      prevHash: "h1",
      prevSize: 10,
      nextSize: 20,
    });
    expect(received).toEqual([
      {
        id: "agent-7",
        meta: { path: "/ws/p/src/a.ts", prevHash: "h1", prevSize: 10, nextSize: 20 },
      },
    ]);
    // 观测面（deps.onLine）仍先于编排动作转发（wire 观测不变量）
    expect(observed.map((l) => l.type)).toEqual(["file-write"]);
  });

  test("onFileWrite 未注入（容缺）→ 分派 no-op 不抛", () => {
    const launcher = makeLauncher(() => {});
    const dispatch = (
      launcher as unknown as { onChildLine: (id: string, line: ChildOutboundLine) => void }
    ).onChildLine.bind(launcher);
    expect(() =>
      dispatch("agent-1", { type: "file-write", instanceId: "agent-1", path: "/x", prevHash: "h", prevSize: 1, nextSize: 2 }),
    ).not.toThrow();
  });

  test("既有行型不受影响（event 行照常走 onInstanceEvent 通道）", () => {
    let eventForwarded = false;
    const launcher = makeLauncher(() => {});
    (launcher as unknown as { callbacks: unknown }).callbacks = {
      onInstanceEvent: () => {
        eventForwarded = true;
      },
    };
    const dispatch = (
      launcher as unknown as { onChildLine: (id: string, line: ChildOutboundLine) => void }
    ).onChildLine.bind(launcher);
    dispatch("agent-1", {
      type: "event",
      instanceId: "agent-1",
      event: { type: "agent_start" } as never,
    });
    expect(eventForwarded).toBe(true);
  });
});
