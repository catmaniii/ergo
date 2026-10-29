# 一条命令搭 VPS：自建 tailnet（headscale）或隧道入口

`lsm vps setup headscale | tunnel` 在一台全新的 Debian / Ubuntu VPS 上把外网访问搭好，`lsm vps status` 看通不通、证书哪天到期，
`lsm vps remove` 原样撤掉。ergo（二狗）的外网访问有三种方式，这里管要 VPS 的两种：

| 方式 | 谁能打开 | 这里的命令 |
|---|---|---|
| Tailscale 官方 | 登进同一个 Tailscale 账号的设备 | 不用 VPS，不在这里 |
| 自建 tailnet（headscale） | 加入你自建 tailnet 的设备；可以自建中转，国内设备之间更快 | `lsm vps setup headscale` |
| 隧道入口（ssh 反向隧道 + nginx） | 任何浏览器，靠二狗的设备配对把关 | `lsm vps setup tunnel` |

**硬规矩**：二狗对外只接**外网端口 8811**（每个请求都要设备凭证）。8810 是本机端口，本机来的一律信任，
接出去等于整个外网免认证——命令里要接 8810 直接拒绝，装完的验收也会查（见下面「验收」）。

> 只在 Windows 上跑过电脑这一头；VPS 第一版只支持 Debian / Ubuntu（apt、systemd）。

## 要先准备的

- 一台 VPS：Debian 11 / 12 或 Ubuntu 20.04 以上，root 登录（或者登录的用户有免密 sudo）。最好是刚开出来的。
- 云厂商控制台的**安全组 / 防火墙**放行：TCP 22（ssh）、TCP 80、TCP 443；自建 tailnet 带中转时再加 UDP 3478。
  程序不替你开安全组，体检时会从电脑上连一下这些端口，告诉你哪个像是没放行。
- 电脑上有 OpenSSH 客户端（Windows 10 / 11 自带）。自建 tailnet 还要装 [Tailscale](https://tailscale.com/download)。
- 不用买域名：默认用 `<名字>.<IP>.sslip.io`（比如 `ergo.203.0.113.10.sslip.io`），sslip.io 把名字里的 IP 原样解析回来，
  Let's Encrypt 照样能签。用自己的域名就加 `--domain`，先在 DNS 里加一条 A 记录指到 VPS。

## 一条命令

```powershell
# 隧道入口：手机浏览器打开 https://ergo.<IP>.sslip.io 就能用（要先在二狗里批准配对）
lsm vps setup tunnel --host root@203.0.113.10

# 自建 tailnet：控制节点在 https://hs.<IP>.sslip.io，电脑自动加入，手机照终端里的步骤加入
lsm vps setup headscale --host root@203.0.113.10
```

两种可以装在同一台 VPS 上（共用 nginx、证书工具、防火墙），撤一种不影响另一种。

## setup 每一步做了什么

1. **定地址和域名**：`--host` 第一次要给，之后记在状态文件里。域名默认 `<名字>.<IP>.sslip.io`（隧道 `ergo`、headscale `hs`，`--name` 改）。
2. **专用钥匙**：在数据目录的 `.secrets\vps-setup\` 生成两把 ed25519 钥匙——
   `admin`（管理用：之后所有 ssh 都只用它）、`tunnel`（隧道用，只有隧道方式要）。
   主机指纹记在同一个目录的 `known_hosts`，不碰你自己的 `~\.ssh`。重跑不会换钥匙。
3. **把管理钥匙放上 VPS**：钥匙登不进去时，终端里打印一句命令让**你自己**跑：

   ```powershell
   ssh root@203.0.113.10 "umask 077; mkdir -p ~/.ssh; grep -qxF 'ssh-ed25519 AAAA… ergo-supervisor-admin' ~/.ssh/authorized_keys 2>/dev/null || echo 'ssh-ed25519 AAAA… ergo-supervisor-admin' >> ~/.ssh/authorized_keys"
   ```

   它会问一次 VPS 的密码——密码只进 ssh 自己的提示，`lsm` 不经手、不保存。跑完回到 `lsm` 那边按回车，它再试一次。
4. **体检**（只读，什么都不改）：在 VPS 上看系统、已经装了什么、谁占着 80 / 443 / 3478、防火墙、sshd 的设置、域名指到哪；
   再从电脑上连 VPS 的 22 / 80 / 443。挡路的（见下面「会停下来的情况」）就停下，不往上装；只是要你知道的列成提醒。
5. **显示脚本、你同意了才跑**：把要在 VPS 上跑的脚本**整份**打在终端里（同一份另存在数据目录的 `vps-scripts\<方式>-setup.sh`，
   可以用编辑器细看），问「照这份脚本在 VPS 上执行？」，答 `y` 才经 ssh 送上去跑，边跑边显示每一步。
   `--yes` 只是省掉这一问，脚本照样整份显示。
6. **电脑这一半**：
   - 隧道：在服务管家里登记一条隧道服务（默认 id `ergo-vps-tunnel`，数据目录的 `registry\services\ergo-vps-tunnel.yaml`）——
     `ssh -N -R 127.0.0.1:18811:127.0.0.1:8811 ergo-tunnel@<VPS>`，用隧道钥匙、断了交给 autoRestart 重连——然后起起来。
     开机自启：`lsm autostart ergo-vps-tunnel on`。
     顺手给二狗的登记（`ergo-daemon`）填上 `exposure`（`via` 指向这条隧道、`publicUrl`、`check: true`、`localPort: 8811`），
     WebUI 上二狗那张卡下面就能看到这条隧道、定期从外面实测。只在文件末尾追加带首尾标记行的一段，`remove` 时按标记原样拿掉；
     **二狗的登记里已经有 `exposure`**（比如你手写的那条接着 `ergo-tunnel`、只写了 `localPort`、标了 `never`）**就不动**，
     只在终端里告诉你要改成什么样。服务管家里没登记二狗就不填。这一步在问「照这份脚本执行？」之前就会说出来。
   - headscale：电脑上的 tailscale 用脚本发的一次性钥匙（1 小时内有效、只能用一次）加入；钥匙不显示、不落盘。
     电脑正连着别的 tailnet 时不动它（换过去会把电脑从那边摘下来），只打印你自己换过去的命令。
     最后打印手机加入的步骤，和给本机服务开 tailnet 入口要往 `manager.yaml` 里加的两段。
7. **验收**（见下面），结果和每一步记进状态文件。

**断了接着做**：VPS 上的脚本每一步先看现状，已经是想要的样子就跳过。网络断了、某一步失败了（比如安全组没放行 80、证书没签下来），
处理完重跑同一条命令，做过的步骤都会显示 skip，从断的地方接着做。

## VPS 上的脚本做了什么

两种方式共用的部分：

| 步骤 | 做什么 | 已经做过时 |
|---|---|---|
| base-record | 第一次跑时在 `/etc/ergo-vps/base.env` 记下「装之前原来是什么样」：nginx、certbot、ufw、unattended-upgrades、curl、headscale 原来装没装，ufw 原来开没开，自动安全更新原来开没开 | 不改（它记的是装之前） |
| packages | 缺哪个装哪个：nginx、certbot、ufw（用 firewalld 的机器不装）、unattended-upgrades | 都有就不碰 apt |
| auto-upgrades | 自动安全更新：没开就单独放一个 `/etc/apt/apt.conf.d/52ergo-auto-upgrades` 打开（不改系统自带的 `20auto-upgrades`）；撤的时候留着 | 本来开着就不动 |
| firewall | ufw：先放行 ssh 端口（不然打开 ufw 的那一刻就把自己关在外面），再放行 80/tcp、443/tcp（headscale 带中转再加 3478/udp）；ufw 原来没开就打开——**别的端口外面就进不来了**，体检会先列出对外在听的别的端口提醒你。加的规则记在 `/etc/ergo-vps/ufw-added`，撤的时候只删这些 | 规则都在就不加 |
| 证书 + 站点 | 先核对域名在 DNS 里指到这台；nginx 先写只有 80 端口的站点（`/.well-known/acme-challenge/` 指到 `/var/www/ergo-acme`，别的跳 https），certbot 用 webroot 签（**不停 nginx**），签好再写完整的 443 站点。每次改站点都先 `nginx -t`，不过就换回原来的、停下 | 证书在就不签，站点内容一样就不动 |
| renew-hook | `/etc/letsencrypt/renewal-hooks/deploy/ergo-vps-reload-nginx`：certbot 自带的定时任务续期后让 nginx 读新证书 | 一样就不动 |

隧道方式另外：

- **受限账号** `ergo-tunnel`：系统账号、shell 是 `/usr/sbin/nologin`，`authorized_keys` 里只有隧道钥匙这一行：

  ```
  restrict,port-forwarding,permitlisten="127.0.0.1:18811",command="/bin/false" ssh-ed25519 AAAA… ergo-supervisor-tunnel
  ```

  `restrict` 关掉终端、X11、agent 转发，`port-forwarding` 只放开转发，`permitlisten` 只许在 VPS 的 127.0.0.1:18811 上开反向转发——
  不能登录、不能执行命令、不能转发别的端口；`command="/bin/false"` 再加一层保险：拿这把钥匙要求开会话、跑命令，跑的也只是 `/bin/false`
  （隧道是 `ssh -N`，不开会话，不受影响）。
- **nginx 站点** `ergo-vps-tunnel`：照二狗自己的模板（`packages/daemon/src/deploy/nginx.ts`）——`/ws`、`/apps/` 做 WebSocket 升级，
  上传边收边转、长超时、大上传（256m）、HSTS；每个 location 都覆盖写 `X-Real-IP $remote_addr`：nginx 直接听 443，
  `$remote_addr` 就是访客真实的 IP，二狗按它给配对请求限频。

headscale 方式另外：

- 从 GitHub 发布页下载 headscale 安装包（默认 0.26.1，`--headscale-version` 改），**和发布页的 `checksums.txt` 核对 sha256**，对不上不装。
  国内 VPS 连 GitHub 慢时加 `--headscale-mirror <前缀>`：安装包地址变成「前缀 + GitHub 上的原地址」（国内常见的 GitHub 加速都是这种写法，
  比如 `--headscale-mirror https://gh-proxy.example.com/`）。镜像只换安装包从哪下——**校验和照样只从 GitHub 发布页取、不从镜像取**，
  镜像给的包和官方的 sha256 对不上就不装（`checksums.txt` 只有几 KB，连 GitHub 慢也拿得到；VPS 完全连不上 GitHub 时这一步会停下）。
- 整份写 `/etc/headscale/config.yaml`（只认这一版的格式）：只听 `127.0.0.1:8080`；DNS 记录走 `extra_records_path: /var/lib/headscale/extra-records.json`
  （服务管家的 tailnet 入口往里写「名字 → 电脑的 tailnet 地址」，headscale 改了几秒内下发）；设备的 DNS 交给 tailnet（`override_local_dns`）；
  带中转时打开内置 DERP（经 `https://<域名>/derp`，打洞用 3478/udp）。安装包自带的那份留成 `config.yaml.ergo-orig`。
  写完先 `headscale configtest`，不过就换回原来的、停下。
- nginx 站点 `ergo-vps-headscale` 照 headscale 文档给的反代写法（WebSocket 升级、不缓冲、Host 写成 server_name）。
- 建用户 `ergo`（电脑和手机都登记在它名下），发一把电脑加入用的一次性钥匙。
- **VPS 上原来就有 headscale（不是这里装的）：不覆盖**，体检就停下。见下面「已经有 headscale」。

同一份脚本也能自己登进 VPS 跑：`lsm vps setup <方式> --print-script > setup.sh`，拷上去 `sudo bash setup.sh`；
电脑那一半再回来跑 `lsm vps setup <方式> --local-only`（headscale 方式这时不去 VPS 上要一次性钥匙，打印浏览器登录的命令）。

## 验收

装完从电脑上走一遍 `https://<域名>/`，**不带任何凭证**：

- 证书按系统信任的根校验、名字要对得上——自签的、名字不对的都算不过；
- 隧道：打 `/api/access` 和 `/healthz`，照二狗网关两个端口的真实行为分辨后面接的是谁：

  | 后面接的 | `/api/access` | `/healthz` | 结论 |
  |---|---|---|---|
  | 外网端口 8811 | 200 `{"access":"none"}` | 401 | ✓ 没配对的设备只拿到配对页 |
  | 本机端口 8810，nginx 改写了 Host | 200 `{"access":"local"}` | 200 | ✗ 整个外网免认证 |
  | 本机端口 8810，Host 原样 | 403（本机端口只认 127.0.0.1 的 Host） | 403 | ✗ 接错了 |
  | 502 / 504 | | | 隧道没接上 |

  认出接到了 8810 就报红、退出码 1，**当场强制停掉隧道服务**，状态记 `verify-failed`。
  另外查服务管家的注册表：有哪条隧道的 `-R` 接的是 8810、哪个 tailnet 入口的目标端口是 8810，一样报红。
- headscale：`https://<域名>/health` 回 200。

## 状态记在哪

| 位置 | 记什么 |
|---|---|
| 电脑：数据目录的 `vps-setup.json` | 哪台 VPS、每种方式的域名和端口、走到哪一步（planned / vps-done / vps-failed / local-done / verified / verify-failed）、脚本每一步是 ok 还是 skip、最后一次体检和验收的结果、历史。**不记密码、不记一次性钥匙** |
| 电脑：`.secrets\vps-setup\` | 两把专用钥匙和这台 VPS 的主机指纹 |
| 电脑：`vps-scripts\` | 最近一次显示给你看的 setup / remove 脚本 |
| VPS：`/etc/ergo-vps/base.env`、`<方式>.env`、`ufw-added*` | 装之前原来是什么样、每种方式装了什么、加了哪些防火墙规则 |

一份状态只管一台 VPS：要换机器先 `lsm vps remove`，或者换一个 `--data-dir`。

## status

```powershell
lsm vps status
```

只读：在 VPS 上看 nginx / headscale 在不在跑、隧道接上没有（VPS 的 127.0.0.1:18811 有没有人在听）、受限账号在不在、
证书哪天到期（少于 20 天提醒——certbot 的自动续期大概没跑成）；在电脑上看隧道服务的状态、从外面再验收一遍。有不对的退出码 1。

## remove

```powershell
lsm vps remove tunnel        # 或 headscale
```

同样先整份显示撤的脚本和电脑这头要做的，同意了才撤，能重复撤：

- 隧道：先拿掉 setup 填进二狗登记的 `exposure`（只拿带标记的那段；拿不掉就停下不往下撤——不然二狗的登记会指着一条不存在的隧道），
  再强制停掉隧道服务、删掉它的登记（只删 `lsm vps setup` 生成的那份）、删隧道钥匙；VPS 上拿掉站点、删证书、删受限账号、关上只给它开的端口。
- headscale：电脑连着这个 tailnet 就先 `tailscale logout`；VPS 上停掉并卸载 headscale **连同它的数据**（tailnet 里登记的设备一起没了）、拿掉站点、删证书、关端口。
- 两种都撤完时，再把公共的部分按「装之前原来有没有」原样撤：原来没有、是这里装的 nginx / certbot / ufw 卸掉
  （它们拉进来的依赖包留着，想清可以 `apt autoremove`），ufw 原来关着就关回去；**原来就有的一律不动**。
  **自动安全更新留着**：unattended-upgrades 不卸、打开它的 `52ergo-auto-upgrades` 不删——撤掉入口不该顺带把这台 VPS 的安全更新也关了。最后把管理钥匙从 `authorized_keys` 里拿掉，电脑上的钥匙、主机指纹也删掉。

## 手机加入自建 tailnet

`setup headscale` 最后会打印这几步：

1. 装官方的 Tailscale App，先别点登录。安卓：右上角 ⋮ →「Change server」，填 `https://hs.<IP>.sslip.io`；
   iPhone：系统「设置」→ Tailscale →「Alternate Coordination Server URL」。
2. 点登录，浏览器里会显示一行 `headscale nodes register --user … --key <一串>`。
3. 在电脑上跑 `lsm vps approve <那一串>`（等于在 VPS 上跑那一行）。
4. 回到 App，几秒内显示已连接。安卓上确认「使用 Tailscale DNS」开着——tailnet 入口的名字只在 tailnet 的 DNS 里解析得到。

## 会停下来的情况（体检）

- 不是 Debian / Ubuntu；不是 root 也没有免密 sudo；没有 systemd / apt。
- **443 前面已经有一层 stream 前门**（nginx 的 `ssl_preread`）：新站点不能直接听 443，访客的真实 IP 也要前门开了 `proxy_protocol`
  才传得过来（不然所有访客在二狗看来都是 127.0.0.1，配对限频挤成一个桶）。`setup` 不改你现有的前门；要在这种布局上加站点用 `lsm vps site add`（见 [vps-https.md](./vps-https.md)，它会往前门里加一行）。
- 80 / 443 被 nginx 以外的程序占着（签证书、续期都要 nginx 占 80）。
- 隧道：OpenSSH 低于 7.8（没有 `permitlisten`）；sshd 的 `AllowTcpForwarding` 是 `no` / `local`；`AllowUsers` 里没有 `ergo-tunnel`；
  VPS 的 127.0.0.1:18811 已经有人在听（多半是你以前手搭的隧道，用 `--remote-port` 换一个）。这一版不改 sshd 的配置。
- headscale：原来就有 headscale；127.0.0.1:8080 被别的占着（`--headscale-port`）；3478/udp 被占着（`--no-derp` 不自建中转）；不是 amd64 / arm64。
- 域名在 VPS 上解析不到它自己的 IP；根分区不到 300 MB。

用 firewalld 的机器不会停下，但脚本不动防火墙，提醒你自己放行。

## 已经有 headscale

VPS 上原来就有你自己的 headscale 时，`setup headscale` 不覆盖它。要让服务管家的 tailnet 入口接着用它：

1. 把 headscale 配置里的 `dns.extra_records` 改成 `extra_records_path: /var/lib/headscale/extra-records.json`（文件里先放 `[]`），`headscale configtest` 后重启；
2. 在数据目录的 `registry\manager.yaml` 里配 `vps:`（`host`、`key`）和 `tailnet:`（`domain`、`gateway`、`records`、`certbotStopUnits`），见 `examples/registry/manager.yaml`。

## 选项

| 选项 | 默认 | 说明 |
|---|---|---|
| `--host [用户@]主机[:端口]` | 第一次必填 | 主机是 IPv4 或域名（第一版不认 IPv6）；用户默认 root |
| `--port <ssh 端口>` | 22 | |
| `--domain <域名>` | `<名字>.<IP>.sslip.io` | 换域名先 remove |
| `--name <名字>` | 隧道 `ergo`、headscale `hs` | 只用来拼默认域名 |
| `--email <邮箱>` | 不填 | Let's Encrypt 的到期提醒发到这里 |
| `--yes` | | 不问「照这份脚本执行？」（脚本照样整份显示） |
| `--print-script` | | 只打印脚本 |
| `--local-only` | | 只做电脑这一半和验收 |
| `--remote-port <端口>` | 18811 | 隧道在 VPS 上的端口（≥ 1024） |
| `--local-port <端口>` | 8811 | 隧道接电脑上的哪个端口；**8810 一律拒绝** |
| `--service-id <id>` | `ergo-vps-tunnel` | 服务管家里隧道服务的 id；同名的手写文件不碰 |
| `--no-start` | | 只登记隧道服务、不起（也就不验收） |
| `--no-derp` | | headscale 不自建中转、不开 3478/udp |
| `--headscale-version <x.y.z>` | 0.26.1 | 换版本先对照那一版的配置格式 |
| `--headscale-port <端口>` | 8080 | headscale 在 VPS 本机听的端口 |
| `--headscale-mirror <前缀>` | 不用镜像 | 安装包从「前缀 + GitHub 原地址」下；sha256 照样只认 GitHub 发布页的 `checksums.txt` |
| `--tailscale <路径>` | `C:\Program Files\Tailscale\tailscale.exe` | |

## 代码在哪

`src/vps/`：`cli.mjs`（命令行）→ `setup.mjs`（步骤）；`exec.mjs`（执行层：外部命令、端口、https、DNS 全经它，测试换成假的）、
`remote.mjs`（地址、钥匙、ssh）、`checkup.mjs`（体检的判断）、`scripts.mjs`（拼脚本、解析输出）、`verify.mjs`（验收）、
`local.mjs`（隧道服务的登记）、`headscale.mjs`、`state.mjs`；VPS 上跑的在 `src/vps/sh/*.sh`（真的 .sh 文件，拼装时只填参数）。

**证书和 nginx 站点是共用的**：`src/vps/certs.mjs` + `sh/certs.sh`（webroot / standalone 两种签法——standalone 先停占 80 的服务、
trap 保证签失败也拉起来——删证书、续期钩子、列到期日）、`src/vps/nginx.mjs`（80 端口的 ACME 段、二狗的隧道站点、headscale 站点；
`listen` 能传 `127.0.0.1:8443 ssl` 给有前门的布局用）。`lsm vps site add / certs / scan`（[vps-https.md](./vps-https.md)）也用它们。

## 测试

`npm run test:supervisor` 里的 `tests/vps-*.test.mjs`，不连任何真机器：

- **假 Debian**（`tests/_fake-debian.*`）：在临时目录里搭出 VPS 的根目录，apt-get、systemctl、nginx、certbot、ufw、useradd、headscale……
  换成按文件模拟状态的假命令，用 Git Bash 把生成的脚本**真的跑**：从零装、重跑什么都不改、断了接着做、`nginx -t` 不过撤回、
  sha256 对不上不装、`configtest` 不过换回、原来就有的不碰、两种方式先撤一种、原样撤干净。另外每份脚本都过 `bash -n`。
- **假执行层**（`tests/_fake-vps-exec.mjs`）：记下要跑的命令和送上 VPS 的脚本全文，按场景回话。验整条流程：先体检、
  脚本整份显示了才问、同意了才跑；认出接到了 8810 就拒绝并停掉隧道；一次性钥匙不显示不落盘；命令行端到端（`LSM_VPS_EXEC` 指向假执行层）。
- 「接到了 8810」的判断另外拿本机起的假二狗网关（照 8810 / 8811 的真实行为）真打一遍。

这一版还没在真的 Debian 上跑过：第一次在真机上用之前，先在一台测试用的 VPS 或虚拟机上从零装、重跑、撤各走一遍。
