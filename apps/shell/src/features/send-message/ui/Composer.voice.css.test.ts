/**
 * Composer 语音镜像层样式纪律（node 环境直读样式表；jsdom 不加载 CSS；
 * thinking-level.css.test / steward-voice-layer.css.test 先例）。
 *
 * 机械判据（实时识别批）：
 * - 镜像容器与 textarea 同盒：.msg-input-wrap position: relative + flex: 1
 *  （接管原 textarea 在 .chat-inputbar 的弹性位）；
 * - .msg-interim-layer：absolute inset:0 + pointer-events: none（纯展示零
 *   交互）+ 与 textarea 同参字体/行高（--font-mono / --text-main / 1.55）
 *   + pre-wrap 换行（与 textarea 换行模型一致防错位）；
 * - 灰字：.interim 走 --text-dim（占位同灰——「未转正」语义一致，零新色板）；
 * - voice-on：textarea 自身文本与 ::placeholder 双隐（transparent——镜像层
 *   接管视觉，占位不与 interim 叠字）；
 * - 零新色板：本段无裸 hex 色值（全部 tokens.css 变量）。
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const css = readFileSync(
  fileURLToPath(new URL("../../../shared/ui/styles/app.css", import.meta.url)),
  "utf8",
);

describe("Composer 语音镜像层 CSS（实时识别批：interim 灰字同面上屏）", () => {
  it("镜像容器：position: relative + flex: 1 + min-width: 0（接管 textarea 弹性位）", () => {
    expect(css).toMatch(/\.msg-input-wrap\s*\{[^}]*position:\s*relative/);
    expect(css).toMatch(/\.msg-input-wrap\s*\{[^}]*flex:\s*1/);
    expect(css).toMatch(/\.msg-input-wrap\s*\{[^}]*min-width:\s*0/);
  });

  it("镜像层：absolute inset:0 + pointer-events: none + overflow: hidden（纯展示零交互）", () => {
    expect(css).toMatch(/\.msg-interim-layer\s*\{[^}]*position:\s*absolute[^}]*inset:\s*0/);
    expect(css).toMatch(/\.msg-interim-layer\s*\{[^}]*pointer-events:\s*none/);
    expect(css).toMatch(/\.msg-interim-layer\s*\{[^}]*overflow:\s*hidden/);
  });

  it("同参防错位：--font-mono / --text-main / line-height 1.55 / pre-wrap", () => {
    expect(css).toMatch(/\.msg-interim-layer\s*\{[^}]*font-family:\s*var\(--font-mono\)/);
    expect(css).toMatch(/\.msg-interim-layer\s*\{[^}]*font-size:\s*var\(--text-main\)/);
    expect(css).toMatch(/\.msg-interim-layer\s*\{[^}]*line-height:\s*1\.55/);
    expect(css).toMatch(/\.msg-interim-layer\s*\{[^}]*white-space:\s*pre-wrap/);
  });

  it("灰字：interim span 走 --text-dim（占位同灰——未转正语义，零新色板）", () => {
    expect(css).toMatch(/\.msg-interim-layer \.interim\s*\{[^}]*color:\s*var\(--text-dim\)/);
  });

  it("voice-on：textarea 文本与 ::placeholder 双隐（transparent——镜像层接管视觉）", () => {
    expect(css).toMatch(/\.msg-input-wrap\.voice-on textarea\s*\{[^}]*color:\s*transparent/);
    expect(css).toMatch(/\.msg-input-wrap\.voice-on textarea::placeholder\s*\{[^}]*color:\s*transparent/);
  });
});
