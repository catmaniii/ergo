// ergo 命令：只管安装和运维，不在命令行里操作二狗。
//   ergo start | stop | restart | status | logs | open      包一层服务管家，用的人不用学 lsm
//   ergo update | rollback | uninstall                      新版本进新目录、空闲时切，旧版本留一份；卸载问要不要删数据
//   ergo backup [--scheduled] | restore <日期> | restore --list      备份、恢复（程序目录里没有 npm run，这两条接上同一份命令行工具）
//   ergo components list | add [--accept-license] | remove | import  组件（守护进程接口）
//   ergo svc <命令…>                                        服务管家的命令原样转过去（ergo svc status = lsm status）
//   ergo onboard                                            把二狗起来，指路去网页走设置向导（向导只做网页）
//   ergo notify <事件名> [--data <JSON>]                     给项目的服务用的：报一个事件，叫醒等它的任务（不算操作二狗）
//   ergo init | list | unregister                           可以配置多份二狗（468）：在空文件夹里建一份、列出各份、从服务管家里拿掉一份
// 每条命令都认 --dir <文件夹>；管哪一份按 --dir > ERGO_DATA_DIR > 当前目录或上级的实例标记文件 > ~/.ergo（instances.ts）。
// 装好的程序里由启动器（ergo.exe / ergo.cmd）用自带的 node 跑它；开发时 npm run ergo -- <命令>。
// 给人看的话按二狗设置的语言（数据目录的 config/language.json），没设按系统的语言（中文系统中文，别的英文）；环境变量 ERGO_LANGUAGE 可以指定。
import "../i18n/boot.ts";
import readline from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { t } from "@ergo/protocol";
import { installBuiltinLocales } from "../i18n/builtin.ts";
import { detectLayout } from "../release/layout.ts";
import { takeDirFlag } from "./args.ts";
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
const argv = process.argv.slice(2);
// --dir 在这里就认：命令行说话的语言按那一份的设置
const { dir } = takeDirFlag(argv);
const ctx = createContext(layout, process.env, terminalIo(), undefined, dir === undefined || dir.trim() === "" ? {} : { dir });
installBuiltinLocales(cliLanguage(process.env, ctx.dataDir));
runCli(argv, ctx).then(
  (code) => {
    process.exitCode = code;
  },
  (err: unknown) => {
    process.stderr.write(`${t("cli.crashed", { detail: err instanceof Error ? err.message : String(err) })}\n`);
    process.exitCode = 1;
  },
);
