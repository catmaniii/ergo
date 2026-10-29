#!/usr/bin/env bash
# 假的 Debian（321 号票的测试用）：VPS 脚本调用的系统命令（apt-get、systemctl、nginx、certbot、ufw、useradd、headscale……）
# 都落到这里，按 $FAKE 下的文件模拟机器的状态，每次调用记一行进 $FAKE/calls.log。
# 文件系统那一半是真的：脚本带着 ERGO_TEST_ROOT 跑，/etc、/var 都落在那个临时目录里。
set -u
cmd="$1"; shift
echo "$cmd $*" >> "$FAKE/calls.log"
R="$ERGO_TEST_ROOT"

mk() { mkdir -p "$(dirname "$1")"; : > "$1"; }
installed() { [ -e "$FAKE/pkg/$1" ]; }
# 包带来的命令：装上才出现在 PATH 里（command -v 才找得到），卸了就没了
pkg_bin() {
  case "$1" in
    nginx|certbot|ufw|headscale|curl)
      if [ "$2" = add ]; then
        { printf '#!/usr/bin/env bash\nset -- %s "$@"\n' "$1"; cat "$FAKE/_fake"; } > "$FAKE_BIN/$1"
      else
        rm -f "$FAKE_BIN/$1"
      fi ;;
  esac
}
pkg_add() {
  mk "$FAKE/pkg/$1"
  pkg_bin "$1" add
  case "$1" in
    nginx)
      mk "$FAKE/pkg/nginx-common"
      mkdir -p "$R/etc/nginx/sites-available" "$R/etc/nginx/sites-enabled" "$R/etc/nginx/conf.d"
      if [ ! -f "$R/etc/nginx/nginx.conf" ]; then
        printf 'http {\n    include /etc/nginx/conf.d/*.conf;\n    include /etc/nginx/sites-enabled/*;\n}\n' > "$R/etc/nginx/nginx.conf"
      fi
      # 和真的一样：包里带一个听 80 的 default 站点，装完马上起 nginx（policy-rc.d 说 101 就不起）
      printf 'server {\n    listen 80 default_server;\n    root /var/www/html;\n}\n' > "$R/etc/nginx/sites-available/default"
      cp "$R/etc/nginx/sites-available/default" "$R/etc/nginx/sites-enabled/default"
      if [ -x "$R/usr/sbin/policy-rc.d" ]; then echo "policy-rc.d: nginx 装完不起" >> "$FAKE/calls.log"; else nginx_start || exit 100; fi ;;
  esac
}

# nginx 抢端口：80 / 443 被别的程序占着、配置里又要听它，就起不来（真的 nginx 报 bind() ... Address already in use）
nginx_conf_files() { ls "$R"/etc/nginx/nginx.conf "$R"/etc/nginx/conf.d/*.conf "$R"/etc/nginx/sites-enabled/* 2>/dev/null || true; }
nginx_start() {
  local port who
  for port in 80 443; do
    who=$(cat "$FAKE/listen/t-$port" 2>/dev/null || true)
    # shellcheck disable=SC2046
    if [ -n "$who" ] && [ "$who" != nginx ] && grep -Eqs "^[[:space:]]*listen[[:space:]]+([0-9.]*:)?$port([[:space:];]|$)" /dev/null $(nginx_conf_files); then
      echo "nginx: [emerg] bind() to 0.0.0.0:$port failed (98: Address already in use)（$who 占着）" >&2
      return 1
    fi
  done
  mk "$FAKE/svc/nginx.active"
}

# 占着端口的服务停了 / 起了：它占的端口跟着空出来 / 占回去（listen-unit/<文件> 记着哪个单元占着 listen/<文件>）
unit_ports() {
  local unit="${1%.service}" f
  for f in "$FAKE"/listen-unit/*; do
    [ -e "$f" ] || continue
    if [ "$(cat "$f")" = "$unit" ] || [ "$(cat "$f")" = "$unit.service" ]; then
      if [ "$2" = stop ] && [ -e "$FAKE/listen/$(basename "$f")" ]; then mkdir -p "$FAKE/listen-off"; mv "$FAKE/listen/$(basename "$f")" "$FAKE/listen-off/"; fi
      if [ "$2" = start ] && [ -e "$FAKE/listen-off/$(basename "$f")" ]; then mv "$FAKE/listen-off/$(basename "$f")" "$FAKE/listen/"; fi
    fi
  done
}

case "$cmd" in
  dpkg-query)
    p="${*: -1}"
    if installed "$p"; then printf 'install ok installed'; else exit 1; fi ;;
  dpkg) echo amd64 ;;
  apt-get)
    sub="$1"; shift
    case "$sub" in
      update) ;;
      install)
        for a in "$@"; do
          case "$a" in -*) ;; *.deb) pkg_add headscale ;; *) pkg_add "$a" ;; esac
        done ;;
      purge|remove)
        for a in "$@"; do
          case "$a" in -*) ;; *) rm -f "$FAKE/pkg/$a"; pkg_bin "$a" rm ;; esac
        done ;;
    esac ;;
  apt-config)
    cat "$R"/etc/apt/apt.conf.d/* 2>/dev/null | grep '^APT::' || true ;;
  systemctl)
    now=0; quiet=0; args=()
    for a in "$@"; do
      case "$a" in --now) now=1 ;; --quiet|-q) quiet=1 ;; --no-pager) ;; *) args+=("$a") ;; esac
    done
    sub="${args[0]}"
    for unit in "${args[@]:1}"; do
      case "$sub" in
        is-active)
          if [ -e "$FAKE/svc/$unit.active" ]; then s=active; else s=inactive; fi
          if [ "$quiet" = 0 ]; then echo "$s"; fi
          if [ "$s" != active ]; then exit 3; fi ;;
        start|restart|reload-or-restart)
          if [ "$unit" = nginx ]; then nginx_start || exit 1; else mk "$FAKE/svc/$unit.active"; unit_ports "$unit" start; fi ;;
        reload)
          if [ ! -e "$FAKE/svc/$unit.active" ]; then exit 1; fi
          if [ "$unit" = nginx ]; then nginx_start || exit 1; fi ;;
        stop) rm -f "$FAKE/svc/$unit.active"; unit_ports "$unit" stop ;;
        enable) if [ "$now" = 1 ]; then mk "$FAKE/svc/$unit.active"; fi ;;
        disable) if [ "$now" = 1 ]; then rm -f "$FAKE/svc/$unit.active"; fi ;;
        cat) if ! installed "$unit"; then exit 1; fi ;;
      esac
    done ;;
  nginx)
    if [ "${1:-}" = -T ]; then
      # nginx 实际读到的文件，按 nginx -T 的格式（路径是 VPS 上的写法）
      echo 'nginx: the configuration file /etc/nginx/nginx.conf syntax is ok' >&2
      for f in "$R/etc/nginx/nginx.conf" "$R"/etc/nginx/conf.d/*.conf "$R"/etc/nginx/sites-enabled/* "$R"/etc/nginx/stream.d/*.conf; do
        [ -f "$f" ] || continue
        echo "# configuration file ${f#"$R"}:"
        cat "$f"
        echo
      done
      exit 0
    fi
    if [ -e "$FAKE/nginx-t-fail" ]; then echo 'nginx: [emerg] fake failure' >&2; exit 1; fi
    # 配置里出现某段文字就不过（造"改了某一处以后 nginx -t 不过"）
    if [ -s "$FAKE/nginx-t-fail-grep" ] && grep -rqsF "$(cat "$FAKE/nginx-t-fail-grep")" "$R/etc/nginx"; then echo 'nginx: [emerg] fake failure (grep)' >&2; exit 1; fi
    # 真的 nginx 也会这样：站点里引用的证书文件不在，-t 不过
    for f in "$R"/etc/nginx/sites-enabled/* "$R"/etc/nginx/conf.d/*; do
      [ -f "$f" ] || continue
      for c in $(grep -Eo 'ssl_certificate(_key)? [^;]+' "$f" | awk '{print $2}'); do
        if [ ! -s "$R$c" ]; then echo "nginx: [emerg] cannot load certificate \"$c\"" >&2; exit 1; fi
      done
    done
    echo 'nginx: configuration file /etc/nginx/nginx.conf test is successful' >&2 ;;
  certbot)
    sub="$1"; shift
    d=""
    while [ $# -gt 0 ]; do
      case "$1" in -d|--cert-name) d="$2"; shift ;; esac
      shift
    done
    case "$sub" in
      certonly)
        if [ -e "$FAKE/certbot-fail" ]; then echo 'certbot: fake failure (Connection refused)' >&2; exit 1; fi
        # standalone 要自己听 80：80 被占着就签不了
        if grep -q -- '--standalone' <<< "$(tail -1 "$FAKE/calls.log")" && [ -s "$FAKE/listen/t-80" ]; then
          echo "certbot: Could not bind TCP port 80 because it is already in use by another process ($(cat "$FAKE/listen/t-80"))" >&2; exit 1
        fi
        mkdir -p "$R/etc/letsencrypt/live/$d" "$R/etc/letsencrypt/renewal"
        echo FAKE-CERT > "$R/etc/letsencrypt/live/$d/fullchain.pem"
        echo FAKE-KEY > "$R/etc/letsencrypt/live/$d/privkey.pem"
        : > "$R/etc/letsencrypt/renewal/$d.conf" ;;
      delete) rm -rf "$R/etc/letsencrypt/live/$d" "$R/etc/letsencrypt/renewal/$d.conf" ;;
    esac ;;
  openssl) echo 'notAfter=Jan  1 00:00:00 2030 GMT' ;;
  getent)
    case "$1" in
      ahostsv4) if [ -e "$FAKE/dns-wrong" ]; then echo "198.51.100.7 STREAM $2"; else echo "$FAKE_IP STREAM $2"; fi ;;
      passwd) echo "$2:x:0:0::/root:/bin/bash" ;;
    esac ;;
  id)
    if [ $# -eq 1 ] && [ "$1" = -u ]; then echo 0; exit 0; fi
    u="${*: -1}"
    if [ -e "$FAKE/user/$u" ]; then echo 1001; else exit 1; fi ;;
  useradd)
    home=""
    while [ $# -gt 1 ]; do
      case "$1" in --home-dir) home="$2"; shift ;; esac
      shift
    done
    mk "$FAKE/user/$1"
    mkdir -p "$R$home" ;;
  userdel)
    u="${*: -1}"
    rm -f "$FAKE/user/$u"
    if [ "$1" = -r ]; then rm -rf "$R/var/lib/$u"; fi ;;
  pkill|chown|journalctl|usermod) ;;
  ufw)
    rules="$FAKE/ufw.rules"
    case "$1" in
      status) if [ -e "$FAKE/ufw.active" ]; then echo 'Status: active'; else echo 'Status: inactive'; fi ;;
      show)
        echo "Added user rules (see 'ufw status' for running firewall):"
        if [ -f "$rules" ]; then sed 's/^/ufw allow /' "$rules"; fi ;;
      allow) echo "$2" >> "$rules" ;;
      delete) if [ -f "$rules" ]; then grep -vxF "$3" "$rules" > "$rules.tmp" || true; mv "$rules.tmp" "$rules"; fi ;;
      --force) if [ "$2" = enable ]; then mk "$FAKE/ufw.active"; else rm -f "$FAKE/ufw.active"; fi ;;
    esac ;;
  ss)
    proto=t; port=""
    for a in "$@"; do
      case "$a" in -l*u*) proto=u ;; "sport = :"*) port="${a#sport = :}" ;; esac
    done
    for f in "$FAKE"/listen/"$proto"-*; do
      [ -e "$f" ] || continue
      p="${f##*-}"
      if [ -n "$port" ] && [ "$p" != "$port" ]; then continue; fi
      pid=$(cat "$FAKE/listen-pid/$(basename "$f")" 2>/dev/null || echo 1)
      echo "LISTEN 0 511 0.0.0.0:$p 0.0.0.0:* users:((\"$(cat "$f")\",pid=$pid,fd=6))"
    done ;;
  sshd) if [ -f "$FAKE/sshd-T" ]; then cat "$FAKE/sshd-T"; else echo 'allowtcpforwarding yes'; fi ;;
  ssh) echo 'OpenSSH_9.2p1 Debian-2+deb12u3, OpenSSL 3.0.15' >&2 ;;
  headscale)
    if ! installed headscale; then echo 'headscale: command not found' >&2; exit 127; fi
    if [ "$1" = -c ]; then shift 2; fi
    case "$1" in
      version) echo "v$(cat "$FAKE/hs-version" 2>/dev/null || echo 0.26.1)" ;;
      configtest) if [ -e "$FAKE/hs-configtest-fail" ]; then echo 'fake configtest failure' >&2; exit 1; fi ;;
      users)
        case "$2" in
          list)
            printf '['; i=0
            while read -r n; do
              [ -n "$n" ] || continue
              i=$((i + 1)); if [ "$i" -gt 1 ]; then printf ','; fi
              printf '{"id":%d,"name":"%s"}' "$i" "$n"
            done < <(cat "$FAKE/hs-users" 2>/dev/null)
            printf ']\n' ;;
          create) echo "$3" >> "$FAKE/hs-users" ;;
        esac ;;
      preauthkeys) echo '0123456789abcdef0123456789abcdef0123456789abcdef' ;;
      nodes) echo '[]' ;;
    esac ;;
  curl)
    out=""; url=""
    while [ $# -gt 0 ]; do
      case "$1" in -o) out="$2"; shift ;; --retry|-m) shift ;; -*) ;; *) url="$1" ;; esac
      shift
    done
    case "$url" in
      http://127.0.0.1:*/health) if [ -e "$FAKE/svc/headscale.active" ]; then echo '{"status":"pass"}'; else exit 7; fi ;;
      *.deb) printf 'FAKE-DEB' > "$out" ;;
      */checksums.txt)
        ver="${url%/checksums.txt}"; ver="${ver##*/v}"
        sum=$(printf 'FAKE-DEB' | sha256sum | cut -d' ' -f1)
        if [ -e "$FAKE/checksum-wrong" ]; then sum=0000000000000000000000000000000000000000000000000000000000000000; fi
        printf '%s  headscale_%s_linux_amd64.deb\n' "$sum" "$ver" > "$out" ;;
      *) exit 22 ;;
    esac ;;
  *) echo "假的 Debian 不认识：$cmd" >&2; exit 127 ;;
esac
