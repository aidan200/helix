import path from "node:path";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";

/**
 * install 级稳定设备标识（pi-ai 订阅登录批）。
 *
 * 【用途】pi-ai Models.login 的 LoginOptions.getDeviceId——OAuth 登录流
 * （PKCE/设备码）向 provider 标识客户端设备；agentName 恒 "helix"。
 * 【语义】安装级匿名 id（首启生成、终身稳定）——非用户身份、不含主机信息；
 * 落 ~/.helix/install-id（0600，与 auth.json 同目录同权限口径）。
 */
export const HELIX_AGENT_NAME = "helix";

/** 读取或生成 install id（幂等：文件存在即读，损坏/空白则重新生成落盘）。 */
export function loadInstallId(filePath: string): string {
  if (existsSync(filePath)) {
    const stored = readFileSync(filePath, "utf8").trim();
    if (stored !== "") return stored;
  }
  const id = randomUUID();
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${id}\n`, { encoding: "utf8", mode: 0o600 });
  return id;
}
