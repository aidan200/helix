/**
 * 生成中占位卡（切回/刷新仍在生成回复的会话的尾部呼吸占位）。
 *
 * 背景：shell 是纯投影（快照+增量），流式中间态（state.streaming）不落盘、
 * 切走即弃；切回经快照重建 streaming=null，进行中的回复完全消失直到
 * message.completed 全量出现——「凭空消失→全量突现」体验断裂。本组件在
 * 快照 agentState 活跃（running/steering/aborting）且无任何流式槽位时，
 * 于时间轴尾部渲染呼吸占位，message.completed 到达后条件派生自然让位
 * 真实气泡（零新 SessionState 字段，显示条件全部派生自现有 state）。
 *
 * 让位关系（MessageFlow 侧条件互斥派生，本组件零权威状态）：
 * - streaming 气泡 / ThinkingLiveView（主线 thinking 槽）出现 → 占位消失；
 * - NetworkRetryCard / EngineErrorCard 独立共存不互斥。
 * 视觉语言复用「思考中」块（.think-live 呼吸点 + 微标签族，ThinkingBlock）。
 */
import { memo } from "react";
import { useI18n } from "@/shared/i18n";

export const GeneratingPlaceholder = memo(function GeneratingPlaceholder() {
  const { t } = useI18n();
  return (
    <div className="think-live gen-placeholder" data-kind="generating-placeholder">
      <span className="tl-label">
        <span className="hud-dot hud-dot-pulse" aria-hidden="true" />
        {t("chat.think.generating")}
      </span>
    </div>
  );
});

export default GeneratingPlaceholder;
