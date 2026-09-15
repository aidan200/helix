/**
 * web 静态联网工具族共享常量（code-review 低危：BROWSER_UA 此前在
 * WebSearchTool 与 WebFetchTool 逐字重复——双源漂移风险，下沉单源共享）。
 */

/** 浏览器伪装 UA（静态抓取防风控的最低限度伪装——web_search/web_fetch 同口径）。 */
export const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
