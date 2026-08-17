/**
 * T4.2 —— CL-3 模型真链路（真 daemon，E 层）：set_model 下一 turn 生效
 * （FakeLLM 记录每 turn model：in-flight 旧值 / 下一 turn 新值）+ 新会话
 * 继承默认 + auth.json 写入面（0600/格式，tmp home）+ ModelCatalog builtin
 * fallback 无外网合并行为断言（test-design K-1）。
 *
 * 填充中（T4.2 增量交付：本文件骨架先行落位，剧本随后逐段补齐）。
 */
import { test } from "./harness/daemon-fixture";

test.describe("T4.2 CL-3 模型真链路（骨架）", () => {
  // 剧本填充中
});
