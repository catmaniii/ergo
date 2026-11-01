// npm run check:ops -- <ops.json 或方案.json> [--url http://127.0.0.1:<端口>] [--workdir <项目工作目录>] [--project <项目编号>]
// 不起二狗校验运营接口清单和运营方案（check-file.ts）。退出码：0 过了；1 没过（原因写在输出里）；2 用法不对、读不了文件、不是 JSON。
// @i18n-ignore-file log：命令行工具的输出
import "../i18n/boot.ts";
import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { checkOpsFile, portOfUrl } from "./check-file.ts";

const USAGE = "用法：npm run check:ops -- <ops.json 或方案.json> [--url http://127.0.0.1:<端口>] [--workdir <项目工作目录，不写是文件所在的目录>] [--project <项目编号>]\n";

function fail(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(2);
}

let args: ReturnType<typeof parse>;
function parse() {
  return parseArgs({ options: { url: { type: "string" }, workdir: { type: "string" }, project: { type: "string" } }, allowPositionals: true });
}
try {
  args = parse();
} catch (err) {
  fail(`${err instanceof Error ? err.message : String(err)}\n${USAGE}`);
}

const file = args.positionals[0];
if (file === undefined || args.positionals.length > 1) fail(USAGE.trimEnd());
const { url, workdir, project } = args.values;

let text: string;
try {
  text = fs.readFileSync(file, "utf8");
  if (url !== undefined) portOfUrl(url);
} catch (err) {
  fail(err instanceof Error ? err.message : String(err));
}

try {
  const report = await checkOpsFile(text, {
    workdir: path.resolve(workdir ?? path.dirname(file)),
    ...(url === undefined ? {} : { url }),
    ...(project === undefined ? {} : { projectId: project }),
  });
  const out = [
    `${report.kind === "ops" ? "运营接口清单" : "运营方案"} ${file}`,
    ...report.notes.map((line) => `  ${line}`),
    ...report.warnings.map((line) => `  提醒：${line}`),
    ...report.problems.map((line) => `  没过：${line}`),
    report.problems.length === 0 ? "过了。" : `没过，${report.problems.length} 处。`,
  ];
  process.stdout.write(`${out.join("\n")}\n`);
  process.exit(report.problems.length === 0 ? 0 : 1);
} catch (err) {
  fail(err instanceof Error ? err.message : String(err));
}
