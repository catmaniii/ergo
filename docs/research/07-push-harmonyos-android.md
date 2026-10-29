# 07 系统级推送：HarmonyOS（Push Kit / Live View）与 Android（国内通道）

- 调研日期：2026-10-07
- 范围：二狗 v2 的“手机系统级通知”能力。ArkWeb 外壳（HarmonyOS 单框架 / NEXT，纯 ArkTS）怎么接 Push Kit；Live View Kit（实况窗）能不能用来显示长程任务进度；HarmonyOS 后台限制；ArkWeb 与网页之间的桥；Android 在中国大陆的推送路线（FCM、各厂商通道、统一推送联盟、UnifiedPush + 自建 ntfy、前台服务长连接）；从通知里审批的安全问题；最后给出 daemon 内通知服务的设计建议、映射表、用户必须手动做的步骤和开放决策。
- 方法：只用一手来源。华为文档页面是 JS 渲染的，本次通过文档站的后台 JSON 接口（`svc-drcn.developer.huawei.com/.../documentPortal/getDocumentById` 与 `getCatalogTree`）直接取正文，所取页面的“最后更新”时间多为 **2026-09-29**；文中链接仍写成正常的 `developer.huawei.com/consumer/cn/doc/...` 页面地址。Android 用 developer.android.com、firebase.google.com；ntfy / UnifiedPush 用官方文档站与源码仓库（GitHub、Codeberg）。厂商通道（OPPO/vivo/小米）的部分页面同样是 JS 渲染，少数结论引用了二手来源，均已注明。
- 版本基线：华为发布说明显示当前最新 API 版本为 **26.0.0**，从这一版起 API 版本号改用语义化版本 X.Y.Z（https://developer.huawei.com/consumer/cn/doc/harmonyos-releases/version-number-26 ）。下文出现的 `5.1.0(18)`、`6.1.0(23)`、`26.0.0` 都是文档原文里的 API 版本标注。
- 标注约定：【未核实】=没找到一手依据或没实测；【推断】=根据文档推出、文档没有直说；【设计建议】=给 ergo 的建议，不是事实。

## 要点（TL;DR）

1. **HarmonyOS 上，进程被杀后唯一合规的通知通道是 Push Kit**。应用退到后台后很快会被挂起，没有一种长时任务类型适合“保持一条消息长连接”。Push Kit 后台消息（push-type 6）只在应用位于前台时才交给应用，否则缓存起来（§1、§3）。
2. **不上架也能收推送（文档层面支持）**：调试证书 + 在 AGC 注册的调试设备 + 开通推送服务后重新申请的调试 Profile，就能拿到 Push Token。实名开发者的调试证书有效期 1 年，未实名的只有 14 天。推送免费（§1.2）。
3. **关键限制是通知分类，不是签名**：没有“通知消息自分类权益”时，所有通知都算 `MARKETING`（资讯营销），而资讯营销通知**静默**（只进通知中心的“更多通知”，没有横幅、锁屏、铃声），每台设备每天只能 2 条（或 5 条）。ergo 需要申请 **`WORK`（工作事项提醒：待办、待处理的业务流程）**，安全类事件可以加申 `ACCOUNT`。审核周期 3 个工作日。即使分类获批，**横幅也默认关闭**，用户要自己去设置里打开（§1.5）。
4. **调试期绕开配额**：`testMessage: true` 时每个项目每天可推 1000 条，而且不受“场景化消息频控”（包括 2/5 条的资讯营销上限）限制。但它不改变通知分类：没有获批的 category 仍会被归为 MARKETING，仍然静默（§1.5）。
5. **Push Kit 通知没有动作按钮**。REST 的 `clickAction` 只能选打开首页、打开指定页面，实况窗里还能选清除通知、拨号。带按钮的通知只能由 Notification Kit 在本地发布，前提是应用进程活着。所以在 HarmonyOS 上，**审批只能“点通知 → 打开 App → 在 App 内审批”**。点击后的路由用 `clickAction.data`，它会出现在 `want.parameters` 里，冷启动时由 `onCreate` 收到，热启动时由 `onNewWant` 收到，再用 `runJavaScript` 交给 ArkWeb（§1.6、§4）。
6. **实况窗对 ergo 基本不可用**：正式权限要求“已上架且月活 ≥1000”。“调测设备管理”允许按 Push Token 加最多 100 台设备，免本地权限校验，但前提是先拿到“实况窗服务权益”（需审核）。开放的场景里没有“agent 任务”，最接近的 `PROGRESS` 限定为“用户手动开启的文件上传/下载、导入/导出”等。实况窗只能在应用位于前台时于本地创建，之后可以用 Push（push-type 7）更新，频率上限为 10 次/5 分钟、60 次/小时。建议**不依赖实况窗**，只作为可选实验（§2）。
7. **Android（中国大陆）**：FCM 依赖 Google Play 商店或 Play 服务，国内 ROM 基本不可用。OPPO、vivo 推送要求应用在各自商店**上架**（vivo 这条来自二手来源）。小米 2026-08-01 起执行新的私信/公信分类，通道需要审核。“统一推送联盟”目前只是一套标准，没有可直接调用的统一 API。**单用户自托管最省事、也最可靠的方案是 UnifiedPush / ntfy**：ntfy 服务端部署在 VPS，手机装 ntfy App，它用前台服务加 WebSocket 即时收消息。第一阶段甚至不用写 Android 代码。第二阶段由自己的 Android 外壳 App 充当 UnifiedPush 接收端，以 ntfy 作为 distributor，再自己画带按钮的通知（§5）。
8. **一个推送库覆盖两条线**：UnifiedPush 规范要求消息必须按 **RFC 8291**（Web Push 消息加密）加密，endpoint 是 **RFC 8030** 定义的 push resource，VAPID（RFC 8292）可选。所以 daemon 用同一个 Web Push 库，就能同时推给桌面浏览器的 Web Push 订阅和 Android 上的 UnifiedPush 接收端（§5.4）。
9. **安全**：HarmonyOS 规定三方应用**不能在后台发起身份认证**，只能用系统认证控件。Android 12 起，通知按钮可以用 `setAuthenticationRequired(true)` 强制先解锁设备；生物识别必须在前台 Activity 中进行。ntfy 的 `http` 按钮不要求解锁。**结论**：“批准”类操作一律不放进通知按钮，要打开 App 后由“生物识别 + 设备密钥对服务端挑战值签名”完成，签名绑定审批 ID 和规范化后的动作哈希。通知按钮只放“稍后提醒”“查看”这类低风险操作（§6）。
10. **ergo 的设计**：daemon 里建一个 `NotificationService`，把事件（意图）和投递渠道（provider adapter）分开。adapter 包括 HarmonyPush、WebPush（同时覆盖 UnifiedPush 和桌面浏览器）、Ntfy（纯文本加按钮）、Telegram（远期）、InApp（SSE）。另外要有一张持久化的设备注册表和带重试、幂等的 outbox，配额感知，用 `notifyId` 覆盖旧通知而不是刷屏，审批完成后**撤回**其他渠道上的通知（HarmonyOS 有撤回 API）。事件到分类的映射见 §7.2，手动步骤见 §7.3，开放决策见 §7.4。

## 目录

1. HarmonyOS Push Kit 端到端
2. Live View Kit（实况窗）
3. HarmonyOS 后台限制与“不用 Push Kit 还能怎样”
4. ArkWeb 外壳的桥接设计
5. Android（中国大陆）的推送路线
6. 安全：能不能在通知里审批
7. 对 ergo 的建议
8. 未核实清单

---

## 1. HarmonyOS Push Kit 端到端

### 1.1 Push Kit 能做什么

- 提供“系统级长连接”，**应用进程不存在时也能实时推送**（https://developer.huawei.com/consumer/cn/doc/harmonyos-guides/push-kit-introduction ）。
- 支持的设备：Phone、Tablet、PC/2in1、Wearable、TV。除 Wearable 外，**只支持中国境内**（不含港澳台）。不支持云真机，模拟器能收通知，但不支持语音播报、实况窗、应用内通话这三类消息（同上）。
- 收费：免费（https://developer.huawei.com/consumer/cn/doc/harmonyos-guides/push-faq-11 ）。
- 消息体（不含 Token）最大 4096 字节，超出返回错误码 80300008（https://developer.huawei.com/consumer/cn/doc/harmonyos-references/push-scenariozed-api-intro ）。
- **夜间管控**：系统会学习用户习惯、预测睡眠时间，睡眠期间收到的消息先缓存，醒后再投递。应用内通话消息和 `category=VOIP` 的消息除外（https://developer.huawei.com/consumer/cn/doc/harmonyos-guides/push-kit-introduction ）。对 ergo 来说，这意味着夜里的审批请求通常要到早上才送达。
- 网络要求：手机所在网络需要放通 5223 和 443 端口（同上）。

消息类型由请求头 `push-type` 决定（https://developer.huawei.com/consumer/cn/doc/harmonyos-references/push-scenariozed-api-request-struct ，https://developer.huawei.com/consumer/cn/doc/harmonyos-references/push-scenariozed-api-intro ）：

| push-type | 名称 | 行为 | 需要的特殊权益 | 对 ergo |
|---|---|---|---|---|
| 0 | Alert（通知消息 / 角标刷新） | 系统直接展示，点击拉起应用 | 想要“服务与通讯”类提醒，必须先申请通知消息自分类权益 | **主力** |
| 1 | 卡片刷新 | 刷新桌面服务卡片（Form Kit） | 无；但每张卡片有刷新频控 | 可选（桌面卡片显示“待审批 N 项”） |
| 2 | 语音播报 | 拉起通知扩展子进程（最长 10 秒）后展示 | 推送语音播报消息权益，**只开放给**商家订单、物流、收款和医疗紧急提醒场景 | 不可用 |
| 6 | 后台消息 | 应用在前台就交给应用；不在前台就缓存（只缓存最新一条，最多 7 天） | 无；建议每小时不超过 2 条 | 只能做“前台时同步” |
| 7 | 实况窗 | 创建、更新、结束实况窗 | 实况窗权益（§2） | 基本不可用 |
| 10 | 应用内通话 | 唤醒应用并弹出来电界面 | 需要《增值电信业务经营许可证》（B22）或盖章证明函 | 不可用 |

（语音播报：https://developer.huawei.com/consumer/cn/doc/harmonyos-guides/push-apply-right ；后台消息：https://developer.huawei.com/consumer/cn/doc/harmonyos-guides/push-background ；通话权益材料：https://developer.huawei.com/consumer/cn/doc/harmonyos-guides/push-apply-right ）

### 1.2 前提：账号、项目、开通推送、签名

**流程（官方“使用入门”）**（https://developer.huawei.com/consumer/cn/doc/harmonyos-guides/push-gettingstart ）：开通推送服务 → 申请通知消息自分类权益 → 客户端获取 Push Token → 客户端请求通知授权 → 配置 skills 标签 → 服务端用服务账号生成鉴权令牌 → 服务端调用 REST API → （可选）消息回执。

**开通推送服务**（https://developer.huawei.com/consumer/cn/doc/harmonyos-guides/push-config-setting ）：
- 先在 AGC 创建项目和应用，然后进入“增长 > 推送服务”，点击“立即开通”。推送服务权益是**项目级**的。
- 要设置**数据处理位置**。手机设备只支持中国境内，数据处理地固定为中国。数据处理位置和服务器位置或用户所在地不一致时，消息发不出去。
- 从 HarmonyOS NEXT Developer Beta2 起，**不再需要**配置公钥指纹和 Client ID。
- **调试阶段签名有两条路**：
  - 手动签名：“调试阶段必须申请调试证书、注册调试设备、确保已开通推送服务后**重新**申请调试 Profile 文件，并完成手动签名。”
  - 自动签名：DevEco Studio 6.0.0 Beta5 起支持，但必须是“**关联注册应用**”的自动签名（勾选 Associate with registered application）。开通 Push Kit 开放能力后，DevEco 会自动重签。另外，“Push Kit 开放能力接入后不可取消”（https://developer.huawei.com/consumer/cn/doc/harmonyos-guides/ide-signing-auto ）。
- 发布阶段要用发布证书和发布 Profile（同上）。

**由此推出**：“不上架、只装在自己手机上”的 App 走调试签名，文档上明确能拿到 Push Token、能收推送。**未关联 AGC 应用**的自动签名应该不能用于 Push【推断】：Push Token 有权益校验，`getToken` 只有在 AGC 开通推送后才返回 Token（https://developer.huawei.com/consumer/cn/doc/harmonyos-guides/push-get-token ）。【未核实：本次没有在真机上验证】

**签名材料的期限与上限**：
- 调试证书有效期：“实名认证开发者 1 年，未实名开发者 14 天。”过期后应用会被拦截启动（https://developer.huawei.com/consumer/cn/doc/app/agc-help-debug-cert-0000002283256797 ）。所以**每年要续签一次**。
- 一个账号最多管理 100 台设备；一个调试 Profile 最多选 100 台设备；一个应用最多 100 个 Profile（https://developer.huawei.com/consumer/cn/doc/app/agc-help-add-device-0000002283189937 ，https://developer.huawei.com/consumer/cn/doc/app/agc-help-debug-profile-0000002248181278 ）。
- **账号类型**：Push Kit 的文档没有区分个人开发者和企业开发者【未核实：没找到明确说明，但也没有看到限制】。语音播报、应用内通话、实况窗正式权限、优先通知这类特殊权益，基本都是面向特定行业或企业的（各节有出处）。

### 1.3 获取 Push Token

（https://developer.huawei.com/consumer/cn/doc/harmonyos-guides/push-get-token ，API 参考 https://developer.huawei.com/consumer/cn/doc/harmonyos-references/push-pushservice ）

- 在 `EntryAbility.onCreate()` 里调用 `pushService.getToken()`（`@kit.PushKit`），拿到后上报服务端。官方建议**每次启动都调用**，但不要频繁申请；也不要假定 Token 的长度固定。
- Token 失效的情况：卸载后重装、恢复出厂设置、显式调用 `deleteToken` 或 `deleteAAID` 后重新获取、Wearable 设备出境。
- `pushService.on('tokenUpdate')` 回调：手机从 6.1.0(23) 起支持，只能在 UIAbility 里注册，而且需要在 module.json5 的 skills 中配置 `action.ohos.push.listener`（整个工程只能有一个 Ability 配这个 action）。
- 获取 Token 时报 1000900010（App 身份验证失败），一般是签名或权益配置的问题。
- **发通知前必须先请求通知授权**：调用 `notificationManager.requestEnableNotification()`。应用的通知开关默认是关的（https://developer.huawei.com/consumer/cn/doc/harmonyos-guides/push-kit-introduction ，https://developer.huawei.com/consumer/cn/doc/harmonyos-guides/push-send-alert ）。

### 1.4 服务端 REST API（自建服务器）

**接口**（https://developer.huawei.com/consumer/cn/doc/harmonyos-references/push-scenariozed-api-request-struct ）：
- `POST https://push-api.cloud.huawei.com/v3/[projectId]/messages:send`。`projectId` 在 AGC 的“项目设置”里查看。
- **v3 只推 HarmonyOS NEXT/5.x 及以后的系统，v2 只推 3.x/4.x**（https://developer.huawei.com/consumer/cn/doc/harmonyos-guides/push-faq-8 ）。
- 请求头：`Content-Type: application/json`、`Authorization: Bearer <JWT>`、`push-type: <0|1|2|6|7|10>`。
- “HarmonyOS 5 及以上系统版本推送**不再支持 OAuth 2.0** 开放鉴权方式”，只能用 JWT（同上）。
- 只接受 TLS 1.2 及以上（https://developer.huawei.com/consumer/cn/doc/harmonyos-references/push-safety ）。

**鉴权：服务账号签发 JWT**（https://developer.huawei.com/consumer/cn/doc/harmonyos-guides/push-jwt-token ）：
- 在开发者联盟的 API Console（https://developer.huawei.com/consumer/cn/console/api/myApi ）给项目创建“服务账号密钥”，下载 JSON 文件。其中包含 `project_id`、`key_id`、`private_key`、`sub_account`、`token_uri` 等字段。**私钥华为不保存**，要自己保管好。
- Header：`{"kid": key_id, "typ": "JWT", "alg": "PS256"}`。
- Payload：`{"iss": sub_account, "aud": "https://oauth-login.cloud.huawei.com/oauth2/v3/token", "iat": now, "exp": now+3600}`。
- 签名算法是 SHA256withRSA/PSS（即 PS256）。令牌**不需要拿去换 access token**，直接放进 `Authorization` 头。建议有效期设 3600 秒，有效期内复用。服务器时间要对准。
- 官方示例有 Java、Node.js（jsonwebtoken）、Go、Python、PHP 几个版本。

Node（只用 `node:crypto`）的最小写法【设计建议；是否可用以实测为准】：

```ts
import { sign, constants } from 'node:crypto';
const b64u = (b: Buffer | string) => Buffer.from(b).toString('base64url');

function huaweiJwt(sa: { key_id: string; sub_account: string; private_key: string }) {
  const now = Math.floor(Date.now() / 1000);
  const head = b64u(JSON.stringify({ kid: sa.key_id, typ: 'JWT', alg: 'PS256' }));
  const body = b64u(JSON.stringify({
    iss: sa.sub_account, aud: 'https://oauth-login.cloud.huawei.com/oauth2/v3/token',
    iat: now, exp: now + 3600,
  }));
  const input = `${head}.${body}`;
  const sig = sign('sha256', Buffer.from(input), {
    key: sa.private_key, padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: 32, // PS256
  });
  return `${input}.${b64u(sig)}`; // 缓存约 55 分钟后重签
}

async function sendAlert(projectId: string, jwt: string, token: string, n: {
  category: string; title: string; body: string; notifyId: number; data: Record<string, string>;
}) {
  const res = await fetch(`https://push-api.cloud.huawei.com/v3/${projectId}/messages:send`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${jwt}`, 'push-type': '0' },
    body: JSON.stringify({
      payload: { notification: {
        category: n.category, title: n.title, body: n.body, notifyId: n.notifyId,
        clickAction: { actionType: 0, data: n.data },   // data 会出现在 want.parameters 中
        foregroundShow: false,                            // 前台时不弹，交给 receiveMessage
      } },
      target: { token: [token] },
      pushOptions: { ttl: 3600 /*, testMessage: true */ },
    }),
  });
  return res.json(); // 成功：{ code: "80000000", msg: "Success", requestId }
}
```

**常用字段**（https://developer.huawei.com/consumer/cn/doc/harmonyos-references/push-scenariozed-api-request-param ）：
- `pushOptions.ttl`：设备离线时的缓存时长。默认 86400 秒，最长 15 天。
- `pushOptions.collapseKey`：离线时按组只保留最新一条，取值 0–100，只对 push-type 0 和 2 生效。
- `pushOptions.testMessage`：标记为测试消息，见 §1.5。
- `pushOptions.receiptId`、`biTag`：消息回执用。
- `target.token`：一次最多 1000 个（卡片刷新只能 1 个）。
- `notification.notifyId`：取值 [0, 2147483647]，**同一个 notifyId 的新通知会覆盖旧通知**；要撤回消息时必须带。
- `appMessageId`：多渠道（Push、本地通知、应用自己拉取）去重，24 小时内只展示最早到达的一条。
- `badge.addNum` / `setNum`：设置角标。
- `style=3` 加 `inboxContent`：多行文本，最多 3 行。
- `image`：只支持 HTTPS，不超过 192KB。
- `sound` / `soundDuration`：铃声文件放在应用的 `rawfile` 里。从 2025-11 起不再需要单独申请权益，但 MARKETING 消息上无效（https://developer.huawei.com/consumer/cn/doc/harmonyos-guides/push-apply-right ）。
- `profileId`：账号校验，用于多账号设备；ergo 单用户用不到。
- `priorityScene`：优先通知，需要单独申请，只开放给商务类和社交通讯类应用（https://developer.huawei.com/consumer/cn/doc/harmonyos-guides/priority-notification-permission-guidelines ）。

**响应与错误**：成功时 `code` 为 `"80000000"`。HTTP 401 表示鉴权失败，503 表示流控（QPS 超阈值或全网流控）（https://developer.huawei.com/consumer/cn/doc/harmonyos-references/push-scenariozed-api-response ，https://developer.huawei.com/consumer/cn/doc/harmonyos-references/push-msg-freq-control ）。

**撤回**：`POST https://push-api.cloud.huawei.com/v1/[clientId]/messages:revoke`，同样用 JWT 鉴权，`push-type` 填 0。按 `notifyId` 加 token 撤回，只对“还没送到”或“已展示但用户还没点”的通知有效（https://developer.huawei.com/consumer/cn/doc/harmonyos-references/push-msg-revoke ，https://developer.huawei.com/consumer/cn/doc/harmonyos-guides/push-revoke-alert ）。注意这个接口的路径参数是 **clientId**，不是 projectId。ergo 可以在审批已在别处完成后撤回手机上的通知。

**消息回执**（可选）（https://developer.huawei.com/consumer/cn/doc/harmonyos-guides/push-msg-receipt ）：
- 在 AGC 配置回执 URL。华为会校验回执服务器是否用“**商用 CA 签发的证书**”。
- 回执请求头 `X-HUAWEI-CALLBACK-ID` 里带 `timestamp`、`nonce`、`value`，其中 `value = Base64(HMAC-SHA256(secret, timestamp+nonce+userName))`。
- 有用的状态码：0 成功送达、2 应用已卸载、6 通知未展示、27 进程不在而后台消息被缓存、51 开机后未解锁、102 设备频控丢弃、256 场景频次限制。
- 回执 URL 要放在 VPS 的 nginx 上。Let's Encrypt 证书算不算“商用 CA”【未核实】。

### 1.5 通知分类、提醒方式与配额（决定体验的关键）

（https://developer.huawei.com/consumer/cn/doc/harmonyos-guides/push-apply-right ，https://developer.huawei.com/consumer/cn/doc/harmonyos-guides/notification-slot ）

**两大类**：

| 大类 | 提醒方式 | 数量 |
|---|---|---|
| 服务与通讯（社交通讯 + 服务提醒） | 锁屏、铃声、振动（以用户在通知管理里的设置为准） | 受“设备消息频控”约束：“系统会根据使用场景和流量进行管控”，**阈值不公开** |
| 资讯营销（`MARKETING`） | **静默**，只出现在通知中心的“更多通知”里 | 每个应用每台设备每个自然日 **2 条**（新闻类持证应用为 5 条）；不在分类表里或没申请自分类权益的应用默认 2 条 |

**category 取值**（服务与通讯类）：
- 社交通讯：`IM`、`VOIP`、`MISS_CALL`。
- 服务提醒：`TRAVEL`、`HEALTH`、`WORK`、`ACCOUNT`、`EXPRESS`、`FINANCE`、`DEVICE_REMINDER`、`MAIL`、`PLAY_VOICE`、`SUBSCRIPTION`。

**几条硬规则**：
- 没有自分类权益，或者带了没获批的 category（比如没开通 IM 却传了 IM），消息都会被**自动归为资讯营销**。
- 本地通知的渠道表里，`CONTENT_INFORMATION`、`OTHER_TYPES` 渠道（对应 MARKETING）的横幅、锁屏、铃声振动、状态栏图标、亮屏这几列全是 **N**。也就是说，静默不是用户能改的设置，是这个渠道根本不支持（https://developer.huawei.com/consumer/cn/doc/harmonyos-guides/notification-slot ）。
- 即使是 SOCIAL_COMMUNICATION 或 SERVICE_INFORMATION 渠道，“**横幅通知默认关闭**（不支持应用配置、用户可手动开启）”。

**适合 ergo 的分类**：
- **`WORK`（工作事项提醒）**：官方说明是“用户下一步需要做某件事项的提醒、待处理的业务流程”，例子有待办提醒、审核进度提醒、工单处理。待审批、待回答都能对上，任务完成或失败也勉强能算。**这是首选。**
- **`ACCOUNT`（账号动态）**：“账号上下线、账号状态变化”，适合安全事件，比如新设备登录、设备密钥变更。
- `IM` 要求是“用户间点对点聊天消息”，agent 向用户提问不属于这一类，有被判为**误分类违规**的风险【推断】。
- `SUBSCRIPTION` 只开放几种规定场景，还要求有订阅弹窗流程，不合适。
- `DEVICE_REMINDER` 限定为 IoT 设备的提醒，不合适。

**申请自分类权益**：
- 入口：AGC“增长 > 推送服务 > 配置”，选中应用，点自分类权益后的“申请”。
- 选择消息类型并填写消息示例，**审核 3 个工作日**，通过 5 分钟后生效。
- 官方原则写的是“所有应用可申请，部分自分类申请需与应用分类相关”。WORK 没有列为与应用分类挂钩。
- 未上架的个人应用能不能批下来【未核实：没找到官方说明，也没看到要求必须上架的条款；社区二手文章说“可以申请”】。
- 分类填错或违规，按《通知违规处罚标准》处理（https://developer.huawei.com/consumer/cn/doc/harmonyos-guides/push-punishment-standards ）。
- 官方另外提供了“通知消息自分类权益推荐 Skill”，可以帮忙选类别（https://developer.huawei.com/consumer/cn/doc/harmonyos-guides/push-skill-classification ）。

**测试消息**（https://developer.huawei.com/consumer/cn/doc/harmonyos-references/push-msg-freq-control ，https://developer.huawei.com/consumer/cn/doc/harmonyos-guides/push-faq-5 ）：
- `testMessage: true` 时，每个项目每天 1000 条，所有设备共用。计数的是“REST 请求成功的总数”，单次最多 10 个 Token。测试消息**不受场景化消息频控**，包括资讯营销的 2/5 条上限。超过 1000 条后，回执返回 256。
- 但 category 的归类照样生效。**所以 testMessage 只解决“条数”，解决不了“静默”。**
- 官方定位是“调测阶段用，正式发布时改为 false”（同上）。单用户应用长期用 testMessage 算不算违规，【未核实】。

**内容规范**里会直接影响 ergo 的几条（https://developer.huawei.com/consumer/cn/doc/harmonyos-guides/push-specification ，https://developer.huawei.com/consumer/cn/doc/harmonyos-guides/push-detail-rules ）：
- 不得重复发送相同内容的通知来打扰用户。
- 通知标题与正文不得重复。
- 不得用进行中通知把消息强制置顶（进度类、通话类等例外）。
- 点击后的落地页必须和通知内容一致。

### 1.6 动作按钮与点击路由

**Push Kit 通知没有按钮**。`ClickAction.actionType` 的取值：
- push-type 0 和 2：只能是 0（打开首页）或 1（打开自定义页面）。
- 实况窗的扩展区（`notificationData.extend.clickAction`）：还能多选 3（清除通知）和 5（拨号）。

请求参数里也没有任何按钮字段（https://developer.huawei.com/consumer/cn/doc/harmonyos-references/push-scenariozed-api-request-param ）。

**按钮只存在于本地通知**：Notification Kit 的 `NotificationRequest.actionButtons`，每个按钮挂一个 `WantAgent`，作用是拉起 UIAbility 或发布公共事件（https://developer.huawei.com/consumer/cn/doc/harmonyos-guides/notification-with-wantagent ）。但“当应用进程终止后，本地通知发布通道关闭”（https://developer.huawei.com/consumer/cn/doc/harmonyos-guides/notification-overview ）。

**能不能在收到推送时改写通知内容**：`RemoteNotificationExtensionAbility` 能做到，但它只服务于**语音播报消息**（push-type 2，需要特殊权益）。它最长运行 10 秒，**不允许调用通知 API**，只能返回 title、text、badge、`wantAgent{abilityName, parameters}`，**不能加按钮**（https://developer.huawei.com/consumer/cn/doc/harmonyos-references/push-remote-notification-extension-ability ，https://developer.huawei.com/consumer/cn/doc/harmonyos-references/push-pushcommon ）。

**结论**：HarmonyOS 上做不到“锁屏状态下在通知里点一下就批准”。这在安全上反而是好事（§6）。

**点击路由**（https://developer.huawei.com/consumer/cn/doc/harmonyos-guides/push-send-alert ）：
- `actionType: 0` 加 `data: {...}`：点击后打开首页，即入口 Ability（EntryAbility）。`data` 里的键值会出现在 `want.parameters` 里：
  - 冷启动：在 `onCreate(want)` 中读取。
  - 热启动：在 `onNewWant(want)` 中读取。`onNewWant` 只在 singleton 启动模式下可用。
- `actionType: 1` 加 `action` 或 `uri`：打开某个特定 Ability，需要在 skills 里单独配一个 skill。注意首页那条 skill（`entity.system.home` 加 `ohos.want.action.home`）**不能配 uris**，否则收不到消息。
- 推荐 ergo 用 `actionType: 0`，只放一个 `data.route`（以及 `data.nid`），由壳把它翻译成 ArkWeb 路由（§4）。这样不必为每个页面配 skill。

**应用在前台时**：设置 `foregroundShow: false`，前台就不弹系统通知，改由 `pushService.receiveMessage('DEFAULT', ...)` 把内容交给应用（需要配置 `action.ohos.push.listener`）。注意 `foregroundShow: true`（默认值）时，`receiveMessage` **不会被触发**（同上）。这样网页正在打开时可以在页面里提示，不会再弹一遍系统通知。

---

## 2. Live View Kit（实况窗）

（https://developer.huawei.com/consumer/cn/doc/harmonyos-guides/liveview-introduction ）

**适用范围**：
- HarmonyOS 5 及以上，**只支持 Phone 和 Tablet**，只在中国境内。
- 准入原则：用户高度关注、需要反复查看的活动；有明确的开始和结束，**最长不超过 8 小时**；用户对收到实况窗有预期；不能用于营销。

**开放的场景**（`event`）：
- TAXI、DELIVERY、FLIGHT、TRAIN、QUEUE、PICK_UP、SCORE、RENT、TIMER、SUBSCRIBE_TIMER、WORKOUT、NAVIGATION、CHECK_IN、EXPRESS、PROGRESS、TRADE。
- `PROGRESS`（进度类型）：适用于“**用户手动开启**的文件上传/下载、资源导入/导出等场景”；明确**不适用**于“文件在后台自动上传/下载”。子场景有 UPLOAD、DOWNLOAD、IMPORT、EXPORT、BACKUP、RECOVER（https://developer.huawei.com/consumer/cn/doc/harmonyos-references/liveview-liveviewmanager ）。
- `TIMER`：“仅限于工具类应用申请（计时场景仅支持通过端侧创建与更新）”，并点名排除“AI 对话时长、事项待办”等场景。
- **没有能对应“agent 长程任务”的场景**。PROGRESS 最接近，但正式审核大概率通不过【推断】。

**权益流程**：
1. 开通推送服务（https://developer.huawei.com/consumer/cn/doc/harmonyos-guides/liveview-push-service ）。
2. 申请“实况窗服务权益”：AGC“项目设置 > 开放能力管理”，按模板写申请原因，附上用可视化工具做的设计方案。**5 个工作日**内出结果。通过后要重新生成 Profile（https://developer.huawei.com/consumer/cn/doc/harmonyos-guides/liveview-rights ）。
3. 接入联调测试：在“增长 > 推送服务 > 配置 > 实况窗-调测设备管理”里按 **Push Token** 添加设备，每个应用最多 100 台，24 小时内生效。“添加到调测名单中的设备，**不做本地构建实况窗权限的校验**”，调测权限的有效期和 Push Token 一致（https://developer.huawei.com/consumer/cn/doc/harmonyos-guides/liveview-joint-commission-test ）。
4. 正式权限：在应用场景里点“申请”的前提是“**应用月活数大于等于 1000 且为已上架应用**”。方案评审加测试验收约 15 个工作日（https://developer.huawei.com/consumer/cn/doc/harmonyos-guides/liveview-formal-authority ）。

**对个人未上架 App 的结论**：正式权限拿不到。唯一可能的路径是先拿到第 2 步的服务权益，再把自己的手机加进调测设备，长期按“调测”方式使用。第 2 步能不能用 agent 任务这个理由批下来、调测通道是否长期可用，都【未核实】。

**创建与更新**：
- 本地创建：“只有应用**在前台运行**……开发者才可以创建实况窗”。本地更新和结束依赖应用进程存活，所以官方推荐“本地创建后用 Push Kit 更新或结束”（https://developer.huawei.com/consumer/cn/doc/harmonyos-guides/liveview-create-locally ）。
- 通过 Push 创建：只支持 FLIGHT、TAXI、TRAIN、DELIVERY、QUEUE、RENT、EXPRESS、CHECK_IN、TRADE、SUBSCRIBE_TIMER，**不包括 PROGRESS**（https://developer.huawei.com/consumer/cn/doc/harmonyos-guides/liveview-introduction ）。
- 通过 Push 更新（push-type 7，`activityId` 对应本地的 `id`）：每个实况窗每台设备 **5 分钟最多 10 次、每小时最多 60 次**（打车和比分场景是 30 次 / 180 次），超出部分直接丢弃（https://developer.huawei.com/consumer/cn/doc/harmonyos-references/push-msg-freq-control ）。
- 生命周期：最长 8 小时。超过 2 小时不更新，会从状态栏胶囊和锁屏上隐藏；超过 4 小时不更新，视为已结束（https://developer.huawei.com/consumer/cn/doc/harmonyos-guides/liveview-introduction ）。
- 从 26.0.0 起可设 `lifeCycleMode: AUTO_STOP_WHEN_APP_TERMINATE`，从 6.1.1(24) 起可设 `aliveTime`，用来防止留下“僵尸”实况窗（https://developer.huawei.com/consumer/cn/doc/harmonyos-guides/liveview-faq-3 ）。
- 本地实况窗可以带“连续服务按钮”（`serviceButtons`，挂 WantAgent），但**云侧不支持这个字段**（https://developer.huawei.com/consumer/cn/doc/harmonyos-references/liveview-api-map ）。

**ergo 的替代方案**【设计建议】：
- 进度不推送，打开 App 时在页面里看。
- 只在里程碑（完成、失败、需要人介入）时发一条 WORK 通知。
- 同一个任务的通知用同一个 `notifyId` 覆盖，不要每一步都新发一条。

---

## 3. HarmonyOS 后台限制与“不用 Push Kit 还能怎样”

（https://developer.huawei.com/consumer/cn/doc/harmonyos-guides/background-task-overview ）

总的原则：“应用退至后台一段时间应用进程会被挂起……挂起后，无法使用软件资源（如公共事件、定时器等）和硬件资源（CPU、**网络**、GPS、蓝牙等）。”“系统仅支持规范内受约束的后台任务。”

| 类型 | 规则 | 能不能用来收 ergo 事件 |
|---|---|---|
| 短时任务 | 只能在前台或 `onBackground` 里申请。单次最多 3 分钟（低电量时 1 分钟），**每天合计 10 分钟**，同时最多 3 个（https://developer.huawei.com/consumer/cn/doc/harmonyos-guides/transient-task ） | 只够切到后台时把状态存好 |
| 长时任务 | 类型有 DATA_TRANSFER、AUDIO_PLAYBACK、AUDIO_RECORDING、LOCATION、BLUETOOTH_INTERACTION、MULTI_DEVICE_CONNECTION、VOIP、TASK_KEEPING、MODE_AV_PLAYBACK_AND_RECORD、MODE_SPECIAL_SCENARIO_PROCESSING、MODE_NEARLINK。系统会做一致性校验：“申请长时任务后，应用未执行相应的业务……会被挂起”（https://developer.huawei.com/consumer/cn/doc/harmonyos-guides/continuous-task ） | **没有合规类型**（见下文） |
| 延迟任务 | 由系统统一调度。按应用活跃度分组，**最短间隔 2 小时**，常用分组 24 小时，极少使用分组 48 小时。单次最长 2 分钟（https://developer.huawei.com/consumer/cn/doc/harmonyos-guides/work-scheduler ） | 只能做低频补拉，不能实时 |
| 代理提醒 | 只支持倒计时、日历、闹钟三类定时提醒。手机上受管控，要申请权限，而且只对工具、商务、效率等应用类别开放（https://developer.huawei.com/consumer/cn/doc/harmonyos-guides/agent-powered-reminder ） | 只适合“预先知道时间”的提醒 |

长时任务逐个看：
- **DATA_TRANSFER**：要求有真实的非托管上传或下载，而且“首次更新超过 10 分钟”没更新进度就会被取消，进度通知还必须用实况窗。
- **VOIP**：要求真的在通话。
- **TASK_KEEPING**：手机上要先拿到 ACL 权限 `ohos.permission.KEEP_BACKGROUND_RUNNING_SYSTEM`，典型场景是“自动接单等计算类业务”。
- 接入规范明确禁止“恶意保活”，以及“在非用户主动行为触发的场景”下申请长时任务（https://developer.huawei.com/consumer/cn/doc/harmonyos-guides/bgtask-design-formula ）。
- 结论：**在后台保持 WebSocket 不断没有合规办法**。官方 FAQ 也写明，应用在后台时只有语音播报消息和后台消息（开启 proxyData 时写进数据库，不拉起进程）这两种能让应用“内部收到消息”（https://developer.huawei.com/consumer/cn/doc/harmonyos-guides/push-faq-9 ）。

**一个只适合“自己的调试包”的实验口子**【未核实，不建议作为主路径】：
- 自动签名文档说，在**未关联注册应用**的调试签名下，“不会强制校验配置文件中添加的 ACL 权限”（https://developer.huawei.com/consumer/cn/doc/harmonyos-guides/ide-signing-auto ）。理论上可以声明 TASK_KEEPING 试试能不能在后台保活。
- 但 Push Kit 必须走**关联注册应用**的签名（§1.2），两者不能同时成立；后台负载异常时系统仍会挂起应用。另外，关联应用申请 ACL 后，在审批完成前能拿到一个“有效期较短的临时 Profile”。

**不用 Push Kit 时现实可行的做法**：
1. App 在前台时，网页用 WebSocket 或 SSE 和 daemon 保持连接；回到前台时补拉一次“未读事件”。
2. agent 事先知道时间的提醒（例如“明天 9 点提醒我”），由 App 在前台时写进系统日历（Calendar Kit，代理提醒在手机上的官方替代方案，见上面代理提醒的链接）。
3. 借用第三方 IM 机器人（企业微信、飞书、钉钉都有 HarmonyOS NEXT 客户端，推送由它们自己负责）。例如企业微信“应用消息”的**按钮交互型模板卡片**，点击会回调到开发者服务器，但必须先配置回调接口（https://developer.work.weixin.qq.com/document/path/90236 ）。企业微信的可信 IP、可信域名、个人能不能建企业等要求【未核实】。
4. 短信或邮件，最后的兜底。

---

## 4. ArkWeb 外壳的桥接设计

背景：前作的壳只有约 350 行 ArkTS，用 `javaScriptProxy` 注入 `window.native`（调研 01，未公开）。ergo v2 的网页不在 rawfile 里，而是加载远端的 `https://<ergo 域名>/`（VPS nginx → ssh 反向隧道 → daemon）。

### 4.1 ArkWeb 侧的事实

（https://developer.huawei.com/consumer/cn/doc/harmonyos-guides/web-in-page-app-function-invoking ，https://developer.huawei.com/consumer/cn/doc/harmonyos-references/arkts-apis-webview-webviewcontroller ，https://developer.huawei.com/consumer/cn/doc/harmonyos-guides/web-in-app-frontend-page-function-invoking ）

- 有两种注入方式：初始化时用 `javaScriptProxy({...})`，初始化后用 `registerJavaScriptProxy(obj, name, methodList, asyncMethodList?, permission?)`。两种都要配合 `deleteJavaScriptRegister`。
- 注入的对象“暴露给**所有**页面 frames”。官方要求“尽可能只在可信的 URL 及 HTTPS 场景下”注册。
- 可选参数 `permission` 是一个 JSON 字符串，可以按 scheme、host、port、path 给整个对象或单个方法设白名单（`javascriptProxyPermission.urlPermissionList` / `methodList`）。
- 支持在两侧之间传 Promise。`asyncMethodList` 里的方法异步执行，不阻塞 H5 线程。
- 应用调网页用 `runJavaScript()` 或 `runJavaScriptExt()`。需要双向流式通信时可以用 `createWebMessagePorts`（https://developer.huawei.com/consumer/cn/doc/harmonyos-guides/web-app-page-data-channel ）。

### 4.2 三条数据流

1. **注册设备**：
   - 壳在 `EntryAbility.onCreate` 里调用 `getToken()`，结果存进 AppStorage。
   - 网页已经登录（有 session）后，调用 `ergoNative.getPushRegistration()`，再 `POST /api/devices` 上报 `{provider:'harmony-push', address: token, label, appVersion, devicePublicKey}`。
   - 每次启动都上报一次，服务端按 provider 加 address 做幂等。daemon 收到失效类回执（2、5）或撤回失败时，把这台设备标为 stale。
2. **点击通知**：
   - 推送里带 `clickAction.data = {route:'/approvals/ap_123', nid:'n_456'}`。
   - 冷启动：`onCreate(want)` 读到后存为 pending，网页加载完成后自己来取。
   - 热启动：`onNewWant(want)` 读到后用 `runJavaScript` 发出 `ergo:intent` 事件。
   - 网页收到后做前端路由跳转，并上报 `nid` 已被点击（同时充当已读回执）。
3. **前台消息**：
   - daemon 发通知时一律带 `foregroundShow:false`。
   - 壳用 `receiveMessage('DEFAULT')` 收到后转给网页（`ergo:push` 事件），由网页决定显示什么。
   - 网页本身也有 SSE，所以这一步主要用来去重，以及在 SSE 断开时兜底。

### 4.3 JS 桥 API 草案【设计建议】

```ts
// web 侧类型（壳不存在时退化为浏览器实现：Web Push / 纯页面）
interface ErgoNative {
  platform(): 'harmony' | 'android';
  getPushRegistration(): Promise<{
    provider: 'harmony-push' | 'unifiedpush'; address: string; // token 或 endpoint
    keys?: { p256dh: string; auth: string };                    // 仅 unifiedpush/webpush
    appVersion: string; deviceLabel: string;
  }>;
  notificationStatus(): Promise<{ enabled: boolean }>;
  requestNotificationPermission(): Promise<boolean>;            // requestEnableNotification
  openNotificationSettings(): void;                              // 引导用户开横幅
  takePendingIntent(): string | null;                            // 冷启动时的 {route,nid} JSON，读一次即清
  getDeviceKey(): Promise<{ keyId: string; publicKeySpki: string }>; // 首次注册时上传公钥
  stepUpSign(challengeB64: string, reason: string): Promise<{ keyId: string; sigB64: string }>;
  setBadge(n: number): void;                                     // notificationManager.setBadgeNumber
}
// 壳 → 网页的事件：window.dispatchEvent(new CustomEvent(name, { detail }))
//   'ergo:intent'         {route, nid}       点击通知（热启动）
//   'ergo:push'           {data}             前台收到推送（foregroundShow:false）
//   'ergo:token-changed'  {address}          tokenUpdate 回调
```

ArkTS 侧骨架（省略错误处理）【设计建议】：

```ts
// EntryAbility.ets
onCreate(want: Want) { captureIntent(want); pushService.getToken().then(t => AppStorage.setOrCreate('pushToken', t)); }
onNewWant(want: Want) { captureIntent(want); }        // 默认 launchType 为 singleton
function captureIntent(want: Want) {
  const route = want.parameters?.['route'] as string | undefined;
  const nid = want.parameters?.['nid'] as string | undefined;
  if (route && /^\/(approvals|tasks|questions)\/[\w-]+$/.test(route))   // 路由白名单，防开放跳转
    AppStorage.setOrCreate('pendingIntent', JSON.stringify({ route, nid }));
}

// Index.ets
Web({ src: ORIGIN + '/app', controller: this.ctl })
  .javaScriptProxy({
    object: this.bridge, name: 'ergoNative', controller: this.ctl,
    methodList: ['platform', 'takePendingIntent', 'openNotificationSettings', 'setBadge'],
    asyncMethodList: ['getPushRegistration', 'notificationStatus', 'requestNotificationPermission',
                      'getDeviceKey', 'stepUpSign'],
    permission: JSON.stringify({ javascriptProxyPermission: { urlPermissionList: [
      { scheme: 'https', host: ORIGIN_HOST, port: '', path: '' } ] } }),
  })
// @StorageLink('pendingIntent') + @Watch：页面已加载时
//   this.ctl.runJavaScript(`window.dispatchEvent(new CustomEvent('ergo:intent',{detail:${json}}))`)
```

要点：
- `route` 在壳里过一遍白名单，网页侧再校验一遍。
- 推送载荷里**不放任何秘密**，只放不透明的 ID。
- `stepUpSign` 的实现见 §6.3。

---

## 5. Android（中国大陆）的推送路线

### 5.1 FCM

- FCM 的 Android 客户端要求“Android 6.0 及以上，且装有 **Google Play 商店**”（https://firebase.google.com/docs/cloud-messaging/android/client ）。国内 ROM 一般没有 Play 服务。
- Google 服务在中国大陆被屏蔽，FCM 的服务端和设备端都连不上（二手来源：https://en.wikipedia.org/wiki/Censorship_of_Google ）。
- 结论：**国内手机上 FCM 不可用**。只有装了 Play 服务、又常年挂代理的手机才勉强能用，不值得当主路径。
- 连带影响：桌面版 Chrome 的 Web Push 走 FCM，在国内同样不可靠。Edge 走微软的推送服务，Firefox 走 Mozilla autopush，它们在国内能否连通【未核实】。

### 5.2 厂商推送

| 通道 | 前提与限制 | 对单用户、未上架 App |
|---|---|---|
| 华为 HMS Push（Android 版） | 华为设备需 EMUI 3.0+；**非华为设备也要装 HMS Core**，官方表格列的是 Android 4.4–13（https://developer.huawei.com/consumer/cn/doc/HMSCore-Guides/service-introduction-0000001050040060 ）。不适用于 HarmonyOS NEXT 单框架（NEXT 走 §1 的 Push Kit） | 只在旧华为或荣耀机上有意义 |
| 荣耀推送 | 需要注册开发者并实名、创建应用、申请推送服务，拿 App ID、Client ID、Client Secret；支持通知栏、透传、VoIP 消息（官方 demo：https://github.com/HONORDevelopers/Honor-Push-Client-demo ；接口：https://developer.honor.com/cn/docs/11002/guides/cloud-base-api ） | 能否不上架就开通【未核实】 |
| 小米推送 | 2026-08-01 起执行新分类规则，消息类型扩到 75 类：**私信**（聊天、通话、账号安全、交易提醒、订单物流、设备状态等，不限量）和**公信**（严格限量；8 类可订阅消息在用户订阅后按私信管控）。新通道要在运营平台申请，审核 5 个工作日（https://dev.mi.com/xiaomihyperos/documentation/detail?pId=2321 ） | 文档没写要求上架【未核实】；“agent 待审批”该归哪一类，需要自己去匹配 41 个私信场景 |
| OPPO 推送 | 官方开发者社区写明“应用需在 OPPO 软件商店**上架**”；借贷类应用只能用每天 1000 条的测试权限（https://open.oppomobile.com/bbs/forum.php?mod=viewthread&tid=1906 ） | **不可行**（未上架） |
| vivo 推送 | 应用必须先在 vivo 开放平台审核**上架**，才能通过推送服务审核；运营消息每人每天 2–5 条，只能在 7:00–23:00 推；系统消息不限量（二手：腾讯云接入文档 https://cloud.tencent.cn/document/product/548/36657 ；vivo 官方页面是 JS 渲染，没取到正文） | **不可行**（未上架） |

### 5.3 统一推送联盟 / 统一推送标准

- 统一推送工委会 2025-05 发文，说已有 17 家品牌（华为、荣耀、OPPO、vivo、小米等）完成“通知栏消息”统一推送标准的适配，并计划“适时启动 ID 互联互通相关标准制定”（二手：https://www.ithome.com/0/852/629.htm ）。另有报道称联盟官网域名一度挂牌出售（二手：https://m.jiemian.com/article/7942898.html ）。
- **对开发者的实际意义**：没找到一个能直接调用的“统一 API 或统一 SDK”。现实做法仍然是逐家接厂商 SDK，或者用个推、极光这类聚合商【未核实是否存在可用的统一接口；这里按“标准层面的适配”理解】。**这不是一条可用的通道。**

### 5.4 UnifiedPush + 自建 ntfy

**UnifiedPush 是什么**：一个去中心化的推送体系。应用服务器把消息发给用户自己选的 distributor 的服务器，distributor App 再转给目标应用。distributor 有 ntfy、Sunup、NextPush、Conversations、gCompat-UP 等（https://unifiedpush.org/ ）。

**规范要点**（Android 规范：https://codeberg.org/UnifiedPush/specifications/src/branch/main/specifications/android.md ；术语：https://unifiedpush.org/developers/spec/definitions/ ）：
- Endpoint 是 RFC 8030 定义的 push resource，属于 capability URL，至少要含 160 bit 的随机熵。
- 消息“**MUST** be an encrypted content that follows RFC 8291”，大小 1–4096 字节，明文最多 3993 字节。
- VAPID（RFC 8292）可选。如果服务器要求 VAPID，注册时就得带公钥。
- 也就是说，**应用服务器发 UnifiedPush 和发 Web Push 的方式完全一样**（都是加密后 POST 到 endpoint）。daemon 可以复用同一个 Web Push 库【推断，依据是上面两条规范】。
- Android 接入库 `android-connector` 已从 GitHub 迁到 Codeberg，最新版本 3.3.4（2026-08-20）（https://codeberg.org/UnifiedPush/android-connector ）。

**ntfy**：
- 服务端可以自托管，提供 `auth-default-access: "deny-all"`、用户与访问令牌、`behind-proxy`、`keepalive-interval`（例如 45s）、Web Push（VAPID 配置项）等能力（https://docs.ntfy.sh/config/ ）。
- **Android App**（https://docs.ntfy.sh/subscribe/phone/ ）：
  - “uses Firebase only for the main host ntfy.sh, and only in the Google Play flavor……It won't use Firebase for any self-hosted servers”。
  - F-Droid 版不带 Firebase，所有订阅默认走 instant delivery。
  - Instant delivery 用一个**前台服务**实现（通知栏常驻一条），“even when your phone is in doze mode”。
  - 源码确认：前台服务类型是 `specialUse`，申请了 `REQUEST_IGNORE_BATTERY_OPTIMIZATIONS`、`RECEIVE_BOOT_COMPLETED`、`SCHEDULE_EXACT_ALARM`，用 WebSocket 连接并持有 wakelock（https://github.com/binwiederhier/ntfy-android ：`AndroidManifest.xml`、`service/SubscriberService.kt`、`service/WsConnection.kt`）。
  - 可以作为 UnifiedPush distributor。
- **通知按钮**：最多 3 个，类型有 `view`（打开 URL 或 App）、`http`（直接发 HTTP 请求）、`broadcast`（只在 Android 上有效）、`copy`（https://docs.ntfy.sh/publish/ ）。源码里构造按钮时**没有调用** `setAuthenticationRequired`（`msg/NotificationService.kt`）。所以 `http` 按钮在锁屏状态下也能触发，**不能拿来做“批准”**。

### 5.5 自己写前台服务长连接

- 前台服务类型（https://developer.android.com/develop/background-work/services/fgs/service-types ）：
  - `remoteMessaging`：在设备间转发文本消息。
  - `specialUse`：其他类型都不适用时使用；上架 Google Play 时要说明理由（这里不上 Play，不受影响）。
  - `dataSync`：从 Android 15 起不能在 `BOOT_COMPLETED` 里启动。
  - `shortService`：大约 3 分钟。
- 时限：面向 Android 15+ 的应用，`dataSync` 和 `mediaProcessing` 在后台**每 24 小时合计 6 小时**，超时后系统回调 `onTimeout`，不停止就抛异常（https://developer.android.com/develop/background-work/services/fgs/timeout ）。所以长连接不能用 `dataSync`。
- Doze：会暂停网络、忽略 wakelock、推迟闹钟（https://developer.android.com/training/monitoring-device-state/doze-standby ）。
  - 电池优化豁免的合理用途表里，“有技术原因无法使用 FCM 的消息类应用”标为 **Acceptable**，这正是 ergo 的情况。
  - 同一页还说：有前台服务在跑的应用不会被归为 idle。
- 国产 ROM 有各自的自启动管理和后台清理，需要用户手动加白名单【经验，未逐家核实】。
- Android 13+ 发通知需要运行时权限 `POST_NOTIFICATIONS`（https://developer.android.com/develop/ui/views/notifications/build-notification ）。

### 5.6 哪个最简单、最可靠（单用户、自托管）

1. **阶段 A（零 Android 代码）**：
   - VPS 上部署 ntfy，放在 nginx 后面，开 HTTPS，`deny-all` 加访问令牌。
   - 手机安装 ntfy App（F-Droid 版或 GitHub 发布的 APK），订阅一个私有 topic，关掉电池优化，加入自启动白名单。
   - daemon 直接 `POST` 到 ntfy，用 `Actions:` 头加按钮。按钮只用 `view`（打开审批页的 URL），不用 `http`。
   - 这样就有了系统通知、优先级（1–5）和点击跳转。
2. **阶段 B（有了自己的 Android 壳以后）**：
   - 壳 App 接入 UnifiedPush connector，用 ntfy 作 distributor，把 endpoint 和密钥上报给 daemon。
   - daemon 用 Web Push 加密后推送；壳 App 收到后自己画通知，可以加按钮。按钮用 `setAuthenticationRequired(true)`，深链进 WebView，再配合 BiometricPrompt。
   - 这样 Android 也和 HarmonyOS 一样，走同一个“打开 App → 生物识别 → 签名”的审批流程。
3. 厂商通道（小米、荣耀、HMS）只在“必须去掉 ntfy 那条常驻通知”或“耗电不可接受”时才考虑，代价是每家都要注册和审核，OPPO 和 vivo 还要求上架。

---

## 6. 安全：能不能在通知里审批

### 6.1 平台能力对照

| 平台 / 渠道 | 通知按钮 | 按钮是否强制先解锁 | 生物识别 | 来源 |
|---|---|---|---|---|
| HarmonyOS Push Kit 通知 | **无** | — | 只能在 App 前台用系统认证控件；“**不允许三方应用在后台发起身份认证请求**” | https://developer.huawei.com/consumer/cn/doc/harmonyos-references/push-scenariozed-api-request-param ，https://developer.huawei.com/consumer/cn/doc/harmonyos-guides/user-authentication-overview |
| HarmonyOS 本地通知 | 有（WantAgent），但要求进程存活 | 文档没提解锁要求【未核实】 | 同上 | https://developer.huawei.com/consumer/cn/doc/harmonyos-guides/notification-with-wantagent |
| Android 原生通知 | 有（`addAction`、`RemoteInput` 快速回复） | **API 31+** 有 `Notification.Action.Builder#setAuthenticationRequired(true)`：“设备锁定时会显示锁屏，认证成功后才触发”。设为 false 时由系统决定 | `BiometricPrompt`，必须在前台 Activity；可绑定 Keystore 的 `setUserAuthenticationRequired` 和 `CryptoObject` | https://developer.android.com/reference/android/app/Notification.Action.Builder ，https://developer.android.com/identity/sign-in/biometric-auth |
| ntfy App | 有（view/http/broadcast/copy） | 源码中没有设置 | 无 | §5.4 |
| Telegram Bot | inline keyboard 加 callback_query | 取决于 Telegram 客户端的锁 | 无 | https://core.telegram.org/bots/api#inlinekeyboardmarkup ；国内需要代理才能访问【常识，未核实】 |

补充两点：
- Android 12+ 禁止“通知 trampoline”：点了通知或按钮后，不能在 BroadcastReceiver 或 Service 里再 `startActivity`，要直接用 Activity 的 PendingIntent（https://developer.android.com/about/versions/12/behavior-changes-12#notification-trampolines ）。
- HarmonyOS 的 HUKS 可以生成“必须经过用户身份认证才能使用”的密钥（锁屏口令、指纹、人脸的子集），失效条件可选“清除锁屏密码后失效”或“录入新生物特征后失效”（https://developer.huawei.com/consumer/cn/doc/harmonyos-guides/huks-identity-authentication-overview ）。认证用 `userAuth` 控件，带 `challenge`，可信等级可以要求 ATL3（https://developer.huawei.com/consumer/cn/doc/harmonyos-guides/start-authentication ）。生物识别需要声明 `ohos.permission.ACCESS_BIOMETRIC`（system_grant）（https://developer.huawei.com/consumer/cn/doc/harmonyos-guides/prerequisites ）。

### 6.2 风险判断

- “从通知按钮批准”的问题：
  - 锁屏状态下谁拿到手机都能点。
  - 通知只有一两行，看不到完整的动作参数，容易“批准了不该批的”（06 号文档 §2.5：批准必须绑定到规范化后的具体调用）。
  - `http` 类按钮直接打 daemon 的 API，就等于把一个能执行操作的令牌放进了通知。
- 06 号文档的类别模型里，花钱、以我名义发消息、删除、不可逆、隐私这几类恰恰是最需要审批的，也是最不该“一键”的。

### 6.3 建议的策略【设计建议】

1. **分级**：
   - L0 低风险：确认收到、稍后提醒、静音该任务、回答“是/否”这类不产生外部副作用的澄清。Android 上可以放在通知按钮里，并加 `setAuthenticationRequired(true)`；HarmonyOS 上做不到，只能点击打开 App。
   - L1 审批：06 号文档里的“必确认”类别。一律**打开 App → 看完整卡片 → 生物识别 → 设备密钥签名**。
2. **签名挑战**：
   - daemon 生成 `challenge = H(approvalId ‖ canonicalActionHash ‖ nonce ‖ expiry)`，一次性使用，有效期 5 分钟左右。
   - App 调用 `stepUpSign`：
     - HarmonyOS：`userAuth`（ATL3）加一把带用户认证访问控制的 HUKS 密钥签名。
     - Android：BiometricPrompt 加 `CryptoObject(Signature)`，Keystore 密钥设 `setUserAuthenticationRequired`。
   - daemon 用注册时上传的公钥验签，然后执行。
   - 这样即使 Web 的 session cookie 泄漏，也批不了任何审批。
3. **通知内容最小化**：锁屏上只显示“有 1 项待审批（任务：xxx）”，不显示金额、收件人等敏感参数，详情留在 App 里。HarmonyOS 服务提醒默认会出现在锁屏上（§1.5）。
4. **只认第一个答复**：审批状态以 daemon 为准。任何一个渠道答复后，其余渠道的通知都要撤回或覆盖（HarmonyOS 用 revoke API 或同一个 `notifyId` 覆盖；Android 用 cancel；ntfy 用 clear 或 delete）。不管谁晚到，都只返回“已处理”。
5. **审计**：每个审批记下渠道、设备、keyId、时间，写进 06 号文档里的 action ledger。

---

## 7. 对 ergo 的建议

### 7.1 NotificationService 抽象（daemon 内）【设计建议】

```ts
type Urgency = 'blocking' | 'normal' | 'low';
interface NotifyIntent {            // 业务层只产生“意图”，不关心渠道
  id: string;                        // 幂等键
  kind: 'approval_needed' | 'clarification' | 'task_done' | 'task_failed'
      | 'task_stuck' | 'digest' | 'security' | 'daemon_offline';
  urgency: Urgency;
  title: string; body: string;       // 已按隐私等级裁剪的文案
  route: string;                     // 前端路由，如 /approvals/ap_123
  subjectKey: string;                // 同一主题（同一任务/审批）复用一条通知
  actions?: Array<{ id: 'snooze' | 'open' | 'quick_reply'; risk: 'L0' }>; // 只允许 L0
  expiresAt?: number;                // 过期后撤回
}
interface Device { id: string; provider: 'harmony-push' | 'webpush' | 'ntfy' | 'telegram';
  address: string; keys?: unknown; publicKey?: string; label: string; lastSeen: number; stale?: boolean; }
interface PushProvider {
  readonly name: Device['provider'];
  send(d: Device, n: NotifyIntent, opts: { collapseId: number }): Promise<{ ok: boolean; retryable: boolean; invalidAddress?: boolean }>;
  revoke?(d: Device, collapseId: number): Promise<void>;
  quota(): { remainingToday?: number };
}
```

- **adapter**：
  - `HarmonyPushProvider`：缓存 JWT，调用 v3 send 和 v1 revoke。`subjectKey` 映射成稳定的 `notifyId`（31 位哈希）。可选接回执 webhook。
  - `WebPushProvider`：VAPID 加 RFC 8291，覆盖 UnifiedPush endpoint 和桌面浏览器。
  - `NtfyProvider`：纯 HTTP，加 `Priority`、`Actions`、`Click` 等头。
  - `TelegramProvider`：远期。
  - `InAppProvider`：当前在线页面的 SSE。
- **路由策略**：
  - 先看 InApp 有没有活跃会话。用户正在看页面时，非阻塞事件不推手机；阻塞事件仍然推，但在 HarmonyOS 上用 `foregroundShow:false`。
  - 然后推用户的主手机，再按需推其他设备。
  - **升级**：阻塞事件 N 分钟没被确认，就换一个渠道再推一次，或者用同一个 `notifyId` 加重提醒。不要发内容相同的新通知，那违反华为内容规范。
  - 与 06 号文档的“打扰预算 / bounded deferral”对接：低紧急度的事件合并成摘要。
- **outbox**：持久化，带指数退避重试。401（JWT 过期）时重签；503 时退避；地址失效就把设备标为 stale。
- **配额感知**：HarmonyOS 在调试期如果用 testMessage，每天 1000 条，按项目算；MARKETING 每天 2 条。每天的计数存下来，快用完时降级（合并成摘要，或者只走 InApp）。
- **daemon 掉线**：daemon 跑在 PC 上，PC 关机或隧道断开时没人能发通知。可以在 VPS 上放一个很小的 watchdog（检测心跳 → 通过 ntfy 或邮件告警）。HarmonyOS 那边要不要让 VPS 也持有华为服务账号密钥，是开放决策（§7.4）。
- **密钥存放**：华为服务账号 JSON、VAPID 私钥、ntfy token 都放进 daemon 的 secrets，不要放进前端。

### 7.2 事件 → 分类映射

| 事件 | 紧急度 | HarmonyOS（push-type 0 的 category） | Android 自有 App 的 channel / ntfy priority | 点击或按钮 |
|---|---|---|---|---|
| 待审批（阻塞） | blocking | `WORK` | `approvals`，IMPORTANCE_HIGH / ntfy 4–5 | 点击 → 审批页（需要 §6.3 的签名）。Android 按钮只放“稍后提醒” |
| 澄清问题（阻塞） | blocking 或 normal | `WORK`（“待处理的业务流程”）。不用 `IM`，有误分类风险 | `questions`，HIGH / 4 | 点击 → 问题页。Android 可以加 RemoteInput 快速回复（L0，回答本身不触发副作用） |
| 任务完成 | normal | `WORK` | `tasks`，DEFAULT / 3 | 点击 → 结果页 |
| 任务失败或卡住 | normal 偏高 | `WORK` | `tasks`，HIGH / 4 | 点击 → 任务详情 |
| 长程任务进度 | low | **不推送**（可选：实况窗 PROGRESS，仅限调测设备，§2） | 自有 App 可以用常驻进度通知；ntfy 不推 | — |
| 每日摘要 | low | 不推，或者用 `MARKETING`（静默，每天 2 条以内） | `digest`，LOW / 2 | 点击 → 摘要页 |
| 安全事件（新设备注册、设备密钥变更、连续拒绝） | blocking | `ACCOUNT` | `security`，HIGH / 5 | 点击 → 设备管理 |
| daemon 掉线 | blocking | 由 VPS watchdog 发（视决策而定） | ntfy 5 | — |

### 7.3 用户必须手动完成的最少步骤

**HarmonyOS（Push Kit）**：
1. 华为开发者账号完成**实名认证**，否则调试证书只有 14 天有效期。
2. 在 AGC 创建项目和 HarmonyOS 应用，bundleName 要和壳工程一致。在“增长 > 推送服务”里开通推送，数据处理位置选中国。
3. 签名，二选一：
   - 在 DevEco 里用“关联注册应用”的自动签名，并勾选 Push Kit。
   - 手动签名：申请调试证书，在 AGC 注册手机，开通推送后**重新**申请调试 Profile。
   - 无论哪种，都要**每年续签**一次。
4. 在 API Console 为该项目创建“服务账号密钥”，下载 JSON，交给 daemon 的 secrets。同时记下 `projectId`；如果要用撤回接口，再记下 `clientId`。
5. 在 AGC 申请通知消息自分类权益 **`WORK`**，可选再加 `ACCOUNT`。消息示例按真实场景写，例如“任务‘整理发票’有 1 项操作等待你确认，点击查看”。等待 3 个工作日。
6. 在手机上：首次启动时允许通知；到“设置 > 通知和状态栏 > 二狗”里手动打开**横幅通知**；确认铃声和锁屏的设置。
7. （可选）在 AGC 配置消息回执 URL（VPS，HTTPS，商用 CA 证书）。
8. （可选，实况窗）申请“实况窗服务权益”，再到“实况窗-调测设备管理”里按 Push Token 添加自己的手机。

**Android（阶段 A）**：
1. 在 VPS 部署 ntfy（Docker），放在 nginx 后面开 HTTPS。配置 `auth-default-access: deny-all`，建一个用户，给 daemon 发一个 token。
2. 手机安装 ntfy（F-Droid 或 GitHub APK），添加自建服务器并订阅私有 topic。
3. 在系统设置里关闭 ntfy 的电池优化，开启自启动或后台运行（各品牌入口不同）。

### 7.4 需要你拍板的开放决策

1. **HarmonyOS 的分类权益**：要不要申请 `WORK`（加 `ACCOUNT`）？如果被拒（未上架或者理由不够），能不能接受只有静默通知（MARKETING，每天 2 条，只在“更多通知”里）？还是改走 IM 机器人兜底（企业微信或飞书的按钮卡片）？
2. **testMessage**：分类权益批下来之前，是否长期用 `testMessage:true`（每天 1000 条、不受 2 条限制，但仍然静默）？还是只在调试时用？
3. **审批交互**：是否接受“HarmonyOS 上不能在通知里一键批准、必须打开 App 加生物识别”？Android 上是否允许 L0 动作（稍后提醒、快速回复澄清）放进通知按钮，L1 一律打开 App？
4. **设备密钥签名**：要不要从第一版就做 §6.3 的挑战签名？简化版是只要求“App 内生物识别 + session”，但安全性弱很多。
5. **Android 路线**：先做阶段 A（ntfy App），还是直接做阶段 B（自有壳 + UnifiedPush）？是否完全不碰厂商通道？
6. **ntfy 放在 VPS 上**：这等于多暴露一个公网服务。是否接受？要不要和 ergo 的 nginx 共用域名或证书？
7. **daemon 掉线告警**：要不要在 VPS 上做 watchdog？HarmonyOS 那边，要不要让 VPS 也持有华为服务账号私钥，以便 daemon 掉线时仍能推送？还是只用 ntfy 或邮件告警？
8. **实况窗**：值不值得花时间申请服务权益、走调测设备路线，只为在锁屏上看长程任务进度？
9. **夜间行为**：华为会在“预测的睡眠时间”缓存非 VoIP 消息。ergo 自己还要不要加免打扰时段和超时默认值（与 06 号文档“按紧急度设等待上限”对齐）？
10. **Telegram**：在国内需要 daemon 走代理才能访问 Bot API，还要不要列入计划？
11. **证书续签**：调试证书每年续一次，能否接受？还是考虑以后上架，或者走 AGC 的测试分发（这条路本次没调研）？

---

## 8. 未核实清单

- 个人开发者账号使用 Push Kit 有没有限制（没看到限制条款）。调试签名的 App 在真机上收推送，本次没有实测。
- 未上架的个人应用能否通过 `WORK` 和 `ACCOUNT` 自分类审核；单用户长期使用 `testMessage:true` 是否合规。
- “设备消息频控”对服务与通讯类消息的具体阈值（官方不公开）。
- 实况窗“服务权益”能否以 agent 任务、PROGRESS 的理由获批；调测设备是否能长期使用；Push 侧更新时是否校验 event 权益。
- 调试签名下声明 TASK_KEEPING（ACL 不强制校验）能否在手机上维持 WebSocket，以及会不会被系统挂起。
- 华为消息回执是否接受 Let's Encrypt 证书。
- HarmonyOS 本地通知按钮是否会强制先解锁。
- 荣耀、小米推送对未上架应用的开通条件；vivo 官方原文（目前引用的是腾讯云二手文档）。
- 统一推送联盟是否已有对开发者可用的统一接口。
- 企业微信、飞书机器人方案的可信 IP、可信域名要求，以及个人能否注册。
- Edge 和 Firefox 的 Web Push 在中国大陆能否连通。
- Telegram 在国内的可达性（常识判断，没做一手核实）。
