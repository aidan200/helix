/**
 * auth_url 系统默认浏览器拉起命令组装（TR-95 windows-x64 兼容面）。
 *
 * 纯函数（TR-175 防御纪律：装配层内联闭包抽纯工厂 + 窄测试钉死）——
 * 只组 argv 不 spawn，平台注入可单测（mac 宿主上钉 win32 分支）。
 *
 * win32 形态：`cmd.exe /d /s /c start "" <url>`（verbatim 形态——引号由
 * 本模块按 cmd 语义显式控制，运行时不做 MSVC 转义）。
 * - `start` 是 cmd 内建（非可执行映像），CreateProcess 直起必抛 ENOENT，
 *   须经 cmd.exe /c 包装（codegraph .cmd launcher 同款定式，cliSpawnCmd）；
 * - 首参 `""` = start 的窗口标题占位（缺省时带引号的 url 会被当标题，
 *   浏览器不拉起——Windows start 内建的经典坑）；
 * - url 整体双引号包裹：& 等元字符在 cmd 重解析层是命令分隔符，未包裹的
 *   url 会被腰斩成两条命令（auth_url 实际形态含 state/code 查询串）；
 * - 内部引号按 cmd 规则翻倍（" → ""）。
 *
 * posix 形态：darwin = open，其余（linux 等）= xdg-open（零行为变化）。
 *
 * ⚠ 调用方 spawn 须传 windowsVerbatimArguments: true（win32 档）——本模块
 * 返回的 argv 已含最终引号形态，运行时再转义会双重引号。posix 档该
 * option 无语义，恒传无害（缺省 false）。
 */

/** cmd.exe 参数双引号包裹（含空白/元字符整体包裹，内部引号翻倍）。 */
function quoteCmdArg(s: string): string {
  return /[ \t"&|^<>%]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/**
 * 拉起系统默认浏览器的 argv（已含最终引号形态）。
 * platform 注入面缺省 process.platform（测试可钉任一平台分支）。
 */
export function openUrlCommand(
  url: string,
  platform: NodeJS.Platform = process.platform,
): readonly string[] {
  if (platform === "win32") {
    return ["cmd.exe", "/d", "/s", "/c", "start", '""', quoteCmdArg(url)];
  }
  return [platform === "darwin" ? "open" : "xdg-open", url];
}
