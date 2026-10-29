# 二狗接入用户自己的 Google 账号数据：调研笔记

调研日期：2026-10-25。以官方一手资料为准，每条结论后面写了出处；括号里的"页面更新"是那一页底部写的最后更新日期（帮助中心的页面大多不写日期，就只标"无日期"）。二手文章只当线索，用到的地方都明确标了"二手"。

本次只查资料：没登录账号、没建 Google Cloud 项目、没调任何 Google 接口、没装任何东西。

---

## 先看结论

| 数据 | 现在能不能接 | 怎么接 | 档位 |
|---|---|---|---|
| 账号资料（姓名、头像、邮箱、生日、性别、电话、地址） | 能 | People API `people/me` | 姓名、邮箱、头像属于普通档；生日、性别、电话、地址属于敏感档 |
| 联系人（家人朋友的生日、电话、地址、关系） | 能 | People API `connections.list`，支持增量同步 | 敏感 |
| Gmail（读、搜、标签、发信） | 能（自用） | Gmail API；只读和元数据都算受限档 | 受限（发信单独算敏感） |
| 日历（事件、提醒、生日、节假日） | 能 | Calendar API，用 syncToken 增量同步；只读还可以走"私密 iCal 地址" | 敏感 |
| 地图：时间线 / 位置记录 | **没有 API** | 时间线现在只存在手机上，只能从手机手动导出 JSON 再导入 | — |
| 地图：收藏的地点、评价 | **没有常规 API** | 用 Takeout 手动导出再导入；Data Portability API 只对欧洲经济区（EEA）用户开放 | （DPA 的这几项属于受限或敏感） |
| Drive | 能 | `drive.file` 配合文件选择器（普通档），或者 `drive.readonly`（受限档） | 普通 / 受限 |
| Photos | 只能让用户自己挑 | 2025-03-31 起 Library API 只能访问 App 自己建的内容；读用户的照片要走 Picker API | — |
| 健康 | 不建议做 | Fit API 支持到 2026 年底；Health Connect 只在安卓手机本机；Google Health API 只有 Fitbit 或 Pixel Watch 的数据 | 受限 |

**一句话**：单用户自用的话，**People、日历、Gmail 现在就能做**。做法是建一个外部（External）应用，不提交验证、按"个人使用"豁免，不用过 CASA 安全评估。两种状态的区别：
- 停在"测试"状态：每 7 天要重新授权一次；
- 发布成"正式版"但不验证：令牌不会 7 天过期，代价是授权时要点过一个"未经验证"的警告页，而且这个应用一辈子最多 100 个用户。

地图时间线、收藏这类数据只能**手动导出文件再导入**。健康数据不建议做。

---

## 0. 二狗现在的日历有没有接外部日历：没有

只读看了 `packages/daemon/src/calendar/`（`plugin.ts`、`calendar.ts`、`api.ts`）：

- 日历插件只是把三样东西**按天合在一起看**：工作日判定（内核的工作日历）、当天的提醒（提醒插件）、当天的定时作业。注释里写着它"不拥有数据：日历只是合起来看的视图，没有派生视图、事件、卡片、改写函数、素材来源，没有数据契约"。
- 节假日数据来自两个地方：框架自带的 `holidays/<地区>-<年>.json`（新加坡和国内），以及用户发起的"节假日更新任务"交来的文件（`workday/holiday-data.ts`、`holiday-check.ts`）。没有 iCal、CalDAV、Google 或 Outlook 的拉取。
- 整个守护进程里出现的 "google" 只有两类：联网搜索里排在第三位的 Google 搜索引擎（`web/access.ts`、`web/search.ts`），以及守卫识别密钥用的 `AIza…` 形式的 API key（`guard/secrets.ts`）。依赖里没有 `googleapis`。

所以接 Google 日历是**新功能**。接进来以后日历插件第一次会有"外部来源"，需要定它归谁：是 Google 插件把事件交给日历插件（日历插件把它列为可选依赖 wants），还是日历插件自己拥有一份同步来的数据（那样就要补上数据契约，移除时连数据一起删）。

---

## 1. 认证：本机守护进程该用哪种 OAuth 流程

### 1.1 几种流程，官方现在怎么说

| 流程 | 官方现状 | 对二狗 |
|---|---|---|
| **已安装应用 + 回环地址**（`http://127.0.0.1:端口`） | 官方推荐。Windows、macOS、Linux 桌面程序都用它；**必须用 PKCE**（推荐 S256）；客户端类型选 **Desktop app** | ✅ 首选 |
| 自定义 URI scheme | "已不再支持"，理由是有被仿冒的风险 | ✗ |
| 手动复制粘贴（OOB，`urn:ietf:wg:oauth:2.0:oob`） | "已不再支持"，2022 年 2 月宣布弃用 | ✗ |
| **设备码流程**（电视、受限输入设备） | 只支持 `openid`、`email`、`profile`、`drive.appdata`、`drive.file`、`youtube`、`youtube.readonly` 这几个 scope，**没有 Gmail、日历、联系人** | ✗ 用不了 |

出处：
- [OAuth 2.0 for iOS & Desktop Apps](https://developers.google.com/identity/protocols/oauth2/native-app)（页面更新 2026-10-16）
- [OAuth 2.0 for TV and Limited-Input Device Applications](https://developers.google.com/identity/protocols/oauth2/limited-input-device)（页面更新 2026-10-16）

几个要点：
- 桌面程序属于"公共客户端"。原文是 "Desktop apps are public clients and cannot keep secrets confidential"，所以 client secret 在官方眼里不算真正的秘密，靠 PKCE 保证安全；换令牌时 `client_secret` 写的是"可选"。即便如此，二狗还是把它放进密钥区，不进仓库。
- 已安装应用**一定会拿到 refresh token**。
- 已安装应用**不支持增量授权**（"Incremental authorization is not supported for installed apps"）。以后用户想多开一类数据（比如先开了日历，后来要开 Gmail），只能带着更大的 scope 集合重新走一遍授权。
- 撤销令牌：`POST https://oauth2.googleapis.com/revoke`。撤销 access token 时，跟它关联的 refresh token 也一起撤销。

### 1.2 二狗特有的两个坑：页面可能是在手机上打开的

1. **回环地址只对"跟守护进程在同一台机器上的浏览器"有效**。用户如果在鸿蒙 App 里、或者经隧道在手机浏览器里点"连接 Google"，同意之后 Google 会跳到 `http://127.0.0.1:端口/...`，而这个地址在手机上指的是手机自己，打不开。
2. **Google 禁止在自己控制的嵌入式浏览器里打开授权页**。原文是 "A developer must not direct a Google OAuth 2.0 authorization request to an embedded user-agent under the developer's control"（[OAuth 2.0 Policies](https://developers.google.com/identity/protocols/oauth2/policies)，最后修改 2026-08-05）。鸿蒙 App 外壳里的 ArkWeb 页面不能直接加载 Google 的同意页，**必须跳到系统浏览器**。

可选的三种做法：

| 做法 | 说明 | 评价 |
|---|---|---|
| A. 在电脑浏览器上完成那一次授权 | 二狗网页上点"连接 Google"，守护进程临时监听一个回环端口，用电脑上的系统浏览器打开同意页 | 最省事。授权只做一次（发布成正式版以后不会 7 天过期） |
| B. 在手机上授权，再把跳转失败的地址复制回二狗 | 手机系统浏览器里同意后，地址栏里是 `http://127.0.0.1:端口/?code=…`，页面打不开，但 code 就在地址里。把整段地址粘回二狗，守护进程手里有 PKCE 的 verifier，可以拿它换令牌 | 技术上可行，但**不是官方描述的用法**，当兜底用 |
| C. 改用"Web 应用"类型的客户端，回调到隧道的 HTTPS 域名 | Web 客户端的回调地址必须是 HTTPS（只有 localhost 例外），不能用裸 IP（[Web server 流程的回调地址规则](https://developers.google.com/identity/protocols/oauth2/web-server)） | 要有固定的公网域名；二狗的外网端口每个请求都要带设备凭证，回调这条路径还得单独开口子，等于安全面要另算。**不推荐**，至少等安全机制接入以后再说 |

### 1.3 要在 Google Cloud 建什么（下面写的是步骤，本次没有动手）

1. **建一个 Cloud 项目**，在里面启用要用的 API：People API、Gmail API、Google Calendar API（以后要的话再加 Drive API、Photos Picker API）。
2. **Google Auth Platform**（原来叫"OAuth 同意屏幕"），分四块：
   - **Branding**：应用名、支持邮箱；
   - **Audience**：用户类型选 **External**，发布状态先是"测试"，把自己的 Gmail 加成测试用户（最多 100 个）；
   - **Data Access**：勾上要的 scope；
   - **Clients**：建客户端。

   出处：[Configure the OAuth consent screen](https://developers.google.com/workspace/guides/configure-oauth-consent)（页面更新 2026-09-03）、[Manage App Audience](https://support.google.com/cloud/answer/15549945)（无日期）。
3. **"内部"（Internal）用户类型个人账号用不了**：它要求项目属于一个 Google Cloud Organization，也就是 Google Workspace 或 Cloud Identity 组织，普通 `@gmail.com` 没有这个。出处同上，另见 [When is verification not needed](https://support.google.com/cloud/answer/13464323)。
4. **客户端类型选 Desktop app**。官方原话是 Desktop 类型 "requires no extra information"，不用登记回调地址。下面两条是 2025 年以后的新规矩，二狗要特别注意（[Manage OAuth Clients](https://support.google.com/cloud/answer/15549257)，无日期）：
   - **client secret 只在创建那一刻能看到和下载**。2025 年 6 月以后新建的客户端都这样，2025 年 11 月起老客户端也一样，之后控制台里只显示末四位。丢了就只能轮换一个新的。
   - **6 个月没有活动的客户端会被自动删除**。删除前 30 天会发邮件提醒，删了以后一般 30 天内还能恢复。二狗如果半年没用 Google 插件，客户端可能就没了。
5. **不用绑结算账户**。Gmail 和 Calendar 的配额页都写着 "All standard use … is available at no additional cost"。不过两页也都写了"计划在 2026 年晚些时候对**超出配额**的请求收费"，自用的量远远到不了。出处：[Gmail API 配额](https://developers.google.com/workspace/gmail/api/reference/quota)（页面更新 2026-10-16，每个用户每分钟 6000 配额单位）、[Calendar API 配额](https://developers.google.com/workspace/calendar/api/guides/quota)（页面更新 2026-09-11，每个用户每分钟 600 个请求）。

### 1.4 refresh token：怎么存，什么时候会失效

**怎么存**
- 官方要求："Never transmit tokens in plaintext, and **always store encrypted tokens at rest**"；client 凭据要像对待机密一样，**绝不能提交到公开仓库**；不再需要的时候撤销并彻底删除（[OAuth 2.0 Policies](https://developers.google.com/identity/protocols/oauth2/policies)）。
- 放二狗的位置：数据目录的**密钥区**（`config/data-dir.ts` 里的 `layout.secrets`，任何 agent 连读都会被硬拒绝，这是 ADR-0026 里保留不关的那部分）。
- 在 Windows 上建议用 **DPAPI**（按当前 Windows 用户加密）再写文件。DPAPI 怎么在 Node 里调、用哪个库，实现时再定，本次不选型。

**会失效的情况**（出处：[Using OAuth 2.0 to Access Google APIs · Refresh token expiration](https://developers.google.com/identity/protocols/oauth2#expiration)，页面更新 2026-10-16）

| 情况 | 对二狗的影响 |
|---|---|
| **应用是 External 且停在"测试"状态：refresh token 7 天后过期**。例外是只申请了姓名、邮箱、个人资料（profile）这几个 scope | 只要申请 Gmail、日历、联系人，**每周都要重新授权一次** |
| 6 个月没用过 | 二狗每天都会同步，用来刷新令牌，正常情况下碰不到 |
| 用户改了密码，**而且令牌里有 Gmail 的 scope** | 改密码以后要重新授权 |
| 用户在 Google 账号里撤销了授权 | 二狗要能识别 `invalid_grant`，回到"未连接"状态 |
| 同一个 Google 账号、同一个客户端最多 **100 个**有效的 refresh token，超出的话最老的那个失效；每个账号在所有客户端上加起来另有一个总上限 | 每次重新授权都会多一个；二狗只保留最新的那个就行 |
| 用户授权时选了"限时访问"，到期了 | 少见 |
| 管理员把对应服务设成了受限（只有 Workspace 账号才会遇到） | 个人账号碰不到 |

---

## 2. scope 分级和应用验证

### 2.1 三个档位分别要什么

官方分三档（[Configure the OAuth consent screen](https://developers.google.com/workspace/guides/configure-oauth-consent)、[People API · Authorize requests](https://developers.google.com/people/v1/how-tos/authorizing)，两页都是 2026-09-03 更新）：
- **普通**（non-sensitive）：只要做基本验证；
- **敏感**（sensitive）：基本验证，加上额外的应用验证；
- **受限**（restricted）：基本验证，加上额外的应用验证，**再加安全评估**。

某个 scope 属于哪一档，在 Cloud 控制台里勾选 scope 时会自动标出来。

**受限清单**（[Restricted Scopes](https://support.google.com/cloud/answer/13464325)，无日期）包括：Gmail（全部读写 scope 都在里面）、Drive（全盘、只读、元数据、活动等）、**Google Fit**、Google Chat、**Data Portability API**、Photos Ambient、**Google Health API**。
**People API 和 Calendar API 不在受限清单里**。官方给敏感 scope 举的例子正好是"读取 Google 日历里的事件""在 Google 通讯录里新建联系人"（[Sensitive scope verification](https://developers.google.com/identity/protocols/oauth2/production-readiness/sensitive-scope-verification)，页面更新 2026-08-19）。

### 2.2 每类数据用哪个 scope

| 数据 | API | 建议用的 scope（够用就好） | 档位 | 出处 |
|---|---|---|---|---|
| 登录、姓名、邮箱、头像 | OpenID / People | `openid`、`userinfo.email`、`userinfo.profile` | 普通（7 天规则的例外就是这几个） | [Refresh token expiration](https://developers.google.com/identity/protocols/oauth2#expiration) |
| 本人的生日、性别、电话、地址 | People `people/me` | `user.birthday.read`、`user.gender.read`、`user.phonenumbers.read`、`user.addresses.read`、`user.emails.read` | 敏感（官方页没逐个标档位，按控制台显示为准） | [people.get](https://developers.google.com/people/api/rest/v1/people/get)（2024-08-06）、[OAuth 2.0 Scopes](https://developers.google.com/identity/protocols/oauth2/scopes)（2026-09-14） |
| 联系人 | People `connections.list` | `contacts.readonly`（要写回才用 `contacts`）；"其他联系人"用 `contacts.other.readonly` | 敏感 | [connections.list](https://developers.google.com/people/api/rest/v1/people.connections/list) |
| 日历 | Calendar | 只读：`calendar.readonly` 或 `calendar.events.readonly`；读写事件：`calendar.events`；只碰二狗自己建的副日历：`calendar.app.created` | 敏感 | [Choose Calendar API scopes](https://developers.google.com/workspace/calendar/api/auth)（2026-09-03） |
| Gmail 只看标签 | Gmail | `gmail.labels` | 普通 | [Choose Gmail API scopes](https://developers.google.com/workspace/gmail/api/auth/scopes)（2026-09-10） |
| Gmail 发信 | Gmail | `gmail.send` | 敏感 | 同上 |
| Gmail 读、搜 | Gmail | `gmail.readonly`（`gmail.metadata` 只能看邮件头和标签，**而且不能用 `q` 搜索**） | **受限** | 同上；[messages.list](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages/list)（2026-04-15） |
| Gmail 改标签、存草稿 | Gmail | `gmail.modify` / `gmail.compose` | **受限** | 同上 |
| Drive | Drive | `drive.file`（只能碰用户用选择器挑出来、或者二狗自己建的文件）；`drive.readonly` 能读整个网盘 | 普通 / **受限** | [Choose Drive API scopes](https://developers.google.com/workspace/drive/api/guides/api-specific-auth)（2026-09-03） |
| Photos | Photos Picker | `photospicker.mediaitems.readonly` | 官方页没标档位 | [Photos authorization](https://developers.google.com/photos/overview/authorization)（2025-08-28） |
| 待办（顺带一提） | Tasks | `tasks.readonly` / `tasks` | 控制台为准 | [OAuth 2.0 Scopes](https://developers.google.com/identity/protocols/oauth2/scopes) |

另外，授权页上用户可能**只勾其中几项**（官方叫"细粒度授权"）。代码里要检查实际拿到了哪些 scope，按拿到的开放对应功能（[How to handle granular permissions](https://developers.google.com/identity/protocols/oauth2/resources/granular-permissions)，2026-05-26 更新；这页没有明确说桌面应用也会这样，按"可能会"来做）。

### 2.3 只给自己用，要不要验证、要不要过 CASA

**官方豁免**（[When is verification not needed](https://support.google.com/cloud/answer/13464323)，无日期；[Restricted scope verification](https://developers.google.com/identity/protocols/oauth2/production-readiness/restricted-scope-verification)，2026-08-19 更新）：
- **个人使用**："If the app is for your personal use (fewer than 100 users)"。用户可以点过"未经验证"的警告页；想超过 100 个用户才必须验证。
- **开发、测试、预发布状态**：不用验证，但同样有警告页和 100 个用户的上限。
- 内部应用、只用服务账号访问自己数据的，也豁免（这两种二狗都用不上）。

**CASA 安全评估**：只有申请了受限 scope、**并且**数据会"from or through a third-party server"被访问的应用才需要。评估由 Google 认可的第三方机构做，至少每 12 个月复评一次。二狗是个人使用、**本来就豁免验证**，所以 CASA 也不用做。
- Gmail 那一页的说法是："If you store restricted scope data on servers (or transmit), then you must go through a security assessment"；
- 官方没有写"纯本机客户端可以免评估"这一条，判断要不要评估看的是"数据会不会经过第三方服务器"。

**不验证的代价**（[Unverified apps](https://support.google.com/cloud/answer/7454865)，无日期）：
- 授权前会先出现"未经验证的应用"警告页；
- 用户的 Google 账号安全检查（Security Checkup）里可能把这个应用标成有风险；
- 这个项目**一辈子最多 100 个新用户**，而且不能重置（跟"测试用户最多 100 个"是两回事）。

**仍然必须遵守的**：所有接 Google API 的应用，不管验没验证，都要遵守 [Google API Services User Data Policy](https://developers.google.com/terms/api-services-user-data-policy)（2024-02-15 更新）的"有限使用"（Limited Use）条款：
- 数据只能用来提供或改进用户看得见的功能；
- 原则上不许转给别人，也不许让人工去读。

Gmail、日历、Drive 这些属于 Workspace API，另外还有 [Workspace API User Data and Developer Policy](https://developers.google.com/workspace/workspace-api-user-data-developer-policy)（2026-09-03 更新），其中明确**禁止**：用这些数据"create, train, or improve a machine learning or artificial intelligence model … beyond that specific user's personalized model"。
对二狗的意思是：把邮件、日历内容交给大模型做总结、回答用户，属于"提供用户看得见的功能"，政策允许；但要**选不拿 API 数据去训练的模型服务**，而且不能把这些数据拿去做通用的训练语料。

### 2.4 自用的两种姿势，选哪个

| | 停在"测试"状态，把自己加成测试用户 | 发布成"正式版"但不提交验证（按个人使用豁免） |
|---|---|---|
| 警告页 | 有 | 有（每次重新授权都要点过去） |
| refresh token | **7 天过期**（只申请了姓名、邮箱、个人资料时例外） | **不会 7 天过期**，只按 1.4 里的一般规则失效 |
| 用户上限 | 最多 100 个测试用户 | 一辈子最多 100 个新用户 |
| 要不要验证或 CASA | 不要 | 不要（个人使用豁免） |
| 适合 | 刚开始调试的时候 | **二狗长期用** |

佐证：rclone 官方文档教用户建自己的客户端 ID 时就是这么写的：测试状态下 "any grants will expire after a week"；自用的话点"PUBLISH APP"，然后在登录时点过"未经验证"的警告页就行（[rclone · Google Drive](https://rclone.org/drive/)，二手，只当佐证）。

风险：如果哪天 Google 收紧，对没验证的正式版应用直接拦截受限 scope（比如 Gmail），就只能退回"测试"状态、每周重新授权一次。所以二狗要做一个"令牌失效 → 待我处理里放一条'Google 授权过期，点这里重新连接'"的事项。

---

## 3. 各类数据具体能拿到什么

### 3.1 账号资料：People API `people/me`

- `personFields` 能要这些：`names`、`photos`、`emailAddresses`、`birthdays`、`genders`、`phoneNumbers`、`addresses`、`relations`、`events`、`organizations`、`biographies`、`nicknames`、`urls`、`memberships` 等，大约 30 个（[people.get](https://developers.google.com/people/api/rest/v1/people/get)，2024-08-06 更新）。
- 读本人的私有字段需要对应的 `user.*.read` scope，公开字段不用授权。
- 对二狗：能给**本人那份个人档案**提供"候选值"，比如生日、电话、住址。按 CONTEXT.md 里的规矩，"写进去的都经用户确认过"：Google 拉来的值只能当候选，用户点头以后才进固定信息。

### 3.2 联系人：People API `connections.list`

- 返回本人的联系人，每页 1 到 1000 条（[connections.list](https://developers.google.com/people/api/rest/v1/people.connections/list)，2024-08-06 更新）。字段跟上面一样，家人朋友的 **`birthdays`、`phoneNumbers`、`addresses`、`relations`（关系，比如配偶、母亲）、`events`（纪念日等）** 都能拿到。
- **增量同步**：
  - 第一次带上 `requestSyncToken=true`，以后用 `syncToken` 只拿变化，删掉的联系人会带 `metadata.deleted`；
  - **同步令牌在完整同步之后 7 天过期**，过期报 `EXPIRED_SYNC_TOKEN`，只能重新做完整同步，所以至少每周要同步一次；
  - 写入以后要过几分钟才能在同步里看到，不要拿增量同步做"写完马上读"。
- "其他联系人"（跟你来往过、但你没有手动存的人）要单独的 scope `contacts.other.readonly`。
- 对二狗：可以**提议给"重要的人"建档案**，或者给已有的档案补生日、电话、地址，但都要用户确认。注意 CONTEXT.md 的 Avoid 写着 _"联系人, contact"_ 不等于"重要的人"：通讯录很大，不能整本导进去，只给用户挑出来的人建档。

### 3.3 Gmail

- 读和搜：`users.messages.list` 的 `q` 参数用的是"跟 Gmail 搜索框一样的语法"，每页最多 500 条（[messages.list](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages/list)）。用 `gmail.metadata` 时不能用 `q`。
- 标签：`gmail.labels` 是普通档；读邮件要 `gmail.readonly`（受限）；改标签、存草稿要 `gmail.modify` 或 `gmail.compose`（受限）；只发信用 `gmail.send`（敏感）。
- **同步**：用 `history.list`，从上次记下的 `historyId` 往后拿变化。历史记录"通常至少保留一周"，过期会返回 404，只能做完整同步（[Synchronizing clients](https://developers.google.com/workspace/gmail/api/guides/sync)，2026-09-15 更新）。
- **推送**要 Cloud Pub/Sub，而且每 7 天要续一次 watch。官方对已安装应用的建议是**直接轮询**，按 Synchronize clients 那篇做（[Push notifications](https://developers.google.com/workspace/gmail/api/guides/push)，2026-09-15 更新）。二狗就用定时轮询。
- 不建 Cloud 项目的替代办法：IMAP 加"应用专用密码"。前提是开了两步验证；改 Google 密码会让它失效；官方原话是这种密码 "aren't recommended and are unnecessary in most cases"，而且它能访问整个邮箱，范围太大（[Sign in with app passwords](https://support.google.com/accounts/answer/185833)）。IMAP 也支持 OAuth 的 XOAUTH2 方式（[IMAP/SMTP](https://developers.google.com/workspace/gmail/imap/imap-smtp)），但那样还是要建 Cloud 项目，不如直接用 Gmail API。**不推荐走 IMAP**。

### 3.4 日历

- **事件读写**：`events.list`、`insert`、`patch` 这些。提醒写在 `reminders.useDefault` 和 `reminders.overrides[]` 里，方式有 `email` 和 `popup` 两种，提前 0 到 40320 分钟（4 周），**每个事件最多 5 条**（[Events 资源](https://developers.google.com/workspace/calendar/api/v3/reference/events)，2026-07-07 更新）。
- **生日**（[Event types](https://developers.google.com/workspace/calendar/api/guides/event-types)，2026-09-11 更新）：
  - Google 通讯录和本人账号资料里的生日会同步到日历上，`eventType` 是 `birthday`，全天、每年重复；
  - 可以用 `eventTypes=birthday` 只列生日；
  - `birthdayProperties.contact` 是 `people/c…` 这种形式，能拿去 People API 查到那个人；
  - **跟联系人关联的生日改不了日期**，要改得去 People API 里改联系人；
  - API 能新建普通的生日事件，但不能建"自定义纪念日"。
- **节假日**：节假日日历是一种公共日历，ID 形如 `en.usa#holiday@group.v.calendar.google.com`（[Apps Script CalendarApp 示例](https://developers.google.com/apps-script/reference/calendar/calendar-app)）。用户订阅过的会出现在 `calendarList.list` 里。二狗已经有自己的新加坡、国内节假日数据，**不建议拿 Google 的节假日替换**，最多用来对照。
- **增量同步**：用 `syncToken`。服务器返回 410 就清空本地数据重新完整同步（[Synchronize resources efficiently](https://developers.google.com/workspace/calendar/api/guides/sync)，2026-09-11 更新）。
- **推送不适合本机**：接收地址必须是 HTTPS，证书要有效，不能用自签名证书（[Push notifications](https://developers.google.com/workspace/calendar/api/guides/push)，2026-09-11 更新）。二狗就用定时轮询。
- **不用 OAuth 的只读捷径**："私密 iCal 地址"。在日历设置 → 某个日历 → 集成日历里能拿到；官方提醒不要把它告诉别人，泄露了可以重置（[Calendar 帮助 37648](https://support.google.com/calendar/answer/37648)，无日期）。只能读、拿不到提醒设置，但**不用建 Cloud 项目**。这个地址本身就相当于密钥，要放进密钥区。适合"先让日历上看到 Google 的事件"这种最快的第一步。

### 3.5 地图

**时间线 / 位置记录：现在没有 API，以后大概率也不会有**
- 官方博客 2023-12-12：时间线改成"saved on your device"，可以选择云端加密备份（"no one can read it, including Google"），第一次开启时自动删除的默认值从 18 个月改成 3 个月（[Google 博客：Updates to Location History](https://blog.google/products/maps/updates-to-location-history-and-new-controls-coming-soon-to-maps/)）。
- 帮助中心："Timeline is not available for Maps on your computer"；备份就是在 Google 服务器上存一份加密副本（[Timeline 帮助 14169818](https://support.google.com/maps/answer/14169818)，无日期）。连 Google 自己都读不了的数据，自然不会有给开发者的 API。Data Portability API 的 Maps 结构说明里也**没有** Timeline 或 Location History（[DPA Maps 结构说明](https://developers.google.com/data-portability/schema-reference/maps)，2026-03-16 更新）。
- **唯一的办法是从手机手动导出**。Android 官方步骤：设置 → 位置信息 → 位置信息服务 → 时间线 → "导出时间线数据" → 选保存位置（[Manage your Timeline · Android](https://support.google.com/maps/answer/6258979?hl=en&co=GENIE.Platform%3DAndroid)）。iOS 是在 Google 地图 App 里导出，二手资料说文件名是 `location-history.json`。
- 二手（媒体报道，没找到官方页）：网页版时间线和云端位置记录在 2025 年中停了（报道说是 2025-06-09，各账号日期不同），没迁移到手机上的数据已经删除。Takeout 现在还包不包含时间线，官方帮助没写，要用户自己导一次看看。
- **跟用户的手机有关**：用户的主力机是鸿蒙。时间线只存在装了 Google 地图并开了时间线的那台 Android 或 iPhone 上。鸿蒙机上没有，就没有可导的东西。

**收藏的地点、评价：没有常规 API，只能用 Takeout 导出**
- Google Maps Platform（Places API 等）是给开发者查公共地点用的，读不到用户个人的收藏或评价。官方唯一能读个人地图数据的接口是 **Data Portability API**，它的 Maps 部分包括（[DPA scopes](https://developers.google.com/data-portability/user-guide/scopes)，2026-04-20 更新）：
  - 受限：`maps.starred_places`（星标地点）、`maps.aliased_places`（标注过的地点，比如家、公司）、`maps.commute_routes`、`myactivity.maps`、`mymaps.maps`；
  - 敏感：`maps.reviews`（评价）、`maps.photos_videos`、`maps.questions_answers` 等。
- **但 Data Portability API 只对欧洲经济区（EEA）的用户开放**，原文是 "end users in the European Economic Area (EEA)"（[DPA policy](https://developers.google.com/data-portability/policy)，2024-11-20 更新）；也不支持 18 岁以下的账号（[DPA Overview](https://developers.google.com/data-portability/user-guide/overview)）。二狗用户的节假日数据是新加坡和国内的，大概率不在 EEA，**用不了**。
- **Takeout**（各地区都能用，全手动）：
  - 选好产品以后打包成 zip 或 tgz，可以发邮件给下载链接，或者直接传到 Drive、Dropbox、OneDrive、Box；
  - 链接大约 7 天过期，每个包最多下载 5 次；
  - 定时导出（每 2 个月一次、持续 1 年）**只对 Google 相册有效**。

  出处：[Download your Google data](https://support.google.com/accounts/answer/3024190)。"地图（你的地点）"里的星标地点是 **GeoJSON** 格式，字段有坐标、名称、地址、国家码、Maps 链接、修改时间（[DPA local_actions 结构说明](https://developers.google.com/data-portability/schema-reference/local_actions)，2025-02-13 更新，跟 Takeout 用的是同一套格式说明）。二手资料还说"想去""收藏"等**收藏列表**是 CSV（标题、备注、链接），评价单独一个文件，以实际导出的为准。

### 3.6 Drive、Photos、健康

- **Drive**：`drive.file` 是普通档，只能碰用户用选择器挑出来、或者二狗自己建的文件，最省心；`drive.readonly` 能读整个网盘，但属于受限档（[Drive scopes](https://developers.google.com/workspace/drive/api/guides/api-specific-auth)）。自用两种都行。建议只在"用户指定某个文件或文件夹做素材"时才用。
- **Photos**（[Photos API updates](https://developers.google.com/photos/support/updates)，2025-08-28 更新）：
  - 2025-03-31（页面横幅写的是 4-1）起，`photoslibrary.readonly`、`photoslibrary.sharing`、`photoslibrary` 这三个 scope 已经**移除**，Library API 只能访问 **App 自己建的**相册和照片；
  - 要读用户的照片只能走 **Picker API**：建一个会话 → 把 `pickerUri` 给用户 → 用户在 Google 相册里自己挑 → 二狗轮询会话 → 列出挑中的照片 → 用 `baseUrl` 下载（[Picker 入门](https://developers.google.com/photos/picker/guides/get-started-picker)，2025-10-06 更新）。

  所以**没法让二狗自己去翻相册**，只能用户挑一批交给它。
- **健康**：
  - **Google Fit API**：2024-05-01 起不再接受新开发者注册，"will be deprecated in 2026"，"supported until the end of 2026"，**没有替代的 REST API**（[Google Fit](https://developers.google.com/fit)；[Fit 迁移 FAQ](https://developer.android.com/health-and-fitness/guides/health-connect/migrate/migration-faq)，2026-08-21 更新）。Fit 的 scope 本身也在受限清单里。
  - **Health Connect**：数据 "is stored on-device"，是安卓手机本机上的接口，Windows 上的守护进程和鸿蒙都用不上。
  - **Google Health API**：Fitbit Web API 的接替者，用 Google OAuth，**所有 scope 都是受限档**，数据只来自 Fitbit 设备和 Pixel Watch。Fitbit Web API 在 2026-09-30 停止支持，**2026-11-02 关停**（[About the Google Health API](https://developers.google.com/health/about)，2026-10-23 更新；二手资料里有说 10-30 的，以官方页为准）。
  - **结论：健康数据不走 Google**。用户没有 Fitbit 或 Pixel Watch 就更没东西可拿。这一块交给查华为运动健康的那条线。

---

## 4. 对二狗的建议

### 4.1 能做和不能做

| 现在就能做（单用户、External 应用、自用不验证） | 做不了或不划算 |
|---|---|
| People：本人资料，联系人的生日、电话、地址、关系 → 档案**候选** | 地图时间线的 API（不存在） |
| 日历：只读同步，在日历插件里显示 Google 的事件和生日 | 收藏地点、评价的 API（只有 DPA，仅限 EEA） |
| 日历：二狗建事件、加提醒（`calendar.events`，或者只碰二狗自己的副日历 `calendar.app.created`） | 让二狗自己翻相册（Library API 已收紧） |
| Gmail：按需搜索、读邮件给 agent 当工具；定时拉新邮件进素材 | 健康数据（Fit 年底退役，Health Connect 只在安卓本机） |
| Gmail：起草或发送（发送对外，要用户确认） | 设备码流程（不支持这些 scope） |
| Drive：用户指定的文件进素材（`drive.file`） | 推送通知（日历要公网 HTTPS，Gmail 要 Pub/Sub），改用轮询 |
| 一次性导入：Takeout 的收藏地点（GeoJSON、CSV），手机导出的时间线 JSON | "内部"应用（个人 Gmail 没有组织） |

### 4.2 推荐的接法

1. **一个"Google"插件**（守护进程里的 `plugin.ts` 加网页的 `plugins/google/`，按 ergo-plugin 的检查清单做）。它**拥有数据**：令牌（放密钥区）、同步下来的联系人、事件和邮件快照、同步游标。所以要有**数据契约**，移除时勾"连数据删"就删同步快照和游标、撤销令牌。日历插件把它列为**可选依赖**（wants），每次现取它给的事件；提醒、档案、素材按各自的口子接。
   - 提醒一下：用户定过"插件化的范围"，说的是把现有功能拆成插件时只拆那五个。Google 接入是新功能，做成插件最自然（能整体停用、连数据删），**开工前跟用户确认一句**。
2. **授权**：
   - 设置 · 插件 · Google 里点"连接"。守护进程临时在 `127.0.0.1` 起一个随机端口当回环监听，生成 PKCE，用**电脑上的系统浏览器**打开同意页（做法 A）；
   - 用户在手机上点的话，提示"请在电脑上完成"，或者给出做法 B 的粘贴框；
   - 鸿蒙 App 里**不能内嵌**同意页。
3. **按需开 scope**：
   - 第一步只开 `openid email profile` 加 `contacts.readonly` 和 `calendar.readonly`；
   - Gmail 只读、日历写、发信这几项，用户在设置里打开开关时，带着新的 scope 集合**重新走一次授权**（已安装应用不支持增量授权）；
   - 每次都检查实际拿到了哪些 scope。
4. **同步都用轮询，不用推送**：日历用 `syncToken`，联系人用 `syncToken`（**至少每周一次**，不然令牌过期），Gmail 用 `history.list`。作为插件的内部作业跑，比如每 15 到 30 分钟一次，开机后补一次。
5. **进档案、进素材之前都让用户确认**：
   - **个人档案**：Google 来的生日、电话、地址一律只当"候选"，用户确认才写，保留"来自 Google 联系人 X"的出处；
   - **记忆、素材**：邮件和日历事件按"生活来源"进素材。建议先只收用户勾选的标签或日历，或者"带星标、发件人在重要的人里"的邮件，不要全量导入。
6. **能一键断开并删除**：调撤销接口 `oauth2.googleapis.com/revoke` → 删密钥区里的令牌 → 按数据契约删同步快照。界面上同时提示用户，也可以到 Google 账号的"第三方连接"里自己确认已经撤销。
7. **令牌失效时**（遇到 `invalid_grant`、测试状态满 7 天、改了密码）：在"待我处理"里放一条"Google 授权失效，点这里重新连接"，同步停下，不报错刷屏。

### 4.3 和二狗现有规矩怎么配合

- **密钥不进仓库**：`client_secret.json`（只能在创建那一刻下载）和 refresh token 都只放数据目录的**密钥区**，agent 读不到（硬拒绝保留）。仓库和配置文件里只写"Google 插件已启用"这类开关。守卫现在只认 `AIza…` 形式的 API key，可以考虑以后把 OAuth 的 client secret、令牌的特征也加进"对外内容含密钥"的识别，**按"新安全设计只记录不实现"的规矩先记下来**。
- **功能先跑通、安全后接**：
  - 能先放的：Gmail 发信要不要先问、秘书能不能直接读全部邮件，这些"先问我"类的策略可以先放开（照 ADR-0026）。
  - **建议不要放的**：一是官方政策里**硬性要求**的"令牌静态加密"，DPAPI 成本很低，建议第一版就做；如果第一版用明文，要当成已知偏差记下来。二是"进档案前用户确认"，这是档案本来的定义，不算安全机制。
  - 发信属于"对外送内容"，"对外内容含密钥"和"读过密钥文件之后往外送"这两条"永不"仍然会拦。
- **数据交给大模型**：符合 Workspace 政策里"为用户看得见的功能"这一条；要保证用的模型服务不拿 API 数据训练（DeepSeek、Anthropic 等各家的数据条款，实现时核对一下）。

### 4.4 现成的官方 Node 客户端库（只记名字和版本，没有安装）

2026-10-25 用 `npm view` 查的：

| 包 | 最新版本 | Node 要求 | 说明 |
|---|---|---|---|
| `googleapis` | 188.0.0（2026-10-22 发布） | >=22 | 所有 Google API 的合集，很大 |
| `google-auth-library` | 11.3.1（2026-10-15） | >=22 | OAuth2Client：生成授权地址（支持 PKCE）、换令牌、自动刷新、撤销 |
| `@googleapis/people` | 12.0.1 | >=22 | 单个 API 的小包，**推荐按需只装这几个** |
| `@googleapis/calendar` | 20.1.0 | >=22 | 同上 |
| `@googleapis/gmail` | 22.0.2 | >=22 | 同上 |
| `@google-cloud/local-auth` | 3.0.1（2024-01 之后没再更新） | >=14 | 官方示例里用来跑回环授权的小工具，不保存令牌，二狗自己写回环更可控，**不需要** |

二狗要求 Node >=22.19，本机是 22.23，都满足。

### 4.5 建议的落地顺序

1. **最快见效，几乎零成本**：日历插件支持订阅"私密 iCal 地址"（只读，地址放密钥区），先让日历上看到 Google 的事件。
2. **Google 插件第一版**：完成授权（回环 + PKCE + 正式版不验证），接 People（本人资料和联系人 → 档案候选）和 Calendar 只读同步（事件和生日进日历插件）。
3. **第二版**：Gmail 只读（agent 工具 `gmail_search` 和 `gmail_read`，加按条件进素材），Calendar 写（建事件、加提醒）。
4. **第三版**：Gmail 起草和发送（发送前确认）、Drive 的 `drive.file`、Photos Picker。
5. **一次性导入工具**（跟插件无关，随时可做）：导入 Takeout 的"地图（你的地点）"（星标 GeoJSON、收藏 CSV、评价），以及手机导出的时间线 JSON。导入前给用户看摘要，确认后进素材。

### 4.6 没查实或要用户定的

- 没有验证的正式版应用申请 Gmail 受限 scope，Google 现在是让点过警告页，还是直接拦？官方豁免条款说能点过去，但 Google 有可能收紧。**建项目那一步实测一次就知道**（本次规定不建，没测）。
- People API 的 `user.*.read` 那几个、Calendar 的几个 scope 具体在哪一档，官方文档没有逐个标，要以 Cloud 控制台勾选时显示的为准。
- Takeout 里现在还有没有时间线、收藏列表 CSV 的确切字段，要用户实际导一次看看。
- 用户手里有没有装着 Google 地图的 Android 或 iPhone。没有的话，时间线这一项就不用做了。

---

## 出处汇总（按主题）

**认证**
- OAuth 2.0 for iOS & Desktop Apps：https://developers.google.com/identity/protocols/oauth2/native-app （2026-10-16）
- Limited-input device flow（设备码流程）：https://developers.google.com/identity/protocols/oauth2/limited-input-device （2026-10-16）
- Refresh token expiration：https://developers.google.com/identity/protocols/oauth2#expiration （2026-10-16）
- OAuth 2.0 Policies：https://developers.google.com/identity/protocols/oauth2/policies （2026-08-05）
- Web server 流程（回调地址规则）：https://developers.google.com/identity/protocols/oauth2/web-server
- Granular permissions（细粒度授权）：https://developers.google.com/identity/protocols/oauth2/resources/granular-permissions （2026-05-26）

**Google Cloud 设置、验证、政策**
- Configure OAuth consent screen：https://developers.google.com/workspace/guides/configure-oauth-consent （2026-09-03）
- Manage App Audience：https://support.google.com/cloud/answer/15549945
- Manage OAuth Clients：https://support.google.com/cloud/answer/15549257
- When is verification not needed：https://support.google.com/cloud/answer/13464323
- Unverified apps：https://support.google.com/cloud/answer/7454865
- Restricted Scopes 清单：https://support.google.com/cloud/answer/13464325
- Sensitive scope verification：https://developers.google.com/identity/protocols/oauth2/production-readiness/sensitive-scope-verification （2026-08-19）
- Restricted scope verification：https://developers.google.com/identity/protocols/oauth2/production-readiness/restricted-scope-verification （2026-08-19）
- API Services User Data Policy：https://developers.google.com/terms/api-services-user-data-policy （2024-02-15）
- Workspace API User Data and Developer Policy：https://developers.google.com/workspace/workspace-api-user-data-developer-policy （2026-09-03）
- OAuth 2.0 Scopes 总表：https://developers.google.com/identity/protocols/oauth2/scopes （2026-09-14）

**各 API**
- People get：https://developers.google.com/people/api/rest/v1/people/get （2024-08-06）
- People connections.list：https://developers.google.com/people/api/rest/v1/people.connections/list （2024-08-06）
- Gmail scopes：https://developers.google.com/workspace/gmail/api/auth/scopes （2026-09-10）
- Gmail messages.list：https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages/list （2026-04-15）
- Gmail sync：https://developers.google.com/workspace/gmail/api/guides/sync （2026-09-15）
- Gmail push：https://developers.google.com/workspace/gmail/api/guides/push （2026-09-15）
- Gmail 配额：https://developers.google.com/workspace/gmail/api/reference/quota （2026-10-16）
- Gmail IMAP/SMTP：https://developers.google.com/workspace/gmail/imap/imap-smtp （2026-09-15）
- 应用专用密码：https://support.google.com/accounts/answer/185833
- Calendar scopes：https://developers.google.com/workspace/calendar/api/auth （2026-09-03）
- Calendar Events 资源：https://developers.google.com/workspace/calendar/api/v3/reference/events （2026-07-07）
- Calendar event types（生日）：https://developers.google.com/workspace/calendar/api/guides/event-types （2026-09-11）
- Calendar sync：https://developers.google.com/workspace/calendar/api/guides/sync （2026-09-11）
- Calendar push：https://developers.google.com/workspace/calendar/api/guides/push （2026-09-11）
- Calendar 配额：https://developers.google.com/workspace/calendar/api/guides/quota （2026-09-11）
- Apps Script CalendarApp（节假日日历 ID 示例）：https://developers.google.com/apps-script/reference/calendar/calendar-app
- 私密 iCal 地址：https://support.google.com/calendar/answer/37648
- Drive scopes：https://developers.google.com/workspace/drive/api/guides/api-specific-auth （2026-09-03）
- Photos API updates：https://developers.google.com/photos/support/updates （2025-08-28）
- Photos authorization：https://developers.google.com/photos/overview/authorization （2025-08-28）
- Photos Picker：https://developers.google.com/photos/picker/guides/get-started-picker （2025-10-06）

**地图、导出**
- Google 博客 2023-12-12，位置记录改版：https://blog.google/products/maps/updates-to-location-history-and-new-controls-coming-soon-to-maps/
- Timeline 帮助：https://support.google.com/maps/answer/14169818
- 导出时间线（Android）：https://support.google.com/maps/answer/6258979?hl=en&co=GENIE.Platform%3DAndroid
- Takeout：https://support.google.com/accounts/answer/3024190
- Data Portability API：https://developers.google.com/data-portability ；policy（仅限 EEA）：https://developers.google.com/data-portability/policy （2024-11-20）；scopes：https://developers.google.com/data-portability/user-guide/scopes （2026-04-20）；Maps 结构说明：https://developers.google.com/data-portability/schema-reference/maps （2026-03-16）；星标地点：https://developers.google.com/data-portability/schema-reference/local_actions （2025-02-13）

**健康**
- Google Fit：https://developers.google.com/fit
- Fit 迁移 FAQ：https://developer.android.com/health-and-fitness/guides/health-connect/migrate/migration-faq （2026-08-21）
- Google Health API：https://developers.google.com/health/about （2026-10-23）

**二手（只当佐证或线索）**
- rclone 自建客户端 ID 的做法：https://rclone.org/drive/
- 网页版时间线 2025-06-09 关停的报道：https://www.techradar.com/phones/youve-got-more-time-the-great-google-maps-timeline-switch-gets-a-new-deadline-date
