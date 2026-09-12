/**
 * 占用协调轻通知（U5，coord 批）——活动窗口轻条目：daemon 经
 * coord.changed 广播（notification 通道，daemon 级全局帧不按会话订阅
 * 路由——冲突双方用户都要知晓），本组件常驻 AppRoutes 订阅并直渲
 * toast（TaskSyncHintToast 先例；text 由 daemon 侧生成人读单源，前端
 * 零二次叙述）。
 *
 * 不进 entries 不进上下文：协调状态是 daemon 级事实，会话 store 零写入
 * （task.changed 同构口径）；escalated 冲突用 warn 级、其余 info 级。
 */
import { useEffect } from "react";
import type { EventEnvelope, CoordChangedPayload } from "@helix/protocol";
import { useSession } from "@/entities/session/SessionContext";
import { useToast } from "@/shared/ui/Toast";

export default function CoordNoticeToast() {
  const { subscribeCoordFrames } = useSession();
  const toast = useToast();

  useEffect(() => {
    if (typeof subscribeCoordFrames !== "function") return; // 防御：部分测试 mock 的 session 面不含 coord 族
    return subscribeCoordFrames((e: EventEnvelope) => {
      if (e.type !== "coord.changed") return;
      const p = e.payload as CoordChangedPayload;
      // escalated = 同对冲突反复无动作（留给人裁决的信号）→ warn 提级；其余 info 语义
      //（ToastKind 词表无 info——用 ok 档承载轻通知）
      toast.push(p.escalated === true ? "warn" : "ok", p.text);
    });
  }, [subscribeCoordFrames, toast]);

  return null;
}
