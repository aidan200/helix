/**
 * StewardDock —— 管家全局弹层壳（管家全局化批：chat 页 top-bar 挂件退役，
 * 管家升格 app 壳级常驻能力；A1 工作记忆批：关闭 = 隐藏不卸载）。
 *
 * 形态：IconRail（app 生命周期唯一常驻壳）右侧 fixed 浮动面板（满窗口
 * 高直角壳——UI 显示优化批用户裁决：零圆角 / 无边框 / top+bottom 贴满
 * 视口；底/雾/投影仍 tokens.md：popover-fill 0.8 档 + blur + shadow-pop）；
 * 入口 = IconRail 管家位（.rail-steward-btn，WebStatus 能力钮先例同构，
 * props 注入纯展示），开合态由 app 层（AppRoutes）持有。
 *
 * 关闭路径：点外（exempt = dock 本体 + rail 入口钮——入口钮开合归自身
 * toggle，pointerdown 关闭与 click toggle 叠加会抵消成「关了又开」）/
 * Esc（面板自有窗口监听与 dismiss hook 双路径幂等）/ 面板头部 ×。
 *
 * A1 关闭语义：open=false 时**隐藏不卸载**（display 层收起，组件树保留）——
 * useSteward/useStewardVoice 状态与订阅面跨开关保留（回放同源数据驻留，
 * 重开零重拉闪烁）；useDismissOnOutside 点外关闭行为保留（DOM 仍在文档
 * 流，selector 匹配面不变）。
 *
 * 面板本体（StewardPanel）零位置知识——位置/层级/弹层皮全在本壳。
 */
import StewardPanel from "./StewardPanel";
import { useDismissOnOutside } from "@/shared/lib/useDismissOnOutside";

export interface StewardDockProps {
  /** 弹层开合（app 层受控）。 */
  open: boolean;
  onClose: () => void;
  /** B2-④ 入口①：面板头部记忆钮 → 记忆独立页（透传 StewardPanel）。 */
  onOpenMemory: () => void;
}

const StewardDock = function StewardDock({ open, onClose, onOpenMemory }: StewardDockProps) {
  useDismissOnOutside(open, ".stp-dock, .rail-steward-btn", onClose, { event: "pointerdown" });
  return (
    <div className={open ? "stp-dock" : "stp-dock stp-dock-hidden"} data-testid="steward-dock" aria-hidden={!open}>
      <StewardPanel onClose={onClose} active={open} onOpenMemory={onOpenMemory} />
    </div>
  );
};

export default StewardDock;
