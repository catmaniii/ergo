// 发布公钥（318 号票）：验发布包的校验值清单（SHA256SUMS.minisig）和组件清单（manifest.json.minisig）。
// 从哪来，按先后：
//   1. 环境变量 ERGO_RELEASE_PUBKEY（minisign 公钥的 base64 那一行或整个公钥文件的内容）——测试、自己搭发布地址的人用；
//   2. 程序里这个目录下的 release-key.pub（发版构建时按签名用的钥匙写进去：npm run release -- --sign-key …）；
//   3. 下面的 RELEASE_PUBLIC_KEY（发布钥匙定下来之后写进仓库）。
// 都没有：ergo update 不装没验过签的包（要装就得给 --allow-unsigned，自己承担风险）；组件清单照旧用、界面上写"还没签名"。
// 发布钥匙怎么存（私钥不进仓库）等用户定，见 318 号票。
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { type MinisignPublicKey, parsePublicKey } from "./minisign.ts";

/** 仓库里写死的发布公钥（minisign 公钥的 base64 那一行）；发布钥匙还没定，先空着 */
export const RELEASE_PUBLIC_KEY = "";

/** 发版构建写进程序里的公钥文件 */
export const RELEASE_KEY_FILE = fileURLToPath(new URL("./release-key.pub", import.meta.url));

/** 现在认的发布公钥；没有是 undefined */
export function releasePublicKey(env: NodeJS.ProcessEnv = process.env, keyFile: string = RELEASE_KEY_FILE): MinisignPublicKey | undefined {
  const fromEnv = env.ERGO_RELEASE_PUBKEY?.trim();
  if (fromEnv) return parsePublicKey(fromEnv);
  try {
    return parsePublicKey(fs.readFileSync(keyFile, "utf8"));
  } catch {
    // 没有这个文件（开发时、没签名的构建）
  }
  return RELEASE_PUBLIC_KEY ? parsePublicKey(RELEASE_PUBLIC_KEY) : undefined;
}
