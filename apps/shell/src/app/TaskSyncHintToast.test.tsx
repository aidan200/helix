// @vitest-environment jsdom
/**
 * TaskSyncHintToast 订阅补订的 send 消费（code-review 低危）。
 *
 * 背景：连接就绪（首挂/重连）时补发 task.subscribe（重连后服务端连接级订阅
 * 表已清）。旧实现丢弃 send 返回值——conn 刚迁 connected 但 socket 已断的
 * 窗口里 send=false（帧被 HelixWsClient 丢弃），却把 prevConn 记成
 * 「已订阅」，此后不再补订，syncHint 广播整段不达（TR-84/TR-168「send 返回值
 * 必消费」纪律）。
 *
 * 钉法：send 返回 false 时不记已订阅态——下一次 effect 重跑（conn 迁移或
 * sender 身份变化）必须重试补订。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";

let conn = "disconnected";
let sendResult: boolean | undefined = true;
const sendSpy = vi.fn(() => sendResult);

vi.mock("@/entities/session/SessionContext", () => ({
  useSession: () => ({
    state: { conn },
    // 每次渲染返回新函数身份（模拟 provider 重渲）——effect 随身份变化重跑
    sendTaskSubscribe: () => sendSpy(),
    subscribeTaskFrames: () => () => undefined,
  }),
}));

vi.mock("@/shared/ui/Toast", () => ({
  useToast: () => ({ push: () => undefined }),
}));

import TaskSyncHintToast from "./TaskSyncHintToast";

afterEach(() => {
  cleanup();
  sendSpy.mockClear();
  conn = "disconnected";
  sendResult = true;
});

describe("TaskSyncHintToast 重连补订（send 返回值消费）", () => {
  it("send=true：连接就绪补订一次，已在订阅态不重复", () => {
    const { rerender } = render(<TaskSyncHintToast />);
    expect(sendSpy).not.toHaveBeenCalled(); // 未连接不补订
    conn = "connected";
    rerender(<TaskSyncHintToast />);
    expect(sendSpy).toHaveBeenCalledTimes(1);
    rerender(<TaskSyncHintToast />); // 同 conn 下 effect 重跑：不重复补订
    expect(sendSpy).toHaveBeenCalledTimes(1);
  });

  it("send=false（断线窗口帧丢弃）→ 不记已订阅态，下次 effect 重跑重试补订", () => {
    sendResult = false;
    const { rerender } = render(<TaskSyncHintToast />);
    conn = "connected";
    rerender(<TaskSyncHintToast />);
    expect(sendSpy).toHaveBeenCalledTimes(1);
    // 首次补订未发出：下一次 effect 重跑必须重试（旧实现此处静默放弃）
    rerender(<TaskSyncHintToast />);
    expect(sendSpy).toHaveBeenCalledTimes(2);
    // 重试成功后才进入已订阅态
    sendResult = true;
    rerender(<TaskSyncHintToast />);
    expect(sendSpy).toHaveBeenCalledTimes(3);
    rerender(<TaskSyncHintToast />);
    expect(sendSpy).toHaveBeenCalledTimes(3);
  });
});
