/**
 * STT provider 偏好存取（语音输入批 V1）：localStorage 持久化（跨会话），
 * 设置页写入 / Composer 转写命令读取（auto = 不携带，daemon 自动选择）。
 * localStorage 不可用（隐私模式等）→ undefined 兑底（等价 auto）。
 */

/** 存储键。 */
export const STT_PROVIDER_PREF_KEY = "helix.stt.provider";

/** 读取偏好（"dashscope" | "siliconflow" | undefined=auto）。 */
export function readSttProviderPref(): string | undefined {
  try {
    const v = localStorage.getItem(STT_PROVIDER_PREF_KEY);
    return v === "dashscope" || v === "siliconflow" ? v : undefined;
  } catch {
    return undefined;
  }
}

/** 写入偏好（"auto" = 移除）。 */
export function writeSttProviderPref(id: string): void {
  try {
    if (id === "auto") localStorage.removeItem(STT_PROVIDER_PREF_KEY);
    else localStorage.setItem(STT_PROVIDER_PREF_KEY, id);
  } catch {
    // 隐私模式等存储不可用：静默兑底（等价 auto，不阻塞 UI）
  }
}
