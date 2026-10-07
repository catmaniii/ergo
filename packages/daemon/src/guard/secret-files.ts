// 密钥文件识别：v1 模板"读过 .env 或密钥文件之后不许对外发送"用它判断之前读的是不是密钥文件。
// 只看文件名（和所在的 .ssh 目录），不看内容；真实路径（符号链接）由调用方在环境事实里给，判定时两个都看。

/** .env 和它的变体（.env.local、.env.production……；.env.example / .sample / .template 这类示例文件除外） */
const ENV_FILE = /^\.env(?:\.(?!example$|sample$|template$)[^.]+)*$/i;
/** 密钥、证书、凭据文件 */
const KEY_FILE =
  /^(?:id_(?:rsa|dsa|ecdsa|ed25519)|.*\.(?:pem|key|p12|pfx|jks|keystore|ppk)|\.netrc|_netrc|\.npmrc|\.pypirc|\.git-credentials|credentials(?:\.json)?|secrets?\.(?:json|ya?ml|toml))$/i;

/** 是不是 .env 或密钥文件（按文件名；`.ssh` 目录下的一律算） */
export function isSecretFile(path: string): boolean {
  if (path === "") return false;
  const parts = path.split(/[\\/]+/).filter((p) => p !== "");
  const name = parts.at(-1) ?? "";
  if (parts.slice(0, -1).some((p) => p.toLowerCase() === ".ssh")) return true;
  return ENV_FILE.test(name) || KEY_FILE.test(name);
}
