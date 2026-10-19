/**
 * 会话写足迹单项目归约单点（E-264 批立项、批D 落地于 container、批E 起
 * 双消费共享：container progress 写入 scope + sessionEngineFactory/
 * SubagentLauncher 的 memory_search scope 过滤）。
 *
 * 口径：唯一足迹项目 → workspace 一级目录名（与 codegraph projectPath /
 * kg project 同源）；零足迹/多足迹 → undefined（消费方回落 global）。
 * AG-07：不展开用户主目录——输入是绝对路径足迹，输出是目录名。
 *
 * 分隔符口径（评审 F1）：path.basename（win32 宿主原生含反斜杠形态）+
 * 盘符前缀显式按 win32 basename 归一（posix 宿主收到 win32 足迹同样处理，
 * TR-95 兼容面）——原 split("/").pop() 会把 win32 绝对路径整串当目录名、
 * 尾斜杠路径得空串；basename 空结果归 undefined（消费方回落 global）。
 */
import { basename } from "node:path";
import { basename as basenameWin32 } from "node:path/win32";

/** win32 盘符绝对形态（跨宿主识别）。 */
const WIN_DRIVE_ABSOLUTE = /^[a-zA-Z]:[\\/]/;

export function singleProjectDirOf(projectRoots: readonly string[]): string | undefined {
  if (projectRoots.length !== 1) return undefined;
  const root = projectRoots[0]!;
  const dir = WIN_DRIVE_ABSOLUTE.test(root) ? basenameWin32(root) : basename(root);
  return dir === "" ? undefined : dir;
}
