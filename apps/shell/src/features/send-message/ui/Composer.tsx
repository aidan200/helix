/**
 * Composer 输入区（F(7).1 发送 / F(7).3 steer：生成中输入不锁死；T8 输入区改造）：
 * - 仅 connected 可发送（disabled，草稿保留，SM 规则 5/6）；
 * - streaming 时显示 violet steer 提示行，发送自动走 chat.steer；
 * - 多行 textarea（rows=1，内容高度自动增长至上限后内滚）：Alt+Enter（mac
 *   Option 同位）发送；Enter / Shift+Enter / Cmd+Enter 原生换行（不拦截）；
 *   纯空白草稿（含换行）不发送；
 * - 停止钮 #btn-abort（T8）：中断 main 生成（chat.abort）；恒渲染不按态卸载
 *   （焦点守恒，沿 T7 web 双钮先例），仅 runState === "streaming" 可用——
 *   subagent_running（main 空闲）/ idle 禁用（abort 只中断 main 生成）；
 * - 脚注 kbd 键帽提示（[[x]] 标记渲染）。
 */
import { useCallback, useEffect, useRef, type KeyboardEvent } from "react";
import { Square } from "lucide-react";
import { useI18n } from "@/shared/i18n";
import { selectCanSend, selectIsGenerating, useSession } from "@/entities/session/SessionContext";
import { selectActiveRunState } from "@/entities/session/model/topology";
import { cn } from "@/shared/lib/cn";

/** textarea 自动增高上限（px；≈7 行），超出后 overflow-y 内滚。 */
const TA_MAX_HEIGHT = 160;

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
  const { state, setDraft, submit, abort } = useSession();
  const canSend = selectCanSend(state);
  const generating = selectIsGenerating(state);
  // 停止钮可用判据：main session 正在生成（subagent_running = main 空闲，
  // chat.abort 只中断 main 生成，不作用于 SubAgent）
  const abortable = selectActiveRunState(state) === "streaming";
  const taRef = useRef<HTMLTextAreaElement>(null);

  // 自动增高：内容高度增长至上限后内滚。jsdom 无布局（scrollHeight=0）时
  // 不落内联高度，交还 CSS 默认单行。
  useEffect(() => {
    const el = taRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = el.scrollHeight > 0 ? `${Math.min(el.scrollHeight, TA_MAX_HEIGHT)}px` : "";
  }, [state.draft]);

  const placeholder = canSend
    ? t("chat.composer.placeholder")
    : state.conn === "connected" && state.view === "loading"
      ? t("chat.paging.placeholder") // P-1s 切换恢复：输入禁用占位（快照到达恢复）
      : state.conn === "connecting"
        ? t("chat.composer.placeholderConnecting")
        : t("chat.composer.placeholderWaiting");

  const onSend = useCallback(() => {
    // 纯空白草稿（含换行/空格）不发送（canSend 语义之外的前置 trim 门控）
    if (!canSend || state.draft.trim() === "") return;
    submit(state.draft);
  }, [canSend, submit, state.draft]);

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    // Alt+Enter（mac Option）发送；Enter / Shift+Enter / Cmd+Enter 不拦截（原生换行）
    if (e.key === "Enter" && e.altKey) {
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
          <textarea
            id="msg-input"
            ref={taRef}
            rows={1}
            autoComplete="off"
            value={state.draft}
            placeholder={placeholder}
            disabled={!canSend}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={onKeyDown}
          />
          {/* 停止钮（T8）：中断 main 生成；恒渲染不按态卸载（焦点守恒） */}
          <button
            className="hud-btn hud-btn-danger"
            id="btn-abort"
            type="button"
            disabled={!abortable}
            onClick={abort}
          >
            <Square size={12} aria-hidden />
            {t("chat.composer.stop")}
          </button>
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
          <EnterHint text={t("chat.composer.enterHint")} />
        </div>
      </div>
    </footer>
  );
};

export default Composer;
