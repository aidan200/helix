import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";

/**
 * TP-CL1-2：目录骨架与 architecture.md §3.2 一致性（简单断言版，
 * 完整 AG 套件 M2 起常驻）。
 * ① 四层目录 + ports/inbound|outbound 物理分列 + main.ts 就位；
 * ② os.homedir 在 src/ 内唯一调用点为 infrastructure/paths.ts（AG-07）；
 * ③ 序号基线退役（T10a 方案 A）：seq/agentSeqOf/maxAgentSeq 在 daemon src 零残留；
 * ④ tmpdir( 调用点收束（AG-19，落点规范批 2026-10-10）：daemon src 内
 *   唯一调用点为 sandboxSetup（政策面——沙箱可写根追加/helper 自检，
 *   「允许写」非「落点」）；vendor 面豁免（pi-harness createTempDir 经
 *   TMPDIR 注入归位，零 vendor 改动）；落点单点 = infrastructure/workspacePaths。
 */
const srcRoot = path.join(import.meta.dir, "..", "..", "src");

describe("目录骨架（TP-CL1-2，architecture.md §3.2）", () => {
  test("① 四层 + ports 双向分列 + main.ts 就位", () => {
    const requiredDirs = [
      "domain",
      "application/ports/inbound",
      "application/ports/outbound",
      "application/services",
      "adapters/driving",
      "adapters/driven",
      "infrastructure",
    ];
    for (const dir of requiredDirs) {
      expect(existsSync(path.join(srcRoot, dir)), `缺少目录 src/${dir}`).toBe(true);
    }
    expect(existsSync(path.join(srcRoot, "main.ts")), "缺少入口 src/main.ts").toBe(true);
  });

  test("② os.homedir 在 src/ 内唯一调用点是 infrastructure/paths.ts（AG-07）", () => {
    const entries = readdirSync(srcRoot, { recursive: true }) as string[];
    const tsFiles = entries.filter((e) => e.endsWith(".ts"));
    expect(tsFiles.length).toBeGreaterThan(0);
    const offenders: string[] = [];
    for (const rel of tsFiles) {
      const normalized = path.normalize(rel);
      if (normalized === path.join("infrastructure", "paths.ts")) continue;
      const content = readFileSync(path.join(srcRoot, rel), "utf8");
      if (content.includes("os.homedir")) offenders.push(normalized);
    }
    expect(offenders).toEqual([]);
  });

  test("③ 序号基线退役（T10a 方案 A）：seq/agentSeqOf/maxAgentSeq 在 daemon src 零残留", () => {
    const entries = readdirSync(srcRoot, { recursive: true }) as string[];
    const tsFiles = entries.filter((e) => e.endsWith(".ts"));
    const offenders: string[] = [];
    for (const rel of tsFiles) {
      const normalized = path.normalize(rel);
      const content = readFileSync(path.join(srcRoot, rel), "utf8");
      if (/\bagentSeqOf\b|\bmaxAgentSeq\b/.test(content)) offenders.push(normalized);
    }
    expect(offenders).toEqual([]);
  });

  test("④ tmpdir( 调用点收束（AG-19，落点规范批）：唯一豁免 sandboxSetup（政策面），vendor 面豁免", () => {
    const entries = readdirSync(srcRoot, { recursive: true }) as string[];
    const tsFiles = entries.filter((e) => e.endsWith(".ts"));
    const offenders: string[] = [];
    for (const rel of tsFiles) {
      const normalized = path.normalize(rel);
      // 测试面豁免（TR-152：mkdtemp 测试隔离是惯例，非运行时落点写入方）
      if (normalized.endsWith(".test.ts")) continue;
      // vendor（pi-harness）豁免：createTempDir 消费 TMPDIR 注入归位，零改动
      if (normalized.split(path.sep).includes("vendor")) continue;
      // 政策面豁免：sandboxSetup 把系统 tmpdir 追加进沙箱可写根（允许面）
      // + Windows helper 自检目标——不是落点写入方
      if (normalized === path.join("adapters", "driven", "tools", "sandboxSetup.ts")) continue;
      const content = readFileSync(path.join(srcRoot, rel), "utf8");
      if (/\btmpdir\s*\(/.test(content)) offenders.push(normalized);
    }
    expect(offenders).toEqual([]);
  });
});
