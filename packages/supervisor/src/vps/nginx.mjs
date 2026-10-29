// VPS 上的 nginx 站点模板（321 号票写，322 的 `lsm vps site add` 接着用）。
//
// 每个站点两段：
//  - 80 端口：/.well-known/acme-challenge/ 指到 ACME_WEBROOT（certbot --webroot 签证书、续期都不用停 nginx），别的一律跳 https；
//  - 443 端口（有证书以后才写）：TLS 在这里终结，再转给本机（VPS 的 127.0.0.1）上的端口。
// 签证书之前只写 80 那段（httpOnly），签好再写完整的——nginx 不认没有证书文件的 443 站点。
//
// 二狗的隧道站点照二狗自己的模板（packages/daemon/src/deploy/nginx.ts）写：/ws 升级、/apps/ 升级且不缓冲、
// 上传边收边转、Host 原样转发、大上传、长超时、HSTS；每个 location 都覆盖写 X-Real-IP / X-Forwarded-For
// （nginx 的 proxy_set_header 在 location 里写了一条，server 里的就全不继承）。访客的真实 IP 用 $remote_addr——
// 新搭的 VPS 上 nginx 直接听 443，$remote_addr 就是访客；二狗按它给配对请求限频。
// （443 前面有 stream 前门、又没开 proxy_protocol 时 $remote_addr 永远是 127.0.0.1，所有访客挤一个限频桶——
//  体检看到这种布局就停下来，不往上搭；322 处理前门布局。）
export const ACME_WEBROOT = '/var/www/ergo-acme';
/** 单个文件上传上限是 200 MB（二狗），留出余量 */
export const CLIENT_MAX_BODY_SIZE = '256m';
/** WebSocket 长连接：二狗每 30 秒 ping 一次，这里给足一小时 */
export const PROXY_TIMEOUT = '3600s';
/** HSTS：一年 */
export const HSTS_MAX_AGE_SECONDS = 365 * 24 * 3600;

const DOMAIN = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9][a-z0-9-]{0,61}[a-z0-9]$/;
const VAR = /^[a-z_][a-z0-9_]*$/;

function check(domain, port) {
  if (!DOMAIN.test(domain)) throw new Error(`域名不对：${JSON.stringify(domain)}`);
  if (port != null && (!Number.isInteger(port) || port < 1 || port > 65535)) throw new Error(`端口不对：${port}`);
}

export const certDir = (domain) => `/etc/letsencrypt/live/${domain}`;

/** 80 端口：签证书用的 ACME 路径 + 别的跳 https。 */
export function httpServer(domain) {
  check(domain);
  return `server {
    listen 80;
    server_name ${domain};

    # 签证书、续期（certbot --webroot）：不用停 nginx
    location ^~ /.well-known/acme-challenge/ {
        root ${ACME_WEBROOT};
        default_type "text/plain";
    }

    location / {
        return 301 https://$host$request_uri;
    }
}
`;
}

/** 签证书之前只放 80 那段 */
export function httpOnlySite(domain, title, by = 'lsm vps setup') {
  return `# ${title}：由二狗的服务管家（${by}）写的，别手改（重跑会覆盖）。证书签好之前只有 80 端口这一段。

${httpServer(domain)}`;
}

/** 每个 location 都要写全的转发头：覆盖写来源（不追加，客户端带来的 X-Forwarded-For 前缀不留） */
function forwardedHeaders(indent, clientAddress) {
  return [
    'proxy_set_header Host $host;',
    `proxy_set_header X-Real-IP ${clientAddress};`,
    `proxy_set_header X-Forwarded-For ${clientAddress};`,
    'proxy_set_header X-Forwarded-Proto $scheme;',
  ].map((l) => indent + l).join('\n');
}

function tlsHead({ domain, listen }) {
  const cert = certDir(domain);
  return `    listen ${listen};
    server_name ${domain};

    ssl_certificate ${cert}/fullchain.pem;
    ssl_certificate_key ${cert}/privkey.pem;

    add_header Strict-Transport-Security "max-age=${HSTS_MAX_AGE_SECONDS}" always;`;
}

/**
 * 二狗的隧道站点：https://<domain> → VPS 的 127.0.0.1:<upstreamPort>（ssh 反向隧道）→ 二狗的外网端口。
 * listen 默认直接听 443；clientAddress 是访客真实地址的变量（直接听 443 时就是 $remote_addr）。
 */
export function ergoTunnelSite({ domain, upstreamPort, listen = '443 ssl', clientAddress = '$remote_addr', mapVar = 'ergo_tunnel_upgrade' }) {
  check(domain, upstreamPort);
  if (!VAR.test(mapVar)) throw new Error(`map 变量名不对：${mapVar}`);
  const up = `http://127.0.0.1:${upstreamPort}`;
  const loc = '        ';
  return `# 二狗（ergo）的隧道入口：由服务管家（lsm vps setup tunnel）写的，别手改（重跑会覆盖）。
# https://${domain} → 127.0.0.1:${upstreamPort}（电脑起的 ssh 反向隧道，只绑这台的本机地址）→ 二狗的外网端口

map $http_upgrade $${mapVar} {
    default upgrade;
    '' close;
}

${httpServer(domain)}
server {
${tlsHead({ domain, listen })}

    client_max_body_size ${CLIENT_MAX_BODY_SIZE};
    proxy_read_timeout ${PROXY_TIMEOUT};
    proxy_send_timeout ${PROXY_TIMEOUT};

    # WebSocket：前端协议的唯一通道
    location /ws {
        proxy_pass ${up};
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection $${mapVar};
${forwardedHeaders(loc, clientAddress)}
        proxy_read_timeout ${PROXY_TIMEOUT};
    }

    # 转发本机服务的页面：服务的 WebSocket 要升级、流式响应不能攒在 VPS 上
    location /apps/ {
        proxy_pass ${up};
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection $${mapVar};
${forwardedHeaders(loc, clientAddress)}
        proxy_buffering off;
        proxy_request_buffering off;
    }

    # 页面、配对接口、历史分页、媒体上传下载
    location / {
        proxy_pass ${up};
        proxy_http_version 1.1;
${forwardedHeaders(loc, clientAddress)}
        # 上传的分片边收边转，不先攒在 VPS 上
        proxy_request_buffering off;
    }
}
`;
}

/**
 * headscale 的站点（照 headscale 文档给的 nginx 反代写法）：控制协议和内置中转（/derp）都要 WebSocket 升级、不缓冲；
 * Host 写成 server_name；headscale 回的 http:// 跳转改成 https://。
 */
export function headscaleSite({ domain, upstreamPort, listen = '443 ssl', mapVar = 'ergo_headscale_upgrade' }) {
  check(domain, upstreamPort);
  if (!VAR.test(mapVar)) throw new Error(`map 变量名不对：${mapVar}`);
  return `# headscale（自建 tailnet 的控制节点）：由二狗的服务管家（lsm vps setup headscale）写的，别手改（重跑会覆盖）。
# https://${domain} → 127.0.0.1:${upstreamPort}（headscale 只听本机）

map $http_upgrade $${mapVar} {
    default upgrade;
    '' close;
}

${httpServer(domain)}
server {
${tlsHead({ domain, listen })}

    location / {
        proxy_pass http://127.0.0.1:${upstreamPort};
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection $${mapVar};
        proxy_set_header Host $server_name;
        proxy_redirect http:// https://;
        proxy_buffering off;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $remote_addr;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
`;
}

// ---------------------------------------------------------------- 通用站点（lsm vps site add，322 号票）
// https://<域名> → 这台 VPS 本机的 127.0.0.1:<端口>。照二狗自己的模板（packages/daemon/src/deploy/nginx.ts）的要点：
// WebSocket 升级、Host 原样转发、大上传、请求体不缓冲（边收边转）、长超时、HSTS；真实 IP 覆盖写进 X-Real-IP / X-Forwarded-For。
// 布局（体检看出来的）：
//  - 直接听 443（listen 443 ssl）：访客的真实 IP 就是 $remote_addr；
//  - 443 前面有 stream 前门：只听前门后面的本机地址（比如 listen 127.0.0.1:8443 ssl），不抢 443；
//    前门开了 proxy_protocol 的，listen 加 proxy_protocol、真实 IP 用 $proxy_protocol_addr；没开的，$remote_addr 都是 127.0.0.1。
//  - 80 被 nginx 以外的程序占着（证书用 standalone 签）：不写 80 端口那段（nginx 抢不到 80）。

/** 站点名（lsm vps site add 的 <名字>）：小写字母、数字、连字符，最长 40 */
export const SITE_NAME = /^[a-z0-9]([a-z0-9-]{0,38}[a-z0-9])?$/;
/** nginx 站点文件名（不带 .conf） */
export const siteFile = (name) => `ergo-site-${name}`;
/** 每个站点自己的 map 变量（map 定义的是全局变量，两个站点不能重名） */
export const upgradeVar = (name) => `ergo_site_${String(name).replace(/-/g, '_')}_upgrade`;

const LISTEN = /^(443|127\.0\.0\.1:\d{1,5}) ssl( proxy_protocol)?$/;
const CLIENT = /^\$(remote_addr|proxy_protocol_addr)$/;

export function genericSite({ name, domain, upstreamPort, listen = '443 ssl', clientAddress = '$remote_addr', http80 = true }) {
  if (!SITE_NAME.test(name)) throw new Error(`站点名不对：${JSON.stringify(name)}`);
  check(domain, upstreamPort);
  if (!LISTEN.test(listen)) throw new Error(`listen 不对：${listen}`);
  if (!CLIENT.test(clientAddress)) throw new Error(`访客地址的变量不对：${clientAddress}`);
  const v = upgradeVar(name);
  const loc = '        ';
  const layout = listen === '443 ssl'
    ? '# 直接听 443：访客的真实 IP 就是 $remote_addr。'
    : clientAddress === '$proxy_protocol_addr'
      ? `# 443 前面有 stream 前门（开了 proxy_protocol）：这里只听 ${listen.split(' ')[0]}，访客的真实 IP 是 $proxy_protocol_addr。`
      : `# 443 前面有 stream 前门（没开 proxy_protocol）：这里只听 ${listen.split(' ')[0]}；访客的 IP 在这里都是 127.0.0.1。`;
  return `# ${name}：由二狗的服务管家（lsm vps site add ${name}）写的，别手改（重跑会覆盖；lsm vps site remove ${name} 原样撤掉）。
# https://${domain} → 127.0.0.1:${upstreamPort}（这台 VPS 本机上的服务）
${layout}${http80 ? '' : '\n# 80 端口被别的程序占着：这里不写 80 那段，证书用 standalone 签（签、续期时临时停它）。'}

map $http_upgrade $${v} {
    default upgrade;
    '' close;
}
${http80 ? `\n${httpServer(domain)}` : ''}
server {
${tlsHead({ domain, listen })}

    client_max_body_size ${CLIENT_MAX_BODY_SIZE};
    proxy_read_timeout ${PROXY_TIMEOUT};
    proxy_send_timeout ${PROXY_TIMEOUT};

    location / {
        proxy_pass http://127.0.0.1:${upstreamPort};
        proxy_http_version 1.1;
        # WebSocket 升级
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection $${v};
${forwardedHeaders(loc, clientAddress)}
        # 上传边收边转，不先攒在 VPS 上
        proxy_request_buffering off;
    }
}
`;
}
