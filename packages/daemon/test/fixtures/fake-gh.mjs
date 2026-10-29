// 假的 GitHub 命令行（测试里替换 gh，不真的连 GitHub）：node fake-gh.mjs <记录文件> <放裸仓库的目录> <gh 的参数…>
// - 每次调用往记录文件追加一行 JSON（参数和当前目录）；
// - `repo create <名字> --<可见性> --source=. --remote=origin`：在放裸仓库的目录里建一个本地裸仓库，加成当前仓库的远端，
//   像 gh 那样在 stdout 打出仓库地址；
// - 别的子命令：报错退出。
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const [logFile, bareRoot, ...args] = process.argv.slice(2);
fs.appendFileSync(logFile, `${JSON.stringify({ args, cwd: process.cwd() })}\n`);

if (args[0] === "repo" && args[1] === "create") {
  const name = args[2];
  const remote = args.find((a) => a.startsWith("--remote="))?.slice("--remote=".length) ?? "origin";
  const bare = path.join(bareRoot, `${name.replaceAll("/", "__")}.git`);
  fs.mkdirSync(bare, { recursive: true });
  execFileSync("git", ["init", "-q", "--bare", bare], { stdio: "ignore" });
  if (args.includes("--source=.")) execFileSync("git", ["remote", "add", remote, bare], { stdio: "ignore" });
  process.stdout.write(`https://github.com/ergo-test/${name}\n`);
  process.exit(0);
}
process.stderr.write(`假的 gh 不认得：${args.join(" ")}\n`);
process.exit(1);
