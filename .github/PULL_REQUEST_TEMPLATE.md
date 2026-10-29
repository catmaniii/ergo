<!-- 中文、英文都行 / Chinese or English are both fine -->

## 改了什么 / What changed

<!-- 一两句话说清改了什么、为什么。关联的 issue：Fixes #… / One or two sentences on what and why. Related issue: Fixes #… -->

## 怎么验证的 / How it was tested

<!-- 跑了哪些测试；改了界面的附一张截图（用原型的编的数据，不要真实数据）/ Which tests you ran; for UI changes, a screenshot using the prototype's sample data, not real data -->

## 检查 / Checklist

- [ ] `npm run test:fast`、`npm run typecheck`、`npm run lint`、`npm run i18n:check` 都过了 / all pass
- [ ] 改了网页：`npx vitest run --project web test/page-opens.test.ts` 过了 / web changes: page-opens passes
- [ ] 改到守护进程主线、组合根、装配：`npm run test:integration` 过了 / daemon main paths: integration lane passes
- [ ] 给用户看的文字走 `t()`，中文和英文语言文件都加了 / user-facing text uses `t()` with both Chinese and English entries
- [ ] 文档跟着改了（用户手册、开发者指南的中英两份，`CONTEXT.md`、ADR、`CHANGELOG.md` 按需）/ docs updated (both languages of the user and developer guides; `CONTEXT.md`, ADRs, `CHANGELOG.md` as needed)
- [ ] 没有提交个人数据、密钥、本机路径 / no personal data, secrets or local paths committed
- [ ] 新依赖写死了精确版本、许可证和 MIT 兼容，PR 里写了理由 / new dependencies are pinned, MIT-compatible, and justified above
