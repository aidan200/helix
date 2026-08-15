/**
 * Composer 输入区（F(7).1 发送 / F(7).3 steer：生成中输入不锁死）：
 * - 仅 connected 可发送（disabled，草稿保留，SM 规则 5/6）；
 * - streaming 时显示 violet steer 提示行，发送自动走 chat.steer；
 * - Enter 发送；脚注 kbd 键帽提示（[[x]] 标记渲染）。
 */
import { useCallback, type KeyboardEvent } from "react";
import { useI18n } from "@/shared/i18n";
import { selectCanSend, selectIsGenerating, useSession } from "@/entities/session/SessionContext";
import { cn } from "@/shared/lib/cn";

/** enterHint 词条的 [[x]] 标记 → kbd 键帽渲染。 */
function EnterHint({ text }: { text: string }) {
  const parts = text.split(/(\[\[[^\]]+\]\])/g).filter(Boolean);
  return (
    <span>
      {parts.map((p, i) =>
        p.startsWith("[[") && p.endsWith("]]") ? (
          <span key={i} className="kbd">
            {p.slice(2, -2)}
          </span>
        ) : (
          <span key={i}>{p}</span>
        ),
      )}
    </span>
  );
}

const Composer = function Composer() {
  const { t } = useI18n();
  const { state, setDraft, submit } = useSession();
  const canSend = selectCanSend(state);
  const generating = selectIsGenerating(state);

  const placeholder = canSend
    ? t("chat.composer.placeholder")
    : state.conn === "connecting"
      ? t("chat.composer.placeholderConnecting")
      : t("chat.composer.placeholderWaiting");

  const onSend = useCallback(() => {
    if (!canSend) return;
    submit(state.draft);
  }, [canSend, submit, state.draft]);

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      onSend();
    }
  };

  return (
    <footer className="composer-wrap">
      <div className={cn("composer", generating && "streaming")}>
        <div className="steer-hint">
          <span className="q-dot" />
          {t("chat.steer.hint")}
        </div>
        <div className="chat-inputbar">
          <span className="prompt">&gt;</span>
          <input
            id="msg-input"
            type="text"
            autoComplete="off"
            value={state.draft}
            placeholder={placeholder}
            disabled={!canSend}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={onKeyDown}
          />
          <button
            className="hud-btn hud-btn-cyan"
            id="btn-send"
            type="button"
            disabled={!canSend}
            onClick={onSend}
          >
            {t("chat.composer.send")}
          </button>
        </div>
        <div className="composer-foot">
          <span>{t("chat.composer.projectionNote")}</span>
          <EnterHint text={t("chat.composer.enterHint")} />
        </div>
      </div>
    </footer>
  );
};

export default Composer;
