/**
 * useStewardNavigate —— surface.action {verb:"navigate"} 动作消费面
 * （navigate 动作语义修正批：授权即执行）。daemon 在 deliver_to_session
 * 受理 / start_session（createSession 执行体）建成后 / 管家 act 工具
 * （经确认闸）三线经 SurfaceRegistry 路由 surface.action 帧；本 hook 过滤
 * verb=navigate 帧 → **直接 onNavigate 切页**（navigate + switchSession，
 * 与侧栏点击同一路径，由 App 装配层注入）→ 真执行后回执行回执
 * ok:true("navigated")。
 *
 * 语义分界（2026-10-07 用户实测事故落账）：动作通道（surface.action）=
 * 已过确认闸的授权动作，帧到达即执行——「确认卡 + toast 按钮点按才切」
 * 的二次授权形态退役（用户点完确认卡页面纹丝不动、管家却回执成功——
 * 「呈现即回执 presented」在 M2 语义下是谎报）；播报通道（feed/notify/
 * toast）= 永不附带执行（D12-⑤ 不变——播报类建议按钮归播报族）。
 *
 * 载荷防御：verb/args.sessionId 形状非法零动作，但**拒签必回执**（事故
 * 热修批②——invalid-args/unsupported-verb 失败回执，daemon 侧不再 60s
 * 挂死）；seq 非法帧仍执行导航（用户价值面）零回执（无对账锚）。
 */
import { useEffect, useRef } from "react";
import { useSession } from "@/entities/session/SessionContext";
import type { EventEnvelope } from "@helix/protocol";

export function useStewardNavigate(onNavigate: (sessionId: string) => void): void {
  const { subscribeSurfaceFrames, sendSurfaceActionResult } = useSession() as {
    subscribeSurfaceFrames?: (listener: (e: EventEnvelope) => void) => () => void;
    sendSurfaceActionResult?: (seq: number, ok: boolean, detail?: string) => boolean;
  };
  const onNavigateRef = useRef(onNavigate);
  useEffect(() => {
    onNavigateRef.current = onNavigate;
  }, [onNavigate]);

  useEffect(() => {
    if (subscribeSurfaceFrames === undefined) return;
    return subscribeSurfaceFrames((event: EventEnvelope) => {
      if (event.type !== "surface.action") return; // 兼容期旧帧零消费（D8 收编）
      const payload = event.payload as { verb?: unknown; args?: unknown; seq?: unknown };
      // 拒签也回执（事故热修批②）：daemon 侧 surface.action 带回执超时等待面
      // ——零回执 = 60s 挂死（2026-10-07 事故实录：模型发明 url 参数 → 本面静
      // 默弃帧 → daemon 挂闸 60s 后 run error）。「不猜义」不等于「不应答」：
      // 形状非法时回失败回执（invalid-args / unsupported-verb），零动作。
      // seq 非法帧仍零回执（无对账锚）。
      const seq = typeof payload.seq === "number" && Number.isFinite(payload.seq) ? payload.seq : undefined;
      if (payload.verb !== "navigate") {
        if (seq !== undefined) sendSurfaceActionResult?.(seq, false, `unsupported-verb:${String(payload.verb)}`);
        return; // shell 表面唯一动词；其他动词如实回执（本面不支持）
      }
      const args = payload.args as { sessionId?: unknown } | null | undefined;
      const sessionId = typeof args === "object" && args !== null ? args.sessionId : undefined;
      if (typeof sessionId !== "string" || sessionId === "") {
        if (seq !== undefined) sendSurfaceActionResult?.(seq, false, "invalid-args");
        return; // 载荷防御（不猜义——但拒签必应答）
      }
      // 授权即执行：帧到达 = 确认闸已过（write 档），直接切页（与侧栏点击
      // 同一路径）；回执在真执行后发——detail 如实记 navigated。
      onNavigateRef.current(sessionId);
      if (seq !== undefined) {
        sendSurfaceActionResult?.(seq, true, "navigated");
      }
    });
  }, [subscribeSurfaceFrames, sendSurfaceActionResult]);
}
