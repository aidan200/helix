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
  // T3.2：+ helix-sidebar-collapsed（侧栏折叠记忆——纯 UI 布局偏好，非业务状态）
  const LOCALSTORAGE_KEYS = new Set(["helix-theme", "helix-lang", "helix-sidebar-collapsed"]);

  it("localStorage 键白名单：主题 / i18n / 侧栏折叠（无业务状态持久化）", () => {
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

  /** C2 拆分（AD-3/T1.1）后 reducer 纯函数面 = entities/session/model 全目录非测试 TS
   *  （主文件 + 状态/共享投影工具 + dispatcher + consumers；后续新文件自动入列）。 */
  const MODEL_DIR = join(SRC_ROOT, "entities/session/model");
  const reducerPureFiles = walk(MODEL_DIR).filter((f) => !/\.(test|spec)\.[jt]sx?$/.test(f));

  /** C2 拆分落位清单（brief T1.1 + T3.1 拓扑/路由扩展）：dispatcher 壳与
   * 帧入口 + 五块消费者（+ directory/history/model v0.2 真消费）+ 状态/
   * 共享工具 + store 拓扑层。 */
  const C2_SPLIT_FILES = [
    "entities/session/model/session-reducer.ts",
    "entities/session/model/state.ts",
    "entities/session/model/entries.ts",
    "entities/session/model/channel.ts",
    "entities/session/model/instance-cards.ts",
    "entities/session/model/topology.ts",
    "entities/session/model/dispatcher/index.ts",
    "entities/session/model/dispatcher/frame.ts",
    "entities/session/model/consumers/conn.ts",
    "entities/session/model/consumers/chat.ts",
    "entities/session/model/consumers/agent.ts",
    "entities/session/model/consumers/thinking-usage.ts",
    "entities/session/model/consumers/snapshot.ts",
    "entities/session/model/consumers/directory.ts",
    "entities/session/model/consumers/history.ts",
    "entities/session/model/consumers/model.ts",
  ];

  it("AG-14 纯函数扫描覆盖 C2 拆分落位清单（dispatcher/五块消费者/拓扑层与 v0.2 新消费者）", () => {
    const scanned = new Set(reducerPureFiles.map(rel));
    for (const p of C2_SPLIT_FILES) {
      expect(scanned.has(p), `纯函数面未覆盖拆分落位文件：${p}`).toBe(true);
    }
  });

  it("reducer 纯函数面无任何 storage / fetch / Date.now 访问（重放确定性的静态面）", () => {
    const offenders: string[] = [];
    for (const f of reducerPureFiles) {
      const src = stripComments(sourceOf(f));
      if (/localStorage|sessionStorage|fetch\(|Date\.now/.test(src)) offenders.push(rel(f));
    }
    expect(offenders).toEqual([]);
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
