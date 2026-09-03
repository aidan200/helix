// @vitest-environment jsdom
/**
 * SessionContext 命令/订阅面注册表守护测试（M38 注册表化）。
 *
 * 替代原「接口声明 + useCallback + value 对象 + deps 数组」四点联动人工核对：
 * - 注册表项（COMMAND_SURFACE / LISTEN_SURFACE 键）与 context value 面对象键
 *   严格一致——漏登任一点即红（注册表项 = 唯一登记点，结构性免疫
 *   sendKgCandidatesList 漏 deps 类缺陷）；
 * - 订阅面函数语义：listener 入集 → 帧转发到达；退订函数 → 不再到达
 *   （LISTEN_SURFACE 谓词驱动转发的端到端钉死）。
 *
 * HelixWsClient 以 stub 替身注入（同 SessionContext.mode.test.tsx 先例）。
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
    retry(): void {
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
import { COMMAND_SURFACE, LISTEN_SURFACE } from "./command-surface";

/** 替身实例面（mock 工厂内类的实例形态；实例成员仅测试消费面子集）。 */
interface Stub {
  sent: CommandEnvelope[];
  emitFrame(e: EventEnvelope): void;
}

const stub = (): Stub =>
  (HelixWsClient as unknown as { instances: Stub[] }).instances.at(-1)!;

/** 捕获 context value 的探针组件。 */
function probe(): { current: ReturnType<typeof useSession> | null } {
  const box: { current: ReturnType<typeof useSession> | null } = { current: null };
  function Probe() {
    box.current = useSession();
    return null;
  }
  render(
    <SessionProvider>
      <Probe />
    </SessionProvider>,
  );
  return box;
}

describe("SessionContext 命令/订阅面注册表守护（M38）", () => {
  beforeEach(() => {
    (HelixWsClient as unknown as { instances: Stub[] }).instances.length = 0;
  });
  afterEach(() => {
    cleanup();
  });

  it("注册表项与 value 面对象键严格一致（注册表项 = 唯一登记点）", () => {
    const box = probe();
    const value = box.current!;
    const registered = new Set([
      ...Object.keys(COMMAND_SURFACE),
      ...Object.keys(LISTEN_SURFACE),
    ]);
    const valueKeys = Object.keys(value).filter((k) => k !== "state" && k !== "topology");
    // ① 每个注册表项都出现在 value 面且为函数（漏摊入即红）
    for (const key of registered) {
      expect(typeof (value as unknown as Record<string, unknown>)[key], `注册表项未登记到 value 面：${key}`).toBe("function");
    }
    // ② value 面无注册表外键（绕过注册表的手工登记即红）
    for (const key of valueKeys) {
      expect(registered.has(key), `value 面存在注册表外方法：${key}`).toBe(true);
    }
    expect(valueKeys.length).toBe(registered.size);
  });

  it("订阅面谓词驱动转发：listener 收到命中帧，退订后不再收到（kg 域抽查）", () => {
    const box = probe();
    const received: EventEnvelope[] = [];
    const off = box.current!.subscribeKgFrames((e) => received.push(e));
    const frame = (type: string) =>
      ({ v: "0.2", type, payload: {} }) as unknown as EventEnvelope;
    act(() => {
      stub().emitFrame(frame("kg.list.result"));
      stub().emitFrame(frame("connection.error"));
      stub().emitFrame(frame("task.changed")); // 非 kg 域谓词命中——不转发
    });
    expect(received.map((e) => e.type)).toEqual(["kg.list.result", "connection.error"]);
    off();
    act(() => {
      stub().emitFrame(frame("kg.list.result"));
    });
    expect(received).toHaveLength(2);
  });

  it("订阅面谓词驱动转发：workspace 域命中 changed 广播（跨域抽查）", () => {
    const box = probe();
    const received: EventEnvelope[] = [];
    const off = box.current!.subscribeWorkspaceFrames((e) => received.push(e));
    const frame = (type: string) =>
      ({ v: "0.2", type, payload: {} }) as unknown as EventEnvelope;
    act(() => {
      stub().emitFrame(frame("workspace_changed"));
      stub().emitFrame(frame("workspace.open.result"));
      stub().emitFrame(frame("kg.list.result")); // 非 workspace 域——不转发
    });
    expect(received.map((e) => e.type)).toEqual(["workspace_changed", "workspace.open.result"]);
    off();
  });
});
