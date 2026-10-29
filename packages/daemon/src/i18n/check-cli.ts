// npm run i18n:check（168 号票）：多语言的检查工具。
//   npm run i18n:check                          每种语言缺的、多的、插值参数对不上的句子；~/.ergo/locales 里读不进来的文件；
//                                               写死的中文每个区域还剩几处、基线是多少
//   npm run i18n:check -- --data-dir "D:\…"     指定数据目录（不填取 ERGO_DATA_DIR，没设是用户主目录下的 .ergo）
//   npm run i18n:check -- --keys                缺的、多的逐句列出来（不加只列前 20 句）
//   npm run i18n:check -- --list web-pages      列出这个区域写死的中文的每一处（文件:行 原文）
//   npm run i18n:check -- --ignored daemon-a    列出这个区域标了 @i18n-ignore 的（白名单），不写区域是全部
//   npm run i18n:check -- --lower-baseline      把降下来的区域的基线改成现在的数（只降不升；还没有基线的写一份）
// 自带的语言有问题（文件放错区域、自带的英文不全）时以 1 退出；用户自己加的语言缺句子不算错（缺的用中文补）。
// @i18n-ignore-file log：命令行工具的输出
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { DATA_DIR_ENV, loadConfig } from "../config/config.ts";
import { dataDirLayout } from "../config/data-dir.ts";
import { BUILTIN_LOCALES_DIR } from "./builtin.ts";
import { builtinBroken, checkLocales } from "./check.ts";
import { countByRegion, HARDCODED_REGIONS, lowerBaseline, readBaseline, scanRepo } from "./hardcoded.ts";

const REPO = fileURLToPath(new URL("../../../../", import.meta.url));
const DAEMON_SRC = fileURLToPath(new URL("../", import.meta.url));

const { values } = parseArgs({
  options: {
    "data-dir": { type: "string" },
    keys: { type: "boolean" },
    list: { type: "string" },
    ignored: { type: "string" },
    "lower-baseline": { type: "boolean" },
  },
  allowPositionals: true,
});
// --ignored 不写区域：parseArgs 的 string 选项要值，单独写 --ignored 时当成全部
const ignoredAll = process.argv.includes("--ignored") && values.ignored === undefined;

const env = values["data-dir"] ? { ...process.env, [DATA_DIR_ENV]: values["data-dir"] } : process.env;
let userDir: string | undefined;
try {
  userDir = dataDirLayout(loadConfig({ env, homeDir: os.homedir() }).dataDir).locales;
} catch (err) {
  console.log(`（读不了二狗的配置，只查自带的语言：${err instanceof Error ? err.message : String(err)}）`);
}

const show = (keys: readonly string[]) => (values.keys || keys.length <= 20 ? keys.join("\n      ") : `${keys.slice(0, 20).join("\n      ")}\n      ……还有 ${keys.length - 20} 句（加 --keys 全部列出）`);

if (values.list !== undefined || values.ignored !== undefined || ignoredAll) {
  const region = values.list ?? values.ignored;
  const scans = scanRepo(REPO).filter((s) => region === undefined || s.region === region);
  if (region !== undefined && !HARDCODED_REGIONS.some((r) => r.region === region)) {
    console.log(`没有这个区域：${region}。区域有：${HARDCODED_REGIONS.map((r) => r.region).join("、")}`);
    process.exit(1);
  }
  const wantIgnored = values.list === undefined;
  let n = 0;
  for (const scan of scans) {
    for (const literal of scan.literals) {
      if (Boolean(literal.ignored) !== wantIgnored) continue;
      n++;
      console.log(`${scan.file}:${literal.line}${literal.ignored ? ` [${literal.ignored}]` : ""} ${literal.text.replace(/\s+/g, " ").slice(0, 80)}`);
    }
  }
  console.log(`\n共 ${n} 处`);
  process.exit(0);
}

console.log(`自带的语言：${path.relative(REPO, BUILTIN_LOCALES_DIR)}`);
console.log(`用户放的语言：${userDir ?? "（没有）"}\n`);
const check = checkLocales({ builtinDir: BUILTIN_LOCALES_DIR, ...(userDir ? { userDir } : {}), daemonSrc: DAEMON_SRC });
for (const problem of check.builtinProblems) console.log(`✗ 自带的语言文件：${problem}`);
for (const lang of check.languages) {
  const from = lang.source === "user" ? "来自 ~/.ergo/locales" : lang.source === "builtin_user" ? "自带，~/.ergo/locales 里改过" : "自带";
  const ok = lang.missing.length === 0 && lang.extra.length === 0 && lang.paramMismatch.length === 0;
  console.log(`${ok ? "✓" : "·"} ${lang.id}（${lang.nativeName}，${from}）：缺 ${lang.missing.length} 句，多 ${lang.extra.length} 句，插值参数对不上 ${lang.paramMismatch.length} 句`);
  if (lang.missing.length > 0) console.log(`    缺的（用中文补）：\n      ${show(lang.missing)}`);
  if (lang.extra.length > 0) console.log(`    多的（中文里没有这句，用不上）：\n      ${show(lang.extra)}`);
  for (const m of lang.paramMismatch) console.log(`    插值参数对不上：${m.key}：中文是 {${m.expected.join("}、{")}}，这里是 {${m.actual.join("}、{")}}`);
}
if (check.problems.length > 0) {
  console.log("\n~/.ergo/locales 里没读进来的：");
  for (const p of check.problems) console.log(`  ${p.file}：${p.code}${p.detail ? `：${p.detail}` : ""}${p.key ? `（${p.key}）` : ""}`);
}

console.log("\n写死的中文（不含日志和标了 @i18n-ignore 的）：");
const counts = countByRegion(scanRepo(REPO));
for (const { region, ticket } of HARDCODED_REGIONS) {
  const count = counts[region] ?? 0;
  const baseline = readBaseline(REPO, region);
  let note = baseline === undefined ? "还没有基线" : count > baseline ? `比基线 ${baseline} 多了 ${count - baseline} 处 ✗` : count < baseline ? `比基线 ${baseline} 少了 ${baseline - count} 处，可以降基线` : "和基线一样";
  if (values["lower-baseline"] && lowerBaseline(REPO, region, count)) note += `；基线改成了 ${count}`;
  console.log(`  ${region.padEnd(13)}（${ticket} 号票）${String(count).padStart(5)} 处 · ${note}`);
}

if (builtinBroken(check)) {
  for (const lang of check.builtinLanguages) {
    if (lang.missing.length + lang.extra.length + lang.paramMismatch.length === 0) continue;
    console.log(`\n✗ 自带的 ${lang.id} 不全：缺 ${lang.missing.length} 句，多 ${lang.extra.length} 句，插值参数对不上 ${lang.paramMismatch.length} 句（自带的语言必须全有）`);
    if (lang.missing.length > 0) console.log(`      ${show(lang.missing)}`);
  }
  console.log("\n自带的语言有问题（见上面打 ✗ 的）。");
  process.exit(1);
}
