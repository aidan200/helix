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
 * - 停止钮 #btn-mic（语音输入 V2：点击交互）：点击开始 → 录音中（电平条
 *   实时反馈，VAD 静音自动停）→ 点击强制停；转写中 spinner + 禁用（三态
 *   互斥）；回填草稿（转写结果是草稿而非直接发送，最后一道人工闸）；
 *   unsupported（裸跑无授权）隐藏；
 * - 脚注 kbd 键帽提示（[[x]] 标记渲染）。
 */
import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState, type ChangeEvent, type CSSProperties, type KeyboardEvent, type ReactNode } from "react";
import { ImagePlus, Loader2, Mic, Square, X } from "lucide-react";
import { useI18n } from "@/shared/i18n";
import { useToast } from "@/shared/ui/Toast";
import { selectCanSend, selectIsGenerating, useSession } from "@/entities/session/SessionContext";
import { selectActiveRunState } from "@/entities/session/model/topology";
import { useComposerVoice } from "../model/useComposerVoice";
import { cn } from "@/shared/lib/cn";

/** textarea 自动增高上限（px；≈7 行），超出后 overflow-y 内滚。 */
const TA_MAX_HEIGHT = 160;

/** 电平条 per-bar 缩放因子（JS 预计算 scaleY——WKWebView 无 calc() 乘法约束，
 *  §7 WebView 兼容；中条最高、两侧渐低）。 */
const MIC_BAR_FACTORS = [0.55, 0.8, 1, 0.82, 0.6] as const;

/** level → per-bar CSS 变量表（--lv<n>：0.2 底高 + 电平×因子，封顶 1）。 */
function micLevelVars(level: number): Record<string, string> {
  const vars: Record<string, string> = {};
  MIC_BAR_FACTORS.forEach((factor, i) => {
    vars[`--lv${i + 1}`] = Math.min(1, 0.2 + level * factor).toFixed(3);
  });
  return vars;
}

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

export interface ComposerProps {
  /** composer-foot 右侧槽位（space-between 空位；FSD 纪律——features 同层不
   *  互引，页面部件由 pages 层装配注入：P-1 推理强度 picker 走此槽，T2.1） */
  footEnd?: ReactNode;
}

/** M52：聚焦能力出口（pages 层 ref 接线——SessionEmpty/SessionSidebar 的
 *  「建议 chip / 新建会话 → 聚焦输入框」经 props 回调传导，不做魔法 id DOM 直达）。 */
export interface ComposerHandle {
  focus: () => void;
}

const Composer = forwardRef<ComposerHandle, ComposerProps>(function Composer({ footEnd }, ref) {
  const { t } = useI18n();
  const toast = useToast();
  const { state, setDraft, submit, abort, attachImages, removeAttachment } = useSession();
  const canSend = selectCanSend(state);
  const generating = selectIsGenerating(state);
  // 停止钮可用判据：main session 正在生成（subagent_running = main 空闲，
  // chat.abort 只中断 main 生成，不作用于 SubAgent）
  const abortable = selectActiveRunState(state) === "streaming";
  const taRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  // M52：聚焦出口（pages 层经 ref 调起；替代跨层 getElementById 直达）
  useImperativeHandle(ref, () => ({ focus: () => taRef.current?.focus() }), []);
  // 语音输入（V1 → 实时识别批：useComposerVoice 流式接线——stt.stream 实时
  // 回流）；interim 经镜像层灰字上屏（见 msg-interim-layer）；final 回填草稿
  //（末尾拼接——保留已输入内容，最后一道人工闸）；失败 toast
  const voice = useComposerVoice((text) => {
    setDraft(state.draft === "" ? text : `${state.draft}${text}`);
  });
  useEffect(() => {
    if (voice.error !== null) toast.push("err", voice.error);
  }, [toast, voice.error]);
  // 附件超限提示（T9：第 5 张选择预检拦截；移除/成功 attach 后消隐）
  const [limitTip, setLimitTip] = useState(false);
  // M53：附件读取失败临时提示（FileReader 错误；3s 自动消隐）
  const [pickError, setPickError] = useState(false);
  // 消隐 timer 登记：卸载时清理（setState 卸载后触发属泄漏形态，React 18
  // 无害但清理纪律补齐）
  const pickErrTimerRef = useRef<number | null>(null);
  useEffect(
    () => () => {
      if (pickErrTimerRef.current !== null) window.clearTimeout(pickErrTimerRef.current);
    },
    [],
  );

  // 语音镜像层 ref（interim 灰字与草稿同面渲染——textarea 自身文本
  // voice-on 期 CSS 隐去，镜像层接管视觉；jsdom 无布局不落地同步值）
  const mirrorRef = useRef<HTMLDivElement>(null);
  // 录音/转写期 = 镜像期（final 回填草稿后立即出态，灰字让位正式文本）
  const voiceMirroring = voice.state === "recording" || voice.state === "transcribing";

  // 自动增高：内容高度增长至上限后内滚。jsdom 无布局（scrollHeight=0）时
  // 不落内联高度，交还 CSS 默认单行。镜像期以镜像层内容高（草稿+interim）
  // 为准——输入框边说边长，final 转正后归草稿自身高度。
  useEffect(() => {
    const el = taRef.current;
    if (!el) return;
    el.style.height = "auto";
    const measure = mirrorRef.current ?? el;
    el.style.height = measure.scrollHeight > 0 ? `${Math.min(measure.scrollHeight, TA_MAX_HEIGHT)}px` : "";
  }, [state.draft, voice.interim, voiceMirroring]);

  // 镜像层滚动同步：interim 追尾增长（最新可见——bottom 对齐；不低于
  // textarea 自身滚动位，草稿长文场景跟随用户视点）
  useEffect(() => {
    const el = taRef.current;
    const mirror = mirrorRef.current;
    if (el === null || mirror === null) return;
    mirror.scrollTop = Math.max(el.scrollTop, mirror.scrollHeight - mirror.clientHeight);
  }, [voice.interim, state.draft, voiceMirroring]);

  const placeholder = canSend
    ? t("chat.composer.placeholder")
    : state.conn === "connected" && state.view === "loading"
      ? t("chat.paging.placeholder") // P-1s 切换恢复：输入禁用占位（快照到达恢复）
      : state.conn === "connecting"
        ? t("chat.composer.placeholderConnecting")
        : t("chat.composer.placeholderWaiting");

  // 发送提交（trim 门控共享）。T9 附件载荷契约（code-review 低危组11 单一
  // 形态收口：原按钮/Alt+Enter 双形态 submit(text, undefined) vs submit(text)
  // 已统一——两路径同形，测试契约不再分叉）：
  // - 携带附件 → submit(text, images)；
  // - 无附件 → submit(text, undefined)（显式第二参，两路径一致）。
  // M9（#2.18，TR-84）：submit 返回 false（未连接发送失败）→ err toast 交代
  //（草稿由 command-surface 保留未清，重试即可）。
  const trySend = useCallback(() => {
    // 纯空白草稿（含换行/空格）不发送（canSend 语义之外的前置 trim 门控）
    if (!canSend || state.draft.trim() === "") return;
    const ok =
      state.attachments.length > 0 ? submit(state.draft, state.attachments) : submit(state.draft, undefined);
    if (!ok) toast.push("err", t("chat.composer.sendFail"));
  }, [canSend, state.attachments, state.draft, submit, toast, t]);

  const onSend = useCallback(() => trySend(), [trySend]);

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    // Alt+Enter（mac Option）发送；Enter / Shift+Enter / Cmd+Enter 不拦截（原生换行）
    if (e.key === "Enter" && e.altKey) {
      e.preventDefault();
      trySend();
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
    void Promise.all(files.map(readAsDataURL))
      .then((urls) => {
        setLimitTip(false);
        attachImages(urls);
      })
      .catch(() => {
        // M53：读取失败交代——临时错误提示（3s 消隐）+ 收口 limitTip（不残留）
        setLimitTip(false);
        setPickError(true);
        pickErrTimerRef.current = window.setTimeout(() => setPickError(false), 3000);
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
        {pickError && <div className="attach-limit" data-attach-error>{t("chat.attach.readFail")}</div>}
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
          {/* 语音输入钮（V2：点击交互）：待录 Mic / 录音中电平条（level 驱动
              per-bar scaleY）/ 转写中 spinner；点击开始、录音中点击强制停；
              unsupported（tauri dev 裸跑无授权）隐藏。
              录音中恒不禁用（中危 F3a）：强制停是本地动作不依赖连接/视图态
              ——断连（canSend=false）时禁用会让 voice.stop() 不可达，录音悬挂
              到 VAD 静音自停；idle/转写态照旧按 canSend 禁开录 */}
          {voice.state !== "unsupported" && (
            <button
              className={cn("hud-btn", "mic-btn", voice.state === "recording" && "recording")}
              id="btn-mic"
              type="button"
              aria-label={voice.state === "recording" ? t("chat.voice.recording") : voice.state === "transcribing" ? t("chat.voice.transcribing") : t("chat.voice.button")}
              title={t("chat.voice.button")}
              disabled={voice.state === "recording" ? false : !canSend || voice.state === "transcribing"}
              onClick={() => {
                if (voice.state === "idle") void voice.start();
                else if (voice.state === "recording") voice.stop();
              }}
            >
              {voice.state === "recording" ? (
                <span className="mic-level" style={micLevelVars(voice.level) as CSSProperties} aria-hidden="true">
                  <i />
                  <i />
                  <i />
                  <i />
                  <i />
                </span>
              ) : voice.state === "transcribing" ? (
                <Loader2 size={12} aria-hidden className="spin" />
              ) : (
                <Mic size={12} aria-hidden />
              )}
            </button>
          )}
          {/* 语音镜像层（实时识别批）：录音/转写期 textarea 文本 CSS 隐去，
              镜像层同面渲染「草稿（正常色）+ interim（灰）」——正在说的话
              实时上屏，final 回填草稿后出态卸载；纯展示层零交互 */}
          <div className={cn("msg-input-wrap", voiceMirroring && "voice-on")}>
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
            {voiceMirroring && (
              <div className="msg-interim-layer" aria-hidden="true" ref={mirrorRef}>
                {state.draft}
                <span className="interim">{voice.interim ?? ""}</span>
              </div>
            )}
          </div>
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
          <span className="enter-hint">
            <EnterHint text={t("chat.composer.enterHint")} />
          </span>
          {/* foot 右侧槽位（space-between 空位，foot CSS 零改动）：P-1 推理强度
              picker 由 pages 层注入（AG-15 FSD 同层禁互引） */}
          {footEnd}
        </div>
      </div>
    </footer>
  );
});

export default Composer;
