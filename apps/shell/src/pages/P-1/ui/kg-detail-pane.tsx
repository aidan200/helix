/**
 * F5.2 节点详情六段（头卡+描述/规则/锚点/关系/supersede 链/变更日志）
 * + F5.4 draft 转正（状态门控：仅 draft 渲染按钮；两步内联确认条；
 *   确认走 kg.node.confirm = 页面唯一写入口）。
 *
 * AD-16：锚点行 = 等宽符号 + 路径:行号（dead=⚠ 失效 / stale=? 长期无命中）；
 * 关系行 = 边词 + 粗体『name』+kind 徽章（data-goto 可跳转）；id 永不
 * 作为可见文本。叙述文本（desc/rules）经 fmtNarrative 做 `code` 与节点
 * 引用替换。
 */
import { useState } from "react";
import type { KgNodeDetailDto, KgNodeListRow } from "@helix/protocol";
import { useI18n } from "@/shared/i18n";
import { fmtNarrative, KindBadge, NodeRef, StatusBadge } from "./kg-refs";

/** 变更日志日期（ISO → YYYY-MM-DD；非法原样）。 */
function fmtDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const p2 = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
}

function DetailSkeleton() {
  return (
    <div className="kg-skel-card">
      <div className="kg-skel-line" style={{ width: "38%" }} />
      <div className="kg-skel-line" style={{ width: "82%" }} />
      <div className="kg-skel-line" style={{ width: "64%" }} />
      <div className="kg-skel-line" style={{ width: "74%" }} />
      <div className="kg-skel-line" style={{ width: "44%" }} />
    </div>
  );
}

/** F5.2 锚点行（state: ok / dead=⚠ / stale=?）。 */
function AnchorRow({
  anchor,
  t,
}: {
  anchor: KgNodeDetailDto["anchors"][number];
  t: ReturnType<typeof useI18n>["t"];
}) {
  const flag =
    anchor.state === "dead" ? (
      <span className="kg-anchor-flag dead">{t("pj.kg.anchorDead")}</span>
    ) : anchor.state === "stale" ? (
      <span className="kg-anchor-flag stale">{t("pj.kg.anchorStale")}</span>
    ) : null;
  return (
    <div className="kg-anchor" data-anchor-state={anchor.state}>
      {anchor.symbol !== undefined ? (
        <code>{anchor.symbol}</code>
      ) : (
        <code className="kg-anchor-path">{t("pj.kg.anchorPathOnly")}</code>
      )}
      <span className="kg-anchor-path">
        {anchor.path}
        {anchor.line !== undefined ? `:${anchor.line}` : ""}
      </span>
      {flag}
    </div>
  );
}

/** F5.2 supersede 链（历史↓现行；current=本节点时标注现行）。 */
function SupersedeChain({
  detail,
  onGoto,
  t,
}: {
  detail: KgNodeDetailDto;
  onGoto: (id: string) => void;
  t: ReturnType<typeof useI18n>["t"];
}) {
  const selfOnly = detail.supersede.history.length === 0 && detail.supersede.current.id === detail.id;
  if (selfOnly) {
    return <div className="kgv-sec-item">{t("pj.kg.chainSelfOnly")}</div>;
  }
  return (
    <div className="kg-chain">
      {detail.supersede.history.map((n) => (
        <div className="kg-chain-item" key={n.id}>
          <KindBadge kind={n.kind} />
          <b className="kg-nref" data-goto={n.id} onClick={() => onGoto(n.id)}>
            『{n.name}』
          </b>
          <span className="kg-chain-meta">{t("pj.kg.chainHistory")}</span>
        </div>
      ))}
      <div className="kg-chain-gap">{t("pj.kg.chainGap")}</div>
      {/* 现行位恒标 cur（无论当前查看的是历史节点还是现行本体——现行即高亮） */}
      <div className="kg-chain-item cur">
        <KindBadge kind={detail.supersede.current.kind} />
        {detail.supersede.current.id === detail.id ? (
          <b>{detail.name}</b>
        ) : (
          <b className="kg-nref" data-goto={detail.supersede.current.id} onClick={() => onGoto(detail.supersede.current.id)}>
            『{detail.supersede.current.name}』
          </b>
        )}
        <span className="kg-chain-meta">{t("pj.kg.chainCurrent")}</span>
      </div>
    </div>
  );
}

const KgDetailPane = function KgDetailPane({
  detail,
  loading,
  byId,
  onGoto,
  onConfirm,
}: {
  detail: KgNodeDetailDto | null;
  loading: boolean;
  byId: ReadonlyMap<string, KgNodeListRow>;
  onGoto: (id: string) => void;
  onConfirm: (id: string) => void;
}) {
  const { t } = useI18n();
  const [confirmOpen, setConfirmOpen] = useState(false);

  if (loading || detail === null)
    return (
      <div data-kg-detail>
        <DetailSkeleton />
      </div>
    );

  const isDraft = detail.status === "draft";

  return (
    <div data-kg-detail>
      <div className="kgv-detail-head">
        <div className="kgv-dh-top">
          <span className="kgv-dh-name">{detail.name}</span>
          <KindBadge kind={detail.kind} />
          <StatusBadge status={detail.status} />
          {detail.domain !== null && (
            <span className="hud-chip">{detail.domain === "business" ? t("pj.kg.domainChipBusiness") : t("pj.kg.domainChipTech")}</span>
          )}
          {/* F5.4 状态门控：仅 draft 渲染（非草稿静默不渲染，非置灰） */}
          {isDraft && (
            <span className="kgv-dh-actions">
              <button
                type="button"
                className="hud-btn kg-btn-primary"
                data-kg-promote
                onClick={() => setConfirmOpen(true)}
              >
                {t("pj.kg.promote")}
              </button>
            </span>
          )}
        </div>
        <div className="kgv-dh-digest">{detail.digest}</div>
        {/* F5.4 两步确认（内联确认条：warning 边框 + 确认/取消） */}
        {isDraft && confirmOpen && (
          <div className="kgv-confirm-box" data-kg-confirm-box>
            <div className="kgv-confirm-text">
              {t("pj.kg.confirmText", { name: detail.name })}
            </div>
            <div className="kgv-confirm-btns">
              <button
                type="button"
                className="hud-btn kg-btn-primary kg-btn-sm"
                data-kg-promote-yes
                onClick={() => {
                  setConfirmOpen(false);
                  onConfirm(detail.id);
                }}
              >
                {t("pj.kg.confirmYes")}
              </button>
              <button
                type="button"
                className="hud-btn hud-btn-ghost kg-btn-sm"
                data-kg-promote-no
                onClick={() => setConfirmOpen(false)}
              >
                {t("pj.kg.confirmNo")}
              </button>
            </div>
          </div>
        )}
      </div>

      <div className="kgv-sec">
        <div className="kgv-sec-h">{t("pj.kg.secDesc")}</div>
        <div className="kgv-sec-body">{detail.desc}</div>
      </div>
      <div className="kgv-sec">
        <div className="kgv-sec-h">{t("pj.kg.secRules")}</div>
        <div className="kgv-sec-list">
          {detail.rules.map((r, i) => (
            <div className="kgv-sec-item" key={i}>
              {fmtNarrative(r, byId, onGoto)}
            </div>
          ))}
        </div>
      </div>
      <div className="kgv-sec">
        <div className="kgv-sec-h">{t("pj.kg.secAnchors")}</div>
        {detail.anchors.length === 0 ? (
          <div className="kgv-sec-item">{t("pj.kg.anchorsEmpty")}</div>
        ) : (
          detail.anchors.map((a, i) => <AnchorRow anchor={a} key={i} t={t} />)
        )}
      </div>
      <div className="kgv-sec">
        <div className="kgv-sec-h">{t("pj.kg.secRelations")}</div>
        {detail.relations.length === 0 ? (
          <div className="kgv-sec-item">{t("pj.kg.relationsEmpty")}</div>
        ) : (
          detail.relations.map((r, i) => (
            <div className="kg-rel-row" key={i}>
              <span className="kg-rel-t">{r.verb}</span> →{" "}
              <NodeRef id={r.peer.id} name={r.peer.name} kind={r.peer.kind} onGoto={onGoto} />
            </div>
          ))
        )}
      </div>
      <div className="kgv-sec">
        <div className="kgv-sec-h">{t("pj.kg.secSupersede")}</div>
        <SupersedeChain detail={detail} onGoto={onGoto} t={t} />
      </div>
      <div className="kgv-sec">
        <div className="kgv-sec-h">{t("pj.kg.secLog")}</div>
        {detail.log.map((l, i) => (
          <div className="kg-log-row" key={i}>
            <span className="kg-log-d">{fmtDate(l.date)}</span>
            <span className="kg-log-it">{l.iterationId}</span>
            <span className="kg-log-t">{l.eventText}</span>
          </div>
        ))}
      </div>
    </div>
  );
};

export default KgDetailPane;
