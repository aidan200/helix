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
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  RG_TARBALL_SHA256,
  assertArm64Only,
  assertPeX64,
  downloadToFile,
  installFromArchive,
  installFromLocal,
  rgAsset,
  rgDest,
} from "./fetch-rg";

/** 合成最小 PE 头（MZ + e_lfanew + PE\0\0 + Machine），assertPeX64 测试夹具。 */
function fakePe(machine: number): Buffer {
  const b = Buffer.alloc(0x100);
  b.write("MZ", 0, "latin1");
  b.writeUInt32LE(0x80, 0x3c); // e_lfanew
  b.write("PE\0\0", 0x80, "latin1");
  b.writeUInt16LE(machine, 0x84); // Machine 字段
  return b;
}

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
  test("sha256 不符即失败删档，rg 不落位（mac 档）", async () => {
    const dir = tmp();
    const tarball = join(dir, "fake.tar.gz");
    writeFileSync(tarball, "not-the-real-ripgrep-tarball");
    const dest = join(dir, "bin/rg");

    await expect(installFromArchive(tarball, dest)).rejects.toThrow(/sha256/);
    expect(existsSync(tarball)).toBe(false); // 删档
    expect(existsSync(dest)).toBe(false); // 不落位
  });

  test("sha256 不符即失败删档（windows 档走 win pin）", async () => {
    const dir = tmp();
    const zip = join(dir, "fake.zip");
    writeFileSync(zip, "not-the-real-ripgrep-zip");
    const dest = join(dir, "bin/rg.exe");

    await expect(installFromArchive(zip, dest, "windows-x64")).rejects.toThrow(/sha256/);
    expect(existsSync(zip)).toBe(false);
    expect(existsSync(dest)).toBe(false);
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

  test("双档资产：15.1.0 双档名/格式/URL/sha256 分档（TR-95）", () => {
    const mac = rgAsset("darwin-arm64");
    expect(mac.name).toBe("ripgrep-15.1.0-aarch64-apple-darwin.tar.gz");
    expect(mac.format).toBe("tar.gz");
    expect(mac.sha256).toMatch(/^[0-9a-f]{64}$/);
    const win = rgAsset("windows-x64");
    expect(win.name).toBe("ripgrep-15.1.0-x86_64-pc-windows-msvc.zip");
    expect(win.format).toBe("zip");
    expect(win.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(win.sha256).not.toBe(mac.sha256);
    expect(win.url).toContain("x86_64-pc-windows-msvc.zip");
  });

  test("落位随平台分档：rg / rg.exe", () => {
    expect(rgDest("darwin-arm64")).toMatch(/resources\/bin\/rg$/);
    expect(rgDest("windows-x64")).toMatch(/resources\/bin\/rg\.exe$/);
  });
});

describe("fetch-rg：windows 档 PE 断言（lipo 的 Windows 等价物）", () => {
  test("x64 PE（Machine=0x8664）→ 通过", () => {
    const dir = tmp();
    const exe = join(dir, "rg.exe");
    writeFileSync(exe, fakePe(0x8664));
    expect(() => assertPeX64(exe)).not.toThrow();
  });

  test("非 PE（缺 MZ）→ 拒绝", () => {
    const dir = tmp();
    const fake = join(dir, "rg.exe");
    writeFileSync(fake, "#!/bin/sh\necho not-a-pe\n");
    expect(() => assertPeX64(fake)).toThrow(/MZ/);
  });

  test("arm64 PE（Machine=0xAA64）→ 拒绝（TR-95 win 不 arm64）", () => {
    const dir = tmp();
    const exe = join(dir, "rg.exe");
    writeFileSync(exe, fakePe(0xaa64));
    expect(() => assertPeX64(exe)).toThrow(/0x8664/);
  });

  test("x86 PE（Machine=0x014C）→ 拒绝", () => {
    const dir = tmp();
    const exe = join(dir, "rg.exe");
    writeFileSync(exe, fakePe(0x014c));
    expect(() => assertPeX64(exe)).toThrow(/0x8664/);
  });

  test("缺 PE 签名（MZ 在、PE\\0\\0 不在）→ 拒绝", () => {
    const dir = tmp();
    const exe = join(dir, "rg.exe");
    const b = fakePe(0x8664);
    b.write("PX\0\0", 0x80, "latin1"); // 破坏签名
    writeFileSync(exe, b);
    expect(() => assertPeX64(exe)).toThrow(/PE/);
  });
});

describe("fetch-rg：windows 档 --from 本地拷贝", () => {
  test("非 PE 源即拒绝，rg.exe 不落位", async () => {
    const dir = tmp();
    const fake = join(dir, "rg-src.exe");
    writeFileSync(fake, "plain text, not a PE");
    const dest = join(dir, "bin/rg.exe");

    await expect(installFromLocal(fake, dest, "windows-x64")).rejects.toThrow(/PE|MZ/);
    expect(existsSync(dest)).toBe(false);
  });

  test("x64 PE 源拷贝成功（无 lipo/chmod 要求）+ 幂等跳过", async () => {
    const dir = tmp();
    const src = join(dir, "rg-src.exe");
    writeFileSync(src, fakePe(0x8664));
    const dest = join(dir, "bin/rg.exe");

    const result = await installFromLocal(src, dest, "windows-x64");
    expect(result.skipped).toBe(false);
    expect(existsSync(dest)).toBe(true);
    assertPeX64(dest); // 落位后再独立确认

    const again = await installFromLocal(src, dest, "windows-x64");
    expect(again.skipped).toBe(true);
  });
});

describe("fetch-rg：downloadToFile 下载面（超时/停滞/重试/进度）", () => {
  const payload = Buffer.alloc(9 * 1024 * 1024, 7); // 9MB：跨过 8MB 进度日志线

  /** 起临时 HTTP server，返回 [port, close]。 */
  async function serve(handler: () => Response): Promise<[number, () => Promise<void>]> {
    const server = Bun.serve({ port: 0, fetch: handler });
    return [server.port, () => server.stop(true)];
  }

  test("happy path：字节流完整落盘（含 8MB 进度日志线）", async () => {
    const [port, close] = await serve(() => new Response(payload));
    try {
      const dest = join(tmp(), "dl.bin");
      await downloadToFile(`http://127.0.0.1:${port}/a`, dest, {
        label: "t-happy",
        backoffMs: 1,
        stallTimeoutMs: 5_000,
      });
      expect(statSync(dest).size).toBe(payload.length);
      expect(Buffer.compare(readFileSync(dest), payload)).toBe(0);
    } finally {
      await close();
    }
  });

  test("停滞检测：流发一块后静默不 close → 判停滞失败，半成品删除", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2, 3]));
        // 故意不 close：模拟 TCP 半死（连接在、数据停）
      },
    });
    const [port, close] = await serve(() => new Response(stream));
    try {
      const dest = join(tmp(), "dl-stall.bin");
      await expect(
        downloadToFile(`http://127.0.0.1:${port}/b`, dest, {
          label: "t-stall",
          stallTimeoutMs: 150,
          retries: 1,
          backoffMs: 1,
        }),
      ).rejects.toThrow(/停滞|重试耗尽/);
      expect(existsSync(dest)).toBe(false); // 半成品不残留
    } finally {
      await close();
    }
  });

  test("重试：首次 500 次次 200 → 第二次成功", async () => {
    let n = 0;
    const [port, close] = await serve(() => {
      n++;
      return n === 1 ? new Response("boom", { status: 500 }) : new Response("yes");
    });
    try {
      const dest = join(tmp(), "dl-retry.bin");
      await downloadToFile(`http://127.0.0.1:${port}/c`, dest, {
        label: "t-retry",
        retries: 3,
        backoffMs: 1,
        stallTimeoutMs: 5_000,
      });
      expect(readFileSync(dest, "utf8")).toBe("yes");
      expect(n).toBe(2);
    } finally {
      await close();
    }
  });

  test("重试耗尽：恒 500 → 报重试耗尽，不落盘", async () => {
    const [port, close] = await serve(() => new Response("no", { status: 503 }));
    try {
      const dest = join(tmp(), "dl-exhaust.bin");
      await expect(
        downloadToFile(`http://127.0.0.1:${port}/d`, dest, {
          label: "t-exhaust",
          retries: 2,
          backoffMs: 1,
        }),
      ).rejects.toThrow(/重试耗尽/);
      expect(existsSync(dest)).toBe(false);
    } finally {
      await close();
    }
  });
});
