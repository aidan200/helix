/**
 * SqliteStewardDialogStore 真库单测（管家记忆 B6 消息落盘批——better-sqlite3
 * ":memory:" 零磁盘；损坏行用例经临时文件库直插脏 payload）。
 *
 * 断言面：
 * 1. append + loadRecent：记录全形态往返（payload = 协议记录 JSON 原文）、
 *    活跃时间随写刷新；
 * 2. deleteHead：删最老 n 行（保序）；
 * 3. replaceAll：整窗替换单事务（压缩/迁移路径）；
 * 4. clear：记录与活跃时间全清；
 * 5. 损坏行防御：脏 payload 跳过不抛（可用性优先——毒行不毒窗口）；
 * 6. migrateStewardDialogKv：A1 KV 整包拆行导入（遗留 lastJudgedAt 字段
 *    随沉淀管线退役忽略不炸）+ 旧键墓碑幂等。
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { SqliteStewardDialogStore, migrateStewardDialogKv } from "../../src/adapters/driven/steward-memory/SqliteStewardDialogStore";
import type { RuntimeConfigPort } from "../../src/application/ports/outbound/RuntimeConfigPort";
import type { StewardHistoryRecord } from "@helix/protocol";

// TR-152：tmpdir 登记回收（CI 单 job 串行泄漏链防御）
const tmpDirs: string[] = [];
afterAll(() => {
  for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });
});

function makeStore(): SqliteStewardDialogStore {
  return new SqliteStewardDialogStore(":memory:");
}

const R_USER: StewardHistoryRecord = { kind: "user", text: "以后回复要简洁", at: 1000 };
const R_ASST: StewardHistoryRecord = { kind: "assistant", text: "好的", at: 1001 };

/** A1 旧 KV fake（get/set 内存面——迁移读面）。 */
function fakeKv(seed: Record<string, string> = {}): RuntimeConfigPort & { kv: Map<string, string> } {
  const kv = new Map<string, string>(Object.entries(seed));
  return {
    kv,
    get: (key: string) => kv.get(key),
    set: async (key: string, value: string) => {
      kv.set(key, value);
    },
  } as RuntimeConfigPort & { kv: Map<string, string> };
}

describe("SqliteStewardDialogStore（真库）", () => {
  test("① append + loadRecent 全形态往返 + 活跃时间随写刷新", () => {
    const store = makeStore();
    const empty = store.loadRecent();
    expect(empty.records).toEqual([]);
    expect(empty.lastActiveAt).toBe(0);
    store.append(R_USER, 1000);
    store.append({ kind: "assistant", text: "答", thinking: { text: "想", signature: "sig" }, toolCall: { id: "c1", name: "t", args: { a: 1 } }, at: 1002 }, 1002);
    store.append({ kind: "toolResult", toolCallId: "c1", name: "t", text: "r", at: 1003 }, 1003);
    const snap = store.loadRecent();
    expect(snap.records).toHaveLength(3);
    expect(snap.records[0]).toEqual(R_USER);
    expect(snap.records[1]!.kind).toBe("assistant");
    expect((snap.records[1] as { toolCall?: { id: string } }).toolCall?.id).toBe("c1"); // payload 原文往返
    expect(snap.records[2]!.kind).toBe("toolResult");
    expect(snap.lastActiveAt).toBe(1003);
    store.close();
  });

  test("② deleteHead 删最老 n 行（保序）", () => {
    const store = makeStore();
    store.append(R_USER, 1000);
    store.append(R_ASST, 1001);
    store.append({ kind: "user", text: "三", at: 1002 }, 1002);
    store.deleteHead(2);
    const snap = store.loadRecent();
    expect(snap.records).toHaveLength(1);
    expect(snap.records[0]!.kind).toBe("user");
    expect((snap.records[0] as { text?: string }).text).toBe("三");
    store.close();
  });

  test("③ replaceAll 整窗替换（压缩/迁移路径）", () => {
    const store = makeStore();
    store.append(R_USER, 1000);
    store.replaceAll([R_ASST, R_USER], 2000);
    const snap = store.loadRecent();
    expect(snap.records.map((r) => r.kind)).toEqual(["assistant", "user"]);
    expect(snap.lastActiveAt).toBe(2000);
    store.close();
  });

  test("④ clear 全清（记录与活跃时间）", () => {
    const store = makeStore();
    store.append(R_USER, 1000);
    store.clear();
    const snap = store.loadRecent();
    expect(snap.records).toEqual([]);
    expect(snap.lastActiveAt).toBe(0);
    store.close();
  });

  test("⑤ 损坏行防御：脏 payload 跳过不抛（毒行不毒窗口）", () => {
    const dir = mkdtempSync(join(tmpdir(), "helix-dialog-store-"));
    tmpDirs.push(dir);
    const dbPath = join(dir, "steward_dialog.db");
    const store = new SqliteStewardDialogStore(dbPath);
    store.append(R_USER, 1000);
    store.append({ kind: "user", text: "好行", at: 1001 }, 1001);
    store.close();
    // 直插脏行（模拟半写/位腐——绕过 append 的 JSON 保证）
    const raw = new Database(dbPath);
    raw.prepare("INSERT INTO steward_messages(kind, payload, at) VALUES (?, ?, ?)").run("user", "{not-json", 1002);
    raw.prepare("INSERT INTO steward_messages(kind, payload, at) VALUES (?, ?, ?)").run("user", "{}", 1003); // 缺 kind
    raw.close();
    const reopened = new SqliteStewardDialogStore(dbPath);
    const snap = reopened.loadRecent();
    expect(snap.records).toHaveLength(2); // 两脏行跳过，好行全保
    expect((snap.records[1] as { text?: string }).text).toBe("好行");
    reopened.close();
  });

  test("⑥ migrateStewardDialogKv：整包拆行导入（遗留水位字段忽略）+ 墓碑幂等", () => {
    const store = makeStore();
    const existing = JSON.stringify({
      records: [R_USER, R_ASST],
      lastActiveAt: 2001,
      lastJudgedAt: 1500, // 遗留字段（沉淀管线退役）——忽略不炸
    });
    const kv = fakeKv({ steward_dialog: existing });
    expect(migrateStewardDialogKv(store, kv)).toBe(true);
    const snap = store.loadRecent();
    expect(snap.records).toHaveLength(2);
    expect(snap.lastActiveAt).toBe(2001);
    expect(kv.kv.get("steward_dialog")).toBe(""); // 墓碑
    expect(migrateStewardDialogKv(store, kv)).toBe(false); // 幂等：空键零动作
    // 墓碑后不再重复导入（记录未翻倍）
    expect(store.loadRecent().records).toHaveLength(2);
    store.close();
  });
});
