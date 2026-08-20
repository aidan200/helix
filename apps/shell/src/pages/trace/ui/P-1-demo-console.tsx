/**
 * P-1 演示控制台（dev 机制；原型 data-demo 控制台转 isDev() 门控，prod
 * 不渲染；原型标注说明两条已剥离不进实现）。
 *
 * STATE seg：强制视图（成功/加载/空态/错误）+ 强制断连 overlay——走
 * reducer dev-set-view / dev-set-conn 覆盖层，不污染底层状态机
 * （selectTraceView 口径：devForceView ?? view）。
 */
import { useI18n } from "@/shared/i18n";
import { isDev } from "@/shared/config/env";
import { cn } from "@/shared/lib/cn";
import type { TraceView } from "../model/trace-model";

export interface DemoConsoleProps {
  /** 当前展示视图（覆盖后；seg 高亮依据）。 */
  view: TraceView;
  connOff: boolean;
  onForceView: (view: TraceView | null) => void;
  onForceConn: (off: boolean) => void;
}

type SegKey = "success" | "loading" | "empty" | "error" | "conn";

const SEG: readonly { key: SegKey; labelKey: string }[] = [
  { key: "success", labelKey: "trace.demo.viewSuccess" },
  { key: "loading", labelKey: "trace.demo.viewLoading" },
  { key: "empty", labelKey: "trace.demo.viewEmpty" },
  { key: "error", labelKey: "trace.demo.viewError" },
  { key: "conn", labelKey: "trace.demo.viewConn" },
];

const DemoConsole = function DemoConsole({
  view,
  connOff,
  onForceView,
  onForceConn,
}: DemoConsoleProps) {
  const { t } = useI18n();
  if (!isDev()) return null; // prod 不渲染（isDev 门控）
  const active: SegKey | null = connOff ? "conn" : view === "idle" ? null : view;
  return (
    <div className="demo-console" data-demo="console">
      <div className="dc-title">
        <span>{t("trace.demo.title")}</span>
        <span className="hud-dot hud-dot-accent" aria-hidden="true" />
      </div>
      <div className="dc-row">
        <span className="dc-lbl">{t("trace.demo.state")}</span>
        <div className="dc-seg">
          {SEG.map((b) => (
            <button
              key={b.key}
              type="button"
              className={cn(active === b.key && "on")}
              onClick={() => {
                if (b.key === "conn") {
                  onForceConn(true);
                  onForceView(null);
                } else {
                  onForceConn(false);
                  onForceView(b.key);
                }
              }}
            >
              {t(b.labelKey)}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
};

export default DemoConsole;
