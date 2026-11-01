# ergo（二狗）

给在这个仓库里干活的 AI 编程助手（Claude Code 等）看的说明。人类贡献者请先看 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 这是什么

ergo（二狗）是一个装在用户自己 Windows 电脑上的个人 AI 助理：守护进程（`packages/daemon`）管 agent 子进程、事件日志、守卫和网页；服务管家（`packages/supervisor`，命令 `lsm`）是单独的小进程，托管常驻服务。只支持 Windows，Node 22（跟着 pi 走，ADR-0031）。

## 动手前先读

- **`CONTEXT.md`**：术语表。代码、界面、文档用同一套词；新概念先在这里定名。
- **`docs/architecture/README.md`**：系统总览、仓库结构、架构、插件、网页、多语言。
- **`docs/architecture/development.md`**：搭环境、常用命令、写代码的约定、测试。
- **`docs/architecture/adr/`**：和你要动的部分相关的设计记录。推翻已有决定之前先说明理由。
- 写插件、数据源、运行时、项目服务，改界面：读下面"开发 skill"里对应的那一份。
- 改记忆系统：`docs/architecture/memory-system.md`（有测试核对接口表和路径）。

## 开发 skill

每份是一个普通的 Markdown 文件，写了步骤、能照抄的例子和交活清单。Claude Code 会自动发现它们；别的 agent（Codex 等）直接读对应的文件就行。别的几份都以 `ergo-dev` 为前提。

| skill | 干什么 | 路径 |
|---|---|---|
| `ergo-dev` | 搭环境、常用命令、怎么跑测试、测试隔离（绝不碰真数据和真端口）、提交和 PR 规矩 | `.claude/skills/ergo-dev/SKILL.md` |
| `ergo-plugin` | 写插件：能注册什么、网页部分、给 agent 的工具和上下文块、设置页、数据契约和"连数据删" | `.claude/skills/ergo-plugin/SKILL.md` |
| `ergo-data-source` | 写数据源插件：授权、同步、存本地、在哪给用户看、怎么断开和删除 | `.claude/skills/ergo-data-source/SKILL.md` |
| `ergo-agent-runtime` | 接一个新的 agent 运行时（比如 Codex）：一个会话一个子进程、消息和工具怎么转、记录怎么进二狗 | `.claude/skills/ergo-agent-runtime/SKILL.md` |
| `ergo-project-service` | 写能被二狗托管的项目服务：服务管家怎么托管、怎么打开、怎么报事件、怎么登记成 MCP | `.claude/skills/ergo-project-service/SKILL.md` |
| `ergo-web-ui` | 改界面：多语言（中英都要）、十一套风格、手机和宽屏、页面测试、哪些字不能直接写在界面上 | `.claude/skills/ergo-web-ui/SKILL.md` |

## 硬规矩

- **不碰真数据**：不读、不写、不打印用户主目录下的 `.ergo`、`.ssh`，也不碰服务管家的数据目录（`%LOCALAPPDATA%\ergo\supervisor`）。测试一律用临时目录。
- **不起常驻服务、不碰正在跑的二狗**：不占用 8810、8811、7420 端口；测试里的守护进程由测试底座在系统挑的端口上起、测试结束销毁。
- **测试不联网**：测试里只许连本机回环。`vitest.setup-no-network.mjs` 只拦全局 `fetch`，`net`、`tls` 直连拦不住，要自己守住；要测网络就起本机假服务。不调真的模型、不花 token。
- **密钥永不进仓库**：测试里像真密钥的样本在运行时拼（`packages/daemon/test/helpers/fake-secrets.ts`）。
- **pi 的边界**：`@earendil-works/*` 只能在 `packages/daemon/src/runtime/agent-child/` 里引用。
- **模块边界**：项目系统外面只 import `projects/api.ts`；内核只 import 插件的 `api.ts`；网页插件之间不互相 import。边界测试会红。
- **类型剥离**：相对导入写 `.ts` 后缀；不用 `enum`、`namespace`、构造函数参数属性；纯类型导入写 `import type`。
- **写文件走 `util/atomic-file.ts`**（先写临时文件再改名，Windows 上会重试）。
- **给用户看的文字走 `t()`**，中英两份语言文件一起加（`packages/protocol/locales/`）；给模型看的、日志标 `@i18n-ignore`。写死中文的棘轮基线是 0。
- **样式只用 `var(--token)`**，不写死颜色。
- **依赖写死精确版本**；加依赖、加带安装脚本的依赖前先说明理由。

## 语言

- 文档、注释、提交信息用中文；标识符用英文。README、`docs/architecture/` 和 `docs/user-guide/` 里有中英两份的文档，改一份要同步另一份。
- 系统提示文件里的占位符名用中文（`{{拉回次数}}`），是"标识符用英文"的例外。

## 常用命令（仓库根目录，PowerShell 或 Git Bash）

```sh
npm ci
npm run test:fast          # 改完每次跑（约 2 分钟）
npm run typecheck
npm run lint
npm run i18n:check -- --data-dir <临时目录>   # 不带它会读 ~/.ergo/locales
npm run build:web          # 改了网页时；再跑 npx vitest run --project web test/page-opens.test.ts
npm run test:integration   # 改到守护进程主线、组合根、装配时
npm run test:supervisor    # 改了 packages/supervisor 时
npm run check:ops -- <ops.json 或方案.json> --url <服务地址>   # 不起二狗校验运营接口清单和方案
```

Windows 上跑测试前确认 `where bash` 的第一条是 Git for Windows 的 `bash.exe`；几套测试同时跑时设 `ERGO_TEST_WORKERS=2`。工作区的文本文件是 CRLF（仓库里是 LF）：脚本改文件时按 `\n` 匹配多行会失败，用 `\r?\n` 或先归一。

## 做完一件事

1. 跑上面和改动相关的测试，加上 `typecheck`、`lint`、`i18n:check`。
2. 改了行为就在同一个提交里改文档：用户看得到的改 `docs/user-guide/` 里对应的章，模块和约定改 `docs/architecture/README.md`、`development.md`（中英两份），新词改 `CONTEXT.md`，取舍大的写一份 ADR，用户能感到的变化写进 `CHANGELOG.md`。
3. 提交信息：`<类型>: <一句话说清改了什么>`，类型用 `feat`、`fix`、`docs`、`test`、`refactor`、`chore`。

## 问题和需求

在 GitHub Issues 上；安全问题按 `SECURITY.md` 私下报告，不要开公开的 issue。单一上下文：根目录一个 `CONTEXT.md`，决策记录在 `docs/architecture/adr/`。
