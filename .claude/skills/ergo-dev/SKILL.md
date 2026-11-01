---
name: ergo-dev
description: 二狗（ergo）仓库的开发基础。在这个仓库里改代码、跑测试、起守护进程或服务管家、提交、提 PR 之前先读：搭环境、改什么跑什么测试、测试隔离（绝不碰真数据和真端口）、提交和 PR 规矩。写插件、数据源、运行时、项目服务、改界面的 skill 都以它为前提。
---

# 二狗开发基础

先读 `AGENTS.md`（硬规矩）和 `CONTEXT.md`（术语，代码、界面、文档用同一套词）。系统总览在 `docs/architecture/README.md`，命令和测试的完整说明在 `docs/architecture/development.md`，设计取舍在 `docs/architecture/adr/`。

| 要做的 | 接着读 |
|---|---|
| 写、改插件 | `.claude/skills/ergo-plugin/SKILL.md` |
| 接一种外部数据 | `.claude/skills/ergo-data-source/SKILL.md` |
| 接一个 agent 程序（Codex 这类） | `.claude/skills/ergo-agent-runtime/SKILL.md` |
| 写能被二狗托管的服务 | `.claude/skills/ergo-project-service/SKILL.md` |
| 改网页 | `.claude/skills/ergo-web-ui/SKILL.md` |

## 1. 搭环境

- 只支持 Windows 10 / 11。Node 22（≥ 22.19）：`node -v` 看。
- Git for Windows：`where bash` 的第一条要是 Git 的 `bash.exe`。第一条是 `C:\Windows\System32\bash.exe` 时，PowerShell 里先跑 `$env:PATH = "C:\Program Files\Git\bin;" + $env:PATH`。
- 不在东八区的机器设 `TZ=Asia/Shanghai` 再跑测试（测试里的日期按 +08:00 写，CI 也这样设）。

```powershell
npm ci
npm run build:web
npm run test:fast
```

三条都退出码 0 才算环境好了。`test:fast` 约 2 分钟。

## 2. 改什么跑什么

每次都跑：`npm run typecheck`、`npm run lint`、`npm run i18n:check -- --data-dir <临时目录>`，加上改动相关的测试。提 PR 前跑一次 `npm run test:fast`。

| 改了 | 再跑 |
|---|---|
| 一个模块 | `npx vitest run <测试文件或目录>`；按名字挑：`npx vitest run --project daemon -t "中止"` |
| 网页 | `npm run build:web`，`npx vitest run --project web test/page-opens.test.ts` |
| 守护进程主线、组合根、装配 | `npm run test:integration`（十几分钟），或者只跑相关的 `packages/daemon/test/main/<名字>.test.ts` |
| `agent-host/`、`runtime/`、系统提示 | `npm run test:contract` |
| `packages/supervisor` | `npm run test:supervisor` |
| 插件宿主、手册摘录的代码 | `npx vitest run packages/daemon/test/plugins/plugin-guide-doc.test.ts` |

几套测试同时跑时设 `ERGO_TEST_WORKERS=2`。

## 3. 隔离：绝不碰真的

二狗可能就在这台机器上跑着。这些一律不碰：

- **数据**：`~/.ergo`、`~/.ssh`、`~/.claude`、`%LOCALAPPDATA%\ergo\supervisor`。
- **端口**：8810、8811（守护进程）、7420（服务管家）、8090（语音合成）是常见的默认值，不是全部，机器上还可能有别的常驻服务。别写死端口，用系统挑的（`ports.ts` 的 `freePort`）。
- **计划任务** `LocalServiceManager`：名字固定，一台机器一个。`install-autostart`、`uninstall-autostart` 只在测试里跑，设 `ERGO_AUTOSTART_TASK_FILE` 换成一个 JSON 文件。
- **真模型、外部网络**：测试不花 token、不连外网。

有几条命令默认就连真的，要换掉：

| 命令 | 默认碰到 | 这样跑 |
|---|---|---|
| `npm run i18n:check` | 读 `~/.ergo/locales` | `-- --data-dir <临时目录>` |
| `npm run smoke:page` | 打开 8810 上的二狗 | `-- http://127.0.0.1:<自己的端口>/` |
| `npm run ergo -- start` 和 `svc` | 真的服务管家、`~/.ergo` | 同时设临时的 `ERGO_DATA_DIR`、`LSM_DATA_DIR` 和空闲的 `ERGO_SVC_PORT`（`packages/daemon/test/cli/cli.test.ts` 这样做） |
| `node packages/supervisor/bin/lsm.mjs`（`lsm`）的 `reload`、`start`、`stop`、`status` | 端口读数据目录的 `registry/manager.yaml`，没有这个文件就是 7420。它不认 `ERGO_SVC_PORT`，只设 `LSM_DATA_DIR` 照样打到真的服务管家 | 先在临时目录写 `registry/manager.yaml` 的 `port`，再设 `LSM_DATA_DIR=<临时目录>`（`validate` 不连管家）。例子见 ergo-project-service 第 6 节 |
| `npm run backup`、`npm run memory:acceptance` | 真的数据目录 | 设临时的 `ERGO_DATA_DIR` |
| `npm run memory:build`、`npm run memory:rejudge` | 真的数据目录，还调真模型 | 开发时不跑 |

写测试用现成的底座（都在 `packages/daemon/test/helpers/`）：

| 要什么 | 用 |
|---|---|
| 真的守护进程（主切面：临时数据目录、系统挑的端口，模型是按剧本回话的 faux） | `daemon.ts` 的 `startTestDaemon`，`frontend.ts` 的 `TestFrontend` 扮演网页 |
| 只装几个插件（假内核，不起进程） | `plugin-kernel.ts` 的 `startPluginKernel` |
| 自己拉子进程 | 环境用 `user-profile.ts` 的 `withEnv(process.env, NO_LSM_ENV, tempUserProfileEnv(home), { ERGO_DATA_DIR: dir })`；目录用 `temp-dir.ts` 的 `makeTempDir`，端口用 `ports.ts` 的 `freePort` |
| 外部服务 | 本机假服务，照 `fake-openai.ts`、`fake-looki.ts`、`fake-imap.ts` |
| 像真密钥的样本 | `fake-secrets.ts`，运行时拼，仓库里不出现 |

`vitest.setup-no-network.mjs` 只拦全局的 `fetch`。`net`、`tls` 直连它拦不住，自己只连 127.0.0.1。

几个坑：拨时钟跨过 03:00 会唤醒记忆管理员，`startTestDaemon` 给了 `clock` 时默认停掉记忆插件，测记忆的写 `memoryPlugin: true`。别在产品替换文件的途中轮询读它（Windows 上会 EPERM），等产品给的"做完了"信号。超时只为"慢"放宽，断言不放松。

## 4. 想在真页面上看一眼

大多数界面改动看原型就够（见 ergo-web-ui）。要真的守护进程时，起一个隔离的前台实例，用完就停：

1. 建一个临时目录 `<d>`，写 `<d>/config/ergo.json`（UTF-8，不带 BOM），端口挑两个空闲的：
   ```json
   {"ports":{"local":18810,"external":18811},"voice":{"recognizer":{"python":"none"},"speech":{"url":"http://127.0.0.1:1"}}}
   ```
   `voice` 这一段让语音不去碰本机真的 8090。
2. 这个窗口里设 `ERGO_DATA_DIR=<d>`，`HOME`、`USERPROFILE`、`APPDATA`、`LOCALAPPDATA` 都指到 `<d>` 下面，去掉 `LSM_URL`、`LSM_SERVICE_ID`、`LSM_TOKEN`、`LSM_PROTOCOL`、`DEEPSEEK_API_KEY`。
3. `npm run build:web`，再 `node packages/daemon/src/main.ts`。日志出现"二狗守护进程已启动"。没有 key 时秘书照常起来，跟它说话回"还没配模型"。
4. `npm run smoke:page -- http://127.0.0.1:18810/`，输出里有"打开正常"（隔离的 HOME 下它不是最后一行），退出码 0。
5. 同样的环境下 `node packages/daemon/src/stop.ts` 停掉。

常驻的二狗只由服务管家托管，步骤在 `docs/user-guide/install.md` 的"从源码安装"。

## 5. 写代码

硬规矩在 `AGENTS.md`。这些容易忘：

- 模块边界由测试守着：`packages/daemon/test/pi-boundary.test.ts`、`packages/daemon/test/projects/boundary.test.ts`、各插件的 `boundary.test.ts`。
- 每个阈值的默认值只在它自己的模块里定一次。
- 模块只从 `packages/daemon/src/config/data-dir.ts` 的 `dataDirLayout()` 取路径。
- 标识符用英文，注释和提交信息用中文；看不懂中文就在 PR 里用英文说。

## 6. 提交和 PR

1. 大改动（新功能、改架构、加依赖、改默认值）先开 issue 说清要解决什么。小修小补直接提 PR。
2. 从 `main` 拉分支，一个 PR 做一件事。
3. 提交信息：`<类型>: <一句话说清改了什么>`，类型是 `feat`、`fix`、`docs`、`test`、`refactor`、`chore`。
4. 改了行为就在同一个 PR 里改文档：界面上看得到的改 `docs/user-guide/`，模块和写法改 `docs/architecture/`（中英两份都改），新词进 `CONTEXT.md`，取舍大的在 `docs/architecture/adr/` 写一份，用的人感觉得到的进 `CHANGELOG.md`。
5. 新依赖：写死精确版本、`package-lock.json` 一起提交、许可证和 MIT 兼容、PR 里写理由。
6. 个人数据、密钥、本机路径、真实截图不进仓库。界面截图用原型的编的数据。
7. PR 照 `.github/PULL_REQUEST_TEMPLATE.md` 填。CI 在 Windows 上再跑一遍。

## 交活清单

- [ ] `npm run typecheck`、`npm run lint`、`npm run i18n:check -- --data-dir <临时目录>` 退出码都是 0。
- [ ] 第 2 节表里相关的测试都过了；跳过的（比如本机没有 Chrome）写明。
- [ ] `git status` 里只有这次要改的文件。
- [ ] 没有一步碰过第 3 节列的真数据和真端口。
