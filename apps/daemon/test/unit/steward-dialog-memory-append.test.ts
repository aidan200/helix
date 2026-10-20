/**
 * StewardDialogMemory.append 镜像/store 一致性单测（评审 low #11）。
 *
 * 缺陷面：append 先裁剪镜像再单写落盘——新条目自身被裁（budget 恰清空旧窗
 * 使新 toolResult 成窗口头孤儿 → dropHeadOrphanToolResults 连带弃它）时，
 * 镜像弃了却仍 store.append 单写：重载后孤儿回流直达 provider 400，
 * 且 deleteHead 计数把「没入过库的新行」也算进已落盘行（过删一行）。
 *
 * 断言面：①新条目被裁 → store 零 append、deleteHead 只删旧行数；
 * ②新条目存活 → 镜像与 store 同形（分叉回归面）。
 */
import { describe, expect, test } from "bun:test";
import type { StewardHistoryRecord } from "@helix/protocol";
import { StewardDialogMemory } from "../../src/application/steward/StewardDialogMemory";
import { fakeDialogStore } from "./helpers/fake-steward-dialog-store";

const user = (text: string): StewardHistoryRecord => ({ kind: "user", text, at: 1 });
const toolResult = (id: string): StewardHistoryRecord => ({ kind: "toolResult", toolCallId: id, name: "list_tasks", text: "结果", at: 2 });

describe("StewardDialogMemory.append：新条目被裁时不得单写落盘（镜像/store 不分叉）", () => {
  test("budget 恰清空旧窗使新 toolResult 成孤儿 → 镜像弃它、store 零 append、deleteHead 只删旧行", async () => {
    const store = fakeDialogStore();
    // budget=1：任何记录都超预算 → 窗口恒只剩末条，孤儿判定随即清空
    const dialog = new StewardDialogMemory(store, { budgetTokens: 1 });
    await dialog.append(user("第一条"));
    expect(dialog.snapshot().length).toBe(1);
    expect(store.count()).toBe(1);

    // 无配对 toolCall 的 toolResult：窗口末条即孤儿 → 整个窗口清空
    await dialog.append(toolResult("call-orphan"));
    expect(dialog.snapshot().length).toBe(0);
    // 落盘同步：旧行删掉、新行不写（否则重载回流孤儿）
    expect(store.count()).toBe(0);
    expect(store.inspect().records.length).toBe(0);
  });

  test("配对完整的 toolCall+toolResult 正常落盘（存活分支不受影响）", async () => {
    const store = fakeDialogStore();
    const dialog = new StewardDialogMemory(store, { budgetTokens: 10_000 });
    await dialog.append({ kind: "assistant", toolCall: { id: "call-1", name: "list_tasks", args: {} }, at: 1 });
    await dialog.append(toolResult("call-1"));
    expect(dialog.snapshot().length).toBe(2);
    expect(store.count()).toBe(2);
    expect(store.inspect().records[1]?.kind).toBe("toolResult");
  });
});
