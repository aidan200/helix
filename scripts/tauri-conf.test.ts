/**
 * tauri.conf 三通道结构断言 + AF-3 连接面判据（T3.1 脚本级测试）。
 *
 * - 三通道（TR-AD-34 禁错位）：externalBin = daemon 单文件（target-triple 自动解析）；
 *   bundle.resources = rg；frontendDist = shell vite dist 产物目录。
 * - AF-3 判据：daemon 默认端口 7333（禁 port 0 随机）；前端走 env.ts 既有通路
 *   （VITE_HELIX_PORT 缺省 7333 + /helix-dev-token）；壳零连接参数注入，env 注入面
 *   仅 HELIX_RG_PATH。
 */
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const srcTauri = join(root, "apps/shell/src-tauri");
const conf = JSON.parse(readFileSync(join(srcTauri, "tauri.conf.json"), "utf8"));

describe("tauri.conf 三通道接线（TR-AD-34）", () => {
  test("externalBin = binaries/helix-daemon（target-triple 自动解析）", () => {
    expect(conf.bundle.externalBin).toEqual(["binaries/helix-daemon"]);
  });

  test("bundle.resources 含 resources/bin/rg 与 codegraph 树，包内落位 Resources/bin/rg + Resources/codegraph", () => {
    const resources = conf.bundle.resources;
    // map 形式显式固定包内目标位（slice 形式会保留 resources/ 前缀落到
    // Resources/resources/bin/rg，与壳 main.rs 的 Resources/bin/rg 定位错位）
    expect(resources).toEqual({
      "resources/bin/rg": "bin/rg",
      "resources/codegraph": "codegraph",
    });
  });

  test("frontendDist = shell vite build 产物目录（apps/shell/dist）", () => {
    expect(conf.build.frontendDist).toBe("../dist");
  });

  test("三类资源不错位：rg 不进 externalBin；daemon 不进 resources；前端产物不手工拷贝", () => {
    expect(JSON.stringify(conf.bundle.externalBin)).not.toContain("rg");
    expect(JSON.stringify(conf.bundle.resources)).not.toContain("daemon");
    // 前端产物只能经 frontendDist 通道，不得出现在 resources
    expect(JSON.stringify(conf.bundle.resources)).not.toContain("dist");
  });

  test("bundle targets 仅 macOS 格式（arm64 only 分发面，AD-6）", () => {
    expect(conf.bundle.targets).toEqual(["app", "dmg"]);
  });

  test("externalBin 命名符合 target-triple 约定（T2.2 产物位，TR-95 双档）", () => {
    const binariesDir = join(srcTauri, "binaries");
    // mac 档产物必在（本仓构建宿主档）；windows 档交叉编译产物可选在
    expect(existsSync(join(binariesDir, "helix-daemon-aarch64-apple-darwin"))).toBe(true);
    // TR-95 反向断言：只允许裁决双档 triple 变体，不得有其他变体
    const known = [
      "helix-daemon-aarch64-apple-darwin",
      "helix-daemon-x86_64-pc-windows-msvc.exe",
    ];
    const variants = readdirSync(binariesDir).filter((f) => f.startsWith("helix-daemon"));
    for (const v of variants) expect(known).toContain(v);
  });
});

describe("AF-3 连接面判据", () => {
  test("daemon 默认端口 7333（打包形态禁 port 0 随机）", () => {
    const config = readFileSync(join(root, "apps/daemon/src/infrastructure/config.ts"), "utf8");
    expect(config).toContain("DEFAULT_PORT = 7333");
    // sidecar 分发不覆写端口为 0
    const main = readFileSync(join(root, "apps/daemon/src/main.ts"), "utf8");
    expect(main).not.toMatch(/port\s*[:=]\s*0[^0-9]/);
  });

  test("前端走既有 env.ts 通路（VITE_HELIX_PORT 缺省 7333 + /helix-dev-token）", () => {
    const envTs = readFileSync(join(root, "apps/shell/src/shared/config/env.ts"), "utf8");
    expect(envTs).toContain("VITE_HELIX_PORT");
    expect(envTs).toContain("7333");
    const helixWs = readFileSync(join(root, "apps/shell/src/shared/api/helix-ws.ts"), "utf8");
    expect(helixWs).toContain("/helix-dev-token");
  });

  test("壳零连接参数注入：env 注入面仅 HELIX_RG_PATH（契约 §1）", () => {
    const mainRs = readFileSync(join(srcTauri, "src/main.rs"), "utf8");
    const libRs = readFileSync(join(srcTauri, "src/lib.rs"), "utf8");
    const shell = mainRs + libRs;
    expect(libRs).toContain('env("HELIX_RG_PATH"');
    // 壳不得注入任何前端连接参数（VITE_HELIX_PORT / token / 端口）
    expect(shell).not.toContain("VITE_HELIX_PORT");
    expect(shell).not.toContain("HELIX_PORT");
    expect(shell).not.toContain("HELIX_TOKEN");
  });
});
