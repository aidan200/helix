/**
 * useStewardNavigate —— steward.navigate 页面切换指令消费（管家驾驶舱批）。
 *
 * daemon 在 deliver_to_session 确认投递成功 / create_session 建成后广播
 * steward.navigate { sessionId }（仅已订阅 steward 的连接收）；本 hook 过滤
 * 该帧并上调 onNavigate(sessionId)——切页动作（与侧栏点击同一路径）由
 * App 装配层接线（navigate(ROUTE_WORKBENCH) + switchSession）。
 *
 * 回调经 ref 定格（onClose ref 先例）：订阅面不随调用方重渲染反复解绑/
 * 重挂；载荷防御——sessionId 非非空 string 零回调。
 */
import { useEffect, useRef } from "react";
import { useSession } from "@/entities/session/SessionContext";
import type { EventEnvelope } from "@helix/protocol";

export function useStewardNavigate(onNavigate: (sessionId: string) => void): void {
  const { subscribeStewardFrames } = useSession() as {
    subscribeStewardFrames?: (listener: (e: EventEnvelope) => void) => () => void;
  };
  const onNavigateRef = useRef(onNavigate);
  useEffect(() => {
    onNavigateRef.current = onNavigate;
  }, [onNavigate]);

  useEffect(() => {
    if (subscribeStewardFrames === undefined) return;
    return subscribeStewardFrames((event: EventEnvelope) => {
      if (event.type !== "steward.navigate") return;
      const payload = event.payload as { sessionId?: unknown };
      if (typeof payload.sessionId !== "string" || payload.sessionId === "") return;
      onNavigateRef.current(payload.sessionId);
    });
  }, [subscribeStewardFrames]);
}
