import type { ProxyConfig } from "../../../application/ports/outbound/ProxyConfigPort";
import { isValidProxyUrl } from "@helix/protocol";

/** 目标只限 HTTP(S)；本地服务始终直连（URL 已规范化 IPv4/IPv6 字面量）。 */
function shouldProxy(input: Parameters<typeof fetch>[0]): boolean {
  try {
    const url = input instanceof URL ? input : new URL(typeof input === "string" ? input : input.url);
    if (url.protocol !== "http:" && url.protocol !== "https:") return false;
    const h = url.hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
    return h !== "localhost" && !h.endsWith(".localhost") && h !== "::1" && h !== "0.0.0.0" &&
      !/^127\./.test(h) && !/^::ffff:7f[0-9a-f]{2}:/i.test(h);
  } catch { return false; }
}

interface Owner { getConfig: () => ProxyConfig }
interface Installation { original: typeof fetch; wrapped: typeof fetch; owners: Owner[] }
const MARK = Symbol.for("helix.proxyFetch");

/**
 * 单进程单包装，安装先于所有 adapter 构造。逐请求读配置，即热切换。
 * proxy:"" 显式直连，避免 HTTP_PROXY/HTTPS_PROXY 意外接管关闭档或 loopback。
 * 传输失败不偷偷回落直连（也不重试），保留原错误与流式/取消语义。
 * 多个测试 daemon 采用所有权栈；shutdown/启动失败释放后恢复原 fetch 精确引用。
 */
export function installProxyFetch(getConfig: () => ProxyConfig): () => void {
  const globals = globalThis as typeof globalThis & { [MARK]?: Installation };
  let installation = globals[MARK];
  if (installation === undefined) {
    const original = globalThis.fetch;
    const owners: Owner[] = [];
    const wrapped = Object.assign((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const cfg = owners.at(-1)?.getConfig();
      const proxy = cfg?.enabled && isValidProxyUrl(cfg.url) && shouldProxy(input) ? cfg.url : "";
      return original.call(globalThis, input, { ...init, proxy });
    }, original) as typeof fetch;
    // preconnect 不支持代理选项，开启代理时禁预连接，防直连旁路。
    wrapped.preconnect = (...args: Parameters<typeof original.preconnect>) => {
      if (owners.at(-1)?.getConfig().enabled !== true) original.preconnect?.(...args);
    };
    installation = { original, wrapped, owners };
    globals[MARK] = installation;
    globalThis.fetch = wrapped;
  }
  const state = installation;
  const owner = { getConfig };
  state.owners.push(owner);
  return () => {
    const i = state.owners.indexOf(owner);
    if (i < 0) return;
    state.owners.splice(i, 1);
    if (state.owners.length !== 0) return;
    if (globalThis.fetch === state.wrapped) globalThis.fetch = state.original;
    if (globals[MARK] === state) delete globals[MARK];
  };
}
