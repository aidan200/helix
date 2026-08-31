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
 * worktree 路径 → 主仓归一（D8 W-R2/W-R3 读穿透，零 IO 纯函数）。
 *
 * W-R1 落点口径：worktree 统一住 `<workspaceRoot>/.worktrees/{project}-{slug}`
 * ——worktree 内无 .codegraph/.helix-kg（绝不建副本索引/库），读面一律穿透
 * 主仓。本函数是唯一归一点：
 *
 * - 路径含 `/.worktrees/{project}-{slug}` 段 → 主仓等价路径——根形态
 *   `/ws/.worktrees/helix-foo` → `/ws/helix`（首个 `-` 前为 project，slug
 *   可含 `-`）；深层形态保留尾段（`/ws/.worktrees/helix-foo/a/b.ts` →
 *   `/ws/helix/a/b.ts`，附着/文件语义消费）；尾斜杠归一去尾。
 * - 不含该段 / 目录名不合 {project}-{slug} 契约（无 `-`、`-` 打头、空名）/
 *   `.worktrees` 直结尾 → 原样返回（逐字节不变——非 worktree 场景零影响）。
 * - 多段嵌套取首个 `/.worktrees/`（外层 worktree 管辖）。
 */
export function resolveMainRepoPath(input: string): string {
  const marker = "/.worktrees/";
  const idx = input.indexOf(marker);
  if (idx < 0) return input;
  const before = input.slice(0, idx); // idx=0（/.worktrees 紧贴根）→ ""，模板拼出 /{project}
  const tail = input.slice(idx + marker.length);
  const stripped = tail.endsWith("/") && tail.length > 1 ? tail.slice(0, -1) : tail;
  const segments = stripped.split("/");
  const dir = segments[0] ?? "";
  const dash = dir.indexOf("-");
  if (dir === "" || dash <= 0) return input; // 不合 {project}-{slug} 契约 → 不归一
  const project = dir.slice(0, dash);
  const rest = segments.slice(1).join("/");
  return rest === "" ? `${before}/${project}` : `${before}/${project}/${rest}`;
}
