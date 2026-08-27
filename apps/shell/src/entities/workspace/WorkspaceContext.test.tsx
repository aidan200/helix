// @vitest-environment jsdom
/**
 * entities/workspace 门禁状态机接线测试（W3；设计稿 §2.1 / brief 任务 1）。
 *
 * 覆盖 provider 层全链（reducer 纯函数面已单测——此处钉接线缝）：
 * - 连接就绪（deps.connected=true）自动 workspace.get 一次 + 重连重发
 *   （webStatus 先例）；get 回执 bound/null 两分支分流 phase；
 * - openWorkspace：open-started + workspace.open 发出；回执成功 → main；
 * - open 失败：connection.error（结构化错误码）→ 行内 openError + gate 保持；
 *   非在途 connection.error 不误消费（opening 单飞门控，trace 先例）；
 * - send 失败（断连）→ 本地合成错误码（按钮不永久禁用）；
 * - workspace_changed 广播 → main 态 current 跟随。
 *
 * deps 注入面（AG-15 依赖倒置）：直接以 stub deps 渲染——无 useSession /
 * HelixWsClient / daemon。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import type { EventEnvelope } from "@helix/protocol";
import { WorkspaceProvider, useWorkspace, type WorkspaceDeps } from "./WorkspaceContext";
import type { WorkspaceState } from "./model/workspace-store";

let sentGet = 0;
let sentOpen: string[] = [];
let connected = false;
let sendOpenOk = true;
let listeners: ((e: EventEnvelope) => void)[] = [];

function makeDeps(): WorkspaceDeps {
  return {
    connected,
    sendGet: () => {
      sentGet += 1;
      return true;
    },
    sendOpen: (root: string) => {
      sentOpen.push(root);
      return sendOpenOk;
    },
    subscribe: (cb: (e: EventEnvelope) => void) => {
      listeners.push(cb);
      return () => {
        listeners = listeners.filter((l) => l !== cb);
      };
    },
  };
}

/** 探针：渲染期捕获 workspace store / 动作面。 */
let probe: { state: WorkspaceState; openWorkspace: (root: string) => boolean } | null = null;
function Probe() {
  probe = useWorkspace();
  return null;
}

let view: ReturnType<typeof render> | null = null;
function mount() {
  view = render(
    <WorkspaceProvider deps={makeDeps()}>
      <Probe />
    </WorkspaceProvider>,
  );
  return view;
}

/** deps.connected 变化 = app 层重渲（rerender 传新 deps）。 */
function setConnected(next: boolean) {
  connected = next;
  act(() => {
    view!.rerender(
      <WorkspaceProvider deps={makeDeps()}>
        <Probe />
      </WorkspaceProvider>,
    );
  });
}

function frame(type: string, payload: unknown): EventEnvelope {
  return { v: 0, type, sessionId: "__system__", channel: "workspace", payload } as EventEnvelope;
}

function feed(e: EventEnvelope) {
  act(() => {
    for (const l of [...listeners]) l(e);
  });
}

beforeEach(() => {
  sentGet = 0;
  sentOpen = [];
  connected = false;
  sendOpenOk = true;
  listeners = [];
  probe = null;
});
afterEach(() => {
  cleanup();
  view = null;
});

describe("WorkspaceProvider · 门禁读面（连接就绪 → get → 分流）", () => {
  it("未连接不发 workspace.get；connected 即发一次", () => {
    mount();
    expect(sentGet).toBe(0);
    expect(probe!.state.phase).toBe("connecting");
    setConnected(true);
    expect(sentGet).toBe(1);
  });

  it("重连（connected → false → true）重发 get（webStatus 先例）", () => {
    connected = true;
    mount();
    expect(sentGet).toBe(1);
    setConnected(false);
    setConnected(true);
    expect(sentGet).toBe(2);
  });

  it("get 回执 bound → phase=main（current/recents 落位）", () => {
    connected = true;
    mount();
    feed(frame("workspace.get.result", { current: { root: "/ws/helix" }, recents: [] }));
    expect(probe!.state.phase).toBe("main");
    expect(probe!.state.current).toEqual({ root: "/ws/helix" });
  });

  it("get 回执 null → phase=gate + recents/notice 承接（选择页数据源）", () => {
    connected = true;
    mount();
    feed(
      frame("workspace.get.result", {
        current: null,
        recents: [{ root: "/ws/a", name: "a", lastUsedAt: "2026-08-27T10:00:00+08:00", valid: true }],
        notice: "上次的工作空间已不可用：路径不存在",
      }),
    );
    expect(probe!.state.phase).toBe("gate");
    expect(probe!.state.recents).toHaveLength(1);
    expect(probe!.state.notice).toBe("上次的工作空间已不可用：路径不存在");
  });
});

describe("WorkspaceProvider · open 写面", () => {
  function toGate() {
    connected = true;
    mount();
    feed(frame("workspace.get.result", { current: null, recents: [] }));
    expect(probe!.state.phase).toBe("gate");
  }

  it("openWorkspace → open-started + workspace.open 命令发出；回执成功 → main", () => {
    toGate();
    act(() => {
      probe!.openWorkspace("/ws/helix");
    });
    expect(sentOpen).toEqual(["/ws/helix"]);
    expect(probe!.state.opening).toBe(true);
    feed(frame("workspace.open.result", { root: "/ws/helix", projects: [] }));
    expect(probe!.state.phase).toBe("main");
    expect(probe!.state.current).toEqual({ root: "/ws/helix" });
    expect(probe!.state.opening).toBe(false);
  });

  it("open 在途收到 connection.error（结构化错误码）→ openError 行内展示 + gate 保持", () => {
    toGate();
    act(() => {
      probe!.openWorkspace("/nope");
    });
    feed(frame("connection.error", { code: "WORKSPACE_E_INVALID_ROOT", message: "路径不是可读目录：/nope" }));
    expect(probe!.state.phase).toBe("gate");
    expect(probe!.state.opening).toBe(false);
    expect(probe!.state.openError).toEqual({ code: "WORKSPACE_E_INVALID_ROOT", message: "路径不是可读目录：/nope" });
  });

  it("非在途 connection.error 不误消费（opening 单飞门控——其它命令错误不污染门禁）", () => {
    connected = true;
    mount();
    feed(frame("workspace.get.result", { current: { root: "/ws/helix" }, recents: [] }));
    feed(frame("connection.error", { code: "model_not_found", message: "x" }));
    expect(probe!.state.openError).toBeNull();
    expect(probe!.state.phase).toBe("main");
  });

  it("send 失败（断连）→ 本地合成错误（提交禁用态即时收口，不等回执）", () => {
    toGate();
    sendOpenOk = false;
    act(() => {
      probe!.openWorkspace("/nope");
    });
    expect(sentOpen).toEqual(["/nope"]);
    expect(probe!.state.opening).toBe(false);
    expect(probe!.state.openError).toEqual({ code: "send-failed", message: "" });
    expect(probe!.state.phase).toBe("gate");
  });

  it("open 在途断连重连（connected 重发 get）→ 在途/行内错误重置（防按钮永久禁用）", () => {
    toGate();
    sendOpenOk = false;
    act(() => {
      probe!.openWorkspace("/nope");
    });
    sendOpenOk = true;
    setConnected(false);
    setConnected(true);
    expect(probe!.state.opening).toBe(false);
    expect(probe!.state.openError).toBeNull();
    // phase 不回退（重判前保持 gate）
    expect(probe!.state.phase).toBe("gate");
  });
});

describe("workspace_changed 广播跟随（W3 只保 store 一致）", () => {
  it("main 态 current 跟随新 root", () => {
    connected = true;
    mount();
    feed(frame("workspace.get.result", { current: { root: "/ws/a" }, recents: [] }));
    feed(frame("workspace_changed", { root: "/ws/b" }));
    expect(probe!.state.current).toEqual({ root: "/ws/b" });
    expect(probe!.state.phase).toBe("main");
  });
});
