/**
 * sot-consistency：PROTOCOL.md ↔ @helix/protocol SoT 守护断言。
 *
 * 协议文档收口批（changelog §39）+ CHANGELOG 拆分批（§40）后的守护面（两条）：
 * ① 版本位一致：标题行 + §3 代码块版本字面量 == PROTOCOL_VERSION
 *    （§17.2② 单点律的文档面）；
 * ⑥ 文件职责守护（目录化）：changelog/ 目录存在且含 v*.md 版本文件；
 *    `## N.` 批次节号全域连续无跳号（{10..14} ∪ {18..max}）；§15–§17 的
 *    ## 级节号为 PROTOCOL.md 保留域（changelog/ 内出现即红——域分离）；
 *    `### 17.x` 小节 x≥5 且连续（17.1–17.4 属 PROTOCOL.md）；PROTOCOL.md
 *    节号白名单 {1,2,3,4,6,7,8,9,15,16,17} 与实际节标题**双向恰等**——
 *    白名单外节号出现即红（任何未来批次节写回现行文件即红），白名单内
 *    节号缺失亦红（节号漂移即红）。
 *
 * 原断言②③④⑤（类型 presence / 计数一致 / additive 字段 presence / 通道
 * 归属）随 §15/§16 登记面退役而退役——守护对象消失；接管面 = typecheck
 * （字段与形状即契约，前端消费编译期即红）+ exports.test + arch-guard。
 *
 * 解析失败必须红（禁止静默通过）：解析 helper 在结构缺失时 throw，永真
 * 断言 = 未生效。
 */
import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { PROTOCOL_VERSION } from "../../src/index";

const DOC = fileURLToPath(new URL("../../PROTOCOL.md", import.meta.url));
const CHANGELOG_DIR = fileURLToPath(new URL("../../changelog", import.meta.url));

/** 读入文档（文件缺失/不可读 → throw = 红）。 */
function loadDoc(): string {
  const text = readFileSync(DOC, "utf8");
  if (text.trim() === "") throw new Error("PROTOCOL.md 解析失败：文档为空");
  return text;
}

/** 截取 [startRe 节标题, endRe 节标题) 的节文本（任一节标题缺失 → throw = 红）。 */
function section(doc: string, startRe: RegExp, endRe: RegExp): string {
  const start = doc.match(startRe);
  if (!start || start.index === undefined) throw new Error(`PROTOCOL.md 解析失败：未找到节标题 ${startRe}`);
  const end = doc.slice(start.index).match(endRe);
  if (!end || end.index === undefined) throw new Error(`PROTOCOL.md 解析失败：未找到 ${startRe} 节的结束节标题 ${endRe}`);
  return doc.slice(start.index, start.index + end.index);
}

/**
 * PROTOCOL.md 合法节号白名单（协议文档收口批定格）：§1–§4 行为契约 +
 * §6–§9（§5 随 v0.1 遗物目录删除）+ §15/§16 墓碑 + §17 守护口径。
 * 修改节号结构 = 修改本白名单 + 同 commit 改 §17.3 口径（双向恰等断言强制）。
 */
const SECTION_WHITELIST = new Set([1, 2, 3, 4, 6, 7, 8, 9, 15, 16, 17]);

describe("sot-consistency：PROTOCOL.md ↔ protocol 类型 SoT 守护（协议文档收口批口径 = PROTOCOL.md §17.3）", () => {
  test("① 版本位一致：标题行与 §3 代码块版本字面量 == PROTOCOL_VERSION 导出值", () => {
    const doc = loadDoc();
    const title = doc.match(/^# .+ v(\d+(?:\.\d+)?)\s*$/m);
    if (!title) throw new Error("PROTOCOL.md 解析失败：标题行未找到 `# … vX.Y` 版本位");
    const sec3 = section(doc, /^## 3\. /m, /^## 4\. /m);
    const codeVer = sec3.match(/export const PROTOCOL_VERSION = "([^"]+)"/);
    if (!codeVer) throw new Error("PROTOCOL.md 解析失败：§3 代码块未找到 PROTOCOL_VERSION 导出行");
    expect(title[1]).toBe(PROTOCOL_VERSION);
    expect(codeVer[1]).toBe(PROTOCOL_VERSION);
  });

  test("⑥ 文件职责守护：changelog/ 目录形态 + 节号全域连续 + 域分离；PROTOCOL.md 节号白名单双向恰等", () => {
    // (a) changelog/ 目录存在且含 v*.md 版本文件（目录缺失/无版本文件 → throw = 红）
    const versionFiles = readdirSync(CHANGELOG_DIR).filter((f) => /^v[\d.].*\.md$/.test(f));
    if (versionFiles.length === 0) throw new Error("changelog/ 目录无 v*.md 版本文件——批次备案目录丢失");
    // (a2) 当前版本位对应的版本文件必须存在（分配规则守护：版本 bump 开新文件、
    //     尾文件丢失即红——连续域缩短不救场，红演示实证过此盲区）
    if (!versionFiles.includes(`v${PROTOCOL_VERSION}.md`)) {
      throw new Error(`changelog/ 缺当前版本文件 v${PROTOCOL_VERSION}.md（版本 bump 须开新文件）`);
    }

    // (b) 收集全部批次节号（## 级 + ### 17.x 小节级），空文件即红
    const sectionNums: number[] = [];
    const minorNums: number[] = [];
    for (const f of versionFiles) {
      const text = readFileSync(join(CHANGELOG_DIR, f), "utf8");
      if (text.trim() === "") throw new Error(`changelog/${f} 为空——版本文件丢失内容`);
      for (const m of text.matchAll(/^## (\d+)\. /gm)) sectionNums.push(Number(m[1]));
      for (const m of text.matchAll(/^### 17\.(\d+) /gm)) minorNums.push(Number(m[1]));
    }
    if (sectionNums.length === 0) throw new Error("changelog/ 无任何 ## 级批次节标题——内容形态不符");

    // (c) 域分离：§15–§17 的 ## 级节号为 PROTOCOL.md 保留域，changelog/ 内出现即红
    // (d) 全域连续无跳号：{10..14} ∪ {18..max}（拆分丢段/追加漏号即红；§40+ 开放顺延）
    const violations: string[] = [];
    // (d0) 节号重复即红（set 去重盲区补检——两节 §40 并存曾溜过连续性检查，事故实证后补）
    const dupSections = [...new Set(sectionNums.filter((n, i) => sectionNums.indexOf(n) !== i))];
    const dupMinors = [...new Set(minorNums.filter((n, i) => minorNums.indexOf(n) !== i))];
    if (dupSections.length > 0) violations.push(`批次节号重复：[${dupSections.join(", ")}]（同节号两写即红——合并或顺延节号）`);
    if (dupMinors.length > 0) violations.push(`### 17.x 小节号重复：[${dupMinors.join(", ")}]（同号两写即红）`);
    const maxN = Math.max(...sectionNums);
    const expected = new Set<number>();
    for (let n = 10; n <= maxN; n += 1) if (n < 15 || n > 17) expected.add(n);
    const actual = new Set(sectionNums);
    for (const n of actual) {
      if (n === 15 || n === 16 || n === 17) {
        violations.push(`changelog/ 出现保留域节 \`## ${n}.\`（§15–§17 ## 级属 PROTOCOL.md——域分离即红）`);
      } else if (n < 10) {
        violations.push(`changelog/ 出现 §10 前节号 \`## ${n}.\`（非法）`);
      } else if (!expected.has(n)) {
        violations.push(`节 \`## ${n}.\` 超出连续域 {10..${maxN}}（异常）`);
      }
    }
    for (const n of expected) {
      if (!actual.has(n)) violations.push(`批次节 \`## ${n}.\` 缺失（拆分丢段/跳号即红——全域应连续无跳号）`);
    }
    // (e) ### 17.x 小节：x≥5（17.1–17.4 属 PROTOCOL.md）且连续 5..max
    const maxMinor = Math.max(...minorNums);
    const actualMinors = new Set(minorNums);
    for (const x of actualMinors) {
      if (x < 5) violations.push(`\`### 17.${x} \` < 17.5 属 PROTOCOL.md（域分离即红）`);
    }
    for (let x = 5; x <= maxMinor; x += 1) {
      if (!actualMinors.has(x)) violations.push(`\`### 17.${x} \` 小节缺失（跳号即红）`);
    }

    // (f) PROTOCOL.md 节号白名单双向恰等（协议文档收口批口径）
    const doc = loadDoc();
    const docActual = [...doc.matchAll(/^## (\d+)\. /gm)].map((m) => Number(m[1]));
    const docSet = new Set(docActual);
    if (docActual.length !== docSet.size) {
      throw new Error(`PROTOCOL.md 存在重复节号：[${docActual.join(", ")}]`);
    }
    for (const n of docSet) {
      if (!SECTION_WHITELIST.has(n)) violations.push(`节 \`## ${n}.\` 不在白名单（批次节写回现行文件即红）`);
    }
    for (const n of SECTION_WHITELIST) {
      if (!docSet.has(n)) violations.push(`白名单节 \`## ${n}.\` 缺失（节号漂移即红——改节号须同 commit 改断言白名单与 §17.3 口径）`);
    }
    // (g) §17 小节只许 17.1–17.4（批次登记节 17.5+ 属 changelog/，写回即红）
    for (const m of doc.matchAll(/^### 17\.(\d+) /gm)) {
      const minor = Number(m[1]);
      if (minor < 1 || minor > 4) violations.push(`\`### 17.${minor} \` 越界（17.5+ 批次登记属 changelog/）`);
    }
    expect(violations).toEqual([]);
  });
});
