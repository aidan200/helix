/**
 * audit 断言脚本（TP-CL5-1 / F(5.5).1；T4.1 工程卫生批次 A）。
 *
 * 断言面（可重复执行，红=非零退出）：
 * ① `bun audit` 全链零漏洞（dev 链 5 漏洞清零的防复发守护）；bun audit
 *   联网拉漏洞库，请求失败（"audit request failed"，CI 网络瞬断常见）
 *   ≠ 漏洞检出——请求类失败指数退避重试 4 次，耗尽仍败以基础设施故障
 *   红（不静默放行），真检出漏洞不重试直接红；单次尝试带 timeout 兜底
 *   （code-review M13 批 #2.40：子进程自身联网遇 TCP 半死零超时即永久
 *   挂起，4 次退避重试救不了单次挂死——TR-104 同类半死面）；
 *   豁免通道（AUDIT_EXEMPT）：上游无修复版/修复需跨 major 的已评估漏洞
 *   登记放行（GHSA id + 理由留痕，对称于 ④ 的 SIZE_EXEMPT）；对账语义：
 *   检出 id 全部命中登记且无过期登记才绿；登记 id 未再被报（上游已修/
 *   依赖已换）= 过期登记即红——撤销豁免与升级被门自身强制，不靠人记。
 * ② 版本地板：实装面（node_modules 包清单）vite ≥8.2.0 + vitest ≥4.1.0
 *   （防 lock 回退到漏洞窗；T1.2 升级至 latest 线 vite 8.2.2 / vitest
 *   4.1.11，地板随实装 major.minor 线上调）；
 * ③ 生产运行时不引入审计敏感包：root + apps/* + packages/*（Glob 扫描
 *   package.json 清单）的 dependencies（非 dev）不含 vite / vitest /
 *   esbuild（漏洞全在 dev 链，生产面零挂载的对照守护）；
 * ④ 体量双线（TR-AD-25 ④ / AD-3 / CL-3 / F(3.6)）：扫描面 .ts 文件
 *   >1000 行 fail / ≥700 行 warn 汇总（不阻断）。行数 = wc -l 物理行语义，
 *   边界恰等：1000 行 warn 不 fail、1001 行 fail、700 行即 warn；
 *   阈值 700/1000 为裁决定值禁止上调；豁免清单 SIZE_EXEMPT 唯一通道
 *   （仓库根相对路径精确匹配 + 理由留痕）；.tsx 不在断言面
 *   （TR-AD-25 口径，入池备注）。
 * （原 ⑤ kg 锚点跟随断言随 v1 docs/kg 清除一并退役——v2 SoT 在 .helix-kg/kg.db，
 *   锚点治理由 kg 侧锚物化/体检通道承担。）
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

// ── ① bun audit 单次尝试（M13 批 #2.40 可测化抽取，spawn 注入全分支可单测） ──

/** 单次 bun audit 尝试的超时兜底（120s）：超时 SIGTERM 后按请求失败入重试。 */
export const AUDIT_TIMEOUT_MS = 120_000;

/** 单次尝试结论：ok=零漏洞通过；requestFailed=请求类失败（含超时杀）可重试。 */
export interface AuditAttemptResult {
  readonly ok: boolean;
  readonly requestFailed: boolean;
  readonly out: string;
}

/** spawnSync 窄注入面（测试以假结果注入，不真起子进程）。 */
export interface AuditSpawnSyncResult {
  readonly exitCode: number | null;
  readonly stdout: { toString(): string };
  readonly stderr: { toString(): string };
}
export type AuditSpawnSync = (
  cmd: string[],
  opts: { cwd: string; timeout: number },
) => AuditSpawnSyncResult;

/**
 * 单次 bun audit 尝试：
 * - executable 用 process.execPath（当前 bun 二进制绝对路径），不写死
 *   "bun" 走 PATH（M13 批 #2.40）；
 * - timeout 兜底——bun audit 子进程自身联网遇 TCP 半死时零超时即永久挂起
 *   （TR-104 同类半死面），超时 SIGTERM 后 exitCode=null，按「请求失败」
 *   口径入重试（基础设施故障，非漏洞检出）；
 * - exit 0 即判 ok（退出码是唯一权威判据）；"No vulnerabilities found"
 *   文案匹配降级为佐证——exit 0 但佐证文案缺席时 warn（bun 版本文案
 *   漂移线索），不阻断、不翻转判定；
 * - 请求类失败（"audit request failed" / 超时杀）≠ 漏洞检出；其余非零
 *   退出 = 真漏洞检出（或其它断言级失败），不可重试。
 */
export function runAuditAttempt(
  cwd: string,
  spawnSync: AuditSpawnSync = (cmd, opts) => Bun.spawnSync(cmd, opts),
): AuditAttemptResult {
  const audit = spawnSync([process.execPath, "audit"], { cwd, timeout: AUDIT_TIMEOUT_MS });
  const out = audit.stdout.toString() + audit.stderr.toString();
  if (audit.exitCode === 0) {
    if (!out.includes("No vulnerabilities found")) {
      console.warn(
        "⚠ ① bun audit exit 0 但佐证文案 \"No vulnerabilities found\" 缺席（bun 版本文案漂移？）——按退出码判通过",
      );
    }
    return { ok: true, requestFailed: false, out };
  }
  const requestFailed = audit.exitCode === null || out.includes("audit request failed");
  return { ok: false, requestFailed, out };
}

// ── ① 豁免登记（唯一通道：GHSA id + 理由留痕；过期即红见 reconcileAuditExemptions）──

/** 已评估放行的漏洞登记（检出的 GHSA 全部命中且无过期登记才绿）。 */
const AUDIT_EXEMPT: ReadonlyArray<{ ghsa: string; reason: string }> = [
  {
    ghsa: "GHSA-vfj7-8cjw-p6xm",
    reason:
      "braces ≤3.0.3 栈耗尽 DoS——dev 链（tailwind→micromatch），上游无修复版（3.x 最新即 3.0.3）；上游发版后本登记自动过期（核销红）",
  },
  {
    ghsa: "GHSA-rj75-hqrm-r3gf",
    reason:
      "postcss-selector-parser 6.1.4 选择器解析 CPU 耗尽——dev 链（tailwind→postcss-nested）；修复版仅 7.1.6（跨 major，tailwind 内部消费 6.x，override 有构建破坏风险）；tailwind 链升级至 7.x 后本登记自动过期",
  },
];

/** 豁免对账结果（全部为 GHSA id 集合）。 */
export interface AuditExemptionRecon {
  /** bun audit 输出中检出的全部 GHSA id。 */
  readonly detected: string[];
  /** 检出且命中登记（放行面，打印豁免生效）。 */
  readonly exempted: string[];
  /** 检出但未登记——真新漏洞，红。 */
  readonly unexempted: string[];
  /** 登记但未被报——过期登记（上游已修/依赖已换），红提醒撤销。 */
  readonly stale: string[];
}

/**
 * 豁免对账纯函数：从 bun audit 输出提取 GHSA id 集合，与登记清单对账。
 * 提取依据：advisory 行尾 `https://github.com/advisories/GHSA-xxxx-xxxx-xxxx`
 * （标准三段 4-4-4 形态，本地与 CI 实测）；输出无任何 id 且登记非空 →
 * 全部 stale（含输出格式漂移场景——提取面失灵响亮红而非误放行）。
 */
export function reconcileAuditExemptions(
  out: string,
  exemptions: ReadonlyArray<{ ghsa: string }>,
): AuditExemptionRecon {
  const detected = [...new Set(out.match(/GHSA-[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4}/g) ?? [])];
  const registered = new Set(exemptions.map((e) => e.ghsa));
  const exempted = detected.filter((g) => registered.has(g));
  const unexempted = detected.filter((g) => !registered.has(g));
  const stale = exemptions.map((e) => e.ghsa).filter((g) => !detected.includes(g));
  return { detected, exempted, unexempted, stale };
}

async function main(): Promise<void> {
  // ── ① bun audit 全链零漏洞 ──
  // bun audit 需联网拉漏洞库，CI 网络瞬断会报 "audit request failed"（非漏洞
  // 检出）——区分两类失败：请求失败走重试（指数退避 4 次），真检出漏洞即红。
  // 重试耗尽仍请求失败 = 基础设施故障红（明确文案，不静默放行安全闸门）。
  const AUDIT_ATTEMPTS = 4;
  let auditOk = false;
  let auditLastOut = "";
  for (let attempt = 1; attempt <= AUDIT_ATTEMPTS; attempt++) {
    const result = runAuditAttempt(root);
    auditLastOut = result.out;
    if (result.ok) {
      auditOk = true;
      break;
    }
    if (!result.requestFailed) {
      // 非请求类失败 = 漏洞检出（或其它断言级失败）：先对账豁免清单——
      // 检出全部命中登记才放行（过期登记在下方统一核销面判），否则原样红。
      const rec = reconcileAuditExemptions(result.out, AUDIT_EXEMPT);
      if (rec.unexempted.length > 0) {
        console.error(result.out);
        fail(`bun audit 检出未豁免漏洞（期望清零）：${rec.unexempted.join(", ")}`);
      }
      auditOk = true;
      break;
    }
    if (attempt < AUDIT_ATTEMPTS) {
      const waitMs = 5000 * attempt;
      console.warn(`⚠ ① bun audit 请求失败（第 ${attempt}/${AUDIT_ATTEMPTS} 次），${waitMs / 1000}s 后重试…`);
      Bun.sleepSync(waitMs);
    }
  }
  if (!auditOk) {
    console.error(auditLastOut);
    fail(`bun audit 连续 ${AUDIT_ATTEMPTS} 次请求失败（registry 不可达/网络故障，非漏洞检出）——人工重跑确认`);
  }
  // 豁免核销面（对称于 ④ 的过期豁免核销）：登记 id 未被本次输出报告 =
  // 上游已修/依赖已换——过期登记即红，撤销豁免与升级由门自身强制。
  // exit 0 路径：输出无任何 id → 全部登记 stale（零漏洞与残留登记互斥）。
  const recon = reconcileAuditExemptions(auditLastOut, AUDIT_EXEMPT);
  if (recon.stale.length > 0) {
    fail(`① 过期豁免登记（bun audit 未再报 ${recon.stale.join(", ")}）——上游已修复或依赖已换，请撤销登记并升级依赖`);
  }
  for (const g of recon.exempted) {
    const e = AUDIT_EXEMPT.find((x) => x.ghsa === g);
    console.warn(`⚠ ① 豁免生效：${g}（${e?.reason ?? ""}）`);
  }
  console.log("✓ ① bun audit 全链零漏洞（含豁免对账）");

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
  // manifest 清单 = root 固定 + apps/*/packages/* 经 Glob 扫描（新增 workspace
  // 包自动入断言面，免手维护清单漂移）。
  const manifests = ["package.json"];
  for (const pattern of ["apps/*/package.json", "packages/*/package.json"] as const) {
    for await (const rel of new Bun.Glob(pattern).scan({ cwd: root })) {
      manifests.push(rel);
    }
  }
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
    // 豁免唯一通道：仓库根相对 posix 路径精确匹配 + 一行理由留痕；过期豁免由下方核销断言守护（配置漂移即红）。
    {
      file: "apps/daemon/src/infrastructure/assembly/buildSessionStack.ts",
      reason:
        "组合根接线密集期：协调系列（U0a-U7：写事实/护栏/占用/注入）与沙箱系列（seatbelt/helper/fallback）六批接线集中于此；待组合根按域分组重构后撤销豁免",
    },
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

  console.log("audit-assert: 全部断言通过");
}

// import.meta.main 守卫：runAuditAttempt 等纯函数面被测试 import，导入不得
// 触发断言副作用（M13 批 #2.40 可测化改造）。
if (import.meta.main) {
  await main();
}
