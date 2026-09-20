import type { Channel, CommandEnvelope, EntryDto, EventEnvelope } from "../../../src/index";

/**
 * type-surface 守护共用资产（T3.4 自 test/type-surface.test.ts 迁出，语义原样）：
 * ① 类型级断言工具（Equal/Expect/EnvelopeTypeOf/TypeOfChannel，仅编译期）；
 * ② 四个窄化函数（summarizeEvent/dispatchCommand/familyOf/describeEntry）——
 *    每个分支访问该分支 payload 独有字段，窄化失效 → tsc 失败。
 */
// ── 类型级断言工具（仅编译期） ────────────────────────────────
export type Equal<X, Y> =
  (<T>() => T extends X ? 1 : 2) extends <T>() => T extends Y ? 1 : 2
    ? true
    : false;
export type Expect<T extends true> = T;
/** 从信封联合提取全部 type 字面量 */
export type EnvelopeTypeOf<U> = U extends { type: infer T } ? T : never;
/** 通道 C 分族的 type 联合（channel 可选判别字段的 Extract 过滤） */
export type TypeOfChannel<C extends Channel> = Extract<EventEnvelope, { channel?: C }>["type"];


// ── 窄化函数：每个分支访问该分支 payload 独有字段（窄化失效 → tsc 失败） ──
export function summarizeEvent(event: EventEnvelope): string {
  switch (event.type) {
    case "connection.welcome":
      return `welcome:${event.payload.sessionId}:${event.payload.model}:${event.payload.agentState}`;
    case "connection.error":
      return `error:${event.payload.code}:${event.payload.message}`;
    case "session.snapshot":
      return `snapshot:${event.payload.snapshot.sessionId}:${event.payload.snapshot.entries.length}:${event.payload.snapshot.revision}`;
    case "session.list_changed":
      return `list-changed:${event.payload.kind}:${event.payload.sessionId ?? "-"}:${event.payload.session?.runState ?? "-"}`;
    case "chat.stream.delta":
      return `delta:${event.payload.messageId}:${event.payload.delta}`;
    case "chat.turn.started":
      return `turn-start:${event.payload.turnId}`;
    case "chat.turn.completed":
      return `turn-end:${event.payload.turnId}:${event.payload.reason}`;
    case "chat.message.completed":
      return `msg:${event.payload.entry.id}`;
    case "steer.queued":
      return `steer-q:${event.payload.entryId}`;
    case "steer.drained":
      return `steer-d:${event.payload.entryId}`;
    case "tool.call.started":
      return `tool-start:${event.payload.entry.id}`;
    case "tool.call.result":
      return `tool-result:${event.payload.entry.id}`;
    case "agent.state.changed":
      return `state:${event.payload.state}`;
    // ── v0.1 编排生命周期族 ──
    case "agent.spawned":
      return `spawned:${event.payload.agentId}:${event.payload.task}:${event.payload.profileKind}:${event.payload.model ?? "inherit"}`;
    case "agent.queued":
      return `queued:${event.payload.agentId}:${event.payload.position}`;
    case "agent.started":
      return `started:${event.payload.agentId}`;
    case "agent.stalled":
      return `stalled:${event.payload.agentId}:${event.payload.idleMs}`;
    case "agent.completed":
      return `completed:${event.payload.agentId}:${event.payload.closure.status}`;
    case "agent.failed":
      return `failed:${event.payload.agentId}:${event.payload.error}:${event.payload.closure.status}`;
    case "agent.killed":
      return `killed:${event.payload.agentId}:${event.payload.closure.status}`;
    // ── v0.1 通道族 ──
    case "thinking.stream.delta":
      return `think-delta:${event.payload.instanceId}:${event.payload.delta}`;
    case "thinking.completed":
      return `think-done:${event.payload.entry.id}:${event.payload.entry.durationMs}`;
    case "compaction.completed":
      return `compaction:${event.payload.entry.id}:${event.payload.entry.tokensBefore}:${event.payload.entry.tokensAfter}:${event.payload.tailKept ?? "-"}:${event.payload.filesCompacted ?? "-"}`;
    case "usage.recorded":
      return `usage:${event.payload.instanceId}:${event.payload.usage.totalTokens}:${event.payload.source}`;
    case "engine.error":
      return `engine-error:${event.payload.message.slice(0, 20)}`;
    case "error.entry":
      // error entry 批：错误条目原位落时间轴帧（entry 全字段；channel=chat）
      return `error-entry:${event.payload.entry.id}:${event.payload.entry.turnId}:${event.payload.entry.message.slice(0, 20)}`;
    // ── v0.2 model 族 ──
    case "model.changed":
      return `model-changed:${event.payload.sessionId}:${event.payload.model}:${event.payload.previous}:${event.payload.effective}`;
    // ── v0.2 session 族命令结果（T2.2 点对点回执）──
    case "session.list.result":
      return `list-result:${event.payload.sessions.length}:${event.payload.sessions[0]?.sessionId ?? "-"}`;
    case "session.loadHistory.result":
      return `history-result:${event.payload.entries.length}:${event.payload.hasMore}:${event.payload.nextCursor ?? "-"}`;
    // ── v0.2 model/auth 命令结果帧（T2.3-result-frames 微批，契约 C §2.2）──
    case "model.get.result":
      return `model-get-result:${event.payload.model}:${event.payload.isDefault}:${event.payload.defaultModel}`;
    case "model.catalog.result":
      return `model-catalog-result:${event.payload.models.length}:${event.payload.source}`;
    case "model.catalog_refresh.result":
      return `model-catalog-refresh-result:${event.payload.models.length}:${event.payload.source}:${event.payload.degraded.length}`;
    case "model.set_default.result":
      return `model-set-default-result:${event.payload.previous}`;
    case "model.get_default.result":
      return `model-get-default-result:${event.payload.model}`;
    case "config.get_compaction.result":
      return `config-get-compaction-result:${event.payload.reserveTokens}:${event.payload.keepRecentTokens}`;
    case "config.set_compaction.result":
      return `config-set-compaction-result:${event.payload.reserveTokens}:${event.payload.keepRecentTokens}`;
    case "config.get_scheduling.result":
      return `config-get-scheduling-result:${event.payload.maxConcurrent}:${event.payload.maxQueued}`;
    case "config.set_scheduling.result":
      return `config-set-scheduling-result:${event.payload.maxConcurrent}:${event.payload.maxQueued}`;
    case "config.get_port.result":
      return `config-get-port-result:${event.payload.effectivePort}:${event.payload.storedPort}:${event.payload.overriddenByArgv}`;
    case "config.set_port.result":
      return `config-set-port-result:${event.payload.port}`;
    case "config.get_sandbox.result":
      return `config-get-sandbox-result:${event.payload.enabled}`;
    case "config.set_sandbox.result":
      return `config-set-sandbox-result:${event.payload.enabled}`;
    case "auth.list.result":
      return `auth-list-result:${event.payload.providers.length}:${event.payload.providers[0]?.configured ?? "-"}`;
    case "auth.set_key.result":
      return `auth-set-key-result:${event.payload.keyMasked}`;
    case "auth.delete_key.result":
      return "auth-delete-key-result";
    case "auth.verify.result":
      return `auth-verify-result:${event.payload.status}:${event.payload.status === "ok" ? event.payload.latencyMs : event.payload.reason}`;
    // ── v0.4 trace 命令族 + agent 执行上下文面 ──
    case "trace.query.result":
      return `trace-result:${event.payload.events.length}:${event.payload.instances.length}:${event.payload.page.loaded}:${event.payload.page.total}:${event.payload.page.hasMore}`;
    case "agent.instantiated":
      return `instantiated:${event.payload.instanceId}:${event.payload.profileKind}:${event.payload.profileSnapshot.model}:${event.payload.thinkingLevel}`; // v0.11：+ thinkingLevel（thinking 批④）
    case "agent.model.changed":
      return `model-timeline:${event.payload.instanceId}:${event.payload.from}:${event.payload.to}`;
    // ── v0.6 agent.config 族（M6 T3；result 点对点 + changed 广播）──
    case "agent.config.list.result":
      return `agent-config-list-result:${event.payload.profiles.length}:${event.payload.profiles[0]?.profileKind ?? "-"}:${event.payload.profiles[0]?.model ?? "-"}`;
    case "agent.config.changed":
      return `agent-config-changed:${event.payload.profileKind}:${event.payload.resourceType}:${event.payload.name ?? "null"}:${event.payload.enabled}`;
    case "agent.config.set_enabled.result":
      return `agent-config-set-result:${event.payload.status}:${event.payload.status === "skipped" ? event.payload.reason : "-"}`;
    // ── v0.7 web 族（T4 联网状态图标；result 点对点 + changed 广播）──
    case "web.status.result":
      return `web-status-result:${event.payload.state}:${event.payload.tabCount}:${event.payload.tabs.length}`;
    case "web.stop.result":
      return `web-stop-result:${event.payload.status}`;
    case "web.status.changed":
      return `web-status-changed:${event.payload.state}:${event.payload.tabCount}:${event.payload.browser?.label ?? "-"}`;
    // ── v0.9 web.start 结果帧（T7 CDP 显式启动通路；点对点）──
    case "web.start.result":
      return `web-start-result:${event.payload.status}:${event.payload.status === "skipped" ? event.payload.reason : "-"}`;
    // ── v0.11 thinking 族（thinking 批①；覆盖/生效双位广播）──
    case "thinking.changed":
      return `thinking-changed:${event.payload.override ?? "null"}:${event.payload.effective ?? "null"}`;
    // ── kg 批（iter-20260825-11fo T5.3；六命令点对点回执）──
    case "kg.projects.result":
      return `kg-projects:${event.payload.projects.length}:${event.payload.projects[0]?.status ?? "-"}`;
    case "kg.list.result":
      return `kg-list:${event.payload.total}:${event.payload.matched}:${event.payload.nodes.length}`;
    case "kg.node.detail.result":
      return `kg-detail:${event.payload.kind}:${event.payload.status}:${event.payload.anchors.length}:${event.payload.relations.length}:${event.payload.log.length}`;
    case "kg.change.report.result":
      return `kg-report:${event.payload.iterationId}:${event.payload.entries.length}`;
    case "kg.node.confirm.result":
      return `kg-confirm:${event.payload.node.status}`;
    case "kg.index.status.result":
      return `kg-index:${event.payload.state}`;
    // ── kg-bootstrap 批（iter-20260829-ys7q T3.2；五命令点对点回执，契约 kg-bootstrap-api）──
    case "kg.bootstrap.create.result":
      return `kg-boot-create:${event.payload.jobId}`;
    case "kg.bootstrap.produce.result":
      return `kg-boot-produce:${event.payload.groups.length}`;
    case "kg.node.update.result":
      return `kg-node-update:${event.payload.node.status}`;
    case "kg.node.supersede.result":
      return `kg-node-supersede:${event.payload.ok}`;
    case "kg.bootstrap.impact.result":
      return `kg-boot-impact:${event.payload.count}:${event.payload.affected.length}`;
    // ── kg 维护批（C1；两命令点对点回执）──
    case "kg.graph.purge.result":
      return `kg-purge:${event.payload.nodesRemoved}:${event.payload.symbolsRemoved}`;
    case "kg.index.delete.result":
      return `kg-index-delete:${event.payload.state}:${event.payload.watcherStopped}`;
    // ── kg.health 批（W2-E）+ kg 评审批（W2-F；点对点回执）──
    case "kg.health.result":
      return `kg-health:${event.payload.conflicts.length}:${event.payload.orphanCount}:${event.payload.candidates.pending}`;
    case "kg.review.create.result":
      return `kg-review-create:${event.payload.jobId}`;
    // ── workspace 批（W1 绑定闭环；两结果帧 + 一广播）──
    case "workspace.get.result":
      return `workspace-get:${event.payload.current?.root ?? "unbound"}:${event.payload.recents.length}:${event.payload.notice ?? "-"}`;
    case "workspace.open.result":
      return `workspace-open:${event.payload.root}:${event.payload.projects.length}`;
    case "workspace_changed":
      return `workspace-changed:${event.payload.root}`;
    case "task.changed":
      // task 批（T1.5）：逐迁移轻负载广播（notification 通道；changed 面独立字段访问）
      return `task-changed:${event.payload.jobId}:${event.payload.changed}:${event.payload.status ?? "-"}`;
    case "coord.changed":
      // coord 批（U5）：占用协调轻通知（notification 通道；kind 区分 + text 直渲）
      return `coord-changed:${event.payload.kind}:${event.payload.leaseId}:${event.payload.escalated ? "escalated" : "-"}`;
    case "engine.retrying":
      // 网络重试批（P2 ⑦）：退避等待可见反馈（瞬态；attempt/total/waitMs 语义面）
      return `engine-retrying:${event.payload.attempt}/${event.payload.totalAttempts}:${Math.round(event.payload.waitMs / 1000)}s`;
    // ── park/resume 批（⑤ 挂起恢复原语；agent 族非终态广播帧）──
    case "agent.parked":
      return `agent-parked:${event.payload.agentId}:${event.payload.reason}:${event.payload.parkedAt}`;
    case "agent.resumed":
      return `agent-resumed:${event.payload.agentId}`;
    case "model.set_thinking_default.result":
      return `model-set-thinking-default:${event.payload.previous}`;
    case "kg.candidates.list.result":
      return `kg-candidates-list:${event.payload.total}:${event.payload.rows.length}`;
    case "code.review.create.result":
      return `code-review-create:${event.payload.jobId}`;
    case "agent.base_prompt.get.result":
      return `base-prompt:${event.payload.profileKind}:${event.payload.basePrompt.length}`;
    case "agent.skill_content.get.result":
      return `skill-content:${event.payload.name}:${event.payload.content.length}`;
    case "agent.skill.create.result":
      return `skill-create:${event.payload.status}:${event.payload.name ?? event.payload.reason ?? "-"}`;
    case "session.plan.changed":
      return `plan-changed:${event.payload.sessionId}:${event.payload.plan?.length ?? 0}:${event.payload.ledger?.total ?? 0}`;
    case "diff.changed":
      return `diff-changed:${event.payload.turnId}:${event.payload.phase}:${event.payload.adds}/${event.payload.dels}:${event.payload.fileCount}`;
    case "mcp.servers.list.result":
      return `mcp-servers:${event.payload.servers.length}`;
    case "mcp.servers.add.result":
    case "mcp.servers.update.result":
    case "mcp.servers.remove.result":
      return `mcp-mutation:${event.payload.status}:${event.payload.server?.state ?? "-"}`;
    case "mcp.servers.test.result":
      return `mcp-test:${event.payload.status}:${event.payload.toolCount ?? 0}`;
    case "mcp.tools.list.result":
      return `mcp-tools:${event.payload.server}:${event.payload.tools.length}`;
    case "mcp.status.changed":
      return `mcp-status:${event.payload.server.name}:${event.payload.server.state}`;
    case "stt.transcribe.result":
      // 语音输入批（V1 云转写）：两判别窄化（ok 文本 / error 原因）
      return `stt-result:${event.payload.status}:${event.payload.status === "ok" ? `${event.payload.provider}:${event.payload.text}` : event.payload.reason}`;
    case "stt.stream.started":
      // 流式转写批（V3b-1）：开流回执两判别窄化（ok streamId / error 原因）
      return `stt-stream-started:${event.payload.status}:${event.payload.status === "ok" ? `${event.payload.provider}:${event.payload.streamId}` : event.payload.reason}`;
    case "stt.stream.interim":
      // 流式转写批（V3b-1）：中间帧四字段窄化（streamId/prior/text/stash）
      return `stt-stream-interim:${event.payload.streamId}:${event.payload.prior}:${event.payload.text}:${event.payload.stash}`;
    case "stt.stream.final":
      // 流式转写批（V3b-1）：终帧两判别窄化（ok 全文 / error 原因）
      return `stt-stream-final:${event.payload.status}:${event.payload.streamId}:${event.payload.status === "ok" ? event.payload.text : event.payload.reason}`;
    case "voice.broadcast":
      // 语音播报批（V2 TTS）：广播帧窄化（kind/text/seq）
      return `voice-broadcast:${event.payload.kind}:${event.payload.agentId}:${event.payload.seq}`;
    case "voice.synthesize.result":
      // 语音播报批（V2 TTS）：两判别窄化（ok 音频 / error 原因）
      return `voice-result:${event.payload.status}:${event.payload.status === "ok" ? `${event.payload.provider}:${event.payload.audio.length}` : event.payload.reason}`;
    case "steward.ask.result":
      // 文本管家批（V2.5）：三判别窄化（answer 文本 / confirm_required 确认闸 / error 原因）
      if (event.payload.status === "answer") return `steward-answer:${event.payload.text}`;
      if (event.payload.status === "confirm_required")
        return `steward-confirm-required:${event.payload.actionId}:${event.payload.agentId}:${event.payload.message}`;
      return `steward-error:${event.payload.reason}`;
    case "steward.ask.delta":
      // 管家流式体验批（V2.5）：增量帧窄化（delta 增量 + seq 单调）
      return `steward-ask-delta:${event.payload.delta}:${event.payload.seq}`;
    case "steward.confirm.result":
      // 文本管家批（V2.5）：确认闸回执两判别窄化（ok 含注入回执 detail / error 原因）
      return `steward-confirm-result:${event.payload.status}:${event.payload.status === "ok" ? `${event.payload.agentId}:${event.payload.detail}` : event.payload.reason}`;
    case "steward.feed":
      // 文本管家批（V2.5）：feed 文本行窄化（kind/agentId/seq）
      return `steward-feed:${event.payload.kind}:${event.payload.agentId}:${event.payload.seq}`;
    case "steward.config.result":
      // 文本管家批（V2.5）：设置回执窄化（enabled/model）
      return `steward-config:${event.payload.enabled}:${event.payload.model}`;
    case "steward.history.result":
      // 管家工作记忆批（A1）：回放回执窄化（records 数量 + 首条 kind 面）
      return `steward-history-result:${event.payload.records.length}:${event.payload.records[0]?.kind ?? "-"}`;
    case "steward.tool":
      // 管家工作记忆批（A1）：工具过程两相帧窄化（start 参数摘要 / end 结果摘要）
      return event.payload.phase === "start"
        ? `steward-tool-start:${event.payload.name}:${event.payload.argsSummary}:${event.payload.seq}`
        : `steward-tool-end:${event.payload.name}:${event.payload.resultSummary}:${event.payload.seq}`;
    case "steward.thinking":
      // 管家工作记忆批（A1）：thinking 段级帧窄化（text 全量 + seq）
      return `steward-thinking:${event.payload.text}:${event.payload.seq}`;
    case "steward.navigate":
      // 管家驾驶舱批：页面切换指令帧窄化（sessionId = shell 切页目标）
      return `steward-navigate:${event.payload.sessionId}`;
    case "ask.started":
      return `ask-start:${event.payload.askId}:${event.payload.command}`;
    case "ask.resolved":
      return `ask-resolved:${event.payload.askId}:${event.payload.outcome}`;
    default: {
      const _exhaustive: never = event; // 目录外事件 → 编译失败（穷尽性守护）
      return `unhandled:${String(_exhaustive)}`;
    }
  }
}

export function dispatchCommand(cmd: CommandEnvelope): string {
  switch (cmd.type) {
    case "chat.send":
      return `send:${cmd.payload.text}`;
    case "chat.steer":
      return `steer:${cmd.payload.text}:${cmd.payload.instanceId ?? "main"}`; // v0.3：可选定向（缺省 = 主实例）
    case "chat.abort":
      return "abort";
    case "ask.answer":
      return `ask-answer:${cmd.payload.askId}:${cmd.payload.approved}`;
    case "session.subscribe":
      return `subscribe:${cmd.sessionId ?? "-"}:${cmd.payload.tier ?? "full"}`; // v0.2 信封路由 + v0.3 tier（缺省 full）
    case "session.unsubscribe":
      return "unsubscribe";
    // ── v0.1 编排命令 ──
    case "agent.kill":
      return `kill:${cmd.payload.agentId}`;
    case "agent.subscribe":
      return `agent-sub:${cmd.payload.agentId}`;
    case "agent.unsubscribe":
      return `agent-unsub:${cmd.payload.agentId}`;
    // ── v0.2 session 族 ──
    case "session.list":
      return `session-list`;
    case "session.loadHistory":
      return `load-history:${cmd.sessionId ?? "-"}:${cmd.payload.beforeEntryId}:${cmd.payload.limit ?? 50}`;
    case "session.delete":
      return `session-delete:${cmd.sessionId ?? "-"}`;
    // ── v0.2 model 族 ──
    case "model.set":
      return `model-set:${cmd.sessionId ?? "-"}:${cmd.payload.model}`;
    case "model.get":
      return `model-get:${cmd.sessionId ?? "-"}`;
    case "model.catalog":
      return "model-catalog";
    case "model.catalog_refresh":
      return "model-catalog-refresh";
    case "model.set_default":
      return `model-set-default:${cmd.payload.model}`;
    case "model.get_default":
      return "model-get-default";
    // ── config 族（压缩参数/调度预算/端口配置；全局命令）──
    case "config.set_compaction":
      return `config-set-compaction:${cmd.payload.reserveTokens}:${cmd.payload.keepRecentTokens}`;
    case "config.get_compaction":
      return "config-get-compaction";
    case "config.set_scheduling":
      return `config-set-scheduling:${cmd.payload.maxConcurrent}:${cmd.payload.maxQueued}`;
    case "config.get_scheduling":
      return "config-get-scheduling";
    case "config.set_port":
      return `config-set-port:${cmd.payload.port}`;
    case "config.get_port":
      return "config-get-port";
    case "config.set_sandbox":
      return `config-set-sandbox:${cmd.payload.enabled}`;
    case "config.get_sandbox":
      return "config-get-sandbox";
    // ── v0.2 auth 族 ──
    case "auth.list":
      return "auth-list";
    case "auth.set_key":
      return `auth-set-key:${cmd.payload.providerId}`;
    case "auth.delete_key":
      return `auth-delete-key:${cmd.payload.providerId}`;
    case "auth.verify":
      return `auth-verify:${cmd.payload.providerId}`;
    // ── v0.4 trace 族 ──
    case "trace.query":
      return `trace-query:${cmd.payload.sessionId}:${cmd.payload.instanceIds?.length ?? "all"}:${cmd.payload.page?.limit ?? 50}:${cmd.payload.page?.beforeId ?? "-"}`;
    // ── v0.6 agent.config 族（M6 T3 智能体配置页）──
    case "agent.config.list":
      return `agent-config-list:${cmd.payload.profileKind ?? "all"}`;
    case "agent.config.set_enabled":
      return `agent-config-set:${cmd.payload.profileKind}:${cmd.payload.resourceType}:${cmd.payload.name}:${cmd.payload.enabled}`;
    // ── v0.7 web 族（T4 联网状态图标）──
    case "web.status":
      return "web-status";
    case "web.stop":
      return "web-stop";
    // ── v0.9 web 族（T7 CDP 显式启动通路）──
    case "web.start":
      return "web-start";
    // ── v0.11 thinking 族（thinking 批①；per-session 覆盖写面）──
    case "thinking.set":
      return `thinking-set:${cmd.sessionId ?? "-"}:${cmd.payload.level}`;
    // ── kg 批（iter-20260825-11fo T5.3；P-1 数据面六命令）──
    case "kg.list":
      return `kg-list:${cmd.payload.project}:${cmd.payload.kind ?? "-"}:${cmd.payload.status ?? "-"}:${cmd.payload.q ?? "-"}`;
    case "kg.node.detail":
      return `kg-detail:${cmd.payload.project}:${cmd.payload.id}`;
    case "kg.change.report":
      return `kg-report:${cmd.payload.project}:${cmd.payload.iterationId ?? "current"}`;
    case "kg.node.confirm":
      return `kg-confirm:${cmd.payload.project}:${cmd.payload.id}`;
    case "kg.index.status":
      return `kg-index:${cmd.payload.project}:${cmd.payload.rebuild === true ? "rebuild" : "status"}`;
    case "kg.projects":
      return "kg-projects";
    // ── kg-bootstrap 批（iter-20260829-ys7q T3.2；五命令载荷独立字段访问——窄化守护）──
    case "kg.bootstrap.create":
      return `kg-boot-create:${cmd.payload.project}:${cmd.payload.scope ?? "-"}`;
    case "kg.bootstrap.produce":
      return `kg-boot-produce:${cmd.payload.project}`;
    case "kg.node.update":
      return `kg-node-update:${cmd.payload.project}:${cmd.payload.nodeId}:${cmd.payload.digest ? "digest" : "-"}:${cmd.payload.body ? "body" : "-"}`;
    case "kg.node.supersede":
      return `kg-node-supersede:${cmd.payload.project}:${cmd.payload.nodeId}:${cmd.payload.reason}`;
    case "kg.bootstrap.impact":
      return `kg-boot-impact:${cmd.payload.project}:${cmd.payload.nodeId}`;
    // ── kg 维护批（C1；清空图谱 + 删除索引）──
    case "kg.graph.purge":
      return `kg-purge:${cmd.payload.project}`;
    case "kg.index.delete":
      return `kg-index-delete:${cmd.payload.project}`;
    // ── kg.health 批（W2-E）+ kg 评审批（W2-F）──
    case "kg.health":
      return `kg-health:${cmd.payload.project}`;
    case "kg.review.create":
      return `kg-review-create:${cmd.payload.project}`;
    case "code.review.create":
      return `code-review-create:${cmd.payload.project}`;
    // ── workspace 批（W1 绑定闭环；门禁读面 + 显式绑定写面）──
    case "workspace.get":
      return "workspace-get";
    case "workspace.open":
      return `workspace-open:${cmd.payload.root}`;
    case "task.list":
      // task 批（T1.5）：九命令载荷独立字段访问（窄化守护）+ task.retry 批第十命令
      return `task-list:${cmd.payload.status ?? "-"}:${cmd.payload.project ?? "-"}`;
    case "task.detail":
    case "task.artifacts":
    case "task.pause":
    case "task.resume":
    case "task.cancel":
    case "task.retry":
    case "task.delete":
      return `task-${cmd.type.split(".")[1]}:${cmd.payload.jobId}`;
    case "task.subscribe":
    case "task.unsubscribe":
      return `task-${cmd.type.split(".")[1]}:${cmd.payload.jobId ?? "*"}`;
    case "model.set_thinking_default":
      return `model-set-thinking-default:${String(cmd.payload.level)}`;
    case "kg.candidates.list":
      return `kg-candidates-list:${cmd.payload.project}:${cmd.payload.status ?? "*"}`;
    case "agent.base_prompt.get":
      return `base-prompt-get:${cmd.payload.profileKind}`;
    case "agent.skill_content.get":
      return `skill-content-get:${cmd.payload.name}`;
    case "agent.skill.create":
      return `skill-create:${cmd.payload.content.length}`;
    case "diff.get":
      return `diff-get:${cmd.sessionId ?? "-"}:${cmd.payload.turnId ?? "latest"}:${cmd.payload.live ? "live" : "frozen"}`;
    case "mcp.servers.list":
      return `mcp-servers-list`;
    case "mcp.servers.add":
    case "mcp.servers.update":
    case "mcp.servers.test":
      return `mcp-server-input:${cmd.payload.name}:${cmd.payload.command}`;
    case "mcp.servers.remove":
      return `mcp-servers-remove:${cmd.payload.name}`;
    case "mcp.tools.list":
      return `mcp-tools-list:${cmd.payload.server}`;
    case "stt.transcribe":
      // 语音输入批（V1 云转写）：音频 data URL 载荷窄化守护
      return `stt-transcribe:${cmd.payload.audio.slice(0, 8)}:${cmd.payload.durationMs ?? "-"}:${cmd.payload.language ?? "auto"}`;
    case "stt.stream.start":
      // 流式转写批（V3b-1）：开流命令窄化（language/provider 可选位）
      return `stt-stream-start:${cmd.payload.language ?? "auto"}:${cmd.payload.provider ?? "auto"}`;
    case "stt.stream.chunk":
      // 流式转写批（V3b-1）：音频块命令窄化（base64 PCM 载荷）
      return `stt-stream-chunk:${cmd.payload.audio.slice(0, 5)}`;
    case "stt.stream.finish":
      return "stt-stream-finish";
    case "stt.stream.stop":
      return "stt-stream-stop";
    case "voice.synthesize":
      // 语音播报批（V2 TTS）：试听合成命令窄化（text/voice）
      return `voice-synthesize:${cmd.payload.text}:${cmd.payload.voice ?? "-"}`;
    case "voice.subscribe":
      return `voice-subscribe:${cmd.payload.voice ?? "-"}`;
    case "voice.unsubscribe":
      return "voice-unsubscribe";
    case "steward.ask":
      // 文本管家批（V2.5）：对话命令窄化（text）
      return `steward-ask:${cmd.payload.text}`;
    case "steward.confirm":
      return `steward-confirm:${cmd.payload.actionId}`;
    case "steward.subscribe":
      return "steward-subscribe";
    case "steward.unsubscribe":
      return "steward-unsubscribe";
    case "steward.get_config":
      return "steward-get_config";
    case "steward.set_config":
      return `steward-set_config:${String(cmd.payload.enabled)}:${cmd.payload.model ?? "-"}`;
    case "steward.history":
      // 管家工作记忆批（A1）：读/清同命令（clear 缺省 = 回放）
      return `steward-history:${String(cmd.payload.clear ?? false)}`;
    default: {
      const _exhaustive: never = cmd;
      return `unhandled:${String(_exhaustive)}`;
    }
  }
}

/**
 * v0.2 八族类型学判别窄化（契约 A §2 机械判据）：switch(channel) 各分支内
 * type 联合窄化到本族（分支内以 TypeOfChannel<C> 收窄赋值证明——宽化即 tsc 失败）。
 */
export function familyOf(event: EventEnvelope): string {
  switch (event.channel) {
    case "chat": {
      const t: TypeOfChannel<"chat"> = event.type;
      return `chat/${t}`;
    }
    case "agent": {
      const t: TypeOfChannel<"agent"> = event.type;
      return `agent/${t}`;
    }
    case "thinking": {
      const t: TypeOfChannel<"thinking"> = event.type;
      return `thinking/${t}`;
    }
    case "usage": {
      const t: TypeOfChannel<"usage"> = event.type;
      return `usage/${t}`;
    }
    case "compaction": {
      const t: TypeOfChannel<"compaction"> = event.type;
      return `compaction/${t}`;
    }
    case "session": {
      const t: TypeOfChannel<"session"> = event.type;
      return `session/${t}`;
    }
    case "model": {
      const t: TypeOfChannel<"model"> = event.type;
      return `model/${t}`;
    }
    case "trace": {
      const t: TypeOfChannel<"trace"> = event.type;
      return `trace/${t}`;
    }
    case "web": {
      const t: TypeOfChannel<"web"> = event.type;
      return `web/${t}`;
    }
    // interaction 占位族无事件挂靠（_InteractionFamily = never 类型断言守护）：
    // 事件联合中无成员声明 channel: "interaction"，本分支不可达、无需 case。
    case "notification": {
      const t: TypeOfChannel<"notification"> = event.type;
      return `notification/${t}`;
    }
    case "mcp": {
      const t: TypeOfChannel<"mcp"> = event.type;
      return `mcp/${t}`;
    }
    case "stt": {
      // 语音输入批（V1 云转写）：stt 新族窄化（点对点结果帧）
      const t: TypeOfChannel<"stt"> = event.type;
      return `stt/${t}`;
    }
    case "voice": {
      // 语音播报批（V2 TTS）：voice 新族窄化（广播帧 + 点对点结果帧）
      const t: TypeOfChannel<"voice"> = event.type;
      return `voice/${t}`;
    }
    case "steward": {
      // 文本管家批（V2.5）：steward 新族窄化（对话/确认回执 + feed 广播 + 设置回执）
      const t: TypeOfChannel<"steward"> = event.type;
      return `steward/${t}`;
    }
    default:
      // channel 缺省 = v0/v0.1 历史帧（信封兼容读；按 type 走既有消费路径）
      return `legacy/${event.type}`;
  }
}

export function describeEntry(entry: EntryDto): string {
  switch (entry.kind) {
    case "message":
      return `msg:${entry.role}:${entry.content}${entry.steerState ? `:${entry.steerState}` : ""}`;
    case "tool-call":
      return `tool:${entry.name}:${entry.state}${entry.durationMs ? `:${entry.durationMs}ms` : ""}`;
    case "thinking":
      return `thinking:${entry.instanceId}:${entry.durationMs}`;
    case "compaction":
      return `compaction:${entry.instanceId}:${entry.tokensBefore}:${entry.tokensAfter}:${entry.usage.cost}`;
    case "error":
      return `error:${entry.instanceId}:${entry.turnId}:${entry.message}`;
  }
}
