# 81 — web_search 的结果摘要是空的

Status: ready-for-agent
Blocked by: None — can start immediately
Spec: 70 号票（web_search、web_fetch）

## What to build

70 号票合并后主会话跑了真网络冒烟（`npm run smoke:web`，2026-10-10）：搜"Node.js 最新版本"，前 5 条结果的标题和链接都对，但**每条的摘要都是空的**。用户的 `~/.pi/agent/skills/web-search/search.mjs` 是能取到摘要的。

- 对照 `search.mjs` 查清摘要为什么没取到（DDG、Bing、Google 三个引擎分别看）；照它的取法修好。
- 测试用录下来的结果页 HTML 做假数据（不连真网络），三个引擎各一份。

## Acceptance criteria

- [ ] 三个引擎的结果都带摘要；单元测试用录下的页面断言摘要非空。
- [ ] 主会话合并后再跑一次 `npm run smoke:web`，摘要不空。
- [ ] 所有测试通过（vitest），lint（oxlint）无报错。

## Comments
