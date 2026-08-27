/**
 * 门禁 connecting 占位（W3；brief 任务 2；W6b 终端化改版）。
 *
 * phase=connecting（workspace.get 门禁判定前）的全屏占位，与静态 index.html
 * 启动屏同一视觉语言：直接复用 index.html head <style> 持久存在的
 * .app-boot-loader/.boot-term/.bl/.boot-cursor 类名渲染（零重复 CSS 定义），
 * 内容换真实连接态——conn=connecting → "> 正在连接 daemon…" + 方块光标；
 * conn=disconnected（自动重连中）追加状态行；conn=error（gave-up）→
 * 连接失败占位（err-icon + hud-btn——ErrorCard 视觉语言）+ 重试钮
 * （useSession().retry，SM-2 手动重试路径）。连接层零改动（重连状态机照常）。
 */
import type { CSSProperties } from "react";
import { useI18n } from "@/shared/i18n";
import { useSession } from "@/entities/session/SessionContext";

const WorkspaceBootScreen = function WorkspaceBootScreen() {
  const { t } = useI18n();
  const { state, retry } = useSession();

  if (state.conn === "error") {
    return (
      <div className="wsgate" data-wsgate-boot="error">
        <div className="wsgate-panel">
          <div className="err-icon">!</div>
          <div className="wsgate-title">{t("workspace.boot.errorTitle")}</div>
          <div className="wsgate-sub">{t("workspace.boot.errorSub")}</div>
          <button className="hud-btn hud-btn-cyan" type="button" onClick={retry}>
            {t("workspace.boot.retry")}
          </button>
        </div>
      </div>
    );
  }

  // 真实连接态日志行：connecting 恒在；disconnected（自动重连中）追加状态行。
  // 光标随末行（.bl 擦除入场延迟 --d 逐行递增，同静态屏节奏）。
  const lines = [t("workspace.boot.connecting")];
  if (state.conn === "disconnected") lines.push(t("workspace.boot.reconnecting"));

  return (
    <div className="app-boot-loader" data-wsgate-boot="connecting">
      <div className="boot-term">
        {lines.map((line, i) => (
          <span className="bl" key={line} style={{ "--d": `${0.05 + i * 0.08}s` } as CSSProperties}>
            &gt; {line}
            {i === lines.length - 1 && (
              // 静态屏光标 1.5s 入场延迟按 16 行节奏调的；此处 1-2 行，内联提前
              <span className="boot-cursor" style={{ animationDelay: "0.5s" }} />
            )}
          </span>
        ))}
      </div>
    </div>
  );
};

export default WorkspaceBootScreen;
