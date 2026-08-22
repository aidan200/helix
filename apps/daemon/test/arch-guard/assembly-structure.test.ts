import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";

/**
 * TP-2.2e：组合根 TDZ/晚绑注释零残留（结构断言，架构 §4.2.3/§4.2.5）。
 * 判据 = container.ts + infrastructure/assembly/** 内「TDZ」grep 零命中
 * ——结构保证（事件化 + typed 回填面）取代注释保证。
 * 变体措辞（「晚绑安全」「回填安全」类）人工复查归 CP-4（评审项）。
 */
const infraRoot = path.join(import.meta.dir, "..", "..", "src", "infrastructure");

/** 组合根锚面文件清单：container.ts + assembly/**（AG-02④ 豁免面同口径）。 */
function compositionRootFiles(): string[] {
  const files = [path.join(infraRoot, "container.ts")];
  const assemblyDir = path.join(infraRoot, "assembly");
  if (existsSync(assemblyDir)) {
    for (const entry of readdirSync(assemblyDir, { recursive: true }) as string[]) {
      if (entry.endsWith(".ts")) files.push(path.join(assemblyDir, entry));
    }
  }
  return files;
}

describe("TP-2.2e：组合根 TDZ 注释零残留", () => {
  test("container.ts + assembly/** 内「TDZ」零命中（结构保证取代注释保证）", () => {
    const files = compositionRootFiles();
    expect(files.length).toBeGreaterThan(0); // 扫描面非空转
    for (const file of files) {
      const src = readFileSync(file, "utf8");
      expect(src.includes("TDZ"), `${path.relative(infraRoot, file)} 残留 TDZ 注释`).toBe(false);
    }
  });
});
