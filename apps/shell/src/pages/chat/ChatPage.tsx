/**
 * 聊天页（pages/chat 组装件）：P-1 工作台骨架（S1 迁移 AppLayout 统一
 * 壳：header 全宽置顶 + 侧栏/主区/抽屉竖条同处 header 之下）内无损迁入
 * 既有聊天/抽屉装配。主区 .app = conn-banner → 消息流（含连接覆盖层/
 * 失败卡/恢复骨架）→ composer；data-conn / data-session / data-view /
 * data-drawer 驱动全部状态表象（四态互斥 CSS 门控）；恢复 toast 由
 * restoreToast 投影触发。scanline 氛围层上提 App.tsx 全局单份（S1）。
 */
import { useCallback, useEffect, useState } from "react";
import { useI18n } from "@/shared/i18n";
import { useToast } from "@/shared/ui/Toast";
import { selectIsEmpty, useSession } from "@/entities/session/SessionContext";
import MessageFlow from "@/widgets/chat-stream/ui/MessageFlow";
import RestoreSkeleton from "@/widgets/chat-stream/ui/P-1s-restore-skeleton";
import SubagentDrawer from "@/widgets/subagent-drawer/ui/SubagentDrawer";
import Composer from "@/features/send-message/ui/Composer";
import ErrorCard from "@/features/reconnect/ui/ErrorCard";
import ConnBanner from "./ui/ConnBanner";
import ConnOverlay from "./ui/ConnOverlay";
import Workbench from "./ui/P-1-workbench";

const ChatPage = function ChatPage() {
  const { t } = useI18n();
  const toast = useToast();
  const { state, consumeRestoreToast, consumeSpawnToast, consumeKillToast } = useSession();
  // 抽屉寻址：组件状态 selectedAgentId（非 URL；review.md Mock 载体口径）。
  // 入口：P-1 卡片 onOpenDrawer 与 header popover 行尾 onOpenInstance（T4.2 占位接管）。
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);
  const openInstance = useCallback((instanceId: string) => setSelectedAgentId(instanceId), []);
  const closeDrawer = useCallback(() => setSelectedAgentId(null), []);

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

  // kill 终止链末端 toast（F1.2）：agent.killed 到达即交代（卡片/抽屉双视图同帧翻 failed）
  useEffect(() => {
    const k = state.killToast;
    if (!k) return;
    toast.push("err", t("chat.drawer.killedToast"), t("chat.drawer.killedToastSub", { id: k.instanceId }));
    consumeKillToast();
  }, [state.killToast, toast, t, consumeKillToast]);

  const empty = selectIsEmpty(state);

  return (
    <>
      <Workbench onOpenInstance={openInstance}>
        <div
          className="app"
          data-conn={state.conn}
          data-session={empty ? "empty" : "active"}
          data-view={state.view}
          data-drawer={selectedAgentId ? "1" : undefined}
        >
          <ConnBanner />
          <MessageFlow onOpenInstance={openInstance}>
            <ConnOverlay />
            <ErrorCard />
            {/* P-1s 切换两阶段：loading 骨架（CSS 门控 data-view，与
                success 内容互斥） */}
            <RestoreSkeleton />
          </MessageFlow>
          <Composer />
        </div>
      </Workbench>
      {/* P-2 抽屉：页内 overlay（非路由）；衬底 = 真实 P-1 弱化（data-drawer 门控） */}
      {selectedAgentId && (
        <SubagentDrawer agentId={selectedAgentId} onClose={closeDrawer} />
      )}
    </>
  );
};

export default ChatPage;
