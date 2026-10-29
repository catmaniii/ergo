# ---------------------------------------------------------------- 列证书（lsm vps certs；只读）
# 这台 VPS 上的全部证书和到期时刻：Let's Encrypt 的，加上 nginx 里引用的别的证书文件。什么都不改。

echo "ERGO-CERTS=1"
cert_report_all
echo "ERGO-DONE certs"
