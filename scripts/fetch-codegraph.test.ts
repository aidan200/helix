/**
 * fetch-codegraph 单测（bundle-only 定位改造，镜像 fetch-rg.test.ts 面）。
 *
 * RED 面：
 * - sha256 不匹配即失败删档（不落位、不残留）；
 * - `--from` 源缺 vendored node / node 非 arm64 / 缺 launcher / 缺 lib/dist
 *   即拒绝（三锚守护）；
 * - 幂等：已存在且守护通过则跳过。
 *
 * 测试全在临时目录注入 destDir，不触碰真实 resources/codegraph。
 * arm64 正例 node 源 = process.execPath（bun 自身，目标平台 arm64 only，AD-6）。
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  CODEGRAPH_TARBALL_SHA256,
  assertBundleTree,
  codegraphAsset,
  codegraphLauncher,
  installFromArchive,
  installFromLocal,
} from "./fetch-codegraph";

/** 合成最小 PE 头（x64），windows 档 bundle node.exe 夹具。 */
function fakePeX64(): Buffer {
  const b = Buffer.alloc(0x100);
  b.write("MZ", 0, "latin1");
  b.writeUInt32LE(0x80, 0x3c);
  b.write("PE\0\0", 0x80, "latin1");
  b.writeUInt16LE(0x8664, 0x84);
  return b;
}

const tmpDirs: string[] = [];

function tmp(): string {
  const dir = mkdtempSync(join(tmpdir(), "helix-fetch-codegraph-test-"));
  tmpDirs.push(dir);
  return dir;
}

/** 构造假 bundle 树（node 用 bun 自身顶 arm64 Mach-O，launcher/lib 就位）。 */
function makeFakeBundle(dir: string): string {
  const bundle = join(dir, "codegraph-darwin-arm64");
  mkdirSync(join(bundle, "bin"), { recursive: true });
  mkdirSync(join(bundle, "lib", "dist"), { recursive: true });
  writeFileSync(join(bundle, "node"), require("node:fs").readFileSync(process.execPath));
  writeFileSync(join(bundle, "bin", "codegraph"), "#!/bin/sh\nexec \"$(dirname \"$0\")/../node\" \"$(dirname \"$0\")/../lib/dist/bin/codegraph.js\" \"$@\"\n");
  return bundle;
}

afterEach(() => {
  while (tmpDirs.length) rmSync(tmpDirs.pop()!, { recursive: true, force: true });
});

describe("fetch-codegraph：sha256 校验", () => {
  test("sha256 不符即失败删档，bundle 不落位", async () => {
    const dir = tmp();
    const tarball = join(dir, "fake.tar.gz");
    writeFileSync(tarball, "not-the-real-codegraph-tarball");
    const dest = join(dir, "codegraph");

    await expect(installFromArchive(tarball, dest)).rejects.toThrow(/sha256/);
    expect(existsSync(tarball)).toBe(false); // 删档
    expect(existsSync(dest)).toBe(false); // 不落位
  });

  test("sha256 不符即失败删档（windows 档走 win pin）", async () => {
    const dir = tmp();
    const zip = join(dir, "fake.zip");
    writeFileSync(zip, "not-the-real-codegraph-zip");
    const dest = join(dir, "codegraph");

    await expect(installFromArchive(zip, dest, "windows-x64")).rejects.toThrow(/sha256/);
    expect(existsSync(zip)).toBe(false);
    expect(existsSync(dest)).toBe(false);
  });
});

describe("fetch-codegraph：三锚守护", () => {
  test("缺 vendored node → 拒绝", async () => {
    const dir = tmp();
    const bundle = join(dir, "bad-bundle");
    mkdirSync(join(bundle, "bin"), { recursive: true });
    mkdirSync(join(bundle, "lib", "dist"), { recursive: true });
    writeFileSync(join(bundle, "bin", "codegraph"), "#!/bin/sh\n");
    await expect(assertBundleTree(bundle)).rejects.toThrow(/node/);
  });

  test("node 非 arm64（非 Mach-O）→ 拒绝", async () => {
    const dir = tmp();
    const bundle = makeFakeBundle(dir);
    writeFileSync(join(bundle, "node"), "plain text, lipo will fail");
    await expect(assertBundleTree(bundle)).rejects.toThrow();
  });

  test("缺 launcher → 拒绝", async () => {
    const dir = tmp();
    const bundle = makeFakeBundle(dir);
    rmSync(join(bundle, "bin", "codegraph"));
    await expect(assertBundleTree(bundle)).rejects.toThrow(/launcher/);
  });

  test("缺 lib/dist → 拒绝（树不完整）", async () => {
    const dir = tmp();
    const bundle = makeFakeBundle(dir);
    rmSync(join(bundle, "lib"), { recursive: true });
    await expect(assertBundleTree(bundle)).rejects.toThrow(/lib\/dist/);
  });

  test("launcher 无执行位 → chmod 保底通过", async () => {
    const dir = tmp();
    const bundle = makeFakeBundle(dir);
    const launcher = join(bundle, "bin", "codegraph");
    require("node:fs").chmodSync(launcher, 0o644); // 模拟 --from 丢权限位
    await assertBundleTree(bundle);
    expect(statSync(launcher).mode & 0o111).not.toBe(0);
  });
});

describe("fetch-codegraph：--from 本地目录拷贝", () => {
  test("源不是目录 → 拒绝", async () => {
    const dir = tmp();
    await expect(installFromLocal(join(dir, "no-such"), join(dir, "dest"))).rejects.toThrow(
      /bundle 目录/,
    );
  });

  test("合法 bundle 树拷贝成功（守护通过）", async () => {
    const dir = tmp();
    const bundle = makeFakeBundle(dir);
    const dest = join(dir, "resources", "codegraph");

    const result = await installFromLocal(bundle, dest);
    expect(result.skipped).toBe(false);
    expect(existsSync(join(dest, "bin", "codegraph"))).toBe(true);
    expect(statSync(join(dest, "bin", "codegraph")).mode & 0o111).not.toBe(0);
    await assertBundleTree(dest);
  });

  test("幂等：已存在且守护通过则跳过（不覆盖）", async () => {
    const dir = tmp();
    const bundle = makeFakeBundle(dir);
    const dest = join(dir, "resources", "codegraph");

    await installFromLocal(bundle, dest);
    const mtime = statSync(join(dest, "bin", "codegraph")).mtimeMs;

    const again = await installFromLocal(bundle, dest);
    expect(again.skipped).toBe(true);
    expect(statSync(join(dest, "bin", "codegraph")).mtimeMs).toBe(mtime); // 未被重写
  });
});

describe("fetch-codegraph：版本 pin", () => {
  test("sha256 常量形如 64 位十六进制（pin 值已就位，非占位）", () => {
    expect(CODEGRAPH_TARBALL_SHA256).toMatch(/^[0-9a-f]{64}$/);
  });

  test("双档资产：v1.6.0 双档名/格式/URL/sha256 分档（TR-95）", () => {
    const mac = codegraphAsset("darwin-arm64");
    expect(mac.name).toBe("codegraph-darwin-arm64.tar.gz");
    expect(mac.format).toBe("tar.gz");
    expect(mac.sha256).toMatch(/^[0-9a-f]{64}$/);
    const win = codegraphAsset("windows-x64");
    expect(win.name).toBe("codegraph-win32-x64.zip");
    expect(win.format).toBe("zip");
    expect(win.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(win.sha256).not.toBe(mac.sha256);
    expect(win.url).toContain("codegraph-win32-x64.zip");
  });

  test("launcher 路径随平台分档：bin/codegraph / bin/codegraph.cmd", () => {
    expect(codegraphLauncher("darwin-arm64")).toMatch(/bin\/codegraph$/);
    expect(codegraphLauncher("windows-x64")).toMatch(/bin\/codegraph\.cmd$/);
  });
});

describe("fetch-codegraph：windows 档三锚守护（TR-95 win32-x64 bundle）", () => {
  /** 构造假 windows bundle 树（node.exe = 合成 PE，launcher = codegraph.cmd）。 */
  function makeFakeWindowsBundle(dir: string): string {
    const bundle = join(dir, "codegraph-win32-x64");
    mkdirSync(join(bundle, "bin"), { recursive: true });
    mkdirSync(join(bundle, "lib", "dist"), { recursive: true });
    writeFileSync(join(bundle, "node.exe"), fakePeX64());
    writeFileSync(
      join(bundle, "bin", "codegraph.cmd"),
      '@"%~dp0..\\node.exe" "%~dp0..\\lib\\dist\\bin\\codegraph.js" %*\r\n',
    );
    return bundle;
  }

  test("合法 windows bundle 树守护通过（node.exe PE x64 + .cmd + lib/dist）", async () => {
    const dir = tmp();
    const bundle = makeFakeWindowsBundle(dir);
    await expect(assertBundleTree(bundle, "windows-x64")).resolves.toBeUndefined();
  });

  test("缺 node.exe → 拒绝", async () => {
    const dir = tmp();
    const bundle = makeFakeWindowsBundle(dir);
    rmSync(join(bundle, "node.exe"));
    await expect(assertBundleTree(bundle, "windows-x64")).rejects.toThrow(/node/);
  });

  test("node.exe 非 PE → 拒绝", async () => {
    const dir = tmp();
    const bundle = makeFakeWindowsBundle(dir);
    writeFileSync(join(bundle, "node.exe"), "plain text, not a PE");
    await expect(assertBundleTree(bundle, "windows-x64")).rejects.toThrow();
  });

  test("缺 bin/codegraph.cmd → 拒绝", async () => {
    const dir = tmp();
    const bundle = makeFakeWindowsBundle(dir);
    rmSync(join(bundle, "bin", "codegraph.cmd"));
    await expect(assertBundleTree(bundle, "windows-x64")).rejects.toThrow(/launcher/);
  });

  test("缺 lib/dist → 拒绝（树不完整）", async () => {
    const dir = tmp();
    const bundle = makeFakeWindowsBundle(dir);
    rmSync(join(bundle, "lib"), { recursive: true });
    await expect(assertBundleTree(bundle, "windows-x64")).rejects.toThrow(/lib\/dist/);
  });

  test("--from 拷贝成功（windows 档无执行位要求）+ 幂等跳过", async () => {
    const dir = tmp();
    const bundle = makeFakeWindowsBundle(dir);
    const dest = join(dir, "resources", "codegraph");

    const result = await installFromLocal(bundle, dest, "windows-x64");
    expect(result.skipped).toBe(false);
    expect(existsSync(join(dest, "bin", "codegraph.cmd"))).toBe(true);
    expect(existsSync(join(dest, "node.exe"))).toBe(true);
    await assertBundleTree(dest, "windows-x64");

    const again = await installFromLocal(bundle, dest, "windows-x64");
    expect(again.skipped).toBe(true);
  });

  test("windows 树混 mac 档守护 → 拒绝（档错配不错位）", async () => {
    const dir = tmp();
    const bundle = makeFakeWindowsBundle(dir);
    // mac 档守护要求根 node（Mach-O）——windows 树只有 node.exe → 拒
    await expect(assertBundleTree(bundle, "darwin-arm64")).rejects.toThrow();
  });
});
