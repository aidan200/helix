/**
 * 两段式 armed 确认 hook（M10 批⑤ 单点承载；B2 自 pages/settings/ui 提升
 * shared——记忆页跨 slice 复用（AG-15 同层互引防线））。
 *
 * 首击 armed（id 标记 + 超时复原）→ 同 id 二击执行 action；异 id 首击
 * 视为重定向（换 armed 目标复原计时）。Models/Mcp/向量端点/记忆条目删除
 * 行为同构消费。
 */
import { useCallback, useEffect, useRef, useState } from "react";

export function useArmedConfirm(timeoutMs = 2_500): {
  readonly armed: string | null;
  readonly confirm: (id: string, action: () => void) => void;
} {
  const [armed, setArmed] = useState<string | null>(null);
  const armedRef = useRef<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  // unmount 清理复原定时器
  useEffect(() => () => clearTimeout(timer.current), []);

  const confirm = useCallback(
    (id: string, action: () => void): void => {
      if (armedRef.current !== id) {
        armedRef.current = id;
        setArmed(id);
        clearTimeout(timer.current);
        timer.current = setTimeout(() => {
          armedRef.current = null;
          setArmed(null);
        }, timeoutMs);
        return;
      }
      clearTimeout(timer.current);
      armedRef.current = null;
      setArmed(null);
      action();
    },
    [timeoutMs],
  );

  return { armed, confirm };
}
