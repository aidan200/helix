/**
 * 指令帧唯一性机械守护（M0 验收基准；设计稿 D8——「protocol 里管家→页面的
 * 指令帧只剩一种，且域工具执行体不再直接广播页面指令帧」）：
 *
 * ① 协议面：SURFACE_INSTRUCTION_FRAME_TYPES 恰一种（surface.action）；
 *    navigate 旧帧在 DEPRECATED_EVENT_TYPES 在册（兼容期双发，M1 删除点）；
 * ② 源扫面（apps/daemon/src）：
 *    - broadcastStewardNavigate 调用点恰两处——EventStream 定义 +
 *      container 兼容镜像接线（Registry emitLegacyNavigate 的唯一下游）；
 *    - application 层（域/服务体）零页面指令帧字面量（StewardService 不
 *      直接组帧/直发广播——emitNavigate 是纯 payload 端口）；
 *    - "surface.action" 帧组装点唯一（EventStream.sendSurfaceAction——
 *      新指令帧注册面只认它）。
 */
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  DEPRECATED_EVENT_TYPES,
  SURFACE_INSTRUCTION_FRAME_TYPES,
} from "@helix/protocol";

/** daemon src 根（TR-180：import.meta.dir 锚定，cwd 无关）。 */
const SRC_ROOT = join(import.meta.dir, "..", "..", "src");

function listTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...listTsFiles(full));
    else if (name.endsWith(".ts")) out.push(full);
  }
  return out;
}

interface SourceFile {
  readonly rel: string;
  readonly text: string;
}

function scan(pattern: RegExp): SourceFile[] {
  const hits: SourceFile[] = [];
  for (const abs of listTsFiles(SRC_ROOT)) {
    const raw = readFileSync(abs, "utf8");
    // 语义扫描：剥注释后匹配（文档性提及不算组帧/调用——守护的是代码位）
    const text = stripComments(raw);
    if (pattern.test(text)) hits.push({ rel: abs.slice(SRC_ROOT.length + 1), text });
  }
  return hits;
}

/** 剥 // 行注释与 /* 块注释（守护面用；字符串内的 // 属可接受误差——目标字面量不含）。 */
function stripComments(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

describe("指令帧唯一性机械守护（D8：M0 验收基准）", () => {
  test("① 协议面：指令帧注册面恰 surface.action；旧帧 deprecated 在册且不相交", () => {
    expect([...SURFACE_INSTRUCTION_FRAME_TYPES]).toEqual(["surface.action"]);
    expect([...DEPRECATED_EVENT_TYPES]).toEqual(["steward.navigate"]);
    for (const t of DEPRECATED_EVENT_TYPES) {
      expect((SURFACE_INSTRUCTION_FRAME_TYPES as readonly string[]).includes(t)).toBe(false);
    }
  });

  test("② broadcastStewardNavigate 调用点恰两处（EventStream 定义 + container 兼容镜像）", () => {
    const hits = scan(/broadcastStewardNavigate\s*\(/);
    const rels = hits.map((h) => h.rel).sort();
    expect(rels).toEqual([
      "adapters/driving/ws-server/EventStream.ts", // 定义（帧组装单点）
      "infrastructure/container.ts", // 兼容期双发镜像接线（M1 前检查点删除点）
    ]);
    // container 内恰一行接线（防镜像面扩散）
    const container = hits.find((h) => h.rel === "infrastructure/container.ts")!;
    expect(container.text.match(/broadcastStewardNavigate\s*\(/g)?.length).toBe(1);
  });

  test("② application 层零页面指令帧直发（域工具执行体不组帧/不直发广播）", () => {
    const appHits = scan(/broadcastStewardNavigate|"steward\.navigate"|type:\s*"surface\.action"/).filter(
      (h) => h.rel.startsWith("application/"),
    );
    expect(appHits.map((h) => h.rel)).toEqual([]);
  });

  test("② surface.action 帧组装点唯一（EventStream.sendSurfaceAction——新指令帧注册面）", () => {
    const hits = scan(/type:\s*"surface\.action"/).map((h) => h.rel);
    expect(hits).toEqual(["adapters/driving/ws-server/EventStream.ts"]);
  });
});
