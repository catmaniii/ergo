# 鸿蒙 App 拿华为账号信息和运动健康数据：调研笔记

- 调研日期：2026-10-25。官方文档页的"更新时间"大多是 2026-10-19（HarmonyOS 6.x 文档）。
- 范围：HarmonyOS NEXT / 5.x 及以上、ArkTS 原生应用。结论都以 developer.huawei.com 的官方文档为准，每条附了出处。少数二手材料只当线索用，文中都标了"线索"。
- 二狗现状：bundle `com.example.ergou`，`compatibleSdkVersion` 和 `targetSdkVersion` 都是 `6.1.1(24)`。`module.json5` 只声明了 `INTERNET`、`MICROPHONE`，没有 `client_id` metadata。签名是 DevEco "Automatically generate signature" 生成的调试签名（`debugKey`，材料在 `~/.ohos/config/default_harmony_*`，签名材料本身没看）。原生桥 `ergoNative`（`entry/src/main/ets/bridge/NativeBridge.ets`，javaScriptProxy）已经在用，新能力可以照这个模式加。

---

## 0. 先看结论

| 问题 | 一句话结论 |
|---|---|
| 华为账号 | 个人开发者、不上架也能拿：**UnionID/OpenID、头像昵称、发票抬头**，不用申请权限。**手机号、收货地址、实名年龄段、一键登录**只给企业开发者（手机号、年龄段还只给游戏类）。**拿不到生日、性别、地区、实名信息**，文档里没有这些 scope。 |
| 运动健康 | 要在 AGC 申请 Health Service Kit，人工审核：测试权限约 10 个工作日，限 100 个用户；正式验证约 15 个工作日。**个人开发者的 App 必须先在华为应用市场上架**，而且只能申请"基础"等级的数据，也就是**日常活动（步数、热量、距离）和锻炼记录**。心率、睡眠、血氧、体重、血压等都是"高阶"，只给企业，且实缴注册资本不低于 500 万元、成立 1 年以上。没有免审核的"自用/白名单"模式。网页里不能直接调，只能原生 ArkTS 调。 |
| 其他来源 | **联系人 Picker**（不用任何权限，用户点选，返回的联系人对象里有生日、电话、地址字段）、**日历**、**位置**、**照片 Picker** 加 `MEDIA_LOCATION`，个人开发者都能用。批量读通讯录、批量读相册是受限权限（ACL），调试签名可以用，上架要审核，场景对不上会被驳回。 |
| 对二狗 | 现在就值得做的是**联系人 Picker → 档案候选 → 用户确认**，再加上日历和照片的时间地点。华为账号只拿得到昵称、头像，价值不大。运动健康这条路，个人身份走不通，要么上架后只拿步数和锻炼记录，要么等有企业主体。 |

---

## 1. 华为账号（Account Kit）

### 1.1 能拿到哪些信息

| 信息 | scope / 接口 | 要不要在 AGC 申请 | 谁能申请 | 出处 |
|---|---|---|---|---|
| OpenID、UnionID（用户标识） | `openid`（默认）；登录接口 `createLoginWithHuaweiIDRequest` 或"华为账号登录"按钮 | 不用（"此场景无需申请账号权限"） | 个人、企业都行 | [登录概述](https://developer.huawei.com/consumer/cn/doc/harmonyos-guides/account-quick-login-overview)、[静默登录](https://developer.huawei.com/consumer/cn/doc/harmonyos-guides/account-silent-login)、[华为账号登录按钮](https://developer.huawei.com/consumer/cn/doc/harmonyos-guides/account-unionid-login-button) |
| 头像、昵称 | `profile` | 不用 | 个人、企业都行 | [获取头像昵称](https://developer.huawei.com/consumer/cn/doc/harmonyos-guides/account-get-avatar-nickname) |
| 发票抬头 | `invoiceAssistant` 选择抬头接口 | 不用 | 文档没限制开发者类型 | [获取发票抬头](https://developer.huawei.com/consumer/cn/doc/harmonyos-guides/account-select-invoice-title) |
| 手机号（一键登录：手机号加 UnionID） | `quickLoginAnonymousPhone` 加 `openid` | 要申请"华为账号一键登录" | **仅企业**；非游戏、非银行类；必须是 HarmonyOS NEXT 应用 | [一键登录](https://developer.huawei.com/consumer/cn/doc/harmonyos-guides/account-phone-unionid-login)、[申请账号权限](https://developer.huawei.com/consumer/cn/doc/harmonyos-guides/account-config-permissions) |
| 手机号（单独获取） | `phone` | 要申请"获取您的手机号" | **仅企业，且仅游戏类** | [获取手机号](https://developer.huawei.com/consumer/cn/doc/harmonyos-guides/account-get-phonenumber)、[申请账号权限](https://developer.huawei.com/consumer/cn/doc/harmonyos-guides/account-config-permissions) |
| 收货地址（姓名、电话、地址） | `shippingAddress.chooseAddress` | 要申请"获取收货地址" | **仅企业**，应用类型不限 | [获取收货地址](https://developer.huawei.com/consumer/cn/doc/harmonyos-guides/account-choose-address-dev)、[申请账号权限](https://developer.huawei.com/consumer/cn/doc/harmonyos-guides/account-config-permissions) |
| 实名年龄段（只有年龄段，不是生日） | `realNameAgeRange` | 要申请"获取您的年龄段" | **仅企业，且仅游戏类** | [获取实名年龄段](https://developer.huawei.com/consumer/cn/doc/harmonyos-guides/account-get-realname-age)、[申请账号权限](https://developer.huawei.com/consumer/cn/doc/harmonyos-guides/account-config-permissions) |
| 风险等级 | `riskLevel` | 发邮件到 accountkit@huawei.com 申请，邮件要填"企业名称" | 实际上是企业 | [按需获取风险等级](https://developer.huawei.com/consumer/cn/doc/harmonyos-guides/account-get-risklevel-on-demand-acquisition) |
| 邮箱 | 返回结构里有 `email` 字段（"scopes 中包含 'email' 时返回"），但 scope 列表里没列 `email`，也没有申请入口 | — | 按现有文档拿不到，别指望 | [authentication API 参考](https://developer.huawei.com/consumer/cn/doc/harmonyos-references/account-api-authentication) |
| 生日、性别、地区、真实姓名、身份证 | 文档里**没有**这些 scope | — | 都拿不到 | [Account Kit 简介：能力范围](https://developer.huawei.com/consumer/cn/doc/harmonyos-guides/account-introduction)、[API 参考 scope 列表](https://developer.huawei.com/consumer/cn/doc/harmonyos-references/account-api-authentication) |

补充：

- 用户没设昵称时，`profile` 返回的是"华为账号绑定的匿名手机号/邮箱"。用户一换头像，旧头像链接马上失效，要先下载保存（[获取头像昵称](https://developer.huawei.com/consumer/cn/doc/harmonyos-guides/account-get-avatar-nickname)）。
- UnionID 是"同一开发者账号下"的用户标识，OpenID 是"本应用下"的标识（[登录概述](https://developer.huawei.com/consumer/cn/doc/harmonyos-guides/account-quick-login-overview)）。
- 一键登录只给中国境内用户（不含港澳台），用户还要同意《华为账号用户认证协议》（[一键登录](https://developer.huawei.com/consumer/cn/doc/harmonyos-guides/account-phone-unionid-login)）。

### 1.2 三种登录方式的条件

| 方式 | 拿到什么 | 条件 |
|---|---|---|
| 华为账号一键登录 | 手机号、UnionID、OpenID | 企业开发者，非游戏、非银行；在 AGC 申请"华为账号一键登录"，3 个工作日内出审核结果，通过后最迟 25 小时生效；自检表里有一条"是否上架应用市场，不上架需要说明原因"；按钮 UX 要符合规范，否则影响上架。出处：[申请账号权限](https://developer.huawei.com/consumer/cn/doc/harmonyos-guides/account-config-permissions)、[一键登录](https://developer.huawei.com/consumer/cn/doc/harmonyos-guides/account-phone-unionid-login) |
| 华为账号登录（按钮或自定义按钮） | UnionID、OpenID | 个人、企业都行，不用申请权限。出处：[登录按钮](https://developer.huawei.com/consumer/cn/doc/harmonyos-guides/account-unionid-login-button)、[登录概述](https://developer.huawei.com/consumer/cn/doc/harmonyos-guides/account-quick-login-overview) |
| 静默登录（`forceLogin = false`） | UnionID、OpenID | 个人、企业都行，不用申请权限；设备没登华为账号时返回 1001502001。出处：[静默登录](https://developer.huawei.com/consumer/cn/doc/harmonyos-guides/account-silent-login) |

### 1.3 共同前提：AGC 应用、Client ID、签名、bundle 名

1. **要在 AGC 建一个 HarmonyOS 应用**，包名和工程的 bundleName 一致。Client ID 从"常规 > 应用"里拿；**如果 Client ID 和 APP ID 相同，就不用配**，不同就在 entry 的 `module.json5` 里加 `metadata: [{ name: "client_id", value: "..." }]`（[配置 Client ID](https://developer.huawei.com/consumer/cn/doc/harmonyos-guides/account-client-id)）。
2. **签名和指纹**：设备系统是 HarmonyOS 6.0.0(20) 及以上时，"所有接口均支持使用自动签名"；"`compatibleSdkVersion>=20` 不需要配置公钥指纹"（[配置签名和指纹](https://developer.huawei.com/consumer/cn/doc/harmonyos-guides/account-sign-fingerprints)）。二狗的 `compatibleSdkVersion` 是 24，**不用配指纹，自动签名就行**。签名不对会报 1001500001（[FAQ 1001500001](https://developer.huawei.com/consumer/cn/doc/harmonyos-guides/account-faq-1)）。
3. **自动签名有两种**（[自动签名](https://developer.huawei.com/consumer/cn/doc/harmonyos-guides/ide-signing-auto)）：
   - "关联注册应用"：勾选 "Associate with registered application"。DevEco 按 bundleName 去 AGC 找同包名的应用，可以直接在 DevEco 里开通开放能力，**Account Kit 默认开启**。需要 DevEco 6.0.0 Beta5 及以上。
   - "未关联注册应用"：只勾 "Automatically generate signature"，二狗现在用的就是这种（见 `docs/developer-guide.md` 的"鸿蒙 App"一节的"签名"）。文档没说这种签名能不能用 Account Kit。**推断**：Client ID 要对上 AGC 里的应用，所以要换成"关联注册应用"那种，需要用户本人登录 DevEco/AGC 操作。AGC 里没有同包名的应用时，DevEco 会提示 "Bundle name … does not exist"，可以直接点 "Add App ID" 现建（[配置调试签名异常 FAQ](https://developer.huawei.com/consumer/cn/doc/harmonyos-faqs/faqs-signature-service-18)）。
4. **上架**：基础登录和头像昵称都**不要求上架**。要求上架（或说明不上架原因）的只有一键登录、手机号、收货地址、年龄段这几项需要申请的权限（[申请账号权限](https://developer.huawei.com/consumer/cn/doc/harmonyos-guides/account-config-permissions)）。
5. **`com.example.*` 能不能用**：AGC 包名规范只禁止把 `oh`、`ohos`、`harmony`、`harmonyos`、`openharmony`、`system` 当独立段用，并要求全局唯一、至少三段、长度 7–128（[创建 HarmonyOS 应用](https://developer.huawei.com/consumer/cn/doc/app/agc-help-create-app-0000002247955506)）。**文档没有禁止 `example`**，所以 `com.example.ergou` 只要没被别人占就能建。但**包名在 AGC 建好后不能改**，`example` 又是占位名，要不要先换成正式包名、再去 AGC 注册，请用户先定。换包名要重新自动签名，手机上的 App 也要卸载重装（数据会清掉）。
6. **服务端换取**：头像昵称和 UnionID/OpenID 在端上的响应里直接有（`avatarUri`、`nickName`、`openID`、`unionID`，见 [API 参考](https://developer.huawei.com/consumer/cn/doc/harmonyos-references/account-api-authentication)）。手机号、年龄段这类要先拿 Authorization Code，再由"应用服务端"用 Client ID 加 **Client Secret** 换 Access Token 后去查。Access Token 有效 60 分钟，Refresh Token 有效 180 天（[获取实名年龄段](https://developer.huawei.com/consumer/cn/doc/harmonyos-guides/account-get-realname-age)、[静默登录：服务端开发](https://developer.huawei.com/consumer/cn/doc/harmonyos-guides/account-silent-login)）。
7. **取消授权**：有 `createCancelAuthorizationRequest`（[API 参考](https://developer.huawei.com/consumer/cn/doc/harmonyos-references/account-api-authentication)）。用户也能在"设置 > 华为账号 > 账号安全 > 使用华为账号的应用"里取消（[运动健康：申请验证](https://developer.huawei.com/consumer/cn/doc/harmonyos-guides/health-verification)里提到的路径）。拿到的数据要由开发者自己提供删除、导出等数据主体权利（[Account Kit 个人数据处理说明](https://developer.huawei.com/consumer/cn/doc/harmonyos-guides/account-personal-data-processing-description)）。

---

## 2. 运动健康（Health Service Kit）

### 2.1 能读写哪些数据

Health Service Kit 是"基于华为账号和用户授权的运动健康数据开放平台"。Phone、Tablet 只在中国境内（不含港澳台）可用（[简介](https://developer.huawei.com/consumer/cn/doc/harmonyos-guides/health-service-kit-ability)）。

| 数据 | 内容 | 开放等级 | 及时性 | 读 | 写 | 读权限名（申请卡片上的名字） |
|---|---|---|---|---|---|---|
| 日常活动 | 步数、热量、距离等 | **基础** | 小时级 | Y | Y | 日常活动数据（读） |
| 锻炼记录 | 跑步、骑行、健走、跳绳、游泳等 | **基础** | 分钟级 | Y | Y | 锻炼记录概要 / 详情 / 位置详情（读） |
| 心率 | 动态、静息、心率变异性 | 高阶 | 小时级 | Y | Y | 心率数据（读） |
| 血氧 | 瞬时血氧饱和度 | 高阶 | 小时级 | Y | Y | 血氧数据（读） |
| 压力 | 压力得分 | 高阶 | 小时级 | Y | Y | 压力数据（读） |
| 体温 | 体温、皮肤体温 | 高阶 | 分钟级 | Y | Y | 体温数据（读） |
| 血压 | 收缩压、舒张压、脉搏 | 高阶 | 分钟级 | Y | Y | 血压数据（读） |
| 体重 / 身高 | 体重、体脂、BMI / 身高 | 高阶 | 分钟级 | Y | Y | 体脂数据（读） |
| 情绪 | 情绪数据 | 高阶 | 小时级 | Y | Y | 情绪数据（读） |
| 睡眠 | 睡眠分期、睡眠记录、午睡 | 高阶 | 分钟级 | Y | Y | 睡眠数据（读） |
| 生理周期 | 经量、痛经、心情等 | 高阶 | 小时级 | Y | **N** | — |

- 出处：[数据开放总览](https://developer.huawei.com/consumer/cn/doc/harmonyos-guides/health-data-overview)、[权限说明](https://developer.huawei.com/consumer/cn/doc/harmonyos-guides/health-permission-description)。
- 开放等级在官方页上是用图标标的，没有文字。图标和行的对应是按页面 HTML 里的图片顺序整理出来的：第一个图标的说明是"高阶，暂不对个人开发者开放"，第二个是"基础，个人及企业均可申请"。
- 另外两个能力：
  - 实时三环（`healthService.workout.readActivityReport`），给实时步数、活动热量、锻炼时长，用"日常活动（读）"权限（[实时三环](https://developer.huawei.com/consumer/cn/doc/harmonyos-guides/health-three-ring-read)）。
  - 手动数据同步（`syncAll`），scope `.../huaweihealthdata.cloudsync`，"该权限仅企业开发者账号可见"（[手动数据同步](https://developer.huawei.com/consumer/cn/doc/harmonyos-guides/health-cloudsync)）。
- 儿童相关数据不开放（[接入流程](https://developer.huawei.com/consumer/cn/doc/harmonyos-guides/health-application-access)）。

### 2.2 谁能申请

| 身份 | 条件 | 出处 |
|---|---|---|
| 个人开发者 | ① **App 必须已上架华为应用市场**，"未上架…暂不开放"，非移动应用也不行；② 只能申请"基础"数据；③ 没有个人信用不良记录；④ 申请材料要填"开发者信息"，并写明"个人所在科研机构或大学等" | [申请资质说明](https://developer.huawei.com/consumer/cn/doc/harmonyos-guides/health-application-qualifications)、[申请运动健康服务：驳回常见问题](https://developer.huawei.com/consumer/cn/doc/harmonyos-guides/health-apply) |
| 企业 | 申请"基础"数据：实缴注册资本不低于 50 万元；申请"高阶"数据：不低于 500 万元；都要求存续、成立 1 年以上（以国家企业信用信息公示系统最新年报为准） | 同上 |
| 事业单位 / 政府机构 | 免资金和年限要求 | 同上 |
| 资质不够 | 找一家符合资质的公司当保证人，出《担保函》、公司章程、股东会决议等，发到 hihealth@huawei.com | [申请运动健康服务](https://developer.huawei.com/consumer/cn/doc/harmonyos-guides/health-apply) |
| 团队成员账号 | "暂不支持团队账号下的成员账号独立使用" | 同上 |

### 2.3 申请流程和时长

1. 实名认证成为开发者，在 AGC 建 HarmonyOS 应用（[接入流程](https://developer.huawei.com/consumer/cn/doc/harmonyos-guides/health-application-access)）。
2. AGC → 开发与服务 → 项目 → 应用 → 项目设置 → 开放能力管理 → 运动健康服务 → 申请。产品类型选"HarmonyOS 应用"，按"最小化原则"勾选数据权限，按材料清单（Excel 模板）写清每一项读写权限的用途。
3. **测试权限**：人工审核"约 10 个工作日"，结果用短信和邮件通知。通过后马上生效，但"仅前 100 位用户"能用，而且**要在一年内完成验证**，否则测试权限会被关掉（[申请运动健康服务](https://developer.huawei.com/consumer/cn/doc/harmonyos-guides/health-apply)）。
4. **申请验证（正式权限）**：上架前提交举证视频（隐私政策、授权页、取消授权、授权不足时的提示、数据和华为运动健康 App 的一致性对比等）和自检 CheckList。专家组评审"约 15 个工作日"，通过后 24 小时生效，解除 100 用户的限制（[申请验证获取正式权限](https://developer.huawei.com/consumer/cn/doc/harmonyos-guides/health-verification)）。
5. 上线后华为会不定期抽查权限使用情况（[申请运动健康服务](https://developer.huawei.com/consumer/cn/doc/harmonyos-guides/health-apply)）。
6. 工程侧还要配两样：`client_id` metadata（[配置 Client ID](https://developer.huawei.com/consumer/cn/doc/harmonyos-guides/health-configuration-client-id)），以及 `querySchemes` 里的 `huaweischeme`（用来拉起运动健康 App）。
7. DevEco 自动签名能顺手开通的开放能力清单里**没有** Health Service Kit（[自动签名：支持的开放能力](https://developer.huawei.com/consumer/cn/doc/harmonyos-guides/ide-signing-auto)），只能在 AGC 网页上申请。
8. 关于"仅自用 / 测试"模式：**没有免审核通道**。所谓"测试阶段"，也是审核通过之后的、限 100 用户的阶段。个人开发者连这个阶段都要以"已上架"为前提。AGC 的"邀请测试"这类分发方式算不算"上架"，文档没写，要问 hihealth@huawei.com。

### 2.4 用户授权怎么弹

1. **先过运动健康 App 的隐私同意**：用户从没打开过华为运动健康 App 时，接口返回 1002703001。这时用 `canOpenLink('huaweischeme://healthapp/home/main')` 判断装没装：装了就 `openLink` 拉起来让用户同意；没装就用应用市场推荐接口引导下载 `com.huawei.hmos.health`（[拉起运动健康 App 隐私授权](https://developer.huawei.com/consumer/cn/doc/harmonyos-guides/health-privacy-authorization)、[错误码](https://developer.huawei.com/consumer/cn/doc/harmonyos-references/errorcode-healthservice)）。
2. **`healthStore.init(context)` 初始化**，然后 `healthStore.requestAuthorizations(UIAbilityContext, { readDataTypes, writeDataTypes, scopes })`，会拉起**华为账号登录和授权页**。用户可以只勾一部分。最后实际可用的权限 =（AGC 审批通过的）∩（用户勾选的）。另有 `getAuthorizations` 查询当前权限、`cancelAuthorizations` 取消全部授权（[管理用户授权](https://developer.huawei.com/consumer/cn/doc/harmonyos-guides/health-add-permissions)、[healthStore API](https://developer.huawei.com/consumer/cn/doc/harmonyos-references/health-api-healthstore)）。
3. 验证时的硬要求：要有取消授权入口；不能"全授权才让用"；授权不足要提示，或引导用户重新授权（[申请验证](https://developer.huawei.com/consumer/cn/doc/harmonyos-guides/health-verification)）。

### 2.5 后台读、历史数据、频率限制

| 问题 | 文档怎么说 | 出处 |
|---|---|---|
| 读法 | `readData`（按类型和时间段，`count` 不填就不限条数）、`aggregateData`（max/min/avg/sum/last/count 聚合）。读今天的日常活动有延迟，建议改用实时三环接口 | [运动健康采样数据](https://developer.huawei.com/consumer/cn/doc/harmonyos-guides/health-samplepoint-manage)、[healthStore API](https://developer.huawei.com/consumer/cn/doc/harmonyos-references/health-api-healthstore) |
| 历史数据 | **HarmonyOS 版文档没写**历史窗口。HMS Core 版（Android/云侧）Health Kit 的规则是：默认只能查授权之后的数据，授权前的要另外申请"读取历史数据"（一周/一月/一年，最多一年）。HarmonyOS 版是不是一样，**要真机验证** | [HMS Core：读取历史数据](https://developer.huawei.com/consumer/cn/doc/HMSCore-Guides/historydata-open-0000001209921350) |
| 数据及时性 | 依赖使用方式：穿戴设备没连手机蓝牙、运动健康 App 没设后台保活时，及时性没保证 | [数据开放总览](https://developer.huawei.com/consumer/cn/doc/harmonyos-guides/health-data-overview) |
| 数据存在哪 | 运动健康服务的本地数据库，再端云同步到云侧 | [个人数据处理说明](https://developer.huawei.com/consumer/cn/doc/harmonyos-guides/health-personal-data-processing) |
| 频率限制 | 文档和错误码里**都没写**调用频率限制。错误码里只有"测试用户数已达上限" | [错误码](https://developer.huawei.com/consumer/cn/doc/harmonyos-references/errorcode-healthservice) |
| 后台读 | Health 文档**没写**。系统层面，应用退到后台后如果没有规范内的后台任务，进程会被挂起或终止；可用的有短时任务、长时任务、延迟任务。`init` 接收普通 `Context`，`requestAuthorizations` 必须用 UIAbilityContext。**推断**：授权只能在前台做；后台读可以试延迟任务（WorkScheduler），要真机验证 | [Background Tasks Kit 简介](https://developer.huawei.com/consumer/cn/doc/harmonyos-guides/background-task-overview)、[healthStore API](https://developer.huawei.com/consumer/cn/doc/harmonyos-references/health-api-healthstore) |

### 2.6 能不能在 ArkWeb 网页里调

- Health Service Kit 只有 ArkTS 的 `@kit.HealthServiceKit`（`healthStore`、`healthService`），没有网页 / JS SDK（[healthStore API](https://developer.huawei.com/consumer/cn/doc/harmonyos-references/health-api-healthstore)）。**只能原生调，再经原生桥交给网页。**
- Account Kit 也一样。官方给 H5 框架的示例工程是用 ArkWeb 同层渲染，把原生登录按钮嵌进网页，ArkTS 和网页之间走数据通道（[三方开发框架接入 FAQ](https://developer.huawei.com/consumer/cn/doc/harmonyos-guides/account-faq-18)、[H5 示例工程](https://gitcode.com/HarmonyOS_Samples/accountkit-samplecode-clientdemo-h5)）。二狗现在的 `ergoNative`（javaScriptProxy，方法回 `Promise<string>`）正好是这种做法（官方：[前端页面调用应用侧函数](https://developer.huawei.com/consumer/cn/doc/harmonyos-guides/web-in-page-app-function-invoking)）。

### 2.7 不走 Health Service Kit 的替代办法

- **计步传感器**：`sensor` 的 `PEDOMETER` 要 `ohos.permission.ACTIVITY_MOTION`（normal，弹窗授权），所有应用都能申请。但它只是 App 订阅期间的实时步数流，没有历史数据（[传感器开发概述](https://developer.huawei.com/consumer/cn/doc/harmonyos-guides/sensor-overview)、[开放权限（用户授权）](https://developer.huawei.com/consumer/cn/doc/harmonyos-guides/permissions-for-all-user)）。心率传感器要 `READ_HEALTH_DATA`，主要在穿戴设备上有。
- **用户自己导出数据副本**（线索）：华为官方支持页说，登录华为账号 → 隐私中心 → Request Your Data 可以申请数据副本，功能因地区而异（[官方支持页（英文）](https://consumer.huawei.com/en/support/content/en-us00746223/)）。至于运动健康数据能导出成 JSON、含心率/睡眠/GPS、各步要等约 7 天，都来自第三方材料（[B 站教程](https://www.bilibili.com/opus/765409652516061189)、[GitHub 讨论](https://github.com/aricooperdavis/Huawei-TCX-Converter/issues/19)），**没有官方核实**。如果可行，二狗可以做"导入数据副本文件"，完全绕开审批。

---

## 3. 其他可能有用的个人信息来源

| 来源 | 不用权限的做法 | 权限名 | 授权方式 | 是不是受限（ACL） | 个人开发者能不能用 | 出处 |
|---|---|---|---|---|---|---|
| 通讯录 | **`contact.selectContacts()` 联系人 Picker**："接口本身无需申请权限"。返回 `Contact[]`，字段里有 `events`（生日 `EVENT_BIRTHDAY`、纪念日）、`phoneNumbers`、`postalAddresses` 等 | 批量读写：`READ_CONTACTS` / `WRITE_CONTACTS` | user_grant | **是**。场景只限"克隆、备份或同步联系人"，上架审核约 3 个工作日 | Picker 能用；ACL 调试可用，上架大概率被驳回 | [Contacts Kit 简介](https://developer.huawei.com/consumer/cn/doc/harmonyos-guides/contacts-intro)、[@ohos.contact](https://developer.huawei.com/consumer/cn/doc/harmonyos-references/js-apis-contact)、[受限开放权限](https://developer.huawei.com/consumer/cn/doc/harmonyos-guides/restricted-permissions) |
| 日历 | — | `READ_CALENDAR` / `WRITE_CALENDAR`：只能读写系统默认账户和本应用账户下、**本应用建的**日程 | user_grant（normal） | 否 | 能 | [Calendar Kit 简介](https://developer.huawei.com/consumer/cn/doc/harmonyos-guides/calendarmanager-overview)、[开放权限（用户授权）](https://developer.huawei.com/consumer/cn/doc/harmonyos-guides/permissions-for-all-user) |
| 日历（读所有应用的日程） | — | `READ_WHOLE_CALENDAR` / `WRITE_WHOLE_CALENDAR` | user_grant | **是**，但写的是"申请后立即通过"；API 20 起面向普通应用开放 | 能 | [受限开放权限](https://developer.huawei.com/consumer/cn/doc/harmonyos-guides/restricted-permissions) |
| 位置 | — | `APPROXIMATELY_LOCATION`（约 5 公里）；精确位置要同时申请 `LOCATION`；后台用 `LOCATION_IN_BACKGROUND`（用户要去设置里手动给），或者申请 LOCATION 类型的长时任务 | user_grant（normal） | 否 | 能 | [申请位置权限](https://developer.huawei.com/consumer/cn/doc/harmonyos-guides/location-permission-guidelines)、[开放权限（用户授权）](https://developer.huawei.com/consumer/cn/doc/harmonyos-guides/permissions-for-all-user) |
| 照片的时间和地点 | **PhotoViewPicker**，不用权限，用户选图 | EXIF 里的位置默认被去掉，要 `MEDIA_LOCATION`（normal，弹窗）才拿得到；批量读图库要 `READ_IMAGEVIDEO` | user_grant | `READ_IMAGEVIDEO` **是**（场景：克隆备份、相册整理、智能生成视频）；API 26 起只能读本地公共目录 | Picker 加 `MEDIA_LOCATION` 能用；批量读同通讯录的情况 | [使用 Picker 选择媒体库资源](https://developer.huawei.com/consumer/cn/doc/harmonyos-guides/photoaccesshelper-photoviewpicker)、[受限开放权限](https://developer.huawei.com/consumer/cn/doc/harmonyos-guides/restricted-permissions) |

**调试签名下的受限权限**，对"只装自己手机"很关键：

- 正式流程是：没申请到权限证书就在配置里声明受限权限，"将会导致应用安装失败"。但"在调试阶段……可以通过 DevEco Studio 自动签名完成申请……开发者可直接使用"（[申请受限权限](https://developer.huawei.com/consumer/cn/doc/harmonyos-guides/declare-permissions-in-acl)）。
- 未关联注册应用的自动签名"不会强制校验配置文件中添加的 ACL 权限"。关联注册应用的自动签名在审批完成前会先发一个"有效期较短的临时 Profile"（[自动签名](https://developer.huawei.com/consumer/cn/doc/harmonyos-guides/ide-signing-auto)）。
- `READ_CONTACTS`、`READ_IMAGEVIDEO` 都在自动签名支持的 ACL 清单里。
- 结论：**自用调试包按文档能用批量读通讯录和相册**，但上架时要按场景审核。建议先真机装一次确认。

---

## 4. 对二狗的建议

### 4.1 现在就能做（个人开发者、不上架、只装自己手机）

| 优先级 | 做什么 | 要用户做的 | 价值 |
|---|---|---|---|
| 1 | **联系人 Picker → 档案候选**：用户在二狗里点"从通讯录选人"，原生调 `selectContacts`，把姓名、电话、生日、地址交给守护进程，生成"待确认"的档案条目，用户确认后才写 | 无（不用权限、不用 AGC） | 高：直接对上个人档案里家人的生日、电话、住址 |
| 2 | **日历**：读系统日历里的生日、纪念日、日程（`READ_WHOLE_CALENDAR`，"申请后立即通过"），作为素材或档案候选 | 弹窗同意；ACL 走自动签名 | 中到高 |
| 3 | **照片的时间地点**：PhotoViewPicker 加 `MEDIA_LOCATION`，用户选的照片给出"什么时候、在哪"，作为记忆素材 | 弹窗同意 | 中 |
| 4 | **位置**（前台）：作为记忆素材的地点线索 | 弹窗同意 | 中 |
| 5 | **华为账号头像昵称 / UnionID**：只能拿到"本人"的昵称和头像，可以作为档案里本人的头像 | 用户登录 DevEco/AGC 建应用，改成"关联注册应用"的自动签名；先定包名要不要从 `com.example` 换掉 | 低 |
| 6 | 步数：计步传感器（`ACTIVITY_MOTION`）只有实时、没有历史；或者先验证"隐私中心导出数据副本"能不能拿到运动健康数据，能的话做"导入文件" | 弹窗；用户自己去导出 | 低到中 |
| 可选 | 自用调试包用 `READ_CONTACTS` 批量读通讯录（做"通讯录里谁的生日快到了"之类） | 走自动签名；不能指望上架 | 中，但只限自用 |

### 4.2 要先满足条件的

| 想要的 | 条件 |
|---|---|
| 账号手机号 / 一键登录 / 收货地址 / 实名年龄段 | 企业开发者（手机号、年龄段还要求是游戏类），AGC 申请加审核。对二狗基本用不上：手机号、地址可以从联系人 Picker 拿，也可以让用户自己填 |
| 运动健康：步数、锻炼记录（基础） | 个人：**先把二狗上架华为应用市场**（APP 备案、隐私政策、生成式 AI 类应用的标识/实名/投诉入口等要求，见下），再申请测试权限（约 10 个工作日，100 用户），一年内申请验证（约 15 个工作日）。企业：实缴不低于 50 万元、成立 1 年以上 |
| 运动健康：心率、睡眠、体重、血压、血氧、压力、体温（高阶） | 只有企业：实缴不低于 500 万元、成立 1 年以上，或找符合资质的公司出担保函；事业单位、政府机构免 |
| 上架本身 | APP 未核准（备案）是常见驳回原因（[应用审核指南](https://developer.huawei.com/consumer/cn/doc/app/50104)、[应用资质审核要求](https://developer.huawei.com/consumer/cn/doc/app/80301)）。含生成式 AI 的应用要给生成内容加显式和隐式标识、提供标识材料、有投诉举报入口、做真实身份认证（[应用审核指南 第 17 条](https://developer.huawei.com/consumer/cn/doc/app/50104)）。医疗保健这类严格管控的应用"不能由个人开发者提交"（同上 11.4） |

### 4.3 推荐接法

```
用户在二狗网页点"从通讯录 / 日历 / 运动健康导入"
  → window.ergoNative.<新方法>()            （NativeBridge.ets，开头先过 allowed()，回 Promise<string>）
  → ArkTS 原生模块就地申请权限或拉起 Picker、读取，只取需要的字段
  → 交回网页，网页 POST 给守护进程（或原生用 ServerAddress 直接 POST）
  → 守护进程放进"待确认"（标上来源：contacts/calendar/health、读取时间）
  → 用户在档案页逐条确认 → 才写进个人档案或记忆素材
```

- 和现有原生桥一致：新方法放进 `NATIVE_BRIDGE_METHODS`，网页按方法在不在判断新旧 App，旧 App 上相关按钮灰掉。
- **就地申请权限**：照 `MICROPHONE` 那样在 `module.json5` 写 `reason` 和 `usedScene`，用到时再弹窗。不在启动时一股脑申请。
- **Account Kit 不要把 Client Secret 放手机上**。头像昵称、UnionID 端上直接就有，用不到 Secret。以后真要服务端换取，Secret 归守护进程保管，按二狗现有的密钥规矩放。
- **运动健康以后要接的话**：只存每天的聚合值（步数、睡眠时长等），不存原始采样。存的时候带上来源和时间窗。提供"断开并删除"：调 `cancelAuthorizations` 加删除守护进程里的素材。
- 插件化范围：按 `plugin-scope` 的约定，日历是插件、记忆是插件。日历导入归日历插件；"生活来源"进记忆插件的素材。联系人导入进档案属于内核还是插件，请用户定。

### 4.4 隐私和合规要注意的

- **法律**：《个人信息保护法》第 28 条把医疗健康、行踪轨迹列为敏感个人信息；第 29 条规定处理敏感个人信息要取得"单独同意"；第 72 条规定"自然人因个人或者家庭事务处理个人信息的，不适用本法"（[网信办刊载全文](https://www.cac.gov.cn/2021-08/20/c_1631050028355286.htm)）。二狗只给自己和家人用，大体落在家庭事务里；一旦分发或上架，就要按完整要求做隐私政策、单独同意、撤回渠道。
- **华为平台规则**：健康数据、行踪轨迹等"不得用于服务改进、投放广告或营销等非业务核心功能"（[应用审核指南 7.16](https://developer.huawei.com/consumer/cn/doc/app/50104)）。运动健康验证要求有取消授权、授权不足的提示、隐私政策视频，文案用"华为运动健康"（[申请验证](https://developer.huawei.com/consumer/cn/doc/harmonyos-guides/health-verification)）。账号数据的删除、导出由开发者自己负责（[Account Kit 个人数据处理说明](https://developer.huawei.com/consumer/cn/doc/harmonyos-guides/account-personal-data-processing-description)）。
- **最小化**：联系人只取姓名、电话、生日、地址；照片只取时间和地点，不传原图；运动只存聚合值。
- **家人的数据**是第三方的个人信息：维持现在"用户确认后才写"的做法，并且能一键删掉某个人的全部档案。
- **撤回**：系统权限可以在设置里撤；华为账号可以在"设置 > 华为账号 > 使用华为账号的应用"里撤；运动健康可以在"运动健康 App > 我的 > 隐私管理 > 数据分享与授权"里撤（[申请验证](https://developer.huawei.com/consumer/cn/doc/harmonyos-guides/health-verification)）。二狗这边也要能"断开并删数据"。

---

## 5. 文档没写清、要真机或问官方确认的

1. 二狗现在的"未关联注册应用"自动签名能不能调 Account Kit。推断要改成"关联注册应用"。
2. 联系人 Picker 返回的 `Contact` 里实际带不带 `events`（生日）、`postalAddresses`。类型定义里有这些字段，Picker 返回哪些没写。
3. `READ_CONTACTS`、`READ_WHOLE_CALENDAR` 在当前自动签名方式下能不能装上、能不能读。
4. HarmonyOS 版 Health Service Kit 能读到授权前多久的数据，能不能在延迟任务（后台）里读。
5. 个人开发者的"已上架"，用 AGC 邀请测试之类的方式行不行。要问 hihealth@huawei.com。
6. "隐私中心导出数据副本"现在还能不能导出运动健康数据，是什么格式。目前只有线索。
7. Account Kit 的 `email` 字段有没有对应 scope。

## 6. 出处清单（官方）

- Account Kit：[简介](https://developer.huawei.com/consumer/cn/doc/harmonyos-guides/account-introduction) · [登录概述](https://developer.huawei.com/consumer/cn/doc/harmonyos-guides/account-quick-login-overview) · [一键登录](https://developer.huawei.com/consumer/cn/doc/harmonyos-guides/account-phone-unionid-login) · [登录按钮](https://developer.huawei.com/consumer/cn/doc/harmonyos-guides/account-unionid-login-button) · [静默登录](https://developer.huawei.com/consumer/cn/doc/harmonyos-guides/account-silent-login) · [获取用户信息概述](https://developer.huawei.com/consumer/cn/doc/harmonyos-guides/account-get-user-info-overview) · [头像昵称](https://developer.huawei.com/consumer/cn/doc/harmonyos-guides/account-get-avatar-nickname) · [手机号](https://developer.huawei.com/consumer/cn/doc/harmonyos-guides/account-get-phonenumber) · [收货地址](https://developer.huawei.com/consumer/cn/doc/harmonyos-guides/account-choose-address-dev) · [发票抬头](https://developer.huawei.com/consumer/cn/doc/harmonyos-guides/account-select-invoice-title) · [实名年龄段](https://developer.huawei.com/consumer/cn/doc/harmonyos-guides/account-get-realname-age) · [风险等级](https://developer.huawei.com/consumer/cn/doc/harmonyos-guides/account-get-risklevel-on-demand-acquisition) · [申请账号权限](https://developer.huawei.com/consumer/cn/doc/harmonyos-guides/account-config-permissions) · [配置签名和指纹](https://developer.huawei.com/consumer/cn/doc/harmonyos-guides/account-sign-fingerprints) · [配置 Client ID](https://developer.huawei.com/consumer/cn/doc/harmonyos-guides/account-client-id) · [FAQ 1001500001](https://developer.huawei.com/consumer/cn/doc/harmonyos-guides/account-faq-1) · [FAQ 1001502014](https://developer.huawei.com/consumer/cn/doc/harmonyos-guides/account-faq-2) · [三方框架 FAQ](https://developer.huawei.com/consumer/cn/doc/harmonyos-guides/account-faq-18) · [登录管理细则](https://developer.huawei.com/consumer/cn/doc/harmonyos-guides/account-detailedrules) · [个人数据处理说明](https://developer.huawei.com/consumer/cn/doc/harmonyos-guides/account-personal-data-processing-description) · [authentication API](https://developer.huawei.com/consumer/cn/doc/harmonyos-references/account-api-authentication)
- Health Service Kit：[简介](https://developer.huawei.com/consumer/cn/doc/harmonyos-guides/health-service-kit-ability) · [接入流程](https://developer.huawei.com/consumer/cn/doc/harmonyos-guides/health-application-access) · [申请资质说明](https://developer.huawei.com/consumer/cn/doc/harmonyos-guides/health-application-qualifications) · [数据开放总览](https://developer.huawei.com/consumer/cn/doc/harmonyos-guides/health-data-overview) · [申请运动健康服务](https://developer.huawei.com/consumer/cn/doc/harmonyos-guides/health-apply) · [配置 Client ID](https://developer.huawei.com/consumer/cn/doc/harmonyos-guides/health-configuration-client-id) · [拉起隐私授权](https://developer.huawei.com/consumer/cn/doc/harmonyos-guides/health-privacy-authorization) · [管理用户授权](https://developer.huawei.com/consumer/cn/doc/harmonyos-guides/health-add-permissions) · [采样数据](https://developer.huawei.com/consumer/cn/doc/harmonyos-guides/health-samplepoint-manage) · [实时三环](https://developer.huawei.com/consumer/cn/doc/harmonyos-guides/health-three-ring-read) · [手动同步](https://developer.huawei.com/consumer/cn/doc/harmonyos-guides/health-cloudsync) · [权限说明](https://developer.huawei.com/consumer/cn/doc/harmonyos-guides/health-permission-description) · [申请验证](https://developer.huawei.com/consumer/cn/doc/harmonyos-guides/health-verification) · [FAQ](https://developer.huawei.com/consumer/cn/doc/harmonyos-guides/health-faqs) · [个人数据处理说明](https://developer.huawei.com/consumer/cn/doc/harmonyos-guides/health-personal-data-processing) · [healthStore API](https://developer.huawei.com/consumer/cn/doc/harmonyos-references/health-api-healthstore) · [错误码](https://developer.huawei.com/consumer/cn/doc/harmonyos-references/errorcode-healthservice) · [HMS Core 读取历史数据（对照）](https://developer.huawei.com/consumer/cn/doc/HMSCore-Guides/historydata-open-0000001209921350)
- 权限和签名：[开放权限（用户授权）](https://developer.huawei.com/consumer/cn/doc/harmonyos-guides/permissions-for-all-user) · [受限开放权限](https://developer.huawei.com/consumer/cn/doc/harmonyos-guides/restricted-permissions) · [申请受限权限](https://developer.huawei.com/consumer/cn/doc/harmonyos-guides/declare-permissions-in-acl) · [自动签名](https://developer.huawei.com/consumer/cn/doc/harmonyos-guides/ide-signing-auto) · [配置调试签名异常 FAQ](https://developer.huawei.com/consumer/cn/doc/harmonyos-faqs/faqs-signature-service-18) · [AGC 创建 HarmonyOS 应用](https://developer.huawei.com/consumer/cn/doc/app/agc-help-create-app-0000002247955506) · [申请调试 Profile](https://developer.huawei.com/consumer/cn/doc/app/agc-help-debug-profile-0000002248181278)
- 其他 Kit：[Contacts Kit](https://developer.huawei.com/consumer/cn/doc/harmonyos-guides/contacts-intro) · [@ohos.contact](https://developer.huawei.com/consumer/cn/doc/harmonyos-references/js-apis-contact) · [Calendar Kit](https://developer.huawei.com/consumer/cn/doc/harmonyos-guides/calendarmanager-overview) · [位置权限](https://developer.huawei.com/consumer/cn/doc/harmonyos-guides/location-permission-guidelines) · [照片 Picker](https://developer.huawei.com/consumer/cn/doc/harmonyos-guides/photoaccesshelper-photoviewpicker) · [传感器概述](https://developer.huawei.com/consumer/cn/doc/harmonyos-guides/sensor-overview) · [后台任务](https://developer.huawei.com/consumer/cn/doc/harmonyos-guides/background-task-overview) · [前端调用应用侧函数](https://developer.huawei.com/consumer/cn/doc/harmonyos-guides/web-in-page-app-function-invoking)
- 审核：[应用审核指南](https://developer.huawei.com/consumer/cn/doc/app/50104) · [应用资质审核要求](https://developer.huawei.com/consumer/cn/doc/app/80301)
- 法律：[个人信息保护法（网信办）](https://www.cac.gov.cn/2021-08/20/c_1631050028355286.htm)

> 取文档的方法：developer.huawei.com 文档页是前端渲染的，直接抓页面会超时。本次用的是文档站自己的接口 `documentPortal/getDocumentById` 和 `getCatalogTree`（POST，公开、不用登录）拿原文，留档在同目录 `raw/` 下。
