// 密钥文件识别：v1 模板"读过 .env 或密钥文件之后不许往外送"用它判断之前读的是不是密钥文件。
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

/** 读过的密钥值至少多长：更短的（端口号、开关）出现在网址里太常见，不算 */
export const MIN_SECRET_VALUE_LENGTH = 8;

/** .env 的一行：`[export ]名字=值` */
const ENV_LINE = /^\s*(?:export\s+)?[A-Za-z_][\w.-]*\s*=\s*(.*?)\s*$/;

/**
 * 密钥文件里要记下的值（30 号票：守护进程在 agent 读过它之后收进内存，见 guard-runtime/read-secrets.ts，判定时作为环境事实
 * secretValues 交进来）。纯函数，不读文件：
 * - .env 和它的变体：每行的值（去掉 export、成对的引号，没加引号的去掉行尾的 ` # 注释`），8 个字符以上的才算；
 * - 别的密钥文件（私钥、证书、凭据文件……）：整段去掉空白算一个值，8 个字符以上才算。
 */
export function secretValuesIn(path: string, content: string): string[] {
  const name = path.split(/[\\/]+/).at(-1) ?? "";
  if (!ENV_FILE.test(name)) {
    const compact = content.replace(/\s+/g, "");
    return compact.length >= MIN_SECRET_VALUE_LENGTH ? [compact] : [];
  }
  const values: string[] = [];
  for (const line of content.split(/\r?\n/)) {
    const m = ENV_LINE.exec(line);
    if (!m) continue;
    const raw = m[1]!;
    const quoted = /^(["'`])(.*)\1$/.exec(raw);
    const value = quoted ? quoted[2]! : raw.replace(/\s+#.*$/, "");
    if (value.length >= MIN_SECRET_VALUE_LENGTH && !values.includes(value)) values.push(value);
  }
  return values;
}
