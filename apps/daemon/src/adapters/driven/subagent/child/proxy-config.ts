import { DEFAULT_PROXY_CONFIG, PROXY_CONFIG_KEY, parseProxyConfig } from "../../../../application/network/proxy-config";
import type { ProxyConfig } from "../../../../application/ports/outbound/ProxyConfigPort";
import { openTaskLedgerDatabase } from "../../sqlite-session/WriteQueue";
import { installProxyFetch } from "../../network/proxy-fetch";

/**
 * 复用 HELIX_DB_PATH，不把代理凭据塞进 env 快照。逐请求短连接只读 KV，
 * 父侧保存落盘后，已经运行的子进程也在下一请求生效；无构造期常驻句柄。
 */
export function installChildProxyFetch(dbPath: string | undefined): () => void {
  if (dbPath === undefined) return () => {};
  return installProxyFetch((): ProxyConfig => {
    let db: ReturnType<typeof openTaskLedgerDatabase> | undefined;
    try {
      db = openTaskLedgerDatabase(dbPath);
      const row = db.prepare("SELECT value FROM runtime_config WHERE key = ?").get(PROXY_CONFIG_KEY) as { value: string } | null;
      return parseProxyConfig(row?.value);
    } catch { return { ...DEFAULT_PROXY_CONFIG }; }
    finally { db?.close(); }
  });
}
