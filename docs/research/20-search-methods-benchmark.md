# 调研 20：三种联网搜索方式的横向对比（deepseek-flash 驱动）

> - **调研日期**：2026-10-19（星期一）。90 次运行都在北京时间 07:19–08:12 跑完，全落在 DeepSeek 的空闲计价时段。二狗以 `main` 的 `9f60286d` 为准。没有改产品代码。
> - **问题**：用户 2026-10-18 要用 `deepseek-flash` 配三种搜索方式，在同一批搜索和下载任务上比时间、token、费用和正确率。结果给 162 号票用：设置里三个标签的"特点"和默认顺序。三种方式：
>   1. **二狗自带的浏览器搜索**（下文简称"浏览器"）；
>   2. **agent-browser**；
>   3. **DeepSeek 付费搜索**（下文简称"DeepSeek"）。
>
>   §1 是要点，§2 写方法，§3 是结果表，§4 讲各方式的长处、短处和典型失败，§5 讲 agent-browser 在本机的两个问题，§6 是给 162 号票的结论，§7 是局限，§8 是花费和意外。附录有任务集和标准答案、系统提示和工具配置、每次运行的明细、重跑方法。
> - **标注**：
>   - 不加标的是实测或一手资料，附出处；
>   - 【建议】是作者的看法；
>   - 【未核实】是没查到定论的。
> - **数据**：
>   - 原始数据在 `data/161-search-bench/`（未公开）：
>     - `runs.jsonl`：每次运行一行；
>     - `truth.json`：开跑前现取的标准答案；
>     - `config.json`：模型、档位、各方式的工具和系统提示；
>     - `overrides.json`：人工改判；
>     - `summary.json`：汇总数字。
>   - 脚本在内部工具目录（不随仓库公开）：
>     - `run.ts`：跑任务；
>     - `tasks.ts`：任务、标准答案、判分；
>     - `report.ts`：出表；
>     - `regrade.ts`：改了判分规则后重判。

---

## 1. 要点

1. **在"搜和读"的 7 个任务上，三种方式都答对了**（63 次里只有 1 次部分对）。差别在速度和花费，下面是 T1–T7 的平均：

   | 方式 | 平均时间 | 中位时间 | 每个任务的花费（按高峰价） |
   |---|---|---|---|
   | DeepSeek | 7.1 秒 | 6.7 秒 | ¥0.039 |
   | 浏览器 | 14.5 秒 | 12.8 秒 | ¥0.023 |
   | agent-browser | 82.4 秒 | 73.2 秒 | ¥0.041 |

   DeepSeek 比浏览器快一倍，比 agent-browser 快约 11 倍（§3.1）。

2. **能不能下载二进制文件，是唯一分出对错的地方**。T10 是下载一张 PNG：
   - 浏览器和 DeepSeek 都做不到：`web_fetch` 把响应当文字解码，`write` 也只能写文字。6 次全是"没完成"，模型都如实说了做不到，没有写坏文件。
   - agent-browser 3 次全对。做法是在页面里 `fetch` 拿到字节、转成 base64、再用 Python 解码写盘。它自带的 `download` 命令在 GitHub 上回了"Download was canceled"。
   - CSV 这类文字文件（T9），三种方式都能做到哈希一致。

3. **DeepSeek 多出来的钱，一半是搜索费，一半是 token**（T1–T7，按高峰价）：
   - 每个任务比浏览器多约 ¥0.016；
   - 其中搜索费 ¥0.0074（平均 1.5 次搜索）；
   - 其余是模型 token：它的结果带长摘要，没命中缓存的输入比浏览器多 38%（全部任务平均 9,808 对 7,099 token），模型费用高约 40%。
   - 读网页几乎都走直接请求（52 次里 51 次）。DeepSeek 读网页只在直接请求失败时才用到，全程只试过 1 次，也没成。

4. **agent-browser 最慢、最费调用**：
   - 平均 13 次模型调用、12 次 bash，是另两种的 4 倍。
   - 输入 token 大多命中缓存，所以按钱算只比 DeepSeek 贵一点（¥0.049 对 ¥0.039，全部任务按高峰价）。
   - 时间的波动也最大：T3 最快 122 秒，最慢 248 秒。
5. **agent-browser 在本机有两个问题**（§5）：
   - 用管道接它的输出，命令会一直不返回。这就是用户说的"open 不返回"，已复现。
   - 打开 Bing 结果页以后，下一条命令常常连不上浏览器。白等约 30 秒，下一条命令再花约 20 秒重启浏览器；重启后起始页变成 `hao.360.com`。30 次运行里出了 17 次，合计白等 556 秒。
   - 百度对它弹人机验证，T2 三次都碰到。
6. **浏览器方式几乎只靠 DuckDuckGo**：36 次有结果的搜索里，35 次来自 DDG，1 次来自 Bing。有一次 DDG、Bing 的结果都不相关，Google 又被反爬拦了，模型换了关键词才搜到。它每搜一次就起一次无头 Chrome（每次 3–4 秒），多跳任务 T6 一次运行最多起了 9 次。
7. **【建议】默认顺序：DeepSeek → 浏览器 → agent-browser**（§6）。
   - DeepSeek 最快最稳，多花的钱每个任务约一分多钱。
   - 浏览器免费，正确率相同，慢一倍。
   - agent-browser 放最后。它是唯一能下载二进制文件、能操作页面的方式，应该留着启用，不该停用。
   - 想完全不花钱时，把浏览器排第一。
8. **实际总花费 ¥1.88**：90 次正式运行 ¥1.842（模型 ¥1.677，DeepSeek 搜索 33 次 ¥0.165），调试脚本时试跑 4 次 ¥0.039。远低于 15 元预算。如果都在高峰时段跑，模型部分翻倍，约 ¥3.5。

---

## 2. 方法

### 2.1 三种方式各给了什么工具

三种方式共用下面这些配置：

- **模型**：`deepseek/deepseek-flash`，思考档位 `high`，照二狗的默认（`packages/daemon/src/model-settings/providers.ts` 的 `DEFAULT_MODEL_SETTINGS`）。pi 的模型目录把 `high` 原样传给 DeepSeek（pi-ai 1.0.4 `providers/data/deepseek.json` 的 `thinkingLevelMap`）。
- **模型版本**：DeepSeek 官网价格页 2026-10-19 的写法是："模型 deepseek-flash … 模型版本 DeepSeek-V4.1-Flash-1017"。脚注写旧名字 `deepseek-v4-flash`、`deepseek-v4-flash-vision-exp` 也由这个模型服务（[S1]）。
  - 2026-10-17 V4.1 Flash 升级成 1017 版，T3 找到的新闻都是这件事。所以本次测的就是 1017 版。
  - pi 1.0.4 的模型目录里这个模型名叫 "DeepSeek V4.1 Flash"。
- **会话**：每次运行一个新会话，接法和二狗一样：
  - 会话存在内存里，用 `SessionManager.inMemory`；设置也只放内存，用 `SettingsManager.inMemory({})`；
  - 凭据只放内存；
  - 不加载上下文文件，不加载扩展。
- **写文件**：都给 pi 自带的 `write`。
- **系统提示**：三种方式用同一段，只差联网那一句（附录 B）。工作目录是每次运行新建的临时目录，要保存的文件放 `out/`。
- **保险**：单次运行墙钟 8 分钟、工具调用 40 次、花费 1.2 元，到了就中止。90 次里一次都没触发。

| | 浏览器 | agent-browser | DeepSeek |
|---|---|---|---|
| 联网工具 | 二狗的 `web_search`、`web_fetch` | 没有 `web_search`、`web_fetch`。给 pi 自带的 `bash` 和 agent-browser skill，模型自己用 CLI 操控 Chrome | 二狗的 `web_search`、`web_fetch` |
| 搜索怎么走 | `createWebAccess` 设置固定成 `search: "browser"`：playwright-core 1.61.0 起无头 Chrome，依次试 DuckDuckGo → Bing → Google。每搜一次起一次浏览器，用完关掉 | 模型自己 `agent-browser open` 搜索引擎的结果页，再用 `snapshot`、`eval` 取内容 | 设置固定成 `search: "deepseek"`：调 DeepSeek 的 `POST /v1/tools/search`。没搜成时换浏览器，本次没发生 |
| 读网页怎么走 | 直接请求 → 浏览器 | 模型自己 `open` 加 `eval` / `get text`，偶尔用 `agent-browser read` | 直接请求 → DeepSeek 的 `POST /v1/tools/fetch` → 浏览器（DeepSeek 读网页开着） |
| 另外 | 没接 DeepSeek 的 key，所以浏览器没搜到时也不会换 DeepSeek（见下面的说明） | bash 的环境照二狗的白名单拼（`process/child-env.ts` 的 `buildChildEnv`），不带任何 key，带 `AGENT_BROWSER_EXECUTABLE_PATH`。每次运行另设 `AGENT_BROWSER_SOCKET_DIR`（见下面的说明） | 每次成功的搜索、读网页 0.005 元 |
| 实现 | `packages/daemon/src/web/` 的正式实现。宿主工具换成 pi 的自定义工具，照 `agent-child/host-tools.ts`（一次一个，结果是文字） | agent-browser 0.34.0；skill 是用户的 `~/.pi/agent/skills/agent-browser/SKILL.md`（它让模型去看 `agent-browser skills get core`） | 同浏览器一栏 |

几处要说明的：

- **浏览器一栏没接 key**。二狗正式运行时如果配了 DeepSeek 的 key，默认又设成浏览器，浏览器没搜到会换 DeepSeek（154 号票，会花钱）。这里为了测纯的浏览器方式，没给 key。
- **两种方式的 Chrome 是同一个**：都是系统装的 Chrome 155.0.8059.40（有签名）。agent-browser 用 `AGENT_BROWSER_EXECUTABLE_PATH` 指过去；二狗的浏览器搜索用 `createBrowserLocator` 找，找到的是同一个。
- **agent-browser 的两处隔离**：
  - 每次运行另设 `AGENT_BROWSER_SOCKET_DIR`（守护进程的套接字、pid 文件放这次运行的目录里）。这样模型照 skill 跑 `close --all` 时，只关自己的，碰不到槽 1、槽 3 的 agent 可能开着的浏览器。
  - 跑完由脚本再 `close --all` 一次，还在的守护进程按 pid 结束。
- **bash 的默认超时 180 秒**：模型没写 `timeout` 时补上。二狗正式运行时 bash 没有默认超时，只有 agent 管家的 10 分钟工具调用超时。本次一次都没超时。
- **能力不完全对等**：agent-browser 一栏的 bash 本身也能写文件、跑 curl 和 Python。系统提示让它"联网用 agent-browser"，30 次里只有 1 次（r2-T1）用了 curl。下载文件时它用了 Python 解码 base64（§4.2）。

### 2.2 任务集

10 个任务，中英文都有。全文和判分标准在附录 A。

| 任务 | 类别 | 内容 |
|---|---|---|
| T1 | 单一事实 | Node.js 最新 LTS 的完整版本号（v26 还是 Current，容易答错） |
| T2 | 单一事实 | 中国 2026 年国庆放假起止和调休日 |
| T3 | 近期新闻 | 最近一周 DeepSeek 的一条新闻：标题、日期、链接 |
| T4 | 读指定网页 | DeepSeek 联网搜索文档里 Search、Fetch 的 QPS 和价格 |
| T5 | 读指定网页（英） | PEP 8 的代码行长和注释行长 |
| T6 | 多跳 | 2026 年诺贝尔化学奖得主 → 日本得主的大学 → 这所大学的创办年份 |
| T7 | 列表对比（英） | axum、actix-web、Rocket 的 GitHub star 数，从多到少排 |
| T8 | 存正文 | DeepSeek"模型 & 价格"页的正文存成 Markdown |
| T9 | 下载文件 | GitHub 上的一个 CSV，要求原样保存、哈希一致 |
| T10 | 下载文件 | python.org 的 logo PNG，要求原样保存、哈希一致 |

会变的标准答案开跑前现取，存在 `truth.json`：

- Node LTS：从 nodejs.org 的 `index.json` 取；
- star 数：从 GitHub API 取；
- CSV、PNG 的哈希：直接下载后算。

### 2.3 跑法与判分

- **次数**：每个任务 × 每种方式跑 3 轮，共 90 次。一次只跑一个，不并发开浏览器。
- **先后**：每个任务里三种方式轮换先后，免得总是同一种先跑，吃到缓存或碰上同一时段。
- **记录**：每次记墙钟时间、模型调用次数、输入（未命中 / 命中缓存）和输出 token、思考 token、模型费用、搜索和读网页的次数、走了哪条路、DeepSeek 的计费次数、起浏览器的次数、每次工具调用（参数、耗时、结果开头）、最后的回答、输出文件。
- **起浏览器的次数怎么数**：
  - 浏览器和 DeepSeek 两栏，数二狗浏览器驱动的 `withPage` 调用；
  - agent-browser 一栏，数守护进程 pid 文件里出现过的不同 pid，重启一次算一次。
- **模型费用**：
  - 单价照 `protocol/token-prices.ts` 的 deepseek-flash（元 / 百万 token）：空闲时段命中 0.02、未命中 1、输出 4，高峰翻倍；
  - 每次模型调用按它的时间落在哪个时段算，节假日看仓库里的 `cn-2026.json`。
  - 本次全在空闲时段，所以"实际"就是空闲价。表里另给"按高峰价"一列，方便和白天用的情况比。
- **判分**：
  - 先由 `tasks.ts` 自动初判，再人工逐条复核；
  - T3 的 9 个链接都逐个打开核对了；
  - 改判 1 条（r1-T3-DeepSeek），记在 `overrides.json`；
  - 第一轮跑完后修了 T4 的判分规则（原来认不出表格里的"QPS … **5**"），重判了 3 条，都从"部分对"改成"对"。

### 2.4 环境

- Windows 11 Pro 10.0.26300，i5-13600K，32 GB 内存；
- Node v22.23.0；pi-coding-agent 1.0.4、pi-ai 1.0.4；
- 系统 Chrome 155.0.8059.40；
- 本机网络，从这里打开部分国内站会被拒（东方网回 403）。
- 脚本在单独的检出里跑，不碰真的守护进程和数据目录，临时目录放在系统临时目录。

---

## 3. 结果

### 3.1 按方式汇总

**全部任务（每种方式 30 次）**

| 方式 | 平均时间 | 中位时间 | 模型调用 | 工具调用 | 输入（未命中） | 输入（命中缓存） | 输出 | 模型费用（实际，空闲价） | 联网费用 | 合计（按高峰价） | 合计中位（按高峰价） | 对 / 部分对 / 错 / 没完成 | 正确率 | 得分率 | 起浏览器 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 浏览器 | 20.5 秒 | 13.7 秒 | 3.4 | 3.9 | 7,099 | 11,247 | 1,808 | ¥0.0146 | ¥0 | ¥0.0291 | ¥0.0234 | 27 / 0 / 0 / 3 | 90% | 90% | 1.5 |
| agent-browser | 75.6 秒 | 68.1 秒 | 13.1 | 12.5 | 7,669 | 85,295 | 3,831 | ¥0.0247 | ¥0 | ¥0.0494 | ¥0.0442 | 30 / 0 / 0 / 0 | 100% | 100% | 1.7 |
| DeepSeek | 9.5 秒 | 7.3 秒 | 3.1 | 3.3 | 9,808 | 12,497 | 1,648 | ¥0.0166 | ¥0.0055 | ¥0.0388 | ¥0.0328 | 26 / 1 / 0 / 3 | 87% | 88% | 0 |

正确率是"对"的比例；得分率把"部分对"算半分。token 和费用都是每次运行的平均。

**只看搜索和读网页（T1–T7，每种方式 21 次）**

| 方式 | 平均时间 | 中位时间 | 平均 token（合计） | 合计（按高峰价） | 对 / 部分对 / 错 / 没完成 | 正确率 |
|---|---|---|---|---|---|---|
| 浏览器 | 14.5 秒 | 12.8 秒 | 17,371 | ¥0.0227 | 21 / 0 / 0 / 0 | 100% |
| agent-browser | 82.4 秒 | 73.2 秒 | 82,293 | ¥0.0413 | 21 / 0 / 0 / 0 | 100% |
| DeepSeek | 7.1 秒 | 6.7 秒 | 25,018 | ¥0.0391 | 20 / 1 / 0 / 0 | 95% |

**只看存正文和下载文件（T8–T10，每种方式 9 次）**

| 方式 | 平均时间 | 中位时间 | 平均 token（合计） | 合计（按高峰价） | 对 / 部分对 / 错 / 没完成 | 正确率 |
|---|---|---|---|---|---|---|
| 浏览器 | 34.6 秒 | 19.5 秒 | 26,648 | ¥0.0440 | 6 / 0 / 0 / 3 | 67% |
| agent-browser | 59.7 秒 | 66.1 秒 | 130,632 | ¥0.0684 | 9 / 0 / 0 / 0 | 100% |
| DeepSeek | 15.2 秒 | 10.8 秒 | 21,468 | ¥0.0380 | 6 / 0 / 0 / 3 | 67% |

### 3.2 按任务的明细

每格依次是：三轮的判分、平均时间（最短–最长）、平均费用（按高峰价）。

| 任务 | 类别 | 浏览器 | agent-browser | DeepSeek |
|---|---|---|---|---|
| T1 | 单一事实（中） | 对、对、对 · 12 秒（12–13） · ¥0.0236 | 对、对、对 · 23 秒（20–24） · ¥0.0292 | 对、对、对 · 6 秒（4–7） · ¥0.0305 |
| T2 | 单一事实（中） | 对、对、对 · 16 秒（15–17） · ¥0.0186 | 对、对、对 · 112 秒（79–129） · ¥0.0536 | 对、对、对 · 7 秒（6–8） · ¥0.0323 |
| T3 | 近期新闻（中） | 对、对、对 · 17 秒（17–18） · ¥0.0174 | 对、对、对 · 168 秒（122–248） · ¥0.0499 | 部分对、对、对 · 8 秒（6–10） · ¥0.0583 |
| T4 | 读指定网页（中） | 对、对、对 · 9 秒（8–9） · ¥0.0158 | 对、对、对 · 14 秒（10–17） · ¥0.0232 | 对、对、对 · 5 秒（4–6） · ¥0.0253 |
| T5 | 读指定网页（英） | 对、对、对 · 4 秒（2–6） · ¥0.0200 | 对、对、对 · 12 秒（9–15） · ¥0.0192 | 对、对、对 · 3 秒（3–4） · ¥0.0230 |
| T6 | 多跳查询（中） | 对、对、对 · 35 秒（29–46） · ¥0.0323 | 对、对、对 · 181 秒（143–206） · ¥0.0807 | 对、对、对 · 11 秒（9–13） · ¥0.0634 |
| T7 | 列表对比（英） | 对、对、对 · 9 秒（6–13） · ¥0.0315 | 对、对、对 · 67 秒（44–83） · ¥0.0331 | 对、对、对 · 10 秒（7–16） · ¥0.0412 |
| T8 | 存正文（中） | 对、对、对 · 12 秒（8–20） · ¥0.0255 | 对、对、对 · 84 秒（43–137） · ¥0.1107 | 对、对、对 · 10 秒（7–16） · ¥0.0230 |
| T9 | 下载 CSV（中） | 对、对、对 · 17 秒（10–25） · ¥0.0423 | 对、对、对 · 72 秒（66–80） · ¥0.0603 | 对、对、对 · 19 秒（9–34） · ¥0.0577 |
| T10 | 下载 PNG（中） | 没完成 ×3 · 74 秒（20–117） · ¥0.0643 | 对、对、对 · 24 秒（22–26） · ¥0.0341 | 没完成 ×3 · 16 秒（7–30） · ¥0.0333 |

几点读法：

- **T5、T7 和下载任务都不靠搜索**：
  - T5 给了网址，三种方式都是读一次就答；
  - T7 除了一次 agent-browser，都直接读了 GitHub API（`/repos/{owner}/{repo}`），没用搜索，所以浏览器和 DeepSeek 的差别只在读网页那一步。
- **DeepSeek 在 T3、T6 上更贵**：搜索结果的长摘要进了上下文，没命中缓存的输入多。浏览器的摘要只有一两句。
- **浏览器在 T10 上又慢又贵**：模型试了好几种绕法，比如用第三方的 HTTP 头查询接口拿到文件大小 15770 字节，最后还是如实说写不出二进制。
- **agent-browser 在 T8 上费用最高**（¥0.11）：它写了一大段 JS 把页面的 DOM 转成 Markdown，再在 `eval`、文件和 bash 之间来回倒，r3 那次用了 28 次模型调用。

### 3.3 各方式的细节

**浏览器**

- 工具执行占墙钟时间的 55%。平均每次起 1.5 次浏览器，T6 一次运行最多起了 9 次。
- 搜索 38 次，有结果的 36 次：DuckDuckGo 35、Bing 1。没搜成 2 次：
  - r1-T1 模型自己写了 `engine: "deepseek"`，这一栏没接 DeepSeek，报错；
  - 有一次 DDG、Bing 的结果被判成和查询不相关，Google 又被反爬拦了。
- 读网页 68 次：直接请求 62 次，换浏览器 6 次，没有读不到的。

**agent-browser**

- 工具执行占墙钟时间的 67%。平均每次运行 13.6 条 agent-browser 子命令、12.1 次 bash 调用。
- 子命令合计：eval 174、open 121、close 35、get 30、snapshot 28、skills 5、click 4、wait 2、download 2、network 2、fill 1、press 1、status 1、doctor 1。
  - 模型主要靠 `open` 加 `eval`（写 JS 取 `innerText` 或链接）来读页面，很少用 skill 推荐的"snapshot 加 @ref 点击"。
  - 30 次都先读了 SKILL.md，只有 4 次再去看了更完整的 `agent-browser skills get core`。
- 连不上浏览器 17 次，出现在 9 次运行里，每次白等平均 32.7 秒，合计 556 秒（§5.2）。
- 百度人机验证 3 次（都在 T2），bash 超时 0 次。

**DeepSeek**

- 工具执行只占墙钟时间的 13%，模型思考占大头。
- DeepSeek 搜索 33 次全部成功（计费）。没有一次因为 DeepSeek 没搜成而换浏览器。
- 读网页 52 次：直接请求 51 次。剩下 1 次是 r2-T10 模型想借第三方接口（microlink）拿文件大小，直接请求回 400，DeepSeek 读网页也没取到正文（回 404，没计费），最后换浏览器。

---

## 4. 各方式的长处、短处和典型失败

### 4.1 DeepSeek

- **长处**：
  - 最快：T1–T7 中位 6.7 秒，单次最长 34 秒。
  - 模型调用平均最少（3.1 次，最多 6 次）。
  - 不起浏览器，不怕反爬：33 次搜索全成。
  - 结果带日期、站点、"优质""权威"标记和长摘要。新闻、政策类问题（T2、T3、T6）往往一两次搜索就够，模型拿摘要就能答，不用再读原文。
  - 能用 `site:`、`after:` 这类语法；T1 里模型用了 `time: "w"`，实际查询自动加了 `after:`。
- **短处**：
  - 按次收费；
  - 长摘要让没命中缓存的输入变多，模型费用比浏览器高约 40%；
  - 只能搜和读，不能下载二进制，不能操作页面。
- **典型失败**：
  - T10 下载 PNG 三次都没完成，模型如实说明了原因。
  - r1-T3 给的链接是东方网的转载页，本机打不开（直接请求和浏览器都回 403）。同一篇第一财经的稿子在新浪财经能打开，所以判"部分对"。DeepSeek 的索引里会有本机打不开的国内转载站。

### 4.2 浏览器

- **长处**：
  - 免费；
  - 模型 token 最少（T1–T7 平均 17k）；
  - 搜和读的正确率和 DeepSeek 一样（T1–T7 全对）。
  - 读网页先走直接请求（62 / 68），很快。
- **短处**：
  - 每次搜索都要新起一个无头 Chrome（3–4 秒），多跳任务要搜好几次，时间就上去了：T6 平均 35 秒，DeepSeek 11 秒。
  - 结果实际上全靠 DuckDuckGo（35 / 36）。DDG 一旦限流或不相关，后面的 Bing、Google 未必接得住；Google 本次就被反爬拦了。
  - 摘要短，模型常常还得再读原文。
  - 只能搜和读。
- **典型失败**：
  - T10 下载 PNG 三次都没完成；
  - 模型看到工具说明里有 `engine: "deepseek"` 就自己去指定，在没开 DeepSeek 的配置里白报一次错（r1-T1）。

### 4.3 agent-browser

- **长处**：
  - 30 次全对，是唯一能下载二进制文件的（T10 三次全对）；
  - 能点、能填表、能执行页面里的 JS；
  - 读到的是真实渲染的页面，看到的和用户在浏览器里看到的一样。比如 T7 它同时核对了 API 的精确数和页面上显示的"27.5k"。
- **短处**：
  - 最慢：平均 76 秒，最长 248 秒。
  - 调用最多：5–31 次模型调用。
  - 上下文最长：平均 85k 命中缓存的输入。
  - 波动大。
  - 它要的本机知识很多：管道会挂住（SKILL.md 里专门写了）；`eval` 不能 `await`，要"先发射再轮询"；Windows 上的 Python 读不到 Git Bash 的 `/tmp`。模型常要试错一两次。
- **典型失败**：
  - 打开 Bing 结果页后连不上浏览器，白等约 30 秒（§5.2）；
  - 百度弹人机验证；
  - `agent-browser download` 在 GitHub 上回"Download was canceled"（r1-T9），后来改成在页面里 `fetch` 再转 base64 才成；
  - 偶尔把文件写到工作目录以外（见 §8）。

---

## 5. agent-browser 在本机的两个问题

### 5.1 "open 不返回"：管道接输出时守护进程占着管道

- **复现**：`agent-browser open https://example.com | cat` 一直不返回。外面套了 `timeout 25` 也没用，直到从另一个终端 `close --all` 关掉守护进程才结束，共 132 秒。
- **原因**：命令本身早就跑完了，是它拉起的后台守护进程继承了同一个 stdout，管道一直等不到 EOF。
- 输出重定向到文件时（`> log 2>&1 </dev/null`），同样的 `open` 1–2 秒就返回。
- 用户的 SKILL.md 第一条铁律写的就是这件事。本次 30 次运行里，模型都照着重定向了，bash 没有一次超时。
- **pi 自带的 bash 工具本身不会被这个挂住**：它在 shell 退出后只等管道空闲 100 毫秒（pi-coding-agent `utils/child-process.js` 的 `waitForChildProcess`）。只有命令里自己写了 `| head`、`| cat` 才会挂。

【建议】162 号票把 agent-browser 写进秘书和维护者的上下文时，要连"别用管道接它的输出"一起写进去。二狗的 bash 没有默认超时，一旦挂住就要等到 10 分钟的工具调用超时。

### 5.2 打开 Bing 结果页之后，下一条命令连不上浏览器

- **现象**：30 次运行里 17 次碰到 `✗ Could not configure browser: Failed to connect …（os error 10061）`，或者 `Failed to read …（os error 10060）`。每次白等 30–35 秒，下一条命令再自己重启浏览器，又要约 20 秒。
- **出现的位置**：前一步基本都在 Bing 的结果页或 Bing 资讯页上，另有一次是在 GitHub 上 `download` 失败之后。
- **单独复现**（不经模型）：
  1. `open https://www.bing.com/news/search?q=DeepSeek`，紧接着 `eval document.title` 正常；
  2. 等 3 秒再 `eval`，30 秒后报 10061；
  3. 下一条 `open` 用了 23 秒（重启浏览器）。
- **当时的进程状态**：
  - 报错前 6 秒内，那次 Chrome 的主进程（`--remote-debugging-port=0` 那个）一直在；
  - 报错之后它就不在了；
  - 重启后的标签页起始地址是 `https://hao.360.com/?a1004`。
- 【未核实】原因没查清：
  - Chrome 没有立刻退出，但调试端口连不上了。
  - 重启后被换成 360 导航页，说明本机的 360 在改 Chrome 的启动页。360 会不会也在掐断这个调试连接，没有证据。
  - 二狗的浏览器搜索每次新起浏览器、用完就关，而且几乎只用 DDG，本次没受这个影响。

【建议】如果 162 号票把 agent-browser 排在前面，上下文里提示"搜索优先用 DuckDuckGo 的 html 版（`https://html.duckduckgo.com/html/?q=`），少开 Bing"能省掉大部分白等。这一条没有实测。

---

## 6. 给 162 号票的结论

### 6.1 推荐的默认顺序【建议】

**DeepSeek 付费搜索 → 二狗自带的浏览器搜索 → agent-browser**。

1. **DeepSeek 排第一**：
   - 搜和读一样准，快一倍；
   - 不起浏览器、不怕反爬，33 次搜索全成；
   - 新闻、政策这类问题有日期和权威度标记。
   - 多花的钱按高峰价每个任务约 ¥0.016，一天几十次搜索也就几毛钱。
   - 这也和 154 号票"配了 key 时默认 DeepSeek"一致。
2. **浏览器排第二**：
   - 免费，正确率和 DeepSeek 一样；
   - 慢在每次起浏览器；
   - 结果几乎全来自 DDG，适合当 DeepSeek 失效（余额不足、限流、出错）时的退路。
3. **agent-browser 排第三**：
   - 搜索时慢 5–11 倍，调用多 4 倍，在本机还常碰上连不上浏览器；
   - 它是唯一能下载二进制文件、能操作页面的方式，要留着启用，不建议停用。
   - 162 号票的设计里，停用它只影响"拿它来搜"，skill 还在。但模型要知道"下载图片、PDF 这类文件用 agent-browser 或 bash"。本次浏览器和 DeepSeek 两栏的模型在 T10 都想到了 curl，只是手上没有 bash。

**想完全不花钱时**：浏览器 → agent-browser，DeepSeek 停用。代价是搜和读平均慢一倍，DDG 失效时只能退到 agent-browser。

### 6.2 标签上的一句话特点【建议】

照用户给的样子（"免费 · 中等速度 · 只能搜和读"）：

| 方式 | 标签上的特点 | 依据 |
|---|---|---|
| DeepSeek 付费搜索 | **按次收费（每次 0.005 元）· 最快 · 只能搜和读** | T1–T7 中位 6.7 秒；每个任务平均 1.1 次搜索；T10 做不到 |
| 二狗自带的浏览器搜索 | **免费 · 中等速度 · 只能搜和读** | T1–T7 中位 12.8 秒；模型 token 最少；T10 做不到 |
| agent-browser | **免费 · 最慢、最费 token · 能下载文件、能操作网页** | T1–T7 中位 73 秒；平均 13 次模型调用；T10 全对 |

如果标签放得下括号里的数字，可以写成"最快（约 7 秒）""中等速度（约 15 秒）""最慢（约 1 分多钟）"。

### 6.3 162 号票实现时顺带要注意的【建议】

- **`web_search` 的工具说明要跟着队列改**：现在的说明不管设置如何，都写着 `deepseek` / `browser` / `tavily` 各种 engine。r1-T1 里模型在没开 DeepSeek 的配置下自己指定了 `engine: "deepseek"`。
  - 正式运行时如果配了 key，指定 engine 会绕过队列直接花钱。162 号票写了"显式指定照旧只用那种"。
  - 停用了的方式最好不出现在说明里，或者写明"已停用"。
- **`web_fetch` 的回退顺序影响很小**：直接请求成功率很高（浏览器一栏 62 / 68，DeepSeek 一栏 51 / 52）。DeepSeek 读网页、浏览器读网页谁先谁后，对时间和花费几乎没有影响。
- **"只启用 agent-browser"时**：
  - 要在上下文里写清"别用管道接输出、`eval` 不能 `await`"这类本机要点。用户的 SKILL.md 已有，但模型 30 次里只有 4 次去看了更完整的 `skills get core`。
  - 还要给它一个固定的工作目录说法。本次有两次它把文件写到了工作目录外（§8）。

---

## 7. 局限

- **任务偏容易**：搜和读的 7 个任务三种方式几乎都对，所以本次只能比出速度、花费和能力边界。比不出"难找的信息谁更找得到"。
- **样本小**：每格 3 次。agent-browser 的时间波动大（T3 122–248 秒），平均数受个别慢的那次影响大，中位数更可靠。
- **只在空闲时段、只在本机网络上跑**：
  - 白天高峰时 DeepSeek 接口的延迟、DDG 的限流情况可能不同，本次没测；
  - 从本机打开部分国内站会被拒（东方网 403），国内网络下 DeepSeek 一栏 r1-T3 可能会是"对"。
- **只测了一个模型**：`deepseek-v4-pro` 或别的档位下，agent-browser 的步数可能会少。
- **agent-browser 的配置**：
  - 本次 skill 是用户机器上那份。里面有一段讲另一个项目（短剧控制台）的口令门禁，和本次任务无关，但占了上下文。
  - bash 有 180 秒的默认超时，二狗正式运行时没有（§2.1）。
- **浏览器一栏的 Google 回退**：本次只有一次走到 Google，就被反爬拦了。DDG 挂掉时这一栏实际能不能用，没测。

---

## 8. 花费和意外

- **花费**：

  | 项目 | 次数 | 花费 | 其中 |
  |---|---|---|---|
  | 正式运行 | 90 | ¥1.842 | 模型 ¥1.677；DeepSeek 搜索 33 次 ¥0.165；DeepSeek 读网页没计费 |
  | 调试脚本时试跑 | 4 | ¥0.039 | 含 DeepSeek 搜索 1 次 |
  | 合计 | | **约 ¥1.88** | |

  - 核对新闻链接、取标准答案、复现 agent-browser 的问题，都是直接请求或本机浏览器，没花钱。
  - 运行全在空闲时段。按高峰价，正式运行约 ¥3.5。
- **意外**：
  1. **记录里的回答被误删了几处字**：脚本最初用二狗的 `redactApiKeys` 处理回答，它会把"API Key"后面跟着的一截字换成 `<已隐去>`。所以第一轮 T4 的 3 条回答各有一处被换掉，原文是"与使用哪个 API Key 无关"一类的话。key 本身从没出现过。之后改成只去掉 key 本身，第二、三轮不受影响。判分要的数（QPS 5、5 元）都还在，判分不受影响。
  2. **判分规则修过一次**：T4 原来认不出表格里的 QPS，第一轮跑完后修了，重判 3 条（§2.3）。
  3. **agent-browser 一栏两次写到工作目录以外**，都已删掉：
     - r1-T1 模型 `cd /d/code` 后建了 `D:\code\out\nodejs-lts.txt`；
     - r3-T8 用 `write` 写 `/tmp/ser.js`，pi 把它解析成 `D:\tmp\ser.js`。同一次运行里还在 `C:\` 下 `find` 了两次找这个文件（只读）。
  4. **agent-browser 的两个本机问题**见 §5。复现时开的守护进程和浏览器都已关掉。跑完核对过，没有遗留的 agent-browser 守护进程或调试模式的 Chrome。
  5. **槽 1、槽 3 的 agent 和用户自己的浏览器**：每次运行用独立的 `AGENT_BROWSER_SOCKET_DIR`，模型跑 `close --all` 也只关自己的，没有碰到别人的 agent-browser 会话。

---

## 附录 A：任务集和标准答案

| 任务 | 交给模型的话 | 标准答案和判分 |
|---|---|---|
| T1 | Node.js 现在最新的 LTS（长期支持）版本号是多少？要完整的 x.y.z。 | 开跑前从 `https://nodejs.org/dist/index.json` 现取最新的 LTS：v24.22.0（Krypton，2026-10-14）。v26.12.0 还是 Current，按排期 2026-10-28 才转 LTS。完整版本号对 → 对；大版本对、小版本不对 → 部分对；别的 → 错。 |
| T2 | 中国 2026 年国庆节怎么放假？放几天、从哪天到哪天，调休上班是哪几天？ | 国办发明电〔2025〕7号，见 `packages/daemon/holidays/cn-2026.json`：10 月 1 日至 7 日放假，共 7 天；9 月 20 日（周日）、10 月 10 日（周六）上班。放假起止和两个调休日都对 → 对；只有放假起止对 → 部分对；放假起止不对 → 错。 |
| T3 | 找一条最近一周内（2026-10-12 以后）关于 DeepSeek 的新闻，告诉我标题、发布日期和链接。 | 人工核对三样：链接打得开、确实是关于 DeepSeek 的新闻、发布日期在 10-12 到 10-19 之间。三样都满足 → 对；新闻是真的，但日期早于 10-12，或者链接是本机打不开的转载页、聚合页 → 部分对；打不开且内容对不上，或者编造 → 错。 |
| T4 | 读一下 DeepSeek 联网搜索的官方文档 https://api-docs.deepseek.com/zh-cn/guides/search/ ，告诉我 Search 和 Fetch 两个接口各自的 QPS 上限和价格。 | Search、Fetch 各自账号级 QPS 5；都是每 1000 次成功请求 5 元。都对 → 对；只对一样 → 部分对。 |
| T5 | Read https://peps.python.org/pep-0008/ and tell me: what is the recommended maximum line length for code, and for docstrings/comments? | 代码 79 个字符，docstring 和注释 72 个字符。两个都对 → 对；只对一个 → 部分对。 |
| T6 | 2026 年诺贝尔化学奖颁给了谁？其中来自日本的那位得主在哪所大学任职？这所大学是哪一年创办的？ | nobelprize.org 2026-10-07 新闻稿：Henri B. Kagan（Université Paris-Sud）和 Kenso Soai（东京理科大学）。东京理科大学 1881 年创办。三跳都对 → 对；得主对、后面缺一样 → 部分对；得主不对 → 错。 |
| T7 | Compare the GitHub star counts of three Rust web frameworks: axum, actix-web and Rocket. List each with its current star count, sorted from most to fewest. | GitHub API 现取：axum 27,523、Rocket 25,777、actix-web 24,869。每个数在 ±3% 以内算对。三个都对且顺序对 → 对；对一到两个，或三个都对但顺序错 → 部分对；一个都不对 → 错。 |
| T8 | 把 DeepSeek 官方文档里"模型 & 价格"那一页（https://api-docs.deepseek.com/zh-cn/quick_start/pricing）的正文存成 out/deepseek-pricing.md，Markdown 或纯文本都行，不要 HTML 标签，内容别删减。 | 文件里不能有 HTML 标签，要能找到 10 个关键处：DeepSeek-V4.1-Flash-1017、DeepSeek-V4-Pro-0813、1M、384K、0.02、13.5、2500、"空闲时段价格为高峰时段价格的一半"、"每 1,000 次成功请求 5 元"、"11 月 1 日"。10 个都在 → 对；5 个以上 → 部分对；文件在但不到 5 个 → 错；没有文件 → 没完成。 |
| T9 | 在 GitHub 的 plotly/datasets 仓库里找到 2014_world_gdp_with_codes.csv，原样下载保存为 out/gdp.csv（内容一字不改）。 | 和 raw.githubusercontent.com 现取的比：4515 字节，sha256 `5b2311d1…44f6ef`。哈希一样，或者只差换行和末尾空白 → 对；行数一样、内容有出入 → 部分对；别的 → 错；没有文件 → 没完成。 |
| T10 | 把 https://www.python.org/static/img/python-logo.png 下载下来，原样保存为 out/python-logo.png，告诉我文件多大。 | 15770 字节，sha256 `9c121e61…4ae8f3c`。哈希一样 → 对；文件在但不一样 → 错；没有文件 → 没完成。 |

## 附录 B：系统提示和工具配置

三种方式共用的系统提示如下。第二行在 agent-browser 一栏换成"联网用 agent-browser（浏览器命令行，在 bash 里运行，用法见 skill）：搜索、读网页、下载都用它。"

```
你是一个能联网的助手，替用户查资料、读网页、下载文件。今天是 2026-10-19（星期一），时区 UTC+8。
联网用 web_search（搜索）和 web_fetch（读网页正文）两个工具。
- 会变的信息（版本号、新闻、价格、star 数这类）不要凭记忆答，先联网查证。
- 要保存的文件一律放进当前目录下的 out/ 目录（相对路径，比如 out/a.txt）；写文件可以用 write 工具。
- 不要反问用户，信息不够就自己去查。做完用中文简短回答：结论、关键数据、来源链接。
```

pi 在这段后面还会接两样：

- 工作目录；
- agent-browser 一栏另有 skill 清单（SKILL.md 的路径和说明，让模型用 bash 去读）。

`web_search`、`web_fetch` 的说明和参数原样用二狗的（`packages/daemon/src/web/tools.ts`）。工具清单和网络设置见 `data/161-search-bench/config.json`（未公开）。

## 附录 C：每次运行

90 行的明细表（判分理由、时间、token、费用、走了哪条路、子命令、停止原因）由 `report.ts` 生成，原始字段都在 `runs.jsonl` 里。下表是重跑 `report.ts` 时"每次运行"一节的输出：

| 运行 | 判分 | 理由 | 时间 | 模型调用 | 工具调用 | token（未命中 / 命中 / 输出） | 费用（实际） | 联网（搜 / 读，DeepSeek 计费次数） | 起浏览器 | 停止 |
|---|---|---|---|---|---|---|---|---|---|---|
| r1-T1-browser | 对 | 提到 24.22.0 | 12 秒 | 4 | 6 | 7,872 / 12,032 / 1,350 | ¥0.0135 | 2 / 4 [ddg] [direct,direct,direct,direct] | 1 | stop |
| r2-T1-browser | 对 | 提到 24.22.0 | 13 秒 | 4 | 5 | 7,061 / 12,672 / 1,092 | ¥0.0117 | 1 / 4 [ddg] [direct,direct,direct,direct] | 1 | stop |
| r3-T1-browser | 对 | 提到 24.22.0 | 12 秒 | 3 | 4 | 6,076 / 6,016 / 986 | ¥0.0101 | 1 / 3 [ddg] [direct,direct,direct] | 1 | stop |
| r1-T1-agent-browser | 对 | 提到 24.22.0 | 24 秒 | 8 | 7 | 3,908 / 23,296 / 1,518 | ¥0.0104 | ab 命令 9（open×2 eval×6 close×1） | 1 | stop |
| r2-T1-agent-browser | 对 | 提到 24.22.0 | 20 秒 | 7 | 7 | 5,719 / 27,520 / 1,329 | ¥0.0116 | ab 命令 5（open×2 eval×2 close×1），curl 类 2 | 1 | stop |
| r3-T1-agent-browser | 对 | 提到 24.22.0 | 24 秒 | 10 | 9 | 8,680 / 59,264 / 2,980 | ¥0.0218 | ab 命令 7（open×3 snapshot×1 eval×2 close×1） | 1 | stop |
| r1-T1-deepseek | 对 | 提到 24.22.0 | 4 秒 | 2 | 2 | 12,222 / 1,792 / 568 | ¥0.0195 | 1 / 1（1） [deepseek] [direct] | 0 | stop |
| r2-T1-deepseek | 对 | 提到 24.22.0 | 6 秒 | 3 | 4 | 8,470 / 9,088 / 1,025 | ¥0.0178 | 1 / 3（1） [deepseek] [direct,direct,direct] | 0 | stop |
| r3-T1-deepseek | 对 | 提到 24.22.0 | 7 秒 | 3 | 4 | 6,640 / 7,168 / 1,038 | ¥0.0159 | 1 / 3（1） [deepseek] [direct,direct,direct] | 0 | stop |
| r1-T2-browser | 对 | 10-1 至 10-7，调休 9-20、10-10 | 15 秒 | 3 | 3 | 5,832 / 7,040 / 1,000 | ¥0.0100 | 2 / 1 [ddg,ddg] [direct] | 2 | stop |
| r2-T2-browser | 对 | 10-1 至 10-7，调休 9-20、10-10 | 17 秒 | 3 | 3 | 5,763 / 6,400 / 930 | ¥0.0096 | 2 / 1 [ddg,ddg] [direct] | 2 | stop |
| r3-T2-browser | 对 | 10-1 至 10-7，调休 9-20、10-10 | 15 秒 | 3 | 3 | 5,823 / 6,784 / 587 | ¥0.0083 | 2 / 1 [ddg,ddg] [direct] | 2 | stop |
| r1-T2-agent-browser | 对 | 10-1 至 10-7，调休 9-20、10-10 | 129 秒 | 16 | 16 | 10,646 / 108,928 / 4,005 | ¥0.0288 | ab 命令 21（open×7 snapshot×6 close×2 click×2 get×2 eval×2） | 3 | stop |
| r2-T2-agent-browser | 对 | 10-1 至 10-7，调休 9-20、10-10 | 129 秒 | 13 | 12 | 8,745 / 77,824 / 3,958 | ¥0.0261 | ab 命令 20（open×6 snapshot×7 fill×1 press×1 get×2 click×1 eval×1 close×1） | 3 | stop |
| r3-T2-agent-browser | 对 | 10-1 至 10-7，调休 9-20、10-10 | 79 秒 | 15 | 14 | 7,831 / 86,400 / 3,979 | ¥0.0255 | ab 命令 19（open×7 snapshot×1 get×9 eval×1 close×1） | 2 | stop |
| r1-T2-deepseek | 对 | 10-1 至 10-7，调休 9-20、10-10 | 8 秒 | 3 | 3 | 6,871 / 8,320 / 1,357 | ¥0.0225 | 2 / 1（2） [deepseek,deepseek] [direct] | 0 | stop |
| r2-T2-deepseek | 对 | 10-1 至 10-7，调休 9-20、10-10 | 6 秒 | 2 | 2 | 5,805 / 1,920 / 919 | ¥0.0195 | 2 / 0（2） [deepseek,deepseek] | 0 | stop |
| r3-T2-deepseek | 对 | 10-1 至 10-7，调休 9-20、10-10 | 7 秒 | 3 | 3 | 7,206 / 8,576 / 1,038 | ¥0.0215 | 2 / 1（2） [deepseek,deepseek] [direct] | 0 | stop |
| r1-T3-browser | 对 | 有链接、日期在一周内（待人工核对链接） | 17 秒 | 3 | 4 | 5,285 / 6,272 / 782 | ¥0.0085 | 2 / 2 [ddg,ddg] [direct,browser] | 3 | stop |
| r2-T3-browser | 对 | 有链接、日期在一周内（待人工核对链接） | 18 秒 | 3 | 4 | 5,579 / 6,144 / 763 | ¥0.0088 | 2 / 2 [ddg,ddg] [direct,direct] | 2 | stop |
| r3-T3-browser | 对 | 有链接、日期在一周内（待人工核对链接） | 17 秒 | 3 | 4 | 5,660 / 6,144 / 753 | ¥0.0088 | 2 / 2 [ddg,ddg] [direct,direct] | 2 | stop |
| r1-T3-agent-browser | 对 | 有链接、日期在一周内（待人工核对链接） | 135 秒 | 14 | 13 | 9,150 / 85,504 / 3,848 | ¥0.0263 | ab 命令 13（open×5 snapshot×3 eval×3 get×1 close×1） | 2 | stop |
| r2-T3-agent-browser | 对 | 有链接、日期在一周内（待人工核对链接） | 122 秒 | 11 | 11 | 7,751 / 59,776 / 3,355 | ¥0.0224 | ab 命令 13（open×6 snapshot×1 eval×5 close×1） | 3 | stop |
| r3-T3-agent-browser | 对 | 有链接、日期在一周内（待人工核对链接） | 248 秒 | 15 | 14 | 7,643 / 83,328 / 4,219 | ¥0.0262 | ab 命令 21（open×6 get×2 eval×8 status×1 close×4） | 6 | stop |
| r1-T3-deepseek | 部分对 | 给的东方网链接在本机打不开（直接请求和浏览器都回 403，可能是地区限制）；同一篇第一财经稿（10-17）在新浪财经能打开，新闻本身是真的（人工改判） | 6 秒 | 2 | 2 | 16,508 / 1,920 / 840 | ¥0.0299 | 2 / 0（2） [deepseek,deepseek] | 0 | stop |
| r2-T3-deepseek | 对 | 有链接、日期在一周内（待人工核对链接） | 7 秒 | 3 | 3 | 23,199 / 23,936 / 919 | ¥0.0374 | 2 / 1（2） [deepseek,deepseek] [direct] | 0 | stop |
| r3-T3-deepseek | 对 | 有链接、日期在一周内（待人工核对链接） | 10 秒 | 4 | 4 | 17,899 / 37,632 / 1,638 | ¥0.0352 | 2 / 1（2） [deepseek,deepseek] [direct] | 0 | stop |
| r1-T4-browser | 对 | QPS 5、每千次 5 元 | 9 秒 | 2 | 2 | 5,205 / 1,792 / 566 | ¥0.0075 | 1 / 1 [ddg] [direct] | 1 | stop |
| r2-T4-browser | 对 | QPS 5、每千次 5 元 | 9 秒 | 2 | 2 | 5,302 / 1,792 / 655 | ¥0.0080 | 1 / 1 [ddg] [direct] | 1 | stop |
| r3-T4-browser | 对 | QPS 5、每千次 5 元 | 8 秒 | 2 | 2 | 5,346 / 1,792 / 698 | ¥0.0082 | 1 / 1 [ddg] [direct] | 1 | stop |
| r1-T4-agent-browser | 对 | QPS 5、每千次 5 元 | 17 秒 | 6 | 5 | 5,819 / 18,688 / 1,475 | ¥0.0121 | ab 命令 7（open×1 get×2 eval×3 close×1） | 1 | stop |
| r2-T4-agent-browser | 对 | QPS 5、每千次 5 元 | 10 秒 | 5 | 4 | 5,866 / 13,440 / 1,023 | ¥0.0102 | ab 命令 3（open×1 eval×1 close×1） | 1 | stop |
| r3-T4-agent-browser | 对 | QPS 5、每千次 5 元 | 13 秒 | 6 | 5 | 6,004 / 19,328 / 1,535 | ¥0.0125 | ab 命令 3（open×1 eval×1 close×1） | 1 | stop |
| r1-T4-deepseek | 对 | QPS 5、每千次 5 元 | 6 秒 | 3 | 3 | 9,420 / 11,520 / 1,126 | ¥0.0192 | 1 / 1（1） [deepseek] [direct] | 0 | stop |
| r2-T4-deepseek | 对 | QPS 5、每千次 5 元 | 4 秒 | 2 | 1 | 4,167 / 1,792 / 566 | ¥0.0065 | 0 / 1（0） [direct] | 0 | stop |
| r3-T4-deepseek | 对 | QPS 5、每千次 5 元 | 4 秒 | 2 | 2 | 9,547 / 1,792 / 698 | ¥0.0174 | 1 / 1（1） [deepseek] [direct] | 0 | stop |
| r1-T5-browser | 对 | 79、72 | 3 秒 | 2 | 1 | 9,019 / 1,792 / 392 | ¥0.0106 | 0 / 1 [direct] | 0 | stop |
| r2-T5-browser | 对 | 79、72 | 6 秒 | 3 | 2 | 7,042 / 8,960 / 950 | ¥0.0110 | 0 / 1 [direct] | 0 | stop |
| r3-T5-browser | 对 | 79、72 | 2 秒 | 2 | 1 | 6,755 / 1,792 / 383 | ¥0.0083 | 0 / 1 [direct] | 0 | stop |
| r1-T5-agent-browser | 对 | 79、72 | 9 秒 | 5 | 5 | 3,720 / 11,264 / 758 | ¥0.0070 | ab 命令 3（open×1 eval×1 close×1） | 1 | stop |
| r2-T5-agent-browser | 对 | 79、72 | 15 秒 | 7 | 7 | 5,435 / 22,656 / 1,793 | ¥0.0131 | ab 命令 5（open×1 get×2 eval×1 close×1） | 1 | stop |
| r3-T5-agent-browser | 对 | 79、72 | 12 秒 | 5 | 5 | 3,609 / 11,904 / 1,219 | ¥0.0087 | ab 命令 3（open×1 eval×1 close×1） | 1 | stop |
| r1-T5-deepseek | 对 | 79、72 | 4 秒 | 2 | 1 | 6,787 / 1,792 / 549 | ¥0.0090 | 0 / 1（0） [direct] | 0 | stop |
| r2-T5-deepseek | 对 | 79、72 | 3 秒 | 2 | 1 | 12,607 / 1,792 / 502 | ¥0.0147 | 0 / 1（0） [direct] | 0 | stop |
| r3-T5-deepseek | 对 | 79、72 | 3 秒 | 2 | 1 | 9,040 / 1,792 / 425 | ¥0.0108 | 0 / 1（0） [direct] | 0 | stop |
| r1-T6-browser | 对 | 得主、东京理科大学、1881 都对 | 29 秒 | 4 | 6 | 12,936 / 13,824 / 1,217 | ¥0.0181 | 4 / 2 [ddg,ddg,ddg,ddg] [direct,browser] | 5 | stop |
| r2-T6-browser | 对 | 得主、东京理科大学、1881 都对 | 29 秒 | 4 | 5 | 7,903 / 12,544 / 1,178 | ¥0.0129 | 4 / 1 [ddg,ddg,ddg,ddg] [direct] | 4 | stop |
| r3-T6-browser | 对 | 得主、东京理科大学、1881 都对 | 46 秒 | 5 | 8 | 11,985 / 23,552 / 1,264 | ¥0.0175 | 6 / 2 [ddg,ddg,ddg,ddg,ddg] [browser,direct] | 9 | stop |
| r1-T6-agent-browser | 对 | 得主、东京理科大学、1881 都对 | 206 秒 | 23 | 22 | 15,874 / 260,992 / 7,015 | ¥0.0492 | ab 命令 39（open×18 eval×19 snapshot×1 close×1） | 3 | stop |
| r2-T6-agent-browser | 对 | 得主、东京理科大学、1881 都对 | 143 秒 | 18 | 17 | 10,461 / 122,240 / 3,508 | ¥0.0269 | ab 命令 21（open×9 snapshot×3 click×1 get×1 eval×6 close×1） | 2 | stop |
| r3-T6-agent-browser | 对 | 得主、东京理科大学、1881 都对 | 194 秒 | 31 | 30 | 16,231 / 283,392 / 5,750 | ¥0.0449 | ab 命令 40（open×15 eval×19 close×2 get×2 snapshot×1 doctor×1） | 7 | stop |
| r1-T6-deepseek | 对 | 得主、东京理科大学、1881 都对 | 10 秒 | 3 | 4 | 14,807 / 9,728 / 1,495 | ¥0.0410 | 4 / 0（4） [deepseek,deepseek,deepseek,deepseek] | 0 | stop |
| r2-T6-deepseek | 对 | 得主、东京理科大学、1881 都对 | 9 秒 | 4 | 5 | 14,326 / 19,968 / 1,253 | ¥0.0347 | 3 / 1（3） [deepseek,deepseek,deepseek] [direct] | 0 | stop |
| r3-T6-deepseek | 对 | 得主、东京理科大学、1881 都对 | 13 秒 | 5 | 6 | 18,842 / 43,520 / 1,783 | ¥0.0468 | 4 / 1（4） [deepseek,deepseek,deepseek,deepseek] [direct] | 0 | stop |
| r1-T7-browser | 对 | 三个数都在 ±3% 内，顺序对 | 13 秒 | 4 | 6 | 10,649 / 16,384 / 1,166 | ¥0.0156 | 1 / 4 [ddg] [direct,direct,direct,direct] | 1 | stop |
| r2-T7-browser | 对 | 三个数都在 ±3% 内，顺序对 | 6 秒 | 3 | 4 | 9,100 / 10,880 / 962 | ¥0.0132 | 0 / 3 [direct,direct,direct] | 0 | stop |
| r3-T7-browser | 对 | 三个数都在 ±3% 内，顺序对 | 8 秒 | 4 | 7 | 13,250 / 21,888 / 1,177 | ¥0.0184 | 0 / 6 [direct,direct,direct,direct,direct,direct] | 0 | stop |
| r1-T7-agent-browser | 对 | 三个数都在 ±3% 内，顺序对 | 44 秒 | 10 | 10 | 4,358 / 36,096 / 2,637 | ¥0.0156 | ab 命令 12（open×3 eval×3 snapshot×3 wait×2 close×1） | 1 | stop |
| r2-T7-agent-browser | 对 | 三个数都在 ±3% 内，顺序对 | 73 秒 | 11 | 10 | 4,451 / 40,320 / 2,469 | ¥0.0151 | ab 命令 14（open×5 eval×8 close×1） | 1 | stop |
| r3-T7-agent-browser | 对 | 三个数都在 ±3% 内，顺序对 | 83 秒 | 14 | 13 | 5,611 / 57,088 / 3,029 | ¥0.0189 | ab 命令 19（open×5 eval×10 get×3 close×1） | 1 | stop |
| r1-T7-deepseek | 对 | 三个数都在 ±3% 内，顺序对 | 16 秒 | 6 | 13 | 16,471 / 39,680 / 1,773 | ¥0.0394 | 3 / 9（3） [deepseek,deepseek,deepseek] [direct,direct,direct,direct,direct,direct,direct,direct,direct] | 0 | stop |
| r2-T7-deepseek | 对 | 三个数都在 ±3% 内，顺序对 | 8 秒 | 4 | 7 | 11,174 / 17,920 / 1,374 | ¥0.0170 | 0 / 6（0） [direct,direct,direct,direct,direct,direct] | 0 | stop |
| r3-T7-deepseek | 对 | 三个数都在 ±3% 内，顺序对 | 7 秒 | 3 | 4 | 9,055 / 10,880 / 897 | ¥0.0129 | 0 / 3（0） [direct,direct,direct] | 0 | stop |
| r1-T8-browser | 对 | 10/10 处，1951 字 | 8 秒 | 3 | 2 | 2,876 / 5,504 / 1,622 | ¥0.0095 | 0 / 1 [direct] | 0 | stop |
| r2-T8-browser | 对 | 10/10 处，2119 字 | 10 秒 | 4 | 3 | 3,765 / 9,600 / 1,951 | ¥0.0118 | 0 / 2 [direct,direct] | 0 | stop |
| r3-T8-browser | 对 | 10/10 处，1907 字 | 20 秒 | 4 | 5 | 5,423 / 12,800 / 2,822 | ¥0.0170 | 1 / 3 [ddg] [direct,direct,direct] | 1 | stop |
| r1-T8-agent-browser | 对 | 10/10 处，2474 字 | 43 秒 | 14 | 13 | 10,959 / 90,624 / 6,984 | ¥0.0407 | ab 命令 8（open×1 eval×6 close×1） | 1 | stop |
| r2-T8-agent-browser | 对 | 10/10 处，2466 字 | 71 秒 | 15 | 15 | 9,339 / 128,768 / 8,739 | ¥0.0469 | ab 命令 10（open×1 eval×8 close×1） | 1 | stop |
| r3-T8-agent-browser | 对 | 10/10 处，2471 字 | 137 秒 | 28 | 28 | 11,751 / 353,536 / 14,910 | ¥0.0785 | ab 命令 14（open×1 eval×12 close×1） | 1 | stop |
| r1-T8-deepseek | 对 | 10/10 处，1838 字 | 8 秒 | 3 | 2 | 2,938 / 5,376 / 1,478 | ¥0.0090 | 0 / 1（0） [direct] | 0 | stop |
| r2-T8-deepseek | 对 | 10/10 处，1868 字 | 16 秒 | 4 | 3 | 3,112 / 11,136 / 3,236 | ¥0.0163 | 0 / 1（0） [direct] | 0 | stop |
| r3-T8-deepseek | 对 | 10/10 处，1983 字 | 7 秒 | 3 | 2 | 2,905 / 5,504 / 1,553 | ¥0.0092 | 0 / 1（0） [direct] | 0 | stop |
| r1-T9-browser | 对 | 哈希一致（4515 字节） | 10 秒 | 3 | 2 | 4,319 / 8,192 / 2,812 | ¥0.0157 | 0 / 1 [direct] | 0 | stop |
| r2-T9-browser | 对 | 哈希一致（4515 字节） | 25 秒 | 5 | 5 | 7,017 / 22,016 / 5,034 | ¥0.0276 | 1 / 3 [ddg] [direct,direct,direct] | 1 | stop |
| r3-T9-browser | 对 | 哈希一致（4515 字节） | 16 秒 | 4 | 4 | 7,122 / 16,256 / 3,161 | ¥0.0201 | 1 / 2 [ddg] [direct,direct] | 1 | stop |
| r1-T9-agent-browser | 对 | 哈希一致（4515 字节） | 80 秒 | 17 | 20 | 7,368 / 106,624 / 4,543 | ¥0.0277 | ab 命令 18（skills×1 open×4 snapshot×1 download×2 eval×9 close×1） | 1 | stop |
| r2-T9-agent-browser | 对 | 哈希一致（4515 字节） | 66 秒 | 17 | 16 | 5,526 / 82,944 / 4,884 | ¥0.0267 | ab 命令 19（open×3 eval×13 get×2 close×1） | 1 | stop |
| r3-T9-agent-browser | 对 | 哈希一致（4515 字节） | 70 秒 | 22 | 21 | 8,227 / 146,176 / 6,229 | ¥0.0361 | ab 命令 19（open×3 eval×12 skills×1 network×2 close×1） | 1 | stop |
| r1-T9-deepseek | 对 | 哈希一致（4515 字节） | 9 秒 | 3 | 2 | 4,362 / 8,192 / 2,747 | ¥0.0155 | 0 / 1（0） [direct] | 0 | stop |
| r2-T9-deepseek | 对 | 哈希一致（4515 字节） | 15 秒 | 3 | 3 | 5,598 / 9,728 / 3,986 | ¥0.0267 | 1 / 1（1） [deepseek] [direct] | 0 | stop |
| r3-T9-deepseek | 对 | 哈希一致（4515 字节） | 34 秒 | 6 | 6 | 13,860 / 41,344 / 7,416 | ¥0.0494 | 1 / 4（1） [deepseek] [direct,direct,direct,direct] | 0 | stop |
| r1-T10-browser | 没完成 | 没有 out/python-logo.png | 20 秒 | 3 | 2 | 8,372 / 11,008 / 3,244 | ¥0.0216 | 0 / 2 [direct,direct] | 0 | stop |
| r2-T10-browser | 没完成 | 没有 out/python-logo.png | 86 秒 | 5 | 5 | 9,617 / 44,160 / 8,663 | ¥0.0452 | 0 / 4 [direct,direct,direct,browser] | 1 | stop |
| r3-T10-browser | 没完成 | 没有 out/python-logo.png | 117 秒 | 5 | 7 | 5,019 / 21,376 / 6,079 | ¥0.0298 | 1 / 6 [bing] [direct,browser,direct,browser,direct,direct] | 4 | stop |
| r1-T10-agent-browser | 对 | 哈希一致（15770 字节） | 26 秒 | 12 | 11 | 5,122 / 50,432 / 2,793 | ¥0.0173 | ab 命令 9（skills×2 open×1 eval×5 close×1） | 1 | stop |
| r2-T10-agent-browser | 对 | 哈希一致（15770 字节） | 24 秒 | 10 | 9 | 4,710 / 36,352 / 2,521 | ¥0.0155 | ab 命令 7（skills×1 open×1 get×1 eval×3 close×1） | 1 | stop |
| r3-T10-agent-browser | 对 | 哈希一致（15770 字节） | 22 秒 | 8 | 7 | 9,561 / 54,144 / 1,920 | ¥0.0183 | ab 命令 6（open×1 get×1 eval×3 close×1） | 1 | stop |
| r1-T10-deepseek | 没完成 | 没有 out/python-logo.png | 7 秒 | 2 | 1 | 8,041 / 1,792 / 1,166 | ¥0.0127 | 0 / 1（0） [direct] | 0 | stop |
| r2-T10-deepseek | 没完成 | 没有 out/python-logo.png | 30 秒 | 4 | 4 | 8,732 / 23,040 / 4,254 | ¥0.0262 | 0 / 3（0） [direct,direct,browser] | 1 | stop |
| r3-T10-deepseek | 没完成 | 没有 out/python-logo.png | 11 秒 | 3 | 2 | 3,623 / 6,272 / 1,817 | ¥0.0110 | 0 / 2（0） [direct,direct] | 0 | stop |

## 附录 D：重跑

跑这套基准的脚本是内部工具，不随仓库公开。要自己重复这份对比，照 2.3 的跑法和判分做：同一份题面、每个任务每种方式跑三轮、按同样的判分规则（对 / 没完成、产物哈希、轮数、调用次数）记录；key 只从环境变量 `DEEPSEEK_API_KEY` 取，不打印。

- 标准答案里会变的那几项（Node LTS、star 数、产物哈希）自己重新定。
- 另起一套数据另放一个目录，不覆盖这次的。

## 来源

- [S1] DeepSeek 官网"模型 & 价格"：https://api-docs.deepseek.com/zh-cn/quick_start/pricing/ 。2026-10-19 读。写明了 deepseek-flash 的模型版本是 DeepSeek-V4.1-Flash-1017、分时段价格，以及 Search / Fetch 每 1000 次成功请求 5 元。
- [S2] DeepSeek 联网搜索文档：https://api-docs.deepseek.com/zh-cn/guides/search/ 。见 154 号票。
- [S3] nobelprize.org，The Nobel Prize in Chemistry 2026 新闻稿：https://www.nobelprize.org/prizes/chemistry/2026/press-release/ 。2026-10-19 读。
- [S4] agent-browser 0.34.0：`agent-browser skills get core --full` 的输出；用户的 `~/.pi/agent/skills/agent-browser/SKILL.md`。
- 本仓库：
  - `packages/daemon/src/web/`（`access.ts`、`tools.ts`、`fetch.ts`、`deepseek.ts`）；
  - `packages/daemon/src/process/child-env.ts`；
  - `packages/daemon/src/model-settings/providers.ts`；
  - `packages/protocol/src/token-prices.ts`；
  - `packages/daemon/holidays/cn-2026.json`；
  - pi-coding-agent 1.0.4（`core/sdk.d.ts`、`core/system-prompt.js`、`utils/child-process.js`）；
  - pi-ai 1.0.4（`providers/data/deepseek.json`）。
