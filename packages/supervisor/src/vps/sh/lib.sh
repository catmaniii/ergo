# ---------------------------------------------------------------- 公共函数（321 号票）
# 约定：每一步先看现状，已经是想要的样子就跳过——脚本能重复跑，断了重跑接着做。
# 本机按行首标记显示进度、收结果：ERGO-STEP <步骤> <ok|skip> [说明]、ERGO-NOTE、ERGO-WARN、ERGO-RESULT 键=值、ERGO-FAIL、ERGO-DONE。
#
# 这台 VPS 上"装之前原来是什么样"记在 /etc/ergo-vps/base.env（第一次跑时记一次，之后不改），
# 每种方式装了什么记在 /etc/ergo-vps/<方式>.env；lsm vps remove 照它们原样撤。

export DEBIAN_FRONTEND=noninteractive
# ERGO_TEST_ROOT 只给测试用：在一个假的根目录里把这份脚本真的跑一遍。VPS 上不设，路径就是真的 /etc、/var。
R="${ERGO_TEST_ROOT:-}"
STATE_DIR="$R/etc/ergo-vps"
FW_ADDED="$STATE_DIR/ufw-added"
FW_ADDED_SSH="$STATE_DIR/ufw-added-ssh"
ACME_WEBROOT=/var/www/ergo-acme
RENEW_HOOK="$R/etc/letsencrypt/renewal-hooks/deploy/ergo-vps-reload-nginx"
AUTO_UPGRADES_FILE="$R/etc/apt/apt.conf.d/52ergo-auto-upgrades"
# base.env 里记"原来装没装"的那几个包
BASE_PACKAGES="nginx nginx-common certbot ufw unattended-upgrades curl headscale"

step() { echo "ERGO-STEP $1 $2${3:+ $3}"; }
note() { echo "ERGO-NOTE $*"; }
warn() { echo "ERGO-WARN $*"; }
die()  { echo "ERGO-FAIL $*" >&2; exit 1; }
has()  { command -v "$1" >/dev/null 2>&1; }
pkg_installed() { dpkg-query -W -f='${Status}' "$1" 2>/dev/null | grep 'install ok installed' >/dev/null; }
pkg_var() { echo "PRE_PKG_$(echo "$1" | tr 'a-z-' 'A-Z_')"; }

need_root() {
  if [ -z "$R" ] && [ "$(id -u)" != 0 ]; then die "要用 root 跑（sudo bash 这个脚本）"; fi
}

need_debian() {
  local id="" like=""
  if [ -r "$R/etc/os-release" ]; then
    id=$(. "$R/etc/os-release"; echo "${ID:-}")
    like=$(. "$R/etc/os-release"; echo "${ID_LIKE:-}")
  fi
  case " $id $like " in
    *" debian "*|*" ubuntu "*) ;;
    *) die "第一版只支持 Debian / Ubuntu（这台是 ${id:-认不出来}）" ;;
  esac
}

ufw_active() { has ufw && ufw status 2>/dev/null | grep '^Status: active' >/dev/null; }
firewalld_active() { has systemctl && systemctl is-active --quiet firewalld 2>/dev/null; }
auto_upgrades_on() { has apt-config && apt-config dump 2>/dev/null | grep '^APT::Periodic::Unattended-Upgrade "1";' >/dev/null; }

# 第一次跑：记下原来的样子（之后再跑不改它——它记的是"装之前"）
base_record() {
  mkdir -p "$STATE_DIR"
  chmod 700 "$STATE_DIR"
  if [ -f "$STATE_DIR/base.env" ]; then
    step base-record skip "原来的样子第一次跑时已经记下"
    return 0
  fi
  local tmp="$STATE_DIR/base.env.tmp" p v
  {
    echo "# 二狗服务管家第一次在这台 VPS 上跑脚本之前，这些东西原来是什么样（lsm vps remove 照它原样撤，别手改）"
    echo "BASE_AT=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    for p in $BASE_PACKAGES; do
      v=0
      if pkg_installed "$p"; then v=1; fi
      echo "$(pkg_var "$p")=$v"
    done
    v=0; if ufw_active; then v=1; fi
    echo "PRE_UFW_ACTIVE=$v"
    v=0; if auto_upgrades_on; then v=1; fi
    echo "PRE_AUTO_UPGRADES=$v"
  } > "$tmp"
  mv "$tmp" "$STATE_DIR/base.env"
  step base-record ok
}

load_base() {
  if [ -f "$STATE_DIR/base.env" ]; then
    # shellcheck disable=SC1091
    . "$STATE_DIR/base.env"
  fi
}

# 这一种方式装了什么（每次跑都按这次的参数重写；remove 读它）。参数：方式名，然后一串 键=值
write_mode_env() {
  local mode="$1" kv
  shift
  {
    echo "# lsm vps setup $mode 装的东西（lsm vps remove $mode 照它撤，别手改）"
    echo "MODE_AT=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    for kv in "$@"; do echo "$kv"; done
  } > "$STATE_DIR/$mode.env.tmp"
  mv "$STATE_DIR/$mode.env.tmp" "$STATE_DIR/$mode.env"
}

# 缺哪个装哪个；全都有就不碰 apt
ensure_packages() {
  local missing=() p
  for p in "$@"; do
    if ! pkg_installed "$p"; then missing+=("$p"); fi
  done
  if [ ${#missing[@]} -eq 0 ]; then
    step packages skip "$*"
    return 0
  fi
  apt-get update -q
  apt-get install -y -q --no-install-recommends "${missing[@]}"
  step packages ok "装了 ${missing[*]}"
}

# 自动安全更新：本来开着就不动；没开就单独放一个文件打开（不改系统自带的 20auto-upgrades）。
# lsm vps remove 撤的时候留着它和 unattended-upgrades：撤掉入口不该顺带把这台 VPS 的安全更新也关了
ensure_auto_upgrades() {
  if auto_upgrades_on; then
    step auto-upgrades skip "自动安全更新本来就开着"
    return 0
  fi
  mkdir -p "$(dirname "$AUTO_UPGRADES_FILE")"
  printf '%s\n' '// 二狗服务管家打开的自动安全更新（lsm vps remove 撤的时候留着它，安全更新不跟着关）' \
    'APT::Periodic::Update-Package-Lists "1";' 'APT::Periodic::Unattended-Upgrade "1";' > "$AUTO_UPGRADES_FILE"
  step auto-upgrades ok "打开了自动安全更新"
}

# 注意：set -o pipefail 下管道里不用 grep -q——它一找到就退出，前面的命令输出没写完会被 SIGPIPE 打断，整条管道就算失败
ufw_has_rule() { ufw show added 2>/dev/null | grep -E "^ufw allow $1( |\$)" >/dev/null; }

# 防火墙只开要用的端口。ssh 端口永远先放行（不然打开 ufw 的那一刻就把自己关在外面了）。
# 我们加的规则记在 ufw-added，remove 只删这些；原来就有的规则不碰。参数：要开的端口，如 80/tcp 443/tcp 3478/udp
ensure_firewall() {
  if firewalld_active; then
    warn "这台用的是 firewalld，没动它：请自己放行 ssh 端口和 $*"
    step firewall skip firewalld
    return 0
  fi
  if ! has ufw; then die "没有 ufw（上一步应该装上了）"; fi
  touch "$FW_ADDED" "$FW_ADDED_SSH"
  local ssh_rules="$SSH_PORT/tcp" rule added=0
  # 这次 ssh 连进来的端口也放行（经 sudo 跑时这个变量可能没有，那就只靠 SSH_PORT）
  if [ -n "${SSH_CONNECTION:-}" ]; then ssh_rules="$ssh_rules ${SSH_CONNECTION##* }/tcp"; fi
  for rule in $ssh_rules; do
    if ufw_has_rule "$rule"; then continue; fi
    ufw allow "$rule" >/dev/null
    added=1
    if ! grep -qxF "$rule" "$FW_ADDED_SSH"; then echo "$rule" >> "$FW_ADDED_SSH"; fi
  done
  for rule in "$@"; do
    if ufw_has_rule "$rule"; then continue; fi
    ufw allow "$rule" >/dev/null
    added=1
    if ! grep -qxF "$rule" "$FW_ADDED"; then echo "$rule" >> "$FW_ADDED"; fi
  done
  if ufw_active; then
    if [ "$added" = 1 ]; then step firewall ok "放行 $*（ufw 原来就开着）"; else step firewall skip "$* 已经放行"; fi
  else
    ufw --force enable >/dev/null
    step firewall ok "放行 ssh 和 $*，打开了 ufw（别的端口外面进不来了）"
  fi
}

ensure_nginx_running() {
  systemctl enable nginx >/dev/null 2>&1 || true
  if ! systemctl is-active --quiet nginx; then systemctl start nginx; fi
}

# nginx 站点放哪：Debian / Ubuntu 的 sites-available + sites-enabled；nginx.conf 没 include 它们就放 conf.d
site_paths() {
  if grep -qs 'sites-enabled' "$R/etc/nginx/nginx.conf"; then
    SITE_AVAIL="$R/etc/nginx/sites-available/$1.conf"
    SITE_ENABLED="$R/etc/nginx/sites-enabled/$1.conf"
  else
    SITE_AVAIL="$R/etc/nginx/conf.d/$1.conf"
    SITE_ENABLED=""
  fi
}

nginx_reload() { systemctl reload-or-restart nginx; }

# 写一个 nginx 站点（内容从 stdin 来）。内容一样就不动；nginx -t 不过就撤回原来的、退出。参数：站点名
site_install() {
  local name="$1" tmp
  site_paths "$name"
  tmp=$(mktemp)
  cat > "$tmp"
  if [ -f "$SITE_AVAIL" ] && cmp -s "$tmp" "$SITE_AVAIL" && { [ -z "$SITE_ENABLED" ] || [ -e "$SITE_ENABLED" ]; }; then
    rm -f "$tmp"
    return 0
  fi
  mkdir -p "$(dirname "$SITE_AVAIL")"
  rm -f "$SITE_AVAIL.ergo-prev"
  if [ -f "$SITE_AVAIL" ]; then cp -p "$SITE_AVAIL" "$SITE_AVAIL.ergo-prev"; fi
  cp "$tmp" "$SITE_AVAIL"
  chmod 644 "$SITE_AVAIL"
  rm -f "$tmp"
  if [ -n "$SITE_ENABLED" ]; then ln -sf "$SITE_AVAIL" "$SITE_ENABLED"; fi
  if nginx -t >/dev/null 2>&1; then
    nginx_reload
    rm -f "$SITE_AVAIL.ergo-prev"
    note "nginx 站点 $name 已生效"
    return 0
  fi
  nginx -t 2>&1 | tail -5 >&2 || true
  if [ -f "$SITE_AVAIL.ergo-prev" ]; then
    mv "$SITE_AVAIL.ergo-prev" "$SITE_AVAIL"
  else
    rm -f "$SITE_AVAIL"
    if [ -n "$SITE_ENABLED" ]; then rm -f "$SITE_ENABLED"; fi
  fi
  if nginx -t >/dev/null 2>&1; then nginx_reload; fi
  die "nginx -t 没通过，站点 $name 已撤回原样"
}

# 拿掉一个站点（没有就算了）
site_remove() {
  site_paths "$1"
  local had=0
  if [ -n "$SITE_ENABLED" ] && { [ -e "$SITE_ENABLED" ] || [ -L "$SITE_ENABLED" ]; }; then rm -f "$SITE_ENABLED"; had=1; fi
  if [ -f "$SITE_AVAIL" ]; then rm -f "$SITE_AVAIL" "$SITE_AVAIL.ergo-prev"; had=1; fi
  if [ "$had" = 1 ] && has nginx && nginx -t >/dev/null 2>&1; then nginx_reload; fi
  if [ "$had" = 1 ]; then step "site-$1" ok "拿掉了"; else step "site-$1" skip "本来就没有"; fi
}

# 签证书 → 写完整站点（443）。已经有证书就直接写完整站点（内容一样就不动）。
# 参数：站点名 域名 写完整站点的函数 写 80 端口那段的函数 [签法 webroot|standalone] [standalone 时要临时停的单元]
#  - webroot（默认）：先写只有 80 端口那段（ACME 路径），certbot --webroot 签，不停任何东西；
#  - standalone：80 被 nginx 以外的程序占着——没有 80 那段，签的时候临时停占着 80 的单元、签完拉起来（trap 保证签失败也拉起来）。
site_with_cert() {
  local name="$1" domain="$2" full_fn="$3" http_fn="$4" how="${5:-webroot}" units="${6:-}"
  if ! dns_points_here "$domain" "$PUBLIC_IP"; then
    die "$domain 在公网 DNS 里没有指到这台 VPS（$PUBLIC_IP）。用 sslip.io 的默认名字时这一步不会错；用自己的域名先去加一条 A 记录"
  fi
  if cert_live "$domain"; then
    "$full_fn" | site_install "$name"
    step "cert-$domain" skip "证书已经有了，还剩 $(cert_days_left "$domain") 天（续期交给 certbot 的定时任务）"
  elif [ "$how" = standalone ]; then
    cert_issue "$domain" standalone "$units"
    "$full_fn" | site_install "$name"
    step "cert-$domain" ok "签好了（standalone：签的时候临时停了 ${units:-（没停）}，已经拉起来）"
  else
    "$http_fn" | site_install "$name"
    cert_issue "$domain" webroot
    "$full_fn" | site_install "$name"
    step "cert-$domain" ok "签好了"
  fi
}

# ---------------------------------------------------------------- 谁占着端口（体检、site add 的布局核对共用）
# 谁在听这个端口（进程名；没人听是空的）。参数：t|u 端口
listener() {
  ss -H "-l$1np" "sport = :$2" 2>/dev/null | grep -Eo 'users:\(\("[^"]+"' | head -1 | cut -d'"' -f2 || true
}

listener_pid() {
  ss -H "-l$1np" "sport = :$2" 2>/dev/null | grep -Eo 'pid=[0-9]+' | head -1 | cut -d= -f2 || true
}

# 在听这个端口的进程属于哪个 systemd 单元（看 /proc/<pid>/cgroup；不是 .service 的——比如 docker 容器的 .scope——是空的）
listener_unit() {
  local pid
  pid=$(listener_pid "$1" "$2")
  if [ -z "$pid" ]; then return 0; fi
  sed -n -e 's#^0::.*/\([^/]*\.service\)$#\1#p' -e 's#^[0-9]*:name=systemd:.*/\([^/]*\.service\)$#\1#p' "$R/proc/$pid/cgroup" 2>/dev/null | head -1 || true
}

# ---------------------------------------------------------------- 80 被别的程序占着时装 nginx（site add 用）
# Debian / Ubuntu 装 nginx 时会马上起它，带的 default 站点听 80——80 被别的程序占着时这一下就起不来，dpkg 报错。
# 所以：装包时用 policy-rc.d 拦住"装完就起"（原来就有这个文件的不碰它），装完拿掉 nginx 自带的 default 站点（只拿我们这次装的）。
install_packages_no_start() {
  local prc="$R/usr/sbin/policy-rc.d" mine=0 had_nginx=0
  if pkg_installed nginx; then had_nginx=1; fi
  if [ ! -e "$prc" ]; then
    mkdir -p "$(dirname "$prc")"
    printf '%s\n' '#!/bin/sh' '# 二狗服务管家装包时临时放的：装完不马上起服务（80 被别的程序占着）。装完就删' 'exit 101' > "$prc"
    chmod 755 "$prc"
    mine=1
    # shellcheck disable=SC2064
    trap "rm -f '$prc'" EXIT
  fi
  ensure_packages "$@"
  if [ "$mine" = 1 ]; then rm -f "$prc"; trap - EXIT; fi
  if [ "$had_nginx" = 0 ] && [ -e "$R/etc/nginx/sites-enabled/default" ]; then
    rm -f "$R/etc/nginx/sites-enabled/default"
    note "拿掉了 nginx 自带的 default 站点（它听 80，可 80 被别的程序占着）"
  fi
}

# ---------------------------------------------------------------- 443 前面的 stream 前门（site add 用）
# 前门按 map \$ssl_preread_server_name \$变量 { 域名 去向; } 分流。往 map 里插一行"这个域名 → 前门后面的站点地址"，
# 行尾带标记 # ergo-vps-site=<站点名>，撤的时候按标记删这一行。改之前留底，nginx -t 不过就换回原样。
# 用到的参数：FD_FILE（map 所在的文件）FD_VAR（map 的变量名，不带 \$）FD_BACKEND（127.0.0.1:端口）SITE_NAME DOMAIN
frontdoor_mark() { echo "# ergo-vps-site=$SITE_NAME"; }

frontdoor_add() {
  local f="$R$FD_FILE" mark tmp
  mark=$(frontdoor_mark)
  if [ ! -f "$f" ]; then die "前门的配置文件 $FD_FILE 不在了：重跑 lsm vps site add 重新体检"; fi
  if grep -qF "$mark" "$f"; then
    step frontdoor skip "前门里已经有 $DOMAIN 这一行"
    return 0
  fi
  if ! grep -Eq "^[[:space:]]*map[[:space:]]+\\\$ssl_preread_server_name[[:space:]]+\\\$$FD_VAR[[:space:]]*\{" "$f"; then
    die "前门 $FD_FILE 里找不到 map \$ssl_preread_server_name \$$FD_VAR { 这一行（配置变了？）：重跑 lsm vps site add 重新体检"
  fi
  cp -p "$f" "$f.ergo-prev"
  tmp="$f.ergo-tmp"
  awk -v var="$FD_VAR" -v add="        $DOMAIN $FD_BACKEND;  $mark" '
    { print }
    !done && $1 == "map" && $2 == "$ssl_preread_server_name" && ($3 == "$" var || $3 == "$" var "{") { print add; done = 1 }
  ' "$f.ergo-prev" > "$tmp"
  cat "$tmp" > "$f"
  rm -f "$tmp"
  if nginx -t >/dev/null 2>&1; then
    nginx_reload
    rm -f "$f.ergo-prev"
    step frontdoor ok "前门里加了一行：$DOMAIN → $FD_BACKEND"
    return 0
  fi
  nginx -t 2>&1 | tail -5 >&2 || true
  cat "$f.ergo-prev" > "$f"
  rm -f "$f.ergo-prev"
  die "前门加了 $DOMAIN 那一行后 nginx -t 没通过，已换回原样"
}

frontdoor_remove() {
  local f="$R$FD_FILE" mark
  mark=$(frontdoor_mark)
  if [ ! -f "$f" ] || ! grep -qF "$mark" "$f"; then
    step frontdoor skip "前门里本来就没有这一行"
    return 0
  fi
  cp -p "$f" "$f.ergo-prev"
  grep -vF "$mark" "$f.ergo-prev" > "$f.ergo-tmp" || true
  cat "$f.ergo-tmp" > "$f"
  rm -f "$f.ergo-tmp"
  if nginx -t >/dev/null 2>&1; then
    nginx_reload
    rm -f "$f.ergo-prev"
    step frontdoor ok "前门里 $DOMAIN 那一行拿掉了"
    return 0
  fi
  cat "$f.ergo-prev" > "$f"
  rm -f "$f.ergo-prev"
  die "前门拿掉 $DOMAIN 那一行后 nginx -t 没通过，已换回原样"
}

# ---------------------------------------------------------------- 把 nginx 的配置原样交给本机看（体检、scan；只读）
# nginx -T：nginx 实际读到的每个文件，按顺序、带"# configuration file 路径:"的抬头。每行前面加 ERGO-NGX| ，本机拆出来解析。
# nginx -T 不过（配置本来就有错）时，退回直接列配置文件（同样的抬头）。
nginx_dump() {
  local out f
  if has nginx && out=$(nginx -T 2>/dev/null) && [ -n "$out" ]; then
    printf '%s\n' "$out" | sed 's/^/ERGO-NGX|/'
    return 0
  fi
  if [ ! -f "$R/etc/nginx/nginx.conf" ]; then return 0; fi
  for f in "$R/etc/nginx/nginx.conf" "$R"/etc/nginx/conf.d/*.conf "$R"/etc/nginx/sites-enabled/* "$R"/etc/nginx/modules-enabled/*.conf "$R"/etc/nginx/streams-enabled/* "$R"/etc/nginx/stream.d/*; do
    [ -f "$f" ] || continue
    echo "ERGO-NGX|# configuration file ${f#"$R"}:"
    sed 's/^/ERGO-NGX|/' "$f"
  done
}
