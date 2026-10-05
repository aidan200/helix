// @vitest-environment jsdom
/**
 * 管家感知批（M0.5）StewardNotifyToast：steward.notify 主动通知帧 →
 * 全局 toast（页面无关常驻，CoordNoticeToast/useStewardNavigate 同构）。
 *
 * 断言面：
 * 1. notify 帧 → toast 直渲（title 主行 + body 副行；normal = violet 档、
 *    high = warn 提级——分诊 urgency 裁定）；
 * 2. suggestions 动作面：verb="open_tasks" 建议渲染动作按钮，**点按才动**
 *    （D12-⑤ 播报不附带执行——onClick → onOpenTasks 注入）；
 * 3. 守卫：非 notify 帧不消费；title/body 缺失不渲染空气泡；
 * 4. suggestions 无动作动词（v1 LLM 建议无执行面）→ 纯文本建议进 sub。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import { I18nProvider } from "@/shared/i18n";
import { ToastProvider } from "@/shared/ui/Toast";
import type { EventEnvelope, StewardNotifyPayload } from "@helix/protocol";

type Listener = (e: EventEnvelope) => void;
let stewardListener: Listener | undefined;

vi.mock("@/entities/session/SessionContext", () => ({
  useSession: () => ({
    subscribeStewardFrames: (fn: Listener) => {
      stewardListener = fn;
      return () => {
        stewardListener = undefined;
      };
    },
  }),
}));

import StewardNotifyToast from "./StewardNotifyToast";

function notifyFrame(payload: Partial<StewardNotifyPayload>): EventEnvelope {
  return {
    v: "0.14",
    sessionId: "__system__",
    channel: "steward",
    type: "steward.notify",
    payload: {
      urgency: "normal",
      title: "任务完成",
      body: "M0.5 感知链路已交付，测试全部通过。",
      seq: 1,
      ...payload,
    },
  } as unknown as EventEnvelope;
}

describe("StewardNotifyToast（管家感知 M0.5 主动通知）", () => {
  afterEach(() => {
    cleanup();
    stewardListener = undefined;
  });

  it("notify 帧 → toast 直渲（title 主行 + body 副行）；normal = violet 档", () => {
    render(
      <I18nProvider>
        <ToastProvider>
          <StewardNotifyToast onOpenTasks={() => undefined} />
        </ToastProvider>
      </I18nProvider>,
    );
    act(() => {
      stewardListener?.(notifyFrame({}));
    });
    const toasts = [...document.querySelectorAll(".toast")];
    expect(toasts).toHaveLength(1);
    expect(toasts[0]!.textContent).toContain("任务完成");
    expect(toasts[0]!.textContent).toContain("感知链路已交付");
    expect(toasts[0]!.className).toContain("violet");
  });

  it("high 档 → warn 提级（门控高危）", () => {
    render(
      <I18nProvider>
        <ToastProvider>
          <StewardNotifyToast onOpenTasks={() => undefined} />
        </ToastProvider>
      </I18nProvider>,
    );
    act(() => {
      stewardListener?.(notifyFrame({ urgency: "high", title: "任务失败" }));
    });
    const toasts = [...document.querySelectorAll(".toast")];
    expect(toasts).toHaveLength(1);
    expect(toasts[0]!.className).toContain("warn");
  });

  it("open_tasks 建议渲染动作按钮，点按才动（onClick → onOpenTasks 注入）", async () => {
    const onOpenTasks = vi.fn();
    render(
      <I18nProvider>
        <ToastProvider>
          <StewardNotifyToast onOpenTasks={onOpenTasks} />
        </ToastProvider>
      </I18nProvider>,
    );
    act(() => {
      stewardListener?.(
        notifyFrame({ suggestions: [{ label: "去任务页看看", verb: "open_tasks" }] }),
      );
    });
    const btn = document.querySelector<HTMLButtonElement>(".toast button");
    expect(btn).not.toBeNull();
    expect(btn!.textContent).toContain("去任务页看看");
    expect(onOpenTasks).not.toHaveBeenCalled(); // 未点按零动作
    btn!.click();
    expect(onOpenTasks).toHaveBeenCalledTimes(1); // 点按才动
  });

  it("无动词建议（v1 LLM 建议）→ 无动作按钮，纯建议文本进副行", () => {
    render(
      <I18nProvider>
        <ToastProvider>
          <StewardNotifyToast onOpenTasks={() => undefined} />
        </ToastProvider>
      </I18nProvider>,
    );
    act(() => {
      stewardListener?.(notifyFrame({ suggestions: [{ label: "建议开修复批次" }] }));
    });
    const toasts = [...document.querySelectorAll(".toast")];
    expect(toasts).toHaveLength(1);
    expect(toasts[0]!.textContent).toContain("建议开修复批次");
    expect(toasts[0]!.querySelector("button")).toBeNull(); // 无执行面零按钮
  });

  it("守卫：非 notify 帧不消费；title/body 缺失不渲染空气泡", () => {
    render(
      <I18nProvider>
        <ToastProvider>
          <StewardNotifyToast onOpenTasks={() => undefined} />
        </ToastProvider>
      </I18nProvider>,
    );
    act(() => {
      stewardListener?.({ v: "0.14", type: "steward.feed", payload: {} } as unknown as EventEnvelope);
      stewardListener?.(notifyFrame({ title: "" }));
      stewardListener?.(notifyFrame({ body: "" }));
    });
    expect(document.querySelectorAll(".toast")).toHaveLength(0);
  });
});
