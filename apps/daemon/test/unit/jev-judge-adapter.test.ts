/**
 * JevJudgeAdapter 单测（B4a——fake fetch，零网络）。
 *
 * 断言面：
 * 1. noul 成功：POST {baseUrl}/systemone + Bearer 头 + noul question 体
 *    → 解析 answers.q.value 校准概率；
 * 2. 未配置 → 抛错降级；
 * 3. HTTP 非 2xx → 抛错含状态码与响应体片段；
 * 4. 协议形态异常（缺 answers / value 非 [0,1] 数值）→ 抛错定位。
 */
import { describe, expect, test } from "bun:test";
import { JevJudgeAdapter } from "../../src/adapters/driven/embedding/JevJudgeAdapter";
import type { JudgeEndpointConfig } from "../../src/application/ports/outbound/JudgePort";

/** 可控 fake fetch（按序返回预设响应）。 */
function fakeFetch(behavior: { status?: number; body?: string; delayMs?: number } = { status: 200, body: '{"answers":{"q":{"value":0.83}}}' }) {
  const calls: { url: string; init: RequestInit }[] = [];
  const doFetch = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    calls.push({ url: String(url), init: init ?? {} });
    if (behavior.delayMs !== undefined) await new Promise((r) => setTimeout(r, behavior.delayMs));
    return new Response(behavior.body ?? "", { status: behavior.status ?? 200 });
  };
  return { doFetch: doFetch as typeof fetch, calls };
}

const CFG: JudgeEndpointConfig = { baseUrl: "https://api.typesafe.ai/v1/", apiKey: "ts-live-secret", model: "jev-latest" };

describe("JevJudgeAdapter：noul 判定", () => {
  test("成功：POST /systemone + Bearer + noul 体 → 校准概率", async () => {
    const ff = fakeFetch();
    const adapter = new JevJudgeAdapter({
      getConfig: () => CFG,
      fetch: ff.doFetch,
    });
    const prob = await adapter.noul("对话片段", "是否包含新信息？");
    expect(prob).toBeCloseTo(0.83);
    // 请求面：尾斜杠客容 + systemone 路径 + Bearer 认证 + noul 原语
    expect(ff.calls).toHaveLength(1);
    expect(ff.calls[0]!.url).toBe("https://api.typesafe.ai/v1/systemone");
    const init = ff.calls[0]!.init;
    expect((init.headers as Record<string, string>)["Authorization"]).toBe("Bearer ts-live-secret");
    const body = JSON.parse(String(init.body)) as { state: string; model: string; questions: Record<string, { type: string; instructions: string }> };
    expect(body.state).toBe("对话片段");
    expect(body.model).toBe("jev-latest");
    expect(body.questions.q).toEqual({ type: "noul", instructions: "是否包含新信息？" });
  });

  test("未配置 → 抛错降级", async () => {
    const ff = fakeFetch();
    const adapter = new JevJudgeAdapter({ getConfig: () => null, fetch: ff.doFetch });
    expect(adapter.noul("s", "q")).rejects.toThrow("未配置");
    expect(ff.calls).toHaveLength(0);
  });

  test("HTTP 401 → 抛错含状态码", async () => {
    const ff = fakeFetch({ status: 401, body: '{"error":"invalid key"}' });
    const adapter = new JevJudgeAdapter({ getConfig: () => CFG, fetch: ff.doFetch });
    let message = "";
    try {
      await adapter.noul("s", "q");
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain("401");
    expect(message).toContain("invalid key");
  });

  test("协议形态异常（缺 answers / value 越界）→ 抛错定位", async () => {
    const noAnswers = new JevJudgeAdapter({ getConfig: () => CFG, fetch: fakeFetch({ body: '{"ok":1}' }).doFetch });
    expect(noAnswers.noul("s", "q")).rejects.toThrow("answers");

    const badValue = new JevJudgeAdapter({ getConfig: () => CFG, fetch: fakeFetch({ body: '{"answers":{"q":{"value":1.5}}}' }).doFetch });
    expect(badValue.noul("s", "q")).rejects.toThrow("形态非法");
  });

  test("endpointLabel：host + model 可读标识", () => {
    const adapter = new JevJudgeAdapter({ getConfig: () => CFG });
    expect(adapter.endpointLabel()).toBe("jev/jev-latest @ api.typesafe.ai");
  });
});
