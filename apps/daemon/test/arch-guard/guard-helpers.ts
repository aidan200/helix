/**
 * 架构守护（AG）源码扫描套件共享面（arch-guard*.test.ts 三文件共用）——
 * 纯位置迁移自 arch-guard.test.ts（P1 体量门拆分批，判定逻辑零改动）。
 * 生产源码只读扫描三件套：listFiles / read / importSpecifiers / typeOnly。
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

export const srcRoot = path.join(import.meta.dir, "..", "..", "src");

export function listFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { recursive: true }) as string[]) {
    // .test.ts 豁免：守护对象是生产代码依赖方向/env 纪律——测试文件的
    // bun:test import 与 env 注入不构成运行时依赖面（domain/sandbox 与
    // application 层测试同批暴露：不豁免则域内测试结构性必红）
    if (entry.endsWith(".ts") && !entry.endsWith(".test.ts")) out.push(entry);
  }
  return out;
}

export function read(rel: string): string {
  return readFileSync(path.join(srcRoot, rel), "utf8");
}

/** 提取 import 说明符（静态 import/export-from）。 */
export function importSpecifiers(source: string): string[] {
  const specifiers: string[] = [];
  const re = /^\s*(?:import|export)\s[^;'"]*?from\s+['"]([^'"]+)['"]/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) specifiers.push(m[1]!);
  return specifiers;
}

export function typeOnly(spec: string, source: string): boolean {
  const typeRe = new RegExp(
    `^\\s*import\\s+type\\s[^;'"']*?from\\s+['"]${spec.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}['"]`,
    "m",
  );
  const valueRe = new RegExp(
    `^\\s*import\\s+(?!type\\b)[^;'"']*?from\\s+['"]${spec.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}['"]`,
    "m",
  );
  return typeRe.test(source) && !valueRe.test(source);
}
