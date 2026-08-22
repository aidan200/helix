import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

/**
 * TP-2.3a/b：显式模式分离（T2.3，architecture §4.3）——
 * - TP-2.3a 生产 DaemonOptions 零测试注入口：字段面 ⊆ {home, port,
 *   cliInput, cliOutput}（架构 §4.3 裁定保留的四真实启动参数）；11 测试
 *   注入口（engine/staticDir/skipLock/skipConfig/toolCwd/builtinSkillsDir/
 *   subagentRunner/browser/sessionTailSize/sessionIdleUnloadMs/
 *   sessionIdlePollMs）在 DaemonOptions 类型块零命中——options 形态仅
 *   存在于 test/helpers/createTestDaemon.ts（TestDaemonOptions）。
 * - TP-2.3b 隐式分支消失：「options.engine === undefined 即生产」式
 *   「未注入即生产」语义分支在组合根锚面（container.ts +
 *   infrastructure/assembly/**，AG-02④ 豁免面同口径）零残留——装配形态
 *   由显式判别字段（engineMode 等）承载，不从注入字段缺省推断。
 */
const daemonRoot = path.join(import.meta.dir, "..", "..");
const srcRoot = path.join(daemonRoot, "src");
const infraRoot = path.join(srcRoot, "infrastructure");

function listTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { recursive: true }) as string[]) {
    if (entry.endsWith(".ts")) out.push(path.join(dir, entry));
  }
  return out;
}

/** 组合根锚面文件清单：container.ts + assembly/**（AG-02④ 豁免面同口径）。 */
function compositionRootFiles(): string[] {
  const files = [path.join(infraRoot, "container.ts")];
  const assemblyDir = path.join(infraRoot, "assembly");
  for (const entry of readdirSync(assemblyDir, { recursive: true }) as string[]) {
    if (entry.endsWith(".ts")) files.push(path.join(assemblyDir, entry));
  }
  return files;
}

/** 11 测试注入口（brief T2.3 处置清单：迁 test/helpers/createTestDaemon.ts）。 */
const INJECTION_FIELDS = [
  "engine",
  "staticDir",
  "skipLock",
  "skipConfig",
  "toolCwd",
  "builtinSkillsDir",
  "subagentRunner",
  "browser",
  "sessionTailSize",
  "sessionIdleUnloadMs",
  "sessionIdlePollMs",
] as const;

/** 提取 container.ts 的 DaemonOptions 接口块（首个顶格 \n} 收口——字段均为
 * 标量/联合/流类型，无嵌套对象字面量）。 */
function daemonOptionsBlock(): string {
  const src = readFileSync(path.join(infraRoot, "container.ts"), "utf8");
  const start = src.indexOf("export interface DaemonOptions");
  expect(start, "container.ts 缺少 DaemonOptions 接口（契约存在性）").toBeGreaterThanOrEqual(0);
  const end = src.indexOf("\n}", start);
  expect(end, "DaemonOptions 接口块未正常收口（解析失败）").toBeGreaterThan(start);
  return src.slice(start, end + 2);
}

describe("TP-2.3a：生产 DaemonOptions 零测试注入口", () => {
  test("① DaemonOptions 字段面 ⊆ {home, port, cliInput, cliOutput}", () => {
    const block = daemonOptionsBlock();
    const fields = [...block.matchAll(/(?:^|\n)[ \t]*(?:readonly\s+)?([A-Za-z_][A-Za-z0-9_]*)\??:/g)].map(
      (m) => m[1]!,
    );
    expect(fields.length, "字段解析非空（防恒真断言）").toBeGreaterThan(0);
    for (const f of fields) {
      expect(["home", "port", "cliInput", "cliOutput"], `DaemonOptions 混入非生产字段：${f}`).toContain(f);
    }
  });

  test("② 11 测试注入口在 DaemonOptions 块零命中（word 边界）", () => {
    const block = daemonOptionsBlock();
    for (const f of INJECTION_FIELDS) {
      expect(new RegExp(`\\b${f}\\b`).test(block), `DaemonOptions 残留测试注入口：${f}`).toBe(false);
    }
  });

  test("③ skipConfig/skipLock 在 src/** 全域零命中（溶解为测试工厂内部决断）", () => {
    const files = listTsFiles(srcRoot);
    expect(files.length).toBeGreaterThan(0); // 扫描面非空转
    for (const file of files) {
      const src = readFileSync(file, "utf8");
      expect(src.includes("skipConfig"), `${path.relative(srcRoot, file)} 残留 skipConfig`).toBe(false);
      expect(src.includes("skipLock"), `${path.relative(srcRoot, file)} 残留 skipLock`).toBe(false);
    }
  });

  test("④ 组合根类型定义零 engine/subagentRunner 字段声明（显式判别命名取代）", () => {
    // 字段声明形态（readonly 可选）：engineMode:/subagentRunnerOverride: 等
    // 显式命名不命中（后缀不匹配冒号收口）；裸 engine:/subagentRunner: 命中。
    // browser 不在本断言：Daemon 接口的 browser 端口暴露面是合法生产字段
    // （非注入 option），其 options 消费面由 TP-2.3b 的 options 模式覆盖。
    const decl = /^[ \t]*(?:readonly\s+)?(?:engine|subagentRunner|skipConfig|skipLock)\??:/gm;
    const files = compositionRootFiles();
    expect(files.length).toBeGreaterThan(5); // container + assembly 五文件以上（扫描面非空转）
    for (const file of files) {
      const src = readFileSync(file, "utf8");
      const hits = src.match(decl);
      expect(hits, `${path.relative(infraRoot, file)} 组合根类型残留注入字段声明：${hits?.join(",")}`).toBeNull();
    }
  });
});

describe("TP-2.3b：隐式「未注入即生产」分支零残留（组合根锚面）", () => {
  const implicitPatterns: ReadonlyArray<readonly [string, RegExp]> = [
    ["engine === undefined 推断", /\bengine\s*===\s*undefined/],
    ["engine !== undefined 推断", /\bengine\s*!==\s*undefined/],
    ["typeof engine 三分支推断", /typeof\s+engine\s*===/],
    [
      "options.<注入字段> 消费",
      /options\.(?:engine|subagentRunner|browser|staticDir|toolCwd|builtinSkillsDir|sessionTailSize|sessionIdleUnloadMs|sessionIdlePollMs|skipConfig|skipLock)\b/,
    ],
  ];

  for (const [label, re] of implicitPatterns) {
    test(`组合根锚面零「${label}」`, () => {
      for (const file of compositionRootFiles()) {
        const src = readFileSync(file, "utf8");
        expect(re.test(src), `${path.relative(infraRoot, file)} 残留隐式分支（${label}）`).toBe(false);
      }
    });
  }
});
