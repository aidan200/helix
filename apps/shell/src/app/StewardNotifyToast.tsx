/**
 * 管家感知批（M0.5）StewardNotifyToast —— steward.notify 主动通知帧 →
 * 全局 toast（页面无关常驻；CoordNoticeToast/useStewardNavigate 同构）。
 *
 * daemon 侧分诊器（激活态一次 LLM 双轨产物）的呈现轨载体：通知预算限流
 * 后经 steward 订阅闸广播（与 feed 同闸）；本组件只呈现不叙述（title/
 * body/建议文案 daemon 单源，前端零二次翻译）。
 *
 * D12-⑤ 播报不附带执行：suggestions 是接续提案（点按才动）——v1 动作词表
 * open_tasks（任务锚固定建议，onOpenTasks 经 App 装配注入 navigate）；
 * 无动词建议（LLM 产物）纯文本呈现，写类动作落地走确认闸（M2 surface
 * 协议后接）。urgency 分档：normal = violet 轻通知、high = warn 提级。
 */
import { useEffect } from "react";
import type { EventEnvelope, StewardNotifyPayload, StewardNotifySuggestion } from "@helix/protocol";
import { useSession } from "@/entities/session/SessionContext";
import { useToast } from "@/shared/ui/Toast";

/** v1 动作词表（notify 建议按钮的动作面——M2 surface.action 后扩全动词）。 */
const SUGGESTION_ACTIONS: Partial<Record<string, (ctx: { onOpenTasks: () => void }) => void>> = {
  open_tasks: ({ onOpenTasks }) => onOpenTasks(),
};

export default function StewardNotifyToast({ onOpenTasks }: { onOpenTasks: () => void }) {
  const { subscribeStewardFrames } = useSession() as {
    subscribeStewardFrames?: (listener: (e: EventEnvelope) => void) => () => void;
  };
  const toast = useToast();

  useEffect(() => {
    if (subscribeStewardFrames === undefined) return; // 防御：部分测试 mock 的 session 面不含 steward 族
    return subscribeStewardFrames((event: EventEnvelope) => {
      if (event.type !== "steward.notify") return;
      const p = event.payload as StewardNotifyPayload;
      // text/sub 守卫（CoordNoticeToast 先例）：非 string/空串不入 toast
      if (typeof p.title !== "string" || p.title === "") return;
      if (typeof p.body !== "string" || p.body === "") return;
      // 建议副行：全部建议 label 拼接（含无动作项——纯建议也是信息）
      const labels = (Array.isArray(p.suggestions) ? p.suggestions : [])
        .map((s) => (typeof s?.label === "string" ? s.label : ""))
        .filter((l) => l !== "");
      const sub = [p.body, ...labels].join(" · ");
      // 动作按钮：首个有动作动词的建议（点按才动——D12-⑤ 通知与动作恒分离）
      const actionSuggestion: StewardNotifySuggestion | undefined = (Array.isArray(p.suggestions) ? p.suggestions : []).find(
        (s) => typeof s?.verb === "string" && SUGGESTION_ACTIONS[s.verb as string] !== undefined,
      );
      const action =
        actionSuggestion !== undefined
          ? {
              label: actionSuggestion.label,
              onClick: () => {
                SUGGESTION_ACTIONS[actionSuggestion.verb as string]!({ onOpenTasks });
              },
            }
          : undefined;
      toast.push(p.urgency === "high" ? "warn" : "violet", p.title, sub, action);
    });
  }, [subscribeStewardFrames, toast, onOpenTasks]);

  return null;
}
