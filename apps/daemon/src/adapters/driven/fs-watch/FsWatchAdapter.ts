/**
 * FsWatchAdapter —— FsWatchPort 真体（node:fs watch，B3）。
 *
 * 跨平台三态（Bun runtime 实测面 = test/unit/kg-fs-watch.test.ts 真 fs 用例）：
 * - macOS/Windows：fs.watch({ recursive: true }) 原生递归；
 * - Linux：recursive 不支持（ERR_FEATURE_UNAVAILABLE_ON_PLATFORM）——兜底
 *   选型 = **目录分层**（不引 chokidar 新依赖、不轮询降级）：初始遍历挂
 *   每个非忽略目录一个非递归 watcher；rename 事件命中新目录时增量补挂
 *   （含其非忽略子树——mkdir -p/git checkout 成片出现场景）。忽略段不下钻
 *   = .helix-kg/.codegraph 自激励产物在源头就没有 watcher（防护第一性）；
 * - recursive 调用期抛错（平台探测漏网/Bun 实现差异）→ 当场回落目录分层，
 *   调用面无感。
 *
 * kind 落定：eventType "change" → write；"rename"（创建/删除/改名不归并）
 * → existsSync 判别——存在 = write，消失 = remove。filename 为 null 的
 * 弃事件防御性丢弃（无法定位路径）。
 */
import { existsSync, readdirSync, statSync, watch, type FSWatcher } from "node:fs";
import path from "node:path";
import type { FsWatchEvent, FsWatchEventKind, FsWatchHandle, FsWatchPort } from "../../../application/ports/outbound/FsWatchPort";

/** fs.watch recursive 原生支持平台（Node/Bun 同口径）。 */
const RECURSIVE_PLATFORMS: ReadonlySet<string> = new Set(["darwin", "win32"]);

export interface FsWatchAdapterDeps {
  /** 忽略段判定（目录分层兜底不下钻的过滤输入；单源 = KgFsWatchService 忽略清单）。 */
  readonly isIgnoredSegment: (name: string) => boolean;
  /** 平台注入面（测试以 "linux" 强制走目录分层兜底）；缺省 process.platform。 */
  readonly platform?: string;
}

export class FsWatchAdapter implements FsWatchPort {
  private readonly deps: FsWatchAdapterDeps;
  private readonly platform: string;

  constructor(deps: FsWatchAdapterDeps) {
    this.deps = deps;
    this.platform = deps.platform ?? process.platform;
  }

  watch(root: string, onEvent: (event: FsWatchEvent) => void, onError?: (error: unknown) => void): FsWatchHandle {
    if (RECURSIVE_PLATFORMS.has(this.platform)) {
      try {
        return this.recursiveWatch(root, onEvent, onError);
      } catch {
        // recursive 调用期不支持（Linux 漏网/Bun 实现差异）→ 目录分层兜底
      }
    }
    return this.layeredWatch(root, onEvent, onError);
  }

  /** macOS/Windows 原生递归（单 watcher）。 */
  private recursiveWatch(
    root: string,
    onEvent: (event: FsWatchEvent) => void,
    onError?: (error: unknown) => void,
  ): FsWatchHandle {
    const watcher = watch(root, { recursive: true }, (eventType, filename) => {
      if (filename === null) return; // 弃事件：无路径可定位
      const abs = path.join(root, filename.toString());
      onEvent({ path: abs, kind: kindOf(eventType, abs) });
    });
    if (onError !== undefined) watcher.on("error", onError);
    return { close: () => watcher.close() };
  }

  /**
   * Linux 兜底：目录分层（每非忽略目录一个非递归 watcher；新目录增量补挂）。
   * 忽略段不下钻——自激励产物目录源头无 watcher，事件根本不会产生。
   */
  private layeredWatch(
    root: string,
    onEvent: (event: FsWatchEvent) => void,
    onError?: (error: unknown) => void,
  ): FsWatchHandle {
    const watchers = new Map<string, FSWatcher>(); // relDir（"" = root）→ watcher

    const addTree = (absDir: string, relDir: string): void => {
      if (!addDir(absDir, relDir)) return;
      let names: string[];
      try {
        names = readdirSync(absDir);
      } catch {
        return; // 目录扫描窗口内消失
      }
      for (const name of names) {
        if (this.deps.isIgnoredSegment(name)) continue;
        const childAbs = path.join(absDir, name);
        try {
          if (statSync(childAbs).isDirectory()) addTree(childAbs, relDir === "" ? name : `${relDir}/${name}`);
        } catch {
          // 扫描窗口内消失/不可读——跳过
        }
      }
    };

    const addDir = (absDir: string, relDir: string): boolean => {
      if (watchers.has(relDir)) return true;
      let watcher: FSWatcher;
      try {
        watcher = watch(absDir, (eventType, filename) => {
          if (filename === null) return;
          const name = filename.toString();
          const rel = relDir === "" ? name : `${relDir}/${name}`;
          const abs = path.join(root, rel);
          // 新目录出现（mkdir -p/git checkout 成片子树）→ 增量补挂整棵非忽略子树
          if (eventType === "rename" && !this.deps.isIgnoredSegment(name)) {
            try {
              if (statSync(abs).isDirectory()) addTree(abs, rel);
            } catch {
              // 已消失（建后即删）——不补挂
            }
          }
          onEvent({ path: abs, kind: kindOf(eventType, abs) });
        });
      } catch {
        return false; // 目录在挂接窗口内消失
      }
      watcher.on("error", (error) => {
        // 单目录 watcher 故障（目录被删等）：自闭合摘除，不影响其余目录
        watchers.delete(relDir);
        try {
          watcher.close();
        } catch {
          // close 幂等防御
        }
        onError?.(error);
      });
      watchers.set(relDir, watcher);
      return true;
    };

    addTree(root, "");
    return {
      close: () => {
        for (const watcher of watchers.values()) {
          try {
            watcher.close();
          } catch {
            // close 幂等防御
          }
        }
        watchers.clear();
      },
    };
  }
}

/** eventType → 归一 kind：change=write；rename 以 existsSync 判别存/亡。 */
function kindOf(eventType: string, absPath: string): FsWatchEventKind {
  if (eventType === "change") return "write";
  return existsSync(absPath) ? "write" : "remove";
}
