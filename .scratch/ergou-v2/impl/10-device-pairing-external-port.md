# 10 — 设备配对与外网端口

Status: done
Blocked by: 06（卡片、待我处理与简单提醒）
Spec: [第一阶段规格](../spec.md) 第 6 节（访问与设备配对）、第 1 节（工程与总体架构）、第 2 节（守护进程的模块）、第 5 节（前端协议）、第 19 节（Web UI）、第 21 节（实现细节补充）

## What to build

做完后，手机等其他设备可以经 VPS 的 HTTPS 域名使用二狗，但必须先完成设备配对。新设备第一次打开页面时停在配对等待页，上面显示设备名、6 位短码和 8 位十六进制短指纹；设备名默认取自浏览器和系统信息，用户可以在新设备上改。同时，PC 本机或任何已配对设备的待我处理里出现一张配对请求卡，显示同样的设备名、短码和短指纹。用户核对后批准，新设备拿到一个长期凭证（cookie），进入正常页面；以后在设置的"已配对设备"里能看到它，也能随时吊销，吊销后它立刻被断开。

守护进程新增第二个监听端口——外网端口。它是隧道的唯一目标，永远不享受本机信任：不管请求从哪个 IP 来、Host 写的是什么，从外网端口进来的每个 HTTP 请求和 WebSocket 连接都要带有效的设备凭证，没有凭证只能看到配对页。经隧道来的请求，TCP 对端都是本机，以 nginx 覆盖写的 `X-Real-IP` 作为来源（用于配对请求的限频）。本机端口照旧自动信任，不需要配对。

另外交付公网入口要用的两样东西：`ergou-tunnel` 的 LSM 条目（照抄现有的 `agentsense-tunnel`，换端口，只连守护进程的外网端口），以及 nginx 站点配置的生成和一条部署命令——部署由用户在本机运行这条命令完成，运行命令即为确认，不另出卡。演示（守护进程经 LSM 启动）：在外网端口上走一遍"新设备请求配对 → 本机在待我处理里核对并批准 → 新设备可用 → 在设置里吊销 → 新设备被断开"。

## Acceptance criteria

- [x] 主切面：守护进程同时起本机端口和外网端口。外网端口上不带凭证的 HTTP 接口（含历史分页、媒体上传下载）和 WebSocket 握手一律被拒，只有配对页和配对请求接口可用；即使请求来自 127.0.0.1、Host 和 Origin 写成本机地址，也不享受本机信任。本机端口的行为不变。
- [x] 主切面：新设备在外网端口发起配对请求，拿到设备名（默认由请求里的浏览器和系统信息生成）、6 位数字短码和 8 位十六进制短指纹；新设备改了设备名后，本机端口上的前端订阅的待我处理里那张配对请求卡显示改过的设备名，以及同一个短码和短指纹。
- [x] 主切面：在本机或已配对设备上批准配对请求卡后，新设备拿到 cookie：HttpOnly、Secure、SameSite=Strict，值是 256 位随机数；`ergou.db` 里只存它的哈希，数据目录的任何文件里都搜不到原值。之后这台设备在外网端口上的 HTTP 请求和 WebSocket 连接都被接受。两台已信任设备同时批准同一张卡时，后到的得到"已被处理"。批准配对不产生素材事件。
- [x] 主切面（可注入时钟）：待批的配对请求 5 分钟后过期，过期后批准不发凭证、卡片不能再处理；以 `X-Real-IP` 认定来源，同一来源 10 分钟内的第 6 个配对请求被拒，换一个 `X-Real-IP` 的请求不受影响。
- [x] 主切面（可注入时钟）：凭证有效期 365 天、每次使用都续期——第 300 天用过的凭证到第 400 天仍然有效；连续 365 天没用过的凭证失效，再访问回到配对页。
- [x] 主切面：设置里能列出已配对设备；吊销某台后，它已经打开的 WebSocket 立即被服务端关闭，后续请求被拒，其他设备不受影响。前端状态层回放：吊销事件之后，已配对设备列表少了这一台。
- [x] Web UI：新设备上的配对等待页（显示设备名并可修改、短码、短指纹）、已信任设备上的批准页（显示设备名、短码、短指纹供核对）、设置页里的"已配对设备"列表和吊销按钮都可用；页面脚本里不出现私钥或令牌（凭证只在 HttpOnly cookie 里）。
- [x] nginx 配置生成：生成的站点配置支持 WebSocket、放大了 `client_max_body_size`、加长了 `proxy_read_timeout`、每个 location 都覆盖写 `X-Forwarded-For` 和 `X-Real-IP`、带 HSTS，上游指向 VPS 上只绑本机地址的隧道端口，域名按 `ergou.<VPS>.sslip.io`；用断言逐项验证。
- [x] 部署命令（ssh 用可替换的执行器测试）：守护进程和任何 agent 都不会自己发起部署，只有用户在本机运行部署命令时才执行一次 ssh 部署；`ergou-tunnel` 的 LSM 条目存在，目标是守护进程的外网端口。
- [x] 所有测试通过（vitest），lint（oxlint）无报错。

## Notes

- **不在本票**：本机端口和它的 Origin/Host 校验已由 04 号票做好；两个端口的默认端口号在 01 号票查过本机已登记的端口后选定，从配置读。`ergou-daemon` 的 LSM 条目从 04 号票起就已登记（指向主分支构建产物），本票只加 `ergou-tunnel`。二狗自己不启动隧道，隧道只由 LSM 启停。自动测试里在临时目录起的守护进程实例是测试的一部分，不算服务。
- 配对请求卡用 06 号票的卡片实体和按钮闭环（按版本条件更新、先到先得、"已被处理"），不另写一套；已配对设备是 `ergou.db` 里的派生视图。
- 短码和短指纹在批准一侧都是显示出来供用户核对，批准时不需要输入短码。
- 规格第 6 节说部署"按'对外发送或发布'先问用户"：落实为用户在本机亲手运行部署命令，运行即确认。部署不是 agent 的工具调用，不经守卫，也不用 07 号票的审批卡。
- 配对请求卡上的批准不算第 15 节的"审批决定"，不进素材。
- 证书沿用 VPS 上现有的 Let's Encrypt 做法，本票不签证书。
- **外部前提**：公网真机上线前要先修好 LSM 的两个已知问题（隧道 PID 复用导致的误判、`vps.key` 路径错误）。这不在本仓库里改，上线演示前先核实已经修好。
- 对应用户故事：119–123、149。

## Comments

2026-10-08 实现说明（子 agent，分支 `worktree-agent-ae56e3ab956f06126`，已变基到合并了 09 号票的 main）：

- **没做的**（按主会话的要求）：没有连 VPS、没有运行部署命令、没有在 LSM 登记 `ergou-tunnel`、没有起常驻进程，所以"守护进程经 LSM 启动、在外网端口上走一遍"的演示没做；步骤写进了 `docs/dev.md` 的"公网入口"第 6 步。做过一次一次性的无头浏览器冒烟（临时数据目录、系统挑的端口、faux 秘书、真实的 Web 构建产物，跑完即停、目录删掉）：新设备打开外网端口 → 配对等待页（默认名 `Chrome · Windows`、改名生效、5 分钟到了显示过期、重新请求）→ 本机待我处理出现配对请求卡并在页面顶上提示 → 批准页核对 → 新设备"进入二狗"后正常使用 → 设置里吊销 → 新设备立刻回到配对等待页、本机列表里它进了"已失效"。`Secure` 的 `__Host-` cookie 在 `http://127.0.0.1` 上 Chrome 照收（本机算安全上下文）。
- **外部前提**照票里写的：上线前先核实 LSM 的两个已知问题（隧道 PID 复用误判、`vps.key` 路径）已经修好，写进了 dev.md。
- **取舍和规格没写死的地方**（都取最保守、最贴近规格的做法）：
  1. 外网端口也只监听 127.0.0.1（隧道从本机连过来）。没凭证时只放行页面本身 `GET /`（就是同一份 Web UI，它看到自己没被信任就只显示配对等待页）、`/api/access`、`/api/pairing`；别的一律 401（`HttpErrorBody` 的 `unauthorized`），WebSocket 握手 401。门在路由之前，以后加的 HTTP 接口自动在门后面（09 的历史分页、上传下载已经在主切面里验过）。带了 Origin 就必须和 Host 同源（不同源 403），这只是多一道防跨站，不因此得到信任。
  2. **凭证在新设备来领的时候才生成**（不是批准的那一刻）：批准只把请求变成已批准；新设备下一次来问时生成 256 位随机值，同一事务里只记哈希，原值只出现在那一个响应里。所以"只存哈希、数据目录里搜不到原值"是结构上保证的。批准后 5 分钟内没来领就作废（`PAIRING_CLAIM_WINDOW_MS`）。认出"这台设备的请求"靠发起时下发的配对 cookie（同样 HttpOnly、只存哈希）；8 位短指纹由它推出，6 位短码另外随机。
  3. cookie 名带 `__Host-` 前缀（`__Host-ergou-device`、`__Host-ergou-pairing`）：浏览器只接受 Secure、Path=/、不带 Domain 的，同一 `*.sslip.io` 下别的子域名覆盖不了。凭证有效时每个 HTTP 响应都重新下发一次 cookie（Max-Age 365 天），浏览器里的到期跟着服务端续期；带着失效凭证来的，顺带让浏览器删掉它。
  4. **"每次使用都续期"落成：使用记录最多一小时落一次**（`DEVICE_USE_RECORD_INTERVAL_MS`），免得每个请求都写一条事件；续期因此最多差一小时（偏保守，只会早失效不会晚）。**这是评审接受的偏差**：规格说"每次使用续期"，实现是"每次使用都算，但最多一小时记一次"，有效期因此最多提前一小时到期，不会推迟。HTTP 请求、WebSocket 握手、开着的 WebSocket 每次心跳都算使用。
  5. 配对请求和凭证的哈希放在守护进程内部的频道 `pairing` 上（不在前端协议的 `Channel` 里，前端订阅会被拒），哈希不推给任何前端；已配对设备本身（不含凭证）在新的前端频道 `devices` 上，事件 `device`（`paired` / `used` / `revoked`）。已配对设备、配对请求都是 `ergou.db` 里的派生视图。
  6. 限频按派生视图里已落下的配对请求数算（守护进程重启也算数），被拒的那次不算进窗口。来源取 `X-Real-IP`（不像 IP 就用 TCP 对端），只在外网端口上信任它。第 6 个回 429 `too_many_requests`。
  7. 新设备改名：同一事务里改请求、卡片负载（版本加 1）和待我处理事项的标题——用户拿旧版本去批准会得到冲突，批准的一定是他看到的名字。只有待批时能改。
  8. 拒绝是"已处理"（`outcome: deny`）不是"已关闭"，不产生回避信号；批准不是审批卡，只追加请求事件和卡片更新两条（主切面断言了）。**08 号票采集素材时不要把配对请求卡当审批决定**。
  9. 吊销是新的前端请求方法 `revoke_device`（带幂等键）；已经吊销的再吊销回 `conflict`；已配对设备也能吊销设备，包括它自己（先收到响应，再被关连接，关闭码 4401）。吊销的设备开着的页面经 `checkAccess` 发现凭证失效后回到配对等待页，**这时不自动发起新的配对请求**（免得刚吊销的设备马上又冒出一张卡），要在那台设备上点"重新请求配对"。凭证按时间过期的设备，列表里按 `expiresAt` 显示成"已失效"（只用于显示，判定在服务端）。
  10. WebSocket 心跳（04 留下的）：两个端口都有，服务端每 30 秒 ping，上一轮没回 pong 的直接断掉；外网端口的连接顺带复查凭证。
  11. 本票加了 HTTP 错误码 `unauthorized`、`forbidden`、`too_many_requests`（09 的 `HTTP_ERROR_CODES`），前端协议的错误码加了 `rate_limited`（配对模块用，HTTP 接口回成 `too_many_requests`）。HTTP 路径 `HTTP_PATHS.access`、`HTTP_PATHS.pairing` 和响应体 `AccessInfo`、`PairingRequestView` 跟 09 的放在一起（`http.ts`、`http-schema.ts`）。
- **nginx 和部署**：
  - 生成的站点：`/ws` 升级连接、`client_max_body_size 256m`（09 的单文件上限 200 MB 一次传上来也够）、`proxy_read_timeout` / `proxy_send_timeout` 3600 秒、每个 location 都覆盖写 `X-Forwarded-For` 和 `X-Real-IP`（用 `$remote_addr`，不用追加式的 `$proxy_add_x_forwarded_for`）、server 里加 HSTS 一年（location 里不写 add_header，免得把它顶掉）、上游 `http://127.0.0.1:18811`、域名 `ergou.<VPS>.sslip.io`。证书只引用路径（默认 `/etc/letsencrypt/live/<域名>`），不签证书。
  - **要用户知道的一点**：如果 VPS 上已有一个按 SNI 分流的前门（stream 占着 443，转给本机端口上的站点），二狗的 nginx 站点站在它后面，看到的 `$remote_addr` 都是 127.0.0.1，配对请求的限频就成了全局的（10 分钟里总共 5 个）——仍然安全，只是陌生人刷请求时会挡住自己的配对 10 分钟。前门开 `proxy_protocol` 的话，把 `nginx.listen` 写成 `127.0.0.1:8443 ssl proxy_protocol`、`nginx.clientAddress` 写 `$proxy_protocol_addr` 就按真实来源限频（会影响同一个前门后面的别的站点，由用户决定）。
  - 部署命令 `npm run deploy:nginx`（`packages/daemon/src/deploy-nginx.ts`）：读数据目录配置里的 `publicAccess`，一条 ssh（`BatchMode`），远端 `sh -s`、脚本和配置都从 stdin 送（不在命令行上拼引号）：写 `sites-available/ergou.conf`（旧的留 `.bak`）、链接、`nginx -t` 通过才 reload，没通过就恢复并非零退出。`--print` 只打印配置。配置项按严格的字符集校验，占位符不收。"守护进程和任何 agent 都不会自己发起部署"用源码扫描测：只有这个入口引用部署模块，只有部署模块里出现 `ssh`。
  - `deploy/lsm/ergou-tunnel.example.yaml` 是一条 ssh 反向隧道（argv 起 ssh、`-R 127.0.0.1:18811:127.0.0.1:8811`、process 档按 `matchCmd` 认、autoRestart），VPS 地址、私钥路径、用户都是占位符；`ergou-daemon.example.yaml` 加了 `exposure` 段的示例（LSM 要求 `via` 指向的隧道已登记，所以登记隧道之后再加）。
- **变基时和 09 号票的合并**：`HTTP_PATHS`、`HttpErrorBody` 用 09 的（本票的路径和错误码加进去）；网关的路由顺序是 `/api/access`、`/api/pairing`、其余 `/api/` 交给 09 的 `http-api.ts`；测试底座里 09 已经有 `test/helpers/http.ts`（上传下载），本票"像浏览器一样带 cookie 和 X-Real-IP"的请求改名为 `browser-http.ts`。
- **票里的用户故事编号**：写的是 119–123、149，规格里设备配对对应的是 120–124（本机直接用、一律经 VPS 域名、配对核对、过期和限频、吊销）和 150（nginx 由二狗生成、ssh 部署）。
- **后续票要知道的**：
  - 外网端口上已配对设备的 WebSocket 连接带 `deviceId`；以后要"按设备"做事（比如 25 号票的活动状态、第二阶段的推送）可以从这里取。
  - 新的 HTTP 接口不用管鉴权：外网端口的门在路由之前。
  - 测试底座：`startTestDaemon()` 返回 `externalUrl`，`test/helpers/device.ts` 的 `TestDevice` / `pairDevice(...)` 模拟一台经隧道来的设备；`TestFrontend.connect(url, { cookie, noPong })`、`closed()`。

2026-10-08 评审后的修改（同一分支，新提交）：

- **前门后面的来源和默认配置**：`nginx.listen` 默认改成站在本机前门后面的 `127.0.0.1:8443 ssl`（`DEFAULT_NGINX_LISTEN`），示例配置里是要换掉的占位符；`clientAddress` 仍默认 `$remote_addr`。来源是本机地址（127.0.0.1、::1，含 IPv4 映射写法）时，卡片上的来源写"经前门转发，无法识别"（`UNIDENTIFIED_SOURCE_LABEL`），限频照样按它算；dev.md 写明没开 `proxy_protocol` 时限频实际上是全局的，开不开由用户决定。
- **吊销后刷新不自动重新申请**：外网端口上带着失效的凭证问 `/api/access` 时，`none` 附上原因（`reason: revoked | expired`，同一个响应让浏览器删掉凭证）；页面问到"被吊销"就在 localStorage 里留一个不敏感的记号（固定值，不含设备 id 和凭证），配对等待页按 `pairingOpening(原因, 记号)` 开场：被吊销的只显示"此设备已被吊销"和"重新申请"，点了才擦掉记号并发起请求；重新被信任时也擦掉。新增回放用例 `device-revoked-here`（被吊销的那台设备上的页面录下来的输入）和记号的单测。
- **领取响应丢了造成的幽灵设备**：设备记录领到凭证时是"未启用"（`activated: false`，`expiresAt` 为领到后 24 小时，`DEVICE_FIRST_USE_WINDOW_MS`），第一次带着凭证来才启用（`device` 事件 `activated`，有效期从这时起算 365 天）；24 小时里一次也没用过就自动作废（按到期时间判断，和 365 天过期同一条路）。设置里显示"等待首次使用"，作废的进"已失效"一组。主切面补了两条用例（启用、作废）。
- `ergou-daemon.example.yaml` 的 `exposure` 段改成注释掉的示例，写明什么时候打开（登记 `ergou-tunnel` 之后），照抄登记不会因为 `via` 指向不存在的服务而失败；补了用例。
- 错误到状态码只有 `http-api.ts` 的 `STATUS_OF` 一张表：它导出 `sendJson`（带 `SECURITY_HEADERS`，含 CSP）和 `sendError`，外网端口、配对接口、两个端口的来源校验 403 都用它们，删掉了 `replyJson` / `replyHttpError` 和写死的状态码；配对模块的拒绝只映射到 HTTP 错误码。补了用例：外网端口的响应头和本机端口一样。
- 配对常量集中：短码、指纹的 pattern 由 `PAIRING_SHORT_CODE_DIGITS`、`PAIRING_FINGERPRINT_HEX_DIGITS` 生成，原型的预览配对接口也用它们；界面和报错里的"5 分钟""365 天""10 分钟 5 个"由 `durationText(常量)` 拼出；待我处理的标题是 `pairingRequestTitle`。
- 框架文件里去掉了个人基础设施的描述（隧道示例、dev.md、本票 Comments 里的措辞改成中性的"如果 VPS 上已有一个按 SNI 分流的前门……"；顺带 `ergou-daemon.example.yaml` 里 04 号票留下的一句同类注释）。
- 小改：截止时间判断抽成 `deadlineOf(r)`；重复的拒绝说法、"重新申请"按钮文字抽成常量；`{ deviceId; refresh() }` 命名为 `DeviceSession`；`PairingClient` / `httpPairingClient` 改名 `PairingApi` / `httpPairingApi`（文件 `pairing-api.ts`），预览的是 `previewPairingApi`。
- 保留不改（主会话会补进规格）：批准后 5 分钟领取窗口、拒绝按钮、外网 Origin 必须等于 Host、`__Host-` 前缀、`devices` 频道、`/api/access` 和 `revoke_device`（能吊销任何设备，包括自己）。

- 2026-10-08 完成：经两轴代码评审并按意见修改（统一错误响应与安全头、配对常量集中、去掉个人基础设施描述、吊销后不自动重新申请、幽灵设备作废、前门后来源显示）后压缩合并进 main。经 LSM 启动、走一遍外网端口的演示，待用户确认 LSM 登记和隧道后再做；前门是否开 proxy_protocol 待用户决定。
