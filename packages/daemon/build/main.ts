// 构建、发版、源码装的命令（318 号票），根 package.json 里的 npm run build / release / ergo:install / release:keygen 都到这里：
//   build    [--skip-web]
//   release  [--node <目录或zip>] [--node-version <版本>] [--node-dist <地址>] [--out <目录>] [--version <版本>]
//            [--sign-key <私钥文件>]（口令放环境变量 ERGO_SIGN_PASSWORD）[--skip-web] [--no-launcher] [--no-npm]
//   install  [--link] [--install-dir <目录>] [--no-switch] [--no-path] [--ref <标签或分支>] [--node-pointer]
//   keygen   --out <目录> [--password]（口令放环境变量 ERGO_SIGN_PASSWORD）——生成一对 minisign 格式的发布钥匙（私钥别进仓库）
import fs from "node:fs";
import path from "node:path";
import { defaultInstallRoot } from "../src/release/layout.ts";
import { formatPublicKey, formatSecretKey, generateKeyPair, keyIdHex } from "../src/release/minisign.ts";
import { devBuild, installFromRepo } from "./install-local.ts";
import { buildRelease } from "./release.ts";
import { quietStripWarning } from "./transpile.ts";

const REPO = path.resolve(import.meta.dirname, "..", "..", "..");

function flags(argv: readonly string[]): Map<string, string | true> {
  const out = new Map<string, string | true>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (!a.startsWith("--")) continue;
    const [name, value] = a.slice(2).split("=", 2) as [string, string | undefined];
    if (value !== undefined) out.set(name, value);
    else if (i + 1 < argv.length && !argv[i + 1]!.startsWith("--")) out.set(name, argv[++i]!);
    else out.set(name, true);
  }
  return out;
}

const str = (f: Map<string, string | true>, name: string) => {
  const v = f.get(name);
  return typeof v === "string" ? v : undefined;
};

async function main(): Promise<number> {
  quietStripWarning();
  const [command, ...rest] = process.argv.slice(2);
  const f = flags(rest);
  const log = (line: string) => console.log(line);
  switch (command) {
    case "build":
      devBuild(REPO, { skipWeb: f.has("skip-web"), log });
      return 0;
    case "release": {
      const key = str(f, "sign-key");
      const result = await buildRelease({
        repo: REPO,
        out: path.resolve(str(f, "out") ?? path.join(REPO, "dist", "release")),
        ...(str(f, "version") ? { version: str(f, "version")! } : {}),
        ...(str(f, "node") ? { node: path.resolve(str(f, "node")!) } : {}),
        ...(str(f, "node-version") ? { nodeVersion: str(f, "node-version")! } : {}),
        ...(str(f, "node-dist") ? { nodeDist: str(f, "node-dist")! } : {}),
        ...(key ? { signKey: { text: fs.readFileSync(key, "utf8"), ...(process.env.ERGO_SIGN_PASSWORD ? { password: process.env.ERGO_SIGN_PASSWORD } : {}) } } : {}),
        skipWeb: f.has("skip-web"),
        noLauncher: f.has("no-launcher"),
        noNpm: f.has("no-npm"),
        log,
      });
      log(`发布包：${result.zip}`);
      log(`校验值：${result.sums}${result.signature ? `，签名：${result.signature}` : "（没签名：没给 --sign-key）"}`);
      log(`启动器：${result.launcher === "exe" ? "ergo.exe + ergo.cmd" : `只有 ergo.cmd（${result.launcherNote ?? "--no-launcher"}）`}`);
      return 0;
    }
    case "install": {
      const name = installFromRepo({
        repo: REPO,
        root: path.resolve(str(f, "install-dir") ?? defaultInstallRoot()),
        link: f.has("link"),
        switchTo: !f.has("no-switch"),
        path: !f.has("no-path"),
        ...(str(f, "ref") ? { ref: str(f, "ref")! } : {}),
        nodePointer: f.has("node-pointer"),
        log,
      });
      log(name);
      return 0;
    }
    case "keygen": {
      const out = path.resolve(str(f, "out") ?? ".");
      const password = f.has("password") ? process.env.ERGO_SIGN_PASSWORD : undefined;
      if (f.has("password") && !password) throw new Error("--password 要把口令放进环境变量 ERGO_SIGN_PASSWORD");
      const key = generateKeyPair();
      fs.mkdirSync(out, { recursive: true });
      const secretFile = path.join(out, "ergo-release.key");
      if (fs.existsSync(secretFile)) throw new Error(`${secretFile} 已经有了，不覆盖`);
      fs.writeFileSync(secretFile, formatSecretKey(key, password));
      fs.writeFileSync(path.join(out, "ergo-release.pub"), formatPublicKey(key));
      log(`钥匙 ${keyIdHex(key.keyId)}：私钥 ${secretFile}（别进仓库），公钥 ${path.join(out, "ergo-release.pub")}`);
      return 0;
    }
    default:
      console.error("用法：node packages/daemon/build/main.ts build | release | install | keygen（见文件开头）");
      return 2;
  }
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (err: unknown) => {
    console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
    process.exitCode = 1;
  },
);
