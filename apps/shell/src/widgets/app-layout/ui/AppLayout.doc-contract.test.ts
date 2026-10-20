/**
 * AppLayout 消费面注释守卫（TR-285：注释口径漂移用源码定式断言钉住）。
 *
 * 背景（code-review 低危）：头注长期写「chat 页用法见 …；trace/settings 等页
 * 由后续任务迁入」「本次仅 chat 使用」——迁移早已完成（trace/settings/tasks/
 * project/agents/steward 两页全部消费本壳），旧注释误导新人判断分层现状。
 * 钉法：新口径（消费面清单 + 「迁移批完成」）在场 + 旧措辞禁回潮。
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const src = readFileSync(fileURLToPath(new URL("./AppLayout.tsx", import.meta.url)), "utf8");

describe("AppLayout 注释口径（消费面已全量迁入）", () => {
  it("新口径在场：消费面清单 + 迁移批完成", () => {
    expect(src).toContain("消费面：");
    expect(src).toContain("S1–S3b 迁移批完成");
  });

  it("旧口径禁回潮（「后续任务迁入」/「本次仅 chat 使用」；分片拼接防自指）", () => {
    const banned = ["由后续" + "任务迁入", "本次仅" + " chat 使用"];
    for (const b of banned) expect(src).not.toContain(b);
  });
});
