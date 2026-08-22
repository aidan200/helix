/**
 * i18n 类型面单一事实源结构测试（T1.1 / TP-1.1a）：
 * 手写接口 types.ts（481 行）已删除，`Translations` 改由 zh-CN 词条结构推导
 * （`typeof zhCN`）+ `en-US satisfies` 兜结构——本测试守护「无第三种形态」
 * （不保留兼容 re-export 的 types.ts 空壳、包内零残留引用）。
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const i18nDir = fileURLToPath(new URL(".", import.meta.url));

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
