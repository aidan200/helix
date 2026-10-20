/**
 * audit-assert ①节 bun audit 重试环单测（code-review M13 批 #2.40）：
 * - executable = process.execPath（不写死 "bun" 走 PATH）；
 * - spawnSync 带 timeout 兜底（TCP 半死防永久挂起，TR-104 同类面）；
 * - 超时杀（exitCode=null）按「请求失败」口径入重试，非漏洞检出；
 * - 真漏洞检出不重试（requestFailed=false）；
 * - exit 0 即 ok（退出码唯一权威）；佐证文案缺席仅 warn 不翻转判定。
 * 注入假 spawnSync 全分支单测，不真起 bun audit（不联网）。
 */
import { describe, expect, test } from "bun:test";

import {
  AUDIT_TIMEOUT_MS,
  reconcileAuditExemptions,
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

  test("exit 0 但佐证文案缺席 → 仍 ok（文案匹配降级为佐证/warn）", () => {
    const { spawn } = fakeSpawn({ exitCode: 0, stdout: "audit completed" });
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

describe("reconcileAuditExemptions（①节豁免对账，2026-10 上游无解洞登记）", () => {
  const EXEMPT = [{ ghsa: "GHSA-aaaa-bbbb-1111" }, { ghsa: "GHSA-cccc-dddd-2222" }];

  const outWith = (...ghsas: string[]) =>
    ghsas
      .map((g) => `  high: something bad - https://github.com/advisories/${g}`)
      .join("\n");

  test("检出全部命中登记 → 放行（exempted=detected，无 stale 无 unexempted）", () => {
    const r = reconcileAuditExemptions(outWith("GHSA-aaaa-bbbb-1111", "GHSA-cccc-dddd-2222"), EXEMPT);
    expect(r.detected).toEqual(["GHSA-aaaa-bbbb-1111", "GHSA-cccc-dddd-2222"]);
    expect(r.exempted).toEqual(["GHSA-aaaa-bbbb-1111", "GHSA-cccc-dddd-2222"]);
    expect(r.unexempted).toEqual([]);
    expect(r.stale).toEqual([]);
  });

  test("检出含未登记 id → unexempted 非空（真新漏洞红）", () => {
    const r = reconcileAuditExemptions(outWith("GHSA-aaaa-bbbb-1111", "GHSA-eeee-ffff-3333"), EXEMPT);
    expect(r.unexempted).toEqual(["GHSA-eeee-ffff-3333"]);
    expect(r.exempted).toEqual(["GHSA-aaaa-bbbb-1111"]);
    expect(r.stale).toEqual(["GHSA-cccc-dddd-2222"]);
  });

  test("登记 id 未被报 → stale 非空（上游已修/依赖已换，过期登记红提醒撤销）", () => {
    const r = reconcileAuditExemptions(outWith("GHSA-aaaa-bbbb-1111"), EXEMPT);
    expect(r.stale).toEqual(["GHSA-cccc-dddd-2222"]);
    expect(r.unexempted).toEqual([]);
  });

  test("输出零 id 且登记非空 → 全 stale（零漏洞与残留登记互斥；输出格式漂移同入此面响亮红）", () => {
    const r = reconcileAuditExemptions("No vulnerabilities found", EXEMPT);
    expect(r.detected).toEqual([]);
    expect(r.stale).toEqual(["GHSA-aaaa-bbbb-1111", "GHSA-cccc-dddd-2222"]);
  });

  test("同 id 多次出现去重（多链路引同一 advisory）", () => {
    const out = outWith("GHSA-aaaa-bbbb-1111") + "\n" + outWith("GHSA-aaaa-bbbb-1111");
    const r = reconcileAuditExemptions(out, EXEMPT);
    expect(r.detected).toEqual(["GHSA-aaaa-bbbb-1111"]);
  });

  test("GHSA 提取正则形态（三段 4-4-4）不误吞两段/普通文本", () => {
    const r = reconcileAuditExemptions("some GHSA text, GHSA-xx id, GHSA-aaaa-bbbb partial", []);
    expect(r.detected).toEqual([]);
  });

  test("实测样例：真实 audit 输出片段提取（形态回归钉）", () => {
    const realLine =
      "  high: braces vulnerable to stack-exhaustion denial of service through deeply nested patterns (<=3.0.3) - https://github.com/advisories/GHSA-vfj7-8cjw-p6xm";
    const r = reconcileAuditExemptions(realLine, [{ ghsa: "GHSA-vfj7-8cjw-p6xm" }]);
    expect(r.exempted).toEqual(["GHSA-vfj7-8cjw-p6xm"]);
    expect(r.unexempted).toEqual([]);
  });
});
