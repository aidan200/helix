/**
 * 模型切换菜单 ↔ 顶栏模型徽标：跨组件「点外关闭豁免」契约单点（code-review 低危）。
 *
 * 背景：菜单（features/model-switch）的点外关闭要给触发钮（widgets/top-bar 的
 * 模型徽标）开豁免，旧实现把 `'[data-model-badge], .model-menu'` 魔法选择器
 * 直接写死在 features 里——徽标侧属性改名即静默破坏点外语义（点徽标先开、
 * 同一 click 冒泡到 document 又被关掉），且跨 FSD 层无可查契约。
 *
 * 契约：触发钮属性名与菜单根选择器都在此单源导出，两任一消费——
 * - 徽标（trigger）：把 MODEL_BADGE_ATTR 铺成属性（值空串）；
 * - 菜单（popover）：用 MODEL_MENU_EXEMPT_SELECTOR 交给 useDismissOnOutside。
 * 改名/挪属性只改本文件，编译器保证两侧同时跟上（不再有「一侧改名一侧
 * 静默失效」的形态）。
 */

/** 顶栏模型徽标（菜单触发钮）的数据属性名。 */
export const MODEL_BADGE_ATTR = "data-model-badge";

/** 点外关闭豁免选择器：触发钮 + 菜单本体（`.model-menu` 是菜单自身样式契约）。 */
export const MODEL_MENU_EXEMPT_SELECTOR = `[${MODEL_BADGE_ATTR}], .model-menu`;
