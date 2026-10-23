import { describe, expect, test } from "bun:test";
import type { EventEnvelope } from "@helix/protocol";
import { handleConfigGetProxy, handleConfigSetProxy } from "../../src/adapters/driving/ws-server/handlers/config";
import type { WsCommandContext } from "../../src/adapters/driving/ws-server/handlers/context";

/**
 * config.get/set_proxy（网络代理批）：读面回执 {enabled,url}；写面部分更新
 * 语义（enabled/url 任选一项）+ **合并终态校验**（enabled=true 时终态 url 必须
 * 合法——含「存量非法 url + 单独开启」的合并写拦截）。
 */

interface StoreShape {
  current: { value: { enabled: boolean; url: string } };
  written: { enabled: boolean; url: string }[];
}

function makeCtx(store: StoreShape, payload: Record<string, unknown>) {
  const frames: EventEnvelope[] = [];
  const errors: { code: string; message: string }[] = [];
  const sender = { id: "conn-1" };
  const ctx = {
    ws: { data: { sender } },
    type: "config.set_proxy",
    payload,
    proxyConfig: {
      current: () => store.current.value,
      set: async (next: { enabled: boolean; url: string }) => {
        store.written.push(next);
        store.current.value = next;
      },
    },
    commandError: (_t: string, code: string, message: string) => errors.push({ code, message }),
    rawSender: () => sender,
    sendNow: (_s: unknown, frame: EventEnvelope) => frames.push(frame),
  } as unknown as WsCommandContext;
  return { ctx, frames, errors };
}

const ON = { enabled: true, url: "http://127.0.0.1:7890" };

describe("config.get_proxy（读面）", () => {
  test("① 回执 {enabled,url}（单快照）", () => {
    const { ctx, frames, errors } = makeCtx({ current: { value: ON }, written: [] }, {});
    (ctx as unknown as { type: string }).type = "config.get_proxy";
    handleConfigGetProxy(ctx);
    expect(errors).toEqual([]);
    expect((frames[0] as { payload: unknown }).payload).toEqual(ON);
    expect((frames[0] as { type: string }).type).toBe("config.get_proxy.result");
  });

  test("② 未装配 → command.unimplemented（零帧）", () => {
    const { ctx, frames, errors } = makeCtx({ current: { value: ON }, written: [] }, {});
    (ctx as unknown as { type: string }).type = "config.get_proxy";
    (ctx as unknown as { proxyConfig: undefined }).proxyConfig = undefined;
    handleConfigGetProxy(ctx);
    expect(frames).toEqual([]);
    expect(errors[0]?.code).toBe("command.unimplemented");
  });
});

describe("config.set_proxy（写面）", () => {
  test("① 全量写 → 合并全量回执", async () => {
    const store: StoreShape = { current: { value: { enabled: false, url: "" } }, written: [] };
    const { ctx, frames, errors } = makeCtx(store, { ...ON });
    handleConfigSetProxy(ctx);
    await Promise.resolve();
    expect(errors).toEqual([]);
    expect(store.written).toEqual([ON]);
    expect((frames[0] as { payload: unknown }).payload).toEqual(ON);
  });

  test("② 部分更新：只带 enabled（url 保留现值）/ 只带 url（enabled 保留现值）", async () => {
    const s1: StoreShape = { current: { value: { enabled: false, url: "http://h:1080" } }, written: [] };
    handleConfigSetProxy(makeCtx(s1, { enabled: true }).ctx);
    await Promise.resolve();
    expect(s1.written).toEqual([{ enabled: true, url: "http://h:1080" }]);

    const s2: StoreShape = { current: { value: { enabled: false, url: "" } }, written: [] };
    handleConfigSetProxy(makeCtx(s2, { url: "http://p:1" }).ctx);
    await Promise.resolve();
    expect(s2.written).toEqual([{ enabled: false, url: "http://p:1" }]); // 未启用态 url 先存后用
  });

  test("③ 空载荷 → invalid_payload", () => {
    const { ctx, errors } = makeCtx({ current: { value: { enabled: false, url: "" } }, written: [] }, {});
    handleConfigSetProxy(ctx);
    expect(errors[0]?.code).toBe("command.invalid_payload");
  });

  test("④ 合并终态校验：enabled=true 时 url 必须合法（存量非法 url 单独开启 → 拒绝）", () => {
    // 存量被外部脏写为非法 url，UI 单独发 enabled:true → 终态非法 → 拒绝
    const s: StoreShape = { current: { value: { enabled: false, url: "not-a-url" } }, written: [] };
    const { ctx, errors } = makeCtx(s, { enabled: true });
    handleConfigSetProxy(ctx);
    expect(errors[0]?.code).toBe("command.invalid_payload");
    expect(s.written).toEqual([]);
  });

  test("⑤ 关闭档也拒绝非法非空地址，避免保存一个不能用的配置", async () => {
    const s: StoreShape = { current: { value: { enabled: true, url: "http://p:1" } }, written: [] };
    const { ctx, errors } = makeCtx(s, { enabled: false, url: "draft" });
    handleConfigSetProxy(ctx);
    await Promise.resolve();
    expect(s.written).toEqual([]);
    expect(errors[0]?.code).toBe("command.invalid_payload");
  });

  test("⑥ 类型闸：enabled 非 boolean / url 非 string → invalid_payload", () => {
    const s: StoreShape = { current: { value: { enabled: false, url: "" } }, written: [] };
    const a = makeCtx(s, { enabled: "yes" });
    handleConfigSetProxy(a.ctx);
    expect(a.errors[0]?.code).toBe("command.invalid_payload");
    const b = makeCtx(s, { url: 123 });
    handleConfigSetProxy(b.ctx);
    expect(b.errors[0]?.code).toBe("command.invalid_payload");
  });

  test("⑦ 未装配 → command.unimplemented", () => {
    const { ctx, errors } = makeCtx({ current: { value: { enabled: false, url: "" } }, written: [] }, { ...ON });
    (ctx as unknown as { proxyConfig: undefined }).proxyConfig = undefined;
    handleConfigSetProxy(ctx);
    expect(errors[0]?.code).toBe("command.unimplemented");
  });
});
