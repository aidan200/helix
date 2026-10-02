import type {
  AgentHarnessTool,
  AgentToolResult,
  ExecutionToolContext,
} from "../../../../adapters/driven/tools/vendor/pi-harness";
import type { AskService } from "../../../../application/services/AskService";

/**
 * permission_request 工具（提权申请批）——agent 主动申请一次性提权执行。
 *
 * 语义（与用户四轮裁决定稿一致）：
 * - **agent 主动申请**（非沙箱拒绝自动弹）：agent 预判命令会越界（写沙箱
 *   可写根外/需要宿主机环境）时调用；
 * - **批准 = 一次性裸跑**：本次执行不经 sandbox-exec 装饰（env.exec 原通道
 *   ——SandboxRuntime 包装在 CoreToolExecutor 的共享 env 上，本工具拿到的
 *   context.env 已是装饰后形态，故裸跑走 deps.unsandboxedExec 注入口）；
 * - **拒绝/超时 = 引导文案**：60s 无裁决自动拒绝（AskService 机械超时）；
 * - 结果（stdout/stderr/exitCode）直接作为工具结果返回——与 bash 工具同形态。
 *
 * 注册门控：仅沙箱开启时注册（装配面判定——沙箱 off 无提权语义）；
 * main/subagent 双 profile 声明，SubAgent 经 ask-request wire 行转发父进程
 * 仲裁（父持 AskService 单例——卡片弹在归属会话页）。
 */

const permissionRequestParameters = {
  type: "object",
  properties: {
    command: {
      type: "string",
      description: "要提权执行的命令原文（与 bash 工具 command 同语义）",
    },
    reason: {
      type: "string",
      description: "申请理由：为什么这条命令必须在沙箱外执行（用户裁决依据，一句话）",
    },
  },
  required: ["command", "reason"],
  additionalProperties: false,
} as const;

export interface PermissionRequestToolDeps {
  /** 提权申请仲裁服务（父进程单例；SubAgent 经 wire 转发同此面）。 */
  readonly ask: Pick<AskService, "request">;
  /** 本会话 id（装配面绑定——工具参数零 sessionId，防伪造他会话申请）。 */
  readonly sessionId: string;
  /** 本实例 id（卡片署名 + 事件归属）。 */
  readonly instanceId: string;
  /**
   * 裸执行面（未经沙箱装饰的 exec——批准后的执行通道）。装配面注入
   * NodeExecutionEnv 原型的 exec 绑定（与 CoreToolExecutor 共享 env 同
   * cwd/shellEnv，仅无沙箱装饰）。
   */
  readonly unsandboxedExec: (
    command: string,
  ) => Promise<{ stdout: string; stderr: string; exitCode: number }>;
}

export function createPermissionRequestTool(
  deps: PermissionRequestToolDeps,
): AgentHarnessTool<ExecutionToolContext, any, undefined> {
  return {
    name: "permission_request",
    label: "申请提权执行",
    description:
      "权限申请：申请一次性提升权限执行命令（写沙箱可写根外、全局安装、宿主机系统命令等被沙箱拦截的场景）。用户批准后仅本次执行放行（不记 always-allow）；拒绝或 60s 超时后收到引导，应改道沙箱内方案或放弃。",
    parameters: permissionRequestParameters,
    execute: async (_toolCallId, params): Promise<AgentToolResult<undefined>> => {
      const { command, reason } = params as { command: string; reason: string };
      let outcome: "approved" | "denied" | "timeout";
      try {
        outcome = await deps.ask.request({
          sessionId: deps.sessionId,
          instanceId: deps.instanceId,
          command,
          reason,
          kind: "permission_request",
        });
      } catch (err) {
        return {
          content: [{ type: "text", text: `提权申请未发起：${(err as Error).message}` }],
          details: undefined,
        };
      }
      if (outcome !== "approved") {
        const why = outcome === "timeout" ? "60 秒内未获用户裁决（超时自动拒绝）" : "用户拒绝";
        return {
          content: [
            {
              type: "text",
              text: `提权执行申请被拒绝（${why}）：\`${command}\`。请改道沙箱内方案（写入工作区或 ~/.helix 下路径），或向用户说明后请其在设置页调整沙箱配置。`,
            },
          ],
          details: undefined,
        };
      }
      // 批准：一次性裸跑（不经沙箱装饰）
      try {
        const res = await deps.unsandboxedExec(command);
        const text =
          (res.stdout !== "" ? res.stdout : "") +
          (res.stderr !== "" ? `${res.stdout !== "" ? "\n" : ""}[stderr]\n${res.stderr}` : "") +
          (res.exitCode !== 0 ? `\n[exit ${res.exitCode}]` : "");
        return {
          content: [{ type: "text", text: text === "" ? "(no output)" : text }],
          details: undefined,
        };
      } catch (err) {
        return {
          content: [{ type: "text", text: `提权执行失败：${(err as Error).message}` }],
          details: undefined,
        };
      }
    },
  };
}
