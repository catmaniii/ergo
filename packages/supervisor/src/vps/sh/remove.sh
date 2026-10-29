# ---------------------------------------------------------------- 原样撤掉（lsm vps remove <方式>、lsm vps site remove <名字>）
# 照 /etc/ergo-vps 里记的撤：这种方式装的站点、证书、账号 / headscale，这种方式开的防火墙端口（别的方式还要的留着）。
# 站点（site）：拿掉站点、前门里加的那一行；证书是这里签的才删（原来就有的留着）。
# 两种方式和所有站点都撤完了，再把公共的那部分（nginx、certbot、ufw……）按"装之前原来有没有"原样撤掉：
# 原来就有的一律不动，原来没有、是我们装的才卸。自动安全更新（unattended-upgrades 和打开它的那个文件）一律留着：
# 撤掉入口不该顺带把这台 VPS 的安全更新也关了。能重复跑：已经撤掉的跳过。

revoke_admin_key() {
  local home ak
  home=$(getent passwd "${SUDO_USER:-root}" | cut -d: -f6)
  ak="$R$home/.ssh/authorized_keys"
  if [ -n "${ADMIN_PUBKEY:-}" ] && [ -f "$ak" ] && grep -qxF "$ADMIN_PUBKEY" "$ak"; then
    grep -vxF "$ADMIN_PUBKEY" "$ak" > "$ak.ergo-tmp" || true
    chmod 600 "$ak.ergo-tmp"
    mv "$ak.ergo-tmp" "$ak"
    step admin-key ok "管理用的钥匙从 authorized_keys 里拿掉了，这台 VPS 不再认它"
  else
    step admin-key skip
  fi
}

need_root
if [ ! -d "$STATE_DIR" ]; then
  note "这台 VPS 上没有二狗服务管家的记录（/etc/ergo-vps），没什么可撤的"
  echo "ERGO-DONE remove"
  exit 0
fi
load_base

# 记录文件：方式是 tunnel.env / headscale.env，站点是 site-<名字>.env
MODE_KEY="$MODE"
if [ "$MODE" = site ]; then MODE_KEY="site-$SITE_NAME"; fi
if [ -f "$STATE_DIR/$MODE_KEY.env" ]; then
  # shellcheck disable=SC1090
  . "$STATE_DIR/$MODE_KEY.env"
else
  note "VPS 上没有 $MODE_KEY 的记录（可能已经撤过）：按本机记的名字再清一遍"
fi

case "$MODE" in
  tunnel)
    site_remove "$SITE"
    cert_delete "$DOMAIN"
    if id -u "$TUNNEL_USER" >/dev/null 2>&1; then
      pkill -u "$TUNNEL_USER" 2>/dev/null || true
      userdel -r "$TUNNEL_USER" 2>/dev/null || userdel "$TUNNEL_USER"
      step tunnel-account ok "删了受限账号 $TUNNEL_USER"
    else
      step tunnel-account skip "受限账号本来就没有"
    fi
    ;;
  headscale)
    site_remove "$SITE"
    cert_delete "$DOMAIN"
    if has systemctl && systemctl cat headscale >/dev/null 2>&1; then systemctl disable --now headscale >/dev/null 2>&1 || true; fi
    if [ "${PRE_PKG_HEADSCALE:-1}" = 0 ]; then
      if pkg_installed headscale; then apt-get purge -y -q headscale >/dev/null; fi
      rm -rf "$R/var/lib/headscale" "$R/etc/headscale"
      step headscale ok "卸了 headscale、删了它的数据（tailnet 里登记的设备一起没了）"
    else
      step headscale skip "headscale 不是我们装的，没卸"
    fi
    ;;
  site)
    site_remove "$SITE"
    if [ -n "${FD_FILE:-}" ]; then frontdoor_remove; fi
    if [ "${CERT_OURS:-0}" = 1 ]; then
      cert_delete "$DOMAIN"
    else
      step "cert-$DOMAIN" skip "证书不是这里签的（原来就有），留着"
    fi
    ;;
  *) die "不认识的方式：$MODE" ;;
esac
rm -f "$STATE_DIR/$MODE_KEY.env"

# 别的方式还在用的端口
STILL=""
OTHERS=0
for f in "$STATE_DIR"/*.env; do
  if [ ! -e "$f" ] || [ "$(basename "$f")" = base.env ]; then continue; fi
  OTHERS=1
  STILL="$STILL $(. "$f"; echo "${NEED_RULES:-}")"
done

# 这种方式开的端口：我们加的、别的方式不再要的才删（原来就有的规则不在 ufw-added 里，碰不到）
if has ufw && [ -f "$FW_ADDED" ]; then
  : > "$FW_ADDED.keep"
  while read -r rule; do
    if [ -z "$rule" ]; then continue; fi
    case " $STILL " in
      *" $rule "*) echo "$rule" >> "$FW_ADDED.keep" ;;
      *) ufw delete allow "$rule" >/dev/null 2>&1 || true; note "防火墙关上了 $rule" ;;
    esac
  done < "$FW_ADDED"
  mv "$FW_ADDED.keep" "$FW_ADDED"
fi

if [ "$OTHERS" = 0 ]; then
  # 公共的部分：原来没有、是我们装的才卸
  rm -f "$RENEW_HOOK"
  rm -rf "$R$ACME_WEBROOT"
  if [ "${PRE_AUTO_UPGRADES:-1}" = 0 ] && [ -f "$AUTO_UPGRADES_FILE" ]; then note "自动安全更新留着（是这里打开的，撤的时候不关）"; fi
  if has ufw; then
    if [ "${PRE_UFW_ACTIVE:-1}" = 0 ] && ufw_active; then
      ufw --force disable >/dev/null
      note "ufw 关回去了（原来就是关着的）"
    fi
    # ssh 端口的规则只在 ufw 关着时才删：开着的时候删它，就把自己关在外面了
    if ! ufw_active && [ -f "$FW_ADDED_SSH" ]; then
      while read -r rule; do
        if [ -n "$rule" ]; then ufw delete allow "$rule" >/dev/null 2>&1 || true; fi
      done < "$FW_ADDED_SSH"
    fi
  fi
  PURGE=""
  # unattended-upgrades 不在这里：自动安全更新撤的时候留着
  for p in headscale ufw certbot nginx nginx-common curl; do
    v=$(pkg_var "$p")
    if [ "${!v:-1}" = 0 ] && pkg_installed "$p"; then PURGE="$PURGE $p"; fi
  done
  if [ -n "$PURGE" ]; then
    # shellcheck disable=SC2086
    apt-get purge -y -q $PURGE >/dev/null
    step packages ok "卸了原来没有的:$PURGE（它们拉进来的依赖包留着，想清可以 apt autoremove）"
  else
    step packages skip "装的包原来就都有，一个没卸"
  fi
  # certbot 是我们装的、我们的证书都删了、也没有别的证书：它的目录一起删
  if [ "${PRE_PKG_CERTBOT:-1}" = 0 ] && [ -d "$R/etc/letsencrypt" ] && [ -z "$(find "$R/etc/letsencrypt/live" -mindepth 1 -maxdepth 1 -type d 2>/dev/null)" ]; then
    rm -rf "$R/etc/letsencrypt"
  fi
  if [ "${REVOKE_ADMIN:-0}" = 1 ]; then revoke_admin_key; fi
  rm -rf "$STATE_DIR"
  note "这台 VPS 上二狗服务管家装的东西都撤完了"
fi
echo "ERGO-DONE remove"
