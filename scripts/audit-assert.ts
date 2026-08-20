/**
 * audit 断言脚本（TP-CL5-1 / F(5.5).1；T4.1 工程卫生批次 A）。
 *
 * 断言面（可重复执行，红=非零退出）：
 * ① `bun audit` 全链零漏洞（dev 链 5 漏洞清零的防复发守护）；
 * ② 版本地板：lock 实装 vite ≥8.2.0 + vitest ≥4.1.0（防 lock 回退到漏洞窗；
 *   T1.2 升级至 latest 线 vite 8.2.2 / vitest 4.1.11，地板随实装 major.minor 线上调）；
 * ③ 生产运行时不引入审计敏感包：root + apps/* 的 dependencies（非 dev）
 *   不含 vite / vitest / esbuild（漏洞全在 dev 链，生产面零挂载的对照守护）；
 * ④ 体量双线（TR-AD-25 ④ / AD-3 / CL-3 / F(3.6)）：扫描面 .ts 文件
 *   >1000 行 fail / ≥700 行 warn 汇总（不阻断）。行数 = wc -l 物理行语义，
 *   边界恰等：1000 行 warn 不 fail、1001 行 fail、700 行即 warn；
 *   阈值 700/1000 为裁决定值禁止上调；豁免清单 SIZE_EXEMPT 唯一通道
 *   （仓库根相对路径精确匹配 + 理由留痕，本期预期空）；.tsx 不在断言面
 *   （TR-AD-25 口径，入池备注）。
 * ⑤ kg 锚点跟随（N7 / M6 T5；qhv8 终验登记 N7 落地）：docs/kg/*.md 内
 *   代码锚点引用的文件级存在性——全路径（apps|packages|e2e|scripts|docs
 *   前缀）精确检查 + 裸文件名锚尾缀（:行号/#符号）按 basename 仓内解析；
 *   腐烂锚点（文件已不存在）fail；行号/符号一律不校验（只验文件级存在，
 *   避免脆断言）；豁免清单 ANCHOR_EXEMPT 唯一通道（file+line+anchor 精确
 *   匹配 + 理由留痕；台账审计痕引用时点快照路径可豁免，历史记录不改写）。
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");

function fail(msg: string): never {
  console.error(`✗ audit-assert: ${msg}`);
  process.exit(1);
}

/** 版本地板比较（semver 三段数值）。 */
function atLeast(version: string, floor: string): boolean {
  const parse = (v: string) => v.split(".").map((n) => Number.parseInt(n, 10));
  const [a, b] = [parse(version), parse(floor)];
  for (let i = 0; i < 3; i++) {
    if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0);
  }
  return true;
}

// ── ① bun audit 全链零漏洞 ──
const audit = Bun.spawnSync(["bun", "audit"], { cwd: root });
const auditOut = audit.stdout.toString() + audit.stderr.toString();
if (audit.exitCode !== 0 || !auditOut.includes("No vulnerabilities found")) {
  console.error(auditOut);
  fail("bun audit 检出漏洞（期望清零）");
}
console.log("✓ ① bun audit 全链零漏洞");

// ── ② 版本地板（实装面：workspace node_modules 包清单） ──
const moduleRoots = [join(root, "node_modules"), join(root, "apps", "shell", "node_modules")];
for (const [pkg, floor] of [
  ["vite", "8.2.0"],
  ["vitest", "4.1.0"],
] as const) {
  let v: string | null = null;
  for (const mr of moduleRoots) {
    try {
      v = (JSON.parse(readFileSync(join(mr, pkg, "package.json"), "utf8")) as { version: string }).version;
      break;
    } catch {
      /* 下一个 node_modules 根 */
    }
  }
  if (!v) fail(`node_modules 中未找到 ${pkg}`);
  if (!atLeast(v, floor)) fail(`${pkg}@${v} 低于地板 ${floor}（漏洞窗内）`);
  console.log(`✓ ② ${pkg}@${v} ≥ ${floor}`);
}

// ── ③ 生产依赖面零审计敏感包（vite/vitest/esbuild 只允许 devDependencies） ──
const AUDIT_SENSITIVE = ["vite", "vitest", "esbuild"];
const manifests = ["package.json", "apps/daemon/package.json", "apps/shell/package.json"];
for (const rel of manifests) {
  const pkg = JSON.parse(readFileSync(join(root, rel), "utf8")) as {
    dependencies?: Record<string, string>;
  };
  for (const name of Object.keys(pkg.dependencies ?? {})) {
    if (AUDIT_SENSITIVE.includes(name)) {
      fail(`${rel} 的生产 dependencies 挂载 ${name}（只允许 devDependencies）`);
    }
  }
}
console.log("✓ ③ 生产依赖面零 vite/vitest/esbuild（漏洞包只在 dev 链）");

// ── ④ 体量双线（TR-AD-25 ④ / AD-3 / CL-3 / F(3.6)）──
// fail 档 >1000 / warn 档 ≥700（wc -l 语义）；阈值 700/1000 为裁决定值，禁止上调。
// 扫描面 = apps/**/src|test + packages/*/src|test 的 .ts（.tsx 不在断言面）；
// node_modules 排除（三方依赖不受本仓治理面约束）。
const SIZE_EXEMPT: Array<{ file: string; reason: string }> = [
  // 豁免唯一通道：仓库根相对 posix 路径精确匹配 + 一行理由；本期预期空，演示登记后须还原。
];

for (const { file, reason } of SIZE_EXEMPT) {
  if (!reason.trim()) fail(`SIZE_EXEMPT[${file}] 缺 reason（豁免须附理由留痕）`);
}

const SIZE_WARN_LINES = 700;
const SIZE_FAIL_LINES = 1000;
const sizeSurface = [
  "apps/**/src/**/*.ts",
  "apps/**/test/**/*.ts",
  "packages/*/src/**/*.ts",
  "packages/*/test/**/*.ts",
] as const;

const sizes = new Map<string, number>();
for (const pattern of sizeSurface) {
  for await (const rel of new Bun.Glob(pattern).scan({ cwd: root })) {
    if (rel.split("/").includes("node_modules")) continue; // 三方依赖不入治理面
    sizes.set(rel, readFileSync(join(root, rel), "utf8").split("\n").length - 1);
  }
}

const exempted = new Set(SIZE_EXEMPT.map((e) => e.file));
const warnPool: Array<{ file: string; lines: number }> = [];
const failPool: Array<{ file: string; lines: number }> = [];
for (const [file, lines] of sizes) {
  if (lines >= SIZE_WARN_LINES) warnPool.push({ file, lines });
  if (lines > SIZE_FAIL_LINES && !exempted.has(file)) failPool.push({ file, lines });
}

// 豁免核销：登记必须命中扫描面且真实越线（过期豁免 = 配置漂移，红）。
for (const { file, reason } of SIZE_EXEMPT) {
  const lines = sizes.get(file);
  if (lines === undefined || lines <= SIZE_FAIL_LINES) {
    fail(`SIZE_EXEMPT[${file}] 过期（不在扫描面或未越 ${SIZE_FAIL_LINES} 线），请移除登记`);
  }
  console.log(`⚠ ④ 豁免生效：${lines} 行 ${file}（理由：${reason}）`);
}

if (warnPool.length > 0) {
  console.log(`⚠ ④ 体量 warn 档（≥${SIZE_WARN_LINES}，汇总不阻断，${warnPool.length} 个）：`);
  for (const { file, lines } of warnPool.sort((a, b) => b.lines - a.lines)) {
    console.log(`      ${String(lines).padStart(5)}  ${file}`);
  }
} else {
  console.log(`✓ ④ 体量 warn 档空（扫描面无 .ts ≥${SIZE_WARN_LINES}）`);
}

if (failPool.length > 0) {
  console.error(`④ fail 档：${failPool.length} 个 .ts 超过 ${SIZE_FAIL_LINES} 行（未豁免）：`);
  for (const { file, lines } of failPool.sort((a, b) => b.lines - a.lines)) {
    console.error(`      ${String(lines).padStart(5)}  ${file}`);
  }
  fail("④ 体量 fail 档检出越线文件（TR-AD-25 ④：拆分，或登记 SIZE_EXEMPT 附理由）");
}
console.log(`✓ ④ 体量 fail 档空（扫描面 ${sizes.size} 个 .ts；.tsx 不在断言面）`);

// ── ⑤ kg 锚点跟随（N7 / M6 T5；qhv8 终验登记 N7 落地）──
// docs/kg/*.md 内代码锚点引用的文件级存在性：拆分/移动文件后未跟随的锚点
// （腐烂锚点，指向文件已不存在）即 fail；行号/符号一律不校验（只验文件级
// 存在，避免脆断言）。引用形态（grep 摸清 docs/kg 书写习惯后定形）：
//   A. 仓库根相对全路径（apps/|packages/|e2e/|scripts/|docs/ 前缀）：精确检查
//      路径存在（后续 :行号/#符号 不参与匹配）；
//   B. 裸文件名 + 锚尾缀（name.ts:12 / name.ts:12-34 / name.ts#symbol；扩展面
//      .ts/.tsx/.css/.mjs——md/json 裸名不入面：迭代工作区文档与运行时用户
//      文件不在仓内）：按 basename 在仓内源面解析，任一命中即过。
// 不入断言面：无锚尾缀的裸文件名（散文提及非锚点）；evidence/ 等工作区
// 相对路径（前缀集外，指向迭代档案不在仓内）。
// 豁免唯一通道 ANCHOR_EXEMPT：{ file, line, anchor, reason } 精确到 docs/kg
// 内文件+行+锚串 + 理由留痕（终验 discard 台账引用 gc 检出时点快照路径属
// 审计痕，历史记录不改写）；登记不再命中腐烂检出 = 过期豁免，红。
const ANCHOR_EXEMPT: Array<{ file: string; line: number; anchor: string; reason: string }> = [
  {
    file: "candidates.md",
    line: 612,
    anchor: "apps/daemon/src/application/services/SchedulerService.ts",
    reason:
      "TR-AD-24 discard 台账审计痕：gc 检出时点快照路径（现行锚已随 scheduler/ 拆分直写落库，qhv8 终验批准）——历史记录不改写",
  },
  {
    file: "candidates.md",
    line: 623,
    anchor: "packages/protocol/src/events.ts",
    reason:
      "TR-AD-21-r2 discard 台账审计痕：gc 检出时点快照路径（现行锚已随 events/ 拆分直写落库）——历史记录不改写",
  },
  {
    file: "candidates.md",
    line: 623,
    anchor: "packages/protocol/test/type-surface.test.ts",
    reason: "TR-AD-21-r2 discard 台账审计痕：同上（现行锚已改 type-surface/catalog.test.ts）",
  },
];

for (const e of ANCHOR_EXEMPT) {
  if (!e.reason.trim()) fail(`ANCHOR_EXEMPT[${e.file}:${e.line}] 缺 reason（豁免须附理由留痕）`);
}

// basename 解析索引（仓内源面；node_modules 排除；与 ④ 扫描面同源另含 e2e/scripts/根级）
const anchorIndexSurface = [
  "apps/**/src/**/*.ts",
  "apps/**/src/**/*.tsx",
  "apps/**/src/**/*.css",
  "apps/**/test/**/*.ts",
  "packages/*/src/**/*.ts",
  "packages/*/test/**/*.ts",
  "e2e/**/*.ts",
  "scripts/**/*.ts",
  "scripts/**/*.mjs",
  "*.ts",
  "*.mjs",
] as const;
const repoBasenames = new Set<string>();
for (const pattern of anchorIndexSurface) {
  for await (const rel of new Bun.Glob(pattern).scan({ cwd: root })) {
    if (rel.split("/").includes("node_modules")) continue;
    repoBasenames.add(rel.split("/").pop()!);
  }
}

const ANCHOR_PATH_RE = /(?<![\w/.-])(?:apps|packages|e2e|scripts|docs)\/[A-Za-z0-9_./-]+\.[A-Za-z0-9]{2,4}/g;
const ANCHOR_BARE_RE = /(?<![\w/.-])[A-Za-z0-9_-]+\.(?:ts|tsx|css|mjs)(?=:\d|#[\w-])/g;

const kgDir = join(root, "docs", "kg");
const kgFiles: string[] = [];
for await (const rel of new Bun.Glob("*.md").scan({ cwd: kgDir })) kgFiles.push(rel);
kgFiles.sort();

type AnchorHit = { file: string; line: number; anchor: string; why: string };
const anchorHits: AnchorHit[] = [];
let anchorChecked = 0;
for (const kf of kgFiles) {
  const lines = readFileSync(join(kgDir, kf), "utf8").split("\n");
  lines.forEach((text, i) => {
    for (const m of text.matchAll(ANCHOR_PATH_RE)) {
      anchorChecked++;
      if (!existsSync(join(root, m[0]))) {
        anchorHits.push({ file: kf, line: i + 1, anchor: m[0], why: "路径不存在" });
      }
    }
    for (const m of text.matchAll(ANCHOR_BARE_RE)) {
      anchorChecked++;
      if (!repoBasenames.has(m[0])) {
        anchorHits.push({ file: kf, line: i + 1, anchor: m[0], why: "basename 未在仓内源面解析到" });
      }
    }
  });
}

const anchorExemptKeys = new Set(ANCHOR_EXEMPT.map((e) => `${e.file}:${e.line}:${e.anchor}`));
const rotAnchors: AnchorHit[] = [];
let anchorExemptCount = 0;
for (const hit of anchorHits) {
  if (anchorExemptKeys.has(`${hit.file}:${hit.line}:${hit.anchor}`)) {
    anchorExemptCount++;
    continue;
  }
  rotAnchors.push(hit);
}

// 豁免核销：登记必须命中腐烂检出（修好/删除引用后未移除登记 = 配置漂移，红）
for (const e of ANCHOR_EXEMPT) {
  const hit = anchorHits.some((h) => h.file === e.file && h.line === e.line && h.anchor === e.anchor);
  if (!hit) {
    fail(`ANCHOR_EXEMPT[${e.file}:${e.line} ${e.anchor}] 过期（该处已无腐烂锚点检出），请移除登记`);
  }
  console.log(`⚠ ⑤ 豁免生效：${e.file}:${e.line} ${e.anchor}（理由：${e.reason}）`);
}

if (rotAnchors.length > 0) {
  console.error(`⑤ kg 锚点腐烂：${rotAnchors.length} 处引用指向不存在的文件（docs/kg 未随文件移动/删除跟随）：`);
  for (const h of rotAnchors) {
    console.error(`      ${h.file}:${h.line}  ${h.anchor}（${h.why}）`);
  }
  fail("⑤ kg 锚点跟随 fail（N7：修订 docs/kg 锚点到现行路径，或登记 ANCHOR_EXEMPT 附理由）");
}
console.log(
  `✓ ⑤ kg 锚点跟随零腐烂（docs/kg ${kgFiles.length} 文件，${anchorChecked} 处引用全有效` +
    (anchorExemptCount > 0 ? `；豁免 ${anchorExemptCount} 处审计痕` : "") + "）",
);

console.log("audit-assert: 全部断言通过");
