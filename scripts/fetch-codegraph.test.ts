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
  installFromLocal,
  installFromTarball,
} from "./fetch-codegraph";

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

    await expect(installFromTarball(tarball, dest)).rejects.toThrow(/sha256/);
    expect(existsSync(tarball)).toBe(false); // 删档
    expect(existsSync(dest)).toBe(false); // 不落位
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
});
