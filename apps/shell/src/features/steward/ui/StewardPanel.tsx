/**
 * StewardPanel —— 管家对话面板（纯记录面，B2 全局语音批瘦身定稿：设计稿
 * §2 职责重划 / §3.5，D4）。
 *
 * B2 起语音能力整体移交全局光球层（StewardVoiceLayer——useStewardVoice
 * 挂载点迁移）；本面板 = 历史流 + 文本输入（Enter 换行 / alt+enter 发送
 * ——Composer 键位照抄）+ 顶部按钮（记忆/新对话/关闭）。语音区组件
 * （mic 钮/波形/相位文案/interim 浮字/双模切换/voiceDraft 采纳路径/
 * 耳机提示）已退役；Esc 让位逻辑（wake 会话在途不关面板）随语音 UI
 * 一起退役——Esc 回归纯关面板。
 *
 * 状态面（useSteward 单点）：config null 或 enabled=false → 关闭引导
 * 占位（daemon money gate 客户端同构，头部状态 chip 同步「未开启」）。
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
import { Brain, ChevronDown, ChevronRight, Wrench } from "lucide-react";
import { useSteward } from "../model/useSteward";
import { useStickyBottom } from "../model/useStickyBottom";
import type { StewardPanelItem } from "../model/useSteward";
import MarkdownMessage from "@/shared/ui/MarkdownMessage";
import { useI18n } from "@/shared/i18n";

interface StewardPanelProps {
  onClose: () => void;
  /** 面板活跃（可见）态；false = Dock 隐藏期（组件树驻留但不可见）——
   *  Esc 窗口监听挂载归活跃态（隐藏期零全局监听，A1）。 */
  readonly active?: boolean;
  /** B2-④ 入口①：头部记忆钮 → 记忆独立页 /steward/memory（app 层注入）。 */
  readonly onOpenMemory?: () => void;
}

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
  const sv = useSteward();
  const [draft, setDraft] = useState("");

  // 历史锚底（驾驶舱批①：chat 页 MessageFlow 滚动语义同构）：吸附态新内容
  // 贴底；上滚脱附不拽回；回底 1s 驻留恢复吸附；打开面板强制贴底。
  const sticky = useStickyBottom();

  // onClose ref 定格（DiffOverlay 先例）：调用方内联箭头每渲染新引用，
  // Esc 监听不随调用方重渲染反复解绑/重挂
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  // Esc = 纯关面板（B2 语音退役后回归——wake 会话让位逻辑随语音 UI 拆除）
  useEffect(() => {
    if (!active) return; // 隐藏期零全局监听（A1：隐藏不卸载但监听归活跃态）
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCloseRef.current();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [active]);

  const enabled = sv.config?.enabled === true;

  // 内容增长贴底（仅吸附态）：条目流/流式文本/输入面可用性变化。
  useLayoutEffect(() => {
    sticky.stickIfAttached();
  }, [sticky, sv.items, sv.streamingText, sv.askInFlight]);

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
          {/* B1：确认卡移出面板——左下角全局 ConfirmStack 承载（useStewardActions）。
              B2：语音区退役——全局光球层（StewardVoiceLayer）承载语音 */}
          <div className="stp-composer">
            <textarea
              className="stp-input"
              data-testid="steward-input"
              value={draft}
              rows={2}
              placeholder={t("steward.inputPlaceholder")}
              disabled={sv.askInFlight}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                // Alt+Enter 发送；Enter / Shift+Enter 不拦截（原生换行）——
                // Composer 键位照抄（设计稿 §1.4）
                if (e.key === "Enter" && e.altKey) {
                  e.preventDefault();
                  submit();
                }
              }}
            />
            <button type="button" className="stp-send" data-testid="steward-send" disabled={sv.askInFlight} onClick={submit}>
              {t("steward.send")}
            </button>
          </div>
        </>
      )}
    </aside>
  );
};

export default StewardPanel;
