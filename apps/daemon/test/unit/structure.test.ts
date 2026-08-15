import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";

/**
 * TP-CL1-2：目录骨架与 architecture.md §3.2 一致性（简单断言版，
 * 完整 AG 套件 M2 起常驻）。
 * ① 四层目录 + ports/inbound|outbound 物理分列 + main.ts 就位；
 * ② os.homedir 在 src/ 内唯一调用点为 infrastructure/paths.ts（AG-07）。
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
});
