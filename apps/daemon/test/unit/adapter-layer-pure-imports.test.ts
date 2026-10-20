import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * 驱动适配器 → application 的 import 边界（低危批备案，TR-13 张力面机械守护）。
 *
 * 口径（三个 KV store 头注同文）：驱动适配器可以 import application 的**纯常量/
 * 纯函数**单元（键位与解析语义单源，各处分写即双源），但不得 import 带依赖
 * 构造的服务类。守护面收窄到配置 store 族所在目录（sqlite-session/）——该目录
 * 之外 driven 适配器另行装配 application service（工具/编排接线面，属既有
 * 装配职责，不在本判据内）。机械判据：
 * ① sqlite-session/ 内 application import 面恰为三个配置单源（清单即白名单，
 *   新增需显式在此登记并说明纯度）；
 * ② 白名单模块自身不出现 service 类构造（`new XxxService(`）——纯单元判据；
 * ③ 三个 store 头注携带分层口径段（口径成文，改动前必读）。
 */

const DAEMON_SRC = join(import.meta.dir, "..", "..", "src");
const DRIVEN = join(DAEMON_SRC, "adapters", "driven");
const SQLITE_SESSION = join(DRIVEN, "sqlite-session");

/** 允许的 import 目标（纯函数 + 键常量单源）。 */
const ALLOWED = [
  "application/services/kg/kgConfig",
  "application/summary/summaryConfig",
  "application/voice/voiceModelConfig",
];

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (name.endsWith(".ts")) out.push(full);
  }
  return out;
}

describe("驱动适配器 → application 纯单元 import 边界", () => {
  test("① sqlite-session/ 内 application import 面恰为三个配置单源", () => {
    const hits = new Set<string>();
    for (const file of walk(SQLITE_SESSION)) {
      const src = readFileSync(file, "utf8");
      for (const m of src.matchAll(/from "(?:\.\.\/)+(application\/[^"]+)"/g)) {
        hits.add(m[1]!);
      }
    }
    // application/ports/* 恒合法（端口接口），非 ports 的才进本判据
    const nonPort = [...hits].filter((h) => !h.startsWith("application/ports/")).sort();
    expect(nonPort).toEqual([...ALLOWED].sort());
  });

  test("② 白名单模块是纯单元：不 new 服务类（纯函数/常量单源判据）", () => {
    for (const target of ALLOWED) {
      const src = readFileSync(join(DAEMON_SRC, `${target}.ts`), "utf8");
      expect(/new\s+\w*Service\s*\(/.test(src)).toBe(false);
    }
  });

  test("③ 三个配置 store 头注携带分层口径段（TR-13 张力面的成文裁决）", () => {
    for (const name of ["KgConfigStore.ts", "SummaryConfigStore.ts", "VoiceModelConfigStore.ts"]) {
      const src = readFileSync(join(SQLITE_SESSION, name), "utf8");
      expect(src).toContain("分层口径（低危批备案，TR-13 张力面）");
      expect(src).toContain("禁 import 带依赖构造的服务类");
    }
  });
});
