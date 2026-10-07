/**
 * StewardDiagnosisAdapter 单测（管家感知批 M0.5：分诊器 driven 面）。
 *
 * 断言面：
 * 1. gate 三条件：enabled 闭包（管家开∧总结开）+ 模型槽位非空——任一断点
 *    isAvailable=false（零 LLM 降级入口）；
 * 2. 防腐面：prompt → StewardLlmRequest（messages 恰一条 user、tools 空）；
 *    toolCall 响应 throw；
 * 3. JSON 三重容错（parseDiagnosis 纯函数）：```json 围栏剥壳 / 前后噪声
 *    大括号定位 / 字段缺席缺省（notify 缺省 true、urgency 非 high 判
 *    normal、suggestions 项守卫 + 机械上限 3）；
 * 4. 烂输出（非 JSON/双轨全空）→ diagnose throw（感知服务静默降级）。
 */
import { describe, expect, test } from "bun:test";
import type { StewardLlmPort, StewardLlmRequest, StewardLlmResponse } from "../../src/application/ports/outbound/StewardLlmPort";
import { StewardDiagnosisAdapter, parseDiagnosis } from "../../src/adapters/driven/voice/StewardDiagnosisAdapter";

function fakeLlm(opts?: { model?: string; text?: string; toolCall?: boolean }): StewardLlmPort & { calls: StewardLlmRequest[] } {
  const calls: StewardLlmRequest[] = [];
  return {
    modelId: opts?.model ?? "dashscope/qwen-flash",
    calls,
    async complete(req: StewardLlmRequest): Promise<StewardLlmResponse> {
      calls.push(req);
      if (opts?.toolCall === true) {
        return {
          kind: "blocks",
          blocks: [
            { type: "text", text: "…" },
            { type: "toolCall", id: "tc-1", name: "list_tasks", args: {} },
          ],
          stopReason: "toolUse",
        };
      }
      return { kind: "blocks", blocks: [{ type: "text", text: opts?.text ?? "{}" }], stopReason: "stop" };
    },
  } as unknown as StewardLlmPort & { calls: StewardLlmRequest[] };
}

function makeAdapter(opts?: { enabled?: boolean; llm?: ReturnType<typeof fakeLlm> }) {
  const llm = opts?.llm ?? fakeLlm({
    text: JSON.stringify({
      notify: true,
      urgency: "normal",
      present: "任务完成，测试全绿。",
      ingest: "做了什么：全链落地。\n发现统计：全绿，任务完成，测试全绿。",
      suggestions: [{ label: "看报告" }],
    }),
  });
  return {
    adapter: new StewardDiagnosisAdapter({ llm, enabled: () => opts?.enabled !== false }),
    llm,
  };
}

describe("gate 三条件（isAvailable）", () => {
  test("enabled ∧ 模型非空 → 可用", () => {
    expect(makeAdapter().adapter.isAvailable()).toBe(true);
  });

  test("enabled 闭包 false（管家关/总结关）→ 不可用", () => {
    expect(makeAdapter({ enabled: false }).adapter.isAvailable()).toBe(false);
  });

  test("模型槽位空（未配 summary.task.model）→ 不可用", () => {
    expect(makeAdapter({ llm: fakeLlm({ model: "" }) }).adapter.isAvailable()).toBe(false);
  });
});

describe("防腐面与调用", () => {
  test("prompt → messages 恰一条 user、tools 空；产物解析透出", async () => {
    const { adapter, llm } = makeAdapter();
    const result = await adapter.diagnose({ systemPrompt: "SYS", userPrompt: "事实" });
    expect(llm.calls.length).toBe(1);
    expect(llm.calls[0]!.systemPrompt).toBe("SYS");
    expect(llm.calls[0]!.messages).toEqual([{ role: "user", text: "事实" }]);
    expect(llm.calls[0]!.tools).toEqual([]);
    expect(result.present).toBe("任务完成，测试全绿。");
    expect(result.notify).toBe(true);
    expect(result.suggestions).toEqual([{ label: "看报告" }]);
  });

  test("toolCall 响应（tools 空不应发生）→ throw 防御", async () => {
    const { adapter } = makeAdapter({ llm: fakeLlm({ toolCall: true }) });
    await expect(adapter.diagnose({ systemPrompt: "s", userPrompt: "u" })).rejects.toThrow("工具调用");
  });

  test("烂输出（非 JSON）→ throw（不播半产物）", async () => {
    const { adapter } = makeAdapter({ llm: fakeLlm({ text: "这不是 JSON" }) });
    await expect(adapter.diagnose({ systemPrompt: "s", userPrompt: "u" })).rejects.toThrow("解析失败");
  });
});

describe("parseDiagnosis（纯函数）：JSON 三重容错", () => {
  test("```json 围栏剥壳", () => {
    const r = parseDiagnosis("```json\n{\"present\":\"一句话\",\"ingest\":\"详录一句话\"}\n```");
    expect(r?.present).toBe("一句话");
  });

  test("前后噪声容忍（首尾大括号定位）", () => {
    const r = parseDiagnosis("好的，结果如下：{\"present\":\"一句话\",\"ingest\":\"详录\"} 以上。");
    expect(r?.present).toBe("一句话");
  });

  test("字段缺席缺省：notify 缺省 true；urgency 非 high 判 normal；suggestions 缺席空数组", () => {
    const r = parseDiagnosis('{"present":"p","ingest":"i"}')!;
    expect(r.notify).toBe(true);
    expect(r.urgency).toBe("normal");
    expect(r.suggestions).toEqual([]);
    expect(parseDiagnosis('{"present":"p","ingest":"i","notify":false}')!.notify).toBe(false);
    expect(parseDiagnosis('{"present":"p","ingest":"i","urgency":"high"}')!.urgency).toBe("high");
    expect(parseDiagnosis('{"present":"p","ingest":"i","urgency":"weird"}')!.urgency).toBe("normal");
  });

  test("suggestions 项守卫（label 非空 string）+ 机械上限 3", () => {
    const r = parseDiagnosis(
      JSON.stringify({
        present: "p",
        ingest: "i",
        suggestions: [{ label: "一" }, { label: "" }, { no: "label" }, "junk", { label: "二" }, { label: "三" }, { label: "四" }],
      }),
    )!;
    expect(r.suggestions).toEqual([{ label: "一" }, { label: "二" }, { label: "三" }]);
  });

  test("无效形态：空文本/非对象/双轨全空 → undefined", () => {
    expect(parseDiagnosis("")).toBeUndefined();
    expect(parseDiagnosis("no braces")).toBeUndefined();
    expect(parseDiagnosis('{"notify":true}')).toBeUndefined(); // 双轨全空
    expect(parseDiagnosis('["array"]')).toBeUndefined();
  });
});
