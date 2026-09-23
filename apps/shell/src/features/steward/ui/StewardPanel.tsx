/**
 * StewardPanel —— 管家对话面板（features/steward 消费端 UI；全局化批重做：
 * 由 chat 右缘 300px 列改 rail 右缘全局弹层内芯；V3a 语音模式：面板内
 * 双模切换，打开默认语音——「跟管家说话」闭环的呈现面）。
 *
 * 结构：头部（标题 + 在线状态 chip + 关闭钮）三段主体：事件流区
 * （steward.feed 文本行滚动窗）/ 对话区（user/steward 两方气泡 + ask 在途态）
 * / 确认卡（confirm_required 全文过目——agentId + 递话全文，确认/放弃两键；
 * §5.2 防火墙客户端面：未点确认零发送）+ 底部输入区（双模）。
 *
 * 双模输入区（V3a）：modebar（语音/文本 切换排 + speaking 态静音钮）之下
 * 二选一互斥渲染——
 * - 语音面（默认）：mic 钮（idle 点击开始 / listening 点击强制停 / 在途禁用）
 *   + 电平波形（level 驱动 scaleY，phase 容器态脉冲）+ 阶段文案行
 *   （idle/listening/transcribing/asking/speaking）+ 行内错误行（转写失败）；
 * - 文本面（既有）：输入框 + 发送钮（Enter 同义）。
 *
 * 状态面（useStewardVoice 单点，V2.5 useSteward 全面透传 + 语音组合）：
 * config null 或 enabled=false → 关闭引导占位（不渲染输入面——daemon
 * money gate 客户端同构，头部状态 chip 同步「未开启」）。
 * 语音转写 ask 发送失败 → voiceDraft 采纳进草稿并切文本态（可重试，
 * 零静默丢话）。
 *
 * Markdown 渲染：steward 气泡复用主聊天 MarkdownMessage（react-markdown +
 * gfm + breaks）；user 气泡纯文本（主聊天同口径）。流式期间（askInFlight +
 * streamingText 非空）显示流式气泡（dashed 边在途态）而非「思考中」占位；
 * 终态 result 权威覆盖。
 *
 * 关闭路径：Esc / 头部 ×（DiffOverlay 先例；onClose ref 定格防重绑——
 * 点外关闭归 StewardDock 壳）；active=false（Dock 隐藏期）时 Esc 监听卸载
 * （A1：隐藏不卸载但全局监听归活跃态）。
 */
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Brain, ChevronDown, ChevronRight, Mic, Square, Wrench } from "lucide-react";
import { useStewardVoice } from "../model/useStewardVoice";
import { useStickyBottom } from "../model/useStickyBottom";
import type { StewardPanelItem } from "../model/useSteward";
import type { StewardVoicePhase } from "../model/steward-voice-machine";
import MarkdownMessage from "@/shared/ui/MarkdownMessage";
import { readPersistedFlag, writePersistedFlag } from "@/shared/lib/persisted-flag";
import { useI18n } from "@/shared/i18n";

interface StewardPanelProps {
  onClose: () => void;
  /** 面板活跃（可见）态；false = Dock 隐藏期（组件树驻留但不可见）——
 *  Esc 窗口监听挂载归活跃态（隐藏期零全局监听，A1）。 */
  readonly active?: boolean;
  /** B2-④ 入口①：头部记忆钮 → 记忆独立页 /steward/memory（app 层注入）。 */
  readonly onOpenMemory?: () => void;
}

/** 波形条高型（7 条对称阵列；listening 态 = level × 型值，他态贴底）。 */
const WAVE_PATTERN = [0.45, 0.75, 1, 0.6, 1, 0.75, 0.45] as const;

/** 耳机提示一次性 flag（B2 随附：扬声器场景建议戴耳机——防自声触发；
 *  persisted-flag 白名单抽象，AG-14 零业务状态持久化口径）。 */
const HEADSET_HINT_KEY = "helix.steward.headsetHintSeen";

/** thinking 折叠条目（默认折叠可展开——屏幕通道完整显示，样式对齐主会话
 *  thinking 条目密度但更紧凑；A1 批）。 */
function ThinkingRow({ text }: { readonly text: string }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  return (
    <div className="stp-think" data-testid="steward-thinking-item">
      <button type="button" className="stp-think-toggle" data-testid="steward-thinking-toggle" onClick={() => setOpen((v) => !v)}>
        {open ? <ChevronDown size={12} strokeWidth={1.75} /> : <ChevronRight size={12} strokeWidth={1.75} />}
        <span className="stp-think-label">{t("steward.thinkingLabel")}</span>
      </button>
      {open && (
        <div className="stp-think-body" data-testid="steward-thinking-body">
          {text}
        </div>
      )}
    </div>
  );
}

/** 工具过程行（「✓ 查询任务列表」可展开结果摘要；A1 批——过程可见）。 */
function ToolRow({ name, argsSummary, resultSummary }: {
  readonly name: string;
  readonly argsSummary: string;
  readonly resultSummary: string | null;
}) {
  const [open, setOpen] = useState(false);
  const done = resultSummary !== null;
  return (
    <div className={`stp-tool${done ? " done" : ""}`} data-testid="steward-tool-item">
      <button type="button" className="stp-tool-toggle" data-testid="steward-tool-toggle" onClick={() => setOpen((v) => !v)}>
        <Wrench size={11} strokeWidth={1.75} />
        <span className="stp-tool-name">{name}</span>
        <span className="stp-tool-state" data-testid="steward-tool-state">{done ? "✓" : "…"}</span>
      </button>
      {open && (
        <div className="stp-tool-body" data-testid="steward-tool-body">
          {argsSummary !== "" && (
            <div className="stp-tool-args">{argsSummary}</div>
          )}
          <div className="stp-tool-result">{resultSummary ?? ""}</div>
        </div>
      )}
    </div>
  );
}

/** 过程条目渲染分发（A1：user/assistant 气泡 + thinking 折叠 + 工具行）。 */
function PanelItemRow({ item }: { readonly item: StewardPanelItem }) {
  if (item.kind === "user") {
    return (
      <div className="stp-msg stp-msg-user" data-testid="steward-msg-user">
        {item.text}
      </div>
    );
  }
  if (item.kind === "assistant") {
    return (
      <div className="stp-msg stp-msg-steward" data-testid="steward-msg-steward">
        <MarkdownMessage text={item.text} />
      </div>
    );
  }
  if (item.kind === "thinking") return <ThinkingRow text={item.text} />;
  return <ToolRow name={item.name} argsSummary={item.argsSummary} resultSummary={item.resultSummary} />;
}

const StewardPanel = function StewardPanel({ onClose, active = true, onOpenMemory }: StewardPanelProps) {
  const { t } = useI18n();
  const sv = useStewardVoice(active);
  const [draft, setDraft] = useState("");
  // 耳机提示（B2 随附）：语音模式首次进入一次性明示（扬声器场景防自声触发）
  const [headsetHintSeen, setHeadsetHintSeen] = useState(() => readPersistedFlag(HEADSET_HINT_KEY, false));

  // 历史锚底（驾驶舱批①：chat 页 MessageFlow 滚动语义同构）：吸附态新内容
  // 贴底；上滚脱附不拽回；回底 1s 驻留恢复吸附；打开面板强制贴底。
  const sticky = useStickyBottom();

  // onClose ref 定格（DiffOverlay 先例）：调用方内联箭头每渲染新引用，
  // Esc 监听不随调用方重渲染反复解绑/重挂
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    if (!active) return; // 隐藏期零全局监听（A1：隐藏不卸载但监听归活跃态）
    const wakeActive = sv.wakeState !== "off";
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      // B4：唤醒会话在途时 Esc = 手动退出会命并关麦（useStewardVoice 同键
      // 监听双听消费，此处只让位不关面板）；否则 = 既有关面板语义
      if (wakeActive) return;
      onCloseRef.current();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [active, sv.wakeState]);

  // ask 发送失败的转写文本采纳：回填草稿 + 切文本态（可重试，零静默丢话）
  const voiceDraft = sv.voiceDraft;
  const setMode = sv.setMode;
  const clearVoiceDraft = sv.clearVoiceDraft;
  useEffect(() => {
    if (voiceDraft === null) return;
    setDraft(voiceDraft);
    setMode("text");
    clearVoiceDraft();
  }, [voiceDraft, setMode, clearVoiceDraft]);

  const enabled = sv.config?.enabled === true;
  const { mode, phase, level } = sv;

  // 内容增长贴底（仅吸附态）：条目流/流式文本/确认卡出入/输入面可用性变化。
  useLayoutEffect(() => {
    sticky.stickIfAttached();
  }, [sticky, sv.items, sv.streamingText, sv.askInFlight, sv.pending]);

  // 打开面板（active 升起）→ 强制贴底 + 吸附复位（面板隐藏不卸载——重开
  // 应回到最新消息，不吃隐藏期残留滚动位置）。
  useEffect(() => {
    if (active) sticky.stick();
  }, [active, sticky]);

  const submit = () => {
    if (draft.trim() === "" || sv.askInFlight) return;
    const ok = sv.ask(draft); // false = 未连接：零静默丢消息（hook 不推气泡，草稿保留）
    if (ok === false) return;
    setDraft("");
  };

  const phaseCaption: Record<StewardVoicePhase, string> = {
    unsupported: t("steward.voice.micUnavailable"),
    idle: t("steward.voice.phaseIdle"),
    wake_armed: t("steward.voice.phaseWakeArmed"),
    listening: t("steward.voice.phaseListening"),
    transcribing: t("steward.voice.phaseTranscribing"),
    asking: t("steward.voice.phaseAsking"),
    speaking: t("steward.voice.phaseSpeaking"),
  };
  const listening = phase === "listening";
  // B4 唤醒待命（可见待命指示）：mic 鈕 = 手动退出会话并关麦（cancelWake）
  const wakeArmed = phase === "wake_armed";
  const micLive = listening || wakeArmed;
  const micBusy = phase === "transcribing" || phase === "asking";

  return (
    <aside className="stp" data-testid="steward-panel" role="complementary" aria-label={t("steward.title")}>
      <header className="stp-head">
        <span className="stp-title">{t("steward.title")}</span>
        <span className={enabled ? "stp-status on" : "stp-status"} data-testid="steward-status">
          <i className="stp-status-dot" aria-hidden="true" />
          {enabled ? t("steward.stateOn") : t("steward.stateOff")}
        </span>
        <button
          type="button"
          className="stp-newchat"
          data-testid="steward-open-memory"
          title={t("steward.memory.openTitle")}
          aria-label={t("steward.memory.openTitle")}
          onClick={onOpenMemory}
        >
          <Brain size={14} strokeWidth={1.75} aria-hidden="true" />
        </button>
        <button
          type="button"
          className="stp-newchat"
          data-testid="steward-new-chat"
          title={t("steward.newChatTitle")}
          onClick={() => sv.newDialog()}
        >
          {t("steward.newChat")}
        </button>
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
          <div className="stp-feed" data-testid="steward-feed">
            <span className="stp-feed-label">{t("steward.feedTitle")}</span>
            {sv.feed.length === 0 ? (
              <span className="stp-feed-empty">{t("steward.feedEmpty")}</span>
            ) : (
              sv.feed.map((line) => (
                <div className="stp-feed-line" key={`${line.seq}-${line.agentId}`}>
                  {line.text}
                </div>
              ))
            )}
          </div>
          <div className="stp-msgs" ref={sticky.ref} onScroll={sticky.onScroll} data-testid="steward-msgs">
            {sv.items.map((item, i) => (
              <PanelItemRow key={i} item={item} />
            ))}
            {/* 流式气泡：delta 聚合文本 md 渲染；终态 result 到达即由正式
                气泡接管（streamingText 清空 → 本槽退场） */}
            {sv.askInFlight && sv.streamingText !== null && sv.streamingText !== "" ? (
              <div className="stp-msg stp-msg-steward stp-msg-streaming" data-testid="steward-msg-streaming">
                <MarkdownMessage text={sv.streamingText} />
              </div>
            ) : (
              sv.askInFlight && (
                <div className="stp-inflight" data-testid="steward-inflight">
                  {t("steward.thinking")}
                </div>
              )
            )}
          </div>
          {sv.pending !== null && (
            <div className="stp-confirm" data-testid="steward-confirm-card">
              <span className="stp-confirm-title">{t("steward.confirmTitle")}</span>
              <span className="stp-confirm-row">
                <span className="stp-confirm-k">{t("steward.confirmTarget")}</span>
                <span className="stp-confirm-v">{sv.pending.agentId}</span>
              </span>
              <span className="stp-confirm-row">
                <span className="stp-confirm-k">{t("steward.confirmBody")}</span>
                <span className="stp-confirm-v">{sv.pending.message}</span>
              </span>
              <div className="stp-confirm-actions">
                <button type="button" className="stp-confirm-yes" data-testid="steward-confirm-yes" onClick={() => sv.confirmPending()}>
                  {t("steward.confirmYes")}
                </button>
                <button type="button" className="stp-confirm-no" data-testid="steward-confirm-no" onClick={sv.dismissPending}>
                  {t("steward.confirmNo")}
                </button>
              </div>
            </div>
          )}
          {/* 双模切换排（V3a）：语音/文本互斥 + 朗读中静音钮（一键停读） */}
          <div className="stp-modebar">
            <div className="stp-mode" data-testid="steward-mode" role="group" aria-label={t("steward.voice.modeLabel")}>
              <button
                type="button"
                className={`stp-mode-btn${mode === "voice" ? " on" : ""}`}
                data-testid="steward-mode-voice"
                aria-pressed={mode === "voice"}
                title={phase === "unsupported" ? t("steward.voice.micUnavailable") : undefined}
                onClick={() => sv.setMode("voice")}
              >
                {t("steward.voice.modeVoice")}
              </button>
              <button
                type="button"
                className={`stp-mode-btn${mode === "text" ? " on" : ""}`}
                data-testid="steward-mode-text"
                aria-pressed={mode === "text"}
                onClick={() => sv.setMode("text")}
              >
                {t("steward.voice.modeText")}
              </button>
            </div>
            {sv.speaking && (
              <button type="button" className="stp-mute" data-testid="steward-mute" onClick={sv.stopSpeaking}>
                {t("steward.voice.speakStop")}
              </button>
            )}
          </div>
          {mode === "voice" ? (
            /* 语音面：mic 钮 + 电平波形 + 阶段文案（phase 容器态驱动视觉） */
            <div className="stp-voice" data-testid="steward-voice" data-phase={phase}>
              <button
                type="button"
                className={`stp-mic${micLive ? " listening" : ""}`}
                data-testid="steward-mic"
                disabled={micBusy}
                aria-label={micLive ? t("steward.voice.micStop") : t("steward.voice.micStart")}
                onClick={() => (wakeArmed ? sv.cancelWake() : listening ? sv.stopListening() : void sv.startListening())}
              >
                {micLive ? <Square size={15} strokeWidth={1.75} /> : <Mic size={16} strokeWidth={1.75} />}
              </button>
              <div className="stp-wave" aria-hidden="true">
                {WAVE_PATTERN.map((shape, i) => (
                  <i
                    key={i}
                    className="stp-wave-bar"
                    style={{ transform: `scaleY(${micLive ? Math.max(0.12, level * shape).toFixed(3) : 0.12})` }}
                  />
                ))}
              </div>
              <div className="stp-voice-status">
                <span className="stp-voice-phase" data-testid="steward-voice-phase">
                  {phaseCaption[phase]}
                </span>
                {/* V3b-1 流式 interim 浮字：淡色斜体，波形下方实时上屏（listening
                    态随帧刷新；transcribing 态短暂保留至 final 转正；B4 唤醒待命期
                    = 唤醒匹配进度可视，命中前内容只上屏不入对话）；final 到达
                    由 ask 气泡接管 */}
                {(micLive || phase === "transcribing") && sv.interim !== null && sv.interim !== "" && (
                  <span className="stp-interim" data-testid="steward-interim" aria-live="polite">
                    {sv.interim}
                  </span>
                )}
                {phase === "idle" && (
                  <span className="stp-voice-hint" data-testid="steward-voice-hint">
                    {t("steward.voice.phaseIdleHint")}
                  </span>
                )}
                {sv.streamDegraded && (listening || phase === "transcribing") && (
                  <span className="stp-stream-degraded" data-testid="steward-stream-degraded">
                    {t("steward.voice.streamDegraded")}
                  </span>
                )}
                {sv.voiceError !== null && (
                  <span className="stp-voice-err" data-testid="steward-voice-err">
                    {sv.voiceError}
                  </span>
                )}
                {/* B2 随附耳机提示：一次性（flag 持久，关闭后不再现） */}
                {!headsetHintSeen && (
                  <span className="stp-headset-hint" data-testid="steward-headset-hint">
                    <span className="stp-headset-hint-text">{t("steward.voice.headsetHint")}</span>
                    <button
                      type="button"
                      className="stp-headset-hint-dismiss"
                      data-testid="steward-headset-hint-dismiss"
                      onClick={() => {
                        writePersistedFlag(HEADSET_HINT_KEY, true);
                        setHeadsetHintSeen(true);
                      }}
                    >
                      {t("steward.voice.headsetHintDismiss")}
                    </button>
                  </span>
                )}
              </div>
            </div>
          ) : (
            <div className="stp-composer">
              <input
                className="stp-input"
                data-testid="steward-input"
                value={draft}
                placeholder={t("steward.inputPlaceholder")}
                disabled={sv.askInFlight}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") submit();
                }}
              />
              <button type="button" className="stp-send" data-testid="steward-send" disabled={sv.askInFlight} onClick={submit}>
                {t("steward.send")}
              </button>
            </div>
          )}
        </>
      )}
    </aside>
  );
};

export default StewardPanel;
