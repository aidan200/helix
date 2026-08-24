// @vitest-environment jsdom
/**
 * SessionContext 槽位读面接线测试（P1 T4；mode-framework-p1 D3/D4）。
 *
 * 覆盖 provider 层三条链（组件/reducer/构造器各自单测之外的接线缝）：
 * - 连接就绪（welcome → conn connected）→ 主动拉 agent.config.list 一次
 *   （topology 级 slots 数据源；web.status 同效应先例）；
 * - agent.config.changed 广播 → revision +1 → 失效重拉 list（新鲜 slots 收口）；
 * - agent.config.list.result 帧 → dispatcher 拓扑级消费落 slots（端到端）；
 * - 草稿首条 send：mode 非 default 随 chat.send{draft:true} 上送，default
 *   不带（构造器裁决归 commands.test.ts，此处钉 provider 接线面）。
 *
 * HelixWsClient 以 stub 替身注入（send 簿记 + frame 回调外驱）——provider
 * 侧唯一 IO 缝；无 daemon / 无真实 WS。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import type { CommandEnvelope, EventEnvelope } from "@helix/protocol";

vi.mock("@/shared/api/helix-ws", () => {
  /** WS 客户端替身：记录出站命令；测试侧经 emitFrame 驱动入站帧。 */
  class StubClient {
    static instances: StubClient[] = [];
    readonly sent: CommandEnvelope[] = [];
    private readonly frameHandlers = new Set<(e: EventEnvelope) => void>();
    private readonly connHandlers = new Set<(c: unknown) => void>();

    constructor(_opts: unknown) {
      StubClient.instances.push(this);
    }
    onFrame(cb: (e: EventEnvelope) => void): () => void {
      this.frameHandlers.add(cb);
      return () => this.frameHandlers.delete(cb);
    }
    onConn(cb: (c: unknown) => void): () => void {
      this.connHandlers.add(cb);
      return () => this.connHandlers.delete(cb);
    }
    start(): void {
      /* 测试侧显式驱动，不自动连 */
    }
    stop(): void {
      /* no-op */
    }
    send(cmd: CommandEnvelope): boolean {
      this.sent.push(cmd);
      return true;
    }
    emitFrame(e: EventEnvelope): void {
      for (const cb of this.frameHandlers) cb(e);
    }
  }
  return { HelixWsClient: StubClient };
});

import { HelixWsClient } from "@/shared/api/helix-ws";
import { SessionProvider, useSession } from "./SessionContext";

/** 替身实例面（mock 工厂内类的实例形态；实例成员仅测试消费面子集）。 */
interface Stub {
  sent: CommandEnvelope[];
  emitFrame(e: EventEnvelope): void;
}
const instances = () => (HelixWsClient as unknown as { instances: Stub[] }).instances;
const stub = () => instances()[0]!;

function frame(type: string, payload: Record<string, unknown>, sessionId?: string): EventEnvelope {
  return {
    v: 0,
    type,
    payload,
    ...(sessionId !== undefined ? { sessionId } : {}),
  } as EventEnvelope;
}

/** 草稿态 welcome（不带 mode——契约：草稿态 welcome 不带 mode）。 */
function draftWelcome(): EventEnvelope {
  return frame("connection.welcome", {
    sessionId: "daemon-mem-draft",
    model: "m/x",
    agentState: "idle",
    draft: true,
  });
}

/** 拓扑探针：渲染期捕获 topology / context 动作面。 */
let probeCtx: ReturnType<typeof useSession> | null = null;
function Probe() {
  probeCtx = useSession();
  return null;
}

function mount() {
  return render(
    <SessionProvider>
      <Probe />
    </SessionProvider>,
  );
}

const sentTypes = () => stub().sent.map((c) => c.type);
const countSent = (type: string) => stub().sent.filter((c) => c.type === type).length;

beforeEach(() => {
  instances().length = 0; // 隔离用例间替身实例
  probeCtx = null;
});
afterEach(cleanup);

describe("SessionContext · 槽位读面接线（P1 T4）", () => {
  it("连接就绪 → 主动拉一次 agent.config.list（与 web.status 同效应）", () => {
    mount();
    expect(sentTypes()).not.toContain("agent.config.list"); // 握手前不发
    act(() => stub().emitFrame(draftWelcome()));
    expect(countSent("agent.config.list")).toBe(1); // 首拉
    expect(sentTypes()).toContain("web.status"); // 先例效应不受影响
  });

  it("agent.config.changed → revision 失效重拉（再次 agent.config.list）", () => {
    mount();
    act(() => stub().emitFrame(draftWelcome()));
    expect(countSent("agent.config.list")).toBe(1);
    act(() =>
      stub().emitFrame(
        frame("agent.config.changed", { profileKind: "main-session", resourceType: "tool", name: "grep", enabled: false }, "system"),
      ),
    );
    expect(countSent("agent.config.list")).toBe(2); // 失效重拉
    expect(probeCtx!.topology.agentConfig.revision).toBe(1);
  });

  it("list.result 帧 → 端到端落 topology slots（dispatcher 拓扑级消费）", () => {
    mount();
    act(() => stub().emitFrame(draftWelcome()));
    expect(probeCtx!.topology.agentConfig.slots).toBeNull(); // 拉取前未设
    act(() =>
      stub().emitFrame(
        frame("agent.config.list.result", {
          profiles: [
            { profileKind: "main-session", tools: [], skills: [], diagnostics: [], model: "openai/gpt-5", thinkingLevel: "high" },
          ],
        }, "system"),
      ),
    );
    expect(probeCtx!.topology.agentConfig.slots).toEqual({
      "main-session": { model: "openai/gpt-5", thinking: "high" },
    });
  });

  it("草稿首条 send：mode=default 不带（协议缺省）；非 default 随 chat.send 上送", () => {
    mount();
    act(() => stub().emitFrame(draftWelcome()));
    // default：不带 mode（构造器裁决 default 缺省）
    act(() => probeCtx!.submit("你好"));
    const first = stub().sent.find((c) => c.type === "chat.send")!;
    expect(first.payload.draft).toBe(true);
    expect("mode" in first.payload).toBe(false);
    // 切模式（丢弃 draft model/thinking 暂存归 reducer）后：mode 随首条上送
    act(() => probeCtx!.setDraftMode("staged"));
    act(() => probeCtx!.submit("第二条"));
    const second = stub().sent.filter((c) => c.type === "chat.send")[1]!;
    expect(second.payload.draft).toBe(true);
    expect(second.payload.mode).toBe("staged");
  });
});
