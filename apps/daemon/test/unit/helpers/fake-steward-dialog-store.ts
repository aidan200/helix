import type { StewardHistoryRecord } from "@helix/protocol";
import type {
  StewardDialogStorePort,
  StewardDialogStoreSnapshot,
} from "../../../src/application/ports/outbound/StewardDialogStorePort";

/**
 * 行式对话存储 fake（测试面）：语义对齐 SqliteStewardDialogStore（append 触
 * 活跃时间、deleteHead 删最老 n 行、clear 清记录与活跃时间）——供跨
 * 「重启」实例共享（同库语义）或单实例注入。
 */
export function fakeDialogStore(): StewardDialogStorePort & {
  /** 现值镜像（断言面）。 */
  inspect(): StewardDialogStoreSnapshot;
  /** 当前行数（deleteHead/replaceAll 断言面）。 */
  count(): number;
} {
  let rows: { record: StewardHistoryRecord; at: number }[] = [];
  let lastActiveAt = 0;
  const snapshot = (): StewardDialogStoreSnapshot => ({
    records: rows.map((r) => r.record),
    lastActiveAt,
  });
  return {
    append(record, at) {
      rows.push({ record, at });
      lastActiveAt = at;
    },
    deleteHead(count) {
      rows = rows.slice(count);
    },
    replaceAll(records, at) {
      rows = records.map((record) => ({ record, at }));
      lastActiveAt = at;
    },
    loadRecent() {
      return snapshot();
    },
    clear() {
      rows = [];
      lastActiveAt = 0;
    },
    inspect: snapshot,
    count() {
      return rows.length;
    },
  };
}
