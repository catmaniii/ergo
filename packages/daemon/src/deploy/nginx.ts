// 公网入口的 nginx 站点配置（规格第 6 节）：二狗生成，部署命令（deploy-nginx.ts）放上 VPS。
// 手机 → https://ergou.<VPS>.sslip.io（VPS 上的 nginx 终止 TLS）→ VPS 的 127.0.0.1:<隧道端口>（ergou-tunnel 的 ssh -R，
// 只绑 VPS 的本机地址）→ 隧道 → 本机守护进程的外网端口。
// - 支持 WebSocket（/ws 升级连接）；
// - 放大 client_max_body_size：单个文件上限 200 MB（09），整个文件一次传上来也放得下；
// - 加长 proxy_read_timeout / proxy_send_timeout：WebSocket 长连接不会被 nginx 的默认 60 秒掐掉；
// - 每个 location 都覆盖写 X-Forwarded-For 和 X-Real-IP（不用 $proxy_add_x_forwarded_for：那是追加，客户端带来的
//   前缀会留下）。nginx 的 proxy_set_header 在 location 里写了一条，server 里的就全部不继承，所以每个 location 都写全；
//   守护进程只在外网端口上信任 X-Real-IP，拿它做配对请求的限频；
// - HSTS 写在 server 里，location 里不写 add_header（否则会把 server 里的顶掉）。
// 证书沿用 VPS 上现有的 Let's Encrypt 做法，这里只引用证书路径，不签证书。
import type { PublicAccess } from "./public-access.ts";

/** 单个文件的上传上限是 200 MB（09 号票），留出余量 */
export const CLIENT_MAX_BODY_SIZE = "256m";
/** WebSocket 长连接：服务端每 30 秒 ping 一次，这里给足一小时 */
export const PROXY_TIMEOUT = "3600s";
/** HSTS：一年 */
export const HSTS_MAX_AGE_SECONDS = 365 * 24 * 3600;

/** 每个 location 都要写全的转发头：覆盖写来源（clientAddress 是客户端真实地址的变量），不追加 */
function forwardedHeaders(indent: string, clientAddress: string): string {
  return [
    "proxy_set_header Host $host;",
    `proxy_set_header X-Real-IP ${clientAddress};`,
    `proxy_set_header X-Forwarded-For ${clientAddress};`,
    "proxy_set_header X-Forwarded-Proto $scheme;",
  ]
    .map((line) => `${indent}${line}`)
    .join("\n");
}

export function nginxSiteConfig(access: PublicAccess): string {
  const upstream = `http://127.0.0.1:${access.tunnelPort}`;
  const cert = access.nginx.certificateDir.replace(/\/+$/, "");
  const loc = "        ";
  return `# 二狗（ergou）的公网入口：由二狗的部署命令生成并放上来，不要手改（重新部署会覆盖）。
# ${access.domain} → 127.0.0.1:${access.tunnelPort}（ergou-tunnel，只绑本机地址）→ 守护进程的外网端口

map $http_upgrade $ergou_connection_upgrade {
    default upgrade;
    '' close;
}

server {
    listen ${access.nginx.listen};
    server_name ${access.domain};

    ssl_certificate ${cert}/fullchain.pem;
    ssl_certificate_key ${cert}/privkey.pem;

    add_header Strict-Transport-Security "max-age=${HSTS_MAX_AGE_SECONDS}" always;

    client_max_body_size ${CLIENT_MAX_BODY_SIZE};
    proxy_read_timeout ${PROXY_TIMEOUT};
    proxy_send_timeout ${PROXY_TIMEOUT};

    # WebSocket：前端协议的唯一通道
    location /ws {
        proxy_pass ${upstream};
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection $ergou_connection_upgrade;
${forwardedHeaders(loc, access.nginx.clientAddress)}
        proxy_read_timeout ${PROXY_TIMEOUT};
    }

    # 页面、配对接口、历史分页、媒体上传下载
    location / {
        proxy_pass ${upstream};
        proxy_http_version 1.1;
${forwardedHeaders(loc, access.nginx.clientAddress)}
        # 上传的分片边收边转，不先攒在 VPS 上
        proxy_request_buffering off;
    }
}
`;
}
