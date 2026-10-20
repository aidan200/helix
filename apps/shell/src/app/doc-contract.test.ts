/**
 * app 层注释口径守卫（TR-285：注释/文案漂移型缺陷用源码定式断言钉住）。
 *
 * 钉两条口径（code-review 低危「路由位计数注释过时」）：
 * - 路由位/导航位**不写字面计数**（TR-206 引用式）：路由清单以 ./route 的
 *   AppRoute 联合为单源、导航清单以 App.tsx 的 RAIL_ITEMS 为单源——计数写死
 *   在注释里必然随增删漂移（历史「五路由位/六路由位/五位」三种说法并存）；
 * - 出现过的旧计数措辞禁回潮（分片拼接构造待禁串，防断言目标自指恒真）。
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
const appTsx = read("./App.tsx");
const routeTs = read("./route.ts");
const useAppRouteTs = read("./useAppRoute.ts");

describe("路由位/导航位计数注释（引用式，禁字面计数）", () => {
  it("App.tsx 新口径在场：路由清单指向 AppRoute 联合、导航清单指向 RAIL_ITEMS", () => {
    expect(appTsx).toContain("AppRoute 联合为单源");
    expect(appTsx).toContain("清单以本数组为单源");
  });

  it("route.ts 新口径在场：路由清单 = AppRoute 联合，本文不重复计数", () => {
    expect(routeTs).toContain("AppRoute 联合，本文不重复计数");
  });

  it("旧计数措辞禁回潮（app 三文件；待禁串分片拼接防自指）", () => {
    const banned = ["五" + "路由位", "六" + "路由位", "导航位" + "五位", "六" + "导航位"];
    for (const src of [appTsx, routeTs, useAppRouteTs]) {
      for (const b of banned) expect(src).not.toContain(b);
    }
  });
});
