/**
 * kg-node md 块解析器（v2 重写，T5.2 迁移专用）。
 *
 * v1 参考资产（AD-1）：PI-SRC helix/src/tools/kg/core/parser/kg-node.ts ——
 * 语义全集（fenced 块边界 / frontmatter / relations 强边 / references 弱边
 * 机械提取 / anchors·derivedFrom 属性化 / ownedProse 边界）按 v1 语义重写；
 * **不扩展弱边前缀集**（仅 SPEC|E 提及产 references 边，TR-* 提及不产边——
 * 迁移忠实性优先，语义增强归日常落账，T5.2 brief 显式决定）。
 *
 * 与 v1 的差异（迁移场景刻意收窄）：
 * - frontmatter 子集手写解析（扁平标量 + 三种嵌套形态：relations 动词→清单
 *   / anchors implementedBy·testedBy→清单 / derivedFrom 清单）；零新依赖。
 * - v1 收集 malformed 进 unresolved 继续解析；迁移面**fail-fast**——任何
 *   解析问题进 issues，dry-run 判失败（R-4 对账不过不切换）。
 * - docPath/docAnchor 指针不解析（v2 SoT 为 db，无 md 指针面）。
 *
 * 纯逻辑零 IO；scripts/oneoff 一次性管道，不入 daemon 运行时分层（TR-AD-1）。
 */

/** v1 生命周期 → v2 建库态映射（proposed→draft；active→confirmed）。 */
export const V1_STATUS_TO_V2: Record<string, "draft" | "confirmed"> = {
  proposed: "draft",
  active: "confirmed",
};

/** v1 边封闭词表（7 词表继承，types.EDGE_VERBS 同源；独立声明避免引入 daemon 分层依赖）。 */
const EDGE_KINDS = new Set([
  "supersedes",
  "changed",
  "dependsOn",
  "partOf",
  "governs",
  "affects",
  "references",
]);

const NODE_KINDS = new Set(["rule", "entity"]);
const NODE_GRAPHS = new Set(["tech", "business"]);
const NODE_LAYERS = new Set(["arch", "convention", "common"]);
const V1_STATUSES = new Set(["proposed", "active", "deprecated", "archived"]);

/** v1 弱边正则原样（A-1.2/REQ-CL-3.10）：仅 SPEC|E 前缀提及产 references 边。 */
const NODE_ID_MENTION_RE = /(?:^|[^A-Za-z0-9_])(SPEC|E)-([A-Za-z0-9_\u4e00-\u9fff-]+)/g;
/** fenced 代码块剥离（避免代码内 id 串误命中，v1 同源）。 */
const FENCE_RE = /```[\s\S]*?```/g;

export interface ParsedKgNode {
  readonly id: string;
  readonly kind: "rule" | "entity";
  readonly graph: "tech" | "business";
  /** v1 layer 原样提取（arch/convention/common；非 tech 域为 ""）——对账用，映射时弃置。 */
  readonly layer: string;
  readonly name: string;
  /** v1 status 原样（proposed/active/...）——映射时查 V1_STATUS_TO_V2。 */
  readonly status: string;
  readonly digest: string;
  /** 块后所属正文（块尾→下一块头），两端 trim。 */
  readonly body: string;
  readonly anchors: { readonly implementedBy: readonly string[]; readonly testedBy: readonly string[] };
  /** relations 声明边（强边）+ references 弱边（v1 机械提取），按文件内出现序。 */
  readonly edges: readonly { readonly verb: string; readonly target: string }[];
  readonly derivedFrom: readonly string[];
  readonly docPath: string;
}

export interface ParseIssue {
  readonly docPath: string;
  readonly line: number;
  readonly message: string;
}

export interface KgMdParseResult {
  readonly nodes: readonly ParsedKgNode[];
  readonly issues: readonly ParseIssue[];
}

const BLOCK_RE = /```kg-node[ \t]*\r?\n([\s\S]*?)```/g;

/** 解析多文件 kg-node 块（id 全局查重——迁移目标是 db 主键空间）。 */
export function parseKgMdFiles(files: readonly { docPath: string; markdown: string }[]): KgMdParseResult {
  const nodes: ParsedKgNode[] = [];
  const issues: ParseIssue[] = [];
  const seenIds = new Set<string>();

  for (const { docPath, markdown } of files) {
    const blocks = [...markdown.matchAll(BLOCK_RE)];
    /** 逐块中间态：解析成功的节点 + 所属正文（弱边提取输入）。 */
    const parsed: { node: ParsedKgNode; ownedProse: string }[] = [];
    /** 本文件强边+已声明 references 对（无序键，弱边去重输入，v1 同源）。 */
    const strongPairs = new Set<string>();
    const refPairs = new Set<string>();

    for (let bi = 0; bi < blocks.length; bi += 1) {
      const match = blocks[bi]!;
      const body = match[1]!;
      const line = 1 + countNewlines(markdown, match.index ?? 0);
      const issue = (message: string): void => {
        issues.push({ docPath, line, message });
      };
      const fm = parseFrontmatter(body, issue);
      if (fm === null) continue;

      // ── 校验（v1 全集，fail-fast 化） ──
      const id = fm.scalars.id ?? "";
      if (id === "") {
        issue("missing id");
        continue;
      }
      if (seenIds.has(id)) {
        issue(`duplicate id: ${id}（跨文档全局查重——迁移目标是 db 主键空间）`);
        continue;
      }
      const kind = fm.scalars.kind ?? "";
      if (!NODE_KINDS.has(kind)) {
        issue(`illegal kind: ${kind || "(missing)"}`);
        continue;
      }
      const graph = fm.scalars.graph ?? "";
      if (!NODE_GRAPHS.has(graph)) {
        issue(`missing or illegal graph: ${graph || "(missing)"}`);
        continue;
      }
      if (kind === "entity" && graph !== "business") {
        issue(`kind "entity" not allowed for graph "${graph}"（v1 规约：entity 仅 business 域）`);
        continue;
      }
      let layer = "";
      if (graph === "tech") {
        layer = fm.scalars.layer ?? "";
        if (!NODE_LAYERS.has(layer)) {
          issue(`tech graph requires valid layer (arch|convention|common): ${layer || "(missing)"}`);
          continue;
        }
      } else if (fm.scalars.layer !== undefined) {
        issue(`non-tech graph must not declare layer: ${fm.scalars.layer}`);
        continue;
      }
      const status = fm.scalars.status ?? "";
      if (!V1_STATUSES.has(status)) {
        issue(`illegal status: ${status || "(missing)"}`);
        continue;
      }
      if (!(status in V1_STATUS_TO_V2)) {
        issue(`status ${status} 无 v2 建库态映射（建库仅 draft/confirmed；终态节点请人工裁决后修订源文档）`);
        continue;
      }
      const digest = (fm.scalars.digest ?? "").trim();
      if (digest === "") {
        issue("digest is empty");
        continue;
      }
      if (digest.split("\n").filter((l) => l.trim() !== "").length > 2) {
        issue("digest exceeds 2 lines");
        continue;
      }

      // ── relations 强边（verb 词表核对） ──
      const edges: { verb: string; target: string }[] = [];
      for (const [relPath, targets] of fm.relations) {
        const verb = relPath.split(".")[1] ?? "";
        if (!EDGE_KINDS.has(verb)) {
          issue(`illegal relations verb: ${verb}（7 词封闭词表外）`);
          continue;
        }
        for (const target of targets) {
          edges.push({ verb, target });
          if (verb !== "references") strongPairs.add(pairKey(id, target));
          else refPairs.add(pairKey(id, target));
        }
      }

      seenIds.add(id);
      const blockEnd = (match.index ?? 0) + match[0].length;
      const proseEnd = bi + 1 < blocks.length ? (blocks[bi + 1]!.index ?? blockEnd) : markdown.length;
      const ownedProse = markdown.slice(blockEnd, proseEnd);
      const node: ParsedKgNode = {
        id,
        kind: kind as ParsedKgNode["kind"],
        graph: graph as ParsedKgNode["graph"],
        layer,
        name: fm.scalars.name?.trim() !== "" && fm.scalars.name !== undefined ? fm.scalars.name : id,
        status,
        digest,
        body: ownedProse.trim(),
        anchors: {
          implementedBy: fm.anchors.get("anchors.implementedBy") ?? [],
          testedBy: fm.anchors.get("anchors.testedBy") ?? [],
        },
        edges,
        derivedFrom: fm.lists.get("derivedFrom") ?? [],
        docPath,
      };
      parsed.push({ node, ownedProse });
    }

    // references 弱边机械提取（v1 同源：剥 fence → 提及 → 与强边/已声明 references 去重）
    const weakEdges = extractReferences(parsed, strongPairs, refPairs);
    for (const draft of parsed) {
      nodes.push({ ...draft.node, edges: [...draft.node.edges, ...(weakEdges.get(draft.node.id) ?? [])] });
    }
  }

  return { nodes, issues };
}

// ── frontmatter 子集解析（扁平标量 + relations/anchors/derivedFrom 三形态） ──

interface Frontmatter {
  readonly scalars: Record<string, string>;
  /** 嵌套键路径（如 relations.governs / anchors.implementedBy）→ 清单。 */
  readonly lists: Map<string, string[]>;
  readonly relations: ReadonlyArray<readonly [string, readonly string[]]>;
  readonly anchors: ReadonlyMap<string, readonly string[]>;
}

function parseFrontmatter(body: string, issue: (message: string) => void): Frontmatter | null {
  const scalars: Record<string, string> = {};
  const lists = new Map<string, string[]>();
  let currentPath: string | null = null;
  let lastListPath: string | null = null;

  for (const rawLine of body.split("\n")) {
    const line = rawLine.replace(/\r$/, "");
    if (line.trim() === "") continue;
    const itemMatch = /^(\s*)-\s?(.*)$/.exec(line);
    if (itemMatch !== null) {
      const value = unquote(itemMatch[2]!.trim());
      if (value === "") continue;
      if (currentPath === null) {
        issue(`游离清单项（无所属键）: ${line.trim()}`);
        continue;
      }
      const list = lists.get(currentPath);
      if (list === undefined) lists.set(currentPath, [value]);
      else list.push(value);
      lastListPath = currentPath;
      continue;
    }
    const keyMatch = /^(\s*)([A-Za-z_][\w-]*):\s*(.*)$/.exec(line);
    if (keyMatch === null) {
      // YAML 多行 plain scalar 折行：非键非清单项的缩进续行折入上一清单项（空格连接）
      const fold = lists.get(lastListPath ?? "");
      if (lastListPath !== null && fold !== undefined && fold.length > 0) {
        fold[fold.length - 1] = `${fold[fold.length - 1]!} ${line.trim()}`;
        continue;
      }
      issue(`无法解析的 frontmatter 行: ${line.trim()}`);
      continue;
    }
    const indent = keyMatch[1]!.length;
    const key = keyMatch[2]!;
    const value = unquote(keyMatch[3]!.trim());
    if (indent === 0) {
      if (value !== "") scalars[key] = value;
      currentPath = key;
    } else {
      // 子键（relations 动词 / anchors implementedBy·testedBy）：挂当前顶层键下
      const topKey: string = listsTopKey(currentPath) ?? currentPath ?? key;
      currentPath = `${topKey}.${key}`;
      if (value !== "") lists.set(currentPath, [value]);
    }
    lastListPath = null;
  }

  const relations: Array<readonly [string, readonly string[]]> = [];
  const anchors = new Map<string, readonly string[]>();
  for (const [listPath, items] of lists) {
    if (listPath.startsWith("relations.")) relations.push([listPath, items]);
    else if (listPath.startsWith("anchors.")) anchors.set(listPath, items);
  }
  return { scalars, lists, relations, anchors };
}

/** 嵌套子键归属的顶层键（relations.governs → relations）；顶层键自身 → null。 */
function listsTopKey(path: string | null): string | null {
  if (path === null) return null;
  const dot = path.indexOf(".");
  return dot === -1 ? null : path.slice(0, dot);
}

function unquote(value: string): string {
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) return value.slice(1, -1);
  return value;
}

// ── references 弱边（v1 语义原样） ───────────────────────────

function extractReferences(
  parsed: readonly { node: ParsedKgNode; ownedProse: string }[],
  strongPairs: Set<string>,
  refPairs: Set<string>,
): Map<string, { verb: string; target: string }[]> {
  const out = new Map<string, { verb: string; target: string }[]>();
  for (const { node, ownedProse } of parsed) {
    const prose = ownedProse.replace(FENCE_RE, " ");
    const seen = new Set<string>();
    for (const m of prose.matchAll(NODE_ID_MENTION_RE)) {
      const target = `${m[1]}-${m[2]}`;
      if (target === node.id) continue; // 不自引用
      const key = pairKey(node.id, target);
      if (strongPairs.has(key) || refPairs.has(key) || seen.has(key)) continue;
      seen.add(key);
      refPairs.add(key);
      const list = out.get(node.id);
      const edge = { verb: "references", target };
      if (list === undefined) out.set(node.id, [edge]);
      else list.push(edge);
    }
  }
  return out;
}

/** 无序节点对键（(a,b) 与 (b,a) 同键，v1 同源）。 */
function pairKey(a: string, b: string): string {
  return a < b ? `${a}\u0000${b}` : `${b}\u0000${a}`;
}

function countNewlines(text: string, end: number): number {
  let count = 0;
  for (let i = 0; i < end; i += 1) {
    if (text.charCodeAt(i) === 10) count++;
  }
  return count;
}
