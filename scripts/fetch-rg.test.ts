/**
 * fetch-rg 单测（T3.1，test-design §CL-2/F2.3 smoke 面映射）。
 *
 * RED 面（brief TDD 测试点）：
 * - sha256 不匹配即失败删档（不落位、不残留）；
 * - `--from` 拷贝非 arm64 即拒绝（lipo 断言，AD-6 反向守护）；
 * - 幂等：已存在且校验通过则跳过。
 *
 * 测试全在临时目录注入 dest，不触碰真实 resources/bin/rg。
 * arm64 正例源 = process.execPath（bun 自身，本任务目标平台 arm64 only，AD-6）。
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  RG_TARBALL_SHA256,
  assertArm64Only,
  installFromLocal,
  installFromTarball,
} from "./fetch-rg";

const tmpDirs: string[] = [];

function tmp(): string {
  const dir = mkdtempSync(join(tmpdir(), "helix-fetch-rg-test-"));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tmpDirs.length) rmSync(tmpDirs.pop()!, { recursive: true, force: true });
});

describe("fetch-rg：sha256 校验", () => {
  test("sha256 不符即失败删档，rg 不落位", async () => {
    const dir = tmp();
    const tarball = join(dir, "fake.tar.gz");
    writeFileSync(tarball, "not-the-real-ripgrep-tarball");
    const dest = join(dir, "bin/rg");

    await expect(installFromTarball(tarball, dest)).rejects.toThrow(/sha256/);
    expect(existsSync(tarball)).toBe(false); // 删档
    expect(existsSync(dest)).toBe(false); // 不落位
  });

  test("assertArm64Only 拒绝非 Mach-O 文件", async () => {
    const dir = tmp();
    const fake = join(dir, "rg");
    writeFileSync(fake, "#!/bin/sh\necho not-a-macho\n");
    await expect(assertArm64Only(fake)).rejects.toThrow();
  });
});

describe("fetch-rg：--from 本地拷贝", () => {
  test("非 arm64 源即拒绝，rg 不落位", async () => {
    const dir = tmp();
    const fake = join(dir, "rg-src");
    writeFileSync(fake, "plain text, lipo will fail");
    const dest = join(dir, "bin/rg");

    await expect(installFromLocal(fake, dest)).rejects.toThrow(/arm64|lipo/);
    expect(existsSync(dest)).toBe(false);
  });

  test("arm64 源拷贝成功（chmod +x + lipo 断言通过）", async () => {
    const dir = tmp();
    const dest = join(dir, "bin/rg");

    const result = await installFromLocal(process.execPath, dest);
    expect(result.skipped).toBe(false);
    expect(existsSync(dest)).toBe(true);
    // chmod +x 落位
    expect(statSync(dest).mode & 0o111).not.toBe(0);
    // lipo 断言 arm64（已通过 installFromLocal 内部断言，此处再独立确认）
    await assertArm64Only(dest);
  });

  test("幂等：已存在且校验通过则跳过（不覆盖）", async () => {
    const dir = tmp();
    const dest = join(dir, "bin/rg");

    await installFromLocal(process.execPath, dest);
    const mtime = statSync(dest).mtimeMs;

    const again = await installFromLocal(process.execPath, dest);
    expect(again.skipped).toBe(true);
    expect(statSync(dest).mtimeMs).toBe(mtime); // 未被重写
  });
});

describe("fetch-rg：版本 pin", () => {
  test("sha256 常量形如 64 位十六进制（pin 值已就位，非占位）", () => {
    expect(RG_TARBALL_SHA256).toMatch(/^[0-9a-f]{64}$/);
  });
});
