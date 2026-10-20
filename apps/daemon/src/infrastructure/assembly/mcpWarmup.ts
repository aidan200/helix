import type { EventStream } from "../../adapters/driving/ws-server/EventStream";
import type { ProfileKind } from "../../application/ports/outbound/ResourceStatePort";
import type { McpRegistry } from "../../adapters/driven/mcp/McpRegistry";
import type { McpConfigStore } from "../../adapters/driven/sqlite-session/McpConfigStore";

/**
 * 装配片 MCP 启动预热 + 状态帧接线（P5 体量门拆分，自组合根 container.ts
 * 原样迁出）：组合根的一部分（AG-02④ 豁免面 infrastructure/assembly/**）。
 *
 * 接线契约（TR-111 MCP 标准接入层）：
 * - ① config.mcpServers → 逐 server addServer（独立 try——单 server 失败降级
 *   error 状态不阻塞其它）；
 * - ② 状态订阅双消费：running/error/stopped → mcp.status.changed 全连接广播
 *   （设置页徽标数据源）；**running/stopped 时同步刷新装配三 kind**
 *   （main-session + subagent-worker + orchestrator）→ refreshAssembly 重算
 *   catalog（新工具名进生效集）+ 活跃会话 appendTools + setTools 直改（下一
 *   turn 生效）。orchestrator 虽零活跃直改（会话短生命周期），快照重算让下一
 *   编排会话拿到 MCP 工具名——F4 修复前漏接此 kind，orchestrator 的 MCP 工具
 *   经 orchestratorMcpTools 注册而快照永不到达（注册而不可达）；
 * - 预热 fire-and-forget：daemon 服务先起，MCP 工具陆续到位。
 *
 * 装配序契约：位于 buildSessionStack 之后（refreshAssembly/eventStream 就绪）、
 * buildDrivingAdapters 之前（本函数返回的 shutdown 钩子进 driving deps：
 * 退订 + stopAll——先退订再停，停自身触发的状态事件不再回流）。
 */
export function wireMcpWarmup(deps: {
  readonly mcpRegistry: McpRegistry;
  readonly mcpConfig: McpConfigStore;
  readonly eventStream: EventStream;
  /** 会话栈装配刷新面（三 kind 重算；catch 兑底在调用点）。 */
  readonly refreshAssembly: (kind: ProfileKind) => Promise<void>;
}): () => void {
  const { mcpRegistry, mcpConfig, eventStream, refreshAssembly } = deps;
  const unsubscribeMcpStatus = mcpRegistry.onStatusChange((status) => {
    eventStream.broadcastMcpStatusChanged({ server: status });
    if (status.state === "running" || status.state === "stopped") {
      // catch 兑底：shutdown 窗口的迟到刷新（关库后 status 事件才回流）
      // 静默降级——unhandled rejection 会击穿测试进程（mcp-ws ③ 实证）
      refreshAssembly("main-session").catch(() => {});
      refreshAssembly("subagent-worker").catch(() => {});
      refreshAssembly("orchestrator").catch(() => {});
    }
  });
  for (const serverConfig of mcpConfig.listConfigs()) {
    void mcpRegistry.addServer(serverConfig).catch(() => {
      // addServer 内部已降级（error 状态 + lastError）——此处兑底不可达路径
    });
  }
  return () => {
    unsubscribeMcpStatus();
    mcpRegistry.stopAll();
  };
}
