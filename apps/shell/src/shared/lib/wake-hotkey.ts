/**
 * wake-hotkey —— 全局组合键注册面（B4；注册时机单点）。
 *
 * 两条注册纪律（brief 口径）：
 * - webview 装载后读 localStorage 偏好即注册（useStewardVoice 挂载时 sync；
 *   壳不读 ~/.helix/，偏好读取全在前端——红线不破）；
 * - 设置改动即 unregister + register 热更新（sync 幂等差分：同值零动作）。
 *
 * 录制期间暂注（suspend）：录制控件捕获的按键若恰为已注册组合键，OS 层
 * 会同时触发全局快捷键——进录制先 unregister、收尾 sync 恢复，杜绝边录边
 * 触发的自激。注册失败（组合键被其他应用占用等）→ "failed" 交调用方行内
 * 交代（不吞错，W6j 同规）；纯浏览器 dev 无挂载点 → "unavailable" 休眠。
 *
 * 模块单例语义：注册事实源在壳侧（tauri-plugin-global-shortcut），本模块持
 * 单槽镜像（registeredAccel）+ 单槽触发回调转发——组合键唯一（B4 批次
 * 钳制：一设置项一组合键），多实例无场景。
 */
import { hasHotkeyCapability, nativeHotkeyRegister, nativeHotkeyUnregister } from "@/shared/api/native-capability";
import { comboToAccel } from "./hotkey-combo";
import { readWakeHotkeyPref } from "./voice-pref";

/** sync 结果（调用方反馈面判据）。 */
export type WakeHotkeySyncResult =
  /** 已达目标注册态（含同值幂等零动作 / 偏好未设置零注册）。 */
  | "ok"
  /** 无壳挂载点（纯浏览器 dev）：休眠降级。 */
  | "unavailable"
  /** 注册失败（组合键被占用/能力未授予等）：调用方行内交代。 */
  | "failed";

let fireHandler: (() => void) | null = null;
let registeredAccel: string | null = null;

/** 接线触发回调（useStewardVoice 挂载时持有、卸载清位）。 */
export function setWakeHotkeyFireHandler(handler: (() => void) | null): void {
  fireHandler = handler;
}

/** 清位全部模块态（测试缝 + 卸载兜底）。 */
export function resetWakeHotkeyRegistration(): void {
  fireHandler = null;
  registeredAccel = null;
}

/**
 * 对齐壳侧注册态与偏好（幂等差分）：
 * - `suspend` = true：录制期间暂注（目标态 = 零注册）；
 * - 目标与镜像一致 → 零动作；
 * - 换值/清值 → 先 unregister 旧值（注销失败不阻塞重注册）再 register 新值。
 */
export async function syncWakeHotkeyRegistration(opts?: { readonly suspend?: boolean }): Promise<WakeHotkeySyncResult> {
  const pref = readWakeHotkeyPref();
  const target = opts?.suspend === true ? null : pref !== null ? comboToAccel(pref) : null;
  if (!hasHotkeyCapability()) return "unavailable";
  if (target === registeredAccel) return "ok";
  if (registeredAccel !== null) {
    const old = registeredAccel;
    registeredAccel = null;
    try {
      await nativeHotkeyUnregister(old);
    } catch {
      // 注销失败不阻塞重注册（镜像已清位——宁漏注销不卡死注册面）
    }
  }
  if (target === null) return "ok";
  try {
    await nativeHotkeyRegister(target, () => {
      fireHandler?.();
    });
    registeredAccel = target;
    return "ok";
  } catch {
    registeredAccel = null;
    return "failed";
  }
}
