/**
 * localStorage 布尔偏好读写（code-review 低危组9 收拢：P-2 会话侧栏与
 * P-1 活跃事件条两处同构 readCollapsed/writeCollapsed 上提）。
 *
 * 编码约定："1"=true / "0"=false；缺键/值脏/存储不可用（无痕·受限环境）
 * → fallback（缺省值由调用方注入——侧栏缺省展开、事件条缺省折叠），
 * 记忆失效不阻断交互。键面归 AG-14 白名单（纯 UI 布局偏好，非业务状态）。
 */

/** 读布尔偏好：值脏/缺键/存储抛错 → fallback。 */
export function readPersistedFlag(key: string, fallback: boolean): boolean {
  try {
    const raw = window.localStorage.getItem(key);
    if (raw === "1") return true;
    if (raw === "0") return false;
    return fallback;
  } catch {
    return fallback;
  }
}

/** 写布尔偏好（"1"/"0"）；存储抛错静默（无痕/受限环境不阻断交互）。 */
export function writePersistedFlag(key: string, value: boolean): void {
  try {
    window.localStorage.setItem(key, value ? "1" : "0");
  } catch {
    /* 无痕/受限环境：记忆失效不阻断交互 */
  }
}
