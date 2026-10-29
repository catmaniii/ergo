# ---------------------------------------------------------------- 扫一遍已有的站点和证书（lsm vps scan；只读）
# 把 nginx 的配置（nginx -T）、证书和到期时刻、谁占着 80 / 443、这里装过什么（/etc/ergo-vps）原样交回本机，
# 本机解析后"认领"进状态文件：之后 lsm vps certs 也盯着它们的到期日。什么都不改——不装包、不写文件、不 reload。

kv() { printf '%s=%s\n' "$1" "$2"; }
yes_no() { if "$@" >/dev/null 2>&1; then echo 1; else echo 0; fi; }

echo "ERGO-SCAN=1"
ID="" PRETTY_NAME=""
# shellcheck disable=SC1091
if [ -r "$R/etc/os-release" ]; then . "$R/etc/os-release"; fi
kv OS_ID "$ID"
kv OS_PRETTY "$PRETTY_NAME"
kv PKG_NGINX "$(yes_no pkg_installed nginx)"
kv PKG_CERTBOT "$(yes_no pkg_installed certbot)"
kv LISTEN_TCP_80 "$(listener t 80)"
kv LISTEN_TCP_443 "$(listener t 443)"
kv MANIFESTS "$(cd "$STATE_DIR" 2>/dev/null && ls -- *.env 2>/dev/null | grep -v '^base\.env$' | tr '\n' ' ' || true)"
cert_report_all
nginx_dump
echo "ERGO-DONE scan"
