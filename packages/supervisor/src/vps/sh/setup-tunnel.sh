# ---------------------------------------------------------------- 搭隧道入口（lsm vps setup tunnel）
# 手机 → https://$DOMAIN（这台的 nginx 终结 TLS，把访客真实 IP 放进 X-Real-IP）→ 127.0.0.1:$TUNNEL_PORT
# → 电脑上起的 ssh 反向隧道 → 二狗的外网端口（每个请求都要设备凭证）。隧道只绑这台的 127.0.0.1，外面只能经 nginx 进来。

# 受限账号：只能做这一个端口的反向转发，不能登录、不能执行命令、不能转发别的端口。
# authorized_keys 那一行：restrict 关掉终端、X11、agent 转发；port-forwarding 只放开转发；permitlisten 只许这一个端口；
# command="/bin/false" 多一层保险——拿这把钥匙要求开会话、跑命令，跑的也只是 /bin/false（隧道是 ssh -N，不开会话，不受影响）
ensure_tunnel_account() {
  local u="$TUNNEL_USER" home line ak
  if ! id -u "$u" >/dev/null 2>&1; then
    useradd --system --create-home --home-dir "/var/lib/$u" --shell /usr/sbin/nologin --comment "ergo tunnel (port forwarding only)" "$u"
    # 口令字段从"锁住"（!）改成"没有口令"（*）：sshd 在 UsePAM no 时会拒绝锁住的账号用钥匙登录；* 照样没法用口令登录
    usermod -p '*' "$u"
    note "建了受限账号 $u"
  fi
  home="$R/var/lib/$u"
  line="restrict,port-forwarding,permitlisten=\"127.0.0.1:$TUNNEL_PORT\",command=\"/bin/false\" $TUNNEL_PUBKEY"
  ak="$home/.ssh/authorized_keys"
  mkdir -p "$home/.ssh"
  chmod 700 "$home/.ssh"
  chown "$u:$u" "$home/.ssh"
  if [ -f "$ak" ] && [ "$(cat "$ak")" = "$line" ]; then
    step tunnel-account skip "受限账号 $u 和它的钥匙都在"
    return 0
  fi
  printf '%s\n' "$line" > "$ak.tmp"
  chmod 600 "$ak.tmp"
  chown "$u:$u" "$ak.tmp"
  mv "$ak.tmp" "$ak"
  step tunnel-account ok "受限账号 $u 只能把 127.0.0.1:$TUNNEL_PORT 转回电脑"
}

need_root
need_debian
base_record
load_base
write_mode_env tunnel "DOMAIN=$DOMAIN" "SITE=$SITE" "TUNNEL_USER=$TUNNEL_USER" "TUNNEL_PORT=$TUNNEL_PORT" "NEED_RULES='80/tcp 443/tcp'"

FW_PKG=ufw
if firewalld_active; then FW_PKG=""; fi
# shellcheck disable=SC2086
ensure_packages nginx certbot $FW_PKG unattended-upgrades
ensure_auto_upgrades
ensure_firewall 80/tcp 443/tcp
ensure_nginx_running
ensure_tunnel_account
site_with_cert "$SITE" "$DOMAIN" content_site_full content_site_http
install_renew_hook
echo "ERGO-DONE tunnel"
