import type { WriteQueue } from "./WriteQueue";
import type { McpServerConfig } from "../mcp/types";

/**
 * McpConfigStore —— MCP server 声明面的持久化存取（config 瘦身批
 * 2026-09-05：config.json mcpServers 段迁 helix.db mcp_server 表——
 * name PK + config JSON 列 + position 保序）。
 *
 * 写面经 WriteQueue 单写通道（AG-06）：整段替换 job（saveMcpServers
 * 先清后插一个 job 内原子序——TR-106 纪律 4「配置落盘先于连接」的
 * 落盘步，await 返回即可查）；读面共用 WriteQueue 暴露的 db 连接
 * （RuntimeConfigStore 同构读侧模式）。
 *
 * 序列化边界：McpServerConfig 行 → config JSON 列在本层完成——
 * WriteQueue 只收 primitive 行（跨 driven 包零类型依赖）。解析非法行
 * 跳过不抛（脏数据容错——半行损坏不让整个声明面失效）。
 */
export class McpConfigStore {
  constructor(private readonly writeQueue: WriteQueue) {}

  /** 全量声明面（ORDER BY position；空表 = 无 server 零配置兼容）。 */
  listConfigs(): McpServerConfig[] {
    const rows = this.writeQueue.database
      .prepare("SELECT name, config FROM mcp_server ORDER BY position")
      .all() as { name: string; config: string }[];
    const out: McpServerConfig[] = [];
    for (const row of rows) {
      const parsed = parseMcpServerConfig(row.name, row.config);
      if (parsed !== undefined) out.push(parsed);
    }
    return out;
  }

  /** 整段替换（数组序 = position 序；落盘完成即返回）。 */
  async replaceAll(servers: readonly McpServerConfig[]): Promise<void> {
    await this.writeQueue.saveMcpServers(
      servers.map((s, i) => ({ name: s.name, config: JSON.stringify(s), position: i })),
    );
  }
}

/** config JSON 列 → McpServerConfig；缺 name/command 或形状非法 → undefined（跳过行）。 */
function parseMcpServerConfig(name: string, raw: string): McpServerConfig | undefined {
  try {
    const p = JSON.parse(raw) as Record<string, unknown>;
    if (typeof p["command"] !== "string" || p["command"].trim() === "") return undefined;
    const out: McpServerConfig = { name, command: p["command"] };
    if (Array.isArray(p["args"]) && p["args"].every((a) => typeof a === "string")) {
      (out as { args?: string[] }).args = p["args"] as string[];
    }
    if (typeof p["env"] === "object" && p["env"] !== null && !Array.isArray(p["env"])) {
      // env 值须全为 string（spawn env 契约）——{FOO: 1} 类脏行整段跳过
      const env = p["env"] as Record<string, unknown>;
      if (Object.values(env).every((v) => typeof v === "string")) {
        (out as { env?: Record<string, string> }).env = env as Record<string, string>;
      }
    }
    if (typeof p["cwd"] === "string" && p["cwd"] !== "") {
      (out as { cwd?: string }).cwd = p["cwd"];
    }
    if (typeof p["enabled"] === "boolean") {
      (out as { enabled?: boolean }).enabled = p["enabled"];
    }
    if (typeof p["timeoutMs"] === "number") {
      (out as { timeoutMs?: number }).timeoutMs = p["timeoutMs"];
    }
    return out;
  } catch {
    return undefined;
  }
}
