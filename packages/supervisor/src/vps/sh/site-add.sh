# ---------------------------------------------------------------- 加一个 https 站点（lsm vps site add <名字>）
# https://$DOMAIN → 这台 VPS 本机的 127.0.0.1:$UPSTREAM_PORT。布局是生成脚本前体检看出来的（参数 LAYOUT、CERT_HOW……），
# 跑之前先核对一遍现在还是不是那样，变了就停下（重跑 lsm vps site add 重新体检），一样东西都不改。

# 生成脚本时看到的布局，现在还是不是这样
site_guard() {
  local who80 who443
  who80=$(listener t 80)
  who443=$(listener t 443)
  if [ "$LAYOUT" = direct ]; then
    if grep -rqs ssl_preread "$R/etc/nginx"; then die "443 前面现在有 stream 前门了（生成脚本时没有）：重跑 lsm vps site add 重新体检"; fi
    if [ -n "$who443" ] && [ "$who443" != nginx ]; then die "443 现在被 $who443 占着：nginx 听不了 443。挪开它，或者重跑 lsm vps site add 重新体检"; fi
  else
    if ! grep -qs ssl_preread "$R$FD_FILE" && ! grep -rqs ssl_preread "$R/etc/nginx"; then die "生成脚本时 443 前面有 stream 前门，现在没有了：重跑 lsm vps site add 重新体检"; fi
  fi
  if ! cert_live "$DOMAIN"; then
    if [ "$CERT_HOW" = webroot ] && [ -n "$who80" ] && [ "$who80" != nginx ]; then
      die "80 现在被 $who80 占着（生成脚本时不是）：重跑 lsm vps site add 重新体检"
    fi
    if [ "$CERT_HOW" = standalone ] && [ -z "$STOP_UNITS" ] && [ -n "$who80" ]; then
      die "80 被 $who80 占着，又没说要临时停哪个服务：重跑 lsm vps site add 重新体检"
    fi
  fi
  step layout ok "布局和体检时一样（$LAYOUT，证书 $CERT_HOW）"
}

need_root
need_debian
site_guard
base_record
load_base

# 证书是不是这里签的：第一次跑时定下来（原来就有这张证书的，撤的时候不删它），之后重跑沿用
MODE_ENV="$STATE_DIR/site-$SITE_NAME.env"
CERT_OURS=""
if [ -f "$MODE_ENV" ]; then CERT_OURS=$(. "$MODE_ENV"; echo "${CERT_OURS:-}"); fi
if [ -z "$CERT_OURS" ]; then
  if cert_live "$DOMAIN"; then CERT_OURS=0; else CERT_OURS=1; fi
fi
write_mode_env "site-$SITE_NAME" "SITE_NAME=$SITE_NAME" "DOMAIN=$DOMAIN" "SITE=$SITE" "UPSTREAM_PORT=$UPSTREAM_PORT" \
  "CERT_OURS=$CERT_OURS" "FD_FILE=$FD_FILE" "FD_VAR=$FD_VAR" "NEED_RULES='80/tcp 443/tcp'"
echo "ERGO-RESULT CERT_OURS=$CERT_OURS"

FW_PKG=ufw
if firewalld_active; then FW_PKG=""; fi
if [ "$NO_START_INSTALL" = 1 ]; then
  # shellcheck disable=SC2086
  install_packages_no_start nginx certbot $FW_PKG unattended-upgrades
else
  # shellcheck disable=SC2086
  ensure_packages nginx certbot $FW_PKG unattended-upgrades
fi
ensure_auto_upgrades
ensure_firewall 80/tcp 443/tcp
if [ "$HTTP80" = 1 ]; then ensure_nginx_running; fi
site_with_cert "$SITE" "$DOMAIN" content_site_full content_site_http "$CERT_HOW" "$STOP_UNITS"
ensure_nginx_running
if [ "$LAYOUT" = frontdoor ]; then frontdoor_add; fi
install_renew_hook
echo "ERGO-DONE site"
