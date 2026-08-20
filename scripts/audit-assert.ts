/**
 * audit 断言脚本（TP-CL5-1 / F(5.5).1；T4.1 工程卫生批次 A）。
 *
 * 断言面（可重复执行，红=非零退出）：
 * ① `bun audit` 全链零漏洞（dev 链 5 漏洞清零的防复发守护）；
 * ② 版本地板：lock 实装 vite ≥8.2.0 + vitest ≥4.1.0（防 lock 回退到漏洞窗；
 *   T1.2 升级至 latest 线 vite 8.2.2 / vitest 4.1.11，地板随实装 major.minor 线上调）；
 * ③ 生产运行时不引入审计敏感包：root + apps/* 的 dependencies（非 dev）
 *   不含 vite / vitest / esbuild（漏洞全在 dev 链，生产面零挂载的对照守护）。
 */
import { readFileSync } from "node:fs";
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
console.log("audit-assert: 全部断言通过");
