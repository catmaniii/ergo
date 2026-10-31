**中文** | [English](deployment.en.md)

# 部署和外网访问

二狗装在你自己的 Windows 电脑上，由服务管家托管、开机自启（见[安装、升级和卸载](install.md)）。这份文档讲怎么让手机、平板从外面连回这台电脑。手机上怎么用见[用户手册第 7 节](user-guide.md#7-手机上用)，设备配对和安全边界见 [SECURITY.md](../SECURITY.md)。

默认二狗只在这台电脑上用（`http://127.0.0.1:8810/`）。要在手机、平板上用，有三种方式，**推荐第一种**。

> **硬规矩**：三种方式都只能接二狗的**外网端口 8811**——那里每个请求都要设备凭证，新设备要你在电脑上批准。**本机端口 8810 绝不能经 Tailscale Serve、隧道或反向代理接出去**：从本机端口来的请求自动信任，接出去等于整个 tailnet（或整个互联网）免认证进你的二狗。

不管哪种方式，新设备第一次打开都会看到配对页：页面上显示设备名、6 位短码和 8 位短指纹 → 电脑上二狗的**待办**里出现一张配对请求卡，核对一致后点批准 → 回到手机上点"进入二狗"。以后在 **更多 · 设置 · 已配对设备** 里能延期、吊销、删除。待批的请求 5 分钟后过期；同一来源 10 分钟内最多申请 5 次。

| | 方式一：Tailscale 官方（推荐） | 方式二：自建 Headscale（进阶） | 方式三：VPS + 隧道 + nginx（公网） |
|---|---|---|---|
| 要什么 | 电脑、手机装 Tailscale，登同一个账号 | 一台 VPS，跑 Headscale | 一台 VPS、域名证书 |
| 谁能打开 | 只有你 tailnet 里的设备 | 只有你 tailnet 里的设备 | 任何浏览器（全靠配对把关） |
| HTTPS 证书 | Tailscale 自带 | VPS 上 certbot 签 | VPS 上 certbot 签 |
| 难度 | 最简单 | 中等 | 最难 |
| 注意 | 登录要 Google / 微软 / GitHub 等账号；中转服务器在海外，国内可能慢 | 可以自建中转，国内快 | 暴露在公网上，陌生人能看到配对页 |

## 方式一：Tailscale 官方（推荐）

设置向导里那一屏"外网访问"会介绍这三种方式；接 Tailscale 是手动三步：

1. 电脑上装 [Tailscale](https://tailscale.com/download/windows) 并登录；在 Tailscale 的管理后台打开 MagicDNS 和 HTTPS 证书。
2. 让 Tailscale 把本机的 **8811** 用 HTTPS 提供给你的 tailnet（只接 8811）：

   ```powershell
   tailscale serve --bg --https=443 http://127.0.0.1:8811
   ```

3. 手机装 Tailscale、登**同一个账号**，浏览器打开 `https://<电脑的机器名>.<你的 tailnet>.ts.net/`，按上面的步骤配对。

## 方式二：自建 Headscale（进阶）

适合想自己掌握控制节点、或者要国内快的。一台 Debian / Ubuntu 的 VPS，一条命令装好 [Headscale](https://github.com/juanfont/headscale)（可以再自建 DERP 中转）：

```powershell
lsm vps setup headscale --host root@<VPS 的 IP>    # 在 packages\supervisor 里；搭完 lsm vps status 看通不通
```

电脑和手机的 Tailscale 客户端都登到你自己的 Headscale；服务管家的 **tailnet 入口**给二狗开一个只在 tailnet 里能打开的 HTTPS 地址（VPS 上 certbot 签真证书，Headscale 的 DNS 记录把名字在 tailnet 里指回本机，本机的网关终结 TLS，转到 8811）：

```powershell
node bin\lsm.mjs tailnet ergo-daemon on <名字>
```

每一步做什么见 [vps.md](../packages/supervisor/docs/vps.md) 和服务管家 [README](../packages/supervisor/README.md) 的"可选功能 · tailnet 入口"。**VPS 那一头还没在真 Debian 上验过**（只在 Windows 上跑过电脑这一头），第一次用照文档一步步来。

## 方式三：VPS + ssh 反向隧道 + nginx（公网）

路径：`https://ergo.<VPS 的 IP>.sslip.io` → VPS 上的 nginx（HTTPS）→ VPS 的 `127.0.0.1:18811` → ssh 反向隧道（`ergo-tunnel`）→ 你电脑上守护进程的外网端口 8811。二狗自己不连 VPS。

一条命令把这套搭好：`lsm vps setup tunnel --host root@<VPS 的 IP>`（在 `packages\supervisor` 里），`lsm vps status` 看通不通；VPS 上原来就有站点的，用 `lsm vps site add` / `site remove` / `certs` / `scan` 接证书和站点，见 [vps-https.md](../packages/supervisor/docs/vps-https.md)。**VPS 那一头还没在真 Debian 上验过。**

不想用那条命令的话，下面每一步都由你来做。

1. **写配置**：在 `ergo.json` 里填 `publicAccess`（照 `config\ergo.example.json`）：VPS 的公网 IP、ssh 用户、ssh 私钥的绝对路径；`nginx.listen`（nginx 直接听 443 的写 `443 ssl`；前面还有一个按域名分流的前门的，写前门转过来的本机端口，比如 `127.0.0.1:8443 ssl`）；`nginx.certificateDir`（现有证书的目录）。
2. **证书**：用你在 VPS 上现有的 Let's Encrypt 做法，把 `ergo.<VPS 的 IP>.sslip.io` 加进证书。
3. **先看一眼**要部署的 nginx 配置：`npm run deploy:nginx -- --print`（只打印，不连 VPS）。
4. **部署**：`npm run deploy:nginx`。它 ssh 到 VPS 写站点配置，`nginx -t` 通过才重载，不通过就恢复原来的配置。
5. **登记隧道**：复制 `deploy\lsm\ergo-tunnel.example.yaml` 到服务管家数据目录的 `registry\services\ergo-tunnel.yaml`，换掉占位符（`<仓库路径>`、`<ssh 私钥路径>`、`<VPS 用户>`、`<VPS 地址>`）；再在 `ergo-daemon.yaml` 里去掉末尾 `exposure:` 那段的注释、换掉 `<VPS 地址>`。然后：

   ```powershell
   node bin\lsm.mjs validate
   node bin\lsm.mjs reload
   node bin\lsm.mjs start ergo-tunnel
   node bin\lsm.mjs autostart ergo-tunnel on
   ```

6. 手机浏览器打开 `https://ergo.<VPS 的 IP>.sslip.io/`，配对。

站在按域名分流的前门后面、前门又没开 `proxy_protocol` 时，nginx 看到的来源都是 127.0.0.1：配对卡上的来源写"经前门转发，无法识别"，配对请求的限频实际上是全局的（仍然安全，只是陌生人刷请求时你自己的配对也要等 10 分钟）。要按真实来源限频，得在前门上开 `proxy_protocol`、把 `nginx.clientAddress` 写成 `$proxy_protocol_addr`，这会影响同一个前门后面的其他站点，由你决定。
