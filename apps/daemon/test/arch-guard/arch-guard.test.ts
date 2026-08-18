import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

/**
 * 架构守护（AG）源码扫描套件 —— test-design §3 的 A 通道落地（Bun test）。
 * 本文件覆盖：AG-01（port 只接口）、AG-02（依赖方向矩阵）、AG-04（pi import 域）、
 * AG-08（与环境变量无缘）、AG-10 + TP-CL4-3（runtime 无编排模式分支）、AG-06（SQLite 写点唯一）、
 * TP-CL4-5-A（runtime 不自持领域状态副本）、AG-05/TP-CL5-4（运行时依赖白名单）、
 * TP-CL5-1-A（四工具 import 源与封装边界）、TP-CL5-2-A（grep 匹配核 framework-free）。
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

  test("② application 包外 import 显式白名单 = {@helix/protocol, node:path}（禁 adapters/infrastructure）", () => {
    // T4.1（TP-CL5-2，CL-5 裁决）：白名单是断言数据不是注释——新增包外
    // import 未进白名单 = 测试红（防复发）。旧实现以 `continue` 静默放行
    // 非相对 import + 恒真断言（死代码），与实有 4 处包外 import
    // （3 × @helix/protocol MAIN_INSTANCE_ID + 1 × node:path join）不符。
    const PACKAGE_WHITELIST: ReadonlySet<string> = new Set(["@helix/protocol", "node:path"]);
    for (const rel of listFiles(path.join(srcRoot, "application"))) {
      for (const spec of importSpecifiers(read(path.join("application", rel)))) {
        expect(spec, `application/${rel} 禁止引到 adapters/infrastructure：${spec}`).not.toMatch(/adapters|infrastructure/);
        if (!spec.startsWith(".")) {
          expect(
            PACKAGE_WHITELIST.has(spec),
            `application/${rel} 包外 import 越出白名单 {@helix/protocol, node:path}：${spec}`,
          ).toBe(true);
        }
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
    const concrete = /(ChatService|SessionService|RestoreService|SchedulerService|SubagentLauncher|CliAdapter|StdoutEventPublisher|PiAgentEngineAdapter|AgentRuntime|SteerHooks|MinimalHooks|FakeAgentEngine|WsServerAdapter|EventStream|StaticServe|WriteQueue|SqliteSessionRepository|CoreToolExecutor)\s*\(/;
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

describe("AG-04：pi import 只允许出现在 driven 域（pi-engine/tools/subagent）", () => {
  test("src 其余目录零 @earendil-works/pi-* import", () => {
    const all = listFiles(srcRoot);
    // T2.2：subagent/ 是 pi driven 域的子进程形态（launcher 透传 Model、
    // ChildMain 复用 pi-engine 防腐墙、剧本引擎用 pi-ai 流原语）——TR-AD-7
    // 「pi import 只在 driven 域」语义不变，白名单新增第三个 driven 根。
    const allowedRoots = [
      path.join("adapters", "driven", "pi-engine"),
      path.join("adapters", "driven", "tools"),
      path.join("adapters", "driven", "subagent"),
    ];
    for (const rel of all) {
      const isAllowed = allowedRoots.some((root) => rel.startsWith(root));
      for (const spec of importSpecifiers(read(rel))) {
        if (spec.startsWith("@earendil-works/pi")) {
          expect(isAllowed, `${rel} 出现 pi import（仅 driven 域 pi-engine/tools/subagent 允许）：${spec}`).toBe(true);
        }
      }
    }
  });
});

describe("TP-CL5-1（A 半）：core 四工具接线与封装边界（AD-10 / F(5).1 标准 1、4）", () => {
  const toolsDir = path.join("adapters", "driven", "tools");
  const executorRel = path.join(toolsDir, "CoreToolExecutor.ts");
  const toolFactories = ["createBashTool", "createReadTool", "createWriteTool", "createEditTool"];

  test("① 四工具工厂 + NodeExecutionEnv 的 import 源恰为 pi-agent-core/node 子入口", () => {
    const src = read(executorRel);
    for (const factory of toolFactories) {
      expect(src.includes(factory), `${executorRel} 缺少 ${factory} 接线`).toBe(true);
    }
    // import 语句中的源必须是 node 子入口（F-7 红线：Node 执行环境经 /node）
    const importBlock = src.split("\n").filter((l) => l.includes("from \"@earendil-works/pi-agent-core"));
    expect(importBlock.length).toBeGreaterThan(0);
    for (const line of importBlock) {
      expect(line.includes('"@earendil-works/pi-agent-core/node"'), `非 /node 子入口 import：${line}`).toBe(true);
    }
  });

  test("② pi 工具符号不外泄：工具工厂只出现在 tools 目录内", () => {
    const all = listFiles(srcRoot);
    for (const rel of all) {
      if (rel.startsWith(toolsDir)) continue;
      for (const factory of toolFactories) {
        expect(read(rel).includes(factory), `${rel} 出现 pi 工具符号 ${factory}（只允许在 tools 目录）`).toBe(false);
      }
    }
  });

  test("③ 封装边界装配在组合根：pi-engine 与 driven/tools 互不 import", () => {
    for (const rel of listFiles(path.join(srcRoot, "adapters", "driven", "pi-engine"))) {
      for (const spec of importSpecifiers(read(path.join("adapters", "driven", "pi-engine", rel)))) {
        expect(spec, `pi-engine/${rel} 不得 import tools 目录：${spec}`).not.toMatch(/driven[\\/]tools/);
      }
    }
    for (const rel of listFiles(path.join(srcRoot, toolsDir))) {
      for (const spec of importSpecifiers(read(path.join(toolsDir, rel)))) {
        expect(spec, `tools/${rel} 不得 import pi-engine 目录：${spec}`).not.toMatch(/driven[\\/]pi-engine/);
      }
    }
  });
});

describe("TP-CL5-2（A 半）：grep 匹配核 framework-free（不碰 fs/node）", () => {
  test("GrepTool.ts 无 node:* / fs import（遍历经注入的 ExecutionEnv）", () => {
    const src = read(path.join("adapters", "driven", "tools", "GrepTool.ts"));
    expect(src.includes('"node:'), "GrepTool.ts 不得 import node 内建").toBe(false);
    expect(src.includes("require("), "GrepTool.ts 不得 require").toBe(false);
  });
});

describe("AG-05 / TP-CL5-4：运行时依赖白名单（daemon 不引入 pi-coding-agent）", () => {
  test("daemon dependencies：pi 系恰为 {pi-agent-core, pi-ai}，全集为基线三键（不新增）", () => {
    const pkg = JSON.parse(readFileSync(path.join(srcRoot, "..", "package.json"), "utf8")) as {
      dependencies: Record<string, string>;
    };
    const deps = Object.keys(pkg.dependencies).sort();
    // @helix/protocol：workspace 内部协议包（T1.2 引入、T1.6 ws-server 运行时用），不计入 pi 系口径
    expect(deps).toEqual(["@earendil-works/pi-agent-core", "@earendil-works/pi-ai", "@helix/protocol"]);
    const piDeps = deps.filter((d) => d.startsWith("@earendil-works/"));
    expect(piDeps).toEqual(["@earendil-works/pi-agent-core", "@earendil-works/pi-ai"]);
  });

  test("全仓（daemon + 根）零 pi-coding-agent / pi-server / pi-proxy 系依赖", () => {
    const daemonPkg = readFileSync(path.join(srcRoot, "..", "package.json"), "utf8");
    const rootPkg = readFileSync(path.join(srcRoot, "..", "..", "..", "package.json"), "utf8");
    for (const raw of [daemonPkg, rootPkg]) {
      expect(raw.includes("pi-coding-agent"), "不得引入 pi-coding-agent").toBe(false);
      expect(raw.includes("pi-server"), "不得引入 pi-server").toBe(false);
      expect(raw.includes("pi-proxy"), "不得引入 pi-proxy").toBe(false);
    }
  });
});

describe("AG-06：SQLite 写点唯一（AD-16，TP-CL8-2 负命题佐证）", () => {
  const writePatterns: [string, RegExp][] = [
    ["new Database", /new\s+Database\s*\(/],
    ["db.exec 调用", /\.exec\s*\(/],
    ["INSERT INTO", /\bINSERT\s+INTO\b/i],
    ["DELETE FROM", /\bDELETE\s+FROM\b/i],
    ["UPDATE … SET", /\bUPDATE\s+\w+\s+SET\b/i],
  ];
  const writeQueueRel = path.join("adapters", "driven", "sqlite-session", "WriteQueue.ts");

  test("① src 内 SQLite 写操作调用点仅存在于 sqlite-session/WriteQueue.ts", () => {
    for (const rel of listFiles(srcRoot)) {
      const src = read(rel);
      const isWriteQueue = rel === writeQueueRel;
      for (const [label, pattern] of writePatterns) {
        const hit = src.match(pattern);
        expect(
          hit === null || isWriteQueue,
          `${rel} 出现 SQLite 写点「${label}」（仅 WriteQueue 允许）`,
        ).toBe(true);
      }
    }
  });

  test("② 组合根全局单写队列：container.ts 仅 new 一个 WriteQueue，仓库经它写", () => {
    const src = read(path.join("infrastructure", "container.ts"));
    expect(src.match(/new\s+WriteQueue\(/g)?.length).toBe(1);
    expect(src.match(/new\s+SqliteSessionRepository\(/g)?.length).toBe(1);
  });

  test("③ T2.3 closure 写面收敛：closure_records/reports 写语句只在 WriteQueue，DDL 只在 schema", () => {
    // closure_records 的 SQL 写语句（INSERT/DELETE/UPDATE）只允许 WriteQueue；
    // DDL 只允许 schema.ts；服务层注释提及表名不算写点（扫 SQL 而非词面）
    const closureSql = /(INSERT\s+INTO|DELETE\s+FROM|UPDATE)\s+closure_records/i;
    for (const rel of listFiles(srcRoot)) {
      const src = read(rel);
      const isWriteQueue = rel === writeQueueRel;
      const isSchema = rel === path.join("adapters", "driven", "sqlite-session", "schema.ts");
      if (closureSql.test(src)) {
        expect(isWriteQueue, `${rel} 出现 closure_records SQL 写语句（只允许 WriteQueue）`).toBe(true);
      }
      if (/CREATE\s+TABLE[^;]*closure_records/i.test(src)) {
        expect(isSchema, `${rel} 出现 closure_records DDL（只允许 schema.ts）`).toBe(true);
      }
      if (/renameSync/.test(src)) {
        // T2.3（AD-2）：原子替换写新增两合法面——auth.json（infrastructure/
        // auth-store.ts，0600+锁）与 models-store.json（pi-engine/model-
        // catalog.ts 落盘兑底）；SQLite reportFile 原子写仍只允许 WriteQueue
        const isAuthStore = rel === path.join("infrastructure", "auth-store.ts");
        const isModelCatalog = rel === path.join("adapters", "driven", "pi-engine", "model-catalog.ts");
        expect(
          isWriteQueue || isAuthStore || isModelCatalog,
          `${rel} 出现原子替换写（只允许 WriteQueue reportFile / auth-store / model-catalog）`,
        ).toBe(true);
      }
    }
    // 两写面真实存在（扫描面与实现同步扩——防扫描空转）
    const wq = read(writeQueueRel);
    expect(wq).toContain('"closureRecord"');
    expect(wq).toContain('"reportFile"');
    expect(wq).toContain("INSERT INTO closure_records");
    expect(read(path.join("adapters", "driven", "sqlite-session", "schema.ts"))).toContain(
      "CREATE TABLE IF NOT EXISTS closure_records",
    );
  });
});

describe("AG-08：与环境变量无缘（apiKeys 只来自 auth.json）", () => {
  test("src 全量无 process.env 读取（subagent/ 除外——env 是父子进程 IPC 通道，非配置源）", () => {
    // T2.2：SubAgent 子进程的 argv/env 由父进程（组合根）显式注入
    // （HELIX_MODEL_JSON/HELIX_API_KEYS_JSON 等）——env 在 subagent/ 内是
    // 父子 IPC 传输通道，不是配置来源。T2.3（AD-2 auth 分层）起 apiKeys
    // 源头仍且仅是 auth.json（AuthStore，0600+文件锁；旧 config.json 含
    // apiKeys 字段时启动迁移，见 infrastructure/config.ts）。
    const whitelistRoot = path.join("adapters", "driven", "subagent");
    for (const rel of listFiles(srcRoot)) {
      if (rel.startsWith(whitelistRoot)) continue;
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

describe("AG-12 / TP-CL6-3（A 半）：ws-server 编排在 service（import 白名单）", () => {
  const wsDir = path.join(srcRoot, "adapters", "driving", "ws-server");

  /** 运行时 import 允许集：ports（in/out）+ @helix/protocol + Bun/Node 内建 + 目录内。
   * 目录内 = 相对导入解析后不逃出 ws-server 目录树（T1.1 AD-3：handlers/ 子目录
   * 回引 ../EventStream 等同属目录内；语义不变，仅路径感知化）。 */
  function runtimeAllowed(rel: string, spec: string): boolean {
    if (
      spec === "@helix/protocol" ||
      spec.startsWith("node:") ||
      spec === "bun" ||
      /\/ports\/(inbound|outbound)\//.test(spec)
    ) {
      return true;
    }
    if (spec.startsWith("./") || spec.startsWith("../")) {
      const resolved = path.normalize(path.join(path.dirname(rel), spec));
      return resolved !== ".." && !resolved.startsWith(`..${path.sep}`);
    }
    return false;
  }

  test("运行时 import ⊆ {inbound/outbound ports, @helix/protocol, Bun 内建, 目录内}；domain 仅 type-only（AD-17.5 转换）", () => {
    const files = listFiles(wsDir);
    expect(files.length).toBeGreaterThanOrEqual(3); // WsServerAdapter/EventStream/DtoMapper
    for (const rel of files) {
      const src = read(path.join("adapters", "driving", "ws-server", rel));
      for (const spec of importSpecifiers(src)) {
        const isDomain = /\/domain\//.test(spec);
        if (isDomain) {
          // domain 只允许 type-only import（无运行时耦合，无业务规则调用）
          expect(typeOnly(spec, src), `ws-server/${rel} 对 domain 只允许 import type：${spec}`).toBe(true);
        } else {
          expect(runtimeAllowed(rel, spec), `ws-server/${rel} 运行时 import 越界：${spec}`).toBe(true);
        }
      }
      // 白名单的否定面：禁 services/infrastructure/driven
      for (const spec of importSpecifiers(src)) {
        expect(spec, `ws-server/${rel} 不得依赖 service/infra/driven：${spec}`).not.toMatch(/services\/|infrastructure\/|\/driven\//);
      }
    }
  });
});

describe("AG-13：协议两端同源基线（@helix/protocol 唯一权威源）", () => {
  test("ws-server 正向 import @helix/protocol（协议类型不得本地重写）", () => {
    const wsDir = path.join(srcRoot, "adapters", "driving", "ws-server");
    const all = listFiles(wsDir)
      .map((rel) => read(path.join("adapters", "driving", "ws-server", rel)))
      .join("\n");
    expect(all).toContain('"@helix/protocol"');
  });

  test("src 内无平行手写协议类型声明（信封/握手/目录联合/DTO 的 canonical 名）", () => {
    const canonical = [
      /interface\s+Envelope\b/,
      /interface\s+HelloCommand\b/,
      /interface\s+HelloPayload\b/,
      /type\s+CommandEnvelope\s*=/,
      /type\s+EventEnvelope\s*=/,
      /interface\s+SessionSnapshotDto\b/,
      /interface\s+MessageEntryDto\b/,
      /interface\s+ToolCallEntryDto\b/,
    ];
    for (const rel of listFiles(srcRoot)) {
      const src = read(rel);
      for (const re of canonical) {
        expect(src.match(re), `${rel} 平行手写协议类型：${re.source}`).toBeNull();
      }
    }
  });
});

describe("AG-14 / TP-CL2-3（守护半）：monitor 白名单过滤唯一位于 EventStream 分发层", () => {
  test("白名单常量/tier 表符号不出现在 EventStream.ts 之外（service/DtoMapper/adapter 零过滤逻辑，TR-AD-23③）", () => {
    const offenders: string[] = [];
    for (const rel of listFiles(srcRoot)) {
      if (rel === path.join("adapters", "driving", "ws-server", "EventStream.ts")) continue;
      const src = read(rel);
      if (/MONITOR_TIER_EVENT_TYPES|sessionTiers|SubscriptionTier/.test(src)) offenders.push(rel);
    }
    expect(offenders, `白名单/tier 符号散落：${offenders.join(", ")}`).toEqual([]);
  });
});

/** 判断某说明符是否仅以 `import type` 形式被引入。 */
function typeOnly(spec: string, source: string): boolean {
  const typeRe = new RegExp(
    `^\\s*import\\s+type\\s[^;'"']*?from\\s+['"]${spec.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}['"]`,
    "m",
  );
  const valueRe = new RegExp(
    `^\\s*import\\s+(?!type\\b)[^;'"']*?from\\s+['"]${spec.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}['"]`,
    "m",
  );
  return typeRe.test(source) && !valueRe.test(source);
}
