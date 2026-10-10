# 81 — web_search 的结果摘要是空的

Status: done
Blocked by: None — can start immediately
Spec: 70 号票（web_search、web_fetch）

## What to build

70 号票合并后主会话跑了真网络冒烟（`npm run smoke:web`，2026-10-10）：搜"Node.js 最新版本"，前 5 条结果的标题和链接都对，但**每条的摘要都是空的**。用户的 `~/.pi/agent/skills/web-search/search.mjs` 是能取到摘要的。

- 对照 `search.mjs` 查清摘要为什么没取到（DDG、Bing、Google 三个引擎分别看）；照它的取法修好。
- 测试用录下来的结果页 HTML 做假数据（不连真网络），三个引擎各一份。

## Acceptance criteria

- [x] 三个引擎的结果都带摘要；单元测试用录下的页面断言摘要非空。
- [ ] 主会话合并后再跑一次 `npm run smoke:web`，摘要不空。
- [x] 所有测试通过（vitest），lint（oxlint）无报错。

## Comments

- 2026-10-10 实现（worktree 分支 `worktree-agent-a50025aeee638eef8`，从 main `d6a3ab03` 开始）。说明在 `docs/dev.md` 的"联网工具"一节。
  - **根因**（三个引擎分别看：录下的页面在真浏览器里离线跑 skill 的取法）：
    - **DDG**（默认、冒烟用的就是它）：DDG 改版，摘要容器变成 `div[data-result="snippet"]`，不再带 skill 认的 `data-testid="result-snippet"`，选择器一个都选不中，摘要全空。**skill 自己也一样**：`node search.mjs "Node.js 最新版本" --engine ddg` 摘要同样是空的；用户看到 skill 有摘要，应该是走了 Bing（skill 的 SKILL.md 描述里写的还是"默认 Bing"）。
    - **Bing**：选择器没问题，摘要取得到（录下的 10 条全有）。
    - **Google**：两个问题。① 本机无头浏览器搜 Google 一律被当成"异常流量"拦下（skill 也一样；有头、关掉自动化标记才不拦）——这是反爬，不是取法，没处理，照旧按被拦截回退。② 就算不拦，标题选择器 `a h3` 选中的是 h3，skill 取 h3 的 href（没有），每条都当成"链接不是 http(s)"丢掉，一条结果都没有。
  - **修法**——和 skill 不一样的两处。用户的 skill 在 DDG、Google 上本来就是坏的，偏离是为了修好它，**用户定：保留**：
    - DDG 的摘要选择器新旧两种容器都认：`[data-testid="result-snippet"], [data-result="snippet"]`（`search.ts` 的 `RESULT_SELECTORS`）。
    - 送进浏览器取结果的函数抽成导出的 `pickResults`（`browser.ts`，`page.evaluate(pickResults, selectors)`）：标题元素自己没有链接时用外面那层 `a`（`closest("a")`）的链接。Bing、DDG 的标题本身就是 `a`，行为不变。
    - 为了测试，playwright 的一页包成 `BrowserPage` 的那段抽成导出的 `playwrightPage(page)`，正式的驱动和测试共用。
    - 发现但没做：Google 现在给的链接是 `https://www.google.com/goto?url=<加密串>`，解不开；打开后 302 到真实地址（curl 验过），`web_fetch` 跟着跳转能读。原样交回，没有解包。
  - **测试**：录下的三页在 `packages/daemon/test/fixtures/web/`（`ddg.html`、`bing.html`、`google.html`，2026-10-10 搜"Node.js 最新版本"）。DDG、Bing 用和二狗一样的无头设置录（浏览器标识、语言、窗口）；Google 无头录不到，用有头、关掉自动化标记录。录完清理：去掉脚本、样式、图片、表单、页脚和会话令牌，浏览器里看不见的元素先标成行内 `display:none`（innerText 才和真浏览器一致，比如 Bing 藏起来的"阅读更多"）；查过没有 IP、位置、账号。`test/web/recorded-results.browser.test.ts` 10 条：三个引擎各取满 8 条、每条摘要非空，首条逐字对，DDG 旧选择器摘要全空（根因），Google 的 h3 取包着它的 a。**测法**（用户定：不加新依赖）：用已有的 playwright-core 起本机浏览器（按二狗同样的顺序找），所有请求拦下、只回录下的页面（不连真网络），经正式的 `playwrightPage` → `pickResults` 取结果；文件名带 `.browser` 标出要浏览器，找不到浏览器（比如 CI）每一条都跳过，原因写进测试报告（`ctx.skip`，验过）。一个文件起一次浏览器，10 条约 7 秒。把两处修复改回去，10 条里 7 条失败（验过）。
    - 第一版用了 happy-dom（新装的开发依赖）在测试里解析 HTML，用户不同意（装依赖算下载，要先问），已换掉：`package.json`、`package-lock.json` 和 main 一样，worktree 的 `node_modules` 里也删干净了（happy-dom 和它带进来的 entities、whatwg-mimetype、@types/whatwg-mimetype、buffer-image-size）。锁文件里剩下的 `happy-dom` 两处是 vitest 本来就有的可选 peerDependency 声明，main 上就有。
  - **冒烟**（`npm run smoke:web`，真网络，2026-10-10，换掉 happy-dom、变基之后）：
    ```
    == 联网搜索（ddg，4288 ms）==
    搜索: Node.js 最新版本 （5 条）

    1. Node.js — 下载 Node.js®
       https://nodejs.org/zh-cn/download
       Node.js® is a free, open-source, cross-platform JavaScript runtime environment that lets developers create servers, web apps, command line tools and scripts.

    2. Node.js
       https://nodejs.org/zh-cn/blog/release/
       3 天前Node.js® is a free, open-source, cross-platform JavaScript runtime environment that lets developers create servers, web apps, command line tools and scripts.
    ```
    `-- --engine bing`：5 条都有摘要（第 1 条 `https://nodejs.org/`，"Node.js® is a free, open-source, …"；这次 Bing 把"阅读更多"显示出来了，摘要末尾带着它，skill 一样，没处理）。`-- --engine google`：**被反爬拦截**（无头浏览器，见上面根因 ①；skill 同样被拦），冒烟里看不到 Google 的摘要，只能靠录下的页面测。
  - 变基到 main `79cf87bf`（57 号票，依赖没变），用进程列表确认没有别的 vitest 在跑之后，在 Git Bash 里 `ERGOU_TEST_WORKERS=2` 全量一次全绿：243 个文件、3589 条（录下结果页的 10 条在本机真浏览器里跑了，没跳过）；`tsc -p packages/daemon`、oxlint 0 报错。上一轮变基到 `bc251282` 时的全量里 `typed-shell.test.ts` 偶发失败一条（`git_status_diff` 回 error），单独重跑通过，和本票无关；这一轮没再出现。

- 2026-10-10 完成：DDG 改版换了摘要容器、Google 取链接的位置不对，两处偏离 search.mjs 是为了修好（用户的 skill 同样坏）；用户不同意装 happy-dom，测试改用已有的 playwright-core（没有浏览器时跳过）。全量 3589 条通过，冒烟 DDG、Bing 有摘要。压缩合并进 main。
