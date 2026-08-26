/**
 * F5.3 知识变化报告（四类条目 + 行动项 + 清零横幅）。
 *
 * 条目形态（AD-16）：sev 色映射边框与类型标签（warn→⚠ / info→? / ok→✓）；
 * body = 因果叙述句；refs.nodes = 粗体『name』+kind 徽章（可跳转）、
 * refs.symbols = 等宽符号+路径:行号——正文之外的结构化引用附于条目尾。
 * 行动项：radio 单选（chip 样式）→ 条目转已处理（降透明+已处理：X+撤销），
 * 仅前端标记不落库（转正例外走 kg.node.confirm）；全部处理 → 清零横幅。
 */
import type { KgChangeReportDto, KgNodeListRow } from "@helix/protocol";
import { useI18n } from "@/shared/i18n";
import { fmtNarrative, NodeRef, SymbolRef } from "./kg-refs";

/** sev → glyph + 色类（warn=⚠ / info=? / ok=✓）。 */
const SEV_GLYPH: Record<KgChangeReportDto["entries"][number]["sev"], string> = {
  warn: "⚠",
  info: "?",
  ok: "✓",
};

function ReportSkeleton() {
  return (
    <>
      {[0, 1].map((i) => (
        <div className="kg-skel-card" key={i} style={{ marginBottom: 12 }}>
          <div className="kg-skel-line" style={{ width: "22%" }} />
          <div className="kg-skel-line" style={{ width: "88%" }} />
          <div className="kg-skel-line" style={{ width: "64%" }} />
        </div>
      ))}
    </>
  );
}

const KgReportPane = function KgReportPane({
  report,
  resolved,
  byId,
  onGoto,
  onResolve,
  onUnresolve,
}: {
  report: KgChangeReportDto | null;
  resolved: Record<number, string>;
  byId: ReadonlyMap<string, KgNodeListRow>;
  onGoto: (id: string) => void;
  onResolve: (index: number, value: string) => void;
  onUnresolve: (index: number) => void;
}) {
  const { t } = useI18n();
  if (report === null) return <ReportSkeleton />;

  const pending = report.entries.length - Object.keys(resolved).length;

  return (
    <div data-kg-report>
      <div className="kgv-report-head">
        <span className="kgv-report-title">{t("pj.kg.reportTitle")}</span>
        <span className="hud-chip">{report.iterationId}</span>
        <span className="hud-chip">{t("pj.kg.reportCount", { n: report.entries.length })}</span>
      </div>
      {pending === 0 && (
        <div className="kgv-report-clear" data-kg-report-clear>
          {t("pj.kg.reportClear", { n: report.entries.length })}
        </div>
      )}
      {report.entries.map((en, i) => {
        const done = resolved[i] !== undefined;
        return (
          <div className={`kg-entry sev-${en.sev}${done ? " done" : ""}`} data-entry-kind={en.kind} key={i}>
            <div className="kg-entry-type">
              {en.label} {SEV_GLYPH[en.sev]}
            </div>
            <div className="kgv-body">{fmtNarrative(en.body, byId, onGoto)}</div>
            {/* 结构化引用（AD-16：知识引用可跳转；符号等宽+路径:行号） */}
            {(en.refs.nodes.length > 0 || en.refs.symbols.length > 0) && (
              <div className="kg-rel-row" style={{ marginTop: 8 }}>
                {en.refs.nodes.map((n) => (
                  <span key={n.id} style={{ marginRight: 10 }}>
                    <NodeRef id={n.id} name={n.name} kind={n.kind} onGoto={onGoto} />
                  </span>
                ))}
                {en.refs.symbols.map((s, j) => (
                  <span key={j} style={{ marginRight: 10 }}>
                    <SymbolRef name={s.name} path={s.path} line={s.line} />
                  </span>
                ))}
              </div>
            )}
            <div className="kg-entry-actions">
              {done ? (
                <>
                  <span className="kg-done-note" data-kg-done={i}>
                    {t("pj.kg.doneNote", { value: resolved[i]! })}
                  </span>
                  <span className="kg-undo" data-kg-undo={i} onClick={() => onUnresolve(i)}>
                    {t("pj.kg.undo")}
                  </span>
                </>
              ) : (
                <>
                  <span className="lead">{t("pj.kg.decide")}</span>
                  {en.options.map((o) => (
                    <label className="kg-opt" key={o}>
                      <input type="radio" name={`e${i}`} value={o} data-kg-opt={i} onChange={() => onResolve(i, o)} />
                      {o}
                    </label>
                  ))}
                </>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
};

export default KgReportPane;
