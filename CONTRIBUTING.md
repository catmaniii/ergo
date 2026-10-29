**中文** | [English](#english)

# 参与二狗

谢谢你愿意帮忙。提问题、改文档、修 bug、写插件、加一种语言都欢迎。issue 和 PR 用中文、英文都行。

## 先看哪些

- [README](README.md)：二狗是什么；[用户手册](docs/user-guide.md)：怎么装、怎么用。
- [开发者指南](docs/developer-guide.md)：仓库结构、架构、插件、测试、写代码的约定。
- [CONTEXT.md](CONTEXT.md)：术语表。代码、界面、文档用同一套词。
- [docs/adr/](docs/adr/)：设计记录，讲为什么这么做。
- 代码注释里的"N 号票"是开发时的内部记录编号，公开仓库里没有这些票；注释本身写清了做什么、为什么。

## 提问题

- **bug、想要的功能、使用上的问题**：到 [Issues](https://github.com/catmaniii/ergo/issues/new/choose) 照模板填。报 bug 请带上二狗、Node、pi 的版本和安装方式（**更多 · 设置 · 数据与设备 →「体检」**那一页能一眼看到这几样）。
- **安全问题**：不要开公开的 issue，见 [SECURITY.md](SECURITY.md)。

## 开发环境

只支持 **Windows 10 / 11**；**Node 22**（≥ 22.19，跟着 pi 走，[ADR-0031](docs/adr/0031-node-version-follows-pi.md)）；**Git for Windows**（测试要用 Git Bash）。

```powershell
git clone https://github.com/catmaniii/ergo.git
cd ergo
npm ci
npm run build:web
npm run test:fast
```

测试一律用临时目录和系统挑的端口，不碰你自己的 `~/.ergo` 和正在跑的二狗，也不联网、不花 token。详见[开发者指南 · 测试](docs/developer-guide.md#10-测试)。

## 改代码

1. **大一点的改动先开 issue 聊**：新功能、改架构、加依赖、改默认值，先说清要解决什么、打算怎么做，免得白做。小修小补直接提 PR。
2. **从 `main` 拉一个分支**，一个 PR 只做一件事。
3. **跑测试**：至少 `npm run test:fast`、`npm run typecheck`、`npm run lint`、`npm run i18n:check`；改了网页再跑 `npx vitest run --project web test/page-opens.test.ts`；改到守护进程主线、组合根、装配跑 `npm run test:integration`；改了服务管家跑 `npm run test:supervisor`。CI 会在 Windows 上再跑一遍。
4. **同一个 PR 里改文档**：用户看得到的改[用户手册](docs/user-guide.md)，模块和约定改[开发者指南](docs/developer-guide.md)——**两份都有中英版本，改一份要同步另一份**；新词加进 `CONTEXT.md`；取舍大的写一份 ADR；用户能感到的变化写进 `CHANGELOG.md`。
5. **守住约定**（详见[开发者指南 · 写代码的约定](docs/developer-guide.md#9-写代码的约定)）：
   - 给用户看的文字走 `t()`，中文、英文两份语言文件一起加；
   - 样式只用 `var(--token)`；
   - pi 只在 `runtime/agent-child/` 里用，模块边界有测试守着；
   - 写文件走 `util/atomic-file.ts`；
   - 标识符用英文，注释用中文（看不懂中文注释也没关系，PR 里用英文说明就行，我们来补）。
6. **不要提交**个人数据、密钥、本机路径、真实的截图数据。测试里像密钥的样本在运行时拼（`packages/daemon/test/helpers/fake-secrets.ts`）。
7. **新依赖**：写死精确版本、`package-lock.json` 一起提交，许可证要和 MIT 兼容；在 PR 里写为什么需要它。
8. **提交信息**：`<类型>: <一句话说清改了什么>`，类型用 `feat`、`fix`、`docs`、`test`、`refactor`、`chore`。

## 写插件、加语言

- **插件**：照[插件开发手册](docs/guides/plugin-development.md)，从一个最小的"笔记"插件讲起；用 AI 编程助手写的，让它按 `.claude/skills/ergo-plugin/SKILL.md` 的清单做。
- **语言**：先在自己的 `~/.ergo/locales/` 里试（[用户手册 · 语言](docs/user-guide.md#54-语言)），译完整了把目录放进 `packages/protocol/locales/<语言代码>/` 提 PR。

## 用 AI 编程助手

欢迎。仓库根目录的 `CLAUDE.md` 是写给 AI 编程助手看的规矩（不碰真数据、不起常驻服务、测试不联网……）。用它生成的改动，提交前请自己看一遍、跑过测试。

## 许可证

二狗用 [MIT 许可证](LICENSE)，版权归 ergo contributors。你提交的贡献同样按 MIT 授权。

## 行为准则

参与即表示同意遵守[行为准则](CODE_OF_CONDUCT.md)。

---

<a id="english"></a>

[中文](#参与二狗) | **English**

# Contributing to ergo

Thank you for helping. Questions, docs fixes, bug fixes, plugins and new languages are all welcome. Issues and PRs may be written in Chinese or English.

## Start here

- [README](README.en.md): what ergo is; [User Guide](docs/user-guide.en.md): installing and using it.
- [Developer Guide](docs/developer-guide.en.md): repository layout, architecture, plugins, tests, coding conventions.
- [CONTEXT.md](CONTEXT.md): the glossary (in Chinese). Code, UI and docs share one vocabulary.
- [docs/adr/](docs/adr/): decision records explaining why things are the way they are (in Chinese).
- "Ticket N" in code comments refers to internal development records that are not public; the comments themselves explain what and why.

## Asking and reporting

- **Bugs, feature requests, usage questions**: [open an issue](https://github.com/catmaniii/ergo/issues/new/choose) using the templates. For bugs, include the ergo, Node and pi versions and how you installed (the **Checkup** page under More · Settings · Data & devices shows all of them).
- **Security issues**: don't open a public issue; see [SECURITY.md](SECURITY.md).

## Development setup

**Windows 10 / 11** only; **Node 22** (≥ 22.19, following pi, [ADR-0031](docs/adr/0031-node-version-follows-pi.md)); **Git for Windows** (tests need Git Bash).

```powershell
git clone https://github.com/catmaniii/ergo.git
cd ergo
npm ci
npm run build:web
npm run test:fast
```

Tests always use temporary directories and system-chosen ports, never touch your own `~/.ergo` or a running ergo, never go online and never spend tokens. See [Developer Guide · Testing](docs/developer-guide.en.md#10-testing).

## Changing code

1. **Discuss bigger changes in an issue first**: new features, architectural changes, new dependencies, changed defaults — say what problem you're solving and how, so nobody's work is wasted. Small fixes can go straight to a PR.
2. **Branch from `main`**; one PR does one thing.
3. **Run the tests**: at least `npm run test:fast`, `npm run typecheck`, `npm run lint`, `npm run i18n:check`; for web changes also `npx vitest run --project web test/page-opens.test.ts`; for the daemon's main paths, composition root or assembly, `npm run test:integration`; for the supervisor, `npm run test:supervisor`. CI runs them again on Windows.
4. **Update docs in the same PR**: user-visible changes in the [User Guide](docs/user-guide.en.md), modules and conventions in the [Developer Guide](docs/developer-guide.en.md) — **both exist in Chinese and English; keep them in sync** (if you can't write Chinese, say so in the PR and we'll help); new terms in `CONTEXT.md`; an ADR for significant trade-offs; user-noticeable changes in `CHANGELOG.md`.
5. **Follow the conventions** (see [Developer Guide · Coding conventions](docs/developer-guide.en.md#9-coding-conventions)):
   - user-facing text goes through `t()`, with both the Chinese and English language files;
   - styles use only `var(--token)`;
   - pi is used only inside `runtime/agent-child/`, and module boundaries are enforced by tests;
   - write files through `util/atomic-file.ts`;
   - identifiers in English, comments in Chinese (English comments are fine in a PR; we can translate).
6. **Never commit** personal data, secrets, local paths or real data in screenshots. Secret-looking test samples are assembled at runtime (`packages/daemon/test/helpers/fake-secrets.ts`).
7. **New dependencies**: pin exact versions, commit `package-lock.json`, use MIT-compatible licenses, and explain in the PR why it's needed.
8. **Commit messages**: `<type>: <one line saying what changed>`, with types `feat`, `fix`, `docs`, `test`, `refactor`, `chore`.

## Plugins and languages

- **Plugins**: follow the [plugin guide](docs/guides/plugin-development.md) (in Chinese), starting from a minimal "notes" plugin; if an AI coding assistant writes it, have it follow the checklist in `.claude/skills/ergo-plugin/SKILL.md`.
- **Languages**: try it in your own `~/.ergo/locales/` first ([User Guide · Language](docs/user-guide.en.md#54-language)); once complete, put the directory in `packages/protocol/locales/<code>/` and open a PR.

## AI coding assistants

Welcome. `CLAUDE.md` at the repository root holds the rules for AI coding assistants (no real data, no long-running services, no network in tests…). Please review changes they generate and run the tests before submitting.

## License

ergo is under the [MIT License](LICENSE), copyright ergo contributors. Your contributions are licensed under MIT as well.

## Code of conduct

By participating you agree to follow the [Code of Conduct](CODE_OF_CONDUCT.md).
