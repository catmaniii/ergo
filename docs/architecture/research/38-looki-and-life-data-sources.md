# 二狗"生活来源"调研笔记

> 2026-10-25｜只读调研，没登录任何账号、没碰任何设备。
> 标注规则：**官方** = 官网 / 帮助中心 / 隐私政策 / 开发者文档 / 官方代码包；**社区** = 媒体、博客、第三方项目，只当线索；查不到的写"官方没有公开"。
> 华为账号 / 运动健康、Google 账号 / Gmail / 日历 / 地图由另外的子 agent 查，本文只在需要时提一句。

---

## 〇、先说结论

1. **Looki 能自动导入，而且有官方正路。** Looki 有官方开放接口（Looki Developer Platform），只读，按 API Key 鉴权，能拿到"时刻（Moments）+ 照片视频文件 + 日记（Journals）+ AI 高光（vlog 等）+ 实时事件（beta）"。中国区和海外各有一套地址。**要先在 Looki Web 上申请开通、等审核**，通过后建 Key 交给二狗，二狗定时去拉就行。没有 Webhook 和 MCP，只能轮询。官方另给了一份 Skill 文件，给 agent 用。
2. 其他来源里，**微信读书（2026-05 官方开放 API Key）** 最省事、价值最高；电脑本机（窗口使用时间、浏览器历史、文件）全自动、不用账号；手机照片走"家庭存储 / 网盘的图库备份 → 电脑"，手机上一行代码都不用写；支付宝 / 微信支付账单要每月手动导出一次。
3. 鸿蒙上，**通知、短信、通话记录三方应用都读不到**（系统接口 / 系统应用权限），这是和安卓最大的差别。微信个人聊天依然没有官方读取接口；2026-03 起微信官方有"ClawBot"通道，可以用微信和自己的 agent 收发消息（用户自己转发东西进来），但读不了别的聊天。

---

## 一、Looki 挂脖摄像头（重点）

### 1.1 它是什么

| 项目 | 内容 | 出处 |
|---|---|---|
| 型号 / 公司 | **Looki L1**。海外主体 Looki Tech Limited（加拿大多伦多）；中国区主体 **深圳光智时空科技有限公司**（looki.tech，粤ICP备2025472973号） | [隐私政策（海外）](https://www.looki.ai/policies/privacy-policy)、[中国站](https://www.looki.tech/)、[隐私政策（中国）](https://www.looki.tech/policies/privacy-policy) |
| 硬件 | 磁吸挂绳挂脖子上；32 GB 存储；375 mAh 电池；蓝牙 5.0 + 双频 Wi-Fi；IP67 防水；109° 视角；照片 4K、视频 1080p 30fps；AI 模式下续航最长约 12 小时，连续录像 / 录音 1–3 小时 | [产品页](https://www.looki.ai/pages/looki-l1)、[帮助中心 FAQ](https://support.looki.ai/hc/en-001/articles/49659915480217-General-FAQs) |
| 拍摄方式 | **按键**：单按 B 键拍照；长按 B 键开 / 关 Auto Mode；单按 A 键开始 / 停止录像；长按 A 键录音；长按触摸板跟 AI 助手说话（要手机蓝牙 + 联网）。<br>**Auto Mode（自动模式）**：按你设的间隔拍短片段，端侧判断场景（工作 / 运动 / 户外），活动多时拍得勤、安静时省电。<br>**默认不连续录**，要连续录也行，每段最长 10 分钟。中国版隐私政策写了三种模式：固定间隔（定时拍低分辨率图 + 环境音片段）、自适应（自动选拍照 / 录音 / 录像）、主动触发（按键或语音） | [User Guide](https://support.looki.ai/hc/en-001/articles/49613635671193-User-Guide)、[Auto Mode](https://support.looki.ai/hc/en-001/articles/49659302782233-Auto-Mode)、[FAQ](https://support.looki.ai/hc/en-001/articles/49659915480217-General-FAQs)、[中国版隐私政策 2.2.1](https://www.looki.tech/policies/privacy-policy) |
| 录制提示 | 录的时候 Trust Light 一直闪，用户关不掉 | [FAQ](https://support.looki.ai/hc/en-001/articles/49659915480217-General-FAQs)、[Privacy 页](https://www.looki.ai/pages/privacy) |
| 存在哪 | **先存设备本地**，只有在手机 App 里选择同步才上云；App 里能配 Wi-Fi、管理自动上传；上传后 12 小时设备上的数据自动清掉（海外 Privacy 页）。一台 L1 同时只能配一部手机 | [FAQ](https://support.looki.ai/hc/en-001/articles/49659915480217-General-FAQs)、[Looki App 说明](https://support.looki.ai/hc/en-001/articles/49659999171737-Looki-App)、[Privacy 页](https://www.looki.ai/pages/privacy) |
| App 里的 AI 功能 | **Lifelog / 记忆**：按时间线看已上传的内容；**Moments**：自动把照片视频切成有主题的片段（标题、描述、时间段、地点）；**Journal / 日记**：AI 写的日记、高光视频、**会议纪要和要点**；**Chat**：结合设备拍的内容 + 联网搜索回答问题；**AI 搜索与回忆**（"周三晚饭""孩子笑"）；**生活洞察**（行为、情绪、活动规律）；漫画日记、Auto Vlog、健康报告（饮食、活动）；主动提醒（Proactive，beta） | [Looki AI](https://support.looki.ai/hc/en-001/articles/49659477121305-Looki-AI)、[Looki App](https://support.looki.ai/hc/en-001/articles/49659999171737-Looki-App)、[官网首页](https://www.looki.ai/) |
| App 和网页 | iOS、Google Play（`ai.looki.lifelog`）、**鸿蒙版在华为应用市场**（同包名，中国站下载页有入口）；网页版 Looki Web：海外 `web.looki.ai`，中国区 `web.looki.tech` | [下载页（海外）](https://www.looki.ai/pages/download)、[下载页（中国）](https://www.looki.tech/app/download)、[AppGallery](https://appgallery.huawei.com/app/detail?id=ai.looki.lifelog) |
| 收费 | 硬件一次性买断；有免费的 Essential 计划（基础存储和 AI）；官方说以后可能出可选的付费档。**API 是否要付费，官方没有公开** | [产品页](https://www.looki.ai/pages/looki-l1)、[FAQ](https://support.looki.ai/hc/en-001/articles/49659915480217-General-FAQs) |

### 1.2 数据能从哪些口子出来

| 口子 | 有没有 | 说明 | 出处 |
|---|---|---|---|
| **开放 API（REST）** | **有，要申请** | 海外 `https://open.looki.ai/api/v1`，中国区 `https://open.looki.tech/api/v1`（两套我都探过，未带 Key 时都回 401，说明在线）。请求头 `X-API-Key`，**全部是 GET，只读**。页面原话："Your data is yours to use. Build your own integrations with the Looki API." | Looki Web 的 API 文档页（`/api-references`，下文 1.3）、[Looki for Codex 博客](https://www.looki.ai/blogs/news/looki-for-codex) |
| SDK | 官方没有公开 | 文档只有 curl 示例 | 同上 |
| Webhook / 推送 | 官方没有公开 | 只能轮询；`/realtime/latest-event` 是"主动模式"下的最新事件，beta | 同上 |
| MCP | 官方没有公开 | 有官方 **Skill 文件** `looki-memory`，原话说给 "Claude, ChatGPT, Cursor 等" agent 用；Looki Web 前端还内置一段给 OpenClaw 类 agent 的"复制提示词"（把 Base URL 和 Key 交给 agent，让它调 `/me` 验证） | [SKILL.md](https://web.looki.ai/agent/looki-memory/SKILL.md) |
| 一键全量导出 | **暂无** | Looki Web 前端代码里有一行 "数据导出（即将推出）：通过邮件请求下载您的全部数据"，**这是网页代码里的字样，不是正式公告**。海外隐私政策没给导出工具，只说可发邮件要求删除；中国版隐私政策权利表里也没写复制 / 导出 | Looki Web 前端代码（`web.looki.ai/assets/index-*.js`）、两份隐私政策 |
| 单个文件保存 / 分享 | 有 | App 能把内容存下来、分享到云或社交平台（官网引用的媒体评测原话）；Looki Web 的相册有"下载"按钮（前端代码） | [官网首页](https://www.looki.ai/) |
| 同步到网盘 | 官方没有公开 | — | — |
| USB / Wi-Fi 直接读设备文件 | 官方没有公开 | USB-C 口在磁吸挂绳上，帮助中心只说是充电用的 | [User Guide](https://support.looki.ai/hc/en-001/articles/49613635671193-User-Guide) |
| Notion / Zapier 等第三方集成 | 官方没有公开 | 只有"往里读"：能读 Apple Health / Health Connect 的步数、心率、睡眠（只读，不往外写） | [隐私政策（海外）](https://www.looki.ai/policies/privacy-policy) |

### 1.3 开放接口细节（官方 API 文档原文整理）

**开通流程**（Looki Web → 侧边栏「API 文档 / API 密钥」）：
1. 在 API 密钥页点"申请开通"，填用途说明，等 Looki 审核；
2. 通过后点"Create API Key"，起个名字，Key 只显示一次（`lk-` 开头）；
3. 请求时带 `X-API-Key: <key>`。

**限流**：每个 Key 每分钟 60 次，超了回 429，要等 60 秒。

| 端点 | 干什么 | 关键参数 |
|---|---|---|
| `GET /me` | 当前账号资料：id、邮箱、姓名、时区、性别、**生日**、地区 | — |
| `GET /moments` | 某一天的所有"时刻" | `on_date`（必填） |
| `GET /moments/calendar` | 一段日期里每天的高光时刻 | `start_date`、`end_date` |
| `GET /moments/search` | **语义搜索**全部时刻 | `query`（1–100 字）、日期范围、分页（每页最多 100） |
| `GET /moments/{id}` | 单个时刻详情 | — |
| `GET /moments/{id}/files` | 这个时刻里的照片 / 视频 / 音频文件，可只要高光 | `highlight`、`cursor_id`、`limit`（≤100） |
| `GET /journals` | 按天分组的日记 | `cursor_date`、`max_days`（≤31）、`sort_order` |
| `GET /journals/calendar`、`/journals/by_date`、`/journals/{id}` | 哪天有日记、某天的日记、单篇详情 | — |
| `GET /for_you/items` | AI 生成的高光：每日 vlog 等 | `group`（all/vlog/other）、`liked`、录制 / 创建日期范围、游标、`order_by` |
| `GET /realtime/latest-event` | 设备检测到的**最新实时事件**（描述、起止时间、地点）。要在 App 里开主动模式，**beta，可能还没开放给你** | — |

**数据长什么样**：
- **Moment**：`id`、`title`、`description`、`media_types`、封面文件、`date`、`tz`、`start_time`、`end_time`；
- **文件**：`location`（地点描述）、`created_at`、`temporary_url`（**预签名链接，1 小时过期**）、`media_type`（IMAGE / VIDEO / AUDIO）、大小、时长；
- **Journal**：`type`（如 DIARY）、`title`、`description`（摘要）、`content`（全文）、附带的媒体、`recorded_at`；
- **ForYou**：`type`（如 DAILY_VLOG）、`title`、`description`、`content`、封面、文件。
- 文档里**没有**单列"对话转写原文"的接口；帮助中心说会议纪要出现在 Journal 里，所以纪要大概率走 `/journals` 拿，**需实测**。

**Skill 文件里的安全要求**（官方写的，二狗照着做）：第一次用前先请求 `https://open.looki.ai/api/v1/verify?endpoint={base_url}`（不带 Key）校验地址，失败就别继续；Key 只发给 `{base_url}`，不发别的域名；Key 不进聊天记录、不进 agent 记忆。我试过：拿 `open.looki.tech` 去校验回 `{"status":"ok"}`，拿随便一个域名回 403 "domain not allowed"。

### 1.4 账号、地区和隐私政策

| | 海外版（looki.ai） | 中国版（looki.tech） |
|---|---|---|
| 运营主体 | Looki Tech Limited，多伦多 | 深圳光智时空科技有限公司 |
| 数据在哪 | AWS：欧洲用户在德国法兰克福，其他海外用户在美国俄勒冈；传输和存储都加密；做过 SOC 2 Type I | "境内收集的信息存储在中国境内"，"当前不涉及个人信息出境"；没写哪家云 |
| AI 处理 | 第三方 AI 服务商，不许他们拿用户数据训练；官方说不用用户内容训练通用模型 | 调"经工信部备案的境内合规大模型"，名单在 App「设置 → 隐私与权限 → 算法及模型备案信息说明」 |
| 保存多久 | 没写固定期限，"只在必要期间保存" | 上传的图像、视频、音频、日记、记忆"在账号存续期间保存"；主动删除后 30 个工作日内删完或匿名化 |
| 删除 | App 里管理，或发邮件 contact@looki.ai；"我们会删除" | App 内「头像 → 设置 → 隐私与权限 → 删除我的数据」或邮件 support@looki.ai；注销 15 个工作日内完成 |
| 导出 | 没有导出工具；提到可在法定条件下转给你指定的第三方 | 权利表里没列复制 / 导出。按《个人信息保护法》第 45 条用户有权查阅复制，可以邮件申请（主题写"个人信息保护相关"，15 个工作日内答复） |
| 执法披露 | 写明可能向执法、政府和私人方披露，没承诺通知用户 | — |
| 出处 | [Privacy Policy](https://www.looki.ai/policies/privacy-policy)、[Privacy 页](https://www.looki.ai/pages/privacy)、[FAQ](https://support.looki.ai/hc/en-001/articles/49659915480217-General-FAQs) | [隐私政策](https://www.looki.tech/policies/privacy-policy)、[隐私政策摘要](https://www.looki.tech/policies/privacy-policy-summary) |

**怎么判断用户是哪个区**：手机 App 从华为应用市场 / 中国站下的、用手机号注册的 → 大概率中国区，接口用 `open.looki.tech`；用 Google / Apple 账号登录海外版 → `open.looki.ai`。登录 Looki Web 后 API 文档页显示的 Base URL 就是本区的（前端按域名切换，`web.looki.tech` 配的是 `open.looki.tech`）。

### 1.5 二狗怎么接（按可行性排）

| 排序 | 接法 | 能自动到什么程度 | 用户要做的 | 风险 / 限制 |
|---|---|---|---|---|
| **1** | **官方开放接口，二狗定时拉** | 一次设置后**全自动**。延迟 = 设备上传（要手机 App 同步）+ Looki 云端处理 + 二狗轮询间隔 | ① 浏览器登录 Looki Web（中国区 web.looki.tech）→ API 密钥 → 申请开通，写清用途（"个人助理读取我自己的记忆"）；② 通过后建 Key；③ 把 Key 填进二狗的密钥设置，别贴进聊天 | 要审核，可能不批或慢；接口新，可能改；只读；没有推送；预签名链接 1 小时过期；60 次 / 分钟 |
| 2 | 官方导出 + 二狗监视文件夹 | 现在**做不到全量**（导出"即将推出"）。只能手动从 App / Looki Web 下载单个文件，放进二狗监视的文件夹，二狗读文件和 EXIF | 每次手动下载、拖进文件夹 | 半手动；文字类内容（日记、时刻描述）拿不全 |
| 3 | 手机侧：分享菜单 / 存图库 | 手动逐条。App 里"分享"到二狗鸿蒙 App（要二狗 App 注册成分享目标，**需查二狗 App 现状**）；或存到手机图库，再走家庭存储 / 网盘的图库备份到电脑（见 2.1） | 每条手动点分享或保存 | 鸿蒙应用沙箱隔离，**直接读 Looki App 的本地存储不可行** |
| 4 | 都不行时 | 用二狗内置浏览器打开 Looki Web 抄页面；或发邮件找客服要数据副本 | 登录网页 / 写邮件 | 抄网页很脆、条款不明；**不建议**逆向 App 私有接口（`api.looki.ai`） |

**接法 1 的具体建议**（给实现参考，不是要现在做）：
- **定时任务**（比如每 30–60 分钟）：`/journals?max_days=2` 拿最新日记；`/moments?on_date=今天`、`昨天` 拿时刻；`/for_you/items?created_from=上次时间` 拿高光。按 `id` 去重。
- **默认只收文字**：时刻的标题、描述、起止时间、地点，日记正文。照片视频默认**不下载**，要的话只存高光缩略图（`/moments/{id}/files?highlight=true`），并且要在 1 小时内下完。
- **秘书工具**：把 `/moments/search`、`/moments/calendar`、`/journals/by_date` 做成二狗的查询工具，用户问"我上周三中午在哪吃的饭"时现查，不必全量入库。
- **实时上下文**（等 beta 开放）：`/realtime/latest-event` 可以当二狗的"此刻在干嘛"信号，每几分钟查一次。
- **个人档案**：`/me` 里有生日、性别、时区，可以拿来核对个人档案里本人的那一栏。

### 1.6 需要用户确认或实测的

1. 用户买的是中国区还是海外版（决定接口地址）；
2. 中国区账号能不能申请开通 API（前端是同一套页面，中国区接口在线，但**官方没写审核规则**）；
3. 会议纪要 / 对话总结是不是在 `/journals` 里，内容多细；
4. `location` 字段的精度（只是"某某商场"，还是带坐标）；
5. 免费档能不能用 API。

---

## 二、还有哪些数据源值得接（概览）

> 评分：**难度**（低 / 中 / 高 / 不可行）；**价值**指对"理解这个人的需求和价值观"有多大帮助；**敏感度**指泄露或误用的伤害。"自动"指一次设置后不用再管。

### 2.1 手机（鸿蒙和安卓差别很大）

| 来源 | 能拿到什么 | 鸿蒙怎么接 | 安卓怎么接 | 自动化 | 难度 | 价值 | 敏感度 | 出处 |
|---|---|---|---|---|---|---|---|---|
| 通知 | 谁、哪个 App 在什么时候找你 | **基本不可行**：订阅通知是系统接口（要 `NOTIFICATION_CONTROLLER`），只有系统应用能用。API 22 起有 `SUBSCRIBE_NOTIFICATION`，但只给"三方穿戴应用"，前提是配对了穿戴设备，权限还是受限级 | `NotificationListenerService`；从文件 / 浏览器装的 App 要先在"应用信息"里"允许受限设置" | 自动 | 鸿蒙不可行；安卓低 | 高 | 高 | [notificationSubscribe（系统接口）](https://gitcode.com/openharmony/docs/blob/master/zh-cn/application-dev/reference/apis-notification-kit/js-apis-notificationSubscribe-sys.md)、[通知订阅扩展能力](https://gitcode.com/openharmony/docs/blob/master/zh-cn/application-dev/notification/notification-subscriber-extension-ability.md)、[Android 文档](https://developer.android.com/reference/android/service/notification/NotificationListenerService)、[受限设置（社区）](https://androidauthority.com/android-15-restricted-settings-sideloading-3481098) |
| 短信、通话记录 | 联系频率、快递 / 账单 / 行程短信 | **不可行**：`READ_MESSAGES`、`READ_CALL_LOG` 是"系统应用可用权限" | `READ_SMS`、`READ_CALL_LOG`。Play 商店规定只有默认短信 / 电话 / 助手应用能申请，但二狗不上架，自己装可以用（安卓 15 起侧载应用也更受限） | 自动 | 鸿蒙不可行；安卓低 | 中–高 | 很高 | [系统应用权限表](https://gitcode.com/openharmony/docs/blob/master/zh-cn/application-dev/security/AccessToken/permissions-for-system-apps-user.md)、[Play 政策](https://support.google.com/googleplay/android-developer/answer/9047303) |
| 照片、截图（时间、地点） | 去过哪、几点、拍了什么；截图 = 你在意的东西 | ① **最省事**：家庭存储类应用的"图库备份"（鸿蒙 5 及以上只支持图库备份），备份到家庭存储，电脑上的同步目录里就能看到，二狗读文件和 EXIF，**手机上不用写代码**；② 二狗 App 申请 `READ_IMAGEVIDEO`（受限权限，要 ACL；官方说改 APL 的办法只能用于调试，不能上架，二狗本来就不上架）+ `MEDIA_LOCATION` 读坐标；③ `PhotoViewPicker` 让用户自己挑，免权限但要手动 | `READ_MEDIA_IMAGES` + `ACCESS_MEDIA_LOCATION` | ①② 自动；③ 手动 | ① 低；② 中 | 高 | 高（人脸、住址） | [家庭存储备份说明](https://consumer.huawei.com/cn/support/content/zh-cn15916722/)、[受限开放权限](https://gitcode.com/openharmony/docs/blob/master/zh-cn/application-dev/security/AccessToken/restricted-permissions.md)、[读 EXIF 和 MEDIA_LOCATION](https://developer.huawei.com/consumer/cn/doc/harmonyos-faqs/faqs-image-61) |
| 录音 | 通话录音、随手录 | `READ_AUDIO` 是受限权限；录音机文件可以手动分享，或经家庭存储（文件同步只支持鸿蒙 3–4.3） | `READ_MEDIA_AUDIO` | 手动为主 | 中 | 中 | 很高（别人的声音） | [受限开放权限](https://gitcode.com/openharmony/docs/blob/master/zh-cn/application-dev/security/AccessToken/restricted-permissions.md)、[家庭存储说明](https://consumer.huawei.com/cn/support/content/zh-cn15916711/) |
| 位置轨迹 | 作息、常去地点 | 后台持续定位要 `LOCATION_IN_BACKGROUND` + 长时任务，费电。**替代**：Looki 每个文件带地点、照片 EXIF、华为运动健康轨迹、谷歌地图时间线（后两个另有子 agent） | 后台定位权限 + 前台服务 | 自动 | 中 | 高 | 很高 | 同上 |
| 手机剪贴板 | 复制过什么 | `READ_PASTEBOARD` 是受限权限 | 安卓 10 起后台读不到 | — | 中 | 低 | 极高（密码、验证码） | [受限开放权限](https://gitcode.com/openharmony/docs/blob/master/zh-cn/application-dev/security/AccessToken/restricted-permissions.md) |

**鸿蒙小结**：通知、短信、通话记录这条路堵死了；照片走家庭存储最现实；其他"手机上发生的事"靠 Looki、运动健康、邮件这些旁路去补。

### 2.2 聊天

| 来源 | 现实情况 | 怎么接 | 自动化 | 难度 | 价值 | 敏感度 | 出处 |
|---|---|---|---|---|---|---|---|
| **微信** | **没有官方的个人聊天读取接口。** 2026-03-21 起微信官方出了 **ClawBot 插件**（腾讯开源 `Tencent/openclaw-weixin`，MIT），扫码绑定后能用微信跟**自己的** agent 收发文字、图片、语音、文件、视频（长轮询），但它是 OpenClaw 的渠道插件，**读不了你和别人的聊天**，社区说不能进群 | ① **官方通道**：用户把想让二狗知道的聊天、文章、图片**转发给 ClawBot**，二狗收进素材，也多了一个微信聊天入口。要么本机跑一个 OpenClaw 当中转，要么照开源插件实现同一协议（后者不算官方支持的用法，协议可能变）；② **常见做法和风险**：解密电脑版微信本地数据库（PyWxDump 一类工具）、hook / 网页协议机器人（wechaty、itchat 一类）——都违反微信用户协议，可能封号；解密工具本来就是安全取证工具，有法律风险；微信一升级就失效。**不建议** | ① 用户每次转发 | ① 中 | 高（用户自己挑的） | 高 | [npm 包说明](https://www.npmjs.com/package/@tencent-weixin/openclaw-weixin)、[爱范儿报道](https://www.ifanr.com/1659499)、[接入教程（社区）](https://www.runoob.com/ai-agent/openclaw-weixin.html)、[PyWxDump 说明（社区 fork）](https://github.com/wo1261931780/fork-PyWxDump) |
| QQ | 官方 QQ 机器人 2026-03-07 起向个人开放接入 OpenClaw（每个 QQ 号最多建 5 个机器人），但机器人是独立账号，读不了你的个人聊天。NapCat / OneBot 这类走协议逆向，违反协议，有封号风险 | 官方机器人做"转发通道"，同微信 ① | 用户转发 | 中 | 中 | 高 | [HK01 报道](https://global.hk01.com/即时中国/60332926/腾讯5大openclaw插件全部上线-微信clawbot聊天方式调用-龙虾)、[NapCat 风险（社区）](https://damodev.csdn.net/6a7f3980662f9a54cb9cca61.html) |
| Telegram | **最开放**：官方 API 允许用户账号客户端（TDLib / MTProto）；桌面版能导出全部数据为 JSON / HTML | TDLib 实时读，或定期导出 JSON 放进文件夹 | 自动 / 半自动 | 中 | 看用不用 | 高 | [TDLib](https://core.telegram.org/tdlib)、[导出数据格式](https://core.telegram.org/import-export)、[官方博客](https://telegram.org/blog/export-and-more) |
| WhatsApp | 个人号没有 API（Business API 是给商家的）；能**逐个聊天导出**纯文本（带媒体最多 1 万条，不带 4 万条） | 手动导出放文件夹 | 手动 | 低 | 看用不用 | 高 | [官方 FAQ](https://faq.whatsapp.com/1180414079177245/) |
| 钉钉 | 开放平台和官方 MCP 有通讯录、日程、待办、机器人发消息等，**没查到读个人聊天的接口** | 日程 / 待办可接；聊天不行 | 自动 | 中 | 中（工作） | 中 | [官方 dingtalk-mcp（收录页）](https://glama.ai/mcp/servers/@open-dingtalk/dingtalk-mcp/inspect) |
| 飞书 | 开放平台有"获取会话历史消息"（官方文档写机器人要在群里；按用户身份读需要用户授权）；有官方 OpenAPI MCP | 建自建应用，用户授权后读 | 自动 | 中 | 中（工作） | 中–高 | [消息列表接口](https://open.feishu.cn/document/server-docs/im-v1/message/list)、[lark-openapi-mcp](https://github.com/larksuite/lark-openapi-mcp) |
| Slack | Web API 用 user token 读 `conversations.history`；2025-05 起非商店应用限到每分钟 1 次、每次 15 条，**自建内部应用不受影响** | 建内部应用 | 自动 | 低 | 看用不用 | 中–高 | [限流说明](https://docs.slack.dev/apis/web-api/rate-limits)、[2025-05 变更](https://docs.slack.dev/changelog/2025/05/29/rate-limit-changes-for-non-marketplace-apps) |

### 2.3 电脑本机（二狗就跑在这台 Windows 上，最好接）

| 来源 | 能拿到什么 | 怎么接 | 自动化 | 难度 | 价值 | 敏感度 | 出处 |
|---|---|---|---|---|---|---|---|
| 浏览器历史、书签 | 看了什么、查了什么、收藏什么 | Chrome / Edge：用户数据目录里的 `History`（SQLite）和 `Bookmarks`（JSON），浏览器开着时文件被锁，要先复制再读；Firefox：`places.sqlite` | 自动 | 低 | 高 | 高 | [Chromium 用户数据目录](https://chromium.googlesource.com/chromium/src/+/HEAD/docs/user_data_dir.md)、[Firefox 配置文件](https://support.mozilla.org/kb/profiles-where-firefox-stores-user-data) |
| 窗口 / 应用使用时间 | 每天用什么软件、多久、几点开始干活、几点停 | 装开源的 **ActivityWatch**（本机 REST `localhost:5600`，有窗口、离开（AFK）、浏览器扩展），或二狗自己定时记前台窗口 | 自动 | 低 | 高 | 中 | [ActivityWatch REST API](https://docs.activitywatch.net/en/latest/api/rest.html) |
| 下载、本地文件 | 最近在弄什么（文件名、类型、时间） | 监视 下载 / 文档 / 桌面 目录；默认只记文件名和元数据，正文按需 | 自动 | 低 | 中 | 中–高 | — |
| 截图 | 用户主动截下来的东西 | 监视 `图片\Screenshots` 等目录 + OCR。重型方案：**Screenpipe**（全程录屏 + OCR + 录音转写，本机 API `localhost:3030`，有 MCP），太全、太敏感，不建议一上来就用。**Windows Recall** 要 Copilot+ PC，也没有导出快照的接口，不可用 | 自动 | 低（目录）/ 中（Screenpipe） | 中 | 高–极高 | [Screenpipe（收录页）](https://mcpservers.org/en/servers/mediar-ai/screenpipe)、[Recall 开发者说明](https://learn.microsoft.com/en-us/windows/ai/apis/recall)、[Recall 硬件要求](https://learn.microsoft.com/windows/client-management/manage-recall) |
| 剪贴板 | 复制过什么 | Win32 剪贴板变化监听可以在后台；剪贴板历史 API（`GetHistoryItemsAsync`）要应用在前台 | 自动 | 低 | 低–中 | 极高（密码） | [Clipboard 类文档](https://learn.microsoft.com/en-us/uwp/api/windows.applicationmodel.datatransfer.clipboard?view=winrt-26100) |

### 2.4 穿戴和健康

| 来源 | 能拿到什么 | 怎么接 | 自动化 | 难度 | 价值 | 敏感度 | 出处 |
|---|---|---|---|---|---|---|---|
| 华为手表 / 运动健康 | 步数、心率、睡眠、运动、体重 | **另一个子 agent 在查** | — | — | 高 | 高 | — |
| 小米手环 / 小米运动健康 | 同上 | **官方没有公开导出或开放接口**；官方只支持在 App「第三方数据」里同步到 Apple 健康等；社区工具走私有接口，随时会坏 | — | 高 | 高 | 高 | [小米 FAQ](https://www.mi.com/uk/support/faq/details/KA-592800/) |
| Apple Watch / Apple 健康 | 同上 | 只能在 iPhone 健康 App 里"导出所有健康数据"（zip 里是 XML）；HealthKit 只在设备上，没有网页接口。用户用鸿蒙手机，大概率不适用 | 手动 | 中 | 高 | 高 | [导出步骤（社区）](https://www.igeeksblog.com/how-to-export-import-health-data-in-ios-10) |
| Garmin | 运动、睡眠、压力 | Health API **只给企业**，个人申请会被拒（社区还说新申请暂停了）；个人只能在账户里手动导出 | 手动 | 高 | 高 | 高 | [Garmin Health API](https://developer.garmin.com/gc-developer-program/health-api/)、[集成指南（社区）](https://openwearables.io/docs/providers/garmin-api-integration) |
| 体重秤 | 体重、体脂 | 华为秤 → 华为运动健康；小米秤 → 小米运动健康 / Zepp Life；**Withings 有公开 API**（OAuth，个人能建应用） | 看品牌 | 低–高 | 中 | 中 | [Withings API 参考](https://developer.withings.com/llms.md) |

### 2.5 消费和出行

| 来源 | 能拿到什么 | 怎么接 | 自动化 | 难度 | 价值 | 敏感度 | 出处 |
|---|---|---|---|---|---|---|---|
| **支付宝** | 每笔收支：时间、商户、金额、分类 | App 账单里"开具交易流水证明 / 收支明细证明"，选"用于个人对账"，发到邮箱（Excel / CSV，压缩包带密码）→ 放进二狗监视的文件夹 | 每月手动一次 | 低 | **高**（钱花在哪 = 在乎什么） | 极高 | [支付宝帮助：收支明细证明](https://help.alipay.com/lab/help_detail.htm?help_id=553265)、[步骤（社区）](https://www.extrabux.com/chs/guide/8796129) |
| **微信支付** | 同上 | 我 → 服务 → 钱包 → 账单 → 下载账单 → 用于个人对账；Excel，每次最长一年；发到微信服务号（7 天有效）或邮箱（要解压码） | 每月手动一次 | 低 | 高 | 极高 | [微信支付用户手册](https://pay.weixin.qq.com/doc/user/4021834826)、[腾讯客服 FAQ](https://kf.qq.com/faq/230919ZBVz6n2309193qMvii.html) |
| 银行 | 信用卡账单、流水 | 电子账单邮件（走 Gmail 那条线）或网银导出 PDF / CSV | 半自动 | 低–中 | 中 | 极高 | — |
| 外卖（美团 / 饿了么） | 吃什么、几点、在哪 | **没有个人订单接口**；美团官方 Skill 只有跑腿下单和领券。只能靠邮件 / 截图 | 手动 | 高 | 中 | 中 | [美团跑腿 Skill 报道](https://news.qq.com/rain/a/20260527A09PXV00)、[美团领券 Skill](https://clawhub.ai/meituan-skillhub/meituan-coupons) |
| 打车（滴滴） | 去哪、什么时候 | 滴滴官方 MCP Key（mcp.didichuxing.com，能叫车、查订单状态；**报道里没提历史行程**）；行程单 / 发票邮件 | 半自动 | 中 | 中 | 高 | [IT之家报道](https://www.ithome.com/0/936/024.htm) |
| 航旅、火车 | 出差旅行 | 航旅纵横、12306 **官方没有公开个人接口**；靠出票短信（鸿蒙读不到）/ 邮件 | 半自动（邮件） | 中 | 中 | 高 | — |
| 快递 | 买了什么、寄给谁 | 取件码在短信里（鸿蒙读不到）；快递100 / 菜鸟是商家接口 | — | 高 | 低 | 中 | — |

### 2.6 内容（最能看出兴趣和价值观）

| 来源 | 能拿到什么 | 怎么接 | 自动化 | 难度 | 价值 | 敏感度 | 出处 |
|---|---|---|---|---|---|---|---|
| **微信读书** | 书架、阅读进度、**划线和想法**、阅读时长统计（按周 / 月 / 年）、推荐 | **2026-05 官方开放 Skill + API Key**：App「我的 → 设置」里拿 Key（`wrk-` 开头），`POST https://i.weread.qq.com/api/agent/gateway`，`Authorization: Bearer`；官方 Skill 包在 `cdn.weread.qq.com/skills/weread-skills.zip`（我下载看过） | 自动 | **低** | **很高** | 低–中 | [官方 Skill 包](https://cdn.weread.qq.com/skills/weread-skills.zip)、[虎嗅报道](https://www.huxiu.com/article/4859863.html)、[Obsidian 插件（社区）](https://community.obsidian.md/plugins/obsidian-weread-plugin) |
| 网易云音乐 | 听什么歌 | 有官方开放平台和 ncm-cli（2026-03 接入 OpenClaw），偏播放、搜索、歌单；**听歌记录官方没有公开**；社区 NeteaseCloudMusicApi 用 cookie，有风险 | — | 中–高 | 中 | 低 | [开放平台文档](https://developer.music.163.com/st/developer/document?docId=9504d35aa41a47c6ac9830b2dbf48f94)、[凤凰科技报道](https://tech.ifeng.com/c/8rjbYa1AzAp) |
| QQ 音乐 | 同上 | 官方没有公开 | — | 高 | 中 | 低 | — |
| Spotify | 听歌记录 | Web API：最近播放（大约只到最近 50 首）、Top；全部记录要在隐私页申请"扩展播放历史"（社区说最长等 30 天） | 自动 + 偶尔手动 | 低 | 中 | 低 | [Recently Played 接口](https://developer.spotify.com/documentation/web-api/reference/get-recently-played)、[隐私设置](https://www.spotify.com/account/privacy/)、[社区说明](https://community.spotify.com/t5/Your-Library/Download-streaming-history/td-p/5431222) |
| B 站 | 看了什么 | **官方没有个人历史接口**；社区 bilibili-API-collect 要 cookie + 签名，CC BY-NC，有风险 | — | 中–高 | 高 | 中 | [bilibili-API-collect](https://github.com/SocialSisterYi/bilibili-API-collect) |
| YouTube | 看了什么 | Data API 不给观看历史；只能 Google Takeout（Google 子 agent） | — | — | 中 | 中 | — |
| Kindle | 标注 | USB 连上后设备里的 `documents/My Clippings.txt`（纯文本）；网页 read.amazon.com/notebook | 手动 | 低 | 高 | 低 | [Kindle Notebook](https://read.amazon.com/notebook) |
| Notion | 自己写的东西 | 官方 API（建 integration，把页面分享给它） | 自动 | 低 | 很高 | 中 | [Notion API](https://developers.notion.com/) |
| Obsidian | 同上 | 本地 Markdown 文件夹，直接读 | 自动 | **极低** | 很高 | 中 | [obsidian.md](https://obsidian.md/) |
| 印象笔记 | 同上 | dev.yinxiang.com 申请 API Key（要 Full 权限才能读笔记）或开发者令牌；也能导出 ENEX | 自动 / 手动 | 中 | 很高 | 中 | [印象笔记开发者支持](https://dev.yinxiang.com/support)、[权限说明](https://dev.yinxiang.com/support/glossary.php) |
| 播客（小宇宙） | 听什么节目 | 只能导出订阅列表 OPML；收听记录官方没有公开 | 手动 | 低 | 中 | 低 | [OPML 教程（社区）](https://haroldgao.substack.com/p/opml) |

### 2.7 其他录音 / 记录类穿戴，和 Looki 比

| 设备 | 现状 | 个人能用的官方接口 | 推送 | MCP / Skill | 导出 |
|---|---|---|---|---|---|
| **Looki L1** | 在卖，有中国区 | **有**，REST，只读，要申请 | 无（轮询） | 官方 Skill，无 MCP | 全量导出"即将推出" |
| Plaud（录音卡 / 吊坠） | 在卖 | 开发者平台（2025-10 上线）偏面向合作伙伴（"Become a partner"）；官网说可"通过 MCP server 或 CLI 访问你的 Plaud 账号数据" | 开发者平台有 Webhook | 有 MCP | App 内导出转写 / 摘要 |
| Limitless Pendant | 2025-12 被 Meta 收购，**停售**；中国、欧盟、英国等地区停服；老用户支持到 2026 年底 | 原有开发者 API，收购后状态官方没写 | — | — | 可导出 / 删除（停服地区截止 2025-12-19） |
| Bee（Amazon） | 2025 年被亚马逊收购；2026-10 出新款 Frontier / Eclipse；Bee Pro 订阅含"第三方应用集成" | **没查到公开的开发者 API** | — | — | 官方没有公开 |
| **Omi** | 开源（MIT，软硬件都开源） | **最开放**：Developer API（`api.omi.me/v1/dev`）、官方 MCP、导入接口 | Webhook 集成应用（记忆、实时转写、原始音频、每日摘要） | 官方 MCP | API 全量拿 |

出处：[Plaud 开发者平台](https://dev.plaud.ai/)、[Plaud Webhook 文档](https://docs.plaud.ai/documentation/developer_guides/webhook_events)、[Limitless 官网](https://www.limitless.ai/)、[TechCrunch：Bee 新品](https://techcrunch.com/2026/10/15/amazons-bee-launches-two-new-personal-ai-devices-starting-at-75/)、[Omi MCP](https://docs.omi.me/doc/developer/mcp/introduction)、[Omi 文档索引](https://docs.omi.me/llms.txt)。

**比较下来**：Looki 的接口在同类里算中上：官方、有中国区、字段清楚（时刻、日记、文件都带时间和地点），但只读、没推送、要审核。Omi 最开放，Plaud 偏企业，Limitless 和 Bee 都被大厂收了，接口前景不明。

### 2.8 智能家居和车

| 来源 | 能拿到什么 | 怎么接 | 自动化 | 难度 | 价值 | 敏感度 | 出处 |
|---|---|---|---|---|---|---|---|
| Home Assistant + 米家 | 起床、到家、开关灯、空调：作息 | HA 本机 REST / WebSocket + 长期令牌；米家用**小米官方** HA 集成 `ha_xiaomi_home`（支持中国大陆，登录小米账号选设备） | 自动 | 中（要先搭 HA） | 中 | 中（在不在家） | [ha_xiaomi_home 镜像](https://gitee.com/YHC/ha_xiaomi_home)、[HA REST API](https://developers.home-assistant.io/docs/api/rest/) |
| 华为智能家居 / 鸿蒙智联 | 同上 | **面向个人的开放接口没查到** | — | 不可行 | 中 | 中 | — |
| 特斯拉 | 位置、行程、充电 | Fleet API，按量付费，每个账户每月 10 美元抵扣 | 自动 | 中 | 中 | 高 | [Tesla 计费说明](https://developer.tesla.com/docs/fleet-api/billing-and-limits) |
| 国产车（蔚来、理想、小鹏、比亚迪、问界…） | 同上 | 面向个人的开放接口官方没有公开（没逐个核实） | — | 不可行 | 中 | 高 | — |

---

## 三、给二狗的建议

### 3.1 前 8 个最值得先接的

> 华为运动健康、Gmail、日历、谷歌地图另有子 agent 在查，不进这个榜；单论价值它们也排得很靠前（尤其日历和账单邮件）。

| 排名 | 来源 | 价值 | 难度 | 隐私风险 | 为什么 | 用户要做的 |
|---|---|---|---|---|---|---|
| 1 | **Looki 官方接口** | 很高 | 低–中 | 高 | 刚买的，每天被动记录"去了哪、见了谁、做了什么"，Looki 已经把它总结成文字（时刻描述、日记），二狗直接拿文字就行，正好补"素材只有聊天"的短板 | 申请 API、建 Key、填进二狗 |
| 2 | **微信读书** | 很高 | 低 | 低 | 官方 Key、一个接口；划线和想法是用户自己的观点，最直接反映价值观；隐私风险小 | App 设置里拿 Key |
| 3 | **电脑：应用使用时间 + 浏览器历史** | 高 | 低 | 中–高 | 二狗就跑在这台电脑上，不用账号、全自动；看得出在忙什么、兴趣在哪、作息怎样 | 点同意；可选装 ActivityWatch |
| 4 | **手机照片和截图的时间地点**（家庭存储图库备份 → 电脑） | 高 | 低 | 高 | 鸿蒙上最现实的"手机生活"来源，手机侧零代码；EXIF 给出时间线和地点 | 确认开了图库备份、电脑能看到备份目录 |
| 5 | **笔记**（Obsidian / Notion / 印象笔记，用哪个接哪个） | 很高 | 极低–中 | 中 | 用户写给自己的东西，含金量最高 | 告诉二狗用哪个、给授权 |
| 6 | **支付宝 + 微信支付账单** | 高 | 低 | 极高 | 钱花在哪 = 真实优先级，比嘴上说的更可信；文件格式固定、好解析 | 每月导出一次，放进指定文件夹 |
| 7 | **微信 ClawBot 官方通道** | 高 | 中 | 高 | 微信是主战场；虽然读不了别的聊天，但用户可以随手把聊天、文章、图片转给二狗，也能直接在微信里和二狗聊，素材自然变多 | 扫码绑定；平时转发 |
| 8 | **电脑本地文件活动**（下载 / 文档 / 桌面 / 截图目录） | 中 | 低 | 中–高 | 全自动，补"最近在弄什么"；和第 3 项共用一套监视 | 点同意、选目录 |

**不建议先接**：鸿蒙通知 / 短信 / 通话记录（做不到）；微信本地库解密、QQ 协议机器人（违反协议、封号、法律风险）；Screenpipe 全程录屏（太敏感）；外卖、快递（拿不到、价值低）。

### 3.2 接这些来源时共同要守的规矩

按二狗"功能先跑通、安全后接"的规矩分两层：**先做**的是功能本身离不开的最小几条，**只记录**的是新安全设计，写进设计文档，不实现。

**先做（不做就没法用 / 没法撤）**
1. **逐项授权**：每个来源单独一个开关，默认关；开的时候写清楚"拿什么、多久拿一次、存在哪"。
2. **默认只读**：二狗只调读接口（Looki、微信读书本来就只读）；不替用户在这些平台上做任何事。
3. **进素材前确认**：拉来的东西先进"待入库"区，用户批量点头才进记忆；可以设"这个来源以后自动通过"。
4. **能一键断开并删除**：每条素材都记上来源 id；断开一个来源时，连同它产生的素材和由它推出的记忆一起删（对应二狗插件清单里"连数据删"的约定）。
5. **密钥只放密钥库**：Looki Key、微信读书 Key 不进聊天记录、不进记忆、不写日志（Looki 的 Skill 也是这么要求的）。
6. **出处可查**：每条素材带来源、原始时间、原始 id / 链接，记忆推理时能追回去。

**只记录、暂不实现（新安全设计）**
1. **敏感字段打码**：手机号、身份证、银行卡、住址、验证码、剪贴板里的密码，入库前替换掉。
2. **旁人保护**：Looki 拍到的别人的脸和声音，默认不存原图 / 原音，只存 Looki 的文字摘要；不做人脸识别。
3. **原始媒体最短保留**：照片视频只在处理时临时下载，处理完删，只留文字和缩略图。
4. **分级**：财务、健康、位置算高敏感，要单独二次确认，记忆里只存汇总（比如"本月外卖占餐饮 60%"），不存明细。
5. **被动数据降权**：从行为数据推出的"价值观"置信度要低于用户亲口说的，冲突时以用户说的为准。
6. **审计**：记下每次拉取了什么、几条，用户能看。

---

## 附：关键一手资料

- Looki：[官网](https://www.looki.ai/)｜[中国站](https://www.looki.tech/)｜[帮助中心](https://support.looki.ai/hc/en-001)｜[Looki for Codex（API 开通步骤）](https://www.looki.ai/blogs/news/looki-for-codex)｜[官方 Skill 文件](https://web.looki.ai/agent/looki-memory/SKILL.md)｜API 文档在 `web.looki.ai/api-references`（要登录才能看完整页面；本文的端点表取自该页面打包进前端的文档原文）｜[隐私政策（海外）](https://www.looki.ai/policies/privacy-policy)｜[隐私政策（中国）](https://www.looki.tech/policies/privacy-policy)
- 鸿蒙权限：[受限开放权限](https://gitcode.com/openharmony/docs/blob/master/zh-cn/application-dev/security/AccessToken/restricted-permissions.md)｜[系统应用权限](https://gitcode.com/openharmony/docs/blob/master/zh-cn/application-dev/security/AccessToken/permissions-for-system-apps-user.md)｜[通知订阅（系统接口）](https://gitcode.com/openharmony/docs/blob/master/zh-cn/application-dev/reference/apis-notification-kit/js-apis-notificationSubscribe-sys.md)（OpenHarmony 文档，HarmonyOS 商用版大体一致，以华为开发者官网为准）
- 微信 ClawBot：[npm @tencent-weixin/openclaw-weixin](https://www.npmjs.com/package/@tencent-weixin/openclaw-weixin)
- 微信读书：[官方 Skill 包](https://cdn.weread.qq.com/skills/weread-skills.zip)
- 支付账单：[微信支付用户手册](https://pay.weixin.qq.com/doc/user/4021834826)｜[支付宝帮助](https://help.alipay.com/lab/help_detail.htm?help_id=553265)

**调研方法说明**：Looki 的接口细节来自 Looki Web 公开的前端代码包（不用登录就能下载，里面带着 API 文档原文）和公开的 SKILL.md；我只对开放接口发了不带 Key 的请求（`/me` 回 401、`/verify` 回 ok），没有登录、没有申请、没有碰设备。
