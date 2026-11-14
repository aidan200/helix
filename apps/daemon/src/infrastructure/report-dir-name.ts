/**
 * 报告目录名 sanitize 单点（TR-95 win32-x64 兼容面）。
 *
 * 背景：sessionId 形态含协议前缀（task:<jobId>）——冒号在 Windows 文件名
 * 非法（NTFS 保留字符，mkdir ENOTDIR）。CI windows runner 实证（task-report
 * 集成测试全文件挂）。协议层 sessionId（SQLite 表/Steward 感知/报告路由键）
 * 不动——只在【落盘目录名】边界归一。
 *
 * 口径：非法文件名字符（Windows 保留集：< > : " / \ | ? *）→ 连字符；
 * 其余平台字符原样（posix 上 sessionId 不含这些字符时零变化——含冒号的
 * task: 前缀在 posix 本来合法，但跨平台一致性优先：统一归一后 mac 侧目录
 * 名也变 task-<jobId>，读写同走本函数自洽）。
 *
 * 消费面：三个装配点的 reportDirFor/reportsDirFor（buildSessionStack /
 * wireSessionStack / buildTaskOrchestrator）——全部注入路径经本函数，
 * 写侧（ClosureRecorder/SubagentLauncher HELIX_REPORT_PATH）与读侧
 * （TaskReportTool summary 落点）同源同式，路径往返自洽。
 */

/** Windows 保留文件名字符集（+ 控制字符）→ 连字符归一。 */
const ILLEGAL_FILENAME = /[<>:"/\\|?*\u0000-\u001f]/g;

/**
 * 报告目录名归一（sessionId → 合法跨平台目录名）。
 * 仅落盘边界消费——协议/存储层的 sessionId 原样。
 */
export function reportDirNameOf(sessionId: string): string {
  const sanitized = sessionId.replace(ILLEGAL_FILENAME, "-");
  // Windows 保留设备名兜底（CON/PRN/AUX/NUL/COM1-9/LPT1-9——目录名等于这些
  // 时 win 创建失败；前缀下划线消歧。sessionId 形态不会命中，防御性收口）
  if (/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(\.|$)/i.test(sanitized)) {
    return `_${sanitized}`;
  }
  return sanitized;
}
