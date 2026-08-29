import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
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
  test("① domain 零包外 import（唯一例外 @helix/common；pi/bun:node/protocol/adapters/infrastructure 全禁）", () => {
    // AD-1（iter-20260821-dg90 T3.3）：MAIN_INSTANCE_ID 双源收编引入 domain 唯一
    // 包外例外 @helix/common（业务无关通用层，零依赖；T10c 常量退役后仅作
    // 结构层保留，domain 现无消费）；@helix/protocol 仍禁
    // （协议类型经 adapter/projection 层转换，TR-AD-1 例外句）。
    const DOMAIN_PACKAGE_WHITELIST: ReadonlySet<string> = new Set(["@helix/common"]);
    for (const rel of listFiles(path.join(srcRoot, "domain"))) {
      for (const spec of importSpecifiers(read(path.join("domain", rel)))) {
        expect(
          spec.startsWith(".") || DOMAIN_PACKAGE_WHITELIST.has(spec),
          `domain/${rel} 不得 import 包外符号（白名单 {@helix/common} 除外）：${spec}`,
        ).toBe(true);
      }
    }
  });

  test("② application 包外 import 显式白名单 = {@helix/common, @helix/protocol, node:path}（禁 adapters/infrastructure）", () => {
    // T4.1（TP-CL5-2，CL-5 裁决）：白名单是断言数据不是注释——新增包外
    // import 未进白名单 = 测试红（防复发）。旧实现以 `continue` 静默放行
    // 非相对 import + 恒真断言（死代码），与实有 4 处包外 import
    // （3 × @helix/protocol MAIN_INSTANCE_ID + 1 × node:path join）不符。
    // AD-1（iter-20260821-dg90 T3.3）扩为三项：+ @helix/common（业务无关
    // 通用层直引，MAIN_INSTANCE_ID 唯一定义所在，TR-AD-1/TR-AD-28）。
    const PACKAGE_WHITELIST: ReadonlySet<string> = new Set(["@helix/common", "@helix/protocol", "node:path"]);
    for (const rel of listFiles(path.join(srcRoot, "application"))) {
      for (const spec of importSpecifiers(read(path.join("application", rel)))) {
        expect(spec, `application/${rel} 禁止引到 adapters/infrastructure：${spec}`).not.toMatch(/adapters|infrastructure/);
        if (!spec.startsWith(".")) {
          expect(
            PACKAGE_WHITELIST.has(spec),
            `application/${rel} 包外 import 越出白名单 {@helix/common, @helix/protocol, node:path}：${spec}`,
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
    // T1.1（iter-20260825-11fo）：kg 栈四类（KgWriteService/KgDatabase/
    // SqliteKnowledgeStore/SqliteKnowledgeGraph）同列组合根专属构造面。
    // T1.1（iter-20260825-11fo）：kg 栈四类（KgWriteService/KgDatabase/
    // SqliteKnowledgeStore/SqliteKnowledgeGraph）同列组合根专属构造面。
    // T2.1（iter-20260829-ys7q O-4）：任务栈两类（TaskStore/WorkLedger）同列
    // ——TaskStore 装配于 assembly/buildTaskStack（父进程）；WorkLedger 两面
    // 装配（子进程直连面 T1.4 ChildMain / 父进程清理面 parentWorkLedger 工厂）
    // 均属组合根行为，业务层不得直构。
    const concrete = /(ChatService|SessionService|RestoreService|SchedulerService|SubagentLauncher|CliAdapter|StdoutEventPublisher|PiAgentEngineAdapter|AgentRuntime|SteerHooks|MinimalHooks|FakeAgentEngine|WsServerAdapter|EventStream|StaticServe|WriteQueue|SqliteSessionRepository|CoreToolExecutor|KgWriteService|KgDatabase|SqliteKnowledgeStore|SqliteKnowledgeGraph|CodegraphEngineAdapter|TaskStore|WorkLedger)\s*\(/;
    const scanDirs = ["adapters/driving", "application", "domain"];
    for (const dir of scanDirs) {
      for (const rel of listFiles(path.join(srcRoot, ...dir.split("/")))) {
        const src = read(path.join(...dir.split("/"), rel));
        const hits = src.match(new RegExp(`new\\s+${concrete.source}`, "g"));
        expect(hits, `${dir}/${rel} 出现组合根专属 new：${hits?.join(",")}`).toBeNull();
      }
    }
    // infrastructure 除组合根锚面（container.ts + assembly/**，T2.2 §4.2.1
    // AG-02④ 豁免面从单文件扩为目录）外也不 new（main.ts 只调 createDaemon）
    const assemblyRoot = path.join("assembly");
    for (const rel of listFiles(path.join(srcRoot, "infrastructure"))) {
      if (rel === path.join("container.ts") || rel.startsWith(assemblyRoot + path.sep)) continue;
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

  test("① 四工具工厂 + NodeExecutionEnv 的 import 源恰为 pi-agent-core/node 子入口；自写 edit/read/edit-lines 同名覆盖接线在位（T3.1）", () => {
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
    // T3.1（AD-12 同名覆盖，AF-1）：自写三件工厂接线在位，pi edit/read 以别名
    // 基线注册（先注册后覆盖——F-20 registry.set 无特权机制的机械形态）
    expect(src.includes("createPiEditTool()"), "pi edit 基线注册缺失").toBe(true);
    expect(src.includes("createPiReadTool()"), "pi read 基线注册缺失").toBe(true);
    expect(src.includes('from "./edit/EditTool"'), "自写 edit 接线缺失").toBe(true);
    expect(src.includes('from "./read/ReadTool"'), "自写 read 接线缺失").toBe(true);
    expect(src.includes('from "./edit-lines/EditLinesTool"'), "edit-lines 接线缺失").toBe(true);
    // 覆盖次序：自写注册必须在 pi 基线之后（registry.set 后注册者胜）
    expect(src.indexOf("createEditTool(options.edit)")).toBeGreaterThan(src.indexOf("createPiEditTool()"));
    expect(src.indexOf("createReadTool()")).toBeGreaterThan(src.indexOf("createPiReadTool()"));
    // write/bash 保留 pi（AD-12：不自写同名覆盖）
    expect(src.includes("createWriteTool()")).toBe(true);
    expect(src.includes("createBashTool()")).toBe(true);
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
  test("grep/backends/ts-backend.ts 无 node:* / fs import（遍历经注入的 ExecutionEnv）", () => {
    // T1.1（CL-3 域目录化）：匹配核随迁至 grep/backends/ts-backend.ts，同口径断言
    const src = read(path.join("adapters", "driven", "tools", "grep", "backends", "ts-backend.ts"));
    expect(src.includes('"node:'), "ts-backend.ts 不得 import node 内建").toBe(false);
    expect(src.includes("require("), "ts-backend.ts 不得 require").toBe(false);
  });
});

describe("AG-05 / TP-CL5-4：运行时依赖白名单（daemon 不引入 pi-coding-agent）", () => {
  test("daemon dependencies：pi 系恰为 {pi-agent-core, pi-ai}，全集为五键（T3.1 +diff：内核复制件 edit-diff 的 diff 展示依赖运行时引入，AF-1 裁决连带）", () => {
    const pkg = JSON.parse(readFileSync(path.join(srcRoot, "..", "package.json"), "utf8")) as {
      dependencies: Record<string, string>;
    };
    const deps = Object.keys(pkg.dependencies).sort();
    // @helix/protocol：workspace 内部协议包（T1.2 引入、T1.6 ws-server 运行时用）；
    // @helix/common：业务无关通用层（AD-1/T3.3；MAIN_INSTANCE_ID 已随 T10c
    // 退役——包级依赖与 AG-15③ 联动断言保留，待包级退役决策）——两包均不计
    // 入 pi 系口径；diff@8.0.4（T3.1/AF-1）：VENDORED edit-diff 内核的
    // generateDiffString/generateUnifiedPatch 运行时依赖，与 pi-agent-core
    // 同版锁定（pi bump 再同步时同步复核版本）；yaml@2.9.0（T2.3/AF-2.3a）：
    // TaskSkillRegistry 自解析 SKILL.md frontmatter task 块（pi loadSourcedSkills
    // 不透传附加字段），与 pi-agent-core pinned 传递依赖同版本零增树
    expect(deps).toEqual([
      "@earendil-works/pi-agent-core",
      "@earendil-works/pi-ai",
      "@helix/common",
      "@helix/protocol",
      "diff",
      "yaml",
    ]);
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
    // 限定 db 系接收者：裸 `\.exec(` 会误伤 RegExp.prototype.exec（如 T1.2
    // rg-backend 的行解析正则）——守护目标是 SQLite 写点而非一切 exec 方法。
    ["db.exec 调用", /\bdb\w*\.exec\s*\(/],
    ["INSERT INTO", /\bINSERT\s+INTO\b/i],
    ["DELETE FROM", /\bDELETE\s+FROM\b/i],
    ["UPDATE … SET", /\bUPDATE\s+\w+\s+SET\b/i],
  ];
  // T1.1（iter-20260825-11fo O-4/AD-15）：.helix-kg 单库两写点扩登记——知识层写
  // （SqliteKnowledgeStore：writeKnowledge 四表/applySync 符号层事务）与连接
  // 底座（KgDatabase：new Database/WAL/DDL exec）是 TR-AD-13 语义域外的
  // 新落盘写路径，与 WriteQueue 并列白名单；库定位 <projectRoot>/.helix-kg/kg.db
  // （per-project，不在 daemon 全局单写队列语义域内，内部同样执行
  // 「唯一写点+串行化」：每表域一个写者、BEGIN IMMEDIATE 事务、崩溃一致）。
  const sqliteWriteWhitelist = new Set([
    path.join("adapters", "driven", "sqlite-session", "WriteQueue.ts"),
    path.join("adapters", "driven", "sqlite-kg", "KgDatabase.ts"),
    path.join("adapters", "driven", "sqlite-kg", "SqliteKnowledgeStore.ts"),
    // T2.1（iter-20260829-ys7q O-1/O-4）：helix.db 任务四表三条写路径登记——
    // ① 父进程 job/stage/batch 写点链 + work_item 写语句宿主
    // （prepareWorkLedgerStatements/openTaskLedgerDatabase）在 WriteQueue.ts
    // （既有成员，语义扩至任务表域）；② 父进程 F3.6 清理面与 ③ 子进程 plan
    // 工具直连 work_item 写点的执行体 WorkLedger（insertItems/updateItem/
    // deleteByInstanceIds——SQL 文本仍只在 WriteQueue，四表 DML/DDL 落位由
    // O-1 表分域断言另行钉死，见下方 describe）。
    path.join("adapters", "driven", "sqlite-session", "WorkLedger.ts"),
  ]);
  // T2.1（AF-2）：codegraph.db 只读读点登记（**非写点**）——codegraph-engine
  // 投影面 new Database（mode=ro 系只读连接，零 DML/DDL/写类 PRAGMA，绝不
  // 写/迁移他人库）；new Database 的允许面 = 写点 ∪ 只读读点，写 SQL 仍只
  // 允许写点（③ 负向守护：只读读点出现写 SQL 即红）。
  const sqliteReadonlyWhitelist = new Set([path.join("adapters", "driven", "codegraph-engine", "codegraph-db-projection.ts")]);

  test("① src 内 SQLite 写操作调用点仅存在于 sqlite-session/WriteQueue.ts 与 sqlite-kg 两写点（new Database 另允许只读读点）", () => {
    for (const rel of listFiles(srcRoot)) {
      const src = read(rel);
      const isWhitelisted = sqliteWriteWhitelist.has(rel);
      const isReadonly = sqliteReadonlyWhitelist.has(rel);
      // new Database：写点 ∪ 只读读点
      const dbCtor = src.match(/new\s+Database\s*\(/);
      expect(
        dbCtor === null || isWhitelisted || isReadonly,
        `${rel} 出现 new Database（仅 WriteQueue / sqlite-kg 两写点 + codegraph-engine 只读读点允许）`,
      ).toBe(true);
      for (const [label, pattern] of writePatterns) {
        const hit = src.match(pattern);
        expect(
          hit === null || isWhitelisted,
          `${rel} 出现 SQLite 写点「${label}」（仅 WriteQueue / sqlite-kg 两写点允许）`,
        ).toBe(true);
      }
    }
  });

  test("①b 只读读点机械守护（AF-2 只读边界）：只允许 SELECT——零写 SQL/DDL，连接恒 mode=ro URI", () => {
    for (const rel of sqliteReadonlyWhitelist) {
      const src = read(rel);
      for (const [label, pattern] of [
        ...writePatterns,
        ["DDL CREATE", /\bCREATE\s+(TABLE|INDEX|TRIGGER|VIEW)\b/i],
        ["DDL ALTER", /\bALTER\s+TABLE\b/i],
      ] as [string, RegExp][]) {
        expect(src.match(pattern), `${rel} 是只读读点，不得出现「${label}」`).toBeNull();
      }
      expect(src.includes("?mode=ro"), `${rel} 连接必须固定 mode=ro 只读 URI（AF-2）`).toBe(true);
    }
  });

  test("② 写实例计数：helix.db 单写队列 1 个；.helix-kg 库独立第二写连接 1 个（仓库各经它们写）", () => {
    // T2.2（§4.2.1）：组合根锚面从 container.ts 单文件扩为 container.ts +
    // assembly/**——单写队列不变量不变，断言扫描面随锚面扩。
    // T1.1（O-4/AD-15）：计数口径扩为两库两写点——helix.db 仍恰一个 WriteQueue；
    // .helix-kg（per-project 懒连）恰一个 KgDatabase 实例，Store/Graph 仓库经它访问。
    const rootFiles = [read(path.join("infrastructure", "container.ts"))]
      .concat(
        listFiles(path.join(srcRoot, "infrastructure", "assembly")).map((rel) =>
          read(path.join("infrastructure", "assembly", rel)),
        ),
      )
      .join("\n");
    expect(rootFiles.match(/new\s+WriteQueue\(/g)?.length).toBe(1);
    expect(rootFiles.match(/new\s+SqliteSessionRepository\(/g)?.length).toBe(1);
    expect(rootFiles.match(/new\s+KgDatabase\(/g)?.length).toBe(1);
    expect(rootFiles.match(/new\s+SqliteKnowledgeStore\(/g)?.length).toBe(1);
    expect(rootFiles.match(/new\s+SqliteKnowledgeGraph\(/g)?.length).toBe(1);
    // T2.1（O-4）：任务栈装配计数——TaskStore 恰一个（buildTaskStack）；父进程
    // work_item 清理面恰一处（parentWorkLedger 工厂调用；子进程直连面在
    // subagent/ChildMain 装配，不在组合根扫描面，由表分域断言负向守护）。
    expect(rootFiles.match(/new\s+TaskStore\(/g)?.length).toBe(1);
    expect(rootFiles.match(/parentWorkLedger\(/g)?.length).toBe(1);
  });

  const writeQueueRel = path.join("adapters", "driven", "sqlite-session", "WriteQueue.ts");

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

  test("④ 任务写点越界 fixture 自证红（守护有效性非空转，O-4）：假模块直写 job 表 → ① 的扫描谓词全判红", () => {
    // 构造一个「若落在 src 内必红」的越界 fixture（假模块直连 helix.db 写
    // job 表）：用 ① 同一套谓词验证它能被检出——守护不是恒真扫描（自证）。
    // fixture 不落盘 src，只验证谓词判红条件本身。
    const fixtureRel = path.join("adapters", "driven", "tools", "plan", "FakeJobWriter.ts");
    const fixtureSrc = [
      'import { Database } from "bun:sqlite";',
      'const db = new Database("helix.db");',
      'db.exec("INSERT INTO job (id, status) VALUES (\'j-1\', \'running\')");',
    ].join("\n");
    expect(sqliteWriteWhitelist.has(fixtureRel), "fixture 不在写点白名单（① 判红条件成立）").toBe(false);
    expect(sqliteReadonlyWhitelist.has(fixtureRel), "fixture 不在只读白名单").toBe(false);
    expect(fixtureSrc.match(/new\s+Database\s*\(/), "① new Database 判红").not.toBeNull();
    const writeHit = writePatterns.filter(([, pattern]) => pattern.test(fixtureSrc));
    expect(writeHit.length, "① SQLite 写点形态判红（db.exec + INSERT INTO）").toBeGreaterThanOrEqual(2);
  });
});

describe("AG-08：与环境变量无缘（apiKeys 只来自 auth.json）", () => {
  test("src 全量无 process.env 读取（subagent/ 除外——env 是父子进程 IPC 通道，非配置源）", () => {
    // T2.2：SubAgent 子进程的 argv/env 由父进程（组合根）显式注入
    // （HELIX_MODEL_JSON/HELIX_API_KEYS_JSON 等）——env 在 subagent/ 内是
    // 父子 IPC 传输通道，不是配置来源。T2.3（AD-2 auth 分层）起 apiKeys
    // 源头仍且仅是 auth.json（AuthStore，0600+文件锁；旧 config.json 含
    // apiKeys 字段时启动迁移，见 infrastructure/config.ts）。
    // T1.1（AD-2/F3.1）新增组合根唯一例外：container.ts 可读且仅可读
    // HELIX_RG_PATH（壳注入的 rg bundle 资源定位参数，非配置源）与 PATH
    // （rg 三级解析第③级探测对象）——读取收束于装配层单点作为 resolve-rg
    // 入参（resolve-rg.ts 本体零 env 依赖）。
    // T2.1（AF-2）：同模式扩 HELIX_CODEGRAPH_PATH（codegraph 三级解析第①级
    // bundle 注入键，resolve-codegraph.ts 本体零 env 依赖）。
    const whitelistRoot = path.join("adapters", "driven", "subagent");
    const containerRel = path.join("infrastructure", "container.ts");
    for (const rel of listFiles(srcRoot)) {
      if (rel.startsWith(whitelistRoot)) continue;
      const src = read(rel);
      if (rel === containerRel) {
        const envKeys = [...new Set([...src.matchAll(/process\.env\.([A-Z_]+)/g)].map((m) => m[1]!))].sort();
        expect(envKeys, `container.ts 可读 env 键仅限 HELIX_CODEGRAPH_PATH/HELIX_RG_PATH/PATH，实际：${envKeys.join(",")}`).toEqual([
          "HELIX_CODEGRAPH_PATH",
          "HELIX_RG_PATH",
          "PATH",
        ]);
        continue;
      }
      expect(src.includes("process.env"), `${rel} 读取了环境变量（AG-08）`).toBe(false);
    }
  });

  test("subagent env IPC 键清单登记（F3.0：新增 HELIX_* 键须同步扩登记——键级守护，防未登记键悄然扩散）", () => {
    // env 在 subagent/ 内是父子 IPC 通道（非配置源）——通道键是协议面，
    // 新键（如 F3.0 reportPath 传参的 HELIX_REPORT_PATH）须在此清单登记，
    // 使键集合变更可评审（扫描面含注释提及：注释与实现同键同责任）。
    const registered = [
      "HELIX_API_KEYS_JSON",
      "HELIX_DB_PATH", // T1.4（AD-6①）：work_item 台账库路径（SubagentLauncher 注入 / ChildMain 本地栈消费）
      "HELIX_FAKE_ENGINE_SCRIPT",
      "HELIX_INSTANCE_ID",
      "HELIX_MODEL_JSON",
      "HELIX_REPORT_PATH", // F3.0（T4.1）：报告落点传参（SubagentLauncher 注入 / 提示词引导消费）
      "HELIX_SYSTEM_PROMPT",
      "HELIX_THINKING_LEVEL",
      "HELIX_TOOLS_JSON",
      "HELIX_TOOL_CWD",
    ].sort();
    const found = new Set<string>();
    const subagentRel = path.join("adapters", "driven", "subagent");
    for (const rel of listFiles(path.join(srcRoot, subagentRel))) {
      for (const m of read(path.join(subagentRel, rel)).matchAll(/HELIX_[A-Z_]+/g)) found.add(m[0]!);
    }
    expect([...found].sort(), "subagent env IPC 键集合与登记清单不一致——新键须扩登记（AG-08）").toEqual(registered);
  });
});

describe("AG-10 + TP-CL4-3：runtime 无编排模式分支", () => {
  const modeWords = /\b(main-session|subagent|phase|kg)\b/i;
  test("runtime 逻辑源码（含 hooks/）不含模式标识符", () => {
    const files = listFiles(path.join(srcRoot, "adapters", "driven", "pi-engine", "runtime"))
      .filter((rel) => !rel.startsWith(path.join("profiles")))
      // T4.2（AD-18）：templates/ 为提示词资产（段库目录/装配指引，与 profiles
      // 同域纯声明数据）——场景定名 kg-change-report / 段名「kg 约束切片」为
      // 架构定名，模式词合法出现在声明数据（同 profiles 豁免口径）；
      // validate.ts 为逻辑源码，不豁免、仍受扫描。
      .filter((rel) => !(rel.startsWith(path.join("templates")) && !rel.endsWith("validate.ts")));
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
          // T5.3（iter-20260825-11fo，§9）：kg 族命令回口 = application service
          //（KgViewerService，architecture.md 明文「driving/kg.ts 调 application
          // service 不触 driven」）——仅限 type-only（依赖面注入经组合根，
          // ws-server 零运行时耦合），同 domain 口径。W1 绑定闭环：workspace
          // 族命令回口同口径（WorkspaceService，仅限 type-only）。
          const serviceTypeOnly = /\/services\/(kg|workspace)\//.test(spec) && typeOnly(spec, src);
          if (!serviceTypeOnly) {
            expect(runtimeAllowed(rel, spec), `ws-server/${rel} 运行时 import 越界：${spec}`).toBe(true);
          }
        }
      }
      // 白名单的否定面：禁 services/infrastructure/driven
      //（T5.3 例外：application/services/kg/ 的 type-only 面见上；W1：
      // application/services/workspace/ 同口径——§15.10/§16.10 命令回口）
      for (const spec of importSpecifiers(src)) {
        if (/\/services\/(kg|workspace)\//.test(spec) && typeOnly(spec, src)) continue;
        expect(spec, `ws-server/${rel} 不得依赖 service/infra/driven：${spec}`).not.toMatch(/services\/|infrastructure\/|\/driven\//);
      }
    }
  });
});

describe("AG-13：协议两端同源基线（@helix/protocol 唯一权威源）", () => {
  test("MAIN_INSTANCE_ID 退役：application 层 import 零残留（T10a 方案 A——主实例 id 每会话生成，kind 判别取代常量值判等）", () => {
    // T4.1（CL-5）历史：SessionRegistry 曾取 domain 本地定义，守护 application
    // 层 MAIN_INSTANCE_ID 取源。AD-1（iter-20260821-dg90 T3.3）：唯一定义迁
    // packages/common/src/constants.ts，domain 本地定义删除（双源退役）。
    // T10a（方案 A 一次性全切）：主实例固定 id "main" 废除——所有实例（含
    // main）instanceId = agent-<唯一串>（newInstanceId 生成单点），application
    // 层 MAIN_INSTANCE_ID 消费全部改 isMainInstanceId kind 判别（legacy
    // "main" 字面只读兼容），本守护从「取源白名单」翻转为「零残留负命题」。
    const importRe = /^\s*import\s+[^;'"]*\bMAIN_INSTANCE_ID\b[^;'"]*from\s+['"]([^'"]+)['"]/gm;
    const offenders: string[] = [];
    for (const rel of listFiles(path.join(srcRoot, "application"))) {
      const src = read(path.join("application", rel));
      for (const m of src.matchAll(importRe)) {
        offenders.push(`${rel} → ${m[1]}`);
      }
    }
    expect(offenders, `application 层 MAIN_INSTANCE_ID import 残留（T10a 应零残留）：${offenders.join(", ")}`).toEqual([]);
  });

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

describe("AG-15 / TR-AD-28：@helix/common 业务无关通用层零依赖结构（AD-1，iter-20260821-dg90 T3.3）", () => {
  const repoRoot = path.join(srcRoot, "..", "..", "..");
  const commonRoot = path.join(repoRoot, "packages", "common");

  test("① common/src 全部 .ts import ∈ {相对路径} ∪ {node:*/bun:* 内置}（@helix/* 或裸包名即红）", () => {
    const files = listFiles(path.join(commonRoot, "src"));
    expect(files.length).toBeGreaterThan(0); // 扫描面非空转（constants + index 门面在位）
    for (const rel of files) {
      const src = readFileSync(path.join(commonRoot, "src", rel), "utf8");
      for (const spec of importSpecifiers(src)) {
        expect(
          spec.startsWith(".") || spec.startsWith("node:") || spec.startsWith("bun:"),
          `packages/common/src/${rel} 越出零依赖白名单（相对路径/node:*/bun:*）：${spec}`,
        ).toBe(true);
      }
    }
  });

  test("② common/package.json dependencies 恰为空对象（零外部依赖 + 零 @helix/*）", () => {
    const pkg = JSON.parse(readFileSync(path.join(commonRoot, "package.json"), "utf8")) as {
      dependencies?: Record<string, string>;
    };
    expect(pkg.dependencies).toEqual({});
  });

  test("③ common 依赖边登记（与 AG-05① 四键联动）：daemon workspace:* + protocol 依赖恰一键 @helix/common（re-export 通道）", () => {
    // protocol 首条 dependencies（AD-1 预期内）：仅 @helix/common 一键——
    // re-export 通道所需最小依赖面，多一键即越零依赖纪律面。
    const daemonDeps = (
      JSON.parse(readFileSync(path.join(srcRoot, "..", "package.json"), "utf8")) as {
        dependencies: Record<string, string>;
      }
    ).dependencies;
    expect(daemonDeps["@helix/common"]).toBe("workspace:*");
    const protocolPkg = JSON.parse(
      readFileSync(path.join(repoRoot, "packages", "protocol", "package.json"), "utf8"),
    ) as { dependencies?: Record<string, string> };
    expect(protocolPkg.dependencies).toEqual({ "@helix/common": "workspace:*" });
  });
});

describe("O-1/O-4（T2.1）：任务四表表分域与子进程写面（job/stage/batch/work_item 只落 helix.db）", () => {
  const writeQueueRel = path.join("adapters", "driven", "sqlite-session", "WriteQueue.ts");
  const sessionSchemaRel = path.join("adapters", "driven", "sqlite-session", "schema.ts");
  // 任务四表 DML/DDL 形态（SQL 邻接匹配——变量名 batch/注释散文不误伤）。
  // 注意 origin_batch_id/task_id 等下划线复合词不含词边界内的四表名，不命中。
  const taskTableDml = /(INSERT\s+INTO|DELETE\s+FROM|UPDATE)\s+(job|stage|batch|work_item)\b/i;
  const taskTableDdl = /CREATE\s+TABLE[^;]*\b(job|stage|batch|work_item)\b/i;
  // 父进程任务写方法名（WriteQueue 公共面——子进程禁止调用）。
  const parentTaskWriteMethods =
    /\b(saveTaskJob|saveTaskStage|saveTaskJobStatus|saveTaskStageStatus|saveTaskBatch|updateTaskBatch|deleteTaskJobCascade)\b/;

  test("① .helix-kg 库面（sqlite-kg/**）零任务四表 SQL——任务表 DDL/写路径不出现在 kg 库代码面（O-1 改判断言）", () => {
    const kgDir = path.join("adapters", "driven", "sqlite-kg");
    const files = listFiles(path.join(srcRoot, kgDir));
    expect(files.length).toBeGreaterThan(0); // 扫描面非空转
    for (const rel of files) {
      const src = read(path.join(kgDir, rel));
      expect(src.match(taskTableDml), `${rel} 出现任务四表 DML（任务表不落 .helix-kg 库）`).toBeNull();
      expect(src.match(taskTableDdl), `${rel} 出现任务四表 DDL（任务表不落 .helix-kg 库）`).toBeNull();
    }
  });

  test("② 全 src 任务四表 DML 只在 WriteQueue.ts、DDL 只在 sqlite-session/schema.ts（写语句宿主唯一，O-1）", () => {
    for (const rel of listFiles(srcRoot)) {
      const src = read(rel);
      if (taskTableDml.test(src)) {
        expect(rel === writeQueueRel, `${rel} 出现任务四表 DML（只允许 WriteQueue——父进程单写通道）`).toBe(true);
      }
      if (taskTableDdl.test(src)) {
        expect(rel === sessionSchemaRel, `${rel} 出现任务四表 DDL（只允许 sqlite-session/schema.ts）`).toBe(true);
      }
    }
    // 宿主真实持有（扫描面与实现同步——防扫描空转）
    expect(taskTableDml.test(read(writeQueueRel))).toBe(true);
    expect(taskTableDdl.test(read(sessionSchemaRel))).toBe(true);
  });

  test("③ 子进程写面仅 work_item：subagent/** 零 job/stage/batch 写方法调用与写 SQL（父写三表、子不写，O-1 双面装配）", () => {
    const subagentRoot = path.join("adapters", "driven", "subagent");
    const threeTableDml = /(INSERT\s+INTO|DELETE\s+FROM|UPDATE)\s+(job|stage|batch)\b/i;
    for (const rel of listFiles(path.join(srcRoot, subagentRoot))) {
      const src = read(path.join(subagentRoot, rel));
      expect(src.match(parentTaskWriteMethods), `${rel} 调用父进程任务写方法（子进程不写 job/stage/batch）`).toBeNull();
      expect(src.match(threeTableDml), `${rel} 出现 job/stage/batch 写 SQL（子进程写面仅 work_item）`).toBeNull();
    }
  });
});

describe("O-4（T2.1）：任务域新分层目录落位（domain/task、services/task、tools/plan、tools/task-create）", () => {
  test("① domain/task 在位且零外层 import（domain 纯逻辑纪律定点声明，AG-02① 同口径）", () => {
    const dir = path.join(srcRoot, "domain", "task");
    const files = listFiles(dir);
    expect(files.length).toBeGreaterThan(0); // T1.1 已落位
    for (const rel of files) {
      for (const spec of importSpecifiers(read(path.join("domain", "task", rel)))) {
        expect(spec.startsWith("."), `domain/task/${rel} 不得 import 外层符号：${spec}`).toBe(true);
      }
    }
  });

  test("② services/task 在位且不 import adapters/infrastructure（service 纪律定点声明，AG-02② 同口径）", () => {
    const dir = path.join(srcRoot, "application", "services", "task");
    const files = listFiles(dir);
    expect(files.length).toBeGreaterThan(0); // T1.3 已落位
    for (const rel of files) {
      for (const spec of importSpecifiers(read(path.join("application", "services", "task", rel)))) {
        expect(spec, `services/task/${rel} 不得依赖 adapters/infrastructure：${spec}`).not.toMatch(/adapters|infrastructure/);
      }
    }
  });

  test("③ tools/plan 与 tools/task-create（T1.4 落位即受守护）不 import infrastructure/driving", () => {
    // T1.4 并行落地中：目录未建时本断言空转跳过，落位后自动生效（防未来
    // 回归；driven 工具面允许 domain/application ports/service type-only 面）。
    for (const dir of [
      path.join("adapters", "driven", "tools", "plan"),
      path.join("adapters", "driven", "tools", "task-create"),
    ]) {
      if (!existsSync(path.join(srcRoot, dir))) continue;
      for (const rel of listFiles(path.join(srcRoot, dir))) {
        const relPath = path.join(dir, rel);
        for (const spec of importSpecifiers(read(relPath))) {
          expect(spec, `${relPath} 不得依赖 infrastructure/driving：${spec}`).not.toMatch(/infrastructure|\/driving\//);
        }
      }
    }
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
