/**
 * sot-consistency：PROTOCOL.md ↔ @helix/protocol SoT 守护断言。
 *
 * 协议文档收口批（PROTOCOL-CHANGELOG.md §39）重构后的守护面（两条）：
 * ① 版本位一致：标题行 + §3 代码块版本字面量 == PROTOCOL_VERSION
 *    （§17.2② 单点律的文档面）；
 * ⑥ 文件职责守护（开放式）：PROTOCOL-CHANGELOG.md 存在非空且含批次节标题
 *    （开放判定 `^## N. `，不封顶节号——未来 §40+ 批次节自动合法）；
 *    PROTOCOL.md 节号白名单 {1,2,3,4,6,7,8,9,15,16,17} 与实际节标题
 *    **双向恰等**——白名单外节号出现即红（任何未来批次节写回现行文件即红），
 *    白名单内节号缺失亦红（节号漂移即红）；`### 17.x` 小节只许 17.1–17.4。
 *
 * 原断言②③④⑤（类型 presence / 计数一致 / additive 字段 presence / 通道
 * 归属）随 §15/§16 登记面退役而退役——守护对象消失；接管面 = typecheck
 * （字段与形状即契约，前端消费编译期即红）+ exports.test + arch-guard。
 *
 * 解析失败必须红（禁止静默通过）：解析 helper 在结构缺失时 throw，永真
 * 断言 = 未生效。
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PROTOCOL_VERSION } from "../../src/index";

const DOC = fileURLToPath(new URL("../../PROTOCOL.md", import.meta.url));
const CHANGELOG = fileURLToPath(new URL("../../PROTOCOL-CHANGELOG.md", import.meta.url));

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

  test("⑥ 文件职责守护：CHANGELOG 存在非空含批次节（开放判定）；PROTOCOL.md 节号白名单双向恰等", () => {
    // (a) 批次备案文件存在且非空（缺失/空 → throw = 红）
    const changelog = readFileSync(CHANGELOG, "utf8");
    if (changelog.trim() === "") throw new Error("PROTOCOL-CHANGELOG.md 缺失或为空——批次备案文件丢失");
    // (b) CHANGELOG 至少含一个批次节标题——开放判定 `^## N. `，不封顶节号
    //   （协议文档收口批开放式重构：原封顶白名单 §10–§23 对 §24+ 失明，CAND-324）
    const batchHeads = [...changelog.matchAll(/^## (\d+)\. /gm)];
    if (batchHeads.length === 0) throw new Error("PROTOCOL-CHANGELOG.md 无任何批次节标题——内容形态不符");
    for (const m of batchHeads) {
      const n = Number(m[1]);
      if (!Number.isInteger(n) || n < 1) throw new Error(`PROTOCOL-CHANGELOG.md 批次节号非法：\`${m[0].trim()}\``);
    }

    const doc = loadDoc();
    // (c) PROTOCOL.md 节号白名单双向恰等
    const actual = [...doc.matchAll(/^## (\d+)\. /gm)].map((m) => Number(m[1]));
    const actualSet = new Set(actual);
    if (actual.length !== actualSet.size) {
      throw new Error(`PROTOCOL.md 存在重复节号：[${actual.join(", ")}]`);
    }
    const violations: string[] = [];
    for (const n of actualSet) {
      if (!SECTION_WHITELIST.has(n)) violations.push(`节 \`## ${n}.\` 不在白名单（批次节写回现行文件即红）`);
    }
    for (const n of SECTION_WHITELIST) {
      if (!actualSet.has(n)) violations.push(`白名单节 \`## ${n}.\` 缺失（节号漂移即红——改节号须同 commit 改断言白名单与 §17.3 口径）`);
    }
    // (d) §17 小节只许 17.1–17.4（批次登记节 17.5+ 属 CHANGELOG，写回即红）
    for (const m of doc.matchAll(/^### 17\.(\d+) /gm)) {
      const minor = Number(m[1]);
      if (minor < 1 || minor > 4) violations.push(`\`### 17.${minor} \` 越界（17.5+ 批次登记属 CHANGELOG）`);
    }
    expect(violations).toEqual([]);
  });
});
