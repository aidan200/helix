/**
 * createKgFramesListener 单测（M9 #2.31 拆分：kg 族帧订阅 listener 独立模块）。
 *
 * 钉住语义：
 * - connection.error：读面 loading 收口（clearReadLoading 必调）+ 写面错误
 *   经 flight.notifyError 归因（单飞位零顺序链）；
 * - 写面回执经 flight.settle(kind) 归因——settle false（非本视图发起）零副作用；
 * - 读面回执（health/candidates/list）落对应回调/dispatch。
 */
import { describe, expect, it, vi } from "vitest";
import type { EventEnvelope } from "@helix/protocol";
import { createKgViewState, type KgAction, type KgViewState } from "./kg-model";
import { createKgFramesListener, type KgFramesListenerDeps } from "./kg-frames-listener";

function setup(opts: { sel?: string | null; settleResult?: boolean } = {}) {
  const state: KgViewState = { ...createKgViewState(), sel: opts.sel ?? null };
  const dispatched: KgAction[] = [];
  const toasts: { kind: string; text: string }[] = [];
  const deps: KgFramesListenerDeps = {
    projectName: "helix",
    stateRef: { current: state },
    dispatch: (a) => {
      dispatched.push(a);
    },
    flight: {
      settle: vi.fn(() => opts.settleResult ?? true),
      notifyError: vi.fn(),
    },
    sendKgNodeDetail: vi.fn(() => true),
    sendKgList: vi.fn(() => true),
    sendKgChangeReport: vi.fn(() => true),
    sendKgIndexStatus: vi.fn(() => true),
    sendKgProjects: vi.fn(() => true),
    projectDispatch: vi.fn(),
    toast: { push: (kind, text) => toasts.push({ kind, text }) },
    t: (key) => key,
    onHealthResult: vi.fn(),
    onCandidatesResult: vi.fn(),
    clearReadLoading: vi.fn(),
    markReviewLaunched: vi.fn(),
    markCodeReviewLaunched: vi.fn(),
  };
  const listener = createKgFramesListener(deps);
  return { deps, listener, dispatched, toasts };
}

const frame = (type: string, payload: unknown): EventEnvelope =>
  ({ v: "0.11", type, sessionId: "__system__", channel: "kg", payload }) as EventEnvelope;

describe("createKgFramesListener（M9 #2.31）", () => {
  it("connection.error：读面 loading 收口 + 写面错误经 notifyError 归因", () => {
    const { deps, listener } = setup();
    listener(frame("connection.error", { code: "kg.graph.purge_blocked", message: "存在运行中任务" }));
    expect(deps.clearReadLoading).toHaveBeenCalledTimes(1); // 体检/台账 loading 不恒真
    expect(deps.flight.notifyError).toHaveBeenCalledWith("存在运行中任务");
  });

  it("connection.error payload 缺 message → 兜底 'error' 串", () => {
    const { deps, listener } = setup();
    listener(frame("connection.error", {}));
    expect(deps.flight.notifyError).toHaveBeenCalledWith("error");
  });

  it("写面回执 settle false（非本视图发起）→ 零副作用", () => {
    const { deps, listener, toasts } = setup({ settleResult: false });
    listener(frame("kg.review.create.result", { ok: true, jobId: "j1" }));
    expect(deps.markReviewLaunched).not.toHaveBeenCalled();
    expect(deps.sendKgProjects).not.toHaveBeenCalled();
    expect(toasts).toHaveLength(0);
  });

  it("kg.review.create.result settle true → launched + 重拉 projects + ok toast", () => {
    const { deps, listener, toasts } = setup({ settleResult: true });
    listener(frame("kg.review.create.result", { ok: true, jobId: "j1" }));
    expect(deps.flight.settle).toHaveBeenCalledWith("review");
    expect(deps.markReviewLaunched).toHaveBeenCalledTimes(1);
    expect(deps.sendKgProjects).toHaveBeenCalledTimes(1);
    expect(toasts).toEqual([{ kind: "ok", text: "pj.health.reviewOkToast" }]);
  });

  it("code.review.create.result 归因 codeReview kind", () => {
    const { deps, listener } = setup({ settleResult: true });
    listener(frame("code.review.create.result", { ok: true, jobId: "j2" }));
    expect(deps.flight.settle).toHaveBeenCalledWith("codeReview");
    expect(deps.markCodeReviewLaunched).toHaveBeenCalledTimes(1);
  });

  it("kg.health.result / kg.candidates.list.result 落读面回调", () => {
    const { deps, listener } = setup();
    const health = { project: "helix", state: "synced" };
    listener(frame("kg.health.result", health));
    expect(deps.onHealthResult).toHaveBeenCalledWith(health);
    listener(frame("kg.candidates.list.result", { rows: [], total: 0 }));
    expect(deps.onCandidatesResult).toHaveBeenCalledWith([], 0);
  });

  it("kg.list.result：dispatch list-result + 首载默认选中发 detail", () => {
    const { deps, listener, dispatched } = setup({ sel: null });
    const nodes = [
      { id: "TR-1", name: "r", kind: "rule", domain: "tech", status: "confirmed", digest: "d" },
      { id: "E-1", name: "e", kind: "entity", domain: null, status: "confirmed", digest: "d" },
    ];
    listener(frame("kg.list.result", { total: 2, nodes }));
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0]).toMatchObject({ type: "list-result", initialSel: "E-1" });
    expect(deps.sendKgNodeDetail).toHaveBeenCalledWith({ project: "helix", id: "E-1" });
  });
});
