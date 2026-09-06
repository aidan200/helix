/**
 * 装配函数 ③ 的 MCP catalog 闭包群（code-review M5 切片，自
 * buildSessionStack 抽出——组合根 AG-02④ 豁免面 infrastructure/assembly/**）。
 * 成员：静态工具目录（五 profile 声明面单源）+ kind 准入白名单 +
 * toolsCatalog/effectiveToolsCatalog/toolSnippetOf/mcpServersOf 四闭包 +
 * deferred 批物化集与 discover 物化回调（onMcpDiscover，含 publish catch
 * 兑底——M5 修复，对齐 container.ts mcp 状态回调先例）。
 * 抽出为零行为改动纯移动：闭包消费面（ResourceService deps / refreshAssembly /
 * engineFor / orchestratorMcpTools）与装配序语义不变。
 */

import type { ProfileKind } from "../../application/ports/outbound/ResourceStatePort";
import type { ResourceService } from "../../application/services/ResourceService";
import type { SessionRegistry } from "../../application/services/SessionRegistry";
import type { McpRegistry } from "../../adapters/driven/mcp/McpRegistry";
import { mcpDiscoverToolName } from "../../adapters/driven/mcp/mcp-tool";
import { MainSessionProfile } from "../../adapters/driven/pi-engine/runtime/profiles/MainSessionProfile";
import { SubAgentProfile } from "../../adapters/driven/pi-engine/runtime/profiles/SubAgentProfile";
import { SubAgentKgWriterProfile } from "../../adapters/driven/pi-engine/runtime/profiles/SubAgentKgWriterProfile";
import { SubAgentCodeReviewerProfile } from "../../adapters/driven/pi-engine/runtime/profiles/SubAgentCodeReviewerProfile";
import { OrchestratorProfile } from "../../adapters/driven/pi-engine/runtime/profiles/OrchestratorProfile";
import type { PublishResourceChanged } from "./resource-events";

/** 静态工具目录（profile 声明面单源；mcp 批抽出一一函数化 catalog 消费）。 */
const STATIC_TOOLS_CATALOG: Readonly<Record<ProfileKind, readonly string[]>> = {
  "main-session": MainSessionProfile.tools,
  "subagent-worker": SubAgentProfile.tools,
  "orchestrator": OrchestratorProfile.tools, // T2.2 第三 kind（additive 扩值；编排工具面可配置化）
  // R7 系统槽位批第四 kind：kg-writer 目录全集（声明面单源；生效集受
  // 自身差异行管控——独立配置，不再从 worker 派生）
  "subagent-kg-writer": SubAgentKgWriterProfile.tools,
  // D5 第五 kind：reviewer 目录全集 = worker 声明面 − write/edit（声明面
  // 单源；生效集受自身差异行管控——独立配置）
  "subagent-code-reviewer": SubAgentCodeReviewerProfile.tools,
};

/**
 * kind → MCP server 准入白名单（mcp 批，profile 声明单源）：五 kind 全
 * 声明 "*"（同轨——装配/读面同构；准入实际由 server enabled 显式启用制
 * + 工具级 toggle 管控；系统派生三 kind 写面只读——展示同构、开关置灰）。
 * 导出供 buildSessionStack 的 SubagentLauncher mcpServersFor 门控复用（同源）。
 */
export const MCP_ALLOWED_OF: Readonly<Record<ProfileKind, readonly string[] | "*" | undefined>> = {
  "main-session": MainSessionProfile.mcpServers,
  "subagent-worker": SubAgentProfile.mcpServers,
  orchestrator: OrchestratorProfile.mcpServers,
  "subagent-kg-writer": SubAgentKgWriterProfile.mcpServers,
  "subagent-code-reviewer": SubAgentCodeReviewerProfile.mcpServers,
};

/** MCP server 运行态行（mcpServersOf 出行；ResourceService list 块数据源）。 */
export interface McpServerRuntimeRow {
  readonly name: string;
  readonly state: string;
  readonly toolCount?: number;
  readonly lastError?: string;
}

export interface McpCatalogSurfaceDeps {
  /** MCP 注册表（可选——缺省 = 无 MCP 零配置兼容形态，catalog 恒静态声明面）。 */
  readonly mcpRegistry: McpRegistry | undefined;
  /**
   * 生效集读面（onMcpDiscover ② 同步直改消费）：ResourceService 构造后闭合
   * 的晚绑 getter（构造环：ResourceService deps 消费本面 catalog 闭包，
   * onMcpDiscover 只在运行期 executor discover 时触发——装配窗口零调用）。
   */
  readonly effectiveToolsOf: (kind: ProfileKind) => readonly string[];
  /** 活跃会话 runtime 读面（onMcpDiscover ②；SessionRegistry 构造后闭合，同上晚绑）。 */
  readonly hotRuntimes: () => readonly { readonly chatService: { setTools(tools: readonly string[]): void } }[];
  /** resources.changed 发布面（onMcpDiscover ③ 异步刷新链）。 */
  readonly publishResourceChanged: PublishResourceChanged;
}

export interface McpCatalogSurface {
  /**
   * deferred 批：MCP 物化集（per kind 内存态——discover 已装载名单；
   * effectiveToolsCatalog 消费 + onDiscover 写入；重启自然清零回 meta-only）。
   */
  readonly materializedMcp: ReadonlyMap<ProfileKind, ReadonlySet<string>>;
  /** kind → tools 全集（静态声明面 + MCP 命名空间工具名动态拼接，每次读现拍）。 */
  readonly toolsCatalog: (kind: ProfileKind) => readonly string[];
  /** kind → 生效集计算专用目录（deferred server 具体工具剔除，代 meta 工具名 + 物化集 union）。 */
  readonly effectiveToolsCatalog: (kind: ProfileKind) => readonly string[];
  /** 工具名 → snippet 动态读面（MCP 工具行 = registry 发现的 description 透传）。 */
  readonly toolSnippetOf: (name: string) => string | undefined;
  /** kind 准入面内的 MCP server 运行态行（registry 现拍 + 白名单门控）。 */
  readonly mcpServersOf: (kind: ProfileKind) => readonly McpServerRuntimeRow[];
  /** discover 物化回调（executor 构造点闭包——kind 绑定；三拍语义见实现注释）。 */
  readonly onMcpDiscover: (kind: ProfileKind, server: string, namespacedNames: readonly string[]) => void;
}

export function buildMcpCatalogSurface(deps: McpCatalogSurfaceDeps): McpCatalogSurface {
  // deferred 批：MCP 物化集（per kind 内存态——discover 已装载名单；
  // effectiveToolsCatalog 消费 + onDiscover 写入；重启自然清零回 meta-only）。
  const materializedMcp = new Map<ProfileKind, Set<string>>();
  /**
   * discover 物化回调（executor 构造点闭包——kind 绑定）：
   * ① 物化集登记（同步——effectiveToolsCatalog 立即可见）；
   * ② 活跃 runtime 同步直改 setTools（同步读 effective 现值——必须赶在
   *    turn 边界 prepareNextTurn 之前，McpDeferredHooks 才能检测到漂移；
   *    经 publishResourceChanged 的异步刷新链会输给 turn 边界竞态）；
   * ③ resources.changed 发布（异步刷新链：快照/系统提示重算对齐）。
   */
  const onMcpDiscover = (kind: ProfileKind, _server: string, namespacedNames: readonly string[]): void => {
    const set = materializedMcp.get(kind) ?? new Set<string>();
    for (const name of namespacedNames) set.add(name);
    materializedMcp.set(kind, set);
    if (kind === "main-session") {
      // 同步最小路径：物化名已注册 executor（构造时全量 append）——按名
      // resolve + state.tools 直改；系统提示/快照对齐交给 ③ 异步链。
      const effective = deps.effectiveToolsOf(kind);
      for (const runtime of deps.hotRuntimes()) {
        runtime.chatService.setTools(effective);
      }
    }
    // catch 兑底（code-review M5，对齐 container.ts mcp 状态回调先例）：
    // publish 经 resourceEvents.publish → Promise.all 汇聚 refreshAssembly
    //（含技能扫描 fs IO 与 setSystemPrompt/setTools）——reject 不得成
    // unhandled rejection（shutdown 窗口迟到刷新碰已关库会击穿测试进程，
    // mcp-ws ③ 实证同机制）。
    void Promise.resolve(deps.publishResourceChanged(kind)).catch(() => {});
  };
  return {
    materializedMcp,
    onMcpDiscover,
    // mcp 批：catalog 函数化——静态 profile 声明面 + MCP 命名空间工具名
    // 动态拼接（每次读现拍 McpRegistry 值；server 到位即进 catalog）。
    // 准入门控：profile mcpServers 白名单（"*" = 全部；未声明 = 不接入）
    // ——五 kind 声明全开（同轨批；准入实际由 server enabled 显式启用制 +
    // 工具级 toggle 管控；系统三 kind 写面只读恒关，未来启用零结构改动）。
    toolsCatalog: (kind: ProfileKind): readonly string[] => {
      const staticNames = STATIC_TOOLS_CATALOG[kind];
      const registry = deps.mcpRegistry; // 窄化（闭包重读不安全）
      const allowed = registry !== undefined ? MCP_ALLOWED_OF[kind] : undefined;
      if (registry === undefined || allowed === undefined) return staticNames;
      const mcpNames = registry
        .discoveredTools()
        .filter((t) => allowed === "*" || allowed.includes(t.server))
        .map((t) => `${t.server}__${t.definition.name}`);
      return [...staticNames, ...mcpNames];
    },
    // deferred 批：生效集计算专用目录（catalog 全集 = 页面展示 + toggle 域
    // 保持全量；本面只供 getEffectiveTools 初始集）——deferred server
    //（缺省）具体工具剔除，代之 meta 工具名 + 物化集 union；非 deferred
    // server 照旧全量。物化集 = discover 已装载名单（per kind 内存态——
    // 重启自然清零回 meta-only，与探查报告边界 1 一致）。
    effectiveToolsCatalog: (kind: ProfileKind): readonly string[] => {
      const staticNames = STATIC_TOOLS_CATALOG[kind];
      const registry = deps.mcpRegistry;
      const allowed = registry !== undefined ? MCP_ALLOWED_OF[kind] : undefined;
      if (registry === undefined || allowed === undefined) return staticNames;
      const names = [...staticNames];
      // 按 server 分组（running 才进 discoveredTools）
      const byServer = new Map<string, string[]>();
      for (const { server, definition } of registry.discoveredTools()) {
        if (allowed !== "*" && !allowed.includes(server)) continue;
        const list = byServer.get(server) ?? [];
        list.push(definition.name);
        byServer.set(server, list);
      }
      const configMap = new Map(registry.listConfigs().map((c) => [c.name, c] as const));
      const materialized = materializedMcp.get(kind);
      for (const [server, rawNames] of byServer) {
        const deferred = configMap.get(server)?.deferred !== false;
        if (!deferred) {
          names.push(...rawNames.map((raw) => `${server}__${raw}`));
          continue;
        }
        const meta = mcpDiscoverToolName(server, rawNames);
        if (meta !== undefined) names.push(meta);
        for (const raw of rawNames) {
          const ns = `${server}__${raw}`;
          if (materialized?.has(ns)) names.push(ns);
        }
      }
      return names;
    },
    // server 级配置面批：MCP 工具行 snippet = registry 发现的 description
    // 透传（注册表外名不再恒空串）；静态工具名不含双下划线恒走注册表。
    toolSnippetOf: (name: string): string | undefined => {
      const sep = name.indexOf("__");
      if (sep <= 0) return undefined;
      const server = name.slice(0, sep);
      return deps.mcpRegistry?.toolsOf(server).find((t) => t.name === name.slice(sep + 2))?.description;
    },
    // server 级配置面批：kind 准入面内的 MCP server 运行态行（registry 现拍
    // + MCP_ALLOWED_OF 白名单门控——静态 kind 不接 MCP 恒空数组→块不携带）；
    // enabled 由 ResourceService store 差异行合取（注入面不解释启停）。
    mcpServersOf: (kind: ProfileKind): readonly McpServerRuntimeRow[] => {
      const registry = deps.mcpRegistry;
      const allowed = registry !== undefined ? MCP_ALLOWED_OF[kind] : undefined;
      if (registry === undefined || allowed === undefined) return [];
      return registry
        .listConfigs()
        .filter((c) => allowed === "*" || allowed.includes(c.name))
        .map((c) => {
          const status = registry.getStatuses().find((s) => s.name === c.name);
          return {
            name: c.name,
            state: status?.state ?? "idle",
            ...(status?.toolCount !== undefined ? { toolCount: status.toolCount } : {}),
            ...(status?.lastError !== undefined ? { lastError: status.lastError } : {}),
          };
        });
    },
  };
}
