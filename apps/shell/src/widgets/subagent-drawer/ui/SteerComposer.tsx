/**
 * 抽屉底部 steer 输入栏（CL-3 F(3.3).3，Q-3b；P-3 原型还原 R-P3-2）。
 *
 * 渲染门控归调用方（SubagentDrawer：rendered iff 实例 state==="running"，
 * 其余态静默不渲染——DOM 不存在、无禁用态无解释文案）。
 * 目标绑定当前展开实例（chip 明示，无下拉选择器——交互链 = 展开 → 阅读 →
 * 干预）。Enter 非空 → chatSteerCommand(text, sessionId, instanceId)（经
 * SessionContext.steerInstance）+ 本地 echo 进共享 store（双处立即可见）
 * + 输入即清空；空输入 Enter 零动作；无阻塞发送态（不设 isSending、不
 * await 回执——非运行中目标的 connection.error 回执走既有错误提示通道，
 * 不阻塞输入栏复用，契约 §3.2 错误模型）。
 * violet 变体（SubAgent 域副强调槽位，--violet-rgb 既有通道，无新 token）。
 */
import { memo, useState, type KeyboardEvent } from "react";
import { useI18n } from "@/shared/i18n";
import { useSession } from "@/entities/session/SessionContext";

interface SteerComposerProps {
  /** 目标实例（= 当前展开实例；chip 明示绑定） */
  instanceId: string;
}

const SteerComposer = memo(function SteerComposer({ instanceId }: SteerComposerProps) {
  const { t } = useI18n();
  const { steerInstance } = useSession();
  const [value, setValue] = useState("");

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== "Enter") return;
    const text = value.trim();
    if (text === "") return; // 空输入零动作（Q-3b：不触发任何转换）
    steerInstance(text, instanceId);
    setValue(""); // 发送即清空，无阻塞发送态
  };

  return (
    <div className="steer-composer" data-kind="steer-composer">
      <div className="sc-target">
        <span className="lab">{t("chat.drawer.steerTarget")}</span>
        <span className="tgt">→ {instanceId}</span>
      </div>
      <div className="sc-bar">
        <input
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder={t("chat.drawer.steerPlaceholder", { id: instanceId })}
          aria-label={t("chat.drawer.steerInputLabel")}
          autoComplete="off"
        />
        <span className="kbd">Enter</span>
      </div>
    </div>
  );
});

export default SteerComposer;
