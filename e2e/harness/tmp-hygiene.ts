/**
 * TMPDIR 卫生审计（T4.3 / CL-7 / TR-TEST-6 外补：E 层跑前全前缀预检）。
 *
 * 判据：$TMPDIR（os.tmpdir()）下 helix-* 前缀条目数 = 0 才放行；非零
 * fail-fast 并报清单。拦截两类残留：①中断遗留（SIGKILL/断电使 teardown
 * 的 rmSync 没跑成）；②并发/历史残留（别轮套件、旧迭代死前缀）。
 *
 * 长驻排除（T4.2 / F(5).2 / AD-1——白名单过滤，不弱化检出力）：
 * HELIX_LONG_RUNNING_PREFIXES 命中的长驻应用前缀目录不计残留，
 * 其余 helix-* 前缀真实临时残留仍检出。
 *
 * 挂点：e2e-global-setup.ts（与端口 5333 预检同位，先于构建）。
 * 单测自证：`bun e2e/harness/tmp-hygiene.ts`（CLI 形态：有残留 exit 1
 * 报清单，干净 exit 0）——构造残留→红 / 清理→绿 两路径由此机械验证。
 *
 * 边界：只识别 helix-* 前缀（本项目面），不碰 TMPDIR 下其他项目条目。
 */
import { readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

/** helix 项目 tmp 条目统一前缀（全前缀面：t15/t23/e2e/ws/… 一律纳入）。 */
export const HELIX_TMP_PREFIX = "helix-";

/**
 * 长驻应用前缀排除表（T4.2 / F(5).2）：长驻进程持有的 tmp 条目不属
 * 中断/历史残留，不计卫生判据。硬编码起步（来源口径：硬编码清单，
 * 配置化登记入池——扩展点：新增长驻应用时在此追加前缀）。
 */
export const HELIX_LONG_RUNNING_PREFIXES = ["helix-deck"] as const;

/** $TMPDIR 下 helix-* 残留条目清单（绝对路径；空数组 = 卫生达标）。 */
export function listHelixTmpResidue(base: string = tmpdir()): string[] {
  return readdirSync(base)
    .filter(
      (name) =>
        name.startsWith(HELIX_TMP_PREFIX) &&
        !HELIX_LONG_RUNNING_PREFIXES.some((longRunning) => name.startsWith(longRunning)),
    )
    .map((name) => join(base, name));
}

/** 卫生审计断言：有残留即抛错（fail-fast，附全量清单指引人工清理）。 */
export function assertTmpHygiene(base: string = tmpdir()): void {
  const residue = listHelixTmpResidue(base);
  if (residue.length === 0) return;
  throw new Error(
    [
      `TMPDIR 卫生审计未通过：${base} 下检出 ${residue.length} 条 helix-* 残留`,
      "（中断遗留/历史残留会污染本轮断言面）。清理后重跑，清单：",
      ...residue.map((p) => `  - ${p}`),
    ].join("\n"),
  );
}

// CLI 形态：bun e2e/harness/tmp-hygiene.ts（红绿自证入口）
// 注：不能用 import.meta.main——playwright 经 CJS transform 加载本模块，
// import.meta 在该形态下语法非法（会拖垮 globalSetup 导入）。改用
// argv[1] 与 __filename 比对（bun ESM 与 playwright CJS 下均定义 __filename）。
if (process.argv[1] && resolve(process.argv[1]) === __filename) {
  try {
    assertTmpHygiene();
    console.log(`✓ TMPDIR 卫生审计通过：${tmpdir()} 下 helix-* 零命中`);
  } catch (err) {
    console.error(`✗ ${(err as Error).message}`);
    process.exit(1);
  }
}
