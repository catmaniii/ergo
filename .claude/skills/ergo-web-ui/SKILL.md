---
name: ergo-web-ui
description: 改二狗（ergo）网页界面时用：加页面、改样式、加界面文字、调手机和宽屏布局、改 packages/web 下的页面和组件、加原型的假数据。讲多语言（中英都要）、十一套风格、页面测试、哪些字不能直接写在界面上。
---

# 改二狗界面

先读 `.claude/skills/ergo-dev/SKILL.md`。网页插件的写法在 ergo-plugin。原则在 `docs/architecture/README.md` 的"网页"一节，风格的设计理由在 `docs/architecture/adr/0021-visual-styles-tokens-in-ts-fonts-from-gateway.md`，多语言在 `docs/architecture/adr/0029-i18n-runtime-in-protocol-one-active-language.md`。

## 东西在哪（`packages/web/`）

| 目录 | 放什么 |
|---|---|
| `src/state/` | 把事件流归并成界面状态的纯函数，不依赖 React 和 DOM |
| `src/app/` | 连接、路由（`route-hash.ts`）、HTTP（`daemon-http.ts`）、主题、语言 |
| `src/ui/` | 共用部件：会话、卡片、图标（`icons.tsx`） |
| `src/pages/` | 各页面 |
| `src/plugins/` | 网页插件宿主、清单、各插件 |
| `src/visual-styles/` | 十一套风格的 token 和规则 |
| `src/styles/` | 经典风格的规则，只用 `var(--token)` |
| `src/prototype/` | 只属于原型的假连接、假数据 |

## 看效果：不用守护进程

```powershell
npm run build:web
```

直接打开 `packages/web/dist/index.html`（`file://`）就是原型，全是编的数据。地址带 `?lang=en` 看英文，`?demo-plugins-off=memory,reminders` 看插件停用，`?demo-plugins-removed=<名字>` 看移除。

无头 Chrome 里换风格和深浅：`localStorage.setItem("ergo-style", "<风格 id>")`、`localStorage.setItem("ergo-theme", "dark")`，然后刷新。

要真数据按 ergo-dev 第 4 节起隔离的实例。

## 1. 文字：一律走 `t()`，中英都加

写死中文的棘轮基线是 0（`packages/daemon/test/i18n/hardcoded.test.ts`），写一个就红。

```tsx
import { t } from "../../state/index.ts";
<button>{t("pages.demo.save")}</button>
```

- 句子放 `packages/protocol/locales/zh-CN/<区域>.json` 和 `en/<区域>.json`，**两边都加**，插值参数要一样。文件名就是 key 的第一段。
- key 写 `<区域>.<模块或页面>.<含义>`，各段小驼峰，说的是意思不是原文。网页只能用 `WEB_NAMESPACES` 里的区域（`packages/protocol/src/i18n/catalog.ts`：`common`、`shell`、`ui`、`app`、`pages`、`state`……）。网页插件放 `ui.json` 的 `ui.plugins.<名字>.*`。
- 句子中间放元素用 `<T k="…" params={…} />`（`src/ui/i18n.tsx`）。单复数：参数里有 `count` 时写 `_one`、`_other` 两条。
- **模块顶层不调 `t()`**，那时可能还没装上语言。写成函数或取值函数：`get title() { return t("…"); }`。`memo` 了的组件、`useMemo` 里用了 `t()` 的，调 `useLocale()` 或放进依赖。
- 不是给人看的中文才标 `@i18n-ignore`，原因只能是 `model`、`log`、`fixed`、`data`。
- 改完 `npm run i18n:check -- --data-dir <临时目录>`，英文缺句子时退出码 1。

## 2. 哪些字不能直接写在界面上

构建产物里查这几条，`packages/web/test/build.test.ts` 红了就是写错了：

| 别写 | 写 | 怎么写 |
|---|---|---|
| 秘书 | 用户给它起的名字 | `<AssistantName />`；只能放纯文字的地方用 `useNamedPlain()`（`src/ui/assistant-name.tsx`）；守护进程写的话用 `<NamedText text={…} />` |
| 待我处理 | 待办 | 语言文件里写"待办" |

例外只有两处：导航上那一项写"秘书"，秘书页标题写"个人秘书：<名字>"。代码、领域术语、给模型的话照旧说秘书，它们不进页面。

别的同类词（测试不查，一样别写）：

- 代码标识符不上界面：负责人（英文 owner），不是 maintainer。
- 给普通人看的话里不出现守护进程、事件日志、宿主协议这类实现词。术语以 `CONTEXT.md` 为准。
- 不用表情符号当图标，用 `<Icon name="…" />`（`src/ui/icons.tsx`），大小跟字号、颜色跟字色。
- 用户的真实名字、路径不进原型的假数据，编的要明显是编的。

## 3. 样式：十一套风格，只换皮

风格 id：`classic` 经典、`paper` 暖纸手帐、`grid` 净白格栅、`night` 夜航仪表、`candy` 软糖圆角、`glass` 玻璃光纹、`blueprint` 工程蓝图、`sticker` 贴纸便当、`pixel` 像素小屋、`ink` 水墨国风、`magazine` 复古杂志。每套都有浅色、深色。清单在 `src/visual-styles/index.ts`。

页面结构、功能是共享的，风格只覆盖 token 和样式。所以：

- **只用 `var(--token)`**，不写死颜色、圆角、阴影。名字在 `src/visual-styles/tokens.ts` 的 `TOKEN_NAMES`。
- 容易用错的：字体分 `font-body`、`font-title`、`font-num`；强调色 `primary`（当字用）和实色块 `primary-fill` 分开；边框 `card-border`（有框的卡片）和 `panel-border`（底板）分开。
- 经典的规则写在 `src/styles/`，别的风格的写在 `src/visual-styles/<id>/style.css`，每条以 `:root[data-style="<id>"]` 开头，`@keyframes` 名字以 `<id>-` 开头，不写 `@font-face`。
- 新加的颜色 token 要在对比度测试里过：正文 4.5:1，大字 3:1。
- 页面运行时不请求任何外部地址。字体由 `fonts` 写 fontsource 的包，构建时拷进来。
- 加一套风格：建 `<id>/style.ts`、`style.css`，在 `index.ts` 登记一行（`docs/architecture/README.md` 的"视觉风格"有步骤）。

改完跑：

```powershell
npx vitest run packages/web/test/visual-styles packages/web/test/app/theme.test.ts packages/web/test/build.test.ts
```

## 4. 手机和宽屏

- 分界是 `App.tsx` 的 `WIDE_MIN`（600）：以下导航在底部一条，以上在左边一栏。页面从 `PageSectionProps.wide` 拿。
- 内容跟着所在栏的宽度走时用 `@container page (max-width: 560px)`：宽屏分栏后，一栏可能比窗口窄得多。
- 手机用手指点：别只靠悬停。`@media (hover: hover)`、`@media (pointer: coarse)` 分开写。
- 还有一种窄的：侧边栏模式 `?ergo=side`（约 320 宽）。

页面测试固定量两个宽度：390×844 和 1280×800。手机和宽屏都看过才算改完。

## 5. 加页面

1. 能做成插件的做成插件（`pages` 插槽，见 ergo-plugin）。
2. 核心页：`src/app/route-hash.ts` 的 `MORE_PAGES` 加一项，`src/pages/` 写组件。加进 `MORE_PAGES` 的自动被页面测试切到。
3. 别的地址加进 `packages/web/test/page-opens.test.ts` 的 `PAGES`。英文迁好的元素加进 `EN_DONE`。
4. 要守护进程的数据：见下一节。
5. 原型不能空着：`src/prototype/` 给假数据（`fake-connection.ts`、`fake-plugins.ts`、`fake-data-sources.ts`），不然 `file://` 打开是空的。
6. 状态逻辑写进 `src/state/` 的纯函数，从 `state/index.ts` 导出，测试用录下的事件流回放（`packages/web/test/state/recordings/`）。

## 6. 网页要取数据

页面要的数据不在事件流里时，加一个 HTTP 接口。路径、网关、组合根、网页共七处要改，全列在 `.claude/skills/ergo-web-ui/web-data.md`，照日历按月取写。

## 怎么测

| 测什么 | 命令 |
|---|---|
| 状态层、组件、风格、构建检查 | `npx vitest run packages/web/test/<目录或文件>` |
| 打开每一页不崩（中英、手机宽屏、插件停用都走一遍，要几分钟） | `npx vitest run --project web test/page-opens.test.ts`（自己构建一遍，不写 `dist/`） |
| 只跑其中一部分 | 加 `-t "手机宽"` |
| 中英文齐不齐 | `npm run i18n:check -- --data-dir <临时目录>` |
| 真守护进程上看 | `npm run smoke:page -- http://127.0.0.1:<自己的端口>/`，不带地址会打开真的 8810 |

本机没有 Chrome 时 `page-opens` 是跳过，不是过了，要写明。

测试 import 到 `src/pages/MorePage.tsx` 的要 mock `src/app/build-info.ts`（它的虚拟模块只在构建时有），照 `packages/web/test/pages/settings-groups.test.ts` 开头那行。

## 完成前检查

- [ ] 界面上每个新字都走 `t()`，中英两份都有。`i18n:check` 过，`packages/daemon/test/i18n/hardcoded.test.ts` 过。
- [ ] `packages/web/test/build.test.ts` 过：页面里没有"秘书""待我处理"。
- [ ] 没有写死的颜色、圆角、阴影；改了 token 或风格的，`packages/web/test/visual-styles` 过。
- [ ] 原型里手机宽（390）、电脑宽（1280）都看过，`?lang=en` 看过，深色看过。
- [ ] 动了共用样式的，抽几套差别大的风格看过（`classic`、`night`、`pixel`、`glass`）。
- [ ] `page-opens` 过了，没跳过。
- [ ] PR 里附原型的截图，不用真实数据。
