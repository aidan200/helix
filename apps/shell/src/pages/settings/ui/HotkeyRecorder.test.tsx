// @vitest-environment jsdom
/**
 * 组合键录制控件测试（B4 设置页管家组「快捷键（组合键）」；TDD 红→绿）。
 *
 * - 录制形态：点击进入录制（回显切录制提示）；按下合法组合即定格显示
 *   （如「⌘⇧K」）并写偏好 + 触发注册热更新；
 * - 修饰键拒单键：无修饰主键 → 行内提示 + 留在录制态；修饰键单独按下忽略；
 * - Esc 取消：退出录制、值不变（偏好零写入）、恢复注册；
 * - 冲突重复值：与现值相同的组合 → 行内提示 + 留在录制态（不重复写）；
 * - 清除：值清空回「未设置」+ 偏好清空 + 热更新注销；
 * - 注册失败（组合键被占用等）→ 行内错误交代（不吞错）；
 * - 录制期间暂注（suspend）：进录制先 unregister，收尾再 sync 恢复。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, fireEvent } from "@testing-library/react";
import { I18nProvider } from "@/shared/i18n";
import { STEWARD_WAKE_HOTKEY_PREF_KEY } from "@/shared/lib/voice-pref";

const syncWakeHotkeyRegistration = vi.fn(
  async (_opts?: unknown): Promise<"ok" | "failed" | "unavailable"> => "ok",
);
vi.mock("@/shared/lib/wake-hotkey", () => ({
  setWakeHotkeyFireHandler: vi.fn(),
  // 惰性包装（vi.mock 工厂提升：顶层 const 不得在工厂求值期解引用）
  syncWakeHotkeyRegistration: (opts?: unknown) => syncWakeHotkeyRegistration(opts),
}));

import HotkeyRecorder from "./HotkeyRecorder";

function renderRecorder() {
  return render(
    <I18nProvider>
      <HotkeyRecorder />
    </I18nProvider>,
  );
}

beforeEach(() => {
  localStorage.clear();
  // jsdom navigator.language 默认 en-US：钉 zh-CN（断言文案确定性）
  localStorage.setItem("helix-lang", "zh-CN");
  syncWakeHotkeyRegistration.mockClear();
  syncWakeHotkeyRegistration.mockResolvedValue("ok");
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("HotkeyRecorder（按键录制形态）", () => {
  it("未设置初始态：显示「未设置」+ 录制钮", () => {
    renderRecorder();
    expect(screen.getByTestId("hotkey-record")).toBeTruthy();
    expect(screen.getByTestId("hotkey-value").textContent).toBe("未设置");
  });

  it("点击进入录制：回显切录制提示 + 暂注（suspend sync）", () => {
    renderRecorder();
    fireEvent.click(screen.getByTestId("hotkey-record"));
    expect(screen.getByTestId("hotkey-value").textContent).toContain("…");
    expect(syncWakeHotkeyRegistration).toHaveBeenCalledWith({ suspend: true });
  });

  it("合法组合按下即定格：「⌘⇧K」回显 + 偏好写入 + 注册热更新", async () => {
    renderRecorder();
    fireEvent.click(screen.getByTestId("hotkey-record"));
    fireEvent.keyDown(window, { key: "K", metaKey: true, shiftKey: true });
    expect(screen.getByTestId("hotkey-value").textContent).toBe("⌘⇧K");
    expect(localStorage.getItem(STEWARD_WAKE_HOTKEY_PREF_KEY)).toBe("⌘⇧K");
    // 三次 = 进录制暂注（effect 体 suspend）+ commit 热更新（await 版）+
    // 离开录制恢复（effect cleanup；幂等重放，B22 #2 卸载兑底面）
    await vi.waitFor(() => expect(syncWakeHotkeyRegistration).toHaveBeenCalledTimes(3));
  });

  it("修饰键拒单键：行内提示 + 留在录制态；修饰键单独按下忽略", () => {
    renderRecorder();
    fireEvent.click(screen.getByTestId("hotkey-record"));
    fireEvent.keyDown(window, { key: "k" });
    expect(screen.getByTestId("hotkey-need-modifier")).toBeTruthy();
    expect(screen.getByTestId("hotkey-value").textContent).toContain("…"); // 仍在录制
    // 修饰键单独按下：无提示变化（不完整组合，继续等主键）
    fireEvent.keyDown(window, { key: "Shift", shiftKey: true });
    expect(screen.getByTestId("hotkey-value").textContent).toContain("…");
  });

  it("Esc 取消：退出录制、值不变（偏好零写入）", () => {
    renderRecorder();
    fireEvent.click(screen.getByTestId("hotkey-record"));
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByTestId("hotkey-need-modifier")).toBeNull();
    expect(localStorage.getItem(STEWARD_WAKE_HOTKEY_PREF_KEY)).toBeNull();
    // 已退出录制（回显不再是录制提示）
    expect(screen.getByTestId("hotkey-value").textContent).not.toContain("…");
  });

  it("冲突重复值：与现值相同的组合 → 行内提示 + 留在录制态（不重复写）", () => {
    localStorage.setItem(STEWARD_WAKE_HOTKEY_PREF_KEY, "⌘⇧K");
    renderRecorder();
    expect(screen.getByTestId("hotkey-value").textContent).toBe("⌘⇧K");
    fireEvent.click(screen.getByTestId("hotkey-record"));
    fireEvent.keyDown(window, { key: "K", metaKey: true, shiftKey: true });
    expect(screen.getByTestId("hotkey-duplicate")).toBeTruthy();
    expect(screen.getByTestId("hotkey-value").textContent).toContain("…"); // 仍在录制
    expect(localStorage.getItem(STEWARD_WAKE_HOTKEY_PREF_KEY)).toBe("⌘⇧K"); // 值未变
  });

  it("清除：值回「未设置」+ 偏好清空 + 热更新注销", async () => {
    localStorage.setItem(STEWARD_WAKE_HOTKEY_PREF_KEY, "⌘⇧K");
    renderRecorder();
    fireEvent.click(screen.getByTestId("hotkey-clear"));
    expect(localStorage.getItem(STEWARD_WAKE_HOTKEY_PREF_KEY)).toBeNull();
    await vi.waitFor(() => expect(syncWakeHotkeyRegistration).toHaveBeenCalled());
  });

  it("注册失败（组合键被占用等）→ 行内错误交代（不吞错）", async () => {
    syncWakeHotkeyRegistration.mockResolvedValue("failed");
    renderRecorder();
    fireEvent.click(screen.getByTestId("hotkey-record"));
    fireEvent.keyDown(window, { key: "K", metaKey: true, shiftKey: true });
    await vi.waitFor(() => expect(screen.getByTestId("hotkey-register-error")).toBeTruthy());
  });

  // code-review task-91e2e2f9 B22 #2：录制态卸载恢复注册
  it("录制态组件卸载：effect cleanup 兜底恢复唤醒组合键注册（切分区/离开页面不静默失灵）", () => {
    const { unmount } = renderRecorder();
    fireEvent.click(screen.getByTestId("hotkey-record"));
    expect(syncWakeHotkeyRegistration).toHaveBeenCalledWith({ suspend: true });
    syncWakeHotkeyRegistration.mockClear();
    unmount(); // 录制态下卸载（Esc/commit 两条收尾路径均不经过）
    // 旧代码：cleanup 只移除键盘监听——唤醒组合键静默失灵直到重新录制
    //（mock 包装层显式透传 opts：无参调用落参为 undefined）
    expect(syncWakeHotkeyRegistration).toHaveBeenCalledWith(undefined);
    expect(syncWakeHotkeyRegistration).not.toHaveBeenCalledWith({ suspend: true });
  });
});
