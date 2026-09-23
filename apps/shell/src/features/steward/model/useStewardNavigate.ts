/**
 * useStewardNavigate —— steward.navigate 建议导航消费（B1 管家文本链路批；
 * 设计稿 §3.7）。
 *
 * daemon 在 deliver_to_session 受理时（B1 起不再等全轮）/ create_session
 * 建成后广播 steward.navigate { sessionId }（仅已订阅 steward 的连接收）；
 * 本 hook 过滤该帧并经**既有 toast 通道**（useToast，零新浮层位）发
 * 「已投递到会话 X · [去看看]」——**点按钮才切页**（不强切，不打断当前
 * 操作——G5 消除）；切页动作（navigate + switchSession，与侧栏点击同路
 * 径）由 App 装配层经 onNavigate 注入。
 *
 * B1 前形态（无条件 switchSession 强切页）退役。
 */
import { useEffect, useRef } from "react";
import { useSession } from "@/entities/session/SessionContext";
import { useToast } from "@/shared/ui/Toast";
import { useI18n } from "@/shared/i18n";
import type { EventEnvelope } from "@helix/protocol";

export function useStewardNavigate(onNavigate: (sessionId: string) => void): void {
  const {
    topology,
    subscribeStewardFrames,
  } = useSession() as {
    topology?: { list?: readonly { sessionId: string; title: string }[] };
    subscribeStewardFrames?: (listener: (e: EventEnvelope) => void) => () => void;
  };
  const toast = useToast();
  const { t } = useI18n();
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
      const sessionId = payload.sessionId;
      // 会话显示标题（session.list 元数据；未命中回退短 id——不猜义）
      const title =
        topology?.list?.find((m) => m.sessionId === sessionId)?.title ?? sessionId.slice(0, 12);
      toast.push("violet", t("steward.navigateToast", { title }), undefined, {
        label: t("steward.navigateGo"),
        onClick: () => onNavigateRef.current(sessionId),
      });
    });
    // topology.list 仅标题查表用（缺失回退 id）——不随清单变化重挂订阅
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [subscribeStewardFrames, toast, t]);
}
