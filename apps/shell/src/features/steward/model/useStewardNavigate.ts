/**
 * useStewardNavigate —— surface.action {verb:"navigate"} 建议导航消费
 * （M0 表面协议地基批翻新；设计稿 D8/D12-⑤——B1 版 steward.navigate 帧
 * 已退役 deprecated，兼容期 daemon 双发、本消费面只认新帧）。
 *
 * daemon 在 deliver_to_session 受理 / start_session（createSession 执行体）
 * 建成后经 SurfaceRegistry 路由 surface.action（定向到已注册 shell 表面
 * 连接）；本 hook 过滤 verb=navigate 帧并经**既有 toast 通道**（useToast，
 * 零新浮层位）发「已投递到会话 X · [去看看]」——**点按钮才切页**（不强切，
 * 不打断当前操作——D12-⑤ 播报不附带执行）；切页动作（navigate +
 * switchSession，与侧栏点击同一路径）由 App 装配层经 onNavigate 注入。
 *
 * D7-1 执行回执：toast 呈现即回 surface.action.result {seq, ok:true}
 * （呈现 = 动作送达面；点按是用户后续决策，不在回执内）。载荷防御：
 * verb/args.sessionId/seq 形状非法零动作零回执。
 */
import { useEffect, useRef } from "react";
import { useSession } from "@/entities/session/SessionContext";
import { useToast } from "@/shared/ui/Toast";
import { useI18n } from "@/shared/i18n";
import type { EventEnvelope } from "@helix/protocol";

export function useStewardNavigate(onNavigate: (sessionId: string) => void): void {
  const {
    topology,
    subscribeSurfaceFrames,
    sendSurfaceActionResult,
  } = useSession() as {
    topology?: { list?: readonly { sessionId: string; title: string }[] };
    subscribeSurfaceFrames?: (listener: (e: EventEnvelope) => void) => () => void;
    sendSurfaceActionResult?: (seq: number, ok: boolean, detail?: string) => boolean;
  };
  const toast = useToast();
  const { t } = useI18n();
  const onNavigateRef = useRef(onNavigate);
  useEffect(() => {
    onNavigateRef.current = onNavigate;
  }, [onNavigate]);

  useEffect(() => {
    if (subscribeSurfaceFrames === undefined) return;
    return subscribeSurfaceFrames((event: EventEnvelope) => {
      if (event.type !== "surface.action") return; // 兼容期旧帧零消费（D8 收编）
      const payload = event.payload as { verb?: unknown; args?: unknown; seq?: unknown };
      if (payload.verb !== "navigate") return; // M0 唯一动词；其他动词 M2 注册面
      const args = payload.args as { sessionId?: unknown } | null | undefined;
      const sessionId = typeof args === "object" && args !== null ? args.sessionId : undefined;
      if (typeof sessionId !== "string" || sessionId === "") return; // 载荷防御（不猜义）
      // D7-1：呈现即回执（seq 对账锚——非法 seq 不回执）
      if (typeof payload.seq === "number" && Number.isFinite(payload.seq)) {
        sendSurfaceActionResult?.(payload.seq, true, "presented");
      }
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
  }, [subscribeSurfaceFrames, sendSurfaceActionResult, toast, t]);
}
