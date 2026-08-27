/**
 * workspace 门禁状态机 reducer 单测（W3；设计稿 §2.1）。
 *
 * 三相 phase：connecting（连接/门禁判定中）→ get-result 分流（bound=main /
 * null=gate）；open 写面成功/失败；workspace_changed 广播跟随。纯函数纪律
 * （AG-14）：无 React / 无 IO / 无 Date.now——帧载荷全部测试注入。
 */
import { describe, expect, it } from "vitest";
import type { WorkspaceRecent } from "@helix/protocol";
import {
  createInitialWorkspaceState,
  workspaceReducer,
  type WorkspaceState,
} from "./workspace-store";

const RECENTS: WorkspaceRecent[] = [
  { root: "/ws/helix", name: "helix", lastUsedAt: "2026-08-27T10:00:00+08:00", valid: true },
  { root: "/ws/gone", name: "gone", lastUsedAt: "2026-08-26T09:00:00+08:00", valid: false },
];

describe("get 读面分流（W3 门禁判定）", () => {
  it("get-result current 非 null → phase=main + current 落位 + recents/notice 承接", () => {
    const s = workspaceReducer(createInitialWorkspaceState(), {
      type: "get-result",
      payload: { current: { root: "/ws/helix" }, recents: RECENTS },
    });
    expect(s.phase).toBe("main");
    expect(s.current).toEqual({ root: "/ws/helix" });
    expect(s.recents).toEqual(RECENTS);
    expect(s.notice).toBeNull();
  });

  it("get-result current=null → phase=gate（recents 保留 + notice 降级说明）", () => {
    const s = workspaceReducer(createInitialWorkspaceState(), {
      type: "get-result",
      payload: { current: null, recents: RECENTS, notice: "上次的工作空间已不可用：路径不存在" },
    });
    expect(s.phase).toBe("gate");
    expect(s.current).toBeNull();
    expect(s.notice).toBe("上次的工作空间已不可用：路径不存在");
    expect(s.recents).toEqual(RECENTS);
  });

  it("get-result 无 notice → notice=null（缺省缺席语义）", () => {
    const s = workspaceReducer(createInitialWorkspaceState(), {
      type: "get-result",
      payload: { current: null, recents: [] },
    });
    expect(s.notice).toBeNull();
  });
});

describe("open 写面（成功/失败/在途）", () => {
  it("open-started → opening=true + 清旧 openError", () => {
    let s: WorkspaceState = workspaceReducer(createInitialWorkspaceState(), {
      type: "get-result",
      payload: { current: null, recents: [] },
    });
    s = workspaceReducer(s, { type: "open-failed", error: { code: "WORKSPACE_E_INVALID_ROOT", message: "x" } });
    s = workspaceReducer(s, { type: "open-started" });
    expect(s.opening).toBe(true);
    expect(s.openError).toBeNull();
    expect(s.phase).toBe("gate");
  });

  it("open-result → phase=main + current 更新 + opening 收口 + notice 清空", () => {
    let s: WorkspaceState = workspaceReducer(createInitialWorkspaceState(), {
      type: "get-result",
      payload: { current: null, recents: RECENTS, notice: "上次的工作空间已不可用" },
    });
    s = workspaceReducer(s, { type: "open-started" });
    s = workspaceReducer(s, {
      type: "open-result",
      payload: { root: "/ws/helix", projects: [] },
    });
    expect(s.phase).toBe("main");
    expect(s.current).toEqual({ root: "/ws/helix" });
    expect(s.opening).toBe(false);
    expect(s.openError).toBeNull();
    expect(s.notice).toBeNull();
  });

  it("open-failed（daemon 结构化错误码）→ phase 保持 gate + openError 行内展示位", () => {
    let s: WorkspaceState = workspaceReducer(createInitialWorkspaceState(), {
      type: "get-result",
      payload: { current: null, recents: [] },
    });
    s = workspaceReducer(s, { type: "open-started" });
    s = workspaceReducer(s, {
      type: "open-failed",
      error: { code: "WORKSPACE_E_INVALID_ROOT", message: "路径不是可读目录：/nope" },
    });
    expect(s.phase).toBe("gate");
    expect(s.opening).toBe(false);
    expect(s.openError).toEqual({ code: "WORKSPACE_E_INVALID_ROOT", message: "路径不是可读目录：/nope" });
  });
});

describe("workspace_changed 广播跟随（W3 只保 store 一致）", () => {
  it("main 态收到 changed → current 跟随新 root", () => {
    let s: WorkspaceState = workspaceReducer(createInitialWorkspaceState(), {
      type: "get-result",
      payload: { current: { root: "/ws/a" }, recents: [] },
    });
    s = workspaceReducer(s, { type: "changed", payload: { root: "/ws/b" } });
    expect(s.phase).toBe("main");
    expect(s.current).toEqual({ root: "/ws/b" });
  });

  it("gate 态收到 changed（open 回执前广播先到/他端绑定）→ 跟随进 main + 在途收口", () => {
    let s: WorkspaceState = workspaceReducer(createInitialWorkspaceState(), {
      type: "get-result",
      payload: { current: null, recents: [] },
    });
    s = workspaceReducer(s, { type: "open-started" });
    s = workspaceReducer(s, { type: "changed", payload: { root: "/ws/b" } });
    expect(s.phase).toBe("main");
    expect(s.current).toEqual({ root: "/ws/b" });
    expect(s.opening).toBe(false);
    expect(s.openError).toBeNull();
  });
});

describe("get-started（连接就绪/重连重判）", () => {
  it("清 open 在途与行内错误（open 在途断连回执永不达——防按钮永久禁用）", () => {
    let s: WorkspaceState = workspaceReducer(createInitialWorkspaceState(), {
      type: "get-result",
      payload: { current: null, recents: [] },
    });
    s = workspaceReducer(s, { type: "open-started" });
    s = workspaceReducer(s, { type: "open-failed", error: { code: "WORKSPACE_E_INVALID_ROOT", message: "x" } });
    s = workspaceReducer(s, { type: "open-started" });
    s = workspaceReducer(s, { type: "get-started" });
    expect(s.opening).toBe(false);
    expect(s.openError).toBeNull();
    // phase 不回退（重连重判前保持既有门禁相——新 get-result 到达再翻转）
    expect(s.phase).toBe("gate");
  });
});
