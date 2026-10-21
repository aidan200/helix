/**
 * 架构守护——环境与运行时约束面（AG-08 与环境变量无缘 / AG-10 + TP-CL4-3
 * runtime 无编排模式分支 / TP-CL4-5-A runtime 不自持领域状态副本 / AG-12 +
 * TP-CL6-3 ws-server 编排在 service / AG-13 协议两端同源 / AG-14 + TP-CL2-3
 * monitor 白名单过滤唯一位）。纯位置迁移自 arch-guard.test.ts
 * （P1 体量门拆分批，判定逻辑零改动）。
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { srcRoot, listFiles, read, importSpecifiers, typeOnly } from "./guard-helpers";

describe("AG-08：与环境变量无缘（apiKeys 只来自 auth.json）", () => {
  test("src 全量无 process.env 读取（subagent/ 除外——env 是父子进程 IPC 通道，非配置源）", () => {
    // T2.2：SubAgent 子进程的 argv/env 由父进程（组合根）显式注入
    // （HELIX_MODEL_JSON/HELIX_API_KEYS_JSON 等）——env 在 subagent/ 内是
    // 父子 IPC 传输通道，不是配置来源。T2.3（AD-2 auth 分层）起 apiKeys
    // 源头仍且仅是 auth.json（AuthStore，0600+文件锁；旧 config.json 含
    // apiKeys 字段时启动迁移，见 infrastructure/config.ts）。
    // T1.1（AD-2/F3.1）新增组合根唯一例外：装配层可读且仅可读
    // HELIX_RG_PATH（壳注入的 rg bundle 资源定位参数，非配置源）——读取
    // 收束于装配层单点作为 resolve-rg 入参（resolve-rg.ts 本体零 env
    // 依赖）。rg 唯一化后其 PATH 级已砍。
    // T2.1（AF-2）：同模式扩 HELIX_CODEGRAPH_PATH（codegraph 二级解析第①级
    // bundle 注入键，resolve-codegraph.ts 本体零 env 依赖）；codegraph
    // bundle-only 化后 PATH 级同砍，装配层 env 读取面收至两键。
    // M5 切片：两键读取面随 grep/codegraph 定格自 container.ts 迁
    // assembly/bootPrelude.ts（AG-02④ 豁免面内移动，AG-08 语义不变——
    // container.ts 本体清零）。
    // mcp 批：mcp/ 同白名单（McpClient spawn MCP server 子进程需环境继承
    //（{...process.env, ...config.env}——PATH 等运行时必需），与 subagent
    // 的 env IPC 同理：子进程环境透传，非配置源）。
    const whitelistRoots = [
      path.join("adapters", "driven", "subagent"),
      path.join("adapters", "driven", "mcp"),
      // vendor/pi-harness：pi 上游冻结件（E-235 升级批次 1）——NodeExecutionEnv
      // 的 PATH/HOME 等环境透传是执行环境语义（上游 0.87.1 原样），非配置源。
      path.join("adapters", "driven", "tools", "vendor", "pi-harness"),
    ];
    // env 读取例外面（组合根豁免面内）：文件 → 允许键集合（升序；空数组 = 零键——
    // M5 后 container.ts 不读 env，两键收束 bootPrelude）。
    const envReaderRules: readonly (readonly [string, readonly string[]])[] = [
      [path.join("infrastructure", "container.ts"), []],
      // 管家记忆 B1：HELIX_VEC_PATH 同模式扩登记（vec0 扩展 bundle 注入键，
      // resolve-vec0.ts 本体零 env 依赖——rg/codegraph 先例同构第三键）
      [path.join("infrastructure", "assembly", "bootPrelude.ts"), ["HELIX_CODEGRAPH_PATH", "HELIX_RG_PATH", "HELIX_VEC_PATH"]],
      // 沙箱批：内层 shell 探测（macOS 26 /bin/sh 沙箱内自崩，$SHELL 兜底
      // /bin/bash）——环境探测非配置源，键级登记可评审
      [path.join("adapters", "driven", "tools", "SandboxEnvWrap.ts"), ["SHELL"]],
      // 沙箱 helper 批：helper.exe 路径显式覆盖口（打包资源位接入前的
      // 测试/开发通道——探测非配置源，键级登记）
      [path.join("adapters", "driven", "tools", "sandboxSetup.ts"), ["HELIX_SANDBOX_HELPER"]],
      // codemode 批：worker 入口指定符——**编译期 --define 常量替换**（compile-daemon
      // 注入嵌入 entrypoint 相对串，dev 运行时恒 undefined）——资源定位差异经
      // 编译管线注入非配置源（AG-18/R4 同构消解；rg/vec 先例同族）
      [path.join("adapters", "driven", "tools", "codemode", "CodemodeTool.ts"), ["HELIX_CODEMODE_WORKER_URL"]],
      // 崩溃留痕批（5f3198a）：进程级崩溃钩子对测试 runner 的让位判别
      //（BUN_TEST=1 不接管 crash 日志/退出码——探测非配置源，键级登记）
      [path.join("infrastructure", "lifecycle.ts"), ["BUN_TEST"]],
    ];
    for (const rel of listFiles(srcRoot)) {
      if (whitelistRoots.some((root) => rel.startsWith(root))) continue;
      const src = read(rel);
      const rule = envReaderRules.find(([file]) => file === rel);
      if (rule !== undefined) {
        const envKeys = [...new Set([...src.matchAll(/process\.env\.([A-Z_]+)/g)].map((m) => m[1]!))].sort();
        expect(envKeys, `${rel} 可读 env 键仅限 ${rule[1].join("/") || "（零键）"}，实际：${envKeys.join(",")}`).toEqual([...rule[1]]);
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
      "HELIX_CODEGRAPH_PATH", // W1-B：codegraph 二进制定格路径透传（SubagentLauncher 注入 / ChildMain 本地栈二级解析第①级消费）
      // custom provider 批：自定义 provider 定义全量透传（SubagentLauncher launch 时刻现拍 / ChildMain buildChildModels 注册进本地 pi-ai Models）
      "HELIX_CUSTOM_PROVIDERS_JSON",
      "HELIX_DB_PATH", // T1.4（AD-6①）：work_item 台账库路径（SubagentLauncher 注入 / ChildMain 本地栈消费）
      "HELIX_FAKE_ENGINE_SCRIPT",
      "HELIX_FINDINGS_PATH", // task-778eb18a 截断兑底：findings 旁路文件落点（SubagentLauncher 注入 / 提示词引导预写 / ClosureRecorder 机械读）
      "HELIX_INSTANCE_ID",
      "HELIX_MEMORY_PROJECT", // 批E 工具化：memory_search 项目 scope 定格透传（SubagentLauncher launch 时刻足迹单项目归约注入 / ChildMain 本地栈 projectOf 消费；零/多足迹不传键 = 仅 global）
      "HELIX_MODEL_JSON",
      // mcp 批：MCP server 配置透传（SubagentLauncher 注入 launch 时刻现拍 /
      // ChildMain 自建 McpRegistry await 预热——spawn 快照工具名时序保证）
      "HELIX_MCP_SERVERS_JSON",
      "HELIX_REPORT_PATH", // F3.0（T4.1）：报告落点传参（SubagentLauncher 注入 / 提示词引导消费）
      "HELIX_RG_PATH", // rg 二进制定格路径透传（SubagentLauncher 注入 / ChildMain grep 门面消费；rg 单后端）
      "HELIX_SANDBOX", // 沙箱开关批：spawn 时刻 KV 现值定格透传（子进程据此装配/不装配沙箱）
      "HELIX_SANDBOX_EXTRA_ROOTS", // 用户额外可写根随开关同帧透传（JSON 数组——子进程不再读库）
      "HELIX_SESSION_ID", // U1 护栏：会话标识透传（子进程 bash commit 归属判定与父会话同域）
      "HELIX_SYSTEM_PROMPT",
      "HELIX_THINKING_LEVEL",
      "HELIX_TOOLS_JSON",
      "HELIX_TOOL_CWD",
      "HELIX_VEC_PATH", // 批E 工具化：vec0 扩展 bundle 路径透传（ChildMain 本地 memory_search 栈二级解析第①级消费——与父进程 container 同键同源）
      "HELIX_WRITE_FACTS_DIR", // U1 护栏：manifest 根透传（子进程 pre-commit hook 定位写集合）
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
  // W1b（pi-engine 拆分）：templates/ 与 prompts.ts 平移至 engine-shared/
  //（纯声明与资产，零 pi import）——模式词扫描根随迁：豁免口径不变
  //（声明数据豁免；validate.ts 是逻辑源码不豁免、仍受扫描）。
  /** 扫描根 → 声明数据豁免筛选（返回 true = 豁免不扫）。 */
  const logicRoots: readonly (readonly [readonly string[], (rel: string) => boolean])[] = [
    // 防腐墙驱动面（AgentRuntime/HookSet/hooks 是逻辑源码，全扫；
    // profiles/ 是声明数据豁免）。
    [["adapters", "driven", "pi-engine", "runtime"], (rel) => rel.startsWith(path.join("profiles"))],
    // 引擎中立声明面：prompts.ts 与 templates/（除 validate.ts）是声明数据
    // 豁免——T4.2（AD-18）场景定名/段名是架构定名，模式词合法出现在声明
    // 数据；prompts.ts 的 EMBEDDED_PROMPTS 清单同口径（loadPrompt 逻辑面是
    // 通用「路径→文本」查表，零模式分支）。
    [
      ["adapters", "driven", "engine-shared"],
      (rel) =>
        rel === "prompts.ts" ||
        (rel.startsWith(path.join("templates")) && !rel.endsWith("validate.ts")),
    ],
  ];
  test("runtime 逻辑源码（含 hooks/）不含模式标识符", () => {
    for (const [rootParts, skip] of logicRoots) {
      const files = listFiles(path.join(srcRoot, ...rootParts)).filter((rel) => !skip(rel));
      for (const rel of files) {
        const src = read(path.join(...rootParts, rel));
        expect(
          src.match(modeWords),
          `${path.join(...rootParts, rel)} 出现编排模式词：${src.match(modeWords)?.[0]}`,
        ).toBeNull();
      }
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
          // 族命令回口同口径（WorkspaceService，仅限 type-only）。task 批
          //（iter-20260829-ys7q T1.5，§8.1）：task 族读面回口同口径
          //（TaskQueryService，仅限 type-only；TaskError 错误映射走
          // duck-typing err.code，不引运行时类）。diff 批（T3+T4 轮次
          // diff 协议与 UI 闭环）：diff.get 查询面回口同口径
          //（application/services/TurnDiffService，仅限 type-only——服务在
          // services 根非子目录，按文件名单列）。ask/提权申请批：ask 回口
          // 同口径（application/services/AskService，仅限 type-only——依赖
          // 面注入经组合根，批准后裸执行走 executor.unsandboxedExec）。
          // stt/tts/steward/embedding 四批（V1~V3b-1 语音与管家线）：流式/
          // 记忆/向量配置服务回口同口径（application/{stt,tts,steward,
          // embedding}/ 下按文件名单列，仅限 type-only——批落地时漏登记，
          // AG-12 曾长期红，pi-0.87 批收口补齐）。surface 批（M0 表面协议
          // 地基）：SurfaceRegistry 回口同口径（仅 type-only——registry 实体
          // 经组合根注入，ws-server 零运行时耦合）。
          const serviceTypeOnly =
            (/\/services\/(kg|workspace|task)\//.test(spec) ||
              /\/services\/(TurnDiffService|AskService|CustomProviderService|AuthLoginService)$/.test(spec) ||
              /\/(stt|tts|steward|embedding)\/(SttStreamService|TtsStreamService|StewardService|EmbeddingConfigService)$/.test(spec) ||
              /\/steward\/StewardActivityService$/.test(spec) ||
              /\/surface\/SurfaceRegistry$/.test(spec)) &&
            typeOnly(spec, src);
          // stt 批显式例外：VocabularyBuilder = 纯函数词汇表工具面
          //（BASE_VOCABULARY 常量 + buildAsrContext/extractSessionTokens
          // 无状态纯函数）——运行时直调零服务状态耦合，注入无收益；
          // 非 type-only 白名单（新增运行时例外须逐文件单列并说明）。
          const pureUtilRuntimeSpec = /\/stt\/VocabularyBuilder$/.test(spec);
          if (!serviceTypeOnly && !pureUtilRuntimeSpec) {
            expect(runtimeAllowed(rel, spec), `ws-server/${rel} 运行时 import 越界：${spec}`).toBe(true);
          }
        }
      }
      // 白名单的否定面：禁 services/infrastructure/driven
      //（T5.3 例外：application/services/kg/ 的 type-only 面见上；W1：
      // application/services/workspace/ 同口径——workspace 批命令回口；
      // task 批：application/services/task/ 同口径——task 批命令回口）
      for (const spec of importSpecifiers(src)) {
        if (
          (/\/services\/(kg|workspace|task)\//.test(spec) ||
            /\/services\/(TurnDiffService|AskService|CustomProviderService|AuthLoginService)$/.test(spec) ||
            /\/(stt|tts|steward|embedding)\/(SttStreamService|TtsStreamService|StewardService|EmbeddingConfigService)$/.test(spec) ||
            /\/surface\/SurfaceRegistry$/.test(spec)) &&
          typeOnly(spec, src)
        )
          continue;
        // 纯函数工具面运行时例外（口径见正面 pureUtilRuntimeSpec 注释）
        if (/\/stt\/VocabularyBuilder$/.test(spec)) continue;
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
