/**
 * workspace 项目发现与解析纯逻辑（§3.5，F5.0，T5.3 收口单点）。
 *
 * v1 教训（explorer boundary finding）：workspace→projectRoot 解析
 * `isAbsolute ? x : join(workspaceRoot, x)` 在 gate.ts / project-docs.ts
 * 等多处重复。v2 收口：**排除清单 + 宽松口径过滤 + project 参数解析**
 * 全部收束本文件（domain 纯逻辑，零 IO——目录枚举归调用方注入），
 * handlers/service 层禁自带 join 解析（TR-AD-6 路径单点）。
 *
 * 宽松口径（V-3 用户裁决）：workspace 一级目录**全部入列**，排除清单为
 * 唯一过滤，不做目录资格甄别——未建索引目录以 status=absent 出现在项目
 * 列表（B1 冷启动入口）。零写路径。
 */

/** §3.5 排除清单（非项目目录；唯一过滤口径，禁散落第二份）。 */
export const WORKSPACE_EXCLUDED: ReadonlySet<string> = new Set([
  "docs",
  ".helix",
  ".worktrees",
  "node_modules",
]);

/**
 * 一级目录入列判定（宽松口径 V-3）：目录项、非隐藏、非排除段。
 * （文件项甄别由调用方以 Dirent.isDirectory 前置——纯函数只判名字。）
 */
export function isWorkspaceProjectDir(name: string): boolean {
  return !name.startsWith(".") && !WORKSPACE_EXCLUDED.has(name);
}

/** 扫描产物行（IO 侧 readdirSync 投影；name=一级目录名，path=绝对路径）。 */
export interface ProjectDirEntry {
  readonly name: string;
  readonly path: string;
}

/**
 * project 参数单点解析：项目名（workspace 一级目录名）或绝对路径 →
 * projectRoot；不在扫描全集内 → undefined（调用方回 KG_E_PARAM）。
 * 绝对路径直用、名称按扫描产物映射——本函数零 join（路径拼接归 IO 侧）。
 */
export function resolveProjectArg(entries: readonly ProjectDirEntry[], project: string): string | undefined {
  const trimmed = project.trim();
  if (trimmed === "") return undefined;
  for (const entry of entries) {
    if (entry.name === trimmed || entry.path === trimmed) return entry.path;
  }
  return undefined;
}

/**
 * 绝对路径 → workspace 一级项目目录名（U0a projectFootprint 消费口——
 * 纯字符串，零 node:path：分隔符归一 + 前缀判定 + 排除集过滤）。
 * 返回 undefined = 根外/隐藏段/排除段（不属任何项目域）。
 * 与 workspace-scan.projectRootOfPath 同口径——后者是本函数的 IO 薄壳
 * （path.join 形态保持），新增消费面一律用本函数（application 层可 import）。
 */
export function projectRootOfAbs(workspaceRoot: string, absPath: string): string | undefined {
  const norm = (p: string) => p.replaceAll("\\", "/").replace(/\/+$/, "");
  const root = norm(workspaceRoot);
  const p = norm(absPath);
  if (root === "" || !p.startsWith(`${root}/`)) return undefined;
  const rel = p.slice(root.length + 1);
  const first = rel.split("/")[0] ?? "";
  if (first === "" || first.startsWith(".") || WORKSPACE_EXCLUDED.has(first)) return undefined;
  return first;
}

/**
 * worktree 路径 → 主仓归一（D8 W-R2/W-R3 读穿透，零 IO 纯函数）。
 *
 * W-R1 落点口径（权威 = GitWorktreeProvisioner 头注）：仓根
 * `.worktrees/<slug>`——生产 isolated worktree 形如
 * `<ws>/<project>/.worktrees/agent-<hex>`，归一目标 = 拥有它的 git 仓根。
 * 本函数是唯一归一点：
 *
 * - 路径含 `/.worktrees/<slug>` 段 → 剥该段回仓根（尾段保留：
 *   `/ws/helix/.worktrees/agent-x/a/b.ts` → `/ws/helix/a/b.ts`，附着/
 *   文件语义消费）；尾斜杠归一去尾；目录名任意形态（slug 可含 `-`）。
 * - 不含该段 / `.worktrees` 直结尾（无目录名）→ 原样返回（逐字节不变
 *   ——非 worktree 场景零影响）。
 * - 多段嵌套取首个 `/.worktrees/`（外层 worktree 管辖）。
 * - 历史 workspace 级目录名（`{project}-{slug}` 形态遗留，provisioner
 *   从未落过的幻影口径）不再拆 project 前缀——按仓内形态剥整段归一
 *   为段前路径（消 `<仓根>/agent` 幻影路径，code-review H1：三读通道
 *   ——kgReadProjects 穿透/CodegraphTool 索引路由/附着锚命中——曾全静默失效）。
 * - win32 原生路径（TR-95 目标平台集含 win32-x64）：调用方传 path.join
 *   反斜杠路径时先归一 POSIX 分隔符再判定——命中 worktree 段的归一输出
 *   统一 POSIX 形态；不命中（非 worktree）原样返回逐字节不变（含分隔符）。
 */
export function resolveMainRepoPath(input: string): string {
  const normalized = input.replaceAll("\\", "/");
  const marker = "/.worktrees/";
  const idx = normalized.indexOf(marker);
  if (idx < 0) return input;
  const before = normalized.slice(0, idx); // idx=0（/.worktrees 紧贴根）→ ""，仓根 = /
  const tail = normalized.slice(idx + marker.length);
  const stripped = tail.endsWith("/") && tail.length > 1 ? tail.slice(0, -1) : tail;
  const segments = stripped.split("/");
  if ((segments[0] ?? "") === "") return input; // .worktrees 直结尾（无 worktree 目录名）→ 不归一
  const rest = segments.slice(1).join("/");
  const root = before === "" ? "/" : before;
  if (rest === "") return root;
  return root === "/" ? `/${rest}` : `${root}/${rest}`;
}
