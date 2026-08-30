/**
 * KgFsWatchService —— per-project 目录文件监控编排（B3 fs-watch 重新挂接，
 * 推翻 2026-08-29 退役裁决；选型 = KgSyncService 进程内监控：watchExternal
 * 直喂 sync 队列链路最短、不推翻 AF-2 被动抽取器、跨平台可控）。
 *
 * 链路：FsWatchPort 事件 → 忽略面过滤 → KgSyncService.onFsEvent（归一入口）
 * → 既有 (path,hash) 去重 → 3s 去抖 → 单飞 sync 管道（本服务不重实现）。
 *
 * 挂接时机两路：
 * ① 索引建成（absent→building→synced）后——KgSyncService.onSynced 钩子
 *   经组合根接到 watchProject（首次 sync 成功即挂）；
 * ② workspace 绑定/换绑时按索引态补齐——container.ts startSync 接缝对
 *   已建 .helix-kg 的项目批量 watchProject。
 *
 * 自激励防护（本功能最大的坑）：sync 写 .helix-kg/kg.db、引擎建索引写
 * .codegraph/codegraph.db——若这些事件回流 onFsEvent 则 sync→watch→sync
 * 死循环。忽略面在**本服务事件过滤**（权威面，全平台生效）+ **adapter 目录
 * 分层不下钻**（Linux 兜底源头无 watcher）双层落实。
 *
 * 生命周期：workspace 切换/daemon 退出经 KnowledgeStack.dispose → dispose()
 * 全停；stopWatching(projectRoot) 是后续 index-delete 任务的消费接缝
 * （本任务不做 delete 命令）。watchProject 幂等（重复挂接 = no-op）。
 */
import { relative } from "node:path";
import type { FsWatchHandle, FsWatchPort } from "../../ports/outbound/FsWatchPort";
import type { KgSyncService } from "./KgSyncService";

/**
 * 监控忽略段（路径任一段命中即忽略）：kg/codegraph 自身产物（自激励防护）
 * + 依赖/版本控制/构建产物（噪声面）。单源——adapter 目录分层不下钻与
 * 本服务事件过滤共用。
 */
export const FS_WATCH_IGNORED_SEGMENTS: readonly string[] = [".helix-kg", ".codegraph", ".git", "node_modules", "dist"];

const IGNORED_SEGMENT_SET: ReadonlySet<string> = new Set(FS_WATCH_IGNORED_SEGMENTS);

/** 段级忽略判定（adapter 目录分层注入面）。 */
export function isIgnoredWatchSegment(name: string): boolean {
  return IGNORED_SEGMENT_SET.has(name);
}

/** 相对路径忽略判定：任一路径段命中忽略清单即忽略（dist-util 等不误伤）。 */
export function isIgnoredWatchRelPath(relPath: string): boolean {
  return relPath.split(/[\\/]/).some((seg) => IGNORED_SEGMENT_SET.has(seg));
}

export interface KgFsWatchServiceDeps {
  /** sync 归一事件入口（结构面子集——只消费 onFsEvent）。 */
  readonly sync: Pick<KgSyncService, "onFsEvent">;
  /** 目录监控端口（真体 FsWatchAdapter；测试 fake）。 */
  readonly watcher: FsWatchPort;
  /** 可观测日志（结构面；组合根注入 Logger，测试缺省无日志）。 */
  readonly logger?: { info(msg: string): void; warn(msg: string): void };
}

export class KgFsWatchService {
  private readonly deps: KgFsWatchServiceDeps;
  private readonly handles = new Map<string, FsWatchHandle>(); // projectRoot → watcher

  constructor(deps: KgFsWatchServiceDeps) {
    this.deps = deps;
  }

  /**
   * 启动 per-project watcher（幂等：已挂 = no-op 返回 true）。
   * watch 建立失败（root 消失/权限等）不抛——warn 留痕返回 false（监控
   * 是兜底信号面，失败不阻断主链路；下次 sync 成功/重绑再补挂）。
   */
  watchProject(projectRoot: string): boolean {
    if (this.handles.has(projectRoot)) return true;
    try {
      const handle = this.deps.watcher.watch(
        projectRoot,
        (event) => {
          const rel = relative(projectRoot, event.path);
          if (rel === "" || rel.startsWith("..")) return; // 根外事件防御
          if (isIgnoredWatchRelPath(rel)) return; // 自激励防护权威面（全平台）
          this.deps.sync.onFsEvent(projectRoot, event.path, event.kind);
        },
        (error) => this.deps.logger?.warn(`fs-watch 故障（${projectRoot}）：${String(error)}`),
      );
      this.handles.set(projectRoot, handle);
      this.deps.logger?.info(`fs-watch 已挂接：${projectRoot}`);
      return true;
    } catch (error) {
      this.deps.logger?.warn(`fs-watch 挂接失败（${projectRoot}）：${String(error)}`);
      return false;
    }
  }

  /** 停止单项目 watcher（index-delete 消费接缝；未挂 = no-op）。 */
  stopWatching(projectRoot: string): void {
    const handle = this.handles.get(projectRoot);
    if (handle === undefined) return;
    this.handles.delete(projectRoot);
    try {
      handle.close();
    } catch {
      // close 幂等防御
    }
  }

  /** 监控态读面（测试/装配断言）。 */
  isWatching(projectRoot: string): boolean {
    return this.handles.has(projectRoot);
  }

  /** 全部 watcher 清理（workspace 切换/daemon 退出；幂等）。 */
  dispose(): void {
    for (const root of [...this.handles.keys()]) this.stopWatching(root);
  }
}
