/**
 * FsWatchPort —— 目录文件监控出站端口（B3 fs-watch 重新挂接，推翻
 * 2026-08-29 退役裁决：KgSyncService 进程内监控选型）。
 *
 * application 层零直接 node:fs（对齐 WorkspaceFsPort 注入风格）：真体 =
 * adapters/driven/fs-watch/FsWatchAdapter（fs.watch recursive；Linux 目录
 * 分层兜底）；测试注入 fake（事件剧本 + 生命周期计数）。
 *
 * 事件归一形态与 KgSyncService.FsEventKind 同构（write=存在类变更，
 * remove=消失）——adapter 侧以 eventType + existsSync 落定 kind，
 * application 层只做转发不做判别。
 */

/** fs 事件归一（write=存在类变更，remove=消失）。 */
export type FsWatchEventKind = "write" | "remove";

export interface FsWatchEvent {
  /** 变更文件绝对路径（watch root 拼接相对名）。 */
  readonly path: string;
  readonly kind: FsWatchEventKind;
}

/** 单个 watcher 句柄（close 幂等）。 */
export interface FsWatchHandle {
  close(): void;
}

export interface FsWatchPort {
  /**
   * 递归监控 root（含子目录）；实现侧保证 Linux 等 recursive 不支持平台
   * 有兜底（目录分层），调用面无平台分支。watch 建不起来（root 消失等）
   * 抛错归调用方捕获。
   */
  watch(root: string, onEvent: (event: FsWatchEvent) => void, onError?: (error: unknown) => void): FsWatchHandle;
}
