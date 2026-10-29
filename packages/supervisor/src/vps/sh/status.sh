# ---------------------------------------------------------------- 现在怎样（lsm vps status；只读）

kv() { printf '%s=%s\n' "$1" "$2"; }
yes_no() { if "$@" >/dev/null 2>&1; then echo 1; else echo 0; fi; }

echo "ERGO-STATUS=1"
kv MANIFEST_TUNNEL "$(yes_no test -f "$STATE_DIR/tunnel.env")"
kv MANIFEST_HEADSCALE "$(yes_no test -f "$STATE_DIR/headscale.env")"
kv SVC_NGINX "$(systemctl is-active nginx 2>/dev/null || true)"
kv SVC_HEADSCALE "$(systemctl is-active headscale 2>/dev/null || true)"
kv UFW_ACTIVE "$(yes_no ufw_active)"
kv TUNNEL_ACCOUNT "$(yes_no id -u "$TUNNEL_USER")"
# 电脑那头的隧道接上了没有：VPS 的 127.0.0.1:<隧道端口> 有没有人在听（就是 sshd 替隧道听着）
kv TUNNEL_LISTEN "$(ss -H -ltn "sport = :$TUNNEL_PORT" 2>/dev/null | grep -c '127\.0\.0\.1' || true)"
kv HS_HEALTH "$(curl -fsS -m 5 "http://127.0.0.1:$HS_PORT/health" 2>/dev/null | tr -d '\n' || true)"
kv HS_NODES "$(headscale nodes list -o json-line 2>/dev/null | grep -o '"given_name"' | wc -l | tr -d ' ' || true)"
# shellcheck disable=SC2086
cert_report $DOMAINS
echo "ERGO-DONE status"
