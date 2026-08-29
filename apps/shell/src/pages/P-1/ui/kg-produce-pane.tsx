/**
 * P-1 bootstrap 产出呈现 pane（T3.2；R-13~R-16/R-18，CL-4 F4.1~F4.3）：
 * KgViewer 第三 tab。三级分组 任务（标题 + 任务详情链接）→ 阶段（layer 名 +
 * chip）→ 批次（scope + n 节点）；节点条目 = AD-4② 人类可读投影（粗体 name +
 * kind 徽章 + 状态徽章 正式知识/已废弃 + digest 首行单行截断；展开 = 正文 /
 * 锚点（符号名+路径:行号）/ 为什么存在 / 来源），nodeId 仅 data-id。
 *
 * 修正面（V-1：无 draft 无转正无审阅进度）：修改 = 内联编辑 digest+正文
 * 保存即 kg.node.update（保持 confirmed）；supersede = 理由必填（前端空
 * 理由拦截 + 后端双防线）确认后 kg.node.supersede 留史（条目降档 + 理由
 * 展示 + 动作按钮消失）；连带 = kg.bootstrap.impact 只读推导渲染「受影响
 * 待复核」warning 徽章 + toast 数量，只标记零自动写。
 *
 * 纯展示组件：命令发送与回执消费归 KgViewer 常驻 listener（单飞关联），
 * 本组件只回调；表单值（理由/编辑框）本地 state，内联面互斥由
 * project-model produce.inline 驱动（开一个清其余）。
 */
import { useState } from "react";
import type { KgProduceGroupDto, KgProduceNodeDto } from "@helix/protocol";
import { cn } from "@/shared/lib/cn";
import type { ProduceInline, ProduceState } from "../model/project-model";
import { ProduceSkeleton } from "./produce-skeleton";

type T = (key: string, vars?: Record<string, string | number>) => string;

/** digest 首行（收起单行截断；多行 digest 只显首行）。 */
function digestFirstLine(digest: string): string {
  return (digest.split("\n")[0] ?? digest).trim();
}

/** 单节点条目（收起摘要行 + 展开四段 + 内联修正面）。 */
function ProduceNode({
  node,
  open,
  affected,
  inline,
  writeBusy,
  t,
  onToggle,
  onInlineOpen,
  onInlineClose,
  onLaunchUpdate,
  onLaunchSupersede,
}: {
  node: KgProduceNodeDto;
  open: boolean;
  affected: boolean;
  inline: ProduceInline;
  writeBusy: boolean;
  t: T;
  onToggle: (nodeId: string) => void;
  onInlineOpen: (kind: "supersede" | "edit", nodeId: string) => void;
  onInlineClose: () => void;
  onLaunchUpdate: (nodeId: string, digest: string, body: string) => void;
  onLaunchSupersede: (nodeId: string, reason: string) => void;
}) {
  const superseded = node.status === "superseded";
  const thisInline = inline !== null && inline.nodeId === node.nodeId ? inline.kind : null;
  return (
    <div
      className={cn("kpn-node", open && "open", affected && "affected", superseded && "superseded")}
      data-produce-node
      data-id={node.nodeId}
      data-node-status={node.status}
      data-affected={affected ? "true" : undefined}
    >
      <div className="kpn-node-top">
        <b className="kpn-name">{node.name}</b>
        {/* kind 徽章：产出节点 kind 为超集透传（契约 §3），不套窄枚举文案面 */}
        <span className="hud-badge kpn-kind">{node.kind}</span>
        <span className={cn("hud-badge", superseded ? "st-superseded" : "st-confirmed")}>
          {t(superseded ? "pj.produce.stSuperseded" : "pj.produce.stConfirmed")}
        </span>
        {affected && <span className="kg-sev-badge warn kpn-aff">{t("pj.produce.affectedBadge")}</span>}
      </div>
      <div className="kpn-digest">{digestFirstLine(node.digest)}</div>
      {superseded ? (
        <div className="kpn-actions">
          <span className="kpn-meta">
            {t("pj.produce.supersededNote", { reason: node.supersedeReason ?? "" })}
          </span>
          <button type="button" className="kpn-toggle" data-act="toggle" onClick={() => onToggle(node.nodeId)}>
            {t(open ? "pj.produce.toggleClose" : "pj.produce.toggleOpen")}
          </button>
        </div>
      ) : (
        <div className="kpn-actions">
          <button
            type="button"
            className="hud-btn kg-btn-sm"
            data-act="edit"
            disabled={writeBusy}
            onClick={() => onInlineOpen("edit", node.nodeId)}
          >
            {t("pj.produce.edit")}
          </button>
          <button
            type="button"
            className="hud-btn hud-btn-danger kg-btn-sm"
            data-act="sup"
            disabled={writeBusy}
            onClick={() => onInlineOpen("supersede", node.nodeId)}
          >
            {t("pj.produce.sup")}
          </button>
          <button type="button" className="kpn-toggle" data-act="toggle" onClick={() => onToggle(node.nodeId)}>
            {t(open ? "pj.produce.toggleClose" : "pj.produce.toggleOpen")}
          </button>
        </div>
      )}
      {open && (
        <div className="kpn-detail">
          <div>
            <div className="kpn-sec-k">{t("pj.produce.secBody")}</div>
            <div className="kpn-sec-body">{node.body}</div>
          </div>
          <div>
            <div className="kpn-sec-k">{t("pj.produce.secAnchors")}</div>
            {node.anchors.length === 0 ? (
              <div className="kpn-sec-body muted">{t("pj.produce.anchorsEmpty")}</div>
            ) : (
              node.anchors.map((a) => (
                <div className="kpn-anchor" key={`${a.symbol}:${a.path}:${a.line ?? 0}`}>
                  <code>{a.symbol}</code>
                  <span className="kpn-anchor-path">
                    {a.path}
                    {a.line !== null ? `:${a.line}` : ""}
                  </span>
                </div>
              ))
            )}
          </div>
          <div>
            <div className="kpn-sec-k">{t("pj.produce.secWhy")}</div>
            <div className="kpn-sec-body muted">{node.rationale}</div>
          </div>
          <div className="kpn-meta">
            {t("pj.produce.originLine", { task: node.origin.taskTitle, batch: node.origin.batchScope })}
          </div>
        </div>
      )}
      {/* 内联修正面：独立于展开态（原型同构——开即见，不必先展开节点） */}
      {thisInline === "supersede" && (
        <SupersedeBox
          nodeId={node.nodeId}
          writeBusy={writeBusy}
          t={t}
          onCancel={onInlineClose}
          onConfirm={onLaunchSupersede}
        />
      )}
      {thisInline === "edit" && (
        <EditBox
          node={node}
          writeBusy={writeBusy}
          t={t}
          onCancel={onInlineClose}
          onSave={onLaunchUpdate}
        />
      )}
    </div>
  );
}

/** supersede 理由框（必填；空理由本地拦截——后端双防线）。 */
function SupersedeBox({
  nodeId,
  writeBusy,
  t,
  onCancel,
  onConfirm,
}: {
  nodeId: string;
  writeBusy: boolean;
  t: T;
  onCancel: () => void;
  onConfirm: (nodeId: string, reason: string) => void;
}) {
  const [reason, setReason] = useState("");
  const [touched, setTouched] = useState(false);
  const empty = reason.trim() === "";
  return (
    <div className="kpn-sup-box" data-sup-box data-id={nodeId}>
      <div className="kpn-sec-k">{t("pj.produce.supBoxTitle")}</div>
      <div className="kpn-form-row">
        <input
          className="hud-input"
          type="text"
          data-sup-reason
          placeholder={t("pj.produce.supPlaceholder")}
          value={reason}
          aria-invalid={touched && empty}
          onChange={(e) => {
            setReason(e.target.value);
            setTouched(true);
          }}
        />
        <button
          type="button"
          className="hud-btn hud-btn-danger kg-btn-sm"
          data-act="supYes"
          disabled={writeBusy}
          onClick={() => {
            if (empty) {
              setTouched(true);
              return;
            }
            onConfirm(nodeId, reason.trim());
          }}
        >
          {t("pj.produce.supConfirm")}
        </button>
        <button type="button" className="hud-btn kg-btn-sm" data-act="cancel" disabled={writeBusy} onClick={onCancel}>
          {t("pj.produce.cancel")}
        </button>
      </div>
      {touched && empty && <div className="kpn-form-err" data-sup-empty>{t("pj.produce.supEmptyReason")}</div>}
    </div>
  );
}

/** 修改编辑框（digest + 正文；保存即 kg.node.update，保持 confirmed）。 */
function EditBox({
  node,
  writeBusy,
  t,
  onCancel,
  onSave,
}: {
  node: KgProduceNodeDto;
  writeBusy: boolean;
  t: T;
  onCancel: () => void;
  onSave: (nodeId: string, digest: string, body: string) => void;
}) {
  const [digest, setDigest] = useState(node.digest);
  const [body, setBody] = useState(node.body);
  const bothEmpty = digest.trim() === "" && body.trim() === "";
  return (
    <div className="kpn-edit-box" data-edit-box data-id={node.nodeId}>
      <div className="kpn-sec-k">{t("pj.produce.editBoxTitle")}</div>
      <label className="kpn-form-label">
        <span>{t("pj.produce.editDigestLabel")}</span>
        <input className="hud-input" type="text" data-edit-digest value={digest} onChange={(e) => setDigest(e.target.value)} />
      </label>
      <label className="kpn-form-label">
        <span>{t("pj.produce.editBodyLabel")}</span>
        <textarea className="hud-input" rows={5} data-edit-body value={body} onChange={(e) => setBody(e.target.value)} />
      </label>
      <div className="kpn-form-row">
        <button
          type="button"
          className="hud-btn kg-btn-primary kg-btn-sm"
          data-act="editYes"
          disabled={writeBusy || bothEmpty}
          onClick={() => onSave(node.nodeId, digest.trim(), body.trim())}
        >
          {t("pj.produce.editSave")}
        </button>
        <button type="button" className="hud-btn kg-btn-sm" data-act="cancel" disabled={writeBusy} onClick={onCancel}>
          {t("pj.produce.cancel")}
        </button>
      </div>
    </div>
  );
}

/** 产出 pane 整体（view 三态互斥：loading / empty / success）。 */
export default function KgProducePane({
  produce,
  writeBusy,
  t,
  onOpenTasks,
  onToggle,
  onInlineOpen,
  onInlineClose,
  onLaunchUpdate,
  onLaunchSupersede,
}: {
  produce: ProduceState;
  /** kg.node.update / supersede 在途（动作钮禁用；单飞锁在 KgViewer）。 */
  writeBusy: boolean;
  t: T;
  onOpenTasks: () => void;
  onToggle: (nodeId: string) => void;
  onInlineOpen: (kind: "supersede" | "edit", nodeId: string) => void;
  onInlineClose: () => void;
  onLaunchUpdate: (nodeId: string, digest: string, body: string) => void;
  onLaunchSupersede: (nodeId: string, reason: string) => void;
}) {
  return (
    <div className="kpn-pane" data-produce-pane={produce.view}>
      {produce.view === "loading" && (
        <div className="kpn-loading">
          <ProduceSkeleton />
          <div className="kpn-loading-t">{t("pj.produce.loading")}</div>
        </div>
      )}
      {produce.view === "empty" && (
        <div className="kpn-empty">
          <div className="kpn-empty-t">{t("pj.produce.emptyTitle")}</div>
          <div className="kpn-empty-s">{t("pj.produce.emptySub")}</div>
        </div>
      )}
      {produce.view === "success" && (
        <>
          {produce.groups.map((g: KgProduceGroupDto) => (
            <section className="kpn-group" key={g.jobId} data-produce-group data-id={g.jobId}>
              <div className="kpn-group-head">
                <span className="kpn-group-title">{g.title}</span>
                <button type="button" className="kpn-link" data-goto-tasks onClick={onOpenTasks}>
                  {t("pj.produce.taskDetailLink")}
                </button>
              </div>
              <div className="kpn-note">{t("pj.produce.note")}</div>
              {g.stages.map((s) => (
                <div className="kpn-stage" key={`${g.jobId}:${s.layer}`} data-produce-stage data-layer={s.layer}>
                  <div className="kpn-stage-head">
                    <span className="kpn-stage-name">{s.name}</span>
                    <span className="hud-chip">{s.layer}</span>
                  </div>
                  {s.batches.map((b) => (
                    <div className="kpn-batch" key={b.batchId} data-produce-batch data-id={b.batchId}>
                      <div className="kpn-batch-head">
                        <span className="kpn-batch-name">{b.scope}</span>
                        <span className="hud-chip">{t("pj.produce.nodeCount", { n: b.nodes.length })}</span>
                      </div>
                      {b.nodes.map((n) => (
                        <ProduceNode
                          key={n.nodeId}
                          node={n}
                          open={produce.openNodes[n.nodeId] === true}
                          affected={produce.affected[n.nodeId] === true}
                          inline={produce.inline}
                          writeBusy={writeBusy}
                          t={t}
                          onToggle={onToggle}
                          onInlineOpen={onInlineOpen}
                          onInlineClose={onInlineClose}
                          onLaunchUpdate={onLaunchUpdate}
                          onLaunchSupersede={onLaunchSupersede}
                        />
                      ))}
                    </div>
                  ))}
                </div>
              ))}
            </section>
          ))}
        </>
      )}
    </div>
  );
}
