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
 * - **提权自动通过**（autoApprove 配置）：AskService 短路裁 auto_approved
 *   （异步版）/ 闸前短路批准（闸制版）→ 免弹卡直接裸跑，工具结果附注记行
 *   留痕（A① 完全静默裁决的唯一留痕面）；
 * - 结果（合并输出 + exitCode）直接作为工具结果返回——与 bash 工具同形态。
 *   输出是**单合并流**（pi 0.85 exec 的 onUpdate 不分 stdout/stderr，裸执行面
 *   只挂一级 tap 收全文）：契约因此只声明 output，不再声明拿不到的 stderr
 *   （低危批：旧契约声明 stderr 而两条实现恒返 ""，[stderr] 分支永不可达）。
 *
 * 注册门控：仅沙箱开启时注册（装配面判定——沙箱 off 无提权语义）；
 * main/subagent 双 profile 声明，SubAgent 经 ask-request wire 行转发父进程
 * 仲裁（父持 AskService 单例——卡片弹在归属会话页）。
 */

/** 裸执行面超时/输出契约说明见 PermissionRequestToolDeps.unsandboxedExec。 */

/** 裸跑结果 → 工具文本（合并输出流 + 非零退出附注；低危批上收两处同构拼接）。 */
function formatExecOutput(res: { output: string; exitCode: number }): string {
  const text = res.output + (res.exitCode !== 0 ? `\n[exit ${res.exitCode}]` : "");
  return text === "" ? "(no output)" : text;
}

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
  readonly unsandboxedExec: (command: string) => Promise<{ output: string; exitCode: number }>;
  /**
   * 提权自动通过判定（autoApprove 配置；可选——缺省不注记）：闸制版审批在
   * beforeToolCall 闸完成、execute 不接触 ask，故闸制版的「未经用户确认」
   * 留痕只能走本判定（异步版留痕走 outcome=auto_approved）。装配面接
   * SandboxConfigPort.current().autoApprove 现值读取（运行期即热）。
   */
  readonly autoApprove?: () => boolean;
}

/** 自动通过注记行（两版共用——静默裁决的唯一留痕面）。 */
const AUTO_APPROVE_NOTE = "（提权申请已按配置自动通过，未经用户确认）";

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
      let outcome: "approved" | "denied" | "timeout" | "auto_approved";
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
      if (outcome === "denied" || outcome === "timeout") {
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
      // 批准：一次性裸跑（不经沙箱装饰）；auto_approved = 配置自动通过（注记留痕）
      const note = outcome === "auto_approved" ? `\n${AUTO_APPROVE_NOTE}` : "";
      try {
        const res = await deps.unsandboxedExec(command);
        return {
          content: [{ type: "text", text: formatExecOutput(res) + note }],
          details: undefined,
        };
      } catch (err) {
        return {
          content: [{ type: "text", text: `提权执行失败：${(err as Error).message}${note}` }],
          details: undefined,
        };
      }
    },
  };
}

/**
 * 闸制版 permission_request（审批闸接线批）：主会话审批闸装配时使用。
 *
 * 与异步工具制的分工：闸制下审批发生在 beforeToolCall（ApprovalGateHook
 * 挂闸 → engine_paused → ChatService 桥走 AskService 卡片 → resume），
 * execute 到达 = 已批准——本工具只剩纯裸跑（再走 ask.request 会双卡片）。
 * 异步工具制（原工厂）保留给 SubAgent 子进程（闸制面未接——RemoteAskPort
 * 转发父进程仲裁的既有链路不变）。工具名/参数/描述与原版同面（模型认知
 * 零变化，profile 声明不动）。autoApprove 配置开时结果附注记留痕（闸前
 * AskService 已短路自动批准——execute 不接触 ask，留痕走 deps.autoApprove）。
 */
export function createPermissionRequestGatedTool(
  deps: Pick<PermissionRequestToolDeps, "unsandboxedExec" | "autoApprove">,
): AgentHarnessTool<ExecutionToolContext, any, undefined> {
  return {
    name: "permission_request",
    label: "申请提权执行",
    description:
      "权限申请：申请一次性提升权限执行命令（写沙箱可写根外、全局安装、宿主机系统命令等被沙箱拦截的场景）。用户批准后仅本次执行放行（不记 always-allow）；拒绝或 60s 超时后收到引导，应改道沙箱内方案或放弃。",
    parameters: permissionRequestParameters,
    execute: async (_toolCallId, params): Promise<AgentToolResult<undefined>> => {
      const { command } = params as { command: string; reason: string };
      const note = deps.autoApprove?.() === true ? `\n${AUTO_APPROVE_NOTE}` : "";
      try {
        const res = await deps.unsandboxedExec(command);
        return {
          content: [{ type: "text", text: formatExecOutput(res) + note }],
          details: undefined,
        };
      } catch (err) {
        return {
          content: [{ type: "text", text: `提权执行失败：${(err as Error).message}${note}` }],
          details: undefined,
        };
      }
    },
  };
}
