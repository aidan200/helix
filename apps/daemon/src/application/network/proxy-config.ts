import type { ProxyConfig } from "../ports/outbound/ProxyConfigPort";
import { isValidProxyUrl } from "@helix/protocol";

export const DEFAULT_PROXY_CONFIG: Readonly<ProxyConfig> = { enabled: false, url: "" };
export const PROXY_CONFIG_KEY = "proxy_config";

/** 非法/缺失配置回落直连，而非继续使用陈旧代理；供父进程与子进程复用。 */
export function parseProxyConfig(raw: string | undefined): ProxyConfig {
  try {
    const value: unknown = raw === undefined ? undefined : JSON.parse(raw);
    if (value === null || typeof value !== "object") return { ...DEFAULT_PROXY_CONFIG };
    const c = value as Record<string, unknown>;
    if (typeof c.enabled !== "boolean") return { ...DEFAULT_PROXY_CONFIG };
    const url = typeof c.url === "string" ? c.url : "";
    if (url !== "" && !isValidProxyUrl(url)) return { ...DEFAULT_PROXY_CONFIG };
    if (c.enabled && url === "") return { ...DEFAULT_PROXY_CONFIG };
    return { enabled: c.enabled, url };
  } catch { return { ...DEFAULT_PROXY_CONFIG }; }
}
