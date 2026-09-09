/**
 * i18n 类型面单一事实源结构测试（T1.1 / TP-1.1a）：
 * 手写接口 types.ts（481 行）已删除，`Translations` 改由 zh-CN 词条结构推导
 * （`typeof zhCN`）+ `en-US satisfies` 兜结构——本测试守护「无第三种形态」
 * （不保留兼容 re-export 的 types.ts 空壳、包内零残留引用）。
 *
 * W3 #2.35：补死 key 扫描（zh-CN 叶子 key 全仓零引用即红）——动态 key 族
 * 经模板串静态前缀自动识别（`tk.stage.${...}` → 前缀 tk.stage.），无手工白名单。
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { zhCN } from "./lang/zh-CN";

const i18nDir = fileURLToPath(new URL(".", import.meta.url));
/** 消费面根（排除词条目录自身与测试文件）。 */
const shellSrc = fileURLToPath(new URL("../../", import.meta.url));

/** 递归收集 i18n 包内全部 .ts/.tsx 源文件。 */
function collectSources(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...collectSources(full));
    else if (/\.(ts|tsx)$/.test(entry)) out.push(full);
  }
  return out;
}

/** 提取源文本全部 import/from 模块说明符（不解析语义，仅机械扫描）。 */
function importSpecifiers(src: string): string[] {
  return [...src.matchAll(/from\s+["']([^"']+)["']/g)]
    .map((m) => m[1] ?? "")
    .filter((spec) => spec !== "");
}

describe("T1.1 i18n 类型单一事实源（typeof zhCN）", () => {
  it("TP-1.1a types.ts 手写接口文件已删除（文件不存在）", () => {
    expect(existsSync(join(i18nDir, "types.ts"))).toBe(false);
  });

  it("TP-1.1a i18n 包内零 types 模块 import 残留（无兼容空壳形态）", () => {
    const offenders = collectSources(i18nDir).flatMap((file) =>
      importSpecifiers(readFileSync(file, "utf8"))
        .filter((spec) => spec === "types" || spec.endsWith("/types"))
        .map((spec) => `${file}: ${spec}`),
    );
    expect(offenders).toEqual([]);
  });
});

// ── 死 key 扫描（W3 #2.35 防再生）──────────────────────

/** 递归展开词条为叶子点路径（仅字符串叶子；嵌套对象下钻）。 */
function leafPaths(obj: unknown, prefix = ""): string[] {
  const out: string[] = [];
  if (obj && typeof obj === "object" && !Array.isArray(obj)) {
    for (const [k, v] of Object.entries(obj)) {
      const p = prefix === "" ? k : `${prefix}.${k}`;
      if (v && typeof v === "object") out.push(...leafPaths(v, p));
      else if (typeof v === "string") out.push(p);
    }
  }
  return out;
}

describe("W3 #2.35 死 key 扫描", () => {
  it("zh-CN 叶子 key 全仓零引用即红（动态模板前缀自动识别）", () => {
    const sources = collectSources(shellSrc).filter(
      (f) => !f.includes(join("shared", "i18n", "lang")) && !f.endsWith(".test.ts") && !f.endsWith(".test.tsx"),
    );
    const corpus = sources.map((f) => readFileSync(f, "utf8")).join("\n");
    // 动态前缀：模板串 `${ 前的静态段（如 `tk.stage.${s}` → "tk.stage."）
    const dynPrefixes = new Set(
      [...corpus.matchAll(/`([^`$\n]*)\$\{/g)]
        .map((m) => m[1] ?? "")
        .filter((s) => s !== "" && s.endsWith(".")),
    );
    const dead = leafPaths(zhCN).filter(
      (p) => !corpus.includes(p) && ![...dynPrefixes].some((pre) => p.startsWith(pre)),
    );
    expect(dead, `死 key（消费面零引用）：${dead.join(", ")}`).toEqual([]);
  });
});
