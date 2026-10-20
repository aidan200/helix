import type { SessionRegistry } from "../../application/services/SessionRegistry";
import { lastMainAnchorId, type AnchorScanEntry } from "@helix/protocol";
import { isMainInstanceId } from "../../domain/agent/AgentInstance";

/**
 * typed 回填面装配片：spawn 锚计算 + 会话主实例 id 读面（P5 体量门拆分，
 * 自组合根 container.ts 原样迁出）。组合根的一部分（AG-02④ 豁免面
 * infrastructure/assembly/**）。
 *
 * 契约（AssemblyBackfill §4.2.5，见 buildSessionStack）：两字段闭合先于
 * registry.initialize，两步间无任何回调触发点；registry 就绪前未定义 =
 * 消费方 ?.() 降级（冷会话理论不可达——spawn 必经热会话门面，防御 null 流首）。
 * 装配序：位于 wireEventFanout 之后、registry.initialize 之前。
 */

/**
 * spawn 时刻锚计算（契约 v0.3 §1 规则②）：扫描面与快照路径同源
 * （SnapshotMapper.toSnapshotDto merged 段同语义）：domain entries + toolCall
 * 记录按时间升序合并后扫——tool 执行不落 domain Entry（独立 toolCalls 集合），
 * 只扫 entries 会把锚落在 agent_spawn 工具调用之前（实时卡片位置 bug）。
 * lastMainAnchorId 只用数组序不掺 ts 排序——合并后须先排好再扫；并列稳定
 * （entries 组内原序在前，与快照路径 .sort 稳定语义一致）。
 */
export function computeSpawnAnchorOf(registry: SessionRegistry): (sessionId: string) => string | null {
  return (sessionId: string) => {
    const runtime = registry.peek(sessionId);
    if (runtime === undefined) return null;
    const mainId = runtime.chatService.sessionView.mainInstanceId;
    // kind 判别归一（T10a）：锚扫描基元（projection 单源）的 "main 归属" 判定
    // 按缺省=main 语义工作——主实例归属条目（会话主 id / legacy "main"）
    // 归一为缺省后扫描，语义与快照路径（DTO 省略编码）一致
    const anchorOf = (list: readonly AnchorScanEntry[]): string | null =>
      lastMainAnchorId(
        list.map((e) => ({ ...e, instanceId: isMainInstanceId(e.instanceId, mainId) ? undefined : e.instanceId })),
      );
    const entries = runtime.chatService.sessionView.toSnapshot().entries;
    const toolCalls = runtime.chatService.toolCallData;
    // 无 tool 调用记录：防御路径与旧语义一致（聚合 entries 数组序直扫）
    if (toolCalls.length === 0) return anchorOf(entries);
    const merged: AnchorScanEntry[] = [
      ...entries.map((entry) => ({ key: Date.parse(entry.createdAt), entry: entry as AnchorScanEntry })),
      ...toolCalls.map((record) => ({
        // toolCallEntryDto 同源 ts 口径：startedAt → endedAt → 0
        key:
          record.startedAt !== undefined
            ? Date.parse(record.startedAt)
            : record.endedAt !== undefined
              ? Date.parse(record.endedAt)
              : 0,
        // id = toolCallId（toolCallEntryDto 同）；instanceId 缺省 = main 天然是锚候选
        entry: { id: record.id, instanceId: record.instanceId } satisfies AnchorScanEntry,
      })),
    ]
      .sort((a, b) => a.key - b.key)
      .map((item) => item.entry);
    return anchorOf(merged);
  };
}

/**
 * T10a kind 判别读面闭合：EventStream（engine.error 抑制/条目归属编码）查会话
 * 主实例 id；冷会话理论不可达（事件只自热运行时发布——registry 未持有该会话）。
 */
export function mainInstanceIdForOf(registry: SessionRegistry): (sessionId: string) => string | undefined {
  return (sessionId: string) => registry.peek(sessionId)?.chatService.sessionView.mainInstanceId;
}
