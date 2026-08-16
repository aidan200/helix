/**
 * 证据工具 —— 截图 / 断言输出落 evidence/e2e/（文件名含 CL-7，门控识别）。
 */
import * as fs from "node:fs";
import * as path from "node:path";
import type { Page } from "@playwright/test";

const EVIDENCE_DIR = path.resolve(
  __dirname,
  "../../../../docs/iterations/iter-20260816-uzvg/evidence/e2e",
);

/**
 * prefix：文件名闭环 id 前缀（F 层缺省 CL-7；E 层 spec 传
 * CL-7 / CL-6-CL-7 / CL-7-CL-8 等，保证 e2e_loops_covered 门控可识别）。
 */
export function evidencePath(name: string, ext: string, prefix = "CL-7"): string {
  fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  return path.join(EVIDENCE_DIR, `${prefix}-${name}-${stamp}.${ext}`);
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
