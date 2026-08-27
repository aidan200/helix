/**
 * P-1 kg 引用/徽章渲染件（AD-16 人类面规范；F5.1~F5.3 共用）。
 *
 * AD-16 三铁律（review.md 设计说明）：
 * - 节点引用 = 粗体『name』+ kind 徽章（rule=cyan / entity=violet），
 *   id 只存在于 data-goto/data-id 属性，永不作为可见文本；
 * - 代码符号 = 等宽 code 样式 + 路径:行号；
 * - 叙述文本中的 `{{id}}` 标记与可解析的裸 TR-n/E-n 一律替换为节点引用
 * （解析来源 = 当前项目全量节点表；不可解析 token 原样保留——daemon
 *   数据层 AD-16 纪律是 SoT，前端不造名）。
 *
 * 文案走 i18n（AG-16 前端半）；『』包裹形态保留（引用视觉锚，跨语言同形）。
 */
import type { ReactNode } from "react";
import type { KgNodeKindDto, KgNodeListRow, KgNodeStatusDto } from "@helix/protocol";
import { useI18n } from "@/shared/i18n";

export function useKindText(): (kind: KgNodeKindDto) => string {
  const { t } = useI18n();
  return (kind) => (kind === "rule" ? t("pj.kg.kindRule") : t("pj.kg.kindEntity"));
}

export function useStatusText(): (status: KgNodeStatusDto) => string {
  const { t } = useI18n();
  return (status) =>
    status === "confirmed" ? t("pj.kg.stConfirmed") : status === "draft" ? t("pj.kg.stDraft") : t("pj.kg.stSuperseded");
}

export function KindBadge({ kind }: { kind: KgNodeKindDto }) {
  const kindText = useKindText();
  return <span className={`hud-badge kind-${kind}`}>{kindText(kind)}</span>;
}

export function StatusBadge({ status }: { status: KgNodeStatusDto }) {
  const statusText = useStatusText();
  return <span className={`hud-badge st-${status}`}>{statusText(status)}</span>;
}

/** 知识引用（可跳转；id 仅 data-goto 属性承载——AD-16）。 */
export function NodeRef({
  id,
  name,
  kind,
  onGoto,
}: {
  id: string;
  name: string;
  kind: KgNodeKindDto;
  onGoto: (id: string) => void;
}) {
  return (
    <>
      <b className="kg-nref" data-goto={id} onClick={() => onGoto(id)}>
        『{name}』
      </b>
      <KindBadge kind={kind} />
    </>
  );
}

/** code 符号渲染（等宽；符号名与 path:line 拆分——AD-16）。 */
export function SymbolRef({ name, path, line }: { name: string; path?: string; line?: number }) {
  return (
    <>
      <code>{name}</code>
      {path !== undefined && (
        <span className="kg-anchor-path">
          {path}
          {line !== undefined ? `:${line}` : ""}
        </span>
      )}
    </>
  );
}

/** 叙述文本格式化：`code` span + `{{id}}` 标记 + 可解析裸 id → 节点引用。 */
export function fmtNarrative(
  text: string,
  byId: ReadonlyMap<string, KgNodeListRow>,
  onGoto: (id: string) => void,
): ReactNode[] {
  // `code` 先切分；片段内再做 id 替换（code 内不替换）
  const codeSplit = text.split(/`([^`]+)`/g);
  return codeSplit.map((chunk, i) => {
    if (i % 2 === 1) return <code key={i}>{chunk}</code>;
    return <span key={i}>{splitRefs(chunk, byId, onGoto)}</span>;
  });
}

/** id 替换切分：{{TR-n}} 标记与裸 TR-n/E-n（可解析时）。 */
function splitRefs(
  text: string,
  byId: ReadonlyMap<string, KgNodeListRow>,
  onGoto: (id: string) => void,
): ReactNode[] {
  const re = /\{\{((?:TR|E)-\d+)\}\}|((?:TR|E)-\d+)/g;
  const out: ReactNode[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  let key = 0;
  while ((m = re.exec(text)) !== null) {
    const id: string = m[1] ?? m[2] ?? "";
    const node = byId.get(id);
    if (node === undefined) continue; // 不可解析：原样保留（daemon 数据层纪律兜底）
    if (m.index > last) out.push(text.slice(last, m.index));
    out.push(
      <NodeRef key={`r${key++}`} id={node.id} name={node.name} kind={node.kind} onGoto={onGoto} />,
    );
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

/** 搜索命中高亮（--search 橙 mark；q 为空原样返回）。 */
export function highlight(text: string, q: string): ReactNode {
  if (q === "") return text;
  const escaped = q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`(${escaped})`, "ig");
  const parts = text.split(re);
  return parts.map((p, i) =>
    p.toLowerCase() === q.toLowerCase() ? <mark key={i}>{p}</mark> : <span key={i}>{p}</span>,
  );
}
