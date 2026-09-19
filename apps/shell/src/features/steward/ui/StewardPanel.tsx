/**
 * StewardPanel —— V2.5 文本管家侧栏面板（features/steward 消费端 UI；设计
 * docs/temp/helix-voice-agent-design.md §2/§5.2「侧栏/面板形态」）。
 *
 * 形态：右缘常驻侧栏（aside）——头部标题 + 关闭钮，主体三段：
 * 事件流区（steward.feed 文本行滚动窗，面板轻量态）/ 对话区（user/steward
 * 两方气泡 + ask 在途态）/ 确认卡（confirm_required 全文过目——agentId +
 * 递话全文，确认/放弃两键；§5.2 防火墙客户端面：未点确认零发送）。
 *
 * 状态面（useSteward 单点）：config null 或 enabled=false → 关闭引导占位
 * （不渲染输入面——daemon money gate 客户端同构）；enabled → 输入框 +
 * 发送钮（Enter 同义），ask 在途禁用输入面防双发。
 *
 * 关闭路径：Esc / 头部 ×（DiffOverlay 先例；onClose ref 定格防重绑）。
 * 未挂载说明：V2.5 收尾批仅交付组件本体 + 测试（挂载位/设置面接线归
 * 后续批——dispatcher 注册注释「真消费归 StewardPanel 与设置页」同口径）。
 */
import { useEffect, useRef, useState } from "react";
import { useSteward } from "../model/useSteward";
import { useI18n } from "@/shared/i18n";

interface StewardPanelProps {
  onClose: () => void;
}

const StewardPanel = function StewardPanel({ onClose }: StewardPanelProps) {
  const { t } = useI18n();
  const { messages, pending, feed, askInFlight, config, ask, confirmPending, dismissPending } = useSteward(true);
  const [draft, setDraft] = useState("");

  // onClose ref 定格（DiffOverlay 先例）：调用方内联箭头每渲染新引用，
  // Esc 监听不随调用方重渲染反复解绑/重挂
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCloseRef.current();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const enabled = config?.enabled === true;

  const submit = () => {
    if (draft.trim() === "" || askInFlight) return;
    const ok = ask(draft); // false = 未连接：零静默丢消息（hook 不推气泡，草稿保留）
    if (ok === false) return;
    setDraft("");
  };

  return (
    <aside className="stp" data-testid="steward-panel" role="complementary" aria-label={t("steward.title")}>
      <header className="stp-head">
        <span className="stp-title">{t("steward.title")}</span>
        <button type="button" className="stp-close" aria-label={t("steward.close")} onClick={onClose}>
          ×
        </button>
      </header>
      {!enabled ? (
        <div className="stp-disabled" data-testid="steward-disabled">
          <span className="stp-disabled-title">{t("steward.disabledTitle")}</span>
          <span className="stp-disabled-hint">{t("steward.disabledHint")}</span>
        </div>
      ) : (
        <>
          <div className="stp-feed" data-testid="steward-feed" aria-label={t("steward.feedTitle")}>
            {feed.length === 0 ? (
              <span className="stp-feed-empty">{t("steward.feedEmpty")}</span>
            ) : (
              feed.map((line) => (
                <div className="stp-feed-line" key={`${line.seq}-${line.agentId}`}>
                  {line.text}
                </div>
              ))
            )}
          </div>
          <div className="stp-msgs">
            {messages.map((m, i) => (
              <div
                key={i}
                className={`stp-msg ${m.role === "user" ? "stp-msg-user" : "stp-msg-steward"}`}
                data-testid={m.role === "user" ? "steward-msg-user" : "steward-msg-steward"}
              >
                {m.text}
              </div>
            ))}
            {askInFlight && <div className="stp-inflight">{t("steward.thinking")}</div>}
          </div>
          {pending !== null && (
            <div className="stp-confirm" data-testid="steward-confirm-card">
              <span className="stp-confirm-title">{t("steward.confirmTitle")}</span>
              <span className="stp-confirm-row">
                <span className="stp-confirm-k">{t("steward.confirmTarget")}</span>
                <span className="stp-confirm-v">{pending.agentId}</span>
              </span>
              <span className="stp-confirm-row">
                <span className="stp-confirm-k">{t("steward.confirmBody")}</span>
                <span className="stp-confirm-v">{pending.message}</span>
              </span>
              <div className="stp-confirm-actions">
                <button type="button" className="stp-confirm-yes" data-testid="steward-confirm-yes" onClick={() => confirmPending()}>
                  {t("steward.confirmYes")}
                </button>
                <button type="button" className="stp-confirm-no" data-testid="steward-confirm-no" onClick={dismissPending}>
                  {t("steward.confirmNo")}
                </button>
              </div>
            </div>
          )}
          <div className="stp-composer">
            <input
              className="stp-input"
              data-testid="steward-input"
              value={draft}
              placeholder={t("steward.inputPlaceholder")}
              disabled={askInFlight}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") submit();
              }}
            />
            <button type="button" className="stp-send" data-testid="steward-send" disabled={askInFlight} onClick={submit}>
              {t("steward.send")}
            </button>
          </div>
        </>
      )}
    </aside>
  );
};

export default StewardPanel;
