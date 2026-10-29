# ---------------------------------------------------------------- 搭自建 tailnet 的控制节点（lsm vps setup headscale）
# headscale 只听这台的 127.0.0.1:$HS_PORT，外面经 nginx（https://$DOMAIN，真证书）进来；可选自建中转（DERP，要 3478/udp）。
# DNS 记录走 extra_records_path 那个文件：服务管家的 tailnet 入口往里写"名字 → 电脑的 tailnet 地址"，headscale 盯着它、改了几秒内下发。

HS_CONF="$R/etc/headscale/config.yaml"
HS_RECORDS="$R/var/lib/headscale/extra-records.json"

hs_version() { headscale version 2>/dev/null | grep -Eo '[0-9]+\.[0-9]+\.[0-9]+' | head -1 || true; }

ensure_headscale_installed() {
  if [ "$(hs_version)" = "$HS_VERSION" ]; then
    step headscale-install skip "已经是 $HS_VERSION"
    return 0
  fi
  local arch deb url tmpd
  arch=$(dpkg --print-architecture)
  case "$arch" in amd64|arm64) ;; *) die "headscale 没有 $arch 的安装包" ;; esac
  deb="headscale_${HS_VERSION}_linux_${arch}.deb"
  url="https://github.com/juanfont/headscale/releases/download/v${HS_VERSION}"
  # 镜像（--headscale-mirror，给连 GitHub 慢的 VPS 用）只换安装包从哪下：地址 = 镜像前缀 + GitHub 上的原地址。
  # 校验和永远从 GitHub 发布页取、不从镜像取——镜像给的安装包要和官方 checksums.txt 里的 sha256 对得上才装
  deb_url="$url/$deb"
  if [ -n "${HS_MIRROR:-}" ]; then deb_url="${HS_MIRROR}${deb_url}"; fi
  tmpd=$(mktemp -d)
  curl -fsSL --retry 3 -o "$tmpd/$deb" "$deb_url" || die "下载 $deb 失败（$deb_url）"
  curl -fsSL --retry 3 -o "$tmpd/checksums.txt" "$url/checksums.txt" || die "从 GitHub 发布页下载 headscale 的校验和失败（校验和只认官方的，不从镜像取）"
  if ! (cd "$tmpd" && grep -E "[[:space:]]$deb\$" checksums.txt | sha256sum -c --status -); then
    rm -rf "$tmpd"
    die "$deb 的 sha256 和 GitHub 发布页的 checksums.txt 对不上，没装${HS_MIRROR:+（安装包是从镜像 $HS_MIRROR 下的）}"
  fi
  apt-get install -y -q "$tmpd/$deb"
  rm -rf "$tmpd"
  step headscale-install ok "装了 headscale $HS_VERSION${HS_MIRROR:+（安装包从镜像下的，sha256 和官方的对上了）}"
}

# 整份写配置（只认 HS_VERSION 这一版的格式）。包里自带的那份第一次留底成 config.yaml.ergo-orig，remove 时放回。
# headscale configtest 不过就换回上一份、退出。
ensure_headscale_config() {
  local tmp
  HS_CONF_CHANGED=0
  mkdir -p "$(dirname "$HS_CONF")" "$(dirname "$HS_RECORDS")"
  tmp=$(mktemp)
  content_headscale_config > "$tmp"
  if [ -f "$HS_CONF" ] && cmp -s "$tmp" "$HS_CONF"; then
    rm -f "$tmp"
    step headscale-config skip
  else
    if [ -f "$HS_CONF" ] && [ ! -f "$HS_CONF.ergo-orig" ]; then cp -p "$HS_CONF" "$HS_CONF.ergo-orig"; fi
    rm -f "$HS_CONF.ergo-prev"
    if [ -f "$HS_CONF" ]; then cp -p "$HS_CONF" "$HS_CONF.ergo-prev"; fi
    cp "$tmp" "$HS_CONF"
    chmod 644 "$HS_CONF"
    rm -f "$tmp"
    if ! headscale -c "$HS_CONF" configtest >/dev/null 2>&1; then
      headscale -c "$HS_CONF" configtest 2>&1 | tail -5 >&2 || true
      if [ -f "$HS_CONF.ergo-prev" ]; then mv "$HS_CONF.ergo-prev" "$HS_CONF"; fi
      die "headscale configtest 没通过，配置已换回原来的"
    fi
    rm -f "$HS_CONF.ergo-prev"
    HS_CONF_CHANGED=1
    step headscale-config ok
  fi
  if [ ! -f "$HS_RECORDS" ]; then
    echo '[]' > "$HS_RECORDS"
    chown headscale:headscale "$HS_RECORDS" 2>/dev/null || true
    chmod 640 "$HS_RECORDS"
    note "建了空的 DNS 记录文件 /var/lib/headscale/extra-records.json"
  fi
}

ensure_headscale_running() {
  local i restarted=0
  systemctl enable headscale >/dev/null 2>&1 || true
  if [ "$HS_CONF_CHANGED" = 1 ] || ! systemctl is-active --quiet headscale; then systemctl restart headscale; restarted=1; fi
  for i in $(seq 1 30); do
    if curl -fsS "http://127.0.0.1:$HS_PORT/health" >/dev/null 2>&1; then
      if [ "$restarted" = 1 ]; then step headscale-running ok "127.0.0.1:$HS_PORT 回话了"; else step headscale-running skip "本来就在跑"; fi
      return 0
    fi
    sleep 1
  done
  journalctl -u headscale -n 20 --no-pager >&2 2>/dev/null || true
  die "headscale 起来 30 秒了还没回话"
}

hs_user_exists() { headscale users list -o json-line 2>/dev/null | grep -E "\"name\": *\"$1\"" >/dev/null; }

ensure_headscale_user() {
  if hs_user_exists "$HS_USER"; then
    step headscale-user skip "用户 $HS_USER 已经有了"
  else
    headscale users create "$HS_USER" >/dev/null
    step headscale-user ok "建了用户 $HS_USER（电脑和手机都登记在它名下）"
  fi
}

# 用户的数字 id（新版 headscale 的 preauthkeys --user 要 id；拿不到就空着，退回用名字）
hs_user_id() {
  headscale users list -o json-line 2>/dev/null | grep -Eo "\"id\": *\"?[0-9]+\"?, *\"name\": *\"$1\"" | grep -Eo '[0-9]+' | head -1 || true
}

valid_authkey() { echo "$1" | grep -E '^[A-Za-z0-9_-]{16,}$' >/dev/null; }

# 一次性、1 小时内有效的加入钥匙：电脑上的 tailscale 用它加入（只打印一次给本机收下，不落盘）
issue_authkey() {
  local uid key=""
  uid=$(hs_user_id "$HS_USER")
  if [ -n "$uid" ]; then key=$(headscale preauthkeys create --user "$uid" --expiration 1h 2>/dev/null | tail -1) || key=""; fi
  if ! valid_authkey "$key"; then key=$(headscale preauthkeys create --user "$HS_USER" --expiration 1h 2>/dev/null | tail -1) || key=""; fi
  if ! valid_authkey "$key"; then die "生成加入 tailnet 的一次性钥匙失败"; fi
  echo "ERGO-RESULT AUTHKEY=$key"
  step authkey ok "一次性、1 小时内有效"
}

need_root
need_debian
base_record
load_base
# 原来就有、又不是我们装的 headscale：不覆盖（那是你现有的 tailnet）
if { pkg_installed headscale || has headscale; } && [ ! -f "$STATE_DIR/headscale.env" ]; then
  die "这台 VPS 上原来就有 headscale，没动它。要接着用你现有的那套，见 docs/vps.md 的「已经有 headscale」"
fi
HS_RULES="80/tcp 443/tcp"
if [ "$HS_DERP" = 1 ]; then HS_RULES="$HS_RULES 3478/udp"; fi
write_mode_env headscale "DOMAIN=$DOMAIN" "SITE=$SITE" "HS_PORT=$HS_PORT" "HS_USER=$HS_USER" "NEED_RULES='$HS_RULES'"

FW_PKG=ufw
if firewalld_active; then FW_PKG=""; fi
# shellcheck disable=SC2086
ensure_packages nginx certbot $FW_PKG unattended-upgrades curl ca-certificates
ensure_auto_upgrades
# shellcheck disable=SC2086
ensure_firewall $HS_RULES
ensure_nginx_running
ensure_headscale_installed
ensure_headscale_config
ensure_headscale_running
site_with_cert "$SITE" "$DOMAIN" content_site_full content_site_http
install_renew_hook
ensure_headscale_user
if [ "${WANT_AUTHKEY:-0}" = 1 ]; then issue_authkey; fi
echo "ERGO-DONE headscale"
