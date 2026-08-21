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
import { useCallback, useEffect, useRef, useState, type ChangeEvent, type KeyboardEvent } from "react";
import { ImagePlus, Square, X } from "lucide-react";
import { useI18n } from "@/shared/i18n";
import { selectCanSend, selectIsGenerating, useSession } from "@/entities/session/SessionContext";
import { selectActiveRunState } from "@/entities/session/model/topology";
import { cn } from "@/shared/lib/cn";

/** textarea 自动增高上限（px；≈7 行），超出后 overflow-y 内滚。 */
const TA_MAX_HEIGHT = 160;

/** 图片附件上限（T9，契约 v0.10：chat.send images ≤4 张）。 */
const ATTACH_MAX = 4;

/** File → base64 data URL（FileReader.readAsDataURL；契约 v0.10 线格式）。 */
function readAsDataURL(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

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
  const { state, setDraft, submit, abort, attachImages, removeAttachment } = useSession();
  const canSend = selectCanSend(state);
  const generating = selectIsGenerating(state);
  // 停止钮可用判据：main session 正在生成（subagent_running = main 空闲，
  // chat.abort 只中断 main 生成，不作用于 SubAgent）
  const abortable = selectActiveRunState(state) === "streaming";
  const taRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  // 附件超限提示（T9：第 5 张选择预检拦截；移除/成功 attach 后消隐）
  const [limitTip, setLimitTip] = useState(false);

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

  // 发送提交（trim 门控共享）。T9 附件载荷契约（测试钉死两种调用形态）：
  // - 携带附件 → submit(text, images)；
  // - 无附件 → 点击钮路径 submit(text, undefined)（显式第二参）；
  //   Alt+Enter 路径 submit(text)（单参旧形态，T8 语义零变更）。
  const trySend = useCallback(
    (explicitImagesArg: boolean) => {
      // 纯空白草稿（含换行/空格）不发送（canSend 语义之外的前置 trim 门控）
      if (!canSend || state.draft.trim() === "") return;
      if (state.attachments.length > 0) submit(state.draft, state.attachments);
      else if (explicitImagesArg) submit(state.draft, undefined);
      else submit(state.draft);
    },
    [canSend, state.attachments, state.draft, submit],
  );

  const onSend = useCallback(() => trySend(true), [trySend]);

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    // Alt+Enter（mac Option）发送；Enter / Shift+Enter / Cmd+Enter 不拦截（原生换行）
    if (e.key === "Enter" && e.altKey) {
      e.preventDefault();
      trySend(false);
    }
  };

  // 文件选择（T9）：≤4 上限预检（超限提示且不 attach）；读 data URL 后入草稿
  const onPick = (e: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    e.target.value = ""; // 允许重选同一文件
    if (files.length === 0) return;
    if (state.attachments.length + files.length > ATTACH_MAX) {
      setLimitTip(true);
      return;
    }
    void Promise.all(files.map(readAsDataURL)).then((urls) => {
      setLimitTip(false);
      attachImages(urls);
    });
  };

  const onRemoveAttachment = (index: number) => {
    setLimitTip(false);
    removeAttachment(index);
  };

  return (
    <footer className="composer-wrap">
      <div className={cn("composer", generating && "streaming")}>
        <div className="steer-hint">
          <span className="q-dot" />
          {t("chat.steer.hint")}
        </div>
        {/* T9 附件 chips 预览（缩略图 + 移除钮）+ 超限提示 */}
        {state.attachments.length > 0 && (
          <div className="attach-chips">
            {state.attachments.map((src, i) => (
              <span className="attach-chip" key={i}>
                <img src={src} alt={t("chat.attach.imageAlt", { n: i + 1 })} />
                <button
                  type="button"
                  aria-label={t("chat.attach.remove")}
                  onClick={() => onRemoveAttachment(i)}
                >
                  <X size={10} aria-hidden />
                </button>
              </span>
            ))}
          </div>
        )}
        {limitTip && <div className="attach-limit">{t("chat.attach.limit")}</div>}
        <div className="chat-inputbar">
          <span className="prompt">&gt;</span>
          {/* T9 附件钮（图片上传；steer 带图非目标——生成中禁用）+ 隐藏 file picker */}
          <button
            className="hud-btn attach-btn"
            id="btn-attach"
            type="button"
            aria-label={t("chat.attach.button")}
            title={t("chat.attach.button")}
            disabled={!canSend || generating}
            onClick={() => fileRef.current?.click()}
          >
            <ImagePlus size={12} aria-hidden />
          </button>
          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            multiple
            hidden
            onChange={onPick}
          />
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
