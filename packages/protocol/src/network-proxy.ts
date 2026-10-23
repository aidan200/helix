/**
 * config.set_proxy 地址契约单源，两端与运行时读面复用。
 * Bun fetch 当前支持 HTTP(S) 代理，不接受 SOCKS5；端点不含路径/查询/片段。
 * 认证可写为 user:password@host（特殊字符须 URL 编码）。
 */
export function isValidProxyUrl(value: string): boolean {
  if (!/^https?:\/\//i.test(value) || /\s/.test(value)) return false;
  try {
    const url = new URL(value);
    return (url.protocol === "http:" || url.protocol === "https:") && url.hostname !== "" &&
      (url.pathname === "" || url.pathname === "/") && url.search === "" && url.hash === "";
  } catch { return false; }
}
