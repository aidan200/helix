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

describe("TR-101：E 层 launcher spawnSnapshot 与生产注入面签名对账", () => {
  // 少参箭头赋多参接口在 TS 协变下合法、多参被静默丢弃（buildDrivingAdapters
  // options 透传坑同型）——机械断言 E 层镜像显式书写生产三参
  // (profileKind, writeMode, sessionId)，生产签名再扩展时此处先红。
  test("e2e/launcher.ts spawnSnapshot 箭头声明全三参（writeMode/sessionId 显式消费）", () => {
    const launcherSrc = readFileSync(path.join(import.meta.dir, "..", "e2e", "launcher.ts"), "utf8");
    const m = launcherSrc.match(/spawnSnapshot:\s*\(([^)]*)\)\s*=>/);
    expect(m, "e2e/launcher.ts 应含 spawnSnapshot 箭头注入").not.toBeNull();
    const params = (m![1] ?? "").split(",").map((s) => s.trim());
    expect(params.length, "E 层 spawnSnapshot 参数面与生产 SubagentLauncherDeps 对账").toBe(3);
    expect(params[0]).toContain("profileKind");
    expect(params[1]).toContain("writeMode");
    expect(params[2]).toContain("sessionId");
    // writeMode 语义消费锚（U3 readonly 减三写工具——非摆设参数）
    expect(launcherSrc.includes("applyWriteModeToAssembly"), "E 层 spawnSnapshot 应经 applyWriteModeToAssembly 消费 writeMode").toBe(true);
  });
});
