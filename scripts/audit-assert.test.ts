/**
 * audit-assert ①节 bun audit 重试环单测（code-review M13 批 #2.40）：
 * - executable = process.execPath（不写死 "bun" 走 PATH）；
 * - spawnSync 带 timeout 兜底（TCP 半死防永久挂起，TR-104 同类面）；
 * - 超时杀（exitCode=null）按「请求失败」口径入重试，非漏洞检出；
 * - 真漏洞检出不重试（requestFailed=false）。
 * 注入假 spawnSync 全分支单测，不真起 bun audit（不联网）。
 */
import { describe, expect, test } from "bun:test";

import {
  AUDIT_TIMEOUT_MS,
  runAuditAttempt,
  type AuditSpawnSync,
} from "./audit-assert";

/** 假 spawnSync：固定结果 + 记录实参（cmd/opts 断言用）。 */
function fakeSpawn(result: { exitCode: number | null; stdout?: string; stderr?: string }) {
  const calls: Array<{ cmd: string[]; opts: { cwd: string; timeout: number } }> = [];
  const spawn: AuditSpawnSync = (cmd, opts) => {
    calls.push({ cmd, opts });
    return {
      exitCode: result.exitCode,
      stdout: Buffer.from(result.stdout ?? ""),
      stderr: Buffer.from(result.stderr ?? ""),
    };
  };
  return { spawn, calls };
}

describe("runAuditAttempt（①节单次尝试，M13 批 #2.40）", () => {
  test("零漏洞（exit 0 + No vulnerabilities found）→ ok", () => {
    const { spawn } = fakeSpawn({ exitCode: 0, stdout: "No vulnerabilities found" });
    const r = runAuditAttempt("/tmp", spawn);
    expect(r.ok).toBe(true);
    expect(r.requestFailed).toBe(false);
  });

  test("executable = process.execPath 且 spawnSync 携带 timeout=AUDIT_TIMEOUT_MS(120s)", () => {
    const { spawn, calls } = fakeSpawn({ exitCode: 0, stdout: "No vulnerabilities found" });
    runAuditAttempt("/tmp/ws", spawn);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.cmd).toEqual([process.execPath, "audit"]);
    expect(calls[0]!.opts).toEqual({ cwd: "/tmp/ws", timeout: 120_000 });
    expect(AUDIT_TIMEOUT_MS).toBe(120_000);
  });

  test("超时杀（exitCode=null，空输出）→ requestFailed=true（入重试，非漏洞检出）", () => {
    const { spawn } = fakeSpawn({ exitCode: null });
    const r = runAuditAttempt("/tmp", spawn);
    expect(r.ok).toBe(false);
    expect(r.requestFailed).toBe(true);
  });

  test("请求失败（audit request failed）→ requestFailed=true（入重试）", () => {
    const { spawn } = fakeSpawn({ exitCode: 1, stderr: "error: audit request failed" });
    const r = runAuditAttempt("/tmp", spawn);
    expect(r.ok).toBe(false);
    expect(r.requestFailed).toBe(true);
  });

  test("真漏洞检出（非请求类失败）→ requestFailed=false（不重试直接红）", () => {
    const { spawn } = fakeSpawn({ exitCode: 1, stdout: "2 vulnerabilities found\nhigh: vite" });
    const r = runAuditAttempt("/tmp", spawn);
    expect(r.ok).toBe(false);
    expect(r.requestFailed).toBe(false);
  });

  test("实测：Bun.spawnSync timeout 对挂死子进程按时 SIGTERM（exitCode=null）——①节 timeout 兜底前提守护", () => {
    const t0 = Date.now();
    const r = Bun.spawnSync([process.execPath, "-e", "setTimeout(() => {}, 60_000)"], {
      timeout: 300,
    });
    const elapsed = Date.now() - t0;
    expect(r.exitCode).toBeNull();
    expect(elapsed).toBeLessThan(5_000); // 零超时即永久挂起的对照：超时兜底按时返回
  });
});
