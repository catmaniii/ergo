# ---------------------------------------------------------------- 证书（321 / 322 共用）
# Let's Encrypt，certbot 签。签之前核对域名指到这台 VPS。
#  - webroot：nginx 占着 80（新搭的 VPS 都这样）——nginx 的 80 端口站点把 /.well-known/acme-challenge/ 指到 ACME_WEBROOT，
#    签证书、续期都不停任何东西；
#  - standalone：80 被别的服务占着时，先停它、签完拉起来，trap 保证签失败也拉起来（322 的 site add 用；先告诉用户）。
# 续期交给 certbot 自带的定时任务；deploy 钩子在续期后让 nginx 读新证书。

cert_file() { echo "$R/etc/letsencrypt/live/$1/fullchain.pem"; }
cert_live() { [ -s "$(cert_file "$1")" ]; }

# 证书到期的时刻（Unix 秒）；没有证书输出 none
cert_end_epoch() {
  local f end
  f=$(cert_file "$1")
  if [ ! -s "$f" ]; then echo none; return 0; fi
  end=$(openssl x509 -enddate -noout -in "$f" | cut -d= -f2)
  date -d "$end" +%s
}

# 还剩几天；没有证书输出 -1
cert_days_left() {
  local end
  end=$(cert_end_epoch "$1")
  if [ "$end" = none ]; then echo -1; return 0; fi
  echo $(( (end - $(date +%s)) / 86400 ))
}

# 域名在公网 DNS 里是不是指到这台。参数：域名 这台的公网 IP
dns_points_here() {
  getent ahostsv4 "$1" 2>/dev/null | awk '{print $1}' | grep -xF "$2" >/dev/null
}

# 签一张证书。参数：域名 方式（webroot|standalone） standalone 时要临时停的 systemd 单元（空格分隔，可空）
cert_issue() {
  local d="$1" how="$2" units="${3:-}" email_args
  if [ -n "${CERT_EMAIL:-}" ]; then email_args="--email $CERT_EMAIL"; else email_args="--register-unsafely-without-email"; fi
  case "$units" in *[!A-Za-z0-9@._\ -]*) die "要停的服务名里有不该有的字符：$units" ;; esac
  if [ "$how" = webroot ]; then
    mkdir -p "$R$ACME_WEBROOT"
    # shellcheck disable=SC2086
    certbot certonly --webroot -w "$R$ACME_WEBROOT" -d "$d" --non-interactive --agree-tos $email_args --keep-until-expiring
  else
    local hooks=()
    if [ -n "$units" ]; then
      note "签证书要用 80 端口：先停 $units，签完马上拉起来"
      # shellcheck disable=SC2086
      systemctl stop $units
      # shellcheck disable=SC2064
      trap "systemctl start $units" EXIT
      # 以后 certbot 自动续期时也要这样停一下、续完拉起来（certbot 把这两句记进续期配置；续期失败也会跑 post-hook）
      hooks=(--pre-hook "systemctl stop $units" --post-hook "systemctl start $units")
    fi
    # shellcheck disable=SC2086
    certbot certonly --standalone -d "$d" --non-interactive --agree-tos $email_args --keep-until-expiring "${hooks[@]}"
    if [ -n "$units" ]; then
      # shellcheck disable=SC2086
      systemctl start $units
      trap - EXIT
    fi
  fi
  cert_live "$d" || die "certbot 跑完了，可 $d 的证书还是没有"
}

# 删一张证书（没有就算了）
cert_delete() {
  if [ -d "$R/etc/letsencrypt/live/$1" ] || [ -f "$R/etc/letsencrypt/renewal/$1.conf" ]; then
    certbot delete --cert-name "$1" --non-interactive >/dev/null
    step "cert-$1" ok "证书删掉了"
  else
    step "cert-$1" skip "本来就没有证书"
  fi
}

# 续期后让 nginx 读新证书
install_renew_hook() {
  local want
  want=$(printf '%s\n' '#!/bin/sh' '# 二狗服务管家装的：证书续期后让 nginx 读新证书（lsm vps remove 会删掉它）' 'systemctl reload nginx')
  if [ -f "$RENEW_HOOK" ] && [ "$(cat "$RENEW_HOOK")" = "$want" ]; then
    step renew-hook skip
    return 0
  fi
  mkdir -p "$(dirname "$RENEW_HOOK")"
  printf '%s\n' "$want" > "$RENEW_HOOK"
  chmod 755 "$RENEW_HOOK"
  step renew-hook ok "续期后自动让 nginx 读新证书"
}

# 列证书和到期时刻（status 和 322 的 certs 用）：ERGO-CERT <域名> <Unix 秒|none>
cert_report() {
  local d
  for d in "$@"; do echo "ERGO-CERT $d $(cert_end_epoch "$d")"; done
}

# 一个证书文件的到期时刻（Unix 秒）；读不了是 none
cert_file_end_epoch() {
  local end
  if [ ! -s "$R$1" ]; then echo none; return 0; fi
  end=$(openssl x509 -enddate -noout -in "$R$1" 2>/dev/null | cut -d= -f2) || true
  if [ -z "$end" ]; then echo none; return 0; fi
  date -d "$end" +%s
}

# 这台 VPS 上的全部证书（lsm vps certs、scan 用；只读）：
#  - Let's Encrypt 的（/etc/letsencrypt/live/<名字>/）：ERGO-CERT <名字> <Unix 秒|none>
#  - nginx 里引用的、不在 letsencrypt/live 下的证书文件：ERGO-CERTFILE <路径> <Unix 秒|none>
cert_report_all() {
  local d f
  for d in "$R"/etc/letsencrypt/live/*/; do
    [ -d "$d" ] || continue
    cert_report "$(basename "$d")"
  done
  if [ -d "$R/etc/nginx" ]; then
    for f in $(grep -rhE '^[[:space:]]*ssl_certificate[[:space:]]' "$R/etc/nginx" --exclude-dir=sites-available 2>/dev/null \
      | awk '{print $2}' | tr -d ';' | grep -v '\$' | grep -v '^/etc/letsencrypt/live/' | sort -u || true); do
      echo "ERGO-CERTFILE $f $(cert_file_end_epoch "$f")"
    done
  fi
}
