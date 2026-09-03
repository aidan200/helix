import { describe, expect, test } from "bun:test";
import { parseDuckDuckGoHtml, parseBingHtml } from "../../src/adapters/driven/tools/web/WebSearchTool";
import { classifyIp, htmlToMarkdown, toJinaUrl } from "../../src/adapters/driven/tools/web/WebFetchTool";

/**
 * T1 静态联网工具族：解析核与转换核纯函数 unit（只 import 纯函数符号，
 * 零 fetch/node API——与 grep-tool.test.ts 同轨的 framework-free 机械证明）。
 *
 * fixture 为参照真实目标结构手工构造的最小页面：
 * - DDG html 版：`<a class="result__a" href="//duckduckgo.com/l/?uddg=…">`
 *   （真实 URL 在 uddg= 重定向参数，需 decodeURIComponent）+ 同块
 *   `<a class="result__snippet">` 摘要；
 * - Bing：`<li class="b_algo">` 块内 `<h2><a href>` 是链接、`<p>` 是摘要。
 */

/** DDG 最小真实结构 fixture：两条结果（其一含实体与缺 snippet 变体）。 */
const DDG_HTML = `<!DOCTYPE html>
<html><head><title>DuckDuckGo</title></head><body>
<div class="results">
  <div class="result results_links results_links_deep web-result">
    <div class="links_main links_deep result__body">
      <h2 class="result__title">
        <a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Falpha%3Fa%3D1%26b%3D2&amp;rut=deadbeef">Alpha &amp; Beta</a>
      </h2>
      <a class="result__snippet" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Falpha">Alpha 摘要 &lt;b&gt;加粗&lt;/b&gt; 文本</a>
    </div>
  </div>
  <div class="result results_links results_links_deep web-result">
    <div class="links_main links_deep result__body">
      <h2 class="result__title">
        <a rel="nofollow" class="result__a" href="https://direct.example.org/beta">直连标题 <b>含标签</b></a>
      </h2>
    </div>
  </div>
  <a class="nav-link" href="/next">下一页（非结果链接，不应入选）</a>
</div>
</body></html>`;

/** Bing 最小真实结构 fixture：两条 b_algo（其一无摘要 p）。 */
const BING_HTML = `<!DOCTYPE html>
<html><head><title>Bing</title></head><body>
<ol id="b_results">
  <li class="b_algo" data-id="1">
    <h2><a href="https://example.com/gamma" target="_blank">Gamma 标题</a></h2>
    <div class="b_caption"><p>Gamma &amp; 摘要文本</p></div>
  </li>
  <li class="b_algo">
    <h2><a href="https://example.org/delta">Delta <strong>标题</strong></a></h2>
  </li>
  <li class="b_ans"><h2><a href="https://ignore.me/x">非 b_algo 块</a></h2></li>
</ol>
</body></html>`;

describe("parseDuckDuckGoHtml（DDG html 版解析核）", () => {
  test("① uddg 重定向解码 + 标题/摘要提取 + 实体解码", () => {
    const results = parseDuckDuckGoHtml(DDG_HTML, 10);
    expect(results).toHaveLength(2);
    expect(results[0]).toEqual({
      title: "Alpha & Beta",
      url: "https://example.com/alpha?a=1&b=2", // uddg= 参数 decodeURIComponent
      snippet: "Alpha 摘要 <b>加粗</b> 文本",
    });
    // 非 uddg 形态：https 直链原样保留；标题内标签剥除
    expect(results[1]).toEqual({ title: "直连标题 含标签", url: "https://direct.example.org/beta", snippet: "" });
  });

  test("② limit 截断 + 非结果页面零结果（不抛错）", () => {
    expect(parseDuckDuckGoHtml(DDG_HTML, 1)).toHaveLength(1);
    expect(parseDuckDuckGoHtml("<html><body>无结果页</body></html>", 10)).toEqual([]);
  });
});

describe("parseBingHtml（Bing 解析核）", () => {
  test("① b_algo 块内 h2>a 链接 + p 摘要；无摘要块 snippet 为空", () => {
    const results = parseBingHtml(BING_HTML, 10);
    expect(results).toEqual([
      { title: "Gamma 标题", url: "https://example.com/gamma", snippet: "Gamma & 摘要文本" },
      { title: "Delta 标题", url: "https://example.org/delta", snippet: "" },
    ]);
  });

  test("② limit 截断 + 非 b_algo 块忽略 + 零结果不抛错", () => {
    expect(parseBingHtml(BING_HTML, 1)).toHaveLength(1);
    expect(parseBingHtml("<html><body>captcha</body></html>", 10)).toEqual([]);
  });
});

describe("htmlToMarkdown（五要素转换核）", () => {
  test("① 标题 h1-h6 → # 前缀", () => {
    const md = htmlToMarkdown("<h1>一级</h1><h3>三级</h3><h6>六级</h6>");
    expect(md).toContain("# 一级");
    expect(md).toContain("### 三级");
    expect(md).toContain("###### 六级");
  });

  test("② 段落文本保留；script/style/head 剥除", () => {
    const md = htmlToMarkdown(
      "<html><head><title>T</title><style>body{color:red}</style></head>" +
        "<body><p>第一段</p><p>第二段</p><script>alert(1)</script></body></html>",
    );
    expect(md).toContain("第一段");
    expect(md).toContain("第二段");
    expect(md).not.toContain("alert");
    expect(md).not.toContain("color:red");
    expect(md).not.toContain("<title>");
  });

  test("③ 链接保留 text+href → [text](href)", () => {
    const md = htmlToMarkdown('<p>见 <a href="https://example.com/doc">文档</a> 一节</p>');
    expect(md).toContain("[文档](https://example.com/doc)");
  });

  test("④ 图片保留 alt+src → ![alt](src)", () => {
    const md = htmlToMarkdown('<img src="https://example.com/a.png" alt="示意图">');
    expect(md).toContain("![示意图](https://example.com/a.png)");
  });

  test("⑤ 代码块 pre/code → 围栏块（内部标签与实体正确处理）", () => {
    const md = htmlToMarkdown("<pre><code>if (a &lt; b) {\n  go();\n}</code></pre>");
    expect(md).toContain("```\nif (a < b) {\n  go();\n}\n```");
  });

  test("⑥ 实体解码：&amp; &lt; &gt; &quot; &#39; &nbsp;", () => {
    const md = htmlToMarkdown("<p>a &amp; b &lt;c&gt; &quot;q&quot; &#39;s&#39; x&nbsp;y</p>");
    expect(md).toContain(`a & b <c> "q" 's' x y`);
  });
});

describe("toJinaUrl（Jina 备选通道 URL 投影）", () => {
  test("去 http(s):// 前缀；其余原样", () => {
    expect(toJinaUrl("https://example.com/a?b=1")).toBe("example.com/a?b=1");
    expect(toJinaUrl("http://sub.example.org/")).toBe("sub.example.org/");
    expect(toJinaUrl("example.com/no-scheme")).toBe("example.com/no-scheme");
  });
});

describe("classifyIp（SSRF 守卫 IP 分类，code-review H12 口径 D1）", () => {
  test("环回放行（本机 dev server 合法场景）", () => {
    expect(classifyIp("127.0.0.1")).toBe("loopback");
    expect(classifyIp("127.255.0.1")).toBe("loopback");
    expect(classifyIp("::1")).toBe("loopback");
  });
  test("公网放行", () => {
    expect(classifyIp("1.1.1.1")).toBe("public");
    expect(classifyIp("203.0.113.10")).toBe("public");
    expect(classifyIp("2606:4700:4700::1111")).toBe("public");
  });
  test("私网/链路本地/云 metadata/CGNAT/保留段拒绝", () => {
    expect(classifyIp("10.0.0.1")).toBe("blocked");
    expect(classifyIp("172.16.0.1")).toBe("blocked");
    expect(classifyIp("172.31.255.255")).toBe("blocked");
    expect(classifyIp("172.15.0.1")).toBe("public"); // 172.16/12 边界外是公网
    expect(classifyIp("192.168.1.1")).toBe("blocked");
    expect(classifyIp("169.254.169.254")).toBe("blocked"); // 云 metadata
    expect(classifyIp("169.254.0.1")).toBe("blocked");
    expect(classifyIp("100.64.0.1")).toBe("blocked"); // CGNAT
    expect(classifyIp("100.127.255.255")).toBe("blocked");
    expect(classifyIp("100.128.0.1")).toBe("public"); // CGNAT 边界外
    expect(classifyIp("0.0.0.0")).toBe("blocked");
    expect(classifyIp("224.0.0.1")).toBe("blocked"); // 组播
  });
  test("IPv6：ULA/链路本地/未指定拒绝；v4-mapped 递归分类", () => {
    expect(classifyIp("fc00::1")).toBe("blocked");
    expect(classifyIp("fd12:3456::1")).toBe("blocked");
    expect(classifyIp("fe80::1")).toBe("blocked");
    expect(classifyIp("febf::1")).toBe("blocked");
    expect(classifyIp("::")).toBe("blocked");
    expect(classifyIp("::ffff:127.0.0.1")).toBe("loopback");
    expect(classifyIp("::ffff:192.168.0.1")).toBe("blocked");
    expect(classifyIp("::ffff:8.8.8.8")).toBe("public");
  });
  test("非 IP 输入拒绝", () => {
    expect(classifyIp("not-an-ip")).toBe("blocked");
    expect(classifyIp("")).toBe("blocked");
  });
});
