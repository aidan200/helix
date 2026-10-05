/**
 * shell surface 纯模块（M0 表面协议地基批）：表面自述 + 感知开关（本地闸）。
 *
 * - SHELL_SURFACE_DESCRIPTOR：shell 表面自述（D4 能力协商——capabilities
 *   动词清单；M0 只收编 navigate 一个动词，browser act/动词注册校验面 M2）；
 * - 感知开关：默认 off（D1 感知默认关，隐私一等公民）——off 时 adapter
 *   不上报页面级事件；注册不受开关门（navigate 消费与感知正交）。开关是
 *   本地闸（localStorage），设置面 UI 属后续批次。
 */
import type { SurfaceDescriptor } from "@helix/protocol";

/** shell 表面自述（页面级事件子集 + 零输入采集——M0 边界）。 */
export const SHELL_SURFACE_DESCRIPTOR: SurfaceDescriptor = {
  kind: "shell",
  capabilities: ["navigate"],
  policy: {
    events: ["activated", "navigated"],
    inputCapture: false,
  },
};

/** 感知开关 localStorage 键（"1" = on；缺省/其他 = off）。 */
export const SURFACE_AWARENESS_KEY = "helix.surface.awareness";

/** 感知开关读面（默认 off——D1；异常环境降级 off）。 */
export function isSurfaceAwarenessOn(): boolean {
  try {
    return localStorage.getItem(SURFACE_AWARENESS_KEY) === "1";
  } catch {
    return false;
  }
}

/** 感知开关写面（on = "1"；off = 移除键回缺省态）。 */
export function setSurfaceAwareness(on: boolean): void {
  try {
    if (on) localStorage.setItem(SURFACE_AWARENESS_KEY, "1");
    else localStorage.removeItem(SURFACE_AWARENESS_KEY);
  } catch {
    // 私隐/受限环境静默降级（读面恒 off）
  }
}
