import { existsSync, readFileSync, readdirSync, watch, type FSWatcher } from "node:fs";
import path from "node:path";
import { globToRegExp } from "../../../domain/kg/anchor-materialize";

/**
 * FsWatchAdapter —— 单流 watch 兜底适配器（F-21 模式照抄，architecture.md
 * §3.2/§3.4；外部编辑/删/改名的第二信号源，与自写工具写后通知双源汇队列）。
 *
 * - macOS/Win：一条递归 `fs.watch(root,{recursive:true})` O(1)；
 * - Linux：每目录 watch + 动态补挂（新目录 rename 事件）+ 总量帽
 *   （超帽不再补挂——防大仓库 fd 耗尽）；Node 内建零依赖；
 * - ignore 清单前置过滤：内置 [node_modules,.git,dist,.worktrees] + 隐藏
 *   项 + 顶层 .gitignore 简单模式（非注释/非否定 glob，相对 root）；
 * - 事件回调只做过滤+归一+入队内存操作（sync 成本被 KgSyncService 去抖
 *   吸收）：rename → exists 判 write/remove；change → write。
 *
 * kind 归一与 ignore 过滤抽为纯函数（resolveWatchEvent/shouldIgnorePath，
 * I 层注入事件源覆盖全部行为；真实 fs.watch 仅环境冒烟）。
 */

/** 内置 ignore 名单（路径任一段命中即忽略；架构 F-21 清单）。 */
export const BUILTIN_IGNORE_SEGMENTS = new Set(["node_modules", ".git", "dist", ".worktrees"]);

/** Linux 每目录挂载总量帽（默认值；防 fd 耗尽的结构参数）。 */
export const DEFAULT_MAX_WATCHED_DIRS = 4096;

export interface FsWatchEvent {
  /** 绝对路径（相对 root 拼接产物）。 */
  readonly absPath: string;
  /** write=存在类变更（含新建/改名落点）；remove=消失（删除/改名离开）。 */
  readonly kind: "write" | "remove";
}

export interface FsWatchAdapterOptions {
  readonly root: string;
  readonly onEvent: (event: FsWatchEvent) => void;
  /** Linux 每目录挂载总量帽（缺省 DEFAULT_MAX_WATCHED_DIRS）。 */
  readonly maxWatchedDirs?: number;
  /** 平台注入（缺省 process.platform；测试切 linux 分支）。 */
  readonly platform?: NodeJS.Platform;
}

/** 顶层 .gitignore 简单模式（非空/非注释/非否定行；目录尾斜杠剥除）。 */
export function loadGitignorePatterns(root: string): string[] {
  const gitignorePath = path.join(root, ".gitignore");
  if (!existsSync(gitignorePath)) return [];
  const patterns: string[] = [];
  for (const raw of readFileSync(gitignorePath, "utf8").split("\n")) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#") || line.startsWith("!")) continue;
    patterns.push(line.replace(/\/+$/, ""));
  }
  return patterns;
}

/**
 * 前置过滤：内置段/隐藏项/额外 glob（.gitignore 模式，相对 root）。
 * gitignore 语义：无斜杠模式匹配任意层段名（文件/目录名）；含斜杠
 * 模式锚定 root 相对（目录模式追加 /** 匹配其内容）。
 */
export function shouldIgnorePath(relPath: string, extraPatterns: readonly string[] = []): boolean {
  const segments = relPath.split("/");
  if (segments.some((seg) => seg === "" || seg === "." || seg === "..")) return true;
  if (segments.some((seg) => BUILTIN_IGNORE_SEGMENTS.has(seg) || seg.startsWith("."))) return true;
  for (const pattern of extraPatterns) {
    if (!pattern.includes("/")) {
      const segRe = globToRegExp(pattern);
      if (segments.some((seg) => segRe.test(seg))) return true;
    } else if (globToRegExp(pattern).test(relPath) || globToRegExp(`${pattern}/**`).test(relPath)) {
      return true;
    }
  }
  return false;
}

/**
 * 事件归一纯函数：→ FsWatchEvent | null（null=忽略）。
 * filename 相对 watchDir（递归单流时即 root）；ignore 按绝对路径
 * 归一到 root 相对后判定。eventType change → write；rename → exists
 * 判 write/remove（注入 exists 供 I 层测试）。
 */
export function resolveWatchEvent(
  root: string,
  watchDir: string,
  eventType: string,
  filename: string | null,
  exists: (absPath: string) => boolean = existsSync,
  extraPatterns: readonly string[] = [],
): FsWatchEvent | null {
  if (filename === null || filename === "") return null;
  const absPath = path.join(watchDir, filename);
  const rel = path.relative(root, absPath).split(path.sep).join("/");
  if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) return null;
  if (shouldIgnorePath(rel, extraPatterns)) return null;
  if (eventType === "change") return { absPath, kind: "write" };
  return { absPath, kind: exists(absPath) ? "write" : "remove" };
}

export class FsWatchAdapter {
  private readonly root: string;
  private readonly onEvent: (event: FsWatchEvent) => void;
  private readonly maxWatchedDirs: number;
  private readonly recursive: boolean;
  private readonly gitignorePatterns: string[];
  private readonly dirWatchers = new Map<string, FSWatcher>();
  private rootWatcher: FSWatcher | null = null;
  private started = false;

  constructor(opts: FsWatchAdapterOptions) {
    this.root = opts.root;
    this.onEvent = opts.onEvent;
    this.maxWatchedDirs = opts.maxWatchedDirs ?? DEFAULT_MAX_WATCHED_DIRS;
    const platform = opts.platform ?? process.platform;
    this.recursive = platform === "darwin" || platform === "win32";
    this.gitignorePatterns = loadGitignorePatterns(opts.root);
  }

  /** 挂载 watch（macOS/Win 单流递归；Linux 初始递归扫描逐目录 + 动态补挂）。 */
  start(): void {
    if (this.started) return;
    this.started = true;
    if (this.recursive) {
      this.rootWatcher = watch(
        this.root,
        { recursive: true },
        (eventType, filename) => this.dispatch(this.root, eventType, filename),
      );
      return;
    }
    this.mountDirTree(this.root);
  }

  stop(): void {
    this.started = false;
    this.rootWatcher?.close();
    this.rootWatcher = null;
    for (const watcher of this.dirWatchers.values()) watcher.close();
    this.dirWatchers.clear();
  }

  /** 当前挂载目录数（Linux 帽诊断/冒烟断言）。 */
  get watchedDirCount(): number {
    return this.dirWatchers.size + (this.rootWatcher !== null ? 1 : 0);
  }

  // ── 内部 ──────────────────────────────────────────────────

  private dispatch(watchDir: string, eventType: string, filename: string | null): void {
    const event = resolveWatchEvent(this.root, watchDir, eventType, filename, existsSync, this.gitignorePatterns);
    if (event === null) return;
    // Linux 动态补挂：rename 落点若是新目录 → 幂等挂载（文件时 watch
    // ENOTDIR 被 mountDir 吞、readdir 失败自然返回）
    if (!this.recursive && event.kind === "write") this.mountDirTree(event.absPath);
    this.onEvent(event);
  }

  /** 递归挂载 dir 及其子目录（跳过 ignore；帽满即止）。 */
  private mountDirTree(dir: string): void {
    if (this.dirWatchers.size >= this.maxWatchedDirs) return;
    this.mountDir(dir);
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const rel = path.relative(this.root, path.join(dir, entry.name)).split(path.sep).join("/");
      if (shouldIgnorePath(rel, this.gitignorePatterns)) continue;
      this.mountDirTree(path.join(dir, entry.name));
    }
  }

  private mountDir(dir: string): void {
    if (this.dirWatchers.has(dir) || this.dirWatchers.size >= this.maxWatchedDirs) return;
    try {
      const watcher = watch(dir, (eventType, filename) => this.dispatch(dir, eventType, filename));
      this.dirWatchers.set(dir, watcher);
    } catch {
      // 目录消失/权限——跳过（总量帽外的自然退化）
    }
  }
}
