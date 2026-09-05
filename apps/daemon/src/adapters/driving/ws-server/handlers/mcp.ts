/**
 * mcp 族命令处理（mcp 批：MCP server 标准接入；契约 = PROTOCOL.md
 * §15.16/§16.11，PROTOCOL-CHANGELOG.md §26）。
 *
 * 先例 = handlers/web.ts：sendNow 点对点结果帧（mcp.*.result，TR-AD-21
 * 模式）+ commandError 错误回执。依赖面经 McpCommandContext 供出：
 * McpServerPort（连接/发现）+ saveMcpServers（配置窄写面）。
 *
 * 命令语义（六命令）：
 * - mcp.servers.list：listConfigs + getStatuses 合并读面（配置详情 +
 *   运行态；status 缺席防御回 idle）；
 * - mcp.servers.add：名字冲突拒绝 → 落盘 → addServer（连接 + 发现，
 *   失败降级 error 配置保留可重试）→ applied/connect_failed 两判别；
 * - mcp.servers.update：名字必须已存在 → 覆盖落盘 → addServer 同名
 *   幂等覆盖（断旧连重连）→ 同上判别；
 * - mcp.servers.remove：落盘（滤行）→ removeServer（断连 + 摘工具 +
 *   stopped 广播）→ applied；
 * - mcp.servers.test：probeMcpServer 试连（不落盘不注册）→
 *   applied{toolCount}/failed{error}；
 * - mcp.tools.list：指定 server 已发现工具（命名空间后全名
 *   `${server}__${tool}`；未知名拒绝）。
 *
 * 广播纪律（单一事件源）：状态迁移（connecting/running/error/stopped）
 * 全部由组合根 onStatusChange → mcp.status.changed 广播 + running/stopped
 * 时 refreshAssembly 刷新链接线发出，handler 不重复广播（web.stop 先例）。
 */
import { PROTOCOL_VERSION, SYSTEM_SESSION_ID } from "@helix/protocol";
import type {
  McpMutationResultPayload,
  McpServerConfigDto,
  McpServersAddResultEvent,
  McpServersListResultEvent,
  McpServersRemoveResultEvent,
  McpServersTestResultEvent,
  McpServersUpdateResultEvent,
  McpServerStatusDto,
  McpToolsListResultEvent,
} from "@helix/protocol";
import type {
  McpServerConfigInput,
  McpServerStatusInfo,
} from "../../../../application/ports/outbound/McpServerPort";
import type { McpCommandContext } from "./context";

/** 运行态行 DTO 映射（port McpServerStatusInfo → 协议 McpServerStatusDto）。 */
function statusDtoOf(status: McpServerStatusInfo): McpServerStatusDto {
  return {
    name: status.name,
    state: status.state,
    ...(status.toolCount !== undefined ? { toolCount: status.toolCount } : {}),
    ...(status.lastError !== undefined ? { lastError: status.lastError } : {}),
  };
}

/** 配置行 DTO 映射（port McpServerConfigInput → 协议 McpServerConfigDto；结构同形浅拷贝）。 */
function configDtoOf(config: McpServerConfigInput): McpServerConfigDto {
  return {
    name: config.name,
    command: config.command,
    ...(config.args !== undefined ? { args: [...config.args] } : {}),
    ...(config.env !== undefined ? { env: { ...config.env } } : {}),
    ...(config.cwd !== undefined ? { cwd: config.cwd } : {}),
    ...(config.enabled !== undefined ? { enabled: config.enabled } : {}),
    ...(config.timeoutMs !== undefined ? { timeoutMs: config.timeoutMs } : {}),
  };
}

/**
 * server 配置输入解析（add/update/test 共用）：name/command 必填非空
 * string；args 为 string[]；env 值全 string；cwd/enabled/timeoutMs 各按型。
 * 非法即返回错误文案（调用方 commandError），合法返回规范输入。
 */
function parseServerInput(
  payload: Record<string, unknown>,
): { ok: true; input: McpServerConfigInput } | { ok: false; error: string } {
  const { name, command } = payload;
  if (typeof name !== "string" || name === "") return { ok: false, error: "payload.name 应为非空 string" };
  if (typeof command !== "string" || command === "") return { ok: false, error: "payload.command 应为非空 string" };
  const args = payload.args;
  if (args !== undefined && (!Array.isArray(args) || args.some((a) => typeof a !== "string"))) {
    return { ok: false, error: "payload.args 应为 string[]" };
  }
  const env = payload.env;
  if (env !== undefined) {
    if (typeof env !== "object" || env === null || Array.isArray(env)) {
      return { ok: false, error: "payload.env 应为 Record<string, string>" };
    }
    for (const value of Object.values(env)) {
      if (typeof value !== "string") return { ok: false, error: "payload.env 应为 Record<string, string>" };
    }
  }
  const cwd = payload.cwd;
  if (cwd !== undefined && typeof cwd !== "string") return { ok: false, error: "payload.cwd 应为 string" };
  const enabled = payload.enabled;
  if (enabled !== undefined && typeof enabled !== "boolean") return { ok: false, error: "payload.enabled 应为 boolean" };
  const timeoutMs = payload.timeoutMs;
  if (timeoutMs !== undefined && typeof timeoutMs !== "number") return { ok: false, error: "payload.timeoutMs 应为 number" };
  return {
    ok: true,
    input: {
      name,
      command,
      ...(args !== undefined ? { args: args as string[] } : {}),
      ...(env !== undefined ? { env: env as Record<string, string> } : {}),
      ...(cwd !== undefined ? { cwd } : {}),
      ...(enabled !== undefined ? { enabled } : {}),
      ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    },
  };
}

/** 写面回执判别：state=error → connect_failed（配置已落盘可重试）；否则 applied。 */
function mutationPayloadOf(status: McpServerStatusInfo): McpMutationResultPayload {
  if (status.state === "error") {
    return {
      status: "connect_failed",
      server: statusDtoOf(status),
      ...(status.lastError !== undefined ? { error: status.lastError } : {}),
    };
  }
  return { status: "applied", server: statusDtoOf(status) };
}

/** mcp.servers.list（全局读面）：配置详情 + 运行态合并行。 */
export function handleMcpServersList(ctx: McpCommandContext): void {
  const configs = ctx.mcp.listConfigs();
  const statuses = new Map(ctx.mcp.getStatuses().map((s) => [s.name, s]));
  const servers = configs.map((config) => ({
    config: configDtoOf(config),
    status: statusDtoOf(statuses.get(config.name) ?? { name: config.name, state: "idle" }),
  }));
  const frame: McpServersListResultEvent = {
    v: PROTOCOL_VERSION,
    sessionId: SYSTEM_SESSION_ID,
    channel: "mcp",
    type: "mcp.servers.list.result",
    payload: { servers },
  };
  ctx.sendNow(ctx.ws.data.sender ?? ctx.rawSender(), frame);
}

/** mcp.servers.add（全局写面）：新增 server（冲突拒绝 → 落盘 → 连接发现）。 */
export function handleMcpServersAdd(ctx: McpCommandContext): void {
  const parsed = parseServerInput(ctx.payload);
  if (!parsed.ok) {
    return ctx.commandError(ctx.type, "command.invalid_payload", parsed.error);
  }
  const { input } = parsed;
  if (ctx.mcp.listConfigs().some((c) => c.name === input.name)) {
    return ctx.commandError(ctx.type, "command.invalid_payload", `MCP server "${input.name}" 已存在（更新请用 mcp.servers.update）`);
  }
  const sender = ctx.ws.data.sender ?? ctx.rawSender();
  const run = async (): Promise<void> => {
    // 先落盘后连接：连接失败（connect_failed 判别）配置仍保留——可重试
    ctx.saveMcpServers([...ctx.mcp.listConfigs(), input]);
    const status = await ctx.mcp.addServer(input);
    const frame: McpServersAddResultEvent = {
      v: PROTOCOL_VERSION,
      sessionId: SYSTEM_SESSION_ID,
      channel: "mcp",
      type: "mcp.servers.add.result",
      payload: mutationPayloadOf(status),
    };
    ctx.sendNow(sender, frame);
  };
  void run().catch((err) => ctx.commandError(ctx.type, "command.invalid_payload", `mcp.servers.add 执行失败：${(err as Error).message}`));
}

/** mcp.servers.update（全局写面）：按 name 覆盖配置（落盘 + 断旧连重连）。 */
export function handleMcpServersUpdate(ctx: McpCommandContext): void {
  const parsed = parseServerInput(ctx.payload);
  if (!parsed.ok) {
    return ctx.commandError(ctx.type, "command.invalid_payload", parsed.error);
  }
  const { input } = parsed;
  const configs = ctx.mcp.listConfigs();
  if (!configs.some((c) => c.name === input.name)) {
    return ctx.commandError(ctx.type, "command.invalid_payload", `MCP server "${input.name}" 不存在（新增请用 mcp.servers.add）`);
  }
  const sender = ctx.ws.data.sender ?? ctx.rawSender();
  const run = async (): Promise<void> => {
    ctx.saveMcpServers(configs.map((c) => (c.name === input.name ? input : c)));
    // addServer 同名幂等覆盖：断旧连 → 重连 → 重新发现（McpRegistry 并发语义）
    const status = await ctx.mcp.addServer(input);
    const frame: McpServersUpdateResultEvent = {
      v: PROTOCOL_VERSION,
      sessionId: SYSTEM_SESSION_ID,
      channel: "mcp",
      type: "mcp.servers.update.result",
      payload: mutationPayloadOf(status),
    };
    ctx.sendNow(sender, frame);
  };
  void run().catch((err) => ctx.commandError(ctx.type, "command.invalid_payload", `mcp.servers.update 执行失败：${(err as Error).message}`));
}

/** mcp.servers.remove（全局写面）：断连 + 摘工具 + 落盘（stopped 广播经组合根链）。 */
export function handleMcpServersRemove(ctx: McpCommandContext): void {
  const name = ctx.payload.name;
  if (typeof name !== "string" || name === "") {
    return ctx.commandError(ctx.type, "command.invalid_payload", "payload.name 应为非空 string");
  }
  const configs = ctx.mcp.listConfigs();
  if (!configs.some((c) => c.name === name)) {
    return ctx.commandError(ctx.type, "command.invalid_payload", `MCP server "${name}" 不存在`);
  }
  ctx.saveMcpServers(configs.filter((c) => c.name !== name));
  ctx.mcp.removeServer(name); // 断连 + 摘 entry + stopped 广播（刷新链在组合根接线自动触发）
  const frame: McpServersRemoveResultEvent = {
    v: PROTOCOL_VERSION,
    sessionId: SYSTEM_SESSION_ID,
    channel: "mcp",
    type: "mcp.servers.remove.result",
    payload: { status: "applied", server: { name, state: "stopped" } },
  };
  ctx.sendNow(ctx.ws.data.sender ?? ctx.rawSender(), frame);
}

/** mcp.servers.test（全局写面）：试连（不落盘不注册）——配置页「测试连接」。 */
export function handleMcpServersTest(ctx: McpCommandContext): void {
  const parsed = parseServerInput(ctx.payload);
  if (!parsed.ok) {
    return ctx.commandError(ctx.type, "command.invalid_payload", parsed.error);
  }
  const sender = ctx.ws.data.sender ?? ctx.rawSender();
  const run = async (): Promise<void> => {
    const frame: McpServersTestResultEvent = {
      v: PROTOCOL_VERSION,
      sessionId: SYSTEM_SESSION_ID,
      channel: "mcp",
      type: "mcp.servers.test.result",
      payload: { status: "applied", toolCount: (await ctx.mcp.testServer(parsed.input)).length },
    };
    ctx.sendNow(sender, frame);
  };
  void run().catch((err) => {
    // 试连失败是业务结果（命令 spawn/握手失败），非协议面错误——failed 判别回执
    const frame: McpServersTestResultEvent = {
      v: PROTOCOL_VERSION,
      sessionId: SYSTEM_SESSION_ID,
      channel: "mcp",
      type: "mcp.servers.test.result",
      payload: { status: "failed", error: (err as Error).message },
    };
    ctx.sendNow(sender, frame);
  });
}

/** mcp.tools.list（全局读面）：指定 server 已发现工具（命名空间后全名）。 */
export function handleMcpToolsList(ctx: McpCommandContext): void {
  const server = ctx.payload.server;
  if (typeof server !== "string" || server === "") {
    return ctx.commandError(ctx.type, "command.invalid_payload", "payload.server 应为非空 string");
  }
  if (!ctx.mcp.listConfigs().some((c) => c.name === server)) {
    return ctx.commandError(ctx.type, "command.invalid_payload", `MCP server "${server}" 不存在`);
  }
  const frame: McpToolsListResultEvent = {
    v: PROTOCOL_VERSION,
    sessionId: SYSTEM_SESSION_ID,
    channel: "mcp",
    type: "mcp.tools.list.result",
    payload: {
      server,
      tools: ctx.mcp.toolsOf(server).map((t) => ({
        name: `${server}__${t.name}`, // 命名空间后全名（与 CoreToolExecutor 注册名一致）
        description: t.description,
      })),
    },
  };
  ctx.sendNow(ctx.ws.data.sender ?? ctx.rawSender(), frame);
}
