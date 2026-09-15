/**
 * DiffOverlay（T3+T4 diff 批）——轮次 diff 详情覆盖窗（盖 chat 对话区）。
 *
 * 挂载位（浮窗批 v3）：ChatPage .app 直系末尾，absolute 锚 .app 盒——
 * .app 外盒由 app-layout flex 恒定（流式期 banner/composer 只重分内部空间），
 * 位置稳定；几何不含 nav-rail/session 侧栏（不覆盖、不参与其 z 序）。
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
import { useEffect, useMemo, useReducer, useRef } from "react";
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
    case "result": {
      // result 帧保留原 selected（code-review 低危组9）：live 视图多帧到达时
      // 用户已选文件不闪回首项；新 files 长度收缩时越界钳制到末项（空表 → 0）
      const prev = s.status === "done" ? s.selected : 0;
      const max = Math.max(0, a.files.length - 1);
      return { status: "done", files: a.files, summary: a.summary, selected: Math.min(prev, max) };
    }
    case "failed":
      // 单飞门控（code-review M，TR-84 同纪律）：仅在途（pending）消费——
      // send false 挂载即失败亦出自 pending；done 视图不被无关 connection.error 误判
      return s.status === "pending" ? { status: "error", message: a.reason } : s;
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

  // onClose ref 定格（code-review 低危组9）：调用方内联箭头每渲染新引用，
  // Esc 监听不随调用方重渲染反复解绑/重挂（最新闭包经 ref 转发）
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  // 开窗时轮相位定格（live 旗标只随开窗时刻，不随后续帧漂移）
  const openPhase = state.diff?.phase;

  // 挂载即查（单飞）：active 轮 → live:true 实时视图；否则冻结视图；
  // send false（断线窗口，code-review M/TR-168）→ failed 态交代（不永挂 pending）
  useEffect(() => {
    const ok = sendDiffGet(openPhase === "active" ? { live: true } : {});
    if (ok === false) dispatch({ type: "failed", reason: t("chat.diff.loadFail") });
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
          // 单飞门控（code-review M：头注释自称「无 pending 忽略」——由 reducer
          // 落：failed 仅 pending 在途生效，done/其它视图不被无关错误帧误判）
          const msg = (e as { payload: { message?: string } }).payload?.message ?? "connection.error";
          dispatch({ type: "failed", reason: msg });
        }
      }),
    [subscribeDiffFrames],
  );

  // Esc 关闭（onClose 经 ref 定格——监听器恒挂载一次）
  useEffect(() => {
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === "Escape") onCloseRef.current();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const selected = view.status === "done" ? view.files[view.selected] : undefined;
  // unified diff 逐行着色（daemon 产文本，前端纯渲染）。先去尾空行再 split
  // （code-review 低危组9）：只剥末尾换行产生的空串，正文内空行（上下文空
  // 行）保留——旧 filter 会连正文空行一并抹掉，hunk 间距失真
  const lines = useMemo(
    () => (selected?.diff ?? "").replace(/\n+$/, "").split("\n"),
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
                    role="button"
                    tabIndex={0}
                    aria-pressed={i === view.selected}
                    onClick={() => dispatch({ type: "select", index: i })}
                    onKeyDown={(e) => {
                      // 键盘可达（W3 #2.36）：Enter/空格切换 diff 文件——与点击同路径
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        dispatch({ type: "select", index: i });
                      }
                    }}
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
