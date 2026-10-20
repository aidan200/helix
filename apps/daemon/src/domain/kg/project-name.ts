/**
 * 项目名派生单源（projectRoot 尾段 = 项目名）。
 *
 * 历史：四处同名 helper 各写一份且行为分叉（评审 low #15/#25）——
 * resident-rules / ClosureRecorder 版不归一分隔符也不滤空段（尾斜杠输入
 * `…/proj/` 回退整串路径、win32 反斜杠取不到尾段）；task-slice 版归一分隔符
 * 但不滤空段；job-activity 版滤空段但不归一分隔符。四份里只有一种是对的。
 *
 * 口径（唯一）：先归一分隔符（`\` → `/`），再滤空段取尾段，取不到才回退
 * 整串。**任何「从 projectRoot 取项目名」的消费面一律 import 本函数**，
 * 禁各面自写 split/pop 推导（AD-16 项目名可见文本不受限；本函数只做名字
 * 派生，不做路径归一——归一归 resolveWithin/foldPathSegments 域）。
 */
export function projectNameOf(projectRoot: string): string {
  const parts = projectRoot.replaceAll("\\", "/").split("/").filter((s) => s !== "");
  return parts[parts.length - 1] ?? projectRoot;
}
