/**
 * entities/session —— 主消息流 entries 投影工具（C2 拆分共享面，T1.1）。
 *
 * chat 消费者（chat/steer/tool 主线定稿）与 thinking·usage 消费者
 * （thinking/compaction 主线定稿）共用的 upsert 语义，自原 session-reducer.ts
 * 语义不变迁出（随所属族共享，故落共享模块）。
 */
import type { EntryDto } from "@helix/protocol";

/** entries 按 id upsert（已存在则原位替换，否则尾部追加；保持到达序）。 */
export function upsertEntry(entries: EntryDto[], entry: EntryDto): EntryDto[] {
  const idx = entries.findIndex((e) => e.id === entry.id);
  if (idx === -1) return [...entries, entry];
  const next = entries.slice();
  next[idx] = entry;
  return next;
}
