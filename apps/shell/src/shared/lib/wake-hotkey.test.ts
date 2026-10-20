// @vitest-environment jsdom
/**
 * wake-hotkey 全局组合键注册面测试（B4；TDD 红→绿）。
 *
 * - 装载注册：sync 读 localStorage 偏好 → combo→accel → seam register（含
 *   触发回调接线到 fire handler）；
 * - 热更新：偏好改动后再 sync → 先 unregister 旧值再 register 新值
 *   （unregister 先于 register 的序断言）；同值 sync 零动作幂等；
 * - suspend：录制期间暂注（unregister 旧值不注册新值），结束再 sync 恢复；
 * - 环境面：无壳挂载点（纯浏览器 dev）→ unavailable 零调用；注册异常
 *   （组合键被占用等）→ failed 交代；未设置偏好 → 零注册。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  setWakeHotkeyFireHandler,
  syncWakeHotkeyRegistration,
  resetWakeHotkeyRegistration,
} from "./wake-hotkey";
import { STEWARD_WAKE_HOTKEY_PREF_KEY } from "./voice-pref";

const callOrder: string[] = [];
let registerResult: "ok" | "reject" = "ok";
let registeredAccel: string | null = null;

function installSeam(): { onFire: (() => void) | null } {
  const seam = { onFire: null as (() => void) | null };
  vi.stubGlobal("helixHotkeyRegister", vi.fn(async (accel: string, onFire: () => void) => {
    callOrder.push(`register:${accel}`);
    if (registerResult === "reject") throw new Error("shortcut taken");
    registeredAccel = accel;
    seam.onFire = onFire;
  }));
  vi.stubGlobal("helixHotkeyUnregister", vi.fn(async (accel: string) => {
    callOrder.push(`unregister:${accel}`);
    if (registeredAccel === accel) registeredAccel = null;
  }));
  return seam;
}

beforeEach(() => {
  localStorage.clear();
  resetWakeHotkeyRegistration();
  callOrder.length = 0;
  registerResult = "ok";
  registeredAccel = null;
  setWakeHotkeyFireHandler(null);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("syncWakeHotkeyRegistration（装载注册 + 设置热更新）", () => {
  it("偏好有值 → 装载注册：accel 换算 + 回调接线（触发即达 fire handler）", async () => {
    const seam = installSeam();
    localStorage.setItem(STEWARD_WAKE_HOTKEY_PREF_KEY, "⌘⇧K");
    const fired = vi.fn();
    setWakeHotkeyFireHandler(fired);
    await expect(syncWakeHotkeyRegistration()).resolves.toBe("ok");
    expect(callOrder).toEqual(["register:CommandOrControl+Shift+K"]);
    seam.onFire?.();
    expect(fired).toHaveBeenCalledTimes(1);
  });

  it("设置改动 → unregister 旧值 + register 新值（热更新，序断言）", async () => {
    installSeam();
    localStorage.setItem(STEWARD_WAKE_HOTKEY_PREF_KEY, "⌘⇧K");
    await syncWakeHotkeyRegistration();
    callOrder.length = 0;
    // 设置页改值（写偏好 + sync）
    localStorage.setItem(STEWARD_WAKE_HOTKEY_PREF_KEY, "⌥Space");
    await expect(syncWakeHotkeyRegistration()).resolves.toBe("ok");
    expect(callOrder).toEqual(["unregister:CommandOrControl+Shift+K", "register:Alt+Space"]);
  });

  it("同值 sync 零动作（幂等——不重复 register）", async () => {
    installSeam();
    localStorage.setItem(STEWARD_WAKE_HOTKEY_PREF_KEY, "⌘⇧K");
    await syncWakeHotkeyRegistration();
    callOrder.length = 0;
    await expect(syncWakeHotkeyRegistration()).resolves.toBe("ok");
    expect(callOrder).toEqual([]);
  });

  it("suspend：录制期间暂注（unregister 后不注册）；再 sync 恢复注册", async () => {
    installSeam();
    localStorage.setItem(STEWARD_WAKE_HOTKEY_PREF_KEY, "⌘⇧K");
    await syncWakeHotkeyRegistration();
    callOrder.length = 0;
    await expect(syncWakeHotkeyRegistration({ suspend: true })).resolves.toBe("ok");
    expect(callOrder).toEqual(["unregister:CommandOrControl+Shift+K"]);
    callOrder.length = 0;
    await expect(syncWakeHotkeyRegistration()).resolves.toBe("ok");
    expect(callOrder).toEqual(["register:CommandOrControl+Shift+K"]);
  });

  it("偏好清空（null）→ unregister 旧值 + 零注册", async () => {
    installSeam();
    localStorage.setItem(STEWARD_WAKE_HOTKEY_PREF_KEY, "⌘⇧K");
    await syncWakeHotkeyRegistration();
    callOrder.length = 0;
    localStorage.removeItem(STEWARD_WAKE_HOTKEY_PREF_KEY);
    await expect(syncWakeHotkeyRegistration()).resolves.toBe("ok");
    expect(callOrder).toEqual(["unregister:CommandOrControl+Shift+K"]);
  });

  it("无壳挂载点（纯浏览器 dev）→ unavailable，零调用", async () => {
    localStorage.setItem(STEWARD_WAKE_HOTKEY_PREF_KEY, "⌘⇧K");
    await expect(syncWakeHotkeyRegistration()).resolves.toBe("unavailable");
    expect(globalThis.helixHotkeyRegister).toBeUndefined();
  });

  it("注册失败（组合键被占用等）→ failed 交代（不吞错）", async () => {
    installSeam();
    registerResult = "reject";
    localStorage.setItem(STEWARD_WAKE_HOTKEY_PREF_KEY, "⌘⇧K");
    await expect(syncWakeHotkeyRegistration()).resolves.toBe("failed");
  });

  it("并发 sync 串行化：两次未 await 的 sync 不双注册（镜像读-改-写原子）", async () => {
    installSeam();
    localStorage.setItem(STEWARD_WAKE_HOTKEY_PREF_KEY, "⌘⇧K");
    // 挂载 sync 与设置热更新相交错（同一拍两个调用）：后到者必读到前者的
    //  注册结果镜像，不得在镜仍为 null 时再 register（壳侧组合键被双写）
    const [r1, r2] = await Promise.all([syncWakeHotkeyRegistration(), syncWakeHotkeyRegistration()]);
    expect([r1, r2]).toEqual(["ok", "ok"]);
    expect(callOrder).toEqual(["register:CommandOrControl+Shift+K"]);
  });

  it("并发 sync 串行化：先挂载注册后 suspend，末次调用定终态（不交错漏注销）", async () => {
    installSeam();
    localStorage.setItem(STEWARD_WAKE_HOTKEY_PREF_KEY, "⌘⇧K");
    await Promise.all([syncWakeHotkeyRegistration(), syncWakeHotkeyRegistration({ suspend: true })]);
    expect(callOrder).toEqual(["register:CommandOrControl+Shift+K", "unregister:CommandOrControl+Shift+K"]);
    expect(registeredAccel).toBeNull();
  });
});
