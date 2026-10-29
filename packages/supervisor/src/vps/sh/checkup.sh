# ---------------------------------------------------------------- 体检（只读，什么都不改）
# 每行 键=值，本机解析后判断能不能搭、要提醒什么。

kv() { printf '%s=%s\n' "$1" "$2"; }
yes_no() { if "$@" >/dev/null 2>&1; then echo 1; else echo 0; fi; }

echo "ERGO-CHECKUP=1"
ID="" ID_LIKE="" VERSION_ID="" PRETTY_NAME=""
# shellcheck disable=SC1091
if [ -r "$R/etc/os-release" ]; then . "$R/etc/os-release"; fi
kv OS_ID "$ID"
kv OS_LIKE "$ID_LIKE"
kv OS_VERSION "$VERSION_ID"
kv OS_PRETTY "$PRETTY_NAME"
kv ARCH "$(dpkg --print-architecture 2>/dev/null || uname -m)"
kv IS_ROOT "$(yes_no test "$(id -u)" = 0)"
kv SYSTEMD "$(yes_no has systemctl)"
kv APT "$(yes_no has apt-get)"
for p in nginx certbot ufw unattended-upgrades headscale curl; do
  kv "PKG_$(echo "$p" | tr 'a-z-' 'A-Z_')" "$(yes_no pkg_installed "$p")"
done
kv HEADSCALE_BIN "$(yes_no has headscale)"
kv HEADSCALE_VERSION "$(headscale version 2>/dev/null | grep -Eo '[0-9]+\.[0-9]+\.[0-9]+' | head -1 || true)"
kv NGINX_SITES "$(yes_no grep -qs sites-enabled "$R/etc/nginx/nginx.conf")"
# 443 前面有 stream 的 SNI 前门（ssl_preread）：站点不能直接听 443，访客的真实 IP 也要前门开 proxy_protocol 才传得过来
kv NGINX_STREAM_443 "$(yes_no grep -rqs ssl_preread "$R/etc/nginx")"
kv UFW_ACTIVE "$(yes_no ufw_active)"
kv FIREWALLD_ACTIVE "$(yes_no firewalld_active)"
kv AUTO_UPGRADES "$(yes_no auto_upgrades_on)"
SSHD_T=$(sshd -T 2>/dev/null || true)
kv SSHD_TCP_FORWARDING "$(echo "$SSHD_T" | awk '$1=="allowtcpforwarding"{print $2}')"
kv SSHD_ALLOW_USERS "$(echo "$SSHD_T" | awk '$1=="allowusers"{$1=""; print}' | xargs echo)"
kv SSHD_ALLOW_GROUPS "$(echo "$SSHD_T" | awk '$1=="allowgroups"{$1=""; print}' | xargs echo)"
kv OPENSSH_VERSION "$(ssh -V 2>&1 | grep -Eo 'OpenSSH_[0-9]+\.[0-9]+' | head -1 | cut -d_ -f2 || true)"
kv LISTEN_TCP_80 "$(listener t 80)"
# 占着 80 的是哪个 systemd 单元（site add 要临时停它签证书时用；认不出是空的）
kv LISTEN_TCP_80_UNIT "$(listener_unit t 80)"
kv LISTEN_TCP_443 "$(listener t 443)"
kv LISTEN_UDP_3478 "$(listener u 3478)"
kv LISTEN_TCP_HS "$(listener t "$HS_PORT")"
kv LISTEN_TCP_TUNNEL "$(listener t "$TUNNEL_PORT")"
# 对外在听的端口（打开防火墙后外面就进不来了，要提醒）
kv PUBLIC_TCP "$(ss -H -ltn 2>/dev/null | awk '{print $4}' | grep -Ev '^(127\.|\[::1\]|\[::ffff:127\.)' | sed -E 's/.*:([0-9]+)$/\1/' | sort -un | tr '\n' ' ' || true)"
kv MANIFEST_BASE "$(yes_no test -f "$STATE_DIR/base.env")"
kv MANIFEST_TUNNEL "$(yes_no test -f "$STATE_DIR/tunnel.env")"
kv MANIFEST_HEADSCALE "$(yes_no test -f "$STATE_DIR/headscale.env")"
kv DISK_FREE_MB "$(df -Pm / 2>/dev/null | awk 'NR==2{print $4}')"
kv DNS_OK "$(yes_no dns_points_here "$DOMAIN" "$PUBLIC_IP")"
# 这个域名的证书已经有了没有（还剩几天；没有是 -1）
kv CERT_LEFT "$(cert_days_left "$DOMAIN")"
# site add 要看布局：把 nginx 的配置原样交回来（只读）
if [ "${WANT_NGINX_DUMP:-0}" = 1 ]; then nginx_dump; fi
echo "ERGO-DONE checkup"
