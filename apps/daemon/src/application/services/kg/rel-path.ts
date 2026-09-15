/**
 * kg 服务族事件路径归一单源（code-review L 收口）：KgSyncService（窗口
 * 队列键）与 KgAttachmentService（锚表/符号表相对语义）原各持一份逐字
 * 同构 relPathOf、KgFsWatchService 内联 relative——三处收口于此。
 *
 * 为什么在 application/services/kg/：三消费面全部位于本目录（TR-13 分层：
 * application 层共享 util，不进 domain/kg——那是跨层语义面，收口范围仅限
 * 服务族内部路径归一口径）。
 */
import { relative } from "node:path";

/**
 * 事件路径归一：绝对路径 → 相对 projectRoot（引擎面/锚表/符号表相对语义
 * 同源）；相对输入原样透传；根自身（relative=""）回退原路径——队列键与
 * 锚表键永不为空串。
 */
export function relPathOf(projectRoot: string, path: string): string {
  if (!path.startsWith("/")) return path;
  return relative(projectRoot, path) || path;
}

/**
 * 根外相对路径精确判定（code-review L：startsWith("..") 会误杀 `..foo`
 * 同前缀合法文件）：仅 `..`、`../`、`..\` 前缀为根外。KgFsWatchService
 * 事件过滤面消费（与 relPathOf 分离——那边根自身回退原路径，无法判根外）。
 */
export function isOutsideRootRel(relPath: string): boolean {
  return relPath === ".." || relPath.startsWith("../") || relPath.startsWith("..\\");
}
