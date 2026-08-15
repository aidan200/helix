/**
 * 证据工具 —— 截图 / 断言输出落 evidence/e2e/（文件名含 CL-7，门控识别）。
 */
import * as fs from "node:fs";
import * as path from "node:path";
import type { Page } from "@playwright/test";

const EVIDENCE_DIR = path.resolve(
  __dirname,
  "../../../../docs/iterations/iter-20260815-6tss/evidence/e2e",
);

export function evidencePath(name: string, ext: string): string {
  fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  return path.join(EVIDENCE_DIR, `CL-7-${name}-${stamp}.${ext}`);
}

export async function shotEvidence(page: Page, name: string): Promise<string> {
  const file = evidencePath(name, "png");
  await page.screenshot({ path: file, fullPage: false });
  return file;
}

export function writeEvidence(name: string, ext: string, content: string): string {
  const file = evidencePath(name, ext);
  fs.writeFileSync(file, content, "utf8");
  return file;
}
