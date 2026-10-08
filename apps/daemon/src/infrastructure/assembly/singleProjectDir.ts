/**
 * 会话写足迹单项目归约单点（E-264 批立项、批D 落地于 container、批E 起
 * 双消费共享：container progress 写入 scope + sessionEngineFactory/
 * SubagentLauncher 的 memory_search scope 过滤）。
 *
 * 口径：唯一足迹项目 → workspace 一级目录名（与 codegraph projectPath /
 * kg project 同源）；零足迹/多足迹 → undefined（消费方回落 global）。
 * AG-07：不展开用户主目录——输入是绝对路径足迹，输出是目录名。
 */
export function singleProjectDirOf(projectRoots: readonly string[]): string | undefined {
  return projectRoots.length === 1 ? (projectRoots[0]!.split("/").pop() ?? undefined) : undefined;
}
