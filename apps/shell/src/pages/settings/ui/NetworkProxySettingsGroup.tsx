/**
 * 设置页通用分区「网络代理」组（网络代理批）——独立组件，GeneralSettingsSection
 * 原位一行挂载（不把逻辑塞进那个大文件）。
 *
 * 语义（后端 E-321 契约）：
 * - 写面 config.set_proxy 部分更新（enabled/url 任选至少一项，未携带项保留
 *   现值），读面 config.get_proxy；进入分区未请求态才拉现值（modelConfig.proxy
 *   帧驱动，非乐观）。
 * - 地址校验单源 = @helix/protocol isValidProxyUrl（HTTP/HTTPS、可内嵌认证、
 *   禁路径/查询/片段）；Bun fetch 不支持 SOCKS5 → 明确行内交代（不发命令）。
 *   关闭档允许空地址，开启时地址必填。
 * - 「已保存」只由 config.set_proxy.result 驱动（proxySaved 位），读回执不冒充；
 *   send false（断连）行内交代不假保存；daemon 拒绝走 connection.error 尾缀
 *   归因（「（命令 config.set_proxy）」）行内原样交代；断连清在途由
 *   clearModelConfigInflight 承担（TR-84 / TR-270）。
 * - 地址草稿保护：未提交草稿不被读帧或其他字段回执覆盖，只在权威值等于草稿
 *   时收敛；回车/失焦双通道提交同值去重（一次命令）；开启时把正在编辑的地址
 *   原子发送 {enabled:true,url}，关闭只发 {enabled:false} 且保留地址。
 * - 凭据不必要暴露：地址含 user:password@ 时默认 password 掩码 + 显隐切换；
 *   本组件零 console 输出（凭据不进日志）。
 *
 * 表现层沿用既有通用配置卡模式（hud-card / fld / hud-label / hud-input /
 * lang-switch 双按钮 / hud-btn / ag-note / mcp-err），零新增色值与依赖，低动效。
 */
import { useEffect, useRef, useState } from "react";
import { isValidProxyUrl } from "@helix/protocol";
import { useSession } from "@/entities/session/SessionContext";
import { useI18n } from "@/shared/i18n";
import { cn } from "@/shared/lib/cn";
import { commandOfConnectionError } from "@/shared/lib/command-error";

/** 本组写面命令（connection.error 尾缀归因判据；「（命令 <type>）」单一构造点）。 */
const SET_PROXY_COMMAND = "config.set_proxy";

/** SOCKS 形态（Bun fetch 不支持）：显式识别以便行内说明「不支持」而非泛泛「非法」。 */
const SOCKS_RE = /^socks(4|4a|5|5h)?:\/\//i;

/** 地址内嵌凭据（user:password@）→ 默认掩码显示。 */
const CREDENTIAL_RE = /^[a-z][a-z0-9+.-]*:\/\/[^/@]*@/i;

type InvalidKind = "invalid" | "socks";

/** 地址校验（空串 = 关闭档合法）；返回 null = 合法。 */
function invalidKindOf(raw: string): InvalidKind | null {
  const value = raw.trim();
  if (value === "") return null;
  if (SOCKS_RE.test(value)) return "socks";
  return isValidProxyUrl(value) ? null : "invalid";
}

const NetworkProxySettingsGroup = function NetworkProxySettingsGroup() {
  const { t } = useI18n();
  const { state, topology, requestProxyConfig, setProxyConfig, subscribeConfigFrames } = useSession();
  const connected = state.conn === "connected";
  const cfg = topology.modelConfig.proxy;
  const inflight = topology.modelConfig.proxyInflight;
  const saved = topology.modelConfig.proxySaved;

  /** 用户未提交的地址草稿（null = 无编辑，展示权威值）。 */
  const [draft, setDraft] = useState<string | null>(null);
  /** 行内交代（本地校验 / 未发出 / daemon 拒绝）。 */
  const [error, setError] = useState<string | null>(null);
  /** 含凭据地址的显隐。 */
  const [reveal, setReveal] = useState(false);
  /** 回车/失焦双通道提交去重（同值一次命令；失败复位可重试）。 */
  const lastSubmitted = useRef<string | null>(null);
  /** 在途位镜像（订阅 listener 单挂一次，读最新在途态——effect 同步，非渲染体写）。 */
  const inflightRef = useRef(false);
  useEffect(() => {
    if (inflightRef.current && !inflight && !connected) {
      setError(t("chat.settings.general.sendFail"));
    }
    inflightRef.current = inflight;
  }, [inflight, connected, t]);

  // 每次连接恢复都重拉权威值；未发出时只退避重试一次，不以 setState 自激。
  useEffect(() => {
    lastSubmitted.current = null;
    if (!connected) {
      if (inflightRef.current) setError(t("chat.settings.general.sendFail"));
      return;
    }
    setError(null);
    if (requestProxyConfig(true) !== false) return;
    setError(t("chat.settings.general.sendFail"));
    const retry = setTimeout(() => {
      if (requestProxyConfig(true) === false) setError(t("chat.settings.general.sendFail"));
      else setError(null);
    }, 200);
    return () => clearTimeout(retry);
    // 连接变迁是世代边界；i18n 变化不应重启拉取/重试。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connected, requestProxyConfig]);

  // 草稿收敛：权威值等于草稿才清编辑态——读帧与其他字段回执不覆盖未保存草稿
  useEffect(() => {
    if (cfg === null) return;
    setDraft((prev) => (prev !== null && prev.trim() === cfg.url ? null : prev));
  }, [cfg]);

  // daemon 拒绝交代：connection.error 尾缀归因（他命令不归本组）；无尾缀旧
  // daemon 仅在「本命令在途」时消费（宁误交代不静默）
  useEffect(
    () =>
      subscribeConfigFrames((e) => {
        if (e.type !== "connection.error") return;
        const message = (e.payload as { message?: string } | undefined)?.message ?? "connection.error";
        const cmd = commandOfConnectionError(message);
        if (cmd !== undefined) {
          if (cmd !== SET_PROXY_COMMAND) return;
        } else if (!inflightRef.current) return;
        lastSubmitted.current = null; // 失败后可重试同值
        setError(message);
      }),
    [subscribeConfigFrames],
  );

  const value = draft ?? cfg?.url ?? "";
  const credentialMasked = CREDENTIAL_RE.test(value.trim());
  const showSaved = saved && draft === null && error === null && connected && !inflight;
  const notReady = cfg === null;
  const busy = notReady || inflight || !connected;

  /** send 包装：false = 未发出（断连），行内交代且不置任何成功态。 */
  const send = (patch: { enabled?: boolean; url?: string }): boolean => {
    if (setProxyConfig(patch) === false) {
      lastSubmitted.current = null;
      setError(t("chat.settings.general.sendFail"));
      return false;
    }
    setError(null);
    return true;
  };

  /** 开关（非乐观：翻转由 set 回执驱动）。 */
  const toggle = (next: boolean): void => {
    if (next) {
      // 开启：把正在编辑的地址原子发送（未提交草稿也一并生效）
      const url = (draft ?? cfg?.url ?? "").trim();
      const bad = invalidKindOf(url);
      if (bad !== null) {
        setError(t(bad === "socks" ? "chat.settings.general.proxySocksUnsupported" : "chat.settings.general.proxyInvalid"));
        return;
      }
      if (url === "") {
        setError(t("chat.settings.general.proxyNeedUrl"));
        return;
      }
      lastSubmitted.current = url;
      send({ enabled: true, url });
      return;
    }
    // 关闭：只发 enabled，地址保留（不随关闭清空）
    send({ enabled: false });
  };

  /** 地址提交（回车/失焦）：未变收敛零命令；非法行内拒绝；同值去重。 */
  const commit = (): void => {
    if (cfg === null || !connected || inflight) return;
    const next = (draft ?? cfg.url).trim();
    if (cfg.enabled && next === "") {
      setError(t("chat.settings.general.proxyNeedUrl"));
      return;
    }
    if (next === cfg.url) {
      setDraft(null);
      setError(null);
      return;
    }
    if (lastSubmitted.current === next) return; // 回车后失焦不再重发
    const bad = invalidKindOf(next);
    if (bad !== null) {
      setError(t(bad === "socks" ? "chat.settings.general.proxySocksUnsupported" : "chat.settings.general.proxyInvalid"));
      return;
    }
    lastSubmitted.current = next;
    send({ url: next });
  };

  return (
    <>
      <h3 className="section-label gen-group-label">{t("chat.settings.general.groupNetworkProxy")}</h3>
      <div className="hud-card" data-network-proxy>
        <div className="fld">
          <span className="hud-label">{t("chat.settings.general.proxySwitch")}</span>
          <div className="lang-switch" data-proxy-switch role="group" aria-label={t("chat.settings.general.proxySwitch")}>
            <button
              type="button"
              className={cn("hud-btn sm", cfg?.enabled === true ? "hud-btn-cyan" : "hud-btn-ghost")}
              data-proxy-option="on"
              aria-pressed={cfg?.enabled === true}
              disabled={busy}
              onClick={() => toggle(true)}
            >
              {t("chat.settings.general.switchOn")}
            </button>
            <button
              type="button"
              className={cn("hud-btn sm", cfg?.enabled === false ? "hud-btn-cyan" : "hud-btn-ghost")}
              data-proxy-option="off"
              aria-pressed={cfg?.enabled === false}
              disabled={busy}
              onClick={() => toggle(false)}
            >
              {t("chat.settings.general.switchOff")}
            </button>
          </div>
          <span className="ag-note" data-proxy-note>
            {t("chat.settings.general.proxyNote")}
          </span>
        </div>
        <div className="fld">
          <label className="hud-label" htmlFor="network-proxy-url">
            {t("chat.settings.general.proxyUrl")}
          </label>
          <input
            id="network-proxy-url"
            className="hud-input"
            type={credentialMasked && !reveal ? "password" : "text"}
            autoComplete="off"
            spellCheck={false}
            value={value}
            placeholder={t("chat.settings.general.proxyUrlPlaceholder")}
            data-proxy-url
            disabled={inflight || !connected}
            onChange={(e) => {
              lastSubmitted.current = null;
              setError(null);
              setDraft(e.target.value);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") commit();
            }}
            onBlur={(e) => {
              // 鼠标/键盘转到本组按钮时，由按钮原子提交；不能让 blur 先保存
              // 地址并锁住即将点击的启用按钮。显隐按钮也不应触发保存。
              if (e.relatedTarget instanceof HTMLElement &&
                e.relatedTarget.closest("[data-proxy-option], [data-proxy-reveal]")) return;
              commit();
            }}
          />
          {credentialMasked && (
            <button
              type="button"
              className="hud-btn hud-btn-ghost sm"
              data-proxy-reveal
              onClick={() => setReveal((prev) => !prev)}
            >
              {t(reveal ? "chat.settings.general.proxyHide" : "chat.settings.general.proxyReveal")}
            </button>
          )}
          <span className="ag-note">{t("chat.settings.general.proxyUrlNote")}</span>
        </div>
        {notReady && (
          <span className="ag-note" data-proxy-loading>
            {t("chat.settings.general.proxyLoading")}
          </span>
        )}
        {inflight && (
          <span className="ag-note" data-proxy-inflight>
            {t("chat.settings.general.proxySaving")}
          </span>
        )}
        {showSaved && (
          <span className="ag-note" data-proxy-saved>
            {t("chat.settings.general.saved")}
          </span>
        )}
        {error !== null && (
          <span className="mcp-err" data-proxy-error role="alert">
            {error}
          </span>
        )}
      </div>
    </>
  );
};

export default NetworkProxySettingsGroup;
