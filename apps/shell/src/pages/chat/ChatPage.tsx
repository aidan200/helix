/**
 * 聊天页（pages/chat 组装件）：产品氛围层 scanline-overlay（fixed 全屏，
 * 暗色常驻/亮色关闭见 tokens.css）+ 应用壳 100dvh = header → conn-banner →
 * 消息流（含连接覆盖层/失败卡）→ composer。data-conn / data-session 驱动
 * 全部状态表象（四态互斥 CSS 门控）；恢复 toast 由 restoreToast 投影触发。
 */
import { useEffect } from "react";
import { useI18n } from "@/shared/i18n";
import { useToast } from "@/shared/ui/Toast";
import { selectIsEmpty, useSession } from "@/entities/session/SessionContext";
import MessageFlow from "@/widgets/chat-stream/ui/MessageFlow";
import Composer from "@/features/send-message/ui/Composer";
import ErrorCard from "@/features/reconnect/ui/ErrorCard";
import AppHeader from "./ui/AppHeader";
import ConnBanner from "./ui/ConnBanner";
import ConnOverlay from "./ui/ConnOverlay";

/** 开实例抽屉（T4.3 接线占位：抽屉本体与 selectedAgentId 组件态归 pages 层）。 */
const noopOpenInstance = (_instanceId: string) => {};

const ChatPage = function ChatPage() {
  const { t } = useI18n();
  const toast = useToast();
  const { state, consumeRestoreToast, consumeSpawnToast } = useSession();

  // 恢复 toast：重连/手动重试成功后由快照条数填满（F(7).4，一次性消费）
  useEffect(() => {
    const r = state.restoreToast;
    if (!r) return;
    if (r.kind === "restore") {
      toast.push("ok", t("chat.restore.toast"), t("chat.restore.toastSub", { n: r.count }));
    } else {
      toast.push("ok", t("chat.error.retryOk"), t("chat.error.retryOkSub"));
    }
    consumeRestoreToast();
  }, [state.restoreToast, toast, t, consumeRestoreToast]);

  // spawn 秒回 toast（F1.5）：agent.spawned 事件即出卡即提示，不等 closure
  useEffect(() => {
    const s = state.spawnToast;
    if (!s) return;
    toast.push(
      "violet",
      t("chat.sa.spawn.toast"),
      t("chat.sa.spawn.toastSub", { id: s.instanceId, profile: s.profileKind }),
    );
    consumeSpawnToast();
  }, [state.spawnToast, toast, t, consumeSpawnToast]);

  const empty = selectIsEmpty(state);

  return (
    <>
      {/* 产品氛围层（原型 P-1 L545：body 首子元素、.app 之前；元素本身
          fixed + pointer-events:none，DOM 序序对齐原型便于对照） */}
      <div className="scanline-overlay" aria-hidden="true" />
      <div className="app" data-conn={state.conn} data-session={empty ? "empty" : "active"}>
        <AppHeader />
        <ConnBanner />
        <MessageFlow onOpenInstance={noopOpenInstance}>
          <ConnOverlay />
          <ErrorCard />
        </MessageFlow>
        <Composer />
      </div>
    </>
  );
};

export default ChatPage;
