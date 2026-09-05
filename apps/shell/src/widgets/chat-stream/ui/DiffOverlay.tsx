/**
 * DiffOverlay（T3+T4 diff 批）——轮次 diff 详情覆盖窗（盖 chat 对话区）。
 *
 * 挂载位：ChatPage 经 MessageFlow children 注入（conn-overlay 同族——
 * .msg-flow-wrap 定位上下文，absolute inset-0 不随滚动，E-89 纪律之外层）。
 *
 * 查询链（trace 族点对点回执同构）：挂载即发 diff.get（live 旗标随开窗时
 * state.diff.phase：active → 进行中轮实时视图；frozen/null → 冻结视图）；
 * diff.get.result 经 subscribeDiffFrames 注入（页面私有 reducer 消费，
 * AG-15 不进 session store）；connection.error → 错误态（单飞：无 pending
 * 忽略）。Esc / 点遮罩 → onClose。
 *
 * 呈现：左文件列表（status 色点 data-status / 路径 / ±counts / 多 agent
 * 徽章：main 主色、SubAgent agent-<id> 短 id、external 无徽章 + note 粗估
 * 说明）+ 右 unified diff 渲染（daemon 已算好文本——前端纯着色：+行 add /
 * −行 del / @@ hunk 头）。
 */
import { useEffect, useMemo, useReducer } from "react";
import { useSession } from "@/entities/session/SessionContext";
import { useI18n } from "@/shared/i18n";
import type { DiffFileDto, EventEnvelope, DiffGetResultPayload } from "@helix/protocol";

interface DiffOverlayProps {
  onClose: () => void;
}

type ViewState =
  | { status: "pending" }
  | { status: "error"; message: string }
  | { status: "done"; files: readonly DiffFileDto[]; summary: { adds: number; dels: number }; selected: number };

type Action =
  | { type: "result"; files: readonly DiffFileDto[]; summary: { adds: number; dels: number } }
  | { type: "failed"; reason: string }
  | { type: "select"; index: number };

function reduceView(s: ViewState, a: Action): ViewState {
  switch (a.type) {
    case "result":
      return { status: "done", files: a.files, summary: a.summary, selected: 0 };
    case "failed":
      return { status: "error", message: a.reason };
    case "select":
      return s.status === "done" ? { ...s, selected: a.index } : s;
  }
}

/** agent-<uuid> → 短 id（uuid 前 6 位截断；字面 "main" 保持）。 */
function shortAgent(agent: string): string {
  return agent.startsWith("agent-") ? agent.slice("agent-".length, "agent-".length + 6) : agent;
}

const DiffOverlay = function DiffOverlay({ onClose }: DiffOverlayProps) {
  const { state, sendDiffGet, subscribeDiffFrames } = useSession();
  const { t } = useI18n();
  const [view, dispatch] = useReducer(reduceView, { status: "pending" } as ViewState);

  // 开窗时轮相位定格（live 旗标只随开窗时刻，不随后续帧漂移）
  const openPhase = state.diff?.phase;

  // 挂载即查（单飞）：active 轮 → live:true 实时视图；否则冻结视图
  useEffect(() => {
    sendDiffGet(openPhase === "active" ? { live: true } : {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 点对点回执消费（页面私有 reducer；AG-15 不进 session store）
  useEffect(
    () =>
      subscribeDiffFrames((e: EventEnvelope) => {
        // diff.get.result 为窄化点对点回执（不入 EVENT_TYPES 目录——task 族
        // 先例，契约 §0 计数纪律）：联合外宽松判别（TasksPage 先例同构）
        const et = e.type as string;
        if (et === "diff.get.result") {
          const p = (e as unknown as { payload: DiffGetResultPayload }).payload;
          dispatch({ type: "result", files: p.files, summary: p.summary });
        } else if (et === "connection.error") {
          const msg = (e as { payload: { message?: string } }).payload?.message ?? "connection.error";
          dispatch({ type: "failed", reason: msg });
        }
      }),
    [subscribeDiffFrames],
  );

  // Esc 关闭
  useEffect(() => {
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const selected = view.status === "done" ? view.files[view.selected] : undefined;
  // unified diff 逐行着色（daemon 产文本，前端纯渲染）
  const lines = useMemo(
    () => (selected?.diff ?? "").split("\n").filter((l) => l !== ""),
    [selected],
  );

  return (
    <div
      className="diff-overlay"
      data-testid="diff-overlay"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="diff-panel" role="dialog" aria-label={t("chat.diff.title")}>
        <header className="diff-head">
          <span className="diff-title">{t("chat.diff.title")}</span>
          {view.status === "done" && (
            <span className="diff-summary">
              +{view.summary.adds} −{view.summary.dels}
            </span>
          )}
          <button type="button" className="diff-close" aria-label={t("chat.diff.close")} onClick={onClose}>
            ×
          </button>
        </header>
        <div className="diff-body">
          {view.status === "pending" && <div className="diff-pending">{t("chat.diff.pending")}</div>}
          {view.status === "error" && (
            <div className="diff-error" data-testid="diff-error">
              {t("chat.diff.loadFail")}：{view.message}
            </div>
          )}
          {view.status === "done" && view.files.length === 0 && (
            <div className="diff-empty">{t("chat.diff.empty")}</div>
          )}
          {view.status === "done" && view.files.length > 0 && (
            <>
              <ul className="diff-file-list">
                {view.files.map((f, i) => (
                  <li
                    key={f.path}
                    className="diff-file"
                    data-status={f.status}
                    data-selected={i === view.selected ? "1" : undefined}
                    onClick={() => dispatch({ type: "select", index: i })}
                  >
                    <i className="diff-dot" />
                    <span className="diff-path" title={f.path}>
                      {f.path}
                    </span>
                    <span className="diff-counts">
                      +{f.adds} −{f.dels}
                    </span>
                    {f.note === undefined && <span className="diff-agents-label">{t("chat.diff.agentsLabel")}</span>}
                    <span className="diff-agents">
                      {f.agents.map((a) => (
                        <em key={a} className="diff-agent" data-agent={a === "main" ? "main" : "sub"}>
                          {shortAgent(a)}
                        </em>
                      ))}
                    </span>
                    {f.note !== undefined && (
                      <span className="diff-note" title={f.note}>
                        {f.note}
                      </span>
                    )}
                  </li>
                ))}
              </ul>
              <pre className="diff-view">
                {selected?.diff !== undefined
                  ? lines.map((l, i) => (
                      <span
                        key={i}
                        className={
                          l.startsWith("+") ? "dl-add" : l.startsWith("-") ? "dl-del" : l.startsWith("@@") ? "dl-hunk" : "dl-ctx"
                        }
                      >
                        {l}
                        {"\n"}
                      </span>
                    ))
                  : selected?.note ?? ""}
              </pre>
            </>
          )}
        </div>
      </div>
    </div>
  );
};

export default DiffOverlay;
