/**
 * AG 架构守护（前端半，A 层扫描；测试点见 test-design §6）：
 * - AG-13 两端协议同源：shared/api import @helix/protocol，仓库无平行协议定义；
 * - AG-14 前端零权威状态：localStorage 键白名单（helix-theme / helix-lang），
 *   无 sessionStorage / 无业务状态持久化（重连无本地补齐由 reducer 测试②守护）；
 * - AG-15 FSD 依赖方向：app → pages → widgets → features → entities → shared，
 *   只准上层引下层、同层仅同 slice 内互引；
 * - AG-16 i18n 纪律：组件源码（注释剥离后）零硬编码 CJK 文案（i18n 词条包
 *   与测试文件豁免；领域数据经协议 DTO 传入不在扫描面）。
 */
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const SRC_ROOT = fileURLToPath(new URL("..", import.meta.url));

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      out.push(...walk(full));
    } else if (/\.(ts|tsx)$/.test(name)) {
      out.push(full);
    }
  }
  return out;
}

const allFiles = walk(SRC_ROOT);
const rel = (f: string) => relative(SRC_ROOT, f);
const sourceOf = (f: string) => readFileSync(f, "utf8");

/** 剥离块注释与行注释（先掩 URL 字面量，避免误伤 http:// ws:// 字符串）。 */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(?:https?|wss?):\/\/[^\s"'`)]+/g, "")
    .replace(/\/\/.*$/gm, "");
}

// ── AG-13 两端协议同源 ──────────────────────────────────────

describe("AG-13 两端协议同源（前端半）", () => {
  it("shared/api 源文件 import @helix/protocol", () => {
    const ws = sourceOf(join(SRC_ROOT, "shared/api/helix-ws.ts"));
    expect(ws).toMatch(/from "@helix\/protocol"/);
  });

  it("apps/shell 内无平行协议定义（信封/事件目录不重复导出）", () => {
    const offenders = allFiles.filter((f) => {
      const src = stripComments(sourceOf(f));
      return /export (const|type|interface) (EVENT_TYPES|COMMAND_TYPES|Envelope|EventEnvelope)\b/.test(src);
    });
    expect(offenders.map(rel)).toEqual([]);
  });
});

// ── AG-14 前端零权威状态 ────────────────────────────────────

describe("AG-14 前端零权威状态", () => {
  const LOCALSTORAGE_KEYS = new Set(["helix-theme", "helix-lang"]);

  it("localStorage 键白名单：仅主题与 i18n（无业务状态持久化）", () => {
    const offenders: string[] = [];
    for (const f of allFiles) {
      if (f.endsWith(".test.ts") || f.endsWith(".test.tsx")) continue;
      const src = stripComments(sourceOf(f));
      for (const m of src.matchAll(/(?:localStorage|sessionStorage)\.(?:get|set|remove)Item\(\s*["']([^"']+)["']/g)) {
        const key = m[1]!;
        if (!LOCALSTORAGE_KEYS.has(key)) offenders.push(`${rel(f)}: ${key}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("reducer 纯函数面无任何 storage / fetch / Date.now 访问（重放确定性的静态面）", () => {
    const src = stripComments(sourceOf(join(SRC_ROOT, "entities/session/model/session-reducer.ts")));
    expect(src).not.toMatch(/localStorage|sessionStorage|fetch\(|Date\.now/);
  });
});

// ── AG-15 FSD 依赖方向 ─────────────────────────────────────

describe("AG-15 FSD 依赖方向", () => {
  const LAYERS = ["app", "pages", "widgets", "features", "entities", "shared"] as const;
  type Layer = (typeof LAYERS)[number];
  const layerOf = (seg: string): Layer | undefined =>
    (LAYERS as readonly string[]).includes(seg) ? (seg as Layer) : undefined;

  /** slice 标识：pages/widgets/features/entities 取前两段，app/shared 取首段。 */
  function sliceOf(parts: string[]): string {
    const l = layerOf(parts[0]!);
    if (l === "app" || l === "shared") return l!;
    return parts.slice(0, 2).join("/");
  }

  it("只准上层引下层；同层仅同 slice 内互引", () => {
    const offenders: string[] = [];
    for (const f of allFiles) {
      const relPath = rel(f);
      const parts = relPath.split("/");
      const myLayer = layerOf(parts[0]!);
      if (!myLayer) continue; // tests 等非分层目录不查
      const mySlice = sliceOf(parts);
      const src = stripComments(sourceOf(f));
      for (const m of src.matchAll(/from\s+["']@(\/[^"']+)["']/g)) {
        const target = m[1]!.slice(1).split("/");
        const targetLayer = layerOf(target[0]!);
        if (!targetLayer) continue; // 非分层目标（不存在）忽略
        const myIdx = LAYERS.indexOf(myLayer);
        const targetIdx = LAYERS.indexOf(targetLayer);
        if (targetIdx > myIdx) continue; // 引下层：合法
        if (targetIdx === myIdx && sliceOf(target) === mySlice) continue; // 同 slice：合法
        offenders.push(`${relPath} -> @/${target.join("/")}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});

// ── AG-16 i18n 纪律 ────────────────────────────────────────

describe("AG-16 i18n key 纪律（前端半）", () => {
  it("组件源码（注释剥离后）零硬编码 CJK 文案", () => {
    const exempt = (f: string): boolean =>
      f.endsWith(".test.ts") ||
      f.endsWith(".test.tsx") ||
      rel(f).startsWith("shared/i18n/lang/");
    const offenders: string[] = [];
    for (const f of allFiles) {
      if (exempt(f)) continue;
      const src = stripComments(sourceOf(f));
      if (/[\u4e00-\u9fff]/.test(src)) offenders.push(rel(f));
    }
    expect(offenders).toEqual([]);
  });
});
