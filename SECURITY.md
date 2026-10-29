**中文** | [English](#english)

# 安全

ergo（二狗）跑在你自己的电脑上，能读写文件、跑命令、联网、以你的名义发东西。这份文档讲它靠什么把关、已知哪里还没收紧，以及发现漏洞怎么报。

## 报告漏洞

**请不要开公开的 issue。** 在本仓库的 **Security** 页面点 **Report a vulnerability**（GitHub 的私密漏洞报告），写清楚：

- 二狗的版本（设置 · 关于二狗）、Node 版本、安装方式；
- 怎么复现（越小越好）、影响是什么（谁能做到什么）；
- 你有没有在公开场合提过。

我们尽量在 7 天内回复，修好后在发布说明里致谢（你不想署名就不署）。二狗还在 1.0 之前，只修最新的版本。

## 二狗靠什么把关

### 两个端口和外网入口

守护进程的两个端口**都只监听 127.0.0.1**：

- **本机端口**（默认 8810）**自动信任**：每个请求校验 Host 是 `127.0.0.1` / `localhost`（防 DNS 重绑定），带了 Origin 就必须是这两个源之一（防别的网站跨站调用）。
- **外网端口**（默认 8811）**每个请求都要设备凭证**：没有凭证只拿得到页面本身（配对页）和配对接口，别的一律 401；以后加的接口自动在这道门后面。

从外面访问（Tailscale、自建 Headscale、VPS 隧道 + nginx，见[用户手册](docs/user-guide.md#6-从外网访问手机平板)）**只能接 8811**。**把 8810 经 Tailscale Serve、隧道或反向代理接出去，等于让整个 tailnet 或整个互联网免认证进你的二狗**——这是配置错误，不是二狗的漏洞，但向导和文档都会拦着你这么做。

### 设备配对

- 新设备打开外网地址 → 页面显示设备名、6 位短码、8 位短指纹 → 电脑上的待办里出现配对请求卡，你核对一致才批准 → 新设备 5 分钟内领走凭证。
- 凭证是 256 位随机数，服务端只存哈希；放在 `HttpOnly`、`Secure`、`__Host-` 前缀的 cookie 里，页面脚本读不到。有效期 365 天、用一次往后推；领到后 24 小时内一次没用过就作废。
- 同一来源 10 分钟内最多 5 个配对请求；待批的 5 分钟后过期；看起来像程序、爬虫的请求在卡片上会提示。
- 设置 · 已配对设备里随时能吊销，吊销后这台设备开着的连接立刻断开。

### 守卫

agent 的**每一次工具调用**在执行前都过守卫（一个纯函数，同样的输入永远同样的判定），判定和依据都存进工具调用详情、用大白话写清：

- **关注类别 × 六档处置**：花钱、以你的名义对外发送、删除或覆盖、不可逆的提交、账户与安全、越出项目目录……每类可以设成直接做只记录 / 做完告诉我 / 计划里列了才做 / 先问我 / 交给我做 / 永不。
- **计划里的授权项**：长程任务开工前你确认一次的授权（种类、范围、次数、有效期），超出的先问你。
- **时序规则**：比如"删除前必须已备份""读过密钥之后不许往外送"。
- **三条硬底线**谁说了都不放：不写二狗自己的配置区、数据库区和程序目录；不读密钥区；确定要把密钥发出去的不做。
- 判断不了的（缺环境事实、参数没法规范化）一律先问你。
- Claude Code 这类外部运行时的工具调用同样过二狗的守卫、留记录。

### 密钥区

- 模型的 API key 等密钥放在数据目录的 `secrets\` 里，**由服务管家读出来**、经环境变量交给守护进程；守护进程再经 stdin 交给需要的 agent 子进程，不进子进程的环境变量。
- 网页上也能填模型的 key（首次设置向导、设置 · 模型）：守护进程把 key 写进 `secrets\` 里同一个文件（目录 `700`、文件 `600`、先写临时文件再改名），只写不读——它本来就从服务管家注入的环境变量里拿 key。接口、页面、日志里都没有 key 的原文；写入后新起的会话就用新的，不用重启。
- 守卫的硬底线不许任何 agent 读密钥区，也不许把认出来的密钥往外送。
- 密钥不进仓库、不进服务管家的注册表（注册表里只写"从哪个文件读"）。服务管家自己的密钥（网页口令、tailnet 证书）在它数据目录的 `.secrets\` 里。

### 数据留在本机

对话、你说过的原话、记忆、档案、账本都在本机的数据目录里，每晚做一致性快照。调用大模型时只发这一轮用得上的内容。网页运行时不请求任何外部地址（字体也由二狗自己提供）。agent 子进程放在 Windows Job 对象里，环境变量只给白名单。

## 已知的限制

二狗按"功能先跑通、安全后接"（[ADR-0026](docs/adr/0026-features-first-security-later.md)）开发，下面这些是**已知的、有意暂时没收紧的**，报告时不用再报一遍（但欢迎提改进方案）：

- **本机端口信任本机上的任何程序**：只要能连 `127.0.0.1:8810`，就能调二狗的接口。二狗假定这台电脑本身是可信的。
- **agent 以你的 Windows 账号运行，没有系统级沙箱**：守卫是策略层的把关（判定、审批、记录），不是隔离；系统级沙箱、审查 agent、高危操作的原生签名确认还在计划里。
- **默认值偏宽**：秘书默认能联网；老版本升级上来的数据目录里"有风险的事先问我""任务超预算就停下"默认关着（新装的开着）。
- **转发的项目服务和二狗同源**：项目上线的服务经 `/apps/<名字>/` 转发，它的页面脚本能带着你的设备凭证调二狗的接口（读不到凭证原值，但能用）。现在只转发你确认上线的服务；以后改成独立的源（[开发者指南](docs/developer-guide.md#48-转发本机服务的页面)）。
- **设备凭证是持有即可用的**（bearer）：设备被偷、浏览器数据被拷走时，请在已配对设备里吊销。
- **站在按域名分流的前门后面**、前门又没开 `proxy_protocol` 时，配对请求的限频按 127.0.0.1 算，实际上是全局的（仍然安全，只是陌生人刷请求时你自己的配对也要等）。
- **发给模型的内容由模型服务商处理**：每一轮用得上的对话和资料会发给你配的模型（现在是 DeepSeek），请按它的隐私条款判断。

---

<a id="english"></a>

[中文](#安全) | **English**

# Security

ergo (二狗) runs on your own computer and can read and write files, run commands, go online and send things in your name. This document explains what guards it, what is knowingly not yet locked down, and how to report vulnerabilities.

## Reporting a vulnerability

**Please don't open a public issue.** On this repository's **Security** page, click **Report a vulnerability** (GitHub private vulnerability reporting) and include:

- ergo's version (Settings · About Ergo), Node version, how you installed it;
- how to reproduce it (the smaller the better) and its impact (who can do what);
- whether you have mentioned it anywhere public.

We aim to reply within 7 days and will credit you in the release notes once it's fixed (or not, if you prefer). ergo is pre-1.0; only the latest release receives fixes.

## What guards ergo

### Two ports and outside access

Both of the daemon's ports **listen only on 127.0.0.1**:

- The **local port** (default 8810) is **trusted automatically**: every request must have Host `127.0.0.1` / `localhost` (against DNS rebinding), and Origin, if present, must be one of those (against cross-site calls from other websites).
- The **external port** (default 8811) **requires a device credential on every request**: without one you only get the page itself (the pairing page) and the pairing API; everything else is 401, and endpoints added later are automatically behind this gate.

Outside access (Tailscale, self-hosted Headscale, VPS tunnel + nginx; see the [User Guide](docs/user-guide.en.md#6-access-from-outside-phone-tablet)) **must only connect to 8811**. **Exposing 8810 through Tailscale Serve, a tunnel or a reverse proxy lets your whole tailnet or the whole internet into ergo without authentication** — that is a misconfiguration rather than a vulnerability in ergo, but the wizard and docs steer you away from it.

### Device pairing

- A new device opens the external address → the page shows a device name, a 6-digit code and an 8-character fingerprint → a pairing request card appears in the inbox on your PC, and you approve only after checking they match → the device collects its credential within 5 minutes.
- The credential is 256 random bits; the server stores only its hash. It lives in an `HttpOnly`, `Secure`, `__Host-`-prefixed cookie that page scripts cannot read. It is valid for 365 days, extended on use, and voided if never used within 24 hours of collection.
- At most 5 pairing requests per source per 10 minutes; pending requests expire after 5 minutes; requests that look automated are flagged on the card.
- Revoke any device at any time under Settings · Paired devices; its open connections drop immediately.

### The guard

**Every tool call** an agent makes passes the guard before it runs (a pure function: the same input always gets the same verdict); the verdict and its reasons are stored in the tool-call detail in plain words:

- **Watch categories × six handlings**: spending money, sending in your name, deleting or overwriting, irreversible commits, accounts and security, leaving the project directory… each can be set to just do it and log / do it and tell me / only if listed in the plan / ask me first / hand it to me / never.
- **Grants in the plan**: the authorization you confirm once before a long-running task starts (kind, scope, count, expiry); anything beyond it asks you first.
- **Temporal rules**: e.g. "back up before deleting", "never send anything out after reading a secret".
- **Three hard bottom lines** nobody can override: never write ergo's own config area, database area or program directory; never read the secrets area; never send something known to be a secret.
- Anything that cannot be judged (missing facts, arguments that can't be normalized) asks you first.
- Tool calls from external runtimes such as Claude Code go through the same guard and are recorded.

### The secrets area

- API keys and other secrets live in the data directory's `secrets\`, **read by the supervisor** and passed to the daemon via environment variables; the daemon passes them to the agent child processes that need them over stdin, never via their environment.
- The model key can also be entered in the web UI (the setup wizard, Settings · Models): the daemon writes it into the same file under `secrets\` (directory `700`, file `600`, temp file then rename) and never reads it back — it still takes the key from the environment the supervisor injects. The API, the pages and the logs never contain the key itself; sessions started after saving use the new key, no restart needed.
- The guard's bottom lines forbid any agent from reading the secrets area or sending out anything recognized as a secret.
- Secrets never go into the repository or the supervisor's registry (which only says which file to read). The supervisor's own secrets (its web UI password, tailnet certificates) live in `.secrets\` in its data directory.

### Your data stays on your PC

Conversations, everything you said verbatim, memory, files and the ledger live in the local data directory, with a consistent snapshot every night. Model calls send only what the current turn needs. The web UI makes no requests to external hosts at runtime (ergo even serves its own fonts). Agent child processes run inside a Windows Job object with an allow-listed environment.

## Known limitations

ergo is built "features first, security later" ([ADR-0026](docs/adr/0026-features-first-security-later.md)). The following are **known and deliberately not yet tightened**; no need to report them again (improvement proposals are welcome):

- **The local port trusts every program on the PC**: anything that can reach `127.0.0.1:8810` can call ergo's API. ergo assumes the computer itself is trusted.
- **Agents run as your Windows account with no OS-level sandbox**: the guard is a policy layer (verdicts, approvals, records), not isolation; an OS-level sandbox, a reviewer agent and native signed confirmation for high-risk actions are planned.
- **Lenient defaults**: the secretary can go online by default; data directories upgraded from older versions have "ask me before risky things" and "stop tasks that go over budget" off (new installs have them on).
- **Proxied project services share ergo's origin**: services that go live are proxied under `/apps/<name>/`, so their page scripts can call ergo's API with your device credential (unreadable, but usable). Only services you approved are proxied; the plan is to move them to separate origins ([Developer Guide](docs/developer-guide.en.md#48-proxying-local-service-pages)).
- **Device credentials are bearer tokens**: if a device is stolen or its browser data copied, revoke it under Paired devices.
- **Behind a SNI front door without `proxy_protocol`**, pairing rate limits are keyed on 127.0.0.1 and thus effectively global (still safe, but strangers spamming requests delay your own pairing).
- **Content sent to the model is processed by the model provider**: whatever the current turn needs goes to the model you configured (currently DeepSeek); judge by its privacy terms.
