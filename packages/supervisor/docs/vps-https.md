# VPS 上的 https 站点和证书

`lsm vps site add` 一条命令把 VPS 本机上的一个服务接成 `https://<域名>`：定域名 → 核对 DNS → 看布局挑签证书的办法 → 签 →
写 nginx 站点 → `nginx -t` 不过自动撤回 → reload → 装续期钩子 → 从外面验收。`site remove` 原样撤掉，`certs` 列证书和到期日，
`scan` 只读扫一遍 VPS 上原来就有的站点和证书、认领进状态文件。

和 `lsm vps setup`（[vps.md](./vps.md)）同一套底子：专用钥匙、只读体检、脚本**整份显示了、你同意了才跑**、能重复跑、断了接着做、
状态记在数据目录的 `vps-setup.json`。VPS 第一版只支持 Debian / Ubuntu。给 agent 用的说明书在 [`skills/vps-https/SKILL.md`](../skills/vps-https/SKILL.md)。

## 一条命令

```powershell
# VPS 本机 127.0.0.1:3000 上的服务 → https://notes.203.0.113.10.sslip.io
lsm vps site add notes --port 3000 --host root@203.0.113.10

# 用自己的域名（先在 DNS 里加一条 A 记录指到 VPS）
lsm vps site add notes --port 3000 --domain notes.example.com

lsm vps site remove notes      # 原样撤掉
lsm vps certs                  # 证书和到期日（只读）
lsm vps scan --host root@203.0.113.10   # 只读扫一遍、认领原来就有的站点和证书
```

`--port` 是**站点后面那个服务在 VPS 上听的端口**（只接 `127.0.0.1:<端口>`；ssh 端口用 `--ssh-port`）。
不能是 80 / 443。第一次要给 `--host`，之后记在状态文件里。

## site add 每一步

1. **域名**：默认 `<名字>.<IP>.sslip.io`，`--domain` 换成自己的。和 `setup` 的方式、别的站点、`scan` 认领的站点撞了就拒。
2. **登进 VPS**：管理用的专用钥匙（同 `setup`，没放上去就打印那一句让你自己跑）。
3. **体检**（只读）+ 把 nginx 的配置（`nginx -T`）要回电脑上解析，看布局：

   | 看到的 | 怎么办 |
   |---|---|
   | 443 没人占、或者 nginx 自己占着 | 站点直接 `listen 443 ssl`，访客的真实 IP 就是 `$remote_addr` |
   | **443 前面有 stream 前门**（`ssl_preread on` + `map $ssl_preread_server_name $变量 {…}`） | 站点**只听前门后面的本机地址**（认出来的那个，通常 `127.0.0.1:8443`），不抢 443；**往前门的 map 里加一行**「这个域名 → 那个地址」（行尾带 `# ergo-vps-site=<名字>`，撤的时候按它删）。前门开了 `proxy_protocol` 就 `listen … ssl proxy_protocol`、真实 IP 用 `$proxy_protocol_addr`；没开就提醒你：这个站点看到的访客 IP 都是 127.0.0.1 |
   | 443 被 nginx 以外的程序占着 | 停下（nginx 听不了 443） |
   | 80 没人占、或者 nginx 占着 | 证书用 **webroot** 签：先写只有 80 端口那段（`/.well-known/acme-challenge/` → `/var/www/ergo-acme`），不停任何东西 |
   | **80 被 nginx 以外的程序占着** | 认出它是哪个 systemd 单元（看 `/proc/<pid>/cgroup`），**先单独告诉你、问你同不同意**，同意了才用 **standalone** 签：签的时候 `systemctl stop` 它、签完马上 `start`，脚本里用 **trap** 保证签失败也拉起来；以后续期也这样停一下（certbot 的 `--pre-hook` / `--post-hook` 记进续期配置）。站点不写 80 那段。VPS 上原来没有 nginx 的，装的时候不让它马上起（它自带的 default 站点听 80 会起不来），装完拿掉 default |
   | 80 被 docker / containerd / sshd 之类占着，或者认不出单元 | 停下：停它会连带停掉别的东西。用 `--stop-unit <单元>` 指定，或者自己挪开 |
   | 这个域名的证书原来就有 | 不签、不停任何东西；撤的时候也不删它 |

4. **显示脚本、你同意了才跑**。脚本开头**先核对布局和体检时一样**（变了就停下，一样东西都不改）；
   缺 nginx / certbot / ufw / 自动安全更新的装上，防火墙只开 ssh、80、443；签证书；写站点；有前门就写前门；装续期钩子。
   **每次改 nginx（站点、前门）都先 `nginx -t`，不过就换回原样、停下。**
5. **从外面验收**（不带任何凭证）：证书按系统信任的根校验；
   - 回 **401 / 403**：有认证把关，过；
   - 回 2xx / 3xx（不带凭证就能打开）：**算没过**——站点本来就公开的，加 `--public` 重跑；
   - 502 / 503 / 504：VPS 这头通了，后面的服务没回话；
   - 后面接的像二狗（`/api/access` 回 `{"access": …}`）：照 [vps.md](./vps.md)「验收」分 8810 / 8811，**接到 8810 当场把站点撤掉**。

## nginx 站点模板

`/etc/nginx/sites-available/ergo-site-<名字>.conf`（没有 sites-enabled 的放 `conf.d/`），照二狗自己的模板（`packages/daemon/src/deploy/nginx.ts`）：
WebSocket 升级（每个站点自己的 `map $http_upgrade` 变量）、`Host $host` 原样转发、`X-Real-IP` / `X-Forwarded-For` 覆盖写访客地址、
`client_max_body_size 256m`、`proxy_request_buffering off`（上传边收边转）、`proxy_read_timeout` / `proxy_send_timeout 3600s`、HSTS 一年。

## remove / certs / scan

- `site remove <名字>`：同样整份显示了才撤。拿掉站点、前门里加的那一行；证书是这里签的才删；只给它开的防火墙端口关上；
  这台 VPS 上归服务管家管的东西（setup 的方式、站点、认领的）都没了，才按「装之前原来有没有」撤公共部分、收回管理钥匙。自动安全更新留着。
  `scan` 认领的站点不撤（那是你原来配的）。
- `certs`（只读）：Let's Encrypt 的证书（`/etc/letsencrypt/live/*`），加 nginx 里引用的别的证书文件，各自哪天到期、归谁；
  **少于 20 天**标出来（certbot 会在剩 30 天时自动续，剩不到 20 天多半是续期坏了），有就退出码 1。结果存进数据目录的 `vps-certs.json`。
  （服务管家网页上的提醒、Windows 通知、管理器定时自己去看——这一版还没接，只有这条命令。）
- `scan`（只读）：`nginx -T`、证书和到期日、谁占着 80 / 443、服务管家在这台装过什么，原样拿回电脑解析：列出每个站点
  （server_name、listen、转到哪、证书还剩几天）、443 的前门，把**不是 lsm 装的**站点和证书「认领」进状态文件——**VPS 上一样没改**。
  `--print-script` 只打印脚本。

## sslip.io 签 Let's Encrypt 证书的频率限制：和全世界共用

**结论：`sslip.io` 不在公共后缀列表（Public Suffix List）里，所以 Let's Encrypt 把所有 `*.sslip.io` 的证书算在同一个「注册域名」`sslip.io` 名下——
「每个注册域名每 7 天能签多少张新证书」这一项是全世界用 sslip.io 的人共用的。**

- Let's Encrypt 按公共后缀列表认注册域名，`New Certificates per Registered Domain` 默认每 7 天 50 张、所有账号共用；
  可以给某个注册域名单独调高。[Let's Encrypt：Rate Limits](https://letsencrypt.org/docs/rate-limits/)
- 2026-10-27 查的公共后缀列表（版本 `2026-10-22_08-36-41_UTC`）里没有 `sslip.io`（也没有 `nip.io`）。
  [publicsuffix.org/list/public_suffix_list.dat](https://publicsuffix.org/list/public_suffix_list.dat)
- sslip.io 的运营方（现在 `sslip.io` 的网站跳到 `nip.io`，两个域名是同一个服务、可以互换）自己说：Let's Encrypt 这些年把「他们的」上限从 50
  调到了 250,000，再要调到 500,000 被拒了；被限了就试 IP 地址证书，或者换另一个域名（用 nip.io 就换 sslip.io，反过来也一样）。
  [nip.io](https://nip.io/)

对我们意味着：

- **第一次签**（新的域名）可能偶尔被限频：certbot 报 `too many certificates already issued for "sslip.io"`（rateLimited）。
  脚本停下、什么都不坏，过一阵（几小时到一天）重跑同一条命令就接着签。急的话用自己的域名（`--domain`），或者把默认域名里的 `sslip.io` 换成 `nip.io`。
- **续期不受影响**：和上一张证书域名完全一样的续期，不算进「每个注册域名」这一项（只受「同一组域名每 7 天 5 张」和验证失败次数的限制）。
- 别反复 remove / add 同一个域名：同一组域名每 7 天最多 5 张，这一项谁也调不高。

## 测试

`tests/vps-sites.test.mjs`，不连任何真机器：假 Debian（`tests/_fake-debian.*`）里用 Git Bash 真跑 site add / remove 的脚本——
直接听 443 从零加、重跑零改动、撤干净；80 被 apache2 占着时先停后签、签失败 trap 拉起来、续期钩子记上、nginx 装的时候不起；
443 有 stream 前门时只听 127.0.0.1:8443、前门 map 加一行、`nginx -t` 不过换回、撤的时候删那一行；布局变了开头就停。
另有 nginx 配置解析、布局判断、证书提醒的单测，和经假执行层的整条流程（standalone 先问、401 才算过、接到 8810 当场撤、scan 认领、certs 提醒）。

**还没在真的 Debian 上跑过**：第一次真用之前，先在一台测试用的 VPS 上把三种布局各走一遍。
