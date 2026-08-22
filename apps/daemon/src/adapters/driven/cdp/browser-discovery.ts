/**
 * 浏览器 CDP 端口发现（移植自 web-access/scripts/browser-discovery.mjs）。
 *
 * 职责：平台路径矩阵（mac/linux/win × chrome/canary/chromium/edge）→
 * 读 DevToolsActivePort（首行=端口，次行=wsPath）→ **TCP connect 探活**
 * （不用 WebSocket 探活——避免触发浏览器的远程调试授权弹窗）。
 *
 * 从简差异：无 config.env 偏好 / --browser override / 固定端口兜底
 * 决策层（v1 三档解析）——只返回全部检出候选，多浏览器选择策略
 * （取第一个）归 CdpConnectionManager。偏好持久化机制后续任务再做。
 *
 * 可测性：fsReader/tcpProber 注入化——unit 测试 fake fs + fake prober，
 * 不碰真实文件系统与网络。homeDir 显式入参（AG-07：用户主目录展开单点在
 * infrastructure/paths.ts，本模块不直接展开）。win32 的 LOCALAPPDATA 不可经
 * 环境变量读取（AG-08）——缺省回退 <homeDir>/AppData/Local（默认安装布局），
 * 非默认布局由调用方显式注入。
 */
import fs from "node:fs";
import net from "node:net";
import path from "node:path";

/** 已知浏览器候选（DevToolsActivePort 路径平台矩阵）。 */
export interface BrowserCandidate {
  readonly id: string;
  readonly label: string;
  readonly devToolsPath: string;
}

/** 检出结果（端口探活通过后）。 */
export interface DiscoveredBrowser {
  readonly id: string;
  readonly label: string;
  readonly port: number;
  readonly wsPath: string | null;
}

/** 文件读取接缝（缺省 node:fs；测试 fake）。返回 null = 文件不存在/不可读。 */
export type FsReader = (path: string) => string | null;

/** TCP 探活接缝（缺省 node:net connect；测试 fake）。 */
export type TcpProber = (port: number, host?: string, timeoutMs?: number) => Promise<boolean>;

export function knownBrowsers(platform: string, homeDir: string, localAppData?: string): readonly BrowserCandidate[] {
  // win32 LOCALAPPDATA 缺省回退（AG-08 禁读环境变量）：默认安装布局 <home>/AppData/Local
  const appData = localAppData ?? path.join(homeDir, "AppData", "Local");
  switch (platform) {
    case "darwin":
      return [
        { id: "chrome", label: "Chrome", devToolsPath: path.join(homeDir, "Library/Application Support/Google/Chrome/DevToolsActivePort") },
        { id: "chrome-canary", label: "Chrome Canary", devToolsPath: path.join(homeDir, "Library/Application Support/Google/Chrome Canary/DevToolsActivePort") },
        { id: "chromium", label: "Chromium", devToolsPath: path.join(homeDir, "Library/Application Support/Chromium/DevToolsActivePort") },
        { id: "edge", label: "Microsoft Edge", devToolsPath: path.join(homeDir, "Library/Application Support/Microsoft Edge/DevToolsActivePort") },
      ];
    case "linux":
      return [
        { id: "chrome", label: "Chrome", devToolsPath: path.join(homeDir, ".config/google-chrome/DevToolsActivePort") },
        { id: "chromium", label: "Chromium", devToolsPath: path.join(homeDir, ".config/chromium/DevToolsActivePort") },
        { id: "edge", label: "Microsoft Edge", devToolsPath: path.join(homeDir, ".config/microsoft-edge/DevToolsActivePort") },
      ];
    case "win32":
      return [
        { id: "chrome", label: "Chrome", devToolsPath: path.join(appData, "Google/Chrome/User Data/DevToolsActivePort") },
        { id: "chromium", label: "Chromium", devToolsPath: path.join(appData, "Chromium/User Data/DevToolsActivePort") },
        { id: "edge", label: "Microsoft Edge", devToolsPath: path.join(appData, "Microsoft/Edge/User Data/DevToolsActivePort") },
      ];
    default:
      return [];
  }
}

export const defaultFsReader: FsReader = (p) => {
  try {
    return fs.readFileSync(p, "utf8");
  } catch {
    return null;
  }
};

/** TCP connect 探活（不用 WebSocket——避免触发授权弹窗）。 */
export const defaultTcpProber: TcpProber = (port, host = "127.0.0.1", timeoutMs = 2000) =>
  new Promise((resolve) => {
    const socket = net.createConnection(port, host);
    const timer = setTimeout(() => {
      socket.destroy();
      resolve(false);
    }, timeoutMs);
    socket.once("connect", () => {
      clearTimeout(timer);
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => {
      clearTimeout(timer);
      resolve(false);
    });
  });

export interface DetectBrowsersDeps {
  readonly platform: string;
  readonly homeDir: string;
  /** win32 的 LOCALAPPDATA（其余平台忽略；缺省回退 <homeDir>/AppData/Local）。 */
  readonly localAppData?: string;
  readonly fsReader?: FsReader;
  readonly tcpProber?: TcpProber;
}

/**
 * 返回所有开了调试 toggle 且端口活的浏览器（候选声明序）。
 * 单个候选的任何失败（文件缺失/端口非法/探活失败）只跳过该候选，不抛错。
 */
export async function detectBrowsers(deps: DetectBrowsersDeps): Promise<DiscoveredBrowser[]> {
  const fsReader = deps.fsReader ?? defaultFsReader;
  const tcpProber = deps.tcpProber ?? defaultTcpProber;
  const result: DiscoveredBrowser[] = [];
  for (const candidate of knownBrowsers(deps.platform, deps.homeDir, deps.localAppData)) {
    const content = fsReader(candidate.devToolsPath);
    if (content === null) continue;
    const lines = content.trim().split(/\r?\n/).filter(Boolean);
    const port = parseInt(lines[0] ?? "", 10);
    if (!(port > 0 && port < 65536)) continue;
    if (!(await tcpProber(port))) continue;
    result.push({ id: candidate.id, label: candidate.label, port, wsPath: lines[1] ?? null });
  }
  return result;
}
