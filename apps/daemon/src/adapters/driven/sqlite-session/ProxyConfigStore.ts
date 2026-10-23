import type { RuntimeConfigPort } from "../../../application/ports/outbound/RuntimeConfigPort";
import type { ProxyConfig, ProxyConfigPort } from "../../../application/ports/outbound/ProxyConfigPort";
import { DEFAULT_PROXY_CONFIG, PROXY_CONFIG_KEY, parseProxyConfig } from "../../../application/network/proxy-config";
import { makeKvConfigStore, type KvConfigStore } from "./KvConfigStore";

/** KV 配置单源；读面现值由 fetch 包装逐请求消费，写经 WriteQueue。 */
export class ProxyConfigStore implements ProxyConfigPort {
  private readonly store: KvConfigStore<ProxyConfig>;

  constructor(runtimeConfig: RuntimeConfigPort) {
    this.store = makeKvConfigStore(runtimeConfig, {
      key: PROXY_CONFIG_KEY,
      parse: parseProxyConfig,
      fallback: DEFAULT_PROXY_CONFIG,
      clone: (v) => ({ ...v }),
      serialize: JSON.stringify,
      warnLabel: "ProxyConfigStore",
    });
  }

  current(): ProxyConfig { return this.store.current(); }
  set(config: ProxyConfig): Promise<void> { return this.store.set(config); }
}
