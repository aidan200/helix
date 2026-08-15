import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

/**
 * 架构守护（AG）源码扫描套件 —— test-design §3 的 A 通道落地（Bun test）。
 * 本文件覆盖：AG-01（port 只接口）、AG-02（依赖方向矩阵）、AG-04（pi import 域）、
 * AG-08（与环境变量无缘）、AG-10 + TP-CL4-3（runtime 无编排模式分支）、
 * TP-CL4-5-A（runtime 不自持领域状态副本）。
 * AG-11（新增 profile 不改 runtime）为行为级验证，见 integration/test-profile.test.ts。
 */
const srcRoot = path.join(import.meta.dir, "..", "..", "src");

function listFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { recursive: true }) as string[]) {
    if (entry.endsWith(".ts")) out.push(entry);
  }
  return out;
}

function read(rel: string): string {
  return readFileSync(path.join(srcRoot, rel), "utf8");
}

/** 提取 import 说明符（静态 import/export-from）。 */
function importSpecifiers(source: string): string[] {
  const specifiers: string[] = [];
  const re = /^\s*(?:import|export)\s[^;'"]*?from\s+['"]([^'"]+)['"]/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) specifiers.push(m[1]!);
  return specifiers;
}

describe("AG-01：port 文件只有接口/类型", () => {
  test("ports/** 无函数体、无 class、非 type-only import 缺失", () => {
    const files = listFiles(path.join(srcRoot, "application", "ports"));
    expect(files.length).toBeGreaterThanOrEqual(9);
    for (const rel of files) {
      const src = read(path.join("application", "ports", rel));
      expect(src.match(/\bfunction\s+\w+\s*\(/), `${rel} 含函数定义`).toBeNull();
      expect(src.match(/\bclass\s+\w+/), `${rel} 含 class`).toBeNull();
      expect(src.match(/=>\s*\{/), `${rel} 含箭头函数体`).toBeNull();
      for (const spec of importSpecifiers(src)) {
        expect(spec, `${rel} 的 import 必须是 type-only 相对路径`).toMatch(/^(\.\.?\/|node:)/);
      }
    }
  });
});

describe("AG-02：依赖方向矩阵", () => {
  test("① domain 零包外 import（pi/bun:node/protocol/adapters/infrastructure 全禁）", () => {
    for (const rel of listFiles(path.join(srcRoot, "domain"))) {
      for (const spec of importSpecifiers(read(path.join("domain", rel)))) {
        expect(spec.startsWith("."), `domain/${rel} 不得 import 包外符号：${spec}`).toBe(true);
      }
    }
  });

  test("② application 只 import port + domain（禁 adapters/infrastructure/包外）", () => {
    for (const rel of listFiles(path.join(srcRoot, "application"))) {
      for (const spec of importSpecifiers(read(path.join("application", rel)))) {
        if (!spec.startsWith(".")) continue; // 纯类型 import 已由 AG-01 覆盖 ports；此处允许的包外为空集
        expect(spec, `application/${rel} 禁止引到 adapters/infrastructure：${spec}`).not.toMatch(/adapters|infrastructure/);
        expect(spec.startsWith("."), `application/${rel} 不得 import 包外符号：${spec}`).toBe(true);
      }
    }
  });

  test("③ driving 与 driven 互不 import", () => {
    for (const rel of listFiles(path.join(srcRoot, "adapters", "driving"))) {
      for (const spec of importSpecifiers(read(path.join("adapters", "driving", rel)))) {
        expect(spec, `driving/${rel} 不得 import driven：${spec}`).not.toContain("/driven/");
      }
    }
    for (const rel of listFiles(path.join(srcRoot, "adapters", "driven"))) {
      for (const spec of importSpecifiers(read(path.join("adapters", "driven", rel)))) {
        expect(spec, `driven/${rel} 不得 import driving：${spec}`).not.toContain("/driving/");
      }
    }
  });

  test("④ 组合根外不 new 具体 adapter/service 实现（pi-engine 内部装配与 domain 聚合除外）", () => {
    const concrete = /(ChatService|SessionService|RestoreService|CliAdapter|StdoutEventPublisher|PiAgentEngineAdapter|AgentRuntime|SteerHooks|MinimalHooks|FakeAgentEngine)\s*\(/;
    const scanDirs = ["adapters/driving", "application", "domain"];
    for (const dir of scanDirs) {
      for (const rel of listFiles(path.join(srcRoot, ...dir.split("/")))) {
        const src = read(path.join(...dir.split("/"), rel));
        const hits = src.match(new RegExp(`new\\s+${concrete.source}`, "g"));
        expect(hits, `${dir}/${rel} 出现组合根专属 new：${hits?.join(",")}`).toBeNull();
      }
    }
    // infrastructure 除 container.ts 外也不 new（main.ts 只调 createDaemon）
    for (const rel of listFiles(path.join(srcRoot, "infrastructure"))) {
      if (rel === path.join("container.ts")) continue;
      const src = read(path.join("infrastructure", rel));
      const hits = src.match(new RegExp(`new\\s+${concrete.source}`, "g"));
      expect(hits, `infrastructure/${rel} 出现组合根专属 new：${hits?.join(",")}`).toBeNull();
    }
    // main.ts 同样只经组合根
    expect(read("main.ts").match(new RegExp(`new\\s+${concrete.source}`, "g"))).toBeNull();
  });
});

describe("AG-04：pi import 只允许出现在 adapters/driven/pi-engine/", () => {
  test("src 其余目录零 @earendil-works/pi-* import", () => {
    const all = listFiles(srcRoot);
    for (const rel of all) {
      const isPiEngine = rel.startsWith(path.join("adapters", "driven", "pi-engine"));
      for (const spec of importSpecifiers(read(rel))) {
        if (spec.startsWith("@earendil-works/pi")) {
          expect(isPiEngine, `${rel} 出现 pi import（仅 pi-engine 允许）：${spec}`).toBe(true);
        }
      }
    }
  });
});

describe("AG-08：与环境变量无缘（apiKeys 只来自 config.json）", () => {
  test("src 全量无 process.env 读取", () => {
    for (const rel of listFiles(srcRoot)) {
      expect(read(rel).includes("process.env"), `${rel} 读取了环境变量（AG-08）`).toBe(false);
    }
  });
});

describe("AG-10 + TP-CL4-3：runtime 无编排模式分支", () => {
  const modeWords = /\b(main-session|subagent|phase|kg)\b/i;
  test("runtime 逻辑源码（含 hooks/）不含模式标识符", () => {
    const files = listFiles(path.join(srcRoot, "adapters", "driven", "pi-engine", "runtime"))
      .filter((rel) => !rel.startsWith(path.join("profiles")));
    for (const rel of files) {
      const src = read(path.join("adapters", "driven", "pi-engine", "runtime", rel));
      expect(src.match(modeWords), `runtime/${rel} 出现编排模式词：${src.match(modeWords)?.[0]}`).toBeNull();
    }
  });
  test("runtime/profiles/ 为纯声明式（无函数/分支）——模式词只允许出现在声明数据里", () => {
    for (const rel of listFiles(path.join(srcRoot, "adapters", "driven", "pi-engine", "runtime", "profiles"))) {
      const src = read(path.join("adapters", "driven", "pi-engine", "runtime", "profiles", rel));
      expect(src.match(/\bfunction\b|=>|\bif\s*\(/), `profiles/${rel} 应为纯声明式对象`).toBeNull();
    }
  });
});

describe("TP-CL4-5（A 半）：runtime 不自持领域状态副本", () => {
  test("runtime/ 不 import domain 聚合（AgentLifecycle/SteerQueue/Session）", () => {
    for (const rel of listFiles(path.join(srcRoot, "adapters", "driven", "pi-engine", "runtime"))) {
      const src = read(path.join("adapters", "driven", "pi-engine", "runtime", rel));
      expect(src.match(/AgentLifecycle|SteerQueue|\bSession\b/), `runtime/${rel} 引用了领域聚合`).toBeNull();
      for (const spec of importSpecifiers(src)) {
        expect(spec, `runtime/${rel} 不得 import domain：${spec}`).not.toContain("/domain/");
      }
    }
  });
});
