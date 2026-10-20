import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { srcRoot, listFiles, read, importSpecifiers } from "./guard-helpers";

/**
 * 架构守护（AG）源码扫描套件 —— test-design §3 的 A 通道落地（Bun test）。
 * 本文件覆盖：AG-01（port 只接口）、AG-02（依赖方向矩阵）、AG-04（pi import 域）、
 * AG-08（与环境变量无缘）、AG-10 + TP-CL4-3（runtime 无编排模式分支）、AG-06（SQLite 写点唯一）、
 * TP-CL4-5-A（runtime 不自持领域状态副本）、AG-05/TP-CL5-4（运行时依赖白名单）、
 * TP-CL5-1-A（四工具 import 源与封装边界）、TP-CL5-2-A（grep 匹配核 framework-free）。
 * AG-11（新增 profile 不改 runtime）为行为级验证，见 integration/test-profile.test.ts。
 * 拆分母文件（P1 体量门 ④）：运行时约束面见 arch-guard-runtime-env.test.ts，
 * 分层落位与判据单点见 arch-guard-layering.test.ts。
 */

describe("AG-01：port 文件只有接口/类型", () => {
  // 管家批（AG 基线清偿）：port 面包导入白名单 = {@helix/protocol}，且必须
  // type-only——值导入会把运行时依赖拖进接口层。协议类型是 wire 契约唯一真源
  // （StewardDialogStorePort 的 StewardHistoryRecord 先例：落盘 payload 即协议
  // JSON 原文，接口层另声明一份即双真源）；AG-02② 已给 application 层同款
  // 白名单，此处对 ports 收紧为 type-only。
  const PORT_PACKAGE_TYPE_WHITELIST: ReadonlySet<string> = new Set(["@helix/protocol"]);

  test("ports/** 无函数体、无 class、包导入仅 @helix/protocol 且 type-only", () => {
    const files = listFiles(path.join(srcRoot, "application", "ports"));
    expect(files.length).toBeGreaterThanOrEqual(9);
    for (const rel of files) {
      const src = read(path.join("application", "ports", rel));
      expect(src.match(/\bfunction\s+\w+\s*\(/), `${rel} 含函数定义`).toBeNull();
      expect(src.match(/\bclass\s+\w+/), `${rel} 含 class`).toBeNull();
      expect(src.match(/=>\s*\{/), `${rel} 含箭头函数体`).toBeNull();
      for (const spec of importSpecifiers(src)) {
        expect(
          spec.startsWith(".") || spec.startsWith("node:") || PORT_PACKAGE_TYPE_WHITELIST.has(spec),
          `${rel} 的 import 必须是相对路径、node: 或白名单包 {@helix/protocol}：${spec}`,
        ).toBe(true);
      }
      // 白名单包导入逐句验 type-only（export-from 无 type 关键字 = 值再导出，同罪）
      const stmtRe = /^[ \t]*(?:import|export)\s+(type\s+)?[^;'"]*?from\s+['"]([^'"]+)['"]/gm;
      let stmt: RegExpExecArray | null;
      while ((stmt = stmtRe.exec(src)) !== null) {
        const spec = stmt[2]!;
        if (spec.startsWith(".") || spec.startsWith("node:")) continue;
        expect(PORT_PACKAGE_TYPE_WHITELIST.has(spec), `${rel} 的包导入越出白名单：${spec}`).toBe(true);
        expect(stmt[1] !== undefined, `${rel} 的包导入 ${spec} 必须 type-only（import type / export type）`).toBe(true);
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

  test("①b domain 不得 import 外层（application/adapters/infrastructure 的相对路径面）", () => {
    // 评审 F1 缺口补强：①只看包外 import（相对路径一律放行），domain →
    // application 的相对 type-import 因此漏网（ProposalLedger 曾引
    // application/ports/outbound/StewardSurfacePort 的请求类型，自记临时债）。
    // TR-13 依赖单向向内：domain 是被依赖方，不得反向引 applicaton/adapters/
    // infrastructure 的任何符号（含 type-only——类型也是层间契约面）。
    for (const rel of listFiles(path.join(srcRoot, "domain"))) {
      for (const spec of importSpecifiers(read(path.join("domain", rel)))) {
        if (!spec.startsWith(".")) continue; // 包外形态归①的白名单规则
        const resolved = path.posix.normalize(path.posix.join("domain", path.posix.dirname(rel), spec));
        expect(
          /^(application|adapters|infrastructure)(\/|$)/.test(resolved),
          `domain/${rel} 不得 import 外层符号（依赖方向 domain ← application ← adapters）：${spec}`,
        ).toBe(false);
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
    // node:path 的宿主方言子入口（node:path/win32）同属白名单——解决 F1 rel-path
    // 盘符分支（559f2da3）：posix 宿主收到 win32 形态路径时需 win32 语义的
    // relative，node:path 默认出口不提供。除路径计算外仍禁一切包外依赖。
    const isPathFamily = (spec: string): boolean => spec === "node:path" || spec.startsWith("node:path/");
    for (const rel of listFiles(path.join(srcRoot, "application"))) {
      for (const spec of importSpecifiers(read(path.join("application", rel)))) {
        expect(spec, `application/${rel} 禁止引到 adapters/infrastructure：${spec}`).not.toMatch(/adapters|infrastructure/);
        if (!spec.startsWith(".")) {
          expect(
            PACKAGE_WHITELIST.has(spec) || isPathFamily(spec),
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
      // mcp 批：mcp/ 是 driven 域工具族（mcp-tool 适配器消费 pi-agent-core
      // 工具工厂形状——与 tools 同构，TR-AD-7 语义不变，白名单第四个 driven 根）
      path.join("adapters", "driven", "mcp"),
      // 文本管家批 V2.5：steward/ 是 driven 域 LLM 适配器（PiStewardLlmAdapter
      // 消费 pi-ai streamSimple——TTS/STT adapter 同构的 provider 防腐墙）
      path.join("adapters", "driven", "steward"),
      // helix-loop L0 批：loop/ 是管家面 LLM 适配器新落点（PiStewardLlmAdapter
      // 自 steward/ 平移——设计 §2：adapters/driven/loop/ ← pi-ai 唯一 import
      // 执行点，L3 替换后其余 pi import 面退役收敛于此）
      path.join("adapters", "driven", "loop"),
      // Phase 0b（pi-engine 拆分）：llm/ 是 pi-ai 栈引擎中立层（streamFn 工厂/
      // 网络重试/thinking 解析/模型目录/自定义 provider——设计 §7.1 自 pi-engine
      // 平移）；agent-loop 替换时永存，TR-AD-7「pi import 只在 driven 域」
      // 语义不变，白名单新增 driven 根。
      path.join("adapters", "driven", "llm"),
      // pi-ai 判官批：embedding/ 下 PiAiJudgeAdapter 是判官域的 pi-ai 分类器
      // 防腐墙（Models.classify→JudgePort 翻译——与 loop/ 的 streamSimple 同
      // 构；判官注册表 JudgeAdapterFactory 同域，跨目录反而破坏注册表内聚）
      path.join("adapters", "driven", "embedding"),
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
    // import 语句中的源必须是 vendored 面（pi 1.0.0 删除 /node 子入口后，
    // 四件套+NodeExecutionEnv 冻结自 v0.87.1 上游——E-235 升级批次 1）
    const importBlock = src.split("\n").filter((l) => l.includes("from \"") && /vendor\/pi-harness"?$/.test(l.trimEnd()) === false && l.includes("vendor/pi-harness"));
    expect(importBlock.length).toBeGreaterThan(0);
    for (const line of importBlock) {
      expect(line.includes("vendor/pi-harness"), `非 vendored 源 import：${line}`).toBe(true);
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

  test("③ 封装边界装配在组合根：pi-engine 与 driven/tools 互不 import（vendor/pi-harness 冻结面除外）", () => {
    for (const rel of listFiles(path.join(srcRoot, "adapters", "driven", "pi-engine"))) {
      for (const spec of importSpecifiers(read(path.join("adapters", "driven", "pi-engine", rel)))) {
        // 例外：vendor/pi-harness 是 pi 上游冻结件（E-235 升级后四件套/env/
        // compaction/skills 的统一源），非 tools 业务面——pi-engine 防腐墙
        // 消费它合法（同一上游包在 0.87 时代经 /node 子入口消费）
        if (spec.includes("vendor/pi-harness")) continue;
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

describe("TP-CL5-2（A 半）：grep 语义契约面 framework-free（不碰 fs/node）", () => {
  test("grep/contract.ts 零 import（类型 + globToRegExp 唯一实现源，纯函数）", () => {
    // rg 唯一化：语义基准自 ts-backend 上收 contract.ts（globToRegExp 迁入），
    // 同口径断言——契约面必须保持 framework-free 可单测
    const src = read(path.join("adapters", "driven", "tools", "grep", "contract.ts"));
    expect(src.includes('"node:'), "contract.ts 不得 import node 内建").toBe(false);
    expect(src.includes("require("), "contract.ts 不得 require").toBe(false);
    expect(importSpecifiers(src), "contract.ts 不得有任何 import").toEqual([]);
  });
});

describe("AG-05 / TP-CL5-4：运行时依赖白名单（daemon 不引入 pi-coding-agent）", () => {
  test("daemon dependencies：pi 系为 {pi-agent-core, pi-ai, pi-mcp, pi-codemode}（pi-telemetry/chord 不计），全集十五键（T3.1 +diff：内核复制件 edit-diff 的 diff 展示依赖运行时引入，AF-1 裁决连带；管家记忆 B1 +better-sqlite3/sqlite-vec：向量存储引擎；MCP 替换批 +pi-mcp：MCP 驱动层薄壳化的协议/传输依赖；codemode 批 +pi-codemode +quickjs-wasi：QuickJS 沙箱编排工具及其 wasm VM）", () => {
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
    // 不透传附加字段），与 pi-agent-core pinned 传递依赖同版本零增树；
    // better-sqlite3 + sqlite-vec（管家记忆 B1 裁决）：管家长期记忆向量
    // 存储引擎——helix.db（bun:sqlite，AG-06）物理隔离独立文件
    // steward_memory.db；NAPI 加载需 Bun ≥1.4.2（1.3.14 panic spike 实证），
    // vec0 扩展随包分发走 rg 先例（resources/bin + HELIX_VEC_PATH）；
    // @earendil-works/pi-mcp（MCP 替换批）：MCP 驱动层薄壳化的协议/传输
    // 依赖（零自身传递依赖，cross-spawn 除外）——pi-coding-agent 仍不在列；
    // @earendil-works/pi-codemode（codemode 批）：QuickJS 沙箱编排工具；
    // quickjs-wasi（codemode 批）：pi-codemode 的 wasm VM——daemon 源码直接
    // import 其 quickjs.wasm（编译形态嵌入），升为直接依赖
    expect(deps).toEqual([
      "@earendil-works/chord",
      "@earendil-works/pi-agent-core",
      "@earendil-works/pi-ai",
      "@earendil-works/pi-codemode",
      "@earendil-works/pi-mcp",
      "@earendil-works/pi-telemetry",
      "@helix/common",
      "@helix/protocol",
      "better-sqlite3",
      "diff",
      "ignore",
      "quickjs-wasi",
      "sqlite-vec",
      "typebox",
      "yaml",
    ]);
    const piDeps = deps.filter((d) => d.startsWith("@earendil-works/"));
    // pi 1.0.0 后 pi 系六键（E-235 升级批次 1 + MCP 替换批 + codemode 批）：chord
    //（vendored harness 面的 Context 依赖正源）、pi-telemetry（同上，
    // NOOP_TELEMETRY_CONTEXT）——vendored 冻结件的上游运行时依赖，非 helix
    // 直接消费；pi-mcp（MCP 替换批）：MCP 驱动层薄壳化的协议/传输依赖；
    // pi-codemode（codemode 批）：QuickJS 沙箱编排工具——helix 直接消费。
    expect(piDeps).toEqual([
      "@earendil-works/chord",
      "@earendil-works/pi-agent-core",
      "@earendil-works/pi-ai",
      "@earendil-works/pi-codemode",
      "@earendil-works/pi-mcp",
      "@earendil-works/pi-telemetry",
    ]);
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
    // 体量治理批：守护式 schema 演进（会话域列级演进 DDL + legacy 迁移）
    // 从 WriteQueue.ts 拆出为独立宿主——单写队列/任务四表 DML 不变，
    // 白名单同步扩登记（方案 B 经用户对话确认，TR-20 正文同步更新）。
    path.join("adapters", "driven", "sqlite-session", "schema-evolution.ts"),
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
    // 管家记忆 B1：steward_memory.db 独立文件第三写面登记——与 helix.db
    // （bun:sqlite + WriteQueue）物理隔离（vec0 只能活在 better-sqlite3
    // 连接里，两引擎同文件必打架）；sqlite-kg 先例同构（per-domain 独立
    // 库独立写点）：本库仅管家记忆域单写者，连接级串行 + 事务写入，
    // 无跨面并发（端口 StewardMemoryPort 唯一消费面 = StewardMemoryService）。
    path.join("adapters", "driven", "steward-memory", "SqliteVecMemoryStore.ts"),
    // 管家记忆 B6（AG 基线清偿批登记）：steward_memory.db 第二连接写面——行式
    // 对话存储（steward_messages + meta 表）与 B1 vec 面（entries/vec_items）
    // 同库不同表：管家域数据单库聚合（与 helix.db 物理隔离），两连接同文件
    // WAL 并存、表域不相交无跨面写冲突；本连接仅对话域单写者（端口
    // StewardDialogStorePort 唯一消费面 = StewardDialogMemory），事务写入。
    path.join("adapters", "driven", "steward-memory", "SqliteStewardDialogStore.ts"),
    // 管家活动账批 M3-d1（同构登记）：steward_memory.db 第三连接写面——活动账
    // 行式存储（steward_activity 表）与 B1/B6 同库不同表（管家域单库聚合）；
    // 本连接仅活动账单写者（端口 StewardActivityStorePort 唯一消费面 =
    // StewardActivityService），append 单行写/时间窗查询/清理，无跨面并发。
    path.join("adapters", "driven", "steward-memory", "SqliteActivityLedgerStore.ts"),
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
        // auth-store.ts，0600+锁）与 models-store.json（llm/model-catalog.ts
        // 落盘兑底，Phase 0b 自 pi-engine/model-catalog.ts 平移）；SQLite
        // reportFile 原子写仍只允许 WriteQueue。
        // code-review M28 新增第三合法面：config.json（infrastructure/
        // config.ts tmp+rename 原子写——崩溃窗口不留半截配置）。
        // sandbox 开关批：bootPrelude 迁移面（sandbox.json → .migrated 改名
        // 保留退路——一次性迁移语义，非状态写面）。
        const isAuthStore = rel === path.join("infrastructure", "auth-store.ts");
        const isModelCatalog = rel === path.join("adapters", "driven", "llm", "model-catalog.ts");
        const isConfig = rel === path.join("infrastructure", "config.ts");
        const isBootPrelude = rel === path.join("infrastructure", "assembly", "bootPrelude.ts");
        // 单例锁陈锁接管批（1a7353a7）：lock 文件走 rename 原子占位（陈锁先
        // 改名搬走再回读复核后才 rm，消灭「删他人新锁」双写者窗口）——非状态
        // 数据写面，与 SQLite/配置落盘无关。
        const isSingletonLock = rel === path.join("infrastructure", "lifecycle.ts");
        expect(
          isWriteQueue || isAuthStore || isModelCatalog || isConfig || isBootPrelude || isSingletonLock,
          `${rel} 出现原子替换写（只允许 WriteQueue reportFile / auth-store / model-catalog / config / bootPrelude 迁移 / lifecycle 陈锁占位）`,
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
