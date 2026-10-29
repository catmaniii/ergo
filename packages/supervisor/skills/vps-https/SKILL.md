---
name: vps-https
description: 在 Debian / Ubuntu 的 VPS 上给服务接 https（Let's Encrypt 证书 + nginx 站点）、看证书哪天到期、认领 VPS 上原来就有的站点，用二狗服务管家的 `lsm vps site add / site remove / certs / scan`。用户说"给 VPS 上的某个服务开 https / 配域名 / 签证书 / 证书快过期了 / 续期 / nginx 反代 / 80 端口被占 / 443 前面有前门 / sslip.io"时用；签证书、nginx 出错要手动排查时也用。不管 VPS 上的系统怎么装、云厂商安全组怎么开（那些只提醒用户自己做）。
---

# VPS 上的 https 站点和证书

命令都在服务管家的包里跑（`packages/supervisor` 下 `node bin/lsm.mjs …`，下文写 `lsm`）。每一步做了什么、选项全表在
`packages/supervisor/docs/vps-https.md`；`lsm vps setup`（隧道入口、自建 tailnet）在 `docs/vps.md`。

## 规矩（先读）

1. **碰 VPS 前先把要跑的给用户看、等用户点头。** `site add / site remove` 自己会整份显示脚本再问；
   你替用户跑时**不要加 `--yes`**，除非用户明确说了。只读的 `scan`、`certs` 第一次在用户的 VPS 上跑之前也先说一句要跑什么、问一下。
   要先看脚本：`--print-script`。
2. 用户自己的 VPS 上原来就有的站点、前门、证书：只用 `scan` 认领，**不改**。要改用户原来的配置，先问。
3. 二狗的本机端口 **8810 绝不接出去**（本机来的一律信任）；对外只能是外网端口 8811。验收认出 8810 会当场撤站点——别绕过它。
4. 密码不经手：钥匙登不进去时程序打印一句让用户自己在终端里跑（会问 VPS 密码），你不要替用户输密码、不要把密码写进命令。
5. 例子、文档里只用 `example.com`、`203.0.113.x`，不写用户真实的域名和 IP。

## 什么时候用哪条

| 用户想要 | 命令 |
|---|---|
| VPS 本机 127.0.0.1:3000 上的服务要一个 https 地址 | `lsm vps site add <名字> --port 3000 [--host root@<IP>] [--domain <域名>]` |
| 站点本来就公开（不带凭证也该能打开） | 同上加 `--public`（不加时，不带凭证就能打开算验收没过） |
| 撤掉 | `lsm vps site remove <名字>` |
| 证书哪天到期 / 快过期了 | `lsm vps certs`（只读；少于 20 天标出来、退出码 1） |
| 用户手工配过站点，想让服务管家知道 | `lsm vps scan --host root@<IP>`（只读认领，不改） |
| 二狗的外网入口（隧道 + nginx） | 不是这里：`lsm vps setup tunnel`（docs/vps.md） |

默认域名 `<名字>.<IP>.sslip.io` 不用买域名、不用配 DNS。它的 Let's Encrypt 频率限制是全世界共用的（sslip.io 不在公共后缀列表里，见 docs/vps-https.md）：
第一次签偶尔会被限，过几小时重跑就行；急就用自己的域名或换 `nip.io`。别反复撤了又加同一个域名（同一个域名每 7 天最多 5 张）。

## 程序自己会处理的布局（看到提示别慌）

- **80 被别的程序占着**：程序认出 systemd 单元，单独问"同意签证书时临时停 X？"，同意后 standalone 签、trap 保证拉起、续期也会停一下。
  认不出单元（docker 容器之类）会停下：让用户自己挪开，或者 `--stop-unit <单元全名>`。docker / sshd 之类不替他停。
- **443 前面有 stream 前门**：站点只听前门后面的 `127.0.0.1:<端口>`，往前门 map 里加一行。认不出那个地址时用 `--frontdoor-backend 127.0.0.1:8443`。
  前门没开 `proxy_protocol` 时会提醒"访客 IP 都是 127.0.0.1"——要不要开由用户决定（会动到他别的站点），不要擅自改。
- **`nginx -t` 不过**：已经自动换回原样，脚本停下。看输出里 `nginx -t` 的最后几行。

## 失败时按踩过的坑排查（只读命令先行，改东西前问用户）

1. **签证书失败 / 超时**：先看云厂商的**安全组**放没放行 TCP 80（体检会从电脑上连一下，超时多半就是它）；`site add` 的体检会列出谁占着 80 / 443；
   域名真的解析到这台吗（体检的 DNS 一项；自己的域名要 A 记录）；被 Let's Encrypt 限频（报 rateLimited）就等，不要连着重试。
2. **80 被占**：`ss -ltnp 'sport = :80'` 看是谁；临时停它签证书是程序的事，别手动长时间停用户的服务。
3. **443 前门**：所有 https 都先进前门（nginx 的 `stream {}`），站点要在前门 map 里有一行指到前门后面的地址，站点自己只听那个本机地址——
   写 `listen 443` 会让前门和所有站点一起挂。真实 IP 只有前门开了 `proxy_protocol`、后面站点的 listen 也带 `proxy_protocol` 才过得来。
4. **nginx 漏项**：反代 WebSocket 要 `proxy_http_version 1.1` + `Upgrade` / `Connection` 两个头；`proxy_set_header` 在 location 里写了一条，
   server 里的就全不继承——每个 location 都要写全；大上传要 `client_max_body_size`；长连接要长 `proxy_read_timeout`。程序生成的模板都有。
5. **真实 IP**：后面服务看到的都是 127.0.0.1 → 要么前门没开 proxy_protocol，要么站点没把 `X-Real-IP` 设成访客地址变量。
6. **Windows 路径进 YAML 被转义吃坏**：服务管家的注册表里写 Windows 路径（钥匙之类）要用 JSON 字符串写法（双引号、反斜杠成对），
   `"C:\vps\a"` 这种 `\v`、`\a` 会变成控制字符；改完 `lsm validate` 读回来核对。
7. **只接对外端口，不接本机端口**：隧道、站点后面接二狗只能接 8811；验收报"接到了 8810"就是接错了。

## 交回给用户时说清

做了什么（域名、站点名、后面接哪个端口、布局、证书怎么签的）、验收结果（证书到期日、不带凭证回什么）、还剩什么要用户自己做（安全组、DNS、要不要开 proxy_protocol）。
