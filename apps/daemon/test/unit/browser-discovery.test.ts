import { describe, expect, test } from "bun:test";
import path from "node:path";
import {
  detectBrowsers,
  knownBrowsers,
  type FsReader,
  type TcpProber,
} from "../../src/adapters/driven/cdp/browser-discovery";

/**
 * T2 浏览器发现逻辑 unit（移植自 web-access/scripts/browser-discovery.mjs）：
 * DevToolsActivePort 解析 + 平台路径矩阵 + TCP 探活选择——全部经注入的
 * fake fs/fake prober 驱动，不碰真实文件系统与网络。
 *
 * 与 v1 差异：无 config.env 偏好/override 决策层（T2 从简——多个开了调试的
 * 浏览器取第一个，偏好持久化机制后续任务再做）。
 */

const proberAlways: TcpProber = async () => true;
const proberNever: TcpProber = async () => false;

/** fake fsReader：路径 → 文件内容映射（未命中 = 文件不存在）。 */
function fakeFs(files: Record<string, string>): FsReader {
  return (p) => files[p] ?? null;
}

describe("knownBrowsers 平台路径矩阵", () => {
  test("darwin：chrome/canary/chromium/edge 四候选，路径在 ~/Library/Application Support 下", () => {
    const list = knownBrowsers("darwin", "/home/u");
    expect(list.map((b) => b.id)).toEqual(["chrome", "chrome-canary", "chromium", "edge"]);
    expect(list[0]!.devToolsPath).toBe(
      path.join("/home/u", "Library/Application Support/Google/Chrome/DevToolsActivePort"),
    );
    expect(list[1]!.devToolsPath).toBe(
      path.join("/home/u", "Library/Application Support/Google/Chrome Canary/DevToolsActivePort"),
    );
    expect(list[2]!.devToolsPath).toBe(
      path.join("/home/u", "Library/Application Support/Chromium/DevToolsActivePort"),
    );
    expect(list[3]!.devToolsPath).toBe(
      path.join("/home/u", "Library/Application Support/Microsoft Edge/DevToolsActivePort"),
    );
    expect(list[0]!.label).toBe("Chrome");
  });

  test("linux：chrome/chromium/edge 三候选，路径在 ~/.config 下", () => {
    const list = knownBrowsers("linux", "/home/u");
    expect(list.map((b) => b.id)).toEqual(["chrome", "chromium", "edge"]);
    expect(list[0]!.devToolsPath).toBe(path.join("/home/u", ".config/google-chrome/DevToolsActivePort"));
    expect(list[2]!.devToolsPath).toBe(path.join("/home/u", ".config/microsoft-edge/DevToolsActivePort"));
  });

  test("win32：路径在 LOCALAPPDATA 下", () => {
    const list = knownBrowsers("win32", "/home/u", "C:\\Users\\u\\AppData\\Local");
    expect(list.map((b) => b.id)).toEqual(["chrome", "chromium", "edge"]);
    expect(list[0]!.devToolsPath).toBe(
      path.join("C:\\Users\\u\\AppData\\Local", "Google/Chrome/User Data/DevToolsActivePort"),
    );
  });

  test("未知平台：空候选", () => {
    expect(knownBrowsers("freebsd", "/home/u")).toEqual([]);
  });
});

describe("detectBrowsers（DevToolsActivePort 解析 + 探活选择）", () => {
  const home = "/home/u";
  const chromePath = path.join(home, "Library/Application Support/Google/Chrome/DevToolsActivePort");
  const edgePath = path.join(home, "Library/Application Support/Microsoft Edge/DevToolsActivePort");

  test("首行端口 + 次行 wsPath 解析；探活通过则检出", async () => {
    const found = await detectBrowsers({
      platform: "darwin",
      homeDir: home,
      fsReader: fakeFs({ [chromePath]: "9222\n/devtools/browser/abc-123\n" }),
      tcpProber: proberAlways,
    });
    expect(found).toEqual([{ id: "chrome", label: "Chrome", port: 9222, wsPath: "/devtools/browser/abc-123" }]);
  });

  test("无 wsPath 次行 → wsPath 为 null", async () => {
    const found = await detectBrowsers({
      platform: "darwin",
      homeDir: home,
      fsReader: fakeFs({ [chromePath]: "9333" }),
      tcpProber: proberAlways,
    });
    expect(found).toEqual([{ id: "chrome", label: "Chrome", port: 9333, wsPath: null }]);
  });

  test("端口行非法（非数字/越界）→ 跳过", async () => {
    for (const content of ["not-a-port\n/x", "0\n/x", "65536\n/x", "\n"]) {
      const found = await detectBrowsers({
        platform: "darwin",
        homeDir: home,
        fsReader: fakeFs({ [chromePath]: content }),
        tcpProber: proberAlways,
      });
      expect(found).toEqual([]);
    }
  });

  test("TCP 探活失败（toggle 残留文件但浏览器已关）→ 跳过", async () => {
    const found = await detectBrowsers({
      platform: "darwin",
      homeDir: home,
      fsReader: fakeFs({ [chromePath]: "9222\n/devtools/browser/abc" }),
      tcpProber: proberNever,
    });
    expect(found).toEqual([]);
  });

  test("文件不存在（fsReader 返回 null）→ 跳过不抛错", async () => {
    const found = await detectBrowsers({
      platform: "darwin",
      homeDir: home,
      fsReader: fakeFs({}),
      tcpProber: proberAlways,
    });
    expect(found).toEqual([]);
  });

  test("多浏览器同时开调试 → 全部检出（选择策略归 manager：取第一个）", async () => {
    const probedPorts: number[] = [];
    const found = await detectBrowsers({
      platform: "darwin",
      homeDir: home,
      fsReader: fakeFs({
        [chromePath]: "9222\n/devtools/browser/c",
        [edgePath]: "9444\n/devtools/browser/e",
      }),
      tcpProber: async (port) => {
        probedPorts.push(port);
        return true;
      },
    });
    expect(found.map((b) => b.id)).toEqual(["chrome", "edge"]);
    expect(probedPorts.sort()).toEqual([9222, 9444]);
  });

  test("探活只命中存活者：chrome 死 edge 活 → 只检出 edge", async () => {
    const found = await detectBrowsers({
      platform: "darwin",
      homeDir: home,
      fsReader: fakeFs({
        [chromePath]: "9222\n/devtools/browser/c",
        [edgePath]: "9444\n/devtools/browser/e",
      }),
      tcpProber: async (port) => port === 9444,
    });
    expect(found.map((b) => b.id)).toEqual(["edge"]);
  });
});
