# 调研 18：OAuth 与用户签名的命令

> - **调研日期**：2026-10-14。只读了网页和本仓库的文档。没有改代码，没有跑 npm，没有装任何东西，也没有碰手机。
> - **问题**：项目负责人（维护者）没有权限改立项书和阶段的验收标准。用户在对话里说"我授权可以"，另一个 agent 认定"这只是转述，不具备效力"。用户想让自己能对命令和要求**签名**，由 agent 一侧（实际是守护进程）验真。要定选什么算法、密钥怎么管。用户点名先调研 OAuth。本文回答七个问题：
>   1. OAuth 2.0 / 2.1 本身管什么、不管什么（§3）；
>   2. 能借用的 OAuth 扩展，以及 AI agent 授权方面的标准（§4、§5）；
>   3. 签名格式、规范化、防重放（§6）；
>   4. 算法（§7）；
>   5. 用户本人在场与硬件密钥：WebAuthn / passkey、鸿蒙、浏览器 WebCrypto、Node.js（§8）；
>   6. 密钥管理（§9）；
>   7. 先例（§10）。
>
>   §2 先把"用户签名"拆成七个性质。§11 汇总没核实的地方。§12 是对二狗的启示。§13 列全部来源。
> - **标注**：
>   - 不加标的是事实，后面附来源（RFC 号加节号，或规范名加节号；完整链接见 §13）。
>   - 【推测】= 作者推断，规范里没有直说。
>   - 【建议】= 作者的建议。
>   - 【未核实】= 没在一手资料里找到定论。
> - **引文**：英文原文照录。网页经摘要工具读取，单段引文最长约 125 字符，是原文片段，不一定是整句。拿去做决定之前，请对照原文再核一遍。
> - **取文方式**：华为开发者文档的网页直接抓只能拿到"文档中心"四个字，正文是经该站自己的文档接口取的，页面更新时间都显示 2026-10-13。OpenHarmony 的内容取自官方 GitHub 镜像，标"OpenHarmony"，HarmonyOS 可能不同。
> - **和以前调研的关系**：调研 [07](07-push-harmonyos-android.md) §6.3 已经提出"打开 App → 生物识别 → 设备密钥对服务端挑战值签名，签名绑定审批 ID 和规范化后的动作哈希"。本文补上这条建议背后的标准依据，并扩到 PC 浏览器和手机浏览器。

---

## 1. 要点

1. **OAuth 不证明"这条命令是用户本人发的"。**
   - RFC 6749 是授权委托框架，解决的是"第三方应用拿到有限的访问权"。RFC 6749、6750 全文没有不可抵赖（non-repudiation）一词。bearer 令牌谁拿到谁能用（RFC 6750 §1.2）。
   - 整个 OAuth / OpenID 体系里，只有 FAPI 2.0 Message Signing 把不可抵赖当目标。它签的是客户端和服务器的报文。它的 §6.5 还明说：证明"某个真实用户发起了某个请求"不在范围内。
   - 所以命令级的签名要另做（§3）。
2. **OAuth 里能借的是结构，不是服务器。**
   - RFC 9396 RAR 的 `authorization_details` 可以照搬成授权项的格式；不认识的 `type` 一律拒。
   - RFC 8693 的 `sub` / `act` 能记"谁代谁在做"。但规范只认当前执行者，链上更早的执行者"仅供参考"。
   - CIBA 的 `binding_message`：发起的设备和确认的设备显示同一段短文字。
   - DPoP 的一次性证明字段（`jti`、`iat`、服务器 nonce），以及 RFC 8725 的显式 `typ`。
   - 【推测】单机单用户不必起一个授权服务器，也不必跑授权码流程（§3.6）。
3. **DPoP、mTLS 只证明"持钥的客户端发了这个请求"，不覆盖命令内容。**
   - DPoP 原文："does not ensure the integrity of the payload"（RFC 9449 §11.7）。
   - 要签内容，得签命令对象本身（JWS），或者用 RFC 9421 再加 Content-Digest。
   - GNAP 的 httpsig 能覆盖正文，但签名方是"客户端实例"，不是用户（§4）。
4. **AI agent 方面没有现成标准。**
   - MCP 当前版本是 2026-07-28。它用 OAuth 2.1 管"客户端能不能调服务器"；stdio 通道不走 OAuth；客户端回报的"用户同意了"没有签名。用 passkey 给单次工具调用签名的提案 SEP-2672 已关闭，没有合并。
   - IETF WIMSE 工作组的 draft-ietf-wimse-aims-00 写明：本地界面上的确认 "do not by themselves constitute authorization and MUST be bound to a verifiable authorization grant"。
   - 最贴近二狗的是个人草案 draft-lee-wimse-local-tool-call-proof-01：在 agent 进程之外，由一个签发方对"工具名 + 参数"的摘要签一次性证明；人审批的也是这个摘要。
   - 没有任何标准规定"秘书转述用户的话、下游验证这话出自用户"（§5）。
5. **格式：签一条结构化命令，JWS Compact 最省事。**
   - 它签的是编码后的字节，不用做 JSON 规范化。
   - 防重放靠 `jti`、`iat` / `exp`、`aud`、服务器 nonce；显式 `typ` 防止一种用途的签名被拿去别的用途。
   - JCS（RFC 8785）只在签名内嵌、或载荷分开传输时才需要。COSE 和 WebAuthn 同源，但 Node 没有内建 CBOR（§6）。
6. **算法：验证端 Ed25519 和 ES256 都要支持。**
   - Ed25519 是确定性的，签名 64 字节，有 S < L 检查就不可塑。ES256 每次签名要新随机数，签名可塑。
   - 平台 passkey 基本只给 ES256：Apple 只支持 ES256；Chrome 桌面的 Google 密码管理器云端认证器只认 -7；Windows 的 `webauthn.h` 没有 EdDSA 常量。
   - JOSE 的新算法名 "Ed25519"（RFC 9864，2025-10）取代 "EdDSA"；WebAuthn L3 却仍建议用 -8（§7）。
7. **本人在场：WebAuthn 能签，但用户看不到签的是什么。**
   - 断言签的是 `authenticatorData ‖ SHA-256(clientDataJSON)`，challenge 在 clientDataJSON 里。把命令哈希混进 challenge，签名就间接覆盖了命令。
   - 但认证器的界面不显示 challenge。SPC 规范把这种用法叫作 "misuse of the challenge field"。用户看到的只是网页自己画的文字，网页被注入脚本就能改。
   - 交易确认扩展 txAuthSimple 在 Level 2 因为"没人实现"被删掉。Level 3（2026-08-25 成为 W3C 推荐标准）没有替代品。SPC 只管支付，只有 Chromium 支持（§8.1–8.2）。
8. **鸿蒙：WebAuthn 这条路走不通，HUKS 这条路可行。**
   - ArkWeb 没有官方说明支持 WebAuthn；系统通行密钥要求 App 关联域名（App Linking）。
   - HUKS 能生成不可导出的 P-256 / Ed25519 密钥（API 8 起），能要求每次签名都验指纹、人脸或锁屏密码，再经 `registerJavaScriptProxy`（可以设 URL 白名单）给网页用。
   - 系统认证弹窗的标题最多 500 字符，可以写命令摘要。但标题不进签名，官方也没说这个弹窗是可信界面。能把内容放进可信界面并签进去的"数字盾"只开放给企业开发者（§8.5）。
9. **纯软件方案（WebCrypto 不可导出密钥存 IndexedDB）只防"偷"，不防"用"。** 注入的脚本能直接调 `sign`；没有在场证明；清浏览器数据就丢。WebCrypto 的 Ed25519 支持从 Chrome / Edge 137、Firefox 129、Safari 17 开始（§8.6）。
10. **Node 22 自带的 `node:crypto` 够验 Ed25519、ES256 和 WebAuthn 断言。**
    - WebCrypto 的 Ed25519 从 22.13.0 起是稳定功能。
    - WebAuthn 注册时的 attestationObject 是 CBOR，Node 没有内建解析。【推测】不要 attestation 时，可以用浏览器直接给的 SPKI 公钥绕开。
    - `jose` 6.2.12 没有依赖；`@simplewebauthn/server` 14.0.3 有 10 个依赖（§8.7）。
11. **密钥管理：每台设备自己生成密钥，私钥不出设备，服务端只存公钥。**
    - NIST SP 800-57：签名私钥建议用 1–3 年；集中生成签名密钥"不能很好地支持不可抵赖"；私钥泄露后，它签过的东西都存疑。
    - NIST SP 800-63B-4（2025-07-31 终稿）：AAL3 要求不可导出的密钥和抗钓鱼；可同步的 passkey 最多到 AAL2；跨设备绑定用一次性绑定码（≥112 bit，有标识符时 ≥40 bit；10 分钟；只用一次）；用户报告丢失后要能立即作废（§9）。
12. **先例**（§10）：
    - OpenSSH 签名（`ssh-keygen -Y sign`）用 namespace 按用途分域，用 allowed_signers 文件登记"谁、哪些用途、什么时段有效"，吊销单独放一个文件。Git 直接用它。
    - FIDO UAF 交易确认、PSD2 的动态链接、U 盾回显，都要求"用户看到的就是签下去的"，改了金额或收款方签名就失效。
    - Signal 的安全码：带外比对公钥指纹。Sigstore：每次签名追加进只增日志。TUF：换根时新旧根一起签，带版本号防回滚。

## 2. 先把"用户签名"拆开

这一节是本文的分析框架【推测】。"用户签名"常被当成一件事，其实是七个性质。后面各节都拿这张表对照。

| 性质 | 意思 | 由什么提供 |
|---|---|---|
| 来源 | 这条东西是某把私钥签的 | 任何数字签名 |
| 完整 | 内容一个字没改 | 签名要覆盖内容本身（DPoP 不覆盖正文，§4.1） |
| 密钥归属 | 这把私钥属于用户本人 | 注册 / 配对流程（FAPI 2.0 MS §6.5 明说这不在它的范围里） |
| 本人在场 | 签名那一刻用户本人做了验证（指纹、人脸、PIN） | WebAuthn 的 UV 位、HUKS 的用户认证访问控制、Windows Hello（§8） |
| 所见即所签 | 用户看到的内容就是被签的内容 | 可信显示：FIDO UAF 交易确认、SPC、鸿蒙数字盾；普通网页做不到（§8.2、§10.3） |
| 新鲜 | 旧签名不能重放 | nonce、`jti`、`iat` / `exp`、`aud`（§6.8） |
| 事后可验 | 过后还能拿出来核对 | 留存签名、被签原文和当时的公钥；公钥的保留期长于私钥（§9.1） |

NIST 对不可抵赖的说法也要先摆出来：数字签名只能 "support" 不可抵赖的判定，"A real determination of non-repudiation is a legal decision"（SP 800-57 Pt1 R5 §3.5）。【推测】对一个单用户系统，实际要的是"守护进程能自己确认、日后能拿给用户看"，不是法律意义上的不可抵赖。

## 3. OAuth 2.0 / 2.1 本身

### 3.1 它解决什么

- RFC 6749（2012-10）是授权框架（authorization framework），让第三方应用拿到对 HTTP 服务的 "limited access"（Abstract）。§1："OAuth addresses these issues by introducing an authorization layer"。
- 四个角色：
  - 资源拥有者（resource owner），即用户；
  - 客户端（client）；
  - 授权服务器（authorization server，AS）；
  - 资源服务器（resource server，RS）。
- 流程：用户在 AS 上同意，AS 发访问令牌（access token），客户端拿令牌去访问 RS。
- 它解决的是"委托访问"：用户不用把密码交给第三方，第三方也只拿到有限、可撤销的权限。

### 3.2 它不解决什么

- **没有不可抵赖。** RFC 6749 和 RFC 6750 全文都没有 non-repudiation 或 repudiation。RFC 6749 §10 安全考虑共 16 个小节，没有一节讲消息完整性，也没有一节讲资源拥有者签名。
- **RS 连"令牌是不是发给这个客户端的"都确认不了。** RFC 6749 §10.3："This specification does not provide any methods for the resource server to ensure"……
- **bearer 令牌谁拿到谁能用。** RFC 6750 §1.2："any party in possession of the token can use the token in any way"，并且 "does not require a bearer to prove possession of cryptographic key material"。
- **令牌表达的是"客户端被授权做某一类事"，不是"用户此刻说了这句话"。**【推测，由 §3.1 的流程推出】用户在 AS 上同意一次之后，客户端发的每个请求都不再有用户参与。
- **连唯一以不可抵赖为目标的 FAPI 2.0 Message Signing 也不管"是不是那个人"。** §6.5："proving that a specific signed response is linked to a specific real world end-user, or that a real world end-user initiated a specific request is outside of the scope"（OIDF Final，2025-09-25）。

### 3.3 OAuth 2.1

- 最新是 draft-ietf-oauth-v2-1-16，2026-09-02 提交（文档首页日期 2026-09-03），2027-03-07 过期。它仍是 Active I-D，不是 RFC。前几版：-15（2026-03-02）、-14（2025-10-19）、-13（2025-05-28）。
- 和 2.0 的差别（§10，非规范性）：
  1. 授权码流程默认带 PKCE；PKCE 的 `plain` 方法去掉；
  2. 重定向 URI 精确字符串匹配；
  3. 去掉隐式授权（implicit）和资源拥有者密码凭证（password grant）；
  4. bearer 令牌不许放在 URI 查询串里；
  5. 公共客户端的刷新令牌 "must either be sender-constrained or one-time use"；
  6. 用授权码换令牌的请求里不再带 `redirect_uri`。
- 这些改动都在收紧"令牌被截获、被重放"的口子。没有一条涉及"命令出自用户"。

### 3.4 RFC 9700 安全最佳实践（BCP 240，2025-01）

对"守护进程既发令牌又验令牌"有用的几条：

- **发送方约束**（sender-constrained，§2.2.1）："SHOULD use mechanisms for sender-constraining access tokens"，点名 mTLS（RFC 8705）和 DPoP（RFC 9449）。
- **受众限制和最小权限**（§2.3）：令牌 "SHOULD be audience-restricted to a specific resource server"；权限 "SHOULD be restricted to the minimum required"；不是发给自己的令牌 "MUST refuse"。
- **刷新令牌**（§2.2.2、§4.14.2）：公共客户端的刷新令牌 "MUST be sender-constrained or use refresh token rotation"；AS 必须能发现刷新令牌被重放。
- **客户端认证用非对称密码**（§2.5）："RECOMMENDED to use asymmetric cryptography for client authentication"。
- **反向代理终止 TLS**（§4.13）：代理 "MUST therefore sanitize any inbound requests"，也就是清掉外面伪造的头；代理到应用之间的链路 "MUST be protected against eavesdropping"。
- **混淆攻击（mix-up）** 的防御只在客户端要对接多个 AS 时才必需（§2.1）。单机只有一个 AS，基本用不上。

### 3.5 PKCE（RFC 7636，2015-09）

- 客户端先生成一个随机的 `code_verifier`，授权请求里只带它的变换值 `code_challenge`（S256 是 `BASE64URL(SHA256(code_verifier))`，§4.2）。换令牌时再交出原值，服务器比对。
- 防的是授权码被截获（"authorization code interception attack"，Abstract）。
- 对二狗：只有跑授权码流程时才用得上。

### 3.6 单机单用户要不要起授权服务器【推测】

- 在二狗里，守护进程同时站在 AS 和 RS 的位置。客户端是用户自己设备上的同一套 Web 界面。没有"第三方客户端"需要被委托。
- 设备配对（10 号票）已经做了 OAuth 里"客户端注册 + 发长期凭证 + 可吊销"那部分：256 位随机凭证，服务端只存哈希，365 天，可吊销（`docs/developer-guide.md` 的"设备配对"）。这个凭证是 bearer 性质的 cookie，按 RFC 6750 §1.2 的说法，谁拿到谁能用。
- MCP 规范对本机 stdio 通道的态度可以参考："Implementations using an STDIO transport SHOULD NOT follow this specification, and instead retrieve credentials from the environment"（MCP 2026-07-28 Authorization）。二狗的 agent 子进程经 stdio 和守护进程通信，守护进程本来就知道每个调用来自哪个进程。
- 所以起一个完整的 AS、跑重定向和授权码，多出来的只有复杂度。真正缺的是 OAuth 本身不给的两样东西：一是命令内容的签名，二是签名时用户本人在场。
- 能借的是 RFC 9700 的原则：发送方约束（设备凭证绑一把设备密钥）、受众限制、最小权限、短时效。

## 4. 能借用的 OAuth 扩展

### 4.1 DPoP（RFC 9449，2023-09）：发送方约束

**机制**
- 客户端每个请求附一个 DPoP 证明（proof），它是一个 JWT：
  - 头（§4.2）：`typ` 必须是 `dpop+jwt`；`alg` "MUST NOT be none or an identifier for a symmetric algorithm"；`jwk` 放公钥，不许含私钥。
  - 载荷：`jti`（至少 96 位随机数或 UUIDv4）、`htm`（HTTP 方法）、`htu`（目标 URI，不含查询串和片段）、`iat`。带访问令牌时还有 `ath`（令牌的 SHA-256）。服务器发过 nonce 时还要带 `nonce`。
- **令牌绑钥**（§6.1）：访问令牌里放 `cnf.jkt`，即公钥的 JWK SHA-256 指纹（RFC 7638）。授权码也能用 `dpop_jkt` 绑到同一把钥（§10）。
- **服务器 nonce**（§8、§9）：AS 回 400 `use_dpop_nonce`、RS 回 401，都在 `DPoP-Nonce` 头里给新值。"Nonce values MUST be unpredictable"。
- **重放**：§4.3 的 12 步校验里有 `iat` 时间窗，但没有 `jti` 查重。§11.1 说 "servers MUST only accept DPoP proofs for a limited time"，`jti` 查重只写了 "can"。
- **私钥存放**：§2 直接提到 WebCrypto："If the private key is non-extractable … DPoP renders exfiltrated tokens alone unusable"。但 §11.4 也说："If an adversary is able to run code in the client's execution context, the security of DPoP is no longer guaranteed"。

**不覆盖什么**
- §11.7："DPoP does not ensure the integrity of the payload or headers of requests"；"only contains claims for the HTTP URI and method, but not the message body"。
- 所以 DPoP 证明的只是"持钥的客户端向这个方法 + URI 发了请求"。它证明不了命令内容，也证明不了用户本人在场。

**对二狗的用处【推测】**
- 能把设备 cookie 从 bearer 变成"cookie + 设备私钥"：cookie 被偷了也用不了。
- 它的字段设计（`jti`、`iat`、服务器 nonce、`typ`、非对称算法白名单）可以直接照搬到命令签名上。

### 4.2 mTLS 证书绑定（RFC 8705，2020-02）

- 令牌的 `cnf` 里放 `x5t#S256`，即客户端证书 DER 编码的 SHA-256（§3.1）。
- **TLS 终止在反向代理时怎么办，规范没讲。** §6.5 允许在负载均衡或反向代理上终止 TLS，但 "How the client certificate metadata is securely communicated between the intermediary and the application server" 属于 "out of scope"。
- RFC 9440（2023-07，Informational）补了 `Client-Cert` 和 `Client-Cert-Chain` 两个头。代理对外来的同名头 "MUST be removed or overwritten"（§2.4）；代理到后端的链路要防窃听和篡改（§4）。
- **套到二狗的拓扑上**：VPS 上 nginx 终止 TLS，再经 ssh 反向隧道回到 PC。
  - 【推测】按 RFC 9440 能做：nginx 清掉外来的头、写入 `Client-Cert`，ssh 隧道算受保护的链路。
  - 但证书要装进每个浏览器和鸿蒙 App，手机浏览器装客户端证书的体验很差。它也和 DPoP 一样不覆盖命令内容。

### 4.3 Rich Authorization Requests（RFC 9396，2023-05）：细粒度授权

**机制**
- `authorization_details` 是一个对象数组。每个对象必须有 `type`："The value of the type field determines the allowable contents of the object"（§2）。
- 通用字段（§2.2）：
  - `locations`：资源位置；
  - `actions`：动作；
  - `datatypes`：数据类别；
  - `identifier`："A string identifier indicating a specific resource"；
  - `privileges`：权限等级。
- 原文示例：
  - Figure 5：`{"type":"customer_information","locations":["https://example.com/customers"],"actions":["read","write"],"datatypes":["contacts","photos"]}`
  - Figure 7（带 `identifier`）：`"type":"financial-transaction","actions":["withdraw"],"identifier":"account-14-32-32-3"`
- **`type` 由 AS 解释**（§2.1）："The AS controls the interpretation"。建议用自己控制的命名空间，比如自己的 URI。
- **不认识就拒**（§5）："The AS MUST refuse to process any unknown authorization details type"，返回 `invalid_authorization_details`。超出策略允许的范围也返回这个错（§6）。
- **在令牌里怎么体现**：令牌响应必须返回实际批准的 `authorization_details`（§7）；JWT 访问令牌里建议作为顶层 claim，按受众过滤（§9.1）；内省响应里也放顶层（§9.2）。

**对二狗的用处【推测】**
- "允许改项目 X 阶段 s6 的验收标准"可以写成：
  ```json
  {"type": "urn:ergo:grant:stage-acceptance",
   "actions": ["update"],
   "identifier": "project:X/stage:s6",
   "datatypes": ["acceptance_criteria"]}
  ```
- 二狗的授权项（CONTEXT.md："操作种类、对象范围、次数、所属阶段、有效期"）和这个结构能对上：`type` 加 `actions` 对应操作种类，`identifier` / `locations` 对应对象范围。次数和有效期 RAR 没有通用字段，要放进 type 自己定义的字段里。

### 4.4 Token Exchange（RFC 8693，2020-01）：委托链

- **委托与冒充**（§1.1）：
  - 冒充（impersonation）："A is given all the rights that B has"；
  - 委托（delegation）："principal A still has its own identity separate from B"。
- **`act`**（§4.1）："provides a means within a JWT to express that delegation has occurred"。可以嵌套：外层 `sub` 是用户，`act.sub` 是当前执行者，`act.act.sub` 是之前的执行者（Figure 6）。
- **只认当前执行者**（§4.1）：令牌使用方 "MUST only consider the token's top-level claims and the party identified as the current actor"；之前的执行者 "informational only and are not to be considered in access control decisions"。
- **`may_act`**（§4.4）："makes a statement that one party is authorized to become the actor"。
- **后续草案**：
  - draft-mcguinness-oauth-actor-proofs-01（2026-10-09，个人草案，没有正式地位）：让链上每一跳的执行者自己签一个证明，补的正是"之前的执行者仅供参考"这个缺口。
  - draft-mw-oauth-actor-chain-02（2026-10-13，个人草案）：原文说执行者的签名只证明协议请求，"not business approval"。

**对二狗的用处【推测】**
- 秘书把用户的话转给负责人，用 RFC 8693 的话说就是一条委托链：`sub` 是用户，`act` 是秘书。
- 规范的态度正好解释了那次"转述无效"：链上的转述者不能为授权作证。要让授权有效，得让负责人一侧（实际是守护进程）验到**用户自己的**签名，而不是听秘书的说法。

### 4.5 CIBA（OpenID Connect Client-Initiated Backchannel Authentication Core 1.0）

- **状态**：Final，2021-09-01。
- **流程**：
  - 客户端不经用户的浏览器，直接向 OP 发后向认证请求。
  - OP 在用户的认证设备（authentication device，"often a smartphone"）上让用户认证并同意。
  - 发起业务的那台设备叫消费设备（consumption device）。
  - 取结果有三种模式：poll、ping、push（§5）。
- **`binding_message`**（§7.1，可选）：
  - 定义："A human-readable identifier or message intended to be displayed on both the consumption device and the authentication device"。
  - 作用："to interlock them together for the transaction by way of a visual cue"，让用户确认"手机上批的就是电脑上那一笔"。
  - 长度："SHOULD be relatively short and use a limited set of plain text characters"。
  - 原文只说 "intended to be displayed"，没有强制 OP 必须显示。
- **签名的请求**（§7.1.1，可选）：用 `request` 参数传一个非对称签名的 JWT。签的是**客户端**。
- **FAPI-CIBA**（Implementer's Draft；页面自标 Draft-02，2019-08-15）：
  - AS "shall ensure unique authorization context exists … or require a binding_message"（§5.2.2 第 2 条）；
  - "shall require Backchannel Authentication Endpoint requests to be signed"（第 6 条）；
  - 不支持 push 模式；请求有效期不超过 60 分钟；
  - §7.3 承认这要靠用户自己去比对绑定信息。

**对二狗的用处【推测】**
- "agent 发起、用户在另一台设备上确认"正是 CIBA 的形状。二狗已经有"待我处理"和推送（调研 07），缺的是确认时的签名。
- `binding_message` 的做法可以照搬：PC 上和手机上同时显示同一个短码或命令摘要。
- 注意 CIBA 里签名的是 OP（push 模式下 ID Token "acts as a detached signature"，§10.3.1），不是用户的密钥。

### 4.6 JAR（RFC 9101，2021-08）与 PAR（RFC 9126，2021-09）

- **JAR**：把授权请求的参数放进一个 JWT（Request Object）。按值传用 `request`，按引用传用 `request_uri`（§5.1、§5.2）。必须签名，可以再加密（§5）。收益是 "integrity … source authentication … confidentiality"（§1）。
- **PAR**：客户端先把请求推到 PAR 端点，拿回 `request_uri` 和 `expires_in`（§2.2），再拿去授权端点用。PAR 端点按令牌端点的方式认证客户端（§2.1）。
- **签名的是客户端，不是用户**：RFC 9101 §6.2 要求签名密钥 "MUST be a key associated with the client"。
- PAR §1 提了一句不可抵赖："Clients requiring an even higher security level, especially cryptographically confirmed non-repudiation, are able to use JWT-based Request Objects"。这是**客户端层面**的不可抵赖。
- **对二狗【推测】**：思路可以借——"要批准的东西先作为一个签名对象交给服务端，用户在服务端的页面上看到的就是它"。但签名者要换成用户设备上的密钥。

### 4.7 Transaction Tokens（draft-ietf-oauth-transaction-tokens-11）

- **版本**：-11，2026-07-30。2026-08-21 起状态是 "WG Consensus: Waiting for Write-Up"，还没有送 IESG。
- **是什么**：在一个信任域内的调用链上 "maintain and propagate user identity, workload identity and authorization context"（Abstract）。寿命 "on the order of minutes or less"。
- **字段**（§9.2，按 -11 核对）：
  - JWT 头 `typ=txntoken+jwt`；
  - 必填：`iat`、`aud`（信任域）、`exp`、`txn`（事务唯一 ID）、`sub`、`scope`、`req_wl`（发起请求的工作负载）；
  - 建议：`tctx`（整条调用链上不变的事务上下文）、`rctx`（请求环境）；
  - 可选：`iss`。
  - 旧字段名已改："Renamed azd claim to tctx claim"（自 -04），"Rename the purpose claim to scope"（自 -06）。
- **怎么拿、怎么传**：用 RFC 8693 向事务令牌服务换（`requested_token_type=urn:ietf:params:oauth:token-type:txn_token`），服务之间用 `Txn-Token` 头传，不放在 Authorization 头里。
- **定位**：§13.12 "Are Not Authentication Credentials"；§13.13 "Are Not OAuth 2.0 Access Tokens"。
- **对二狗【推测】**：它的形状像"守护进程验完用户签名后，生成一份内部的、短期的、不可改的事务上下文，随工单一路传给负责人、子 agent、评审"。它本身不是用户签名。

### 4.8 GNAP（RFC 9635，2024-10；RFC 9767，2025-04）

- **不是 OAuth 的扩展**：§1 "GNAP is not an extension of OAuth 2.0 and is not intended to be directly compatible"。
- **客户端就是一把密钥**：§1.2 "identified by its unique key"；AS 可以接受没有预注册的密钥（§2.3.3）；没有"公共客户端"这个概念（附录 A）。
- **每个请求都证明持钥**（§7）：四种方式 httpsig、mtls、jwsd、jws。其中 httpsig 在请求带正文时 "content-digest … REQUIRED"（§7.3.1），能覆盖正文，这一点比 DPoP 强。
- **`access` 数组**（§8）："designed to be analogous to the OAuth 2.0 Rich Authorization Requests data structure"，字段和 RAR 一样。
- **交互**（§2.5、§3.3）：redirect、app、user_code 等；允许最终用户和资源拥有者是两个人（附录 A）。
- **RFC 9767**：RS 和 AS 之间的接口，包括令牌模型、内省、资源注册、下游令牌派生。
- **成熟度**：
  - GNAP 工作组已结束（Concluded）。
  - 2022-07 的 shepherd write-up 写着 "multiple implementations exist"、"some in production"。
  - 工作组 GitHub 上 2023 年的实现列表有 SUNET、Trustbloc、Verified.ME、XYZ 等。
  - 之后的采用情况没有官方资料【未核实】。
- **是否更合适【推测】**：GNAP 的"每个请求都用密钥签、能覆盖正文、不必预注册"，思路上比 OAuth 更接近需求。但签名方仍是"客户端实例"，把用户设备上的不可导出密钥当成客户端，才近似"用户签名"。整套 GNAP（AS 交互、令牌、续期）对单机单用户仍然偏重，借它的 httpsig 用法和 `access` 结构就够了。

### 4.9 FAPI 2.0 Message Signing 与 Http Signatures：唯一以不可抵赖为目标的一族

- **FAPI 2.0 Message Signing**（OIDF Final，2025-09-25）：
  - 目标："interoperable support for non-repudiation across OAuth 2.0 based requests and responses"。
  - 定义（§5.2）：不可抵赖是 "the assurance that the owner of a signature key pair … cannot convincingly deny having signed the data"，通常靠 "application-level signatures that can be stored together with the payload and meaningful metadata"。
  - 签的对象：推送授权请求（客户端签 JAR）、授权响应（AS 用 JARM 签）、内省响应（AS 按 RFC 9701 签）、ID Token 等。
  - 局限：
    - §6.3 只保证单条消息，不保证消息序列；
    - §6.4 前端授权请求 "non-repudiation is not provided"；
    - §6.5 不管真实用户（见 §3.2）；
    - §7 只给了存储建议：访问控制、数据最小化、防篡改的审计日志。
- **FAPI 2.0 Http Signatures**（OIDF 工作稿，2026-06-26）：
  - 用 RFC 9421 签 HTTP 请求和响应。
  - 客户端签资源请求必须覆盖 `@method`、`@target-uri`、`Authorization`；用了 DPoP 时加 `DPoP` 头；有正文时加 `content-digest`。
  - 参数要有 `created`，`tag=fapi-2-request`；建议 `created` 的时间窗为 1 分钟（§5.3.1.1–5.3.1.2）。
- **对二狗【推测】**：最值得借的是 §5.2 那句"应用层签名，和原文、元数据一起存"，以及 §7 的防篡改审计日志。

### 4.10 对照

| 扩展 | 签名方 | 覆盖命令内容 | 本人在场 | 对二狗主要能借什么【推测】 |
|---|---|---|---|---|
| DPoP | 客户端密钥 | 否（§11.7） | 否 | 设备凭证绑钥；`jti` / `iat` / nonce / `typ` 字段 |
| mTLS | 客户端证书 | 否 | 否 | 基本不借（证书分发重，隧道拓扑要自己配） |
| RAR | 无（只是数据结构） | — | — | 授权项格式；不认识的 type 一律拒 |
| Token Exchange | AS | — | — | `sub` / `act` 记委托链；只认当前执行者 |
| CIBA | OP | 只有 binding_message 文字 | 由 OP 定 | 发起和确认分在两台设备；两边显示同一短码 |
| JAR / PAR | 客户端 | 是（授权请求） | 否 | 先提交签名对象，再让用户看它 |
| Transaction Tokens | 事务令牌服务 | 上下文 | 否 | 守护进程签发内部的事务上下文 |
| GNAP httpsig | 客户端实例密钥 | 是（content-digest） | 否 | 覆盖正文的请求签名用法 |
| FAPI 2.0 MS | 客户端 / AS | 是 | 否（§6.5） | 应用层签名与留存 |

## 5. MCP 授权与 AI agent 相关标准

### 5.1 MCP 的授权规范（当前版本 2026-07-28）

- **版本**：versioning 页写着 "The current protocol version is 2026-07-28"。这一版去掉了 initialize 握手和会话。
- **角色**："A protected MCP server acts as an OAuth 2.1 resource server"（Authorization §Roles，引用 draft-ietf-oauth-v2-1-13）。
- **必须实现的**：
  - RFC 9728 受保护资源元数据："MCP servers MUST implement OAuth 2.0 Protected Resource Metadata"；
  - RFC 8707 资源指示（resource indicators）：授权请求和令牌请求里都要带 `resource`；
  - PKCE：服务器元数据里没有 `code_challenge_methods_supported` 时，客户端 "MUST refuse to proceed"（Security Considerations）。
- **客户端注册**（Client Registration）：优先用 Client ID Metadata Documents（CIMD）；动态客户端注册（RFC 7591）"is deprecated"；选择顺序是预注册 → CIMD → 动态注册 → 让用户手填。
- **禁止令牌透传**："The MCP server MUST NOT pass through the token it received from the MCP client"（Security Considerations）。
- **混淆代理（confused deputy）**：用静态 client ID 的代理服务器 "MUST obtain user consent for each dynamically registered client before forwarding"。
- **stdio 不走 OAuth**："Implementations using an STDIO transport SHOULD NOT follow this specification, and instead retrieve credentials from the environment"。
- **向用户要输入（elicitation）**：
  - 有 form 和 url 两种模式；敏感信息 "MUST NOT use form mode"。
  - 服务器 "MUST bind elicitation requests to the client and user identity"，并且 "MUST NOT rely on client-provided user identification without server verification"。
  - 但客户端回的 `action: "accept"` 是客户端自己报告的，没有签名，也没有证明。
  - 总则 "Hosts must obtain explicit user consent before invoking any tool" 是对宿主程序的要求，服务器无法验证。
- **企业托管授权**（Enterprise-Managed Authorization，扩展，Stable，源自 SEP-990）：客户端拿用户的 ID Token 到企业 IdP 换一个 ID-JAG，再到 MCP 的 AS 换访问令牌。原文："Do not redirect the user to the MCP Authorization Server's authorization endpoint"。
- **讨论过、但没进规范的提案**：
  - SEP-2672《Per-Call Passkey Verified Approval for MCP Tool Calls》：用 WebAuthn 把一次工具调用和它的参数绑在一起，证据放在 `params._meta`。2026-05-02 提出，2026-09-22 关闭，没有合并（理由是新的 SEP 要在工作组里做）。
  - SEP-2848《Asynchronous Approval for Tool Calls》：服务器把调用挂起，等外部审批（人、上级 agent 或策略引擎），示例用 AuthZEN ARAP。状态 Open，没有 sponsor，没有签名审批。
  - SEP-2385《Tool Auth Manifest》：给工具标注"是否需要人工审批"。2026-09-22 关闭。
  - 已 Final 的 42 个 SEP 里没有用户签名确认。

### 5.2 IETF 草案与工作组

成熟度的意思：RFC Ed Queue = IESG 已批、等出版；WG 文档 = 工作组已采纳；个人草案 = "not endorsed by the IETF … no formal standing"。

| 草案 | 最新版 / 日期 | 状态 | 机制一句话 | 和"用户签名命令"的关系 |
|---|---|---|---|---|
| draft-ietf-oauth-identity-chaining | -17 / 2026-07-19 | OAuth WG，RFC Ed Queue | 本域换出 JWT 授权许可，再到另一个信任域换令牌 | 跨域委托，不签命令 |
| draft-ietf-oauth-identity-assertion-authz-grant（ID-JAG） | -04 / 2026-05-21 | OAuth WG 文档 | IdP 用 RFC 8693 换出 ID-JAG，再到资源方的 AS 换令牌；附录 A.4 是"AI agent 用外部工具" | 企业 IdP 集中授权，没有逐条确认 |
| draft-oauth-ai-agents-on-behalf-of-user | -02 / 2025-08-25 | 个人草案，已过期 | 授权请求加 `requested_actor`，令牌请求加 `actor_token` | agent 代用户的委托（OBO），不签命令 |
| draft-ietf-wimse-aims（前身 draft-klrc-aiagent-auth） | -00 / 2026-09-15 | WIMSE WG 文档，Informational | AI agent 认证授权的最佳实践 | 见下 |
| draft-hardt-oauth-aauth-protocol（AAuth） | -11 / 2026-09-25 | 个人草案 | 每个请求用 RFC 9421 签，没有 bearer 令牌；由 Person Server 代用户同意；可选的 Mission 摘要绑进令牌 | 用户本人不签；§7.4 承认同意页上的文字是 agent 写的："The agent chooses the words and gains from being believed" |
| draft-ietf-oauth-transaction-tokens | -11 / 2026-07-30 | OAuth WG，等 write-up | 见 §4.7 | 正文没提 AI agent |
| draft-araut-oauth-transaction-tokens-for-agents | -02 / 2026-05-22 | 个人草案 | 给 Txn-Token 加 `agentic_ctx` | 不涉及用户审批 |
| draft-mcguinness-oauth-actor-profile / -proofs / -receipts | -01 / 2026-10-08~09 | 个人草案 | 每一跳的执行者签证明；签发方出哈希链回执 | 证明委托链的来历，用户不签 |
| **draft-lee-wimse-local-tool-call-proof** | -01 / 2026-10-12 | 个人草案 | 见下 | **最贴近二狗** |
| draft-mw-oauth-actor-chain | -02 / 2026-10-13 | 个人草案 | 每一跳签 JWS，AS 签接受凭证 | "not business approval" |
| draft-sharif-mcps-secure-mcp | -01 / 2026-08-21 | 个人草案 | MCP 消息逐条签（ECDSA P-256 + JCS），防重放 | agent 的密钥签，没有用户签名 |
| draft-chen-oauth-agent-authz-use-cases | -04 / 2026-10-11 | 个人草案 | 用例和缺口分析 | 见下 |

**draft-ietf-wimse-aims-00 的要点**
- §10.7 Human in the Loop：
  - 本地界面上的确认 "do not by themselves constitute authorization and MUST be bound to a verifiable authorization grant issued by the authorization server"；
  - agent "SHOULD therefore translate user confirmation into an OAuth authorization event (e.g., step-up authorization via CIBA)"；
  - "the agent MUST NOT treat local UI confirmation alone as sufficient authorization"。
- §11：审计日志 "MUST be tamper-evident"。
- §8：LLM "MUST NOT have access to an agent's credentials"。

**draft-lee-wimse-local-tool-call-proof-01 的要点**
- 场景就是本机：agent 经 stdio 这类进程间通道调用本地工具服务器，HTTP 授权管不到。
- 在 agent 进程**之外**有一个 Call Authority，负责策略判定，签发短期、一次性的证明。证明绑定确切的工具名和参数：对 JSON-RPC 的方法、工具名、参数做 JCS 规范化后取 SHA-256。
- 工具服务器验这个证明，缺了或无效就拒绝调用。
- 调用方身份取自平台（socket 对端凭证），不信请求里自称的身份。
- 策略可以把某个动作标为"需要人工审批"，人审批的就是这个摘要；审批摘要的文字由 Call Authority 生成，不由 agent 生成。
- 自己承认的局限：不防提示注入（prompt injection）；计划级授权列为未解决的问题。

**draft-chen-oauth-agent-authz-use-cases-04 的要点**
- §3.1：AS 拿不到用户的原始意图，所以同意页只能写得笼统。
- §3.2：资源服务器无法验证多 agent 的委托链能追溯到用户。
- UC1 个人助理：执行时没有逐个动作的审批，也没有执行层的证据。

**工作组**
- agentproto（Agent Communication Protocols）：IETF 126（2026-07-23）开了 BoF，现已是 Active WG。身份和授权"复用、不新造"，纪要原话："expected to be done in OAuth, not here"。
- webbotauth：做机器人和 agent 对网站的密码学认证，明确不管终端用户的认证。
- WIMSE：除了 aims，还有 draft-ietf-wimse-http-signature-07（2026-09-20）等工作负载之间的请求签名。
- 没有专门做 agent 授权的工作组。
- datatracker 上名字带 "agent" 的活跃草案超过 200 份，几乎都是个人草案，不宜作为依据。

### 5.3 OpenID Foundation

- **AI Identity Management Community Group**：不出规范，把 "Development of any global standards protocols related to AI Agents & Identity" 列为范围外。
- **白皮书《Identity Management for Agentic AI》**（2025-10-07；引文取自同文的 arXiv 2510.25819v1，PDF 抓取超时）：
  - CIBA 让 agent "request authorization and continue processing while awaiting user approval"（§2.7、§4.2）；
  - 逐个动作都让人批 "is impossible"，审批疲劳会让用户 "reflexively approving"。替代方案是策略即代码、基于意图的授权、基于风险的动态授权（§3.4）；
  - AP2 的 Mandate 是 "a cryptographically-signed digital artefact that serves as auditable proof of a user's instructions"（§3.6）；
  - 代用户行事（OBO）时，用户放 `sub`，agent 放 `act`，scope 逐跳收窄（§3.2、§2.11）。
- **AuthZEN**：
  - Authorization API 1.0 于 2026-01 定稿（Final）。它是策略决策点（PDP）的 API，回答"这个主体对这个资源做这个动作行不行"，不证明用户说过什么。
  - 2026-06-15 批准了两份工作组草案：
    - ARAP（Access Request and Approval Profile）：PDP 拒绝时表示"可以申请"，审批在带外完成后重新评估。"neither approval.id nor approval.state is a bearer grant by itself"（§10.2）。默认的审批范围是原请求的主体、资源、动作精确匹配（§12.3.4）。它没有定义签名的人工审批证据格式。
    - COAZ：把 MCP 工具的授权映射到 AuthZEN。
- 没有叫 "OpenID for Agents" 的正式工作组。

### 5.4 支付领域：唯一真让用户设备密钥签名的

- **Google AP2**（Agent Payments Protocol；2026-04-29 捐给 FIDO 联盟）：
  - v0.1.0（2025-09-16）：Cart Mandate 由用户签，"typically using a hardware-backed key on their device"（§4.1.1）；Intent Mandate "cryptographically signed by the user"，用于用户不在场的情况（§4.1.2）。
  - v0.2.0（2026-04-28）：
    - 改为 Checkout Mandate 和 Payment Mandate，分 open 和 closed 两种；"specifies the use of SD-JWTs"。
    - 用户在可信界面（Trusted Surface）上批准 open mandate，mandate 里用 `cnf` 放 agent 的公钥。用户不在场时，agent 用自己的密钥签 closed mandate。
    - 安全考虑原文："assumes that preventing prompt injection attacks is infeasible"。
- **Mastercard Verifiable Intent**（Draft v0.1）：
  - 三层 SD-JWT：L1 由发卡方签发，绑定用户设备密钥；L2 由用户设备密钥签；L3 由 agent 签，只用于自主模式。
  - "user keys SHOULD NOT be exportable"；签 L2 之前 "SHOULD require user confirmation"（security-model §3.4）；用 nonce 加 `aud` 防重放（§4.1）。
- **Visa Trusted Agent Protocol**：基于 RFC 9421。签名证明的是 agent 身份和请求完整性，没有用户签名。
- **A2A**（v1.0.0）：
  - 身份放在协议层处理（§7）；
  - `TASK_STATE_AUTH_REQUIRED` 这个状态本身 "MUST NOT" 被当作授权（§7.6.4）；
  - Agent Card 可以用 JWS 签名，签之前用 JCS 规范化（§8.4）。

**这一节的含义【推测】**：现成的模式有三种可以参考。
- local-tool-call-proof：agent 进程之外的签发方对动作摘要签名；人审批的是摘要；摘要文字不由 agent 写。
- AP2 v0.2 / Verifiable Intent：用户设备密钥签一份带约束的"委托书"，agent 只能在约束内行事。
- SEP-2672：用 passkey 签单次调用。已关闭，但思路可以参考。

## 6. 签名格式与规范化

### 6.1 JWS（RFC 7515，2015-05）

- **签名输入**（§2）：`ASCII(BASE64URL(UTF8(JWS Protected Header)) || '.' || BASE64URL(JWS Payload))`。签的是编码后的字节，所以不需要 JSON 规范化（canonicalization）。
  - 【推测】7515 没有字面写"不需要规范化"，这是从签名输入的定义推出来的。RFC 8785 §1 也把 JWS 的做法描述为把数据转成 "a simple and fixed representation"。
- **两种序列化**：
  - Compact："Only one signature/MAC is supported"（§7.1）；
  - JSON：可以带多个签名，也可以带不受保护的头（§7.2）。
- **`crit`**（§4.1.11）：列出的扩展头接收方不认识，"the JWS is invalid"。
- **头参数名必须唯一**（§4）。
- **`typ` / `cty`**（§4.1.9）："ignored by JWS implementations"，由应用自己检查。
- **防重放**（§10.10）：可以加 "a unique message identifier"，但这 "not directly in scope"。
- **分离载荷**（附录 F）：载荷可以不随 JWS 一起传，前提是 "the recipient can reconstruct the exact payload"。
- **RFC 7797**（2016-02）：`"b64": false` 时载荷原样拼在后面签；"The crit Header Parameter MUST be included with b64"（§6）；载荷里含 '.' 时不能用 Compact（§5.2）。

### 6.2 JWT（RFC 7519，2015-05）

- 注册的 claim（§4.1）：`iss`、`sub`、`aud`（处理方不在 `aud` 里时 "MUST be rejected"）、`exp`（之后 "MUST NOT be accepted"）、`nbf`、`iat`、`jti`。
- `jti`："provides a unique identifier for the JWT"，"can be used to prevent the JWT from being replayed"。它是可选的。

### 6.3 JWT 最佳实践（RFC 8725，BCP 225，2020-02）与 8725bis

- **算法校验**（§3.1）："Libraries MUST enable the caller to specify a supported set of algorithms"；"each key MUST be used with exactly one algorithm, and this MUST be checked"。
- **`alg=none`**（§2.1、§3.2）：攻击者能把算法改成 none。
- **受众**（§3.9）："MUST validate the audience value"。
- **显式类型**（§3.11）：用 `typ`，例如 "application/example+jwt"（可以省掉 "application/" 前缀）。"Explicit typing is RECOMMENDED for new uses of JWTs"。
- **跨用途混淆**（§2.8、§3.12）：不同种类 JWT 的校验规则要 "mutually exclusive"。手段有五种：不同的 `typ`、不同的必填 claim、不同的必填头、不同的密钥、不同的 `aud`。
- **8725bis**：draft-ietf-oauth-rfc8725bis-10（2026-08-21），2026-08-24 获 IESG 批准，在 RFC 编辑队列里等一份引用。新增的内容：
  - 算法比较不能写成大小写不敏感（§2.11）；
  - JWT 格式混淆：用 JSON 序列化验签、却按 Compact 解析取 claim，要求 "MUST confirm the JWT is in a legal format"（§2.13、§3.14）；
  - "use allowlists … instead of blocklists"（§3.1）。

### 6.4 JWA（RFC 7518，2015-05）

- **ES256 的签名是 64 字节的 R‖S，不是 DER**（§3.4）："Concatenate the two octet sequences in the order R and then S"；"The resulting 64-octet sequence is the JWS Signature value"；不是 64 字节时 "the validation has failed"。
- RS256 / PS256："A key of size 2048 bits or larger MUST be used"（§3.3、§3.5）。
- 实现要求等级（§3.1）：HS256 是 Required，RS256 是 Recommended，ES256 是 Recommended+。
- 注意：WebAuthn 断言里的 ES256 签名是 **DER** 编码（WebAuthn L3 §6.5.5："MUST be encoded as an ASN.1 DER Ecdsa-Sig-Value"），和 JOSE 不一样。

### 6.5 JCS（RFC 8785，2020-06）

- **地位**：Informational，独立投稿（Independent Submission），不是 IETF 共识标准。
- **做什么**：按 ECMAScript 的规则序列化基本类型；属性按 UTF-16 码元排序（§3.2.3）；输入限定为 I-JSON。
- **限制**：
  - 数字 "builds on the IEEE 754 double-precision standard"（§3.2.2.3）；超出双精度的数 "RECOMMENDED to represent such numbers as JSON strings"；
  - 属性名不能重复（§3.1）。
- **用途**（§1）："enables a JSON object to remain a JSON object even after being signed"。
- 【推测】只有在签名嵌进别的 JSON 里，或者用 JWS 分离载荷 / `b64:false` 而接收方要自己重建原文时，才需要它。直接用 JWS Compact 不需要。

### 6.6 HTTP Message Signatures（RFC 9421，2024-02）

- **签名基**（§2.5）：被覆盖的组件逐行排列，`@signature-params` 放最后一行。
- **派生组件**（§2.2）：`@method`、`@target-uri`、`@authority`、`@path`、`@query`、`@status` 等。
- **参数**（§2.3）：`created`、`expires`、`nonce`（"A random unique value"）、`alg`、`keyid`、`tag`。
- **不直接覆盖正文**：§1 "does not define a means to directly cover HTTP message content"。要配合 RFC 9530 的 `Content-Digest`，并且验签方要自己核对摘要和正文一致（§7.2.8）。
- **防重放**：靠 `nonce` 和 `expires`（§7.2.2）。
- **适用范围**：§1 拿它和 JWS 对比："object-based signature mechanisms such as JWS require the intact conveyance of the exact information that was signed"。【推测】9421 适合签"这一次 HTTP 请求"。签完的命令要被转交、存档、日后再验时，签对象（JWS）更合适。

### 6.7 COSE（RFC 9052 / 9053，2022-08，STD 96）

- 结构：`COSE_Sign1 = [Headers, payload, signature]`（RFC 9052 §4.2）。实际签的是 `Sig_structure`，上下文串为 "Signature1"（§4.4）。
- 受保护的头包成字节串，"avoids the problem of all parties needing to be able to do a common canonical encoding"（§3）。用二进制，不用 base64url（§1.3）。
- RFC 9053 §2.1：ECDSA 签名是定长的 R‖S；"Implementations SHOULD use a deterministic version of ECDSA"。§2.2.1：EdDSA "do not need random numbers of any kind"。
- WebAuthn 的公钥就是 COSE_Key 格式（WebAuthn L3 §6.5.1）。
- 【推测】优点是体积小、和 WebAuthn 一致；缺点是要 CBOR 库（Node 没有内建，§8.7），调试和工具链不如 JOSE。

### 6.8 防重放和防挪用：可以组合的手段

| 手段 | 作用 | 出处 |
|---|---|---|
| `jti`，服务端记住到 `exp` | 同一个签名只能用一次 | RFC 7519 §4.1.7；RFC 9449 §11.1 |
| `iat` / `exp` 短窗口 | 旧签名过期作废 | RFC 7519；RFC 9449 §11.1；FAPI Http Signatures 建议 1 分钟 |
| 服务端下发的 nonce / challenge | 签名必须是"刚才"做的，客户端无法提前签好 | RFC 9449 §8、§9；WebAuthn §13.4.3（≥16 字节随机） |
| `aud` | 签给这台守护进程的，拿到别处无效 | RFC 7519；RFC 8725 §3.9 |
| 显式 `typ` / namespace | 一种用途的签名不能拿去当另一种用途 | RFC 8725 §3.11、§3.12；PROTOCOL.sshsig（§10.1） |
| 算法白名单、一把钥一种算法 | 防 `alg` 被替换 | RFC 8725 §3.1 |
| 绑定会话或设备 | 签名只在这台设备的会话里有效 | RFC 9449 `cnf.jkt` |

### 6.9 格式对照

| 格式 | 好处 | 坏处 |
|---|---|---|
| JWS Compact | 签编码后的字节，不用规范化；生态最广，`jose` 无依赖 | 只能有一个签名；base64url 会变长；有 `alg` 混淆的历史问题（RFC 8725 §2.1） |
| JWS JSON | 能多签名，能带不受保护的头 | 有格式混淆的风险（8725bis §2.13） |
| JWS `b64:false` / 分离载荷 | 命令原文保持可读 | 必须写进 `crit`；接收方要重建一模一样的字节，通常要配 JCS |
| JCS + 内嵌签名 | 签完还是 JSON | 只是 Informational；数字受双精度限制；信封格式要自己设计 |
| RFC 9421 | 覆盖方法、URI 等；有 nonce、expires | 正文要配 Content-Digest；签名绑在这一次请求上 |
| COSE_Sign1 | 二进制、体积小；不用规范化；和 WebAuthn 一致 | Node 没有内建 CBOR；工具少 |

## 7. 算法

### 7.1 Ed25519（RFC 8032，2017-01）

- **确定性**：§1 "unique random number for each signature is not required"；§8.2 "EdDSA signatures are deterministic"。
- **大小**：公钥 32 字节；签名 64 字节，R 和 S 各 32 字节（§5.1.5–5.1.6）。
- **验证**（§5.1.7）：
  - 第 1 步解码 S："in the range 0 <= s < L … If any of the decodings fail (including S being out of range), the signature is invalid"。
  - 第 3 步检查 `[8][S]B = [8]R + [8][k]A'`，也允许不带余因子的 `[S]B = R + [k]A'`。
  - 【推测】RFC 允许两种检查，所以不同实现对边缘情况的判定可能不一致。
- **不可塑**（§8.4）："Ed25519 and Ed448 signatures are not malleable due to the verification check that decoded S is smaller than l"。
- **强度**：标称 128 位（§8.5）。
- **JOSE 里的用法**：RFC 8037（2017-01）定义 `kty: "OKP"`（带 `crv`、`x`），`alg: "EdDSA"`，具体曲线由密钥决定。

### 7.2 完全指定的算法标识（RFC 9864，2025-10）

- **RFC 9864**（Proposed Standard，更新 RFC 7518、8037、9053）：
  - 新注册 JOSE 的 `alg` "Ed25519" 和 "Ed448"；COSE 的 Ed25519 = **-19**，Ed448 = -53（§2.2）。
  - 新注册 COSE 的 ESP256 = -9、ESP384 = -51、ESP512 = -52（§2.1）。JOSE 的 ES256 本来就是完全指定的，不受影响。
  - JOSE 的 "EdDSA"，以及 COSE 的 -8、-7、-35、-36，改为 Deprecated（§4.1.2、§4.2.2）。"Deprecated" 的意思是有更好的机制，"SHOULD be utilized in new deployments"（§4.4）。
  - 没有定义完全指定的 RSA 算法（§6.1）。
- **IANA 注册表现状**：
  - JOSE（2026-09-29）：EdDSA = Deprecated；Ed25519 / Ed448 = Optional；ES256 = Recommended+；RS256 = Recommended；PS256 = Optional；ML-DSA-44/65/87 = Optional（来自 RFC 9964）。
  - COSE（2026-08-25）：EdDSA -8 Deprecated；Ed25519 -19 推荐；ES256 -7 Deprecated；ESP256 -9 推荐；RS256 -257 不推荐；PS256 -37 推荐。
- **WebAuthn L3 的态度相反**：pubKeyCredParams 仍建议 -8、-7、-257；-9 和 -19 "are NOT RECOMMENDED"，理由是 "many implementations support the latter identifiers but not the former"（§5.4）。§5.8.5 把 -8 限定为 Ed25519、-7 限定为 P-256。
- 【推测】结果是：JOSE 一侧签名用 "Ed25519"，WebAuthn 一侧仍会收到 -8 / -7。守护进程的验证代码应该按"登记的密钥 + 算法"来验，不能只看签名里的 `alg` 字符串。

### 7.3 ES256（ECDSA P-256 + SHA-256）

- **FIPS 186-5**（2023-02-03）批准三种：RSA、ECDSA（"deterministic ECDSA is also approved"）、EdDSA（"FIPS 186-5 approves the use of EdDSA"）。DSA 只能用来验旧签名（§1）。
- **随机数**（§6.3）："A new secret random number k … shall be generated prior to the generation of each digital signature"，并且要保密。§6.3.2 的确定性 ECDSA 就是为了防 "insufficient randomness in the per-message secret number that would reveal a private key"。
- **RFC 6979**（2013-08）确定性 ECDSA："Even slight biases in that process may be turned into attacks"（§1）；验证方不用改。
- **可塑性**：
  - SEC 1 v2.0 附录 B.3："If signature (r, s) is a valid signature … then so is (r, −s mod n). This is not regarded as a forgery"。
  - FIPS 186-5 §6.4.2 只要求 r、s 在 [1, n−1] 之间，没有 low-S 规定。比特币的 BIP 146 才有 LOW_S 规则。
- 【推测】可塑性不影响"签名证明了什么"。它只在拿签名字节当唯一键时出问题，比如用签名的哈希做去重 ID。去重应该用 `jti` 或被签内容的哈希，不用签名本身。

### 7.4 RS256 / PS256

- RFC 8017（2016-11）：
  - 签名长度等于模长，2048 位就是 256 字节（§8.2.1）；
  - PKCS#1 v1.5 编码 "is deterministic"（§9.2）；
  - "RSASSA-PSS is REQUIRED in new applications"（§8）；PSS 带随机盐。
- 强度：SP 800-57 Pt1 R5 §5.6.1.1 表 2，RSA 2048 位 = 112 位，3072 位 = 128 位。

### 7.5 强度与量子后

- SP 800-186（2023-02）表 1：128 位一档列出了 P-256 和 Edwards25519。
- ML-DSA：
  - FIPS 204 于 2024-08-13 发布。
  - RFC 9964（2026，Proposed Standard）把 ML-DSA 注册进 JOSE / COSE：`kty` 是 "AKP"；ML-DSA-44 公钥 1312 字节，签名 2420 字节。
  - Node 22 的文档里没有 ML-DSA，v24.6.0 才加入。
- 【建议】现在不必考虑量子后，签名格式里留好 `alg` 字段就够了。

### 7.6 各平台的支持（汇总，细节见 §8、§9.3）

| 平台 | ES256（P-256） | Ed25519 | RSA | 出处 |
|---|---|---|---|---|
| Apple passkey | 是，只有这一种 | 否 | 否 | Apple 文档 `ASCOSEAlgorithmIdentifier` 只有 ES256；开发者论坛 710784 |
| Chrome 桌面 Google 密码管理器 passkey | 是，只有这一种 | 否 | 否 | Chromium `passkeys.rs` |
| Windows Hello（WebAuthn） | 是（Windows 11 22H2 起支持 ECC） | `webauthn.h` 里没有这个常量 | 是（兼容 Windows 平台认证器需要 RS256） | Learn webauthn-apis；`webauthn.h`；Chromium `pub_key_cred_params.md` |
| Windows Hello（KeyCredentialManager 应用接口） | 否 | 否 | 只有 RSA-2048 | Learn KeyCredentialManager |
| TPM 2.0（TCG 参考实现默认配置） | 是 | 规范里有定义，默认关闭 | 是 | TCG 参考实现 `TpmProfile_Common.h` |
| 鸿蒙 HUKS | 是（API 8+） | 是（API 8+） | 是 | 华为签名规格页 |
| 浏览器 WebCrypto（软件） | 是 | Chrome 137 / Firefox 129 / Safari 17 | 是 | §8.6 |
| Android Google 密码管理器 passkey | 示例只有 -7 | 【未核实】 | 【未核实】 | developer.android.com |

| 算法 | 签名 | 公钥 | 确定性 | 可塑 | 强度（位） | FIPS 186-5 |
|---|---|---|---|---|---|---|
| Ed25519 | 64 B | 32 B | 是 | 否（有 S<L 检查时） | 128 | 批准 |
| ES256 | JOSE / COSE 64 B；WebAuthn 的 DER 约 70–72 B【推算】 | 65 B（未压缩）【推算】 | 默认否；RFC 6979 可以做成确定性 | 是 | 128 | 批准 |
| RS256 | 256 B | 约 256 B【推算】 | 是 | 没有已知的可塑性【推测】 | 112 | 批准 |
| PS256 | 256 B | 同上 | 否（随机盐） | 设计上就有多个合法签名【推测】 | 112 | 批准 |

## 8. 用户本人在场与硬件密钥

### 8.1 WebAuthn Level 3 / passkey

- **状态**：W3C 推荐标准（Recommendation），2026-08-25。和 2026-05-26 的候选推荐快照相比 "no substantive changes"。
- **签什么**（§6.3.3 第 11 步）："Let signature be the assertion signature of the concatenation authenticatorData || hash"。`hash` 是 clientDataJSON 的 SHA-256。
- **clientDataJSON**（§5.8.1）：`type`（断言时是 "webauthn.get"）、`challenge`、`origin`、`crossOrigin`、`topOrigin`（只在跨源 iframe 里调用时出现）。
- **challenge 的要求**（§13.4.3）："MUST be randomly generated by Relying Parties in an environment they trust (e.g., on the server-side)"；"Challenges SHOULD therefore be at least 16 bytes long"。验证时 challenge 必须等于服务器发出的那个（§7.2）。
- **界面上显示什么**：断言的第 7 步只写 "Collect an authorization gesture confirming user consent for using selectedCredential"，**没有规定显示内容**。只有注册时（§6.3.2 第 6 步）才 "SHOULD display" RP ID、用户名等。
- **标志位**（§6.1）：
  - UP（bit 0）：用户在场（user present）；
  - UV（bit 2）：用户已验证（user verified）；
  - BE（bit 3）：可备份（backup eligible）；
  - BS（bit 4）：已备份（backup state）。
  - BE "MUST NOT change"，BS 可以变。BE=1、BS=1 就是已同步的多设备凭证（§6.1.3）。
- **`userVerification: "required"`**（§5.8.6）：响应里 UV 没有置位，整个仪式就失败。依赖方（relying party，RP）要检查 UP 位，要求 UV 时还要检查 UV 位（§7.2）。UV 用的是指纹、人脸还是 PIN，L3 里拿不到（uvm 扩展已移除）。
- **签名计数**（§6.1.1）：用来发现被克隆的认证器。不实现计数器的认证器 "leave the signCount … constant at zero"。两边都是 0 时，RP 跳过克隆检测（§7.2）。
- **安全上下文**：API 只在安全上下文（secure context）里提供（§5，IDL 带 `[SecureContext]`）。localhost 和 127.0.0.0/8 算安全上下文（W3C Secure Contexts §3.1）。
- **RP ID 的作用域**（§4 "RP ID"）：RP ID 必须等于页面 origin 的有效域名，或者是它的可注册后缀；并且 scheme 是 https，或者 host 是 localhost 且 scheme 是 http；端口不限。
  - 所以经 VPS 域名访问，和在 PC 本机经 `http://localhost:<端口>` 访问，用的是**两把不同的 passkey**。
  - 本机端口只听 127.0.0.1（`docs/developer-guide.md` 的"网关：两个端口"）。用 `http://127.0.0.1:<端口>` 打开时，有效域名是一个 IP 地址，能不能当 RP ID【未核实】；用 `localhost` 打开没有这个问题。
  - Related Origin Requests（§5.11）要求共用一个 RP ID，浏览器从 `https://<rpId>/.well-known/webauthn` 读允许的 origin 列表。【推测】localhost 没有可注册域名（URL Standard §3.2），不能作为 related origin 去用 VPS 域名的 passkey。

### 8.2 把命令放进签名：challenge、交易确认扩展、SPC

**把命令哈希混进 challenge**
- 【推测】`challenge = H(命令的规范化字节 ‖ 服务器随机数 ≥16 字节)` 满足"不可预测"，签名也就间接覆盖了命令。
- 但有三个问题：
  - 字面上和 "randomly generated" 不完全一致。
  - SPC §1.1.1 把这种做法定性为 "a misuse of the challenge field (which is intended to defeat replay attacks)"，并指出 "Plain [webauthn-3] does not provide for this display: there is no specified UX associated with information stored in the challenge field"。
  - 【推测】关键缺陷：用户在认证器界面上看不到命令，只看得到网页自己画的文字。网页被注入脚本，就能让"显示的"和"实际签的"不一致。
- Microsoft Learn 的 WebAuthn API 页把 "Transactional approval" 列为一种能力，并说这类能力 "haven't been observed in the wild yet"（2026-10-08）。

**交易确认扩展的历史**
- WebAuthn Level 1（推荐标准，2019-03-04）有两个扩展：
  - txAuthSimple（§10.2）："A Relying Party can specify a prompt string, intended for display on a trusted device on the authenticator"；认证器 "MUST display the prompt to the user before performing either user verification or test of user presence"；输出的是实际显示的文字。
  - txAuthGeneric（§10.3）：可以用图片当提示。
- Level 2 删掉了它们：issue w3c/webauthn#1386 "Remove unimplemented extensions"（2020-03），理由是 "not implemented and are not testable"；PR #1399 于 2020-04-15 合并。
- 2024-02 的 #2022 "Revised txAuthSimple extension" 于 2025-07-02 关闭，评论提到 "concerns about untrusted text in a trusted UI"。
- Level 3 没有任何交易确认扩展。CTAP 2.3（评审稿，2025-10-23）的扩展列表里也没有。

**Secure Payment Confirmation（SPC）**
- **状态**：W3C 候选推荐草案（CRD），2026-10-13。进入下一阶段要 "two independent, interoperable implementations"。
- **显示**（§4.10）：浏览器 "MUST present the user with a user interface"，必须告诉用户收款方名称或 origin、金额、支付工具；但 "does not require a User Agent to display a particular user interface"。
- **被签数据**：clientDataJSON 的 `type` 是 "payment.get"，里面多一个 `payment` 对象（rpId、topOrigin、total、instrument 等），"cannot be tampered with via JavaScript"（§1.1.1、§5）。RP 要逐项核对 payment 字段和显示给用户的内容是否一致（§9.1）。
- **支持**：Chrome 95 起（Android 从 M109 起），Edge 跟随；Firefox、Safari 不支持。
- 【推测】SPC 是唯一把"浏览器自己画确认界面 + 显示的内容进入被签数据"标准化的方案。但它只管支付语义，也只有 Chromium 支持。二狗能借的是思路：被签数据里带上展示给用户的文字，服务端逐项核对。

### 8.3 平台认证器支持的 COSE 算法

- **规范建议**（L3 §5.4）：pubKeyCredParams "SHOULD include at least" -8（EdDSA）、-7（ES256）、-257（RS256）。列表为空时，客户端默认补上 -7 和 -257（§5.1.3 第 10 步）。
- **Windows Hello**：
  - Windows 11 22H2 起 "WebAuthn APIs support ECC algorithms"（Learn，2026-10-08）。
  - `webauthn.h`（API 版本 9）的算法常量只有 -7、-35、-36、-257、-258、-259、-37、-38、-39，没有 -8 或 -19。
  - Chromium 文档："RS256 is necessary for compatibility with Microsoft Windows platform authenticators"。
  - Windows 是否支持 EdDSA【未核实】。
- **Chrome / Edge 桌面（Google 密码管理器）**：Chromium 源码 `passkeys.rs` 里，请求的算法里没有 -7 就返回 `NoSupportedAlgorithm`，即只支持 ES256。
- **Android**：developer.android.com 的创建 passkey 示例只写了 `"alg": -7`；web.dev 建议同时写 -7 和 -257，"gives complete coverage"。Google 密码管理器在 Android 上用什么算法，没有一手明文【未核实】。
- **iOS / macOS**：`ASCOSEAlgorithmIdentifier` 只定义了 ES256。Apple 员工在开发者论坛（2022-07）说："Passkeys only support ES256 … There's no option exposed for this since it's not configurable"。
- **结论**：如果用 passkey，守护进程必须能验 ES256（DER 编码）；Windows 上可能还要 RS256。

### 8.4 PC 本机：Windows Hello / TPM

见 §9.3。

### 8.5 鸿蒙

**ArkWeb 与 WebAuthn**
- ArkWeb 内核版本（华为《ArkWeb 简介》）：

  | 系统版本 | Chromium 内核 |
  |---|---|
  | HarmonyOS 4.1–5.1 | M114 |
  | HarmonyOS 6.0 | 默认 M132，可选 M114 |
  | HarmonyOS 6.1 | M132 |
  | HarmonyOS 7.0 | 默认 M144，可选 M132 |

  官方让开发者按内核版本自己去查 W3C 标准的支持情况，没有单独的支持列表。
- ArkWeb 的指南和参考（Web 组件的属性、事件、WebviewController）里都没有 WebAuthn 字样，也没有相关回调。M132→M144 差异指南里列了上游 Chromium 的 WebAuthn 特性（`getClientCapabilities()`、Conditional Create），但那是上游特性清单，不等于在第三方 App 里接通了系统认证器。
- 系统的通行密钥（passkey）在 Online Authentication Kit 里，6.0.0(20) 起提供，ArkTS 模块是 `fido2`。要求：
  - App 关联网址域名（App Linking）："FIDO2协议基于应用的网址域名开通应用的通行密钥，开发者的应用需要关联网址域名"；
  - 设备联网；只支持中国境内；
  - 移动端要支持指纹或 3D 人脸（ATL4）。
- 受限权限 `ohos.permission.ACCESS_FIDO2_ONLINEAUTH`，可以申请的场景是"应用需要通过通行密钥服务完成网页免密认证"，要经 AGC 审核。
- "数字盾"网页场景页写着"从API版本26.0.0开始……网页可以通过接入浏览器提供的WebAuthn接口，调用通行密钥（FIDO2）能力"。
- 【推测】普通 App 里的 ArkWeb 不会自动把 WebAuthn 接到系统通行密钥；rpId 还要是 App 关联的域名，页面要 https。二狗的鸿蒙 App 加载守护进程的页面，这条路基本走不通。真机上 `PublicKeyCredential` 是否存在、能否调用【未核实】。

**HUKS（Universal Keystore Kit，通用密钥库）**
- **签名规格**（手机、平板、PC）：
  - ECC P-256/384/521 + SHA256/384/512（"签名是ASN1格式"）：API 8 起；
  - Ed25519：API 8 起；
  - RSA PKCS1 v1.5 / PSS：API 8 起；
  - SM2：API 9 起；ML-DSA：26.0.0 起。
- **私钥不出安全环境**：
  - "对于具备安全环境（如TEE）的系统、设备，HUKS核心层必须运行在安全环境内"；
  - 密钥的"明文仅在安全环境中进行访问操作，不会将明文传递出安全环境"；
  - "除了非对称密钥中的公钥外，密钥的全生命周期……均只能由HUKS在安全存储区使用"；
  - `exportKeyItem` 只能导出公钥（X.509 DER）。
- **用户身份认证访问控制**：
  - **每次使用都认证**："需要在使用密钥的时候，再次要求用户即时地验证锁屏密码或生物特征"。流程是：
    1. `initSession` 拿到 challenge；
    2. 用 `userAuth` 控件带着这个 challenge 认证，拿到 authToken；
    3. `updateSession` / `finishSession` 带上 authToken 完成签名。
    - authToken 里的 challenge 由 HUKS 校验，"UserIAM 与HUKS 的交互位于TEE环境内"。
  - **一段时间内免认证**：基于时间戳的免 challenge 模式（`HUKS_TAG_AUTH_TIMEOUT`）。华为文档没写上限；OpenHarmony 源码里是 6 小时（216000 秒）【OpenHarmony，HarmonyOS 可能不同】。
  - 认证类型 `HUKS_TAG_USER_AUTH_TYPE`：指纹、人脸、锁屏密码（PIN）的组合。
  - 失效条件 `HUKS_TAG_KEY_AUTH_ACCESS_TYPE`："清除锁屏密码后，密钥永久失效"；"录入新的生物特征，该特征下此类密钥将永久失效"；或者总是有效（11+）。
  - `HUKS_TAG_CHALLENGE_TYPE`：NORMAL（默认 32 字节）、CUSTOM（多个密钥共享一次认证）、NONE。
  - `HUKS_TAG_IS_DEVICE_PASSWORD_SET`（11+）：只有设置了锁屏密码时才能用。
  - 会话"不建议超过1分钟"。
- **密钥证明**（key attestation）：
  - "业务方可以通过系统提供的根CA证书，逐级验证……确保证书中的公钥以及对应的私钥，确实来自合法的硬件设备，且存储管理在HUKS中"。
  - "三方应用开发者只能使用匿名密钥证明"：`anonAttestKeyItem`（11+，要联网）；`anonAttestKeyItemOffline`（26.0.0 起）。Ed25519 的匿名证明 16 起支持。
  - 服务端可以用华为公布的根证书（"Huawei CBG ECC Device Attestation Root CA"）验证书链。
  - 证书里的声明有 challenge、应用 ID、密钥来源、产品型号等，**没有列出"是否要求用户认证"**。所以证明不了这把钥带着指纹 / 密码要求。
- **系统认证弹窗能显示什么**：
  - `WidgetParam.title`（10+）："最大长度为500字符。标题会显示在认证界面"；`navigationButtonText` 最多 60 字符；`AuthParam.challenge` 最多 32 字节。
  - "三方应用调用系统本地身份认证能力，必须使用系统自带的身份认证控件"；"不允许三方应用在后台发起身份认证请求"。
  - 官方没说这个弹窗是可信界面，标题也不进 authToken。【推测】签名证明不了用户在弹窗上看到了什么。
  - `reuseUnlockResult` 能复用最多 5 分钟内的解锁结果。要求本人在场时不该开它。
- **数字盾**（Device Security Kit 的 TrustedAuthentication，6.0.0(20) 起）：
  - 这是唯一能把要确认的内容放到可信界面上并签进去的能力："界面防篡改：TUI展示的关键信息……采用TEE图形渲染通道"；"确保交易完整性与不可抵赖性"。
  - 流程：`procContentAuthentication` 在可信界面（TUI）上显示交易信息 → 用户输入数字盾密码或做生物识别 → 拿到"携带交易信息hash的authToken" → 用设了 `HUKS_SECURE_SIGN_WITH_AUTHINFO` 的 P-256 密钥签名（签名前会附加 41 字节认证信息）。
  - 规格：每条内容不超过 1024 字节，超过 19 行拒绝拉起；TUI 标题不超过 31 字节。
  - **门槛**："申请本服务前，需于华为开发者联盟完成企业开发者实名认证"，还要 AGC 审核；定位是金融企业应用；只支持中国境内。

**JS 桥（ArkWeb → 网页）**
- `registerJavaScriptProxy(jsObject, name, methodList, asyncMethodList?, permission?)`，后两个参数从 API 12 起。方法可以返回 Promise。注入的对象"在页面下一次（重新）加载前不会出现在JavaScript中"。
- 安全原文："请尽可能只在可信的URL及安全通信HTTPS场景下进行registerJavaScriptProxy注册"；"应用会将JavaScript对象暴露给所有的页面frames"（javaScriptProxy 属性："包括所有iframe"）。
- **URL 白名单**：在 `permission` 里配 `javascriptProxyPermission.urlPermissionList`，分对象级和方法级，两者取交集；scheme、host 精确匹配（host 不支持通配符），path 按前缀匹配；"不支持file协议"。白名单校验的是 iframe 自己的 URL 还是顶层页面的 URL，华为文档没说【未核实】。
- **二狗现状**：鸿蒙 App 已有的桥 `window.ergoNative` 做了两层（`frontend/harmony/entry/src/main/ets/bridge/NativeBridge.ets`）：一层是上面的白名单；另一层是每次调用再核对，主框架（`controller.getUrl()`）和调用的框架（`controller.getLastJavascriptProxyCallingFrameUrl()`）都必须是配好的来源，而且去掉 `#` 后网址相同，否则不做事。文档记的残留风险是"同一来源、网址和主框架一模一样的 iframe 分不出来"。

**这一节的含义【推测】**：鸿蒙上"本人在场 + 不可导出密钥"有现成的能力（HUKS + userAuth），"所见即所签"没有。能做可信显示的数字盾，个人开发者用不了。

### 8.6 浏览器 WebCrypto：纯软件方案

**Ed25519 支持**

| 浏览器 | 版本 | 出处 |
|---|---|---|
| Chrome | 137（2025-05-27 稳定版） | Chrome 137 release notes；chromestatus 4913922408710144 |
| Edge | 137（跟随 Chromium） | MDN browser-compat-data |
| Firefox | 129（2024-08-06） | MDN 的 Firefox 129 发布说明 |
| Safari | 17.0（2023-09） | Safari 17 release notes；WebKit 博客 |

- MDN browser-compat-data 的 `SubtleCrypto` 数据和上表一致。
- Safari 的 Ed25519 签名是随机化的（按 draft-irtf-cfrg-det-sigs-with-noise），不是 RFC 8032 的确定性签名。【推测】这不影响验签。
- 规范：W3C Web Cryptography Level 2 首个公开工作草案（2025-04-22）已经包含 Ed25519（§25）和 X25519。验签时对小阶点返回 false，但 "Not all implementations perform this check"（Issue 2、3）。

**不可导出的 CryptoKey 存 IndexedDB：边界在哪**
- CryptoKey 可以结构化克隆（"CryptoKey objects are serializable objects"，§13.5），实际一般存进 IndexedDB（§5.2）。
- `extractable: false` 只挡导出：exportKey 第 7 步 "If the [[extractable]] internal slot of key is false, then throw an InvalidAccessError"。`sign` 只检查密钥是不是私钥，不检查 extractable。
- 也就是说，**注入的脚本能用、不能偷**。规范自己说脚本注入 "equivalent to remote code execution"、"may allow for the exfiltration of keys or data"；还说 "Any application or user that has access to the device storage may be able to recover the key material"（§6.2）。
- 没有用户在场：WebCrypto 没有任何手势或验证要求【推测，规范里没有相关机制】。
- 私钥存在哪里：Chromium 源码 `ed25519.cc` 的克隆反序列化注释是 "The serialized data will be either SPKI or PKCS8 formatted"。【推测】Chrome 把私钥的 PKCS#8 字节写进 IndexedDB 的序列化数据，是软件密钥，不进系统密钥库或硬件。Firefox、Safari【未核实】。
- 清站点数据就丢。Safari 的智能防跟踪（ITP）会在 "seven days of Safari use without user interaction on the site" 之后删掉脚本可写的存储（含 IndexedDB）。加到主屏的 Web App "have their own counter of days of use"，实际上不受影响（WebKit 博客，2020-03-24）。

### 8.7 Node.js 22

- **`node:crypto`**（文档版本 v22.23.3）：
  - `crypto.verify(null, data, key, sig)`：v12.0.0 加入；"If algorithm is null or undefined, then the algorithm is dependent upon the key type (especially Ed25519 and Ed448)"。
  - ES256：`crypto.verify('sha256', data, {key, dsaEncoding: 'ieee-p1363'}, sig)` 验 JOSE 的 R‖S；默认的 `'der'` 验 WebAuthn 的 DER。
  - `createPublicKey` 从 v15.12.0 起接受 JWK（`format: 'jwk'`）；v22 的源码接受 `kty: 'OKP'`、`crv: 'Ed25519'`。
- **WebCrypto**：v22.13.0 起 "Algorithms Ed25519 and X25519 are now stable"（PR nodejs/node#56142）。
- **WebAuthn**：
  - 验断言只需要 `node:crypto`：对 clientDataJSON 取 SHA-256，再验 `authData ‖ hash` 的签名（WebAuthn L3 §7.2）。ES256 用默认的 DER 编码。
  - 注册时的 attestationObject 是 CBOR，Node 没有内建 CBOR。【推测】不需要 attestation 时，浏览器的 `getPublicKey()` 直接给 SPKI 格式的公钥（§5.2.1.1，-7、-257、-8 都必须能给），交给 `createPublicKey` 就绕开了 CBOR。
  - 文档没写的实现细节：Node / OpenSSL 的 Ed25519 验签是否强制 S < L，ECDSA 验签是否拒收 high-S【未核实】。
- **npm 包**（查 registry，2026-10-14；只列事实，没有安装）：
  - `jose` 6.2.12（2026-09-05）：没有依赖，MIT 许可；5.10.0 / 6.0.0 起支持完全指定的 "Ed25519"；v6 起只用 WebCrypto，去掉了 Ed448。
  - `@simplewebauthn/server` 14.0.3（2026-09-25）：要求 node >= 20；10 个依赖（@peculiar/x509、@hexagon/base64、reflect-metadata、@levischuck/tiny-cbor，以及 6 个 @peculiar/asn1-* 包）。

## 9. 密钥管理

### 9.1 NIST SP 800-57 Part 1 Rev.5（2020-05）

- **生命周期**（§8）：四个阶段，pre-operational、operational、post-operational、destroyed。密钥状态（§7）：pre-activation、active、suspended、deactivated、compromised、destroyed。
- **密钥使用期（cryptoperiod）**（§5.3）："the time span during which a specific key is authorized for use by legitimate entities"。
- **建议期限**（§5.3.6、表 1）：
  - 签名私钥："about one to three years"，"shall be destroyed at the end of its cryptoperiod"；
  - 验证公钥："Several years (depends on key size)"。有可信时间戳时，私钥过期后公钥仍能验证 "timestamps within the cryptoperiod" 的签名。
- **谁来生成**（§8.1.5.1.3）：集中生成的签名密钥对 "will not provide strong support for non-repudiation… subscribers should generate their own signing key pairs"。
- **备份**（表 7）：签名私钥 "No (in general); support for non-repudiation would be in question"。
- **登记公钥时**（§8.1.5.1.1）：接收方要确认 "The owner actually possesses the corresponding private key"，并且知道这把钥的用途。
- **泄露**：
  - §5.5.1：签名私钥泄露后，"the integrity and non-repudiation qualities of all data signed by that key are suspect"。泄露前已经由别的机制保护的签名（比如有可信时间戳）仍有一定价值。
  - §7.5："A compromised key shall not be used to apply cryptographic protection"；对应的公钥只能 "under highly controlled conditions" 用于验证；"The transition shall be recorded"。
  - §8.3.5 吊销："should be revoked as soon as feasible"，依赖方 "need to be notified"。
- **Rev.6**：只有初始公开草稿（2025-12-05，评论期到 2026-02-05），没有终稿。表 1 的数值不变，节号改到 §4.3.x。

### 9.2 NIST SP 800-63B-4（终稿 2025-07-31）

- **认证器保证等级（AAL）**：
  - AAL2："Verifiers SHALL offer at least one phishing-resistant authentication option at AAL2"（§2.2）。
  - AAL3："SHALL have a non-exportable private key and SHALL provide phishing resistance"；可同步的认证器 SHALL NOT 用于 AAL3（§2.3.2）。
  - 不可导出（§3.2.13）："SHALL be designed to prohibit the export of the authentication secret to the host processor"。
  - 表 1（非规范性汇总）：

    | 要求 | AAL1 | AAL2 | AAL3 |
    |---|---|---|---|
    | 抗钓鱼（phishing resistance） | 不要求 | 建议，且必须提供可选项 | 必须 |
    | 认证意图（authentication intent） | 不要求 | 建议 | 必须 |
    | 密钥可导出 | 允许 | 允许 | 禁止 |

- **抗钓鱼**（§3.2.5）："prevent the disclosure of authentication secrets and valid authenticator outputs to an impostor verifier … without relying on the vigilance of the claimant"。两种做法：信道绑定（channel binding，§3.2.5.1）和验证者名称绑定（verifier name binding，§3.2.5.2："cryptographically bound to a verifier identifier"）。这一版术语表里 "Verifier impersonation" 只写了 "See phishing"。【未核实：WebAuthn 归入验证者名称绑定、信道绑定更强，这两点没有取到逐字原文】
- **可同步认证器**（附录 B）：
  - "may be offered… up to AAL2"；"syncing violates the non-exportability requirements of AAL3"。
  - 验证方可以看 BE / BS 标志，必须检查 UV。
  - 应假定 "all syncable authenticators may be subject to sharing"；集中吊销 "is challenging"。
- **认证意图**（§3.2.8）：认证器要 "require the claimant to respond explicitly to each authentication or reauthentication request"，防止被 "used without the claimant's knowledge, such as by malware on the endpoint"；"The authenticator itself SHALL establish authentication intent"。
- **交易签名**：800-63B-4 里没有交易确认或交易签名的要求。
- **丢失、作废、绑定新认证器、恢复**：
  - §3.2.1：用户报告丢失、被盗或疑似泄露后，"SHALL provide a mechanism to invalidate the authenticator immediately"。
  - §4.5：作废（"sometimes referred to as revocation or termination"）要 "promptly"。
  - §4.1.2："SHALL permit the binding of multiple authenticators"。
  - §4.1.2.1：绑定新认证器的通知要 "via a mechanism independent of the transaction binding the new authenticator"。
  - §4.1.2.2 跨设备绑定（Binding Across Endpoints）：
    - 由已认证的设备或者新设备申请一个绑定码（binding code），用手输或二维码在两台设备间传；
    - "SHALL NOT be communicated over any insecure channel (e.g., email)"；
    - 熵：有标识符时 ≥40 bit，没有时 ≥112 bit；
    - 最长 10 分钟，只能用一次；
    - SHOULD 让用户用新认证器认证一次，确认绑定成功。
  - §4.2 恢复：保存的恢复码（≥64 bit，用后作废）、发放的码、恢复联系人、重新做身份核验【这一条取自摘要，不是逐字】。
  - §4.6：绑定新认证器、账户恢复都要通知用户。
- **重新认证的时限**：AAL2 总时长 SHOULD ≤24 小时、不活动 SHOULD ≤1 小时；AAL3 总时长 SHALL ≤12 小时、不活动 SHOULD ≤15 分钟（§2.2–2.3）。旧版 800-63B-3 的 AAL2 是 12 小时 / 30 分钟。
- **不可抵赖的定义**：SP 800-63-4 写的是 "The capability to protect against an individual falsely denying having performed a particular transaction"。

### 9.3 PC 本机：Windows Hello / TPM

- **Windows Hello for Business 的密钥**（Learn "How it works"）：
  - "The key pair is bound to the… TPM, if available, or in software"；
  - "The private key is stored locally and protected by the TPM, and can't be exported"；
  - 没有 TPM 时在软件里加密保存；要确保在硬件里生成，"you must configure a policy setting"。
- **Platform Crypto Provider**（CNG 的 TPM 密钥存储提供程序，Windows 8 起）：
  - "can create keys in the TPM with restrictions on their use"；"that key truly can't leave the TPM"；有字典攻击防护。
  - 用 `NCryptOpenStorageProvider(…, MS_PLATFORM_CRYPTO_PROVIDER, 0)` 打开。
  - Learn 没列它支持哪些算法和曲线。【未核实：能否生成 P-256 没有找到逐字原文】
- **TPM 与 Ed25519**：TCG 参考实现定义了 `TPM_ECC_CURVE_25519`（0x0040）和 `TPM_ALG_EDDSA`，但默认配置里 `ALG_EDDSA`、`ECC_CURVE_25519` 是 NO，`ECC_NIST_P256`、`ALG_ECDSA` 是 YES。主流 PC 的 TPM 是否实现 Ed25519【未核实】。
- **KeyCredentialManager**（Windows Hello 的应用接口）：
  - "key credentials, which are RSA 2048-bit keys"。
  - `RequestSignAsync(IBuffer data)`："Prompts the user to cryptographcally sign data using their key credential"（原文拼写如此）。参数是任意数据，签名时 Windows 要求 PIN 或生物识别。
  - "An application can never use the keys from another application"；"It doesn't sync across devices"；只有 TPM 2.0 才有密钥证明；PIN 重置后旧密钥丢失。
  - 文档自相矛盾的两处：签名填充（类备注写 RSA-PSS，示例用 PKCS#1 验签）；是否需要用户手势（Hello for Business 页说不需要，开发页说需要）【未核实，要实测】。
  - "Most methods that follow the Request naming pattern… aren't supported in desktop apps"。KeyCredentialManager 有带窗口句柄的 `RequestCreateForWindowAsync`，`RequestSignAsync` 有没有桌面版本没找到【未核实】。Node 进程调用这些要原生模块。
- **Credential Guard** 保护的是 Windows 登录凭据，不是应用的签名密钥。

## 10. 先例

### 10.1 OpenSSH 签名与 Git

- **PROTOCOL.sshsig**（openssh-portable，v1.5）：
  - 被签数据（§3）：`MAGIC_PREAMBLE "SSHSIG"`、`namespace`、`reserved`、`hash_algorithm`（sha256 / sha512）、`H(message)`。
  - namespace："an unambiguous interpretation domain… prevents cross-protocol attacks caused by signatures intended for one intended domain being accepted in another"；"MUST NOT be the empty string"。
  - 固定前缀保证这类签名 "can never be confused with any message signed during SSH user or host authentication"。
- **ssh-keygen(1)**：
  - `-Y sign -n <namespace>`；自定义用途建议用 "NAMESPACE@YOUR.DOMAIN pattern"。
  - `-Y verify -f <allowed_signers> -I <principal> -n <namespace> -s <sig>`，可以加 `-r` 指定吊销清单。
  - `-Y check-novalidate` 只检查签名结构，不检查签名者是否被授权。
  - ALLOWED SIGNERS 文件：每行是 principals + 选项 + 公钥。选项有：
    - `namespaces=`："a pattern-list of namespaces that are accepted for this key"；
    - `valid-after=`、`valid-before=`：有效时段；
    - `cert-authority`。
  - KRL（Key Revocation List，密钥吊销清单）：`-k` 生成、`-u` 更新、`-Q` 查询。
- **Git**（2.56.0）：
  - `gpg.format=ssh`；`user.signingKey`。
  - `gpg.ssh.allowedSignersFile`："A file containing ssh public keys which you are willing to trust"。
  - "Git will mark signatures as valid if the signing key was valid at the time of the signature's creation. This allows users to change a signing key without invalidating all previously made signatures"。
  - `gpg.ssh.revocationFile`：KRL 或公钥列表，命中的信任级别记为 "never"。
  - Git 固定用 namespace "git"。
- **借鉴【推测】**：按用途分域（namespace）；允许名单带有效期；吊销单独放一个文件；按"签名那一刻"判断钥是否有效。

### 10.2 Sigstore

- Fulcio "issues a short-lived certificate bound to the provided identity and public key"，有效期 10 分钟；"Signatures are generated with ephemeral signing keys so there's no need to manage keys"。
- Rekor 是 "an immutable, append-only ledger"。安全模型："users are responsible for monitoring the log for unauthorized certificates issued to their identities"；"If no third parties monitor the logs… misbehavior… might go undetected"。
- **借鉴【推测】**：把每条已签的命令，连同签名和公钥指纹，追加进只增日志，用户就能查"以我名义签过什么"。单机没有第三方监督，日志能不能防篡改，取决于有没有外部锚点。

### 10.3 FIDO 交易确认

- FIDO UAF Overview v1.2 §3.5：设备有交易确认显示能力时，"supports What You See is What You Sign mode (WYSIWYS)"。
- UAF Protocol v1.2 §3.5.1.1：交易的 `content` "to be shown to the user"；`contentType` 按认证器元数据里声明的。
- UAF Authenticator Commands v1.2 §6.3：
  - 交易内容在可信屏幕上显示，被签数据里放 `TAG_TRANSACTION_CONTENT_HASH`；
  - 有交易确认屏幕的认证器 "MUST display provided transaction content"；
  - "MUST NOT process Sign command without verifying the user first"。
- 显示分级（FIDO Registry §3.5）：ANY、PRIVILEGED_SOFTWARE、TEE、HARDWARE、REMOTE（"provided on a distinct device from the FIDO User Device"）。元数据字段是 `tcDisplay`、`tcDisplayContentType`。
- FIDO2 / CTAP 没有对应功能（§8.2）。
- **借鉴【推测】**：普通网页的显示属于最低一档。"电脑上发起、手机上确认"对应 REMOTE 这一档。

### 10.4 银行交易签名

- **PSD2 RTS 第 5 条"动态链接"**（dynamic linking；委托条例 (EU) 2018/389。EUR-Lex 原文抓取被拦，条文取自欧盟银行管理局 EBA 问答里的引文）：
  - 5(1)(a) "the payer is made aware of the amount of the payment transaction and of the payee"；
  - 5(1)(b) 认证码 "specific to the amount… and the payee"；
  - 5(1)(c) 收款方接受的认证码要 "corresponds to the original specific amount… and to the identity of the payee"；
  - 5(1)(d) "any change to the amount or the payee results in the invalidation of the authentication code"；
  - 5(2)：金额和收款方在认证的全过程中、以及 "the information displayed to the payer"，都要保证机密性、真实性、完整性。
- **U 盾**（工行旗下华商银行《通用 U 盾介绍》，2022-02-14）：
  - "通过数字证书对电子银行交易数据进行加密、解密和数字签名，确保电子银行交易保密和不可篡改"；
  - "请您仔细核对 U 盾屏幕上回显的交易信息，确认无误后，再点击"OK"键"；
  - 丢失后挂失，挂失后所有渠道都不能用。
- EMV CAP 没有公开的一手规范。
- **借鉴【推测】**：签名绑定关键参数，改了任何一个关键参数签名就失效；显示给用户的信息本身也要受完整性保护。

### 10.5 Signal

- **安全码**（safety number）：
  - "allows you to verify the security of your messages and calls"；同时写明 "This does not verify anyone's identity"。
  - 安全码变化时会提示；已标记验证的联系人，"any change must be manually approved"。
  - 核对方式：当面扫码，或者比对数字。
  - 生成方式：两个 30 位数字指纹排序后拼接（官方博客，2016-11-17）。
  - X3DH §4.1："If authentication is not performed, the parties receive no cryptographic guarantee"。
- **关联设备**：在主设备上先验证解锁码或生物识别，再扫新设备显示的二维码。主设备 30 天不上线，全部关联设备解绑；单台设备 45 天不活动就解绑；最多 5 台。
- **借鉴【推测】**：配对新设备时，两边屏幕显示同一个公钥指纹，用户带外核对；由主设备批准；限制设备数量，长期不用自动解绑。

### 10.6 TUF（The Update Framework，规范 v1.0.37）

- "compromise a single key or less than a given threshold of keys, cannot compromise clients"（§1.5.2）。
- 换根：新的 root.json 要 "with both the new and old root keys" 签名（§6.1）。
- "Clients MUST NOT trust an expired file"；不许用版本号更小的元数据替换当前的（§4.3）。这防的是冻结攻击和回滚攻击。
- **借鉴【推测】**：已登记设备公钥的清单本身可以由一把根密钥签发，带版本号和过期时间。

## 11. 没核实、没查到的

1. **引文**：都是摘要工具截取的片段（单段 ≤125 字符），没有整句逐字比对。
2. **OAuth**：
   - RFC 9700 前半部分、RFC 8693、RFC 9396 是否出现 non-repudiation，没有专门查；RFC 9449、9635 末尾的参考文献和作者区没读。
   - OAuth 2.1 -16 的工作组状态，datatracker 页面上没有显示。
   - FAPI 2.0 Message Signing 终版页面仍写着 "not an OIDF International Standard"，和 OIDF 列表上的 "Final Specification" 对不上。FAPI-CIBA 的版本标注也不一致。
   - FAPI 2.0 Http Signatures 没有限定签名算法。
   - GNAP 2023 年之后的采用情况没有官方资料。
   - "nginx + ssh 反向隧道 + RFC 9440" 是否可行，是推测。
3. **MCP 与 agent 标准**：
   - MCP 2026-07-28 的确切发布日期（页面只有版本号）；SEP-2672 具体签了哪些字段。
   - OIDF 白皮书的引文取自 arXiv 版，章节号以 arXiv 版为准。
   - AAuth 草案后半（含安全考虑）、ARAP §14 之后、ID-JAG 附录 A.4 正文没有读完。
   - Visa TAP 的正式规范细节（签名覆盖的组件、算法）。
4. **WebAuthn**：
   - 规范里没有"认证器不显示 challenge"的明文，只有 SPC §1.1.1 和 §6.3.3 第 7 步这两条间接依据。
   - §7.2 里各检查的步号没核实。
   - Apple、Google 的同步 passkey 是否固定返回 signCount = 0。
   - Windows 是否支持 EdDSA；Android 上 Google 密码管理器的算法；Chrome 对安全密钥支持 EdDSA 的起始版本。
   - Related Origin Requests 的浏览器支持版本没查。
   - 用 `http://127.0.0.1` 打开本机端口时能不能用 WebAuthn（IP 地址能否当 RP ID）。
5. **浏览器 WebCrypto**：Firefox、Safari 的私钥存在哪里；Chrome 的结论是从源码推出来的，磁盘上是否加密也没核实。
6. **鸿蒙**：
   - 第三方 App 里的 ArkWeb 能否用 WebAuthn，要上真机测。
   - "26.0.0" 对应哪个 HarmonyOS 版本。
   - `HUKS_TAG_AUTH_TIMEOUT` 在 HarmonyOS 上的上限（6 小时只来自 OpenHarmony 源码）。
   - 系统认证弹窗是否在 TEE 里渲染，标题是否受防篡改保护。
   - `urlPermissionList` 校验的是 iframe 的 URL 还是顶层页面的 URL。
   - 密钥证明的证书里有没有未公开的、表明用户认证要求的字段。
7. **Node**：Node / OpenSSL 的 Ed25519 验签是否强制 S < L、用不用余因子检查；ECDSA 验签是否拒收 high-S。
8. **算法**：RFC 6979 里"重复的 k 会泄露私钥"这句原文没找到；8725bis 卡在等哪份引用；RFC 9964 的确切发布日。
9. **NIST**：800-63B-4 里 WebAuthn 归入哪种绑定、§4.2 恢复码的细节，都是摘要，不是逐字。
10. **Windows**：Platform Crypto Provider 的算法列表；KeyCredentialManager 能否被未打包的桌面进程调用、签名填充方式、是否需要用户手势；只有本地账户时能否启用 Windows Hello；主流 PC 的 TPM 是否实现 Ed25519。
11. **先例**：PSD2 条文来自 EBA 问答引文，不是 EUR-Lex 原文；EMV CAP 没有公开规范；Signal 安全码的具体算法没有官方规范。

## 12. 对二狗的启示【建议】

下面只列从调研里得出、对设计方案有用的要点，不替用户定整体方案。

1. **OAuth 不提供命令级的不可抵赖，签名要另做**（§3.2）。签的应该是"命令对象"，不是"HTTP 请求"：DPoP 和 RFC 9421 都绑在一次请求上，DPoP 还不覆盖正文（§4.1、§6.6）。
2. **不必起授权服务器，也不必跑授权码流程**（§3.6）。守护进程直接当验证方。从 OAuth 借原则（RFC 9700 的发送方约束、受众限制、最小权限、短时效）和数据结构，不借整套流程。
3. **验签放在守护进程这段确定性代码里，agent 只拿到"验过了"的事实。**
   - 依据：wimse-aims §8 要求 LLM 不碰凭证；local-tool-call-proof 把签发方放在 agent 进程之外（§5.2）。
   - 这样"这只是转述"就不再是某个模型的判断题：评审或范围审视看到的是守护进程写下的"某某授权项已由用户签名，验签通过"这条记录，而不是对话里的一句话。
4. **秘书转达时，原样转交用户签过的对象；效力来自用户签名，不来自秘书。** RFC 8693 §4.1 只认当前执行者，之前的执行者"仅供参考"（§4.4）。可以照 `sub` / `act` 的形状记下"谁转的"，只供审计。
5. **授权项格式可以照搬 RAR 的 `authorization_details`**（§4.3）：
   - `type` 用自己的命名空间（例如 `urn:ergo:grant:...`），加上 `actions`、`identifier`、`datatypes`；
   - 次数、有效期、所属阶段放进 type 自己定义的字段；
   - 守护进程不认识的 `type` 一律拒（RAR §5）。
   - 这和 CONTEXT.md 里授权项的定义能对上。
6. **被签的对象由守护进程生成和规范化；展示给用户的文字也由守护进程从结构化命令渲染，不让 agent 写。**
   - 依据：AAuth §7.4 承认 agent 写的同意页文字不可信；local-tool-call-proof 的审批摘要由签发方生成；SPC 把显示的内容放进被签数据，服务端逐项核对；PSD2 第 5 条要求改了关键参数签名就失效（§5.2、§8.2、§10.4）。
   - 调研 07 §6.3 的 `challenge = H(approvalId ‖ canonicalActionHash ‖ nonce ‖ expiry)` 和这些依据一致。
7. **签名格式可以用 JWS Compact**（§6.1、§6.3、§6.8）：
   - 显式 `typ`，每种用途一个（参照 PROTOCOL.sshsig 的 namespace），防止一种签名被挪作他用；
   - 带 `aud`、`jti`、`iat` / `exp`、服务器 nonce；`jti` 记到过期为止；
   - 验签时用算法白名单，一把钥一种算法（RFC 8725 §3.1）；
   - 不需要 JCS。
   - 如果走 WebAuthn，签名就是断言本身（authenticatorData、clientDataJSON、签名），守护进程把它和命令原文一起存。
8. **算法**（§7）：
   - 验证端至少支持 ES256（两种编码：JOSE 的 R‖S 和 WebAuthn 的 DER）和 Ed25519；Windows Hello 走 WebAuthn 时可能还要 RS256。
   - Node 自带的 `node:crypto` 就够，不必引依赖；`jose` 是无依赖的可选项（§8.7）。
   - JOSE 头里写 "Ed25519" 还是 "EdDSA" 两边都要认（RFC 9864 和 WebAuthn L3 的态度相反）。验签时按"登记的密钥 + 算法"验，不信签名里自报的 `alg`。
9. **"本人在场"在三条路上的事实，供定方案时选：**
   - **PC 和手机浏览器**：WebAuthn passkey，`userVerification: "required"`，检查 UV 位。用户看不到命令。经 localhost 和经 VPS 域名访问是两把不同的 passkey（§8.1）。
   - **鸿蒙 App**：HUKS 密钥 + 每次使用都认证（challenge 模式，不开 `reuseUnlockResult`），经 JS 桥给网页。签名方法可以挂在现有的 `window.ergoNative` 上，沿用它的两层核对（§8.5）。报告页的 HTML 预览是 `<iframe sandbox>`，网址和主框架不同，过不了第二层。认证弹窗的标题能放命令摘要，但标题不进签名。
   - **纯 WebCrypto**：只能证明"这台浏览器"，证明不了本人在场；注入的脚本能直接用钥签名（§8.6）。
10. **"所见即所签"做不到硬件级，要写进威胁模型。**
    - 除了数字盾（个人开发者用不了），所有路径的显示都在二狗自己的页面上。
    - 签名能防"agent 伪造用户授权"和"设备 cookie 被偷后冒充"，防不了"页面被注入脚本后改显示"。
    - 【推测】CIBA `binding_message` 那样的双设备对照能降低这个风险：PC 发起、手机确认，两边显示同一个短码或摘要（§4.5、§10.3 的 REMOTE 档）。
11. **签名密钥的注册可以和设备配对绑在一起**（§9.1、§9.2、§10.5）：
    - 每台设备自己生成密钥，只上传公钥；登记时让设备对服务器的 challenge 签一次，证明持有私钥（SP 800-57 §8.1.5.1.1）。
    - 现在配对请求卡上的 8 位十六进制短指纹是由配对 cookie 推出来的（`docs/developer-guide.md` 的"设备配对"）。如果改成由设备公钥推出，就成了 Signal 式的公钥核对。
    - 跨设备绑定的参数可以参考 800-63B-4 §4.1.2.2：10 分钟、只用一次、规定熵、不走不安全的信道。
12. **公钥登记表可以照 allowed_signers 的样子**（§10.1）：
    - 每行记设备、允许的用途、有效时段、算法、吊销标记。
    - 按"签名那一刻这把钥是否有效"来判断历史记录，这样换钥不会作废旧记录。
    - 吊销设备时，同时吊销它的签名公钥（和现有的 `revoke(deviceId)` 联动）。
    - 私钥泄露时，它签过的东西都存疑，按泄露的时间点处理（SP 800-57 §5.5.1）。
13. **轮换和恢复**（§9）：
    - 签名私钥建议用 1–3 年（SP 800-57 表 1）。设备凭证现在是 365 天，可以对照着定。
    - 丢设备时要能立即作废（800-63B-4 §3.2.1）。至少要有第二台能签名的设备，或者一个恢复码（≥64 bit，用后作废）。
    - "PC 本机作为根"要先实测：Windows Hello 的应用接口只有 RSA-2048，桌面程序能不能调用没有核实；TPM 默认配置不支持 Ed25519（§9.3）。
14. **签名留存进只增日志。** 每条签名连同被签原文、公钥指纹、验证结果写进事件日志，用户能查"以我名义签过什么"。依据：Rekor（§10.2）、FAPI 2.0 MS §7 的防篡改审计日志、wimse-aims §11（"MUST be tamper-evident"）。
15. **可同步 passkey 是个取舍**（§9.2）：用起来方便，但难以集中吊销，也可能被共享（800-63B-4 附录 B）。如果要"就是这台设备"的语义，就检查 BE / BS 标志。
16. **签"带约束的委托"比逐条签更可行。** OIDF 白皮书说逐个动作都让人批 "is impossible"，审批疲劳会让人 "reflexively approving"（§5.3）。AP2 的 open mandate 和 Verifiable Intent 的 L2 都是让用户签一份带约束的委托书，再让 agent 在约束内行事（§5.4）。二狗的计划确认、授权项本来就是这个形状，签名可以加在"确认计划 / 确认授权项变更"这一步上。

## 13. 来源

**OAuth 与 OpenID**

- RFC 6749 The OAuth 2.0 Authorization Framework（2012-10）：https://www.rfc-editor.org/rfc/rfc6749.html
- RFC 6750 Bearer Token Usage（2012-10）：https://www.rfc-editor.org/rfc/rfc6750.html
- draft-ietf-oauth-v2-1-16（2026-09-03）：https://www.ietf.org/archive/id/draft-ietf-oauth-v2-1-16.html ；版本历史：https://datatracker.ietf.org/doc/draft-ietf-oauth-v2-1/history/
- RFC 9700 OAuth 2.0 Security Best Current Practice（BCP 240，2025-01）：https://www.rfc-editor.org/rfc/rfc9700.html
- RFC 7636 PKCE（2015-09）：https://www.rfc-editor.org/rfc/rfc7636.html
- RFC 9449 DPoP（2023-09）：https://www.rfc-editor.org/rfc/rfc9449.html
- RFC 7638 JWK Thumbprint（2015-09）：https://www.rfc-editor.org/rfc/rfc7638.html
- RFC 8705 OAuth 2.0 Mutual-TLS（2020-02）：https://www.rfc-editor.org/rfc/rfc8705.html
- RFC 9440 Client-Cert HTTP Header Field（2023-07）：https://www.rfc-editor.org/rfc/rfc9440.html
- RFC 9396 Rich Authorization Requests（2023-05）：https://www.rfc-editor.org/rfc/rfc9396.html
- RFC 8693 Token Exchange（2020-01）：https://www.rfc-editor.org/rfc/rfc8693.html
- RFC 9101 JAR（2021-08）：https://www.rfc-editor.org/rfc/rfc9101.html
- RFC 9126 PAR（2021-09）：https://www.rfc-editor.org/rfc/rfc9126.html
- RFC 9701 JWT Response for Token Introspection（2025-01）：https://www.rfc-editor.org/rfc/rfc9701.html
- draft-ietf-oauth-transaction-tokens-11（2026-07-30）：https://www.ietf.org/archive/id/draft-ietf-oauth-transaction-tokens-11.html ；历史：https://datatracker.ietf.org/doc/draft-ietf-oauth-transaction-tokens/history/
- RFC 9635 GNAP（2024-10）：https://www.rfc-editor.org/rfc/rfc9635.html
- RFC 9767 GNAP Resource Servers（2025-04）：https://www.rfc-editor.org/rfc/rfc9767.html
- GNAP 工作组：https://datatracker.ietf.org/wg/gnap/about/ ；shepherd write-up（2022-07）：https://datatracker.ietf.org/doc/draft-ietf-gnap-core-protocol/shepherdwriteup/ ；实现列表 PR #504：https://github.com/ietf-wg-gnap/gnap-core-protocol/pull/504/files
- OpenID Connect CIBA Core 1.0（Final，2021-09-01）：https://openid.net/specs/openid-client-initiated-backchannel-authentication-core-1_0.html
- FAPI CIBA Profile（Implementer's Draft，Draft-02，2019-08-15）：https://openid.net/specs/openid-financial-api-ciba-ID1.html
- FAPI 2.0 Message Signing（Final，2025-09-25）：https://openid.net/specs/fapi-message-signing-2_0-final.html
- FAPI 2.0 Http Signatures（工作稿，2026-06-26）：https://openid.bitbucket.io/fapi/fapi-2_0-http-signatures.html
- JARM（Final，2022-11-09）：https://openid.net/specs/oauth-v2-jarm-final.html
- OIDF 规范列表：https://openid.net/developers/specs/
- draft-mcguinness-oauth-actor-proofs-01（2026-10-09）：https://datatracker.ietf.org/doc/draft-mcguinness-oauth-actor-proofs/

**MCP 与 AI agent**

- MCP Versioning（当前 2026-07-28）：https://modelcontextprotocol.io/specification/versioning
- MCP Authorization（2026-07-28）：https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization
- MCP Authorization Security Considerations：https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization/security-considerations
- MCP Client Registration：https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization/client-registration
- MCP Elicitation：https://modelcontextprotocol.io/specification/2026-07-28/client/elicitation
- MCP Changelog 2026-07-28：https://modelcontextprotocol.io/specification/2026-07-28/changelog
- MCP Security Best Practices：https://modelcontextprotocol.io/docs/2026-07-28/tutorials/security/security_best_practices
- MCP SEP 列表：https://modelcontextprotocol.io/seps ；SEP-2672：https://github.com/modelcontextprotocol/modelcontextprotocol/pull/2672 ；SEP-2848：https://github.com/modelcontextprotocol/modelcontextprotocol/pull/2848 ；SEP-2385：https://github.com/modelcontextprotocol/modelcontextprotocol/pull/2385
- MCP Enterprise-Managed Authorization：https://modelcontextprotocol.io/extensions/auth/enterprise-managed-authorization ；https://github.com/modelcontextprotocol/ext-auth
- draft-ietf-oauth-identity-chaining-17（2026-07-19）：https://datatracker.ietf.org/doc/draft-ietf-oauth-identity-chaining/
- draft-ietf-oauth-identity-assertion-authz-grant-04（2026-05-21）：https://datatracker.ietf.org/doc/draft-ietf-oauth-identity-assertion-authz-grant/
- draft-oauth-ai-agents-on-behalf-of-user-02（2025-08-25，已过期）：https://datatracker.ietf.org/doc/draft-oauth-ai-agents-on-behalf-of-user/
- draft-ietf-wimse-aims-00（2026-09-15）：https://datatracker.ietf.org/doc/html/draft-ietf-wimse-aims-00
- draft-hardt-oauth-aauth-protocol-11（2026-09-25）：https://datatracker.ietf.org/doc/draft-hardt-oauth-aauth-protocol/
- draft-araut-oauth-transaction-tokens-for-agents-02（2026-05-22）：https://datatracker.ietf.org/doc/draft-araut-oauth-transaction-tokens-for-agents/
- draft-mcguinness-oauth-actor-profile / -actor-receipts（-01，2026-10-08~09）：https://datatracker.ietf.org/doc/draft-mcguinness-oauth-actor-profile/ ；https://datatracker.ietf.org/doc/draft-mcguinness-oauth-actor-receipts/
- draft-lee-wimse-local-tool-call-proof-01（2026-10-12）：https://datatracker.ietf.org/doc/draft-lee-wimse-local-tool-call-proof/
- draft-mw-oauth-actor-chain-02（2026-10-13）：https://datatracker.ietf.org/doc/draft-mw-oauth-actor-chain/
- draft-sharif-mcps-secure-mcp-01（2026-08-21）：https://datatracker.ietf.org/doc/draft-sharif-mcps-secure-mcp/
- draft-chen-oauth-agent-authz-use-cases-04（2026-10-11）：https://datatracker.ietf.org/doc/draft-chen-oauth-agent-authz-use-cases/
- draft-ietf-wimse-http-signature-07（2026-09-20）：https://datatracker.ietf.org/doc/draft-ietf-wimse-http-signature/
- IETF agentproto 工作组：https://datatracker.ietf.org/wg/agentproto/about/ ；IETF 126 BoF 纪要：https://datatracker.ietf.org/doc/minutes-126-agentproto-202607230700/
- OIDF AI Identity Management Community Group：https://openid.net/cg/artificial-intelligence-identity-management-community-group/
- OIDF 白皮书 Identity Management for Agentic AI（2025-10-07）：https://openid.net/wp-content/uploads/2025/10/Identity-Management-for-Agentic-AI.pdf ；arXiv 版：https://arxiv.org/abs/2510.25819 ；公告：https://openid.net/new-whitepaper-tackles-ai-agent-identity-challenges/
- OIDF AuthZEN 工作组：https://openid.net/wg/authzen/ ；ARAP 草案：https://openid.github.io/authzen/authzen-access-request-approval-profile-1_0.html ；2026-06-15 公告：https://openid.net/openid-foundation-advances-authorization-for-the-agent-era-with-new-authzen-working-group-drafts/
- AP2 规范（v0.2.0，2026-04-28）：https://ap2-protocol.org/ap2/specification/ ；https://ap2-protocol.org/ap2/agent_authorization/ ；https://ap2-protocol.org/ap2/security_and_privacy_considerations/ ；仓库：https://github.com/google-agentic-commerce/AP2 ；捐给 FIDO：https://fidoalliance.org/google-donates-agent-payments-protocol-to-fido-alliance/
- Mastercard Verifiable Intent（Draft v0.1）：https://github.com/agent-intent/verifiable-intent ；https://verifiableintent.dev/
- Visa Trusted Agent Protocol：https://developer.visa.com/capabilities/trusted-agent-protocol/trusted-agent-protocol-specifications ；https://github.com/visa/trusted-agent-protocol
- A2A 规范（v1.0.0）：https://a2a-protocol.org/latest/specification/

**签名格式与算法**

- RFC 7515 JWS（2015-05）：https://www.rfc-editor.org/rfc/rfc7515.html
- RFC 7797 JWS Unencoded Payload Option（2016-02）：https://www.rfc-editor.org/rfc/rfc7797.html
- RFC 7519 JWT（2015-05）：https://www.rfc-editor.org/rfc/rfc7519.html
- RFC 8725 JWT BCP（BCP 225，2020-02）：https://www.rfc-editor.org/rfc/rfc8725.txt
- draft-ietf-oauth-rfc8725bis-10（2026-08-21，IESG 已批）：https://datatracker.ietf.org/doc/draft-ietf-oauth-rfc8725bis/
- RFC 7518 JWA（2015-05）：https://www.rfc-editor.org/rfc/rfc7518.html
- RFC 7520 JOSE Examples（2015-05）：https://www.rfc-editor.org/rfc/rfc7520.html
- RFC 8785 JCS（2020-06，Informational）：https://www.rfc-editor.org/rfc/rfc8785.html
- RFC 9421 HTTP Message Signatures（2024-02）：https://www.rfc-editor.org/rfc/rfc9421.txt
- RFC 9530 Digest Fields（2024-02）：https://www.rfc-editor.org/rfc/rfc9530.html
- RFC 9052 COSE Structures（STD 96，2022-08）：https://www.rfc-editor.org/rfc/rfc9052.html
- RFC 9053 COSE Initial Algorithms（2022-08）：https://www.rfc-editor.org/rfc/rfc9053.html
- RFC 9338 COSE Countersignatures（2022-12）：https://www.rfc-editor.org/rfc/rfc9338.html
- RFC 8032 EdDSA（2017-01）：https://www.rfc-editor.org/rfc/rfc8032.txt
- RFC 8037 CFRG Curves in JOSE（2017-01）：https://www.rfc-editor.org/rfc/rfc8037.html
- RFC 9864 Fully-Specified Algorithms for JOSE and COSE（2025-10）：https://www.rfc-editor.org/rfc/rfc9864.html
- RFC 9964 ML-DSA for JOSE and COSE（2026）：https://www.rfc-editor.org/rfc/rfc9964.html
- IANA JOSE 注册表（2026-09-29）：https://www.iana.org/assignments/jose/jose.xhtml
- IANA COSE 注册表（2026-08-25）：https://www.iana.org/assignments/cose/cose.xhtml
- FIPS 186-5 Digital Signature Standard（2023-02-03）：https://nvlpubs.nist.gov/nistpubs/FIPS/NIST.FIPS.186-5.pdf
- FIPS 204 ML-DSA（2024-08-13）：https://csrc.nist.gov/pubs/fips/204/final
- NIST SP 800-186 椭圆曲线（2023-02）：https://csrc.nist.gov/pubs/sp/800/186/final
- RFC 6979 Deterministic DSA/ECDSA（2013-08）：https://www.rfc-editor.org/rfc/rfc6979.html
- RFC 8017 PKCS #1 v2.2（2016-11）：https://www.rfc-editor.org/rfc/rfc8017.html
- SEC 1 v2.0（2009-05-21）：https://www.secg.org/sec1-v2.pdf
- BIP 146：https://github.com/bitcoin/bips/blob/master/bip-0146.mediawiki

**WebAuthn、SPC、FIDO、平台**

- WebAuthn Level 3（W3C 推荐标准，2026-08-25）：https://www.w3.org/TR/webauthn-3/ ；规范源文件：https://raw.githubusercontent.com/w3c/webauthn/main/index.bs
- WebAuthn Level 1（推荐标准，2019-03-04）：https://www.w3.org/TR/2019/REC-webauthn-1-20190304/
- w3c/webauthn issue #1386：https://github.com/w3c/webauthn/issues/1386 ；PR #1399：https://github.com/w3c/webauthn/pull/1399 ；issue #2022：https://github.com/w3c/webauthn/issues/2022
- Secure Payment Confirmation（CRD，2026-10-13）：https://www.w3.org/TR/secure-payment-confirmation/ ；SPC on Android（Chrome 博客，2022-12-01）：https://developer.chrome.com/blog/spc-on-android
- W3C Secure Contexts（CRD 2023-11-10）：https://www.w3.org/TR/secure-contexts/
- WHATWG URL Standard：https://url.spec.whatwg.org/
- FIDO UAF Protocol v1.2（2020-10-20）：https://fidoalliance.org/specs/fido-uaf-v1.2-ps-20201020/fido-uaf-protocol-v1.2-ps-20201020.html
- FIDO UAF Authenticator Commands v1.2：https://fidoalliance.org/specs/fido-uaf-v1.2-ps-20201020/fido-uaf-authnr-cmds-v1.2-ps-20201020.html
- FIDO UAF Overview v1.2：https://fidoalliance.org/specs/fido-uaf-v1.2-ps-20201020/fido-uaf-overview-v1.2-ps-20201020.html
- FIDO Metadata Statement v3.0（2021-05-18）：https://fidoalliance.org/specs/mds/fido-metadata-statement-v3.0-ps-20210518.html
- FIDO Registry v2.2（2022-05-23）：https://fidoalliance.org/specs/common-specs/fido-registry-v2.2-ps-20220523.html
- Microsoft Learn WebAuthn APIs（2026-10-08）：https://learn.microsoft.com/en-us/windows/security/identity-protection/hello-for-business/webauthn-apis
- microsoft/webauthn `webauthn.h`：https://raw.githubusercontent.com/microsoft/webauthn/master/webauthn.h
- Chromium `pub_key_cred_params.md`：https://chromium.googlesource.com/chromium/src/+/main/content/browser/webauth/pub_key_cred_params.md
- Chromium `passkeys.rs`：https://github.com/chromium/chromium/blob/main/third_party/cloud_authenticator/processor/src/passkeys.rs
- Android 创建 passkey：https://developer.android.com/identity/passkeys/create-passkeys
- web.dev Passkey registration（2026-04-09）：https://web.dev/articles/passkey-registration
- Apple `ASCOSEAlgorithmIdentifier`：https://developer.apple.com/documentation/authenticationservices/ascosealgorithmidentifier ；开发者论坛 710784：https://developer.apple.com/forums/thread/710784
- Chrome 137 release notes：https://developer.chrome.com/release-notes/137 ；chromestatus：https://chromestatus.com/feature/4913922408710144
- Firefox 129 发布说明（MDN）：https://developer.mozilla.org/en-US/docs/Mozilla/Firefox/Releases/129
- Safari 17 release notes：https://developer.apple.com/documentation/safari-release-notes/safari-17-release-notes ；WebKit 博客：https://webkit.org/blog/14445/webkit-features-in-safari-17-0/
- MDN browser-compat-data `SubtleCrypto`：https://github.com/mdn/browser-compat-data/blob/main/api/SubtleCrypto.json
- W3C Web Cryptography Level 2（FPWD，2025-04-22）：https://www.w3.org/TR/webcrypto-2/
- WebKit 博客 Full Third-Party Cookie Blocking and More（2020-03-24）：https://webkit.org/blog/10218/full-third-party-cookie-blocking-and-more/

**鸿蒙（华为 HarmonyOS 文档，页面更新于 2026-10-13；OpenHarmony 另标）**

- ArkWeb 简介：https://developer.huawei.com/consumer/cn/doc/harmonyos-guides/web-component-overview
- ArkWeb M132→M144 差异（OpenHarmony-TPC）：https://gitcode.com/openharmony-tpc/chromium_src/blob/master/web/ReleaseNote/ArkWeb_132_144.md
- Online Authentication Kit 简介：https://developer.huawei.com/consumer/cn/doc/harmonyos-guides/onlineauthentication-introduction
- 通行密钥概述：https://developer.huawei.com/consumer/cn/doc/harmonyos-guides/onlineauthentication-passkey-intro
- 通行密钥 ArkTS API：https://developer.huawei.com/consumer/cn/doc/harmonyos-references/onlineauthentication-passkey-api
- 通行密钥开发准备：https://developer.huawei.com/consumer/cn/doc/harmonyos-guides/onlineauthentication-passwordless-auth-preparation
- 受限权限列表：https://developer.huawei.com/consumer/cn/doc/harmonyos-guides/restricted-permissions
- 在线认证术语：https://developer.huawei.com/consumer/cn/doc/harmonyos-guides/online-authentication-glossary
- 数字盾网页场景（FIDO2）：https://developer.huawei.com/consumer/cn/doc/harmonyos-guides/devicesecurity-trustedauth-fido2-webauth
- HUKS 概述：https://developer.huawei.com/consumer/cn/doc/harmonyos-guides/huks-overview
- HUKS 签名 / 验签规格：https://developer.huawei.com/consumer/cn/doc/harmonyos-guides/huks-signing-signature-verification-overview
- HUKS 密钥生成规格：https://developer.huawei.com/consumer/cn/doc/harmonyos-guides/huks-key-generation-overview
- HUKS 导出公钥：https://developer.huawei.com/consumer/cn/doc/harmonyos-guides/huks-export-key-arkts
- HUKS 用户身份认证访问控制简介：https://developer.huawei.com/consumer/cn/doc/harmonyos-guides/huks-identity-authentication-overview
- HUKS 用户身份认证开发指导：https://developer.huawei.com/consumer/cn/doc/harmonyos-guides/huks-user-identity-authentication
- HUKS 密钥使用通用流程：https://developer.huawei.com/consumer/cn/doc/harmonyos-guides/huks-key-use-overview
- HUKS API 参考：https://developer.huawei.com/consumer/cn/doc/harmonyos-references/js-apis-huks
- HUKS 密钥证明：https://developer.huawei.com/consumer/cn/doc/harmonyos-guides/huks-key-attestation-overview
- 应用真实性证明服务端开发：https://developer.huawei.com/consumer/cn/doc/harmonyos-guides/device-attestation-servers ；根证书：https://pki.consumer.huawei.com/ca/cer/Huawei_CBG_ECC_Device_Attestation_Root_CA.cer
- OpenHarmony HUKS 源码 `hks_client_check.c`：https://github.com/openharmony/security_huks/blob/master/services/huks_standard/huks_service/main/core/src/hks_client_check.c
- userAuth API 参考：https://developer.huawei.com/consumer/cn/doc/harmonyos-references/js-apis-useriam-userauth
- 发起认证：https://developer.huawei.com/consumer/cn/doc/harmonyos-guides/start-authentication
- 用户认证概述：https://developer.huawei.com/consumer/cn/doc/harmonyos-guides/user-authentication-overview
- WebviewController 参考：https://developer.huawei.com/consumer/cn/doc/harmonyos-references/arkts-apis-webview-webviewcontroller
- Web 组件属性：https://developer.huawei.com/consumer/cn/doc/harmonyos-references/arkts-basic-components-web-attributes
- Web 组件接口：https://developer.huawei.com/consumer/cn/doc/harmonyos-references/arkts-basic-components-web-i
- 前端页面调用应用侧函数：https://developer.huawei.com/consumer/cn/doc/harmonyos-guides/web-in-page-app-function-invoking
- 数字盾概述：https://developer.huawei.com/consumer/cn/doc/harmonyos-guides/devicesecurity-trustedauth-overview ；密码认证：https://developer.huawei.com/consumer/cn/doc/harmonyos-guides/devicesecurity-trustedauth-verifybypwd ；生物认证：https://developer.huawei.com/consumer/cn/doc/harmonyos-guides/devicesecurity-trustedauth-verifybybio ；API：https://developer.huawei.com/consumer/cn/doc/harmonyos-references/devicesecurity-trusted-auth-api ；开通服务：https://developer.huawei.com/consumer/cn/doc/harmonyos-guides/devicesecurity-deviceverify-activateservice

**Node.js 与 npm**

- Node.js v22 crypto：https://nodejs.org/docs/latest-v22.x/api/crypto.html
- Node.js v22 Web Crypto：https://nodejs.org/docs/latest-v22.x/api/webcrypto.html
- nodejs/node PR #56142：https://github.com/nodejs/node/pull/56142
- npm `jose`（6.2.12）：https://registry.npmjs.org/jose
- npm `@simplewebauthn/server`（14.0.3）：https://registry.npmjs.org/@simplewebauthn/server

**密钥管理（NIST、Windows）**

- NIST SP 800-57 Part 1 Rev.5（2020-05）：https://nvlpubs.nist.gov/nistpubs/SpecialPublications/NIST.SP.800-57pt1r5.pdf
- NIST SP 800-57 Part 1 Rev.6 初始公开草稿（2025-12-05）：https://csrc.nist.gov/pubs/sp/800/57/pt1/r6/ipd
- NIST SP 800-63B-4（终稿 2025-07-31）：https://pages.nist.gov/800-63-4/sp800-63b.html ；CSRC：https://csrc.nist.gov/pubs/sp/800/63/b/4/final
- NIST 词汇表 non-repudiation：https://csrc.nist.gov/glossary/term/non_repudiation
- Windows Hello for Business How it works：https://learn.microsoft.com/en-us/windows/security/identity-protection/hello-for-business/how-it-works
- How Windows uses the TPM：https://learn.microsoft.com/en-us/windows/security/hardware-security/tpm/how-windows-uses-the-tpm
- CNG Key Storage Providers：https://learn.microsoft.com/en-us/windows/win32/seccertenroll/cng-key-storage-providers
- KeyCredentialManager：https://learn.microsoft.com/en-us/uwp/api/windows.security.credentials.keycredentialmanager
- Windows Hello 开发文档：https://learn.microsoft.com/en-us/windows/apps/develop/security/windows-hello
- 桌面应用不支持的 WinRT API：https://learn.microsoft.com/en-us/windows/apps/desktop/modernize/desktop-to-uwp-supported-api
- TCG TPM 参考实现：https://github.com/TrustedComputingGroup/TPM

**先例**

- OpenSSH PROTOCOL.sshsig：https://github.com/openssh/openssh-portable/blob/master/PROTOCOL.sshsig
- ssh-keygen(1)（OpenBSD-current）：https://man.openbsd.org/ssh-keygen.1
- git-config（2.56.0）：https://git-scm.com/docs/git-config
- Sigstore：https://docs.sigstore.dev/about/security/ ；Rekor：https://docs.sigstore.dev/logging/overview/ ；Fulcio：https://docs.sigstore.dev/certificate_authority/overview/
- EBA 问答 2019_4556（2019-12-20）：https://www.eba.europa.eu/single-rule-book-qa/qna/view/publicId/2019_4556 ；EBA 问答 2018_4414（2021-02-26）：https://www.eba.europa.eu/single-rule-book-qa/qna/view/publicId/2018_4414
- 委托条例 (EU) 2018/389（PSD2 RTS）：https://eur-lex.europa.eu/eli/reg_del/2018/389/oj （抓取被拦，没读到原文；条文取自上面的 EBA 问答）
- 华商银行《通用 U 盾介绍（音频 U 盾）》（2022-02-14）：v.icbc.com.cn 上的 PDF（子 agent 读到，本文没有记下完整链接）
- Signal 安全码（2026-04-30）：https://support.signal.org/hc/en-us/articles/360007060632
- Signal 关联设备（2026-09-15）：https://support.signal.org/hc/en-us/articles/360007320551
- Signal 博客 Safety number updates（2016-11-17）：https://signal.org/blog/safety-number-updates/
- X3DH 规范 Rev.1（2016-11-04）：https://signal.org/docs/specifications/x3dh/
- TUF 规范（v1.0.37，2026-10-08）：https://theupdateframework.github.io/specification/latest/

**本仓库**

- `CONTEXT.md`：设备配对、授权项、守卫、范围审视的定义
- `docs/developer-guide.md`："设备配对"一节（凭证、短码、短指纹、吊销）
- [07-push-harmonyos-android.md](07-push-harmonyos-android.md) §6.3：审批签名挑战的早期建议
- [../adr/0026-features-first-security-later.md](../adr/0026-features-first-security-later.md)：功能先跑通、安全后接
