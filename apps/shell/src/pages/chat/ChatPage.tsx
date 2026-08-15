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

const ChatPage = function ChatPage() {
  const { t } = useI18n();
  const toast = useToast();
  const { state, consumeRestoreToast } = useSession();

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

  const empty = selectIsEmpty(state);

  return (
    <>
      {/* 产品氛围层（原型 P-1 L545：body 首子元素、.app 之前；元素本身
          fixed + pointer-events:none，DOM 序序对齐原型便于对照） */}
      <div className="scanline-overlay" aria-hidden="true" />
      <div className="app" data-conn={state.conn} data-session={empty ? "empty" : "active"}>
        <AppHeader />
        <ConnBanner />
        <MessageFlow>
          <ConnOverlay />
          <ErrorCard />
        </MessageFlow>
        <Composer />
      </div>
    </>
  );
};

export default ChatPage;
