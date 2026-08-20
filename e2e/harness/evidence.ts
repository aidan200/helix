/**
 * 证据工具 —— 截图 / 断言输出落 evidence/e2e/（文件名含 CL-7，门控识别）。
 * 证据归属：当前迭代目录（T4.2 / F(5).1 / AD-1——EVIDENCE_DIR 迭代感知
 * 动态化，消除跨仓库边界硬编码；迭代目录迁移时不再改任何字面量）。
 *
 * 迭代标识解析（三态契约，无静默兜底）：
 *   ① 环境变量 HELIX_EVIDENCE_ITER（值 = 迭代 id）优先；
 *   ② 缺省从 git 分支解析（dev-<iterId> → <iterId>）；
 *   ③ 其他分支 / 非 git 环境 → 报错，提示显式指定 HELIX_EVIDENCE_ITER。
 * 工作区根解析：从本目录向上查找含 docs/iterations 的祖先目录（main 仓
 * 就地命中；worktree 向上穿透 .worktrees 达主工作区）；找不到 → 报错退出。
 */
import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import type { Page } from "@playwright/test";

/** 当前迭代 id（env → git 分支 → 报错兜底；进程内解析一次后缓存）。 */
function resolveIterId(): string {
  const envIter = process.env.HELIX_EVIDENCE_ITER?.trim();
  if (envIter) return envIter;
  let branch = "";
  try {
    branch = execSync("git rev-parse --abbrev-ref HEAD", {
      cwd: __dirname,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    branch = "";
  }
  const match = /^dev-(.+)$/.exec(branch);
  if (match) return match[1];
  throw new Error(
    `EVIDENCE_DIR 迭代解析失败：当前分支 "${branch || "(无法解析)"}" 非 dev-<iterId> 形态。` +
      `请显式指定环境变量 HELIX_EVIDENCE_ITER=<iterId> 后重跑。`,
  );
}

/** 工作区根（含 docs/iterations 的最近祖先；main 仓与 worktree 均可达主工作区）。 */
function resolveWorkspaceRoot(): string {
  let dir = __dirname;
  for (;;) {
    if (fs.existsSync(path.join(dir, "docs", "iterations"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) {
      throw new Error(
        `EVIDENCE_DIR 工作区根解析失败：从 ${__dirname} 向上未找到含 docs/iterations 的祖先目录。`,
      );
    }
    dir = parent;
  }
}

let cachedEvidenceDir: string | undefined;

/** 证据落位目录：<workspaceRoot>/docs/iterations/<iterId>/evidence/e2e/。 */
function evidenceDir(): string {
  if (!cachedEvidenceDir) {
    cachedEvidenceDir = path.join(
      resolveWorkspaceRoot(),
      "docs",
      "iterations",
      resolveIterId(),
      "evidence",
      "e2e",
    );
  }
  return cachedEvidenceDir;
}

/**
 * prefix：文件名闭环 id 前缀（F 层缺省 CL-7；E 层 spec 传
 * CL-7 / CL-6-CL-7 / CL-7-CL-8 等，保证 e2e_loops_covered 门控可识别）。
 */
export function evidencePath(name: string, ext: string, prefix = "CL-7"): string {
  const dir = evidenceDir();
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  return path.join(dir, `${prefix}-${name}-${stamp}.${ext}`);
}

export async function shotEvidence(page: Page, name: string, prefix = "CL-7"): Promise<string> {
  const file = evidencePath(name, "png", prefix);
  await page.screenshot({ path: file, fullPage: false });
  return file;
}

export function writeEvidence(name: string, ext: string, content: string, prefix = "CL-7"): string {
  const file = evidencePath(name, ext, prefix);
  fs.writeFileSync(file, content, "utf8");
  return file;
}
