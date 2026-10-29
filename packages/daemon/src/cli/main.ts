// ergo 命令（318 号票）：只管安装和运维，不在命令行里操作二狗（用户 2026-10-26 定）。
//   ergo start | stop | restart | status | logs | open      包一层服务管家，用的人不用学 lsm
//   ergo update | rollback | uninstall                      新版本进新目录、空闲时切，旧版本留一份；卸载问要不要删数据
//   ergo components list | add | remove | import            组件（323 号票的守护进程接口）
//   ergo svc <命令…>                                        服务管家的命令原样转过去（ergo svc status = lsm status）
//   ergo onboard、doctor、key set、pair、remote             319 号票做（onboard 先只把二狗起来）
// 装好的程序里由启动器（ergo.exe / ergo.cmd）用自带的 node 跑它；开发时 npm run ergo -- <命令>。
// 给人看的话按二狗设置的语言（数据目录的 config/language.json），没设按系统的语言（中文系统中文，别的英文）；环境变量 ERGO_LANGUAGE 可以指定。
import "../i18n/boot.ts";
import readline from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { t } from "@ergo/protocol";
import { installBuiltinLocales } from "../i18n/builtin.ts";
import { detectLayout } from "../release/layout.ts";
import { type CliIo, createContext } from "./context.ts";
import { cliLanguage, runCli } from "./run.ts";

function terminalIo(): CliIo {
  return {
    out: (line) => process.stdout.write(`${line}\n`),
    err: (line) => process.stderr.write(`${line}\n`),
    async ask(question) {
      if (!process.stdin.isTTY) return "";
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      try {
        return await rl.question(`${question} `);
      } finally {
        rl.close();
      }
    },
  };
}

const layout = detectLayout({ cliFile: fileURLToPath(import.meta.url) });
const ctx = createContext(layout, process.env, terminalIo());
installBuiltinLocales(cliLanguage(process.env, ctx.dataDir));
runCli(process.argv.slice(2), ctx).then(
  (code) => {
    process.exitCode = code;
  },
  (err: unknown) => {
    process.stderr.write(`${t("cli.crashed", { detail: err instanceof Error ? err.message : String(err) })}\n`);
    process.exitCode = 1;
  },
);
