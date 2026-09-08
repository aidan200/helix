/** 命令信封联合与命令目录常量（双向一致由 catalog.test.ts 机械守护）。 */
import type { CommandFrame } from "../envelope";
import type {
  ChatSendCommand,
  ChatSteerCommand,
  ChatAbortCommand,
  SessionSubscribeCommand,
  SessionUnsubscribeCommand,
  AgentKillCommand,
  AgentSubscribeCommand,
  AgentUnsubscribeCommand,
  SessionListCommand,
  SessionLoadHistoryCommand,
  SessionDeleteCommand,
} from "./session";
import type {
  ModelSetCommand,
  ModelGetCommand,
  ModelCatalogCommand,
  ModelCatalogRefreshCommand,
  ModelSetDefaultCommand,
  ModelSetThinkingDefaultCommand,
  ModelGetDefaultCommand,
  ConfigSetCompactionCommand,
  ConfigGetCompactionCommand,
  ConfigSetSchedulingCommand,
  ConfigGetSchedulingCommand,
  ConfigSetPortCommand,
  ConfigGetPortCommand,
  AuthListCommand,
  AuthSetKeyCommand,
  AuthDeleteKeyCommand,
  AuthVerifyCommand,
  ThinkingSetCommand,
} from "./model-config";
import type {
  TraceQueryCommand,
  AgentConfigListCommand,
  AgentConfigSetEnabledCommand,
  AgentBasePromptGetCommand,
  AgentSkillContentGetCommand,
  AgentSkillCreateCommand,
  WebStatusCommand,
  WebStopCommand,
  WebStartCommand,
} from "./resource";
import type {
  KgProjectsCommand,
  KgListCommand,
  KgNodeDetailCommand,
  KgChangeReportCommand,
  KgNodeConfirmCommand,
  KgIndexStatusCommand,
  KgBootstrapCreateCommand,
  KgBootstrapProduceCommand,
  KgNodeUpdateCommand,
  KgNodeSupersedeCommand,
  KgBootstrapImpactCommand,
  KgGraphPurgeCommand,
  KgIndexDeleteCommand,
  KgHealthCommand,
  KgCandidatesListCommand,
  KgReviewCreateCommand,
  CodeReviewCreateCommand,
} from "./kg";
import type {
  WorkspaceGetCommand,
  WorkspaceOpenCommand,
  TaskListCommand,
  TaskDetailCommand,
  TaskArtifactsCommand,
  TaskSubscribeCommand,
  TaskUnsubscribeCommand,
  TaskPauseCommand,
  TaskResumeCommand,
  TaskCancelCommand,
  TaskRetryCommand,
  TaskDeleteCommand,
  DiffGetCommand,
} from "./task";
import type {
  McpServersListCommand,
  McpServersAddCommand,
  McpServersUpdateCommand,
  McpServersRemoveCommand,
  McpServersTestCommand,
  McpToolsListCommand,
} from "./mcp";

export type CommandEnvelope =
  | ChatSendCommand
  | ChatSteerCommand
  | ChatAbortCommand
  | SessionSubscribeCommand
  | SessionUnsubscribeCommand
  | AgentKillCommand
  | AgentSubscribeCommand
  | AgentUnsubscribeCommand
  | SessionListCommand
  | SessionLoadHistoryCommand
  | SessionDeleteCommand
  | ModelSetCommand
  | ModelGetCommand
  | ModelCatalogCommand
  | ModelCatalogRefreshCommand
  | ModelSetDefaultCommand
  | ModelSetThinkingDefaultCommand
  | ModelGetDefaultCommand
  | ConfigSetCompactionCommand
  | ConfigGetCompactionCommand
  | ConfigSetSchedulingCommand
  | ConfigGetSchedulingCommand
  | ConfigSetPortCommand
  | ConfigGetPortCommand
  | AuthListCommand
  | AuthSetKeyCommand
  | AuthDeleteKeyCommand
  | AuthVerifyCommand
  | TraceQueryCommand
  | AgentConfigListCommand
  | AgentConfigSetEnabledCommand
  | AgentBasePromptGetCommand
  | AgentSkillContentGetCommand
  | AgentSkillCreateCommand
  | WebStatusCommand
  | WebStopCommand
  | WebStartCommand
  | ThinkingSetCommand
  | KgListCommand
  | KgNodeDetailCommand
  | KgChangeReportCommand
  | KgNodeConfirmCommand
  | KgIndexStatusCommand
  | KgProjectsCommand
  | KgBootstrapCreateCommand
  | KgBootstrapProduceCommand
  | KgNodeUpdateCommand
  | KgNodeSupersedeCommand
  | KgBootstrapImpactCommand
  | KgGraphPurgeCommand
  | KgIndexDeleteCommand
  | KgHealthCommand
  | KgReviewCreateCommand
  | CodeReviewCreateCommand
  | KgCandidatesListCommand
  | WorkspaceGetCommand
  | WorkspaceOpenCommand
  | TaskListCommand
  | TaskDetailCommand
  | TaskArtifactsCommand
  | TaskSubscribeCommand
  | TaskUnsubscribeCommand
  | TaskPauseCommand
  | TaskResumeCommand
  | TaskCancelCommand
  | TaskRetryCommand
  | TaskDeleteCommand
  | DiffGetCommand
  | McpServersListCommand
  | McpServersAddCommand
  | McpServersUpdateCommand
  | McpServersRemoveCommand
  | McpServersTestCommand
  | McpToolsListCommand;

/** 命令目录常量（运行时可用；与 CommandEnvelope 联合由测试双向一致性守护） */
export const COMMAND_TYPES = [
  "chat.send",
  "chat.steer",
  "chat.abort",
  "session.subscribe",
  "session.unsubscribe",
  "agent.kill",
  "agent.subscribe",
  "agent.unsubscribe",
  "session.list",
  "session.loadHistory",
  "session.delete",
  "model.set",
  "model.get",
  "model.catalog",
  "model.catalog_refresh",
  "model.set_default",
  "model.set_thinking_default",
  "model.get_default",
  "config.set_compaction",
  "config.get_compaction",
  "config.set_scheduling",
  "config.get_scheduling",
  "config.set_port",
  "config.get_port",
  "auth.list",
  "auth.set_key",
  "auth.delete_key",
  "auth.verify",
  "trace.query",
  "agent.config.list",
  "agent.config.set_enabled",
  "agent.base_prompt.get",
  "agent.skill_content.get",
  "agent.skill.create",
  "web.status",
  "web.stop",
  "web.start",
  "thinking.set",
  "kg.list",
  "kg.node.detail",
  "kg.change.report",
  "kg.node.confirm",
  "kg.index.status",
  "kg.projects",
  "kg.bootstrap.create",
  "kg.bootstrap.produce",
  "kg.node.update",
  "kg.node.supersede",
  "kg.bootstrap.impact",
  "kg.graph.purge",
  "kg.index.delete",
  "kg.health",
  "kg.review.create",
  "code.review.create",
  "kg.candidates.list",
  "workspace.get",
  "workspace.open",
  "task.list",
  "task.detail",
  "task.artifacts",
  "task.subscribe",
  "task.unsubscribe",
  "task.pause",
  "task.resume",
  "task.cancel",
  "task.retry",
  "task.delete",
  "diff.get",
  "mcp.servers.list",
  "mcp.servers.add",
  "mcp.servers.update",
  "mcp.servers.remove",
  "mcp.servers.test",
  "mcp.tools.list",
] as const;

export type CommandType = (typeof COMMAND_TYPES)[number];
