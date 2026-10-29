// 前缀下自检的命令行（132 号票）：npm run check:app-prefix -- <服务地址> --name <应用名> [--keep-prefix]
// 例：npm run check:app-prefix -- http://127.0.0.1:5173 --name p-3-intel
// 抓服务的首页，列出以 / 开头、不在 /apps/<应用名>/ 下的地址和写死的本机地址；有问题退出码 1，连不上 2。见 prefix-check.ts。
// @i18n-ignore-file log：命令行工具的输出
import { isAppName } from "@ergo/protocol";
import { checkAppPrefix, prefixCheckReport } from "./prefix-check.ts";

const args = process.argv.slice(2);
const flag = (name: string) => {
  const at = args.indexOf(name);
  return at < 0 ? undefined : args[at + 1];
};
const name = flag("--name");
const target = args.find((a, i) => !a.startsWith("--") && args[i - 1] !== "--name");
if (target === undefined || name === undefined || !isAppName(name)) {
  process.stderr.write("用法：npm run check:app-prefix -- <服务地址，如 http://127.0.0.1:5173> --name <应用名，小写字母数字连字符> [--keep-prefix]\n");
  process.exit(2);
}
try {
  const result = await checkAppPrefix(target, name, args.includes("--keep-prefix") ? "keep" : "strip");
  process.stdout.write(`${prefixCheckReport(result)}\n`);
  process.exit(result.findings.length === 0 ? 0 : 1);
} catch (err) {
  process.stderr.write(`连不上 ${target}：${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(2);
}
