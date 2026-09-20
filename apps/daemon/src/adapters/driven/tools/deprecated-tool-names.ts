/**
 * 已废弃工具名表 + 会话文本消毒器（幽灵工具名复发修复批）。
 *
 * 【为什么存在】工具改名（sandbox_request → permission_request，4fa44b8b）
 * 后，会话历史文本仍携带旧名（实证：会话 17be1a88 条目 269 处污染）。两条
 * 扩散路径都要堵：
 * 1. **上下文面（防扩散层）**：MainAgent 组 brief 照搬会话内容 → 旧名随
 *    task 文本进 SubAgent 上下文 → 模型照搬旧名发起调用。消毒在 spawn
 *    装配面（SubagentLauncher doLaunch / ChildMain spawnOverridesFromEnv）
 *    机械改写——模型看到的第一手文本即新名；
 * 2. **装配面（防崩溃层）**：stale daemon 版本斜差（父进程内存旧代码发
 *    HELIX_TOOLS_JSON 携带旧名，子进程磁盘新代码注册表只有新名）→
 *    resolveTools 抛错子进程整崩。别名改写在 CoreToolExecutor（见其
 *    resolveTools 已废弃名分支）。
 *
 * 【扩展位】表当前仅 sandbox_request 一项；未来工具改名在此追加映射即可，
 * 消毒器与别名改写自动跟随（不建通用改名框架——范围钳制）。
 */

/** 已废弃工具名表：旧名 → 现名（单源数据面；扩展位）。 */
export const DEPRECATED_TOOL_NAMES: ReadonlyMap<string, string> = new Map([
  ["sandbox_request", "permission_request"],
]);

/** 消毒注记模板：新名 + 通道说明 + 旧名废弃可追溯。 */
const deprecatedAnnotationOf = (oldName: string, newName: string): string =>
  `${newName}（沙箱外执行申请通道——旧名 ${oldName} 已废弃）`;

/**
 * 文本消毒：把已废弃工具名的**裸出现**改写为「新名 + 废弃注记」。
 *
 * - 词边界：仅匹配独立成词的旧名（下划线属标识符字符——
 *   `my_sandbox_request_v2` 内嵌不误改）；
 * - 幂等：重复消毒不嵌套注记（先把既有注记归一为裸旧名再统一重写）；
 * - 干净文本零改写（逐字节不变）。
 */
export function sanitizeDeprecatedToolNames(text: string): string {
  let out = text;
  for (const [oldName, newName] of DEPRECATED_TOOL_NAMES) {
    out = sanitizeOne(out, oldName, newName);
  }
  return out;
}

/** 单条映射的消毒（幂等：既有注记先剥掉再按裸名统一重写）。 */
function sanitizeOne(text: string, oldName: string, newName: string): string {
  const annotation = deprecatedAnnotationOf(oldName, newName);
  // 幂等性：已消毒文本（含注记）先归一为裸旧名，再走统一替换——重复消毒
  // 不会嵌套注记（「旧名 X 已废弃」内的 X 不会再次膨胀）。
  const normalized = text.split(annotation).join(oldName);
  if (!containsBareWord(normalized, oldName)) return text; // 干净文本逐字节不变（含仅注记形态）
  const pattern = new RegExp(`\\b${escapeRegExp(oldName)}\\b`, "g");
  return normalized.replace(pattern, annotation);
}

/** 裸词出现检测（词边界——内嵌长标识符不算）。 */
function containsBareWord(text: string, name: string): boolean {
  return new RegExp(`\\b${escapeRegExp(name)}\\b`).test(text);
}

/** 正则元字符转义（工具名以标识符为主，防御性兜底）。 */
function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
