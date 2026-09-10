/**
 * 装配函数：启动序前置域（code-review M5 切片，自 container.ts 抽出——
 * 组合根 AG-02④ 豁免面 infrastructure/assembly/**）。成员：
 * - freezeSearchBackends：grep/codegraph 后端启动定格（AF-1/AF-2 权威语义）；
 * - migrateLegacyRuntimeConfig：config 瘦身批迁移第一批（port/调度预算/
 *   mcpServers → 新位，先于端口解析与 MCP 预热）；
 * - migrateLegacyModelConfig：旧格式迁移第二批（model/apiKeys → auth.json /
 *   SQLite 默认表，模型栈就绪后）；
 * - resolveWsPort：WS 端口解析链（argv > KV > 7333）+ PortConfigPort 装配。
 * 抽出为零行为改动纯移动——container.ts 在原装配序位调用，装配序语义与
 * 注释留痕不变（TR-78 M29 判据：同生命周期阶段 + 同依赖群切命名装配函数）。
 */

import { accessSync, constants as fsConstants, readFileSync, renameSync } from "node:fs";
import path from "node:path";
import { resolveRgPath } from "../../adapters/driven/tools/grep/resolve-rg";
import { freezeGrepBackend, probeRgVersion, RG_PROBE_TIMEOUT_MS, type GrepBackendFreeze } from "../../adapters/driven/tools/grep/freeze-backend";
import { resolveCodegraphPath, type CodegraphResolution } from "../../adapters/driven/codegraph-engine/resolve-codegraph";
import { DEFAULT_PORT, writeConfig, type DaemonConfig, type LegacyModelConfig } from "../config";
import type { HelixPaths } from "../paths";
import type { Logger } from "../logging";
import type { PortConfigPort } from "../../application/ports/outbound/PortConfigPort";
import type { RuntimeConfigStore } from "../../adapters/driven/sqlite-session/RuntimeConfigStore";
import type { PersistenceStack } from "./buildPersistence";
import type { ModelStack } from "./buildModelStack";

// ── grep/codegraph 后端启动定格 ─────────────────────────────────

/**
 * rg 可执行探测（resolve-rg 的 probe 注入面，装配层唯一实现）：存在且可执行。
 * 抛错（ENOENT/EACCES 等）一律视为不可用——与 resolve-rg 的保守降级语义同调。
 */
function isExecutableFile(p: string): boolean {
  try {
    accessSync(p, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export interface SearchBackendFreeze {
  readonly grepFreeze: GrepBackendFreeze;
  readonly codegraphResolution: CodegraphResolution;
}

/**
 * grep 后端启动定格（AD-2/F3.1/F3.2，AF-1 权威语义：装配层一次性
 * resolve-rg 二级解析（bundle → config；无 PATH 级——版本不可控与
 * pin 确定性相悖）+ rg --version 探针（2s 超时/退出码 0），结果内存
 * 定格——进程生命周期内不重新解析、不升级）。
 * HELIX_RG_PATH 的 process.env 读取收束于组合根本域（AG-08 唯一例外面，
 * 壳注入的资源定位参数，非配置源）；resolve-rg.ts 本体零 env/fs 依赖。
 * 定格产物经 buildSessionStack → CoreToolExecutor 注入 grep 门面（rg 单
 * 后端：unavailable 定格时工具响亮失败，无 TS 兜底）。
 *
 * codegraph 引擎单级解析定格（T2.1/AF-2 bundle-only，TR-AD-32 同模式）：
 * HELIX_CODEGRAPH_PATH 的 process.env 读取同收束于本域；resolve-codegraph.ts
 * 本体零 env/fs 依赖。miss ≠ 装配失败：引擎面定格不可用（binaryPath=null），
 * 构建面 degraded（AF-2）。
 */
export async function freezeSearchBackends(deps: { readonly config: DaemonConfig; readonly logger: Logger }): Promise<SearchBackendFreeze> {
  const { config, logger } = deps;
  const rgResolution = resolveRgPath({
    bundlePath: process.env.HELIX_RG_PATH,
    configPath: config.rgPath,
    probe: isExecutableFile,
  });
  const rgProbe =
    rgResolution.kind === "resolved"
      ? await probeRgVersion(rgResolution.path, RG_PROBE_TIMEOUT_MS)
      : undefined;
  const grepFreeze = freezeGrepBackend(rgResolution, rgProbe);
  if (grepFreeze.kind === "rg") {
    logger.info(`grep 后端定格 rg（source=${grepFreeze.source}）：${grepFreeze.rgPath}`);
  } else {
    logger.warn(`grep 后端定格 unavailable（工具将响亮失败）：${grepFreeze.reasons.join("；")}`);
  }

  const codegraphResolution = resolveCodegraphPath({
    bundlePath: process.env.HELIX_CODEGRAPH_PATH,
    probe: isExecutableFile,
  });
  if (codegraphResolution.kind === "resolved") {
    logger.info(`codegraph 引擎定格（bundle）：${codegraphResolution.path}`);
  } else {
    logger.info(`codegraph 引擎不可用（构建面 degraded，AF-2）：${codegraphResolution.reasons.join("；")}`);
  }
  return { grepFreeze, codegraphResolution };
}

// ── config 瘦身批迁移（两批，一次性幂等） ──────────────────────────

export interface LegacyMigrationCtx {
  readonly legacy: LegacyModelConfig;
  readonly persistence: PersistenceStack;
  readonly paths: HelixPaths;
  readonly config: DaemonConfig;
  readonly logger: Logger;
}

/**
 * config 瘦身批迁移第一批（一次性，幂等；先于端口解析与 MCP 预热）：旧
 * config.json 含 port/maxConcurrent/maxQueued/mcpServers → 写新位
 *（KV daemon_port / KV scheduling_config / mcp_server 表）+ config.json
 * 重写瘦身形态。model/apiKeys 迁移在模型栈就绪后（migrateLegacyModelConfig）。
 */
export async function migrateLegacyRuntimeConfig(ctx: LegacyMigrationCtx): Promise<void> {
  const { legacy, persistence, paths, config, logger } = ctx;
  if (
    legacy.port !== undefined ||
    legacy.maxConcurrent !== undefined ||
    legacy.maxQueued !== undefined ||
    legacy.mcpServers !== undefined
  ) {
    const migrated: string[] = [];
    if (legacy.port !== undefined) {
      await persistence.runtimeConfig.set("daemon_port", String(legacy.port));
      migrated.push(`port=${legacy.port} → KV daemon_port`);
    }
    if (legacy.maxConcurrent !== undefined || legacy.maxQueued !== undefined) {
      const budget = persistence.schedulingConfig.current(); // 未迁字段回落现值/缺省
      await persistence.schedulingConfig.set({
        maxConcurrent: legacy.maxConcurrent ?? budget.maxConcurrent,
        maxQueued: legacy.maxQueued ?? budget.maxQueued,
      });
      migrated.push("调度预算 → KV scheduling_config");
    }
    if (legacy.mcpServers !== undefined) {
      await persistence.mcpConfig.replaceAll(legacy.mcpServers);
      migrated.push(`mcpServers → mcp_server 表（${legacy.mcpServers.length} 项）`);
    }
    writeConfig(paths.configPath(), config); // 重写瘦身形态（旧字段不再出现）
    logger.info(`已迁移旧配置（config 瘦身批）：${migrated.join("；")}；config.json 已重写瘦身形态`);
  }
  await migrateLegacySandboxConfig(paths, persistence, logger);
}

/**
 * 沙箱开关批一次性迁移（幂等）：旧 `<home>/sandbox.json`（第一版文件开关）
 * 存在 → 读 enabled 写 KV sandbox_config → 改名 sandbox.json.migrated（保留
 * 原文退路，不删除）。文件不存在/已迁移 → 无操作。仅当 KV 无既有值时写入
 *（避免覆盖用户已在新面设置过的值）。
 */
async function migrateLegacySandboxConfig(paths: HelixPaths, persistence: PersistenceStack, logger: Logger): Promise<void> {
  const legacyPath = path.join(paths.home, "sandbox.json");
  let raw: { enabled?: unknown };
  try {
    raw = JSON.parse(readFileSync(legacyPath, "utf-8")) as { enabled?: unknown };
  } catch {
    return; // 不存在/已迁移/损坏 → 无操作（损坏视为未设置，不迁移）
  }
  const migratedPath = `${legacyPath}.migrated`;
  try {
    if (typeof raw.enabled === "boolean") {
      const current = persistence.runtimeConfig.get("sandbox_config");
      if (current === undefined) {
        await persistence.sandboxConfig.set({ enabled: raw.enabled });
      }
      renameSync(legacyPath, migratedPath);
      logger.info(`已迁移沙箱开关（沙箱开关批）：sandbox.json{enabled:${raw.enabled}} → KV sandbox_config；原文改名 sandbox.json.migrated`);
    } else {
      renameSync(legacyPath, migratedPath); // 非布尔形态视为废弃文件——改名免得每次启动重读
    }
  } catch (error) {
    logger.warn(`沙箱开关迁移失败（不阻断启动，失败安全=维持 KV 现值）：${(error as Error).message}`);
  }
}

/**
 * 旧格式迁移第二批（一次性，幂等；模型栈就绪后）：config.json 含
 * model/apiKeys → 写新位（auth.json / SQLite 默认表）+ config.json 重写瘦身形态。
 */
export async function migrateLegacyModelConfig(ctx: LegacyMigrationCtx & { readonly modelStack: ModelStack }): Promise<void> {
  const { legacy, persistence, paths, config, logger, modelStack } = ctx;
  if (legacy.model !== undefined || legacy.apiKeys !== undefined) {
    for (const [providerId, apiKey] of Object.entries(legacy.apiKeys ?? {})) {
      await modelStack.authStore.setKey(providerId, apiKey);
    }
    if (legacy.model !== undefined) await persistence.defaultModel.set(legacy.model);
    writeConfig(paths.configPath(), config);
    logger.info(
      `已迁移旧配置：model → SQLite 默认模型表（${legacy.model ?? "无"}）；` +
        `apiKeys → ${paths.authPath()}（${Object.keys(legacy.apiKeys ?? {}).length} 项）；config.json 已重写瘦身形态`,
    );
  }
}

// ── WS 端口解析链 + PortConfigPort ───────────────────────────────

/**
 * 解析 KV daemon_port 值（0-65535 整数字符串；非法/未设 → null——两态同值，调用方无须区分）。
 */
function parseStoredPort(raw: string | undefined): number | null {
  if (raw === undefined) return null;
  if (!/^\d+$/.test(raw)) return null;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0 || n > 65535) return null;
  return n;
}

export interface WsPortResolution {
  /** 完整解析链定格产物（argv --port > KV daemon_port > 缺省 7333）。 */
  readonly resolvedPort: number;
  /** WS 端口配置面（config.get/set_port 回口；effectivePort 晚绑实际监听端口）。 */
  readonly portConfig: PortConfigPort;
  /** config.get_port 回口晚绑回填：实际监听端口（0=随机时 ws.port 为分配值）。 */
  readonly bindEffectivePort: (port: number) => void;
}

/**
 * WS 端口解析链（2026-09-05 config.json 瘦身：argv --port > KV
 * daemon_port > 缺省 7333；config.json port 字段退役——迁移第一批把旧值
 * 写入 KV，故本链须在 migrateLegacyRuntimeConfig 之后求值）。port 是启动期
 * 定格参数：set 后下次启动生效。
 */
export function resolveWsPort(deps: {
  /** argv --port 本次运行显式覆盖（不回写 KV）。 */
  readonly argvPort: number | undefined;
  readonly runtimeConfig: RuntimeConfigStore;
}): WsPortResolution {
  const { argvPort, runtimeConfig } = deps;
  const kvPort = parseStoredPort(runtimeConfig.get("daemon_port"));
  const resolvedPort = argvPort ?? kvPort ?? DEFAULT_PORT;

  /** WS 端口配置面（config.get/set_port 回口；晚绑实际监听端口）。 */
  let effectivePortNow: number | undefined;
  const portConfig: PortConfigPort = {
    effectivePort: () => effectivePortNow ?? resolvedPort,
    overriddenByArgv: () => argvPort !== undefined,
    storedPort: () => parseStoredPort(runtimeConfig.get("daemon_port")),
    setPort: (port) => runtimeConfig.set("daemon_port", String(port)),
  };
  return {
    resolvedPort,
    portConfig,
    bindEffectivePort: (port) => {
      effectivePortNow = port;
    },
  };
}
