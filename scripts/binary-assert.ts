/**
 * binary-assert —— 平台架构断言单点（桌面管线守护面）。
 *
 * 自 fetch-rg.ts 迁入（fetch-rg 保 re-export 兼容面）：断言是「二进制形态
 * 守护」而非「获取」，与 rg 资产面正交——compile-daemon（编译产物）、
 * fetch-rg / fetch-codegraph（落位资产）三方共消费，独立模块消散落。
 * 双档断言形态（TR-95）：darwin-arm64 走 lipo（Mach-O 单架构）、
 * windows-x64 走 PE 头（Machine=0x8664）。
 *
 * 纯只读断言面，零网络零落盘副作用。工程层脚本，不被 apps 任何层
 * import（架构 §5.2）。
 */
import { openSync, readSync, closeSync } from "node:fs";

import { platformSpec, type DesktopPlatform } from "./desktop-platform";

/**
 * lipo -info 断言 arm64 单架构（darwin 档反向断言）。
 * 非 Mach-O（lipo 非零退出）/ 含 x86_64 切片 / 缺 arm64 → 抛错。
 */
export async function assertArm64Only(path: string): Promise<void> {
  const proc = Bun.spawn({
    cmd: ["lipo", "-info", path],
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0) {
    throw new Error(`lipo -info 失败（非 Mach-O 二进制？）：${path}：${err.trim() || out.trim()}`);
  }
  const info = out.trim().toLowerCase();
  if (!info.includes("arm64") || info.includes("x86_64")) {
    throw new Error(`arm64 单架构断言失败（AD-6）：${path} → ${out.trim()}`);
  }
}

/**
 * PE x64 断言（windows-x64 档反向断言，lipo 的 Windows 等价物）：
 * MZ 魔数 → e_lfanew(0x3C) → "PE\0\0" 签名 → Machine 字段必须 0x8664（x64）。
 * 非 PE / 截断头 / 非 x64（x86=0x014C、arm64=0xAA64）→ 抛错。同步只读头 6 字节级。
 */
export function assertPeX64(path: string): void {
  const fd = openSync(path, "r");
  try {
    const dos = Buffer.alloc(0x40);
    if (readSync(fd, dos, 0, 0x40, 0) < 0x40 || dos.toString("latin1", 0, 2) !== "MZ") {
      throw new Error(`PE 断言失败（非 PE 二进制，缺 MZ 魔数）：${path}`);
    }
    const peOffset = dos.readUInt32LE(0x3c);
    const pe = Buffer.alloc(6);
    if (
      readSync(fd, pe, 0, 6, peOffset) < 6 ||
      pe.toString("latin1", 0, 4) !== "PE\0\0"
    ) {
      throw new Error(`PE 断言失败（缺 PE\\0\\0 签名）：${path}`);
    }
    const machine = pe.readUInt16LE(4);
    if (machine !== 0x8664) {
      throw new Error(
        `PE x64 断言失败（TR-95 win32-x64 only）：${path} → Machine=0x${machine.toString(16)}（期望 0x8664）`,
      );
    }
  } finally {
    closeSync(fd);
  }
}

/** 平台分档二进制断言单点（lipo 仅 mac；windows 走 PE x64）。 */
export async function assertBinaryForPlatform(
  path: string,
  platform: DesktopPlatform,
): Promise<void> {
  if (platformSpec(platform).isWindows) {
    assertPeX64(path);
  } else {
    await assertArm64Only(path);
  }
}
