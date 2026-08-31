/**
 * F5.3 知识变化报告（四类条目纯通知面）。
 *
 * 条目形态（AD-16）：sev 色映射边框与类型标签（warn→⚠ / info→? / ok→✓）；
 * body = 因果叙述句；refs.nodes = 粗体『name』+kind 徽章、refs.symbols =
 * 等宽符号+路径:行号——正文之外的结构化引用附于条目尾。
 * 报告 = 纯通知面非审核面：条目无任何交互装置（无 radio/已处理/撤销/
 * 清零横幅）；refs 纯信息展示不跳转（用户裁决：节点详情查询在详情 tab，
 * 报告面不做快捷跳转）。
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
  byId,
}: {
  report: KgChangeReportDto | null;
  byId: ReadonlyMap<string, KgNodeListRow>;
}) {
  const { t } = useI18n();
  if (report === null) return <ReportSkeleton />;

  // C1 空态：无条目时的原因说明（尚未产生知识变化，或内容已被清理）
  if (report.entries.length === 0) {
    return (
      <div className="kgv-empty" data-kg-report-empty>
        <div className="kgv-empty-t">{t("pj.kg.reportEmptyTitle")}</div>
        <div className="kgv-empty-s">{t("pj.kg.reportEmptySub")}</div>
      </div>
    );
  }

  return (
    <div data-kg-report>
      <div className="kgv-report-head">
        <span className="kgv-report-title">{t("pj.kg.reportTitle")}</span>
        {report.iterationId != null && <span className="hud-chip">{report.iterationId}</span>}
        <span className="hud-chip">{t("pj.kg.reportCount", { n: report.entries.length })}</span>
      </div>
      {report.entries.map((en, i) => {
        return (
          <div className={`kg-entry sev-${en.sev}`} data-entry-kind={en.kind} key={i}>
            <div className="kg-entry-type">
              {en.label} {SEV_GLYPH[en.sev]}
            </div>
            <div className="kgv-body">{fmtNarrative(en.body, byId)}</div>
            {/* 结构化引用（AD-16；纯信息展示不跳转——报告面裁决） */}
            {(en.refs.nodes.length > 0 || en.refs.symbols.length > 0) && (
              <div className="kg-rel-row" style={{ marginTop: 8 }}>
                {en.refs.nodes.map((n) => (
                  <span key={n.id} style={{ marginRight: 10 }}>
                    <NodeRef id={n.id} name={n.name} kind={n.kind} />
                  </span>
                ))}
                {en.refs.symbols.map((s, j) => (
                  <span key={j} style={{ marginRight: 10 }}>
                    <SymbolRef name={s.name} path={s.path} line={s.line} />
                  </span>
                ))}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
};

export default KgReportPane;
