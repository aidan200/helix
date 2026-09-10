import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, existsSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { parseSandboxConfig } from "../../src/domain/sandbox/SandboxPolicy";
import { buildSeatbeltProfile } from "../../src/domain/sandbox/seatbeltProfile";

/**
 * macOS Seatbelt 真机行为测试（codex 测试矩阵同款——真 spawn /usr/bin/sandbox-exec
 * 断言放行/拒绝，非 mock）。非 darwin 平台整体 skip（沙箱第一版 macOS only）。
 *
 * fixture：tmpdir 里建 workspace + 假 helix home 两个可写根；行为断言：
 * 写根内 ✓ / 写真 $HOME（根外）✗ 含 Operation not permitted / 读全盘 ✓。
 *
 * 嵌套沙箱防御（codex nested-skip 同构）：测试进程自身已在 Seatbelt 沙箱内
 * 时（如 daemon 开沙箱后从 bash 工具跑测试），内层 sandbox-exec 的
 * sandbox_apply 被 macOS 拒（exit 71 Operation not permitted）——整体 skip
 * 打印原因，不假红。
 */

const isDarwin = process.platform === "darwin";

/** 内层可用性探测：最小 profile 真跑一次（sandbox_apply 被拒 → 嵌套环境）。 */
function seatbeltApplicable(): boolean {
  if (!isDarwin) return false;
  try {
    const res = spawnSync("/usr/bin/sandbox-exec", ["-p", "(version 1)(allow default)", "--", "/usr/bin/true"], {
      encoding: "utf-8",
      timeout: 5_000,
    });
    return res.status === 0;
  } catch {
    return false;
  }
}

const applicable = seatbeltApplicable();

describe.skipIf(!isDarwin || !applicable)("Seatbelt 真机行为", () => {
  let workspace: string;
  let helixHome: string;
  let profile: string;
  let cleanupRoots: string[];

  beforeAll(() => {
    cleanupRoots = [];
    // realpath 归一：tmpdir() 的 /var/folders 是 /private/var/folders 符号链接
    workspace = realpathSync(mkdtempSync(path.join(tmpdir(), "helix-sbx-ws-")));
    helixHome = realpathSync(mkdtempSync(path.join(tmpdir(), "helix-sbx-home-")));
    cleanupRoots.push(workspace, helixHome);
    // 对齐装配层语义（readSandboxRuntime）：roots realpath + per-user tmpdir 追加
    const policy = parseSandboxConfig({ enabled: true }, workspace, helixHome);
    profile = buildSeatbeltProfile({
      ...policy,
      writableRoots: [...policy.writableRoots, realpathSync(tmpdir())],
    });
  });

  afterAll(() => {
    for (const dir of cleanupRoots) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        /* 兑底清理 */
      }
    }
  });

  /** 沙箱内执行（-p 内联 profile）。 */
  function sandboxExec(cmd: string): { status: number | null; stdout: string; stderr: string } {
    const res = spawnSync("/usr/bin/sandbox-exec", ["-p", profile, "--", "/bin/bash", "-c", cmd], {
      encoding: "utf-8",
      timeout: 15_000,
    });
    return { status: res.status, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
  }

  test("写可写根内（workspace）：放行且落盘", () => {
    const target = path.join(workspace, "ok.txt");
    const r = sandboxExec(`echo hello > ${JSON.stringify(target)}`);
    expect(r.status).toBe(0);
    expect(existsSync(target)).toBe(true);
    expect(readFileSync(target, "utf-8").trim()).toBe("hello");
  });

  test("写可写根内（假 helix home）：放行", () => {
    const target = path.join(helixHome, "reports", "x.md");
    const r = sandboxExec(`mkdir -p ${JSON.stringify(path.join(helixHome, "reports"))} && echo r > ${JSON.stringify(target)}`);
    expect(r.status).toBe(0);
    expect(existsSync(target)).toBe(true);
  });

  test("写根外（真 $HOME 下）：拒绝且含 Operation not permitted", () => {
    const target = path.join(process.env["HOME"] ?? "/Users", `.helix-sbx-deny-${Date.now()}.txt`);
    const r = sandboxExec(`echo evil > ${JSON.stringify(target)}`);
    expect(r.status).not.toBe(0);
    expect(r.stderr.toLowerCase()).toContain("operation not permitted");
    expect(existsSync(target)).toBe(false);
  });

  test("写根外（系统 tmp 之外的受保护路径 /private/etc）：拒绝", () => {
    const r = sandboxExec(`echo evil > /private/etc/helix-sbx-deny-test`);
    expect(r.status).not.toBe(0);
  });

  test("读全盘（/etc/hosts）：放行（读面不设限）", () => {
    const r = sandboxExec("cat /etc/hosts > /dev/null && echo READ_OK");
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("READ_OK");
  });

  test("系统 scratch（/tmp）放行：SCRATCH 段生效", () => {
    const marker = path.join(tmpdir(), `helix-sbx-scratch-${Date.now()}.txt`);
    const r = sandboxExec(`echo t > ${JSON.stringify(marker)}`);
    expect(r.status).toBe(0);
    expect(existsSync(marker)).toBe(true);
    rmSync(marker, { force: true });
  });

  test("子进程继承沙箱（孙进程写根外同样拒绝）", () => {
    const target = path.join(process.env["HOME"] ?? "/Users", `.helix-sbx-deny-child-${Date.now()}.txt`);
    // 内层再起 /bin/sh —— 沙箱策略随进程继承
    const r = sandboxExec(`/bin/bash -c "echo evil > ${JSON.stringify(target)}"`);
    expect(r.status).not.toBe(0);
    expect(existsSync(target)).toBe(false);
  });

  test("进程常规操作不误伤（uname/env/which 探测类）", () => {
    const r = sandboxExec("uname -a > /dev/null && /usr/bin/env > /dev/null && which bash > /dev/null && echo PROBE_OK");
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("PROBE_OK");
  });
});
