// ergo 命令的分派：入口见 main.ts（启动器跑它）；测试直接调 runCli。
import fs from "node:fs";
import path from "node:path";
import { t } from "@ergo/protocol";
import { flagOn, flagString, parseArgs, takeDirFlag } from "./args.ts";
import { cmdBackupTool } from "./backup-tools.ts";
import { cmdComponents } from "./components.ts";
import { type CliContext, contextForInstance } from "./context.ts";
import { cmdInit, cmdList, cmdUnregister, isDefaultDataDir } from "./instance-commands.ts";
import { cmdLocalPairing } from "./local-pairing.ts";
import { cmdNotify } from "./notify.ts";
import { cmdLogs, cmdOnboard, cmdOpen, cmdRestart, cmdSvc, cmdStart, cmdStatus, cmdStop } from "./service.ts";
import { cmdUninstall } from "./uninstall.ts";
import { cmdRollback, cmdUpdate } from "./versions.ts";

/** 带值的开关（--dir 在分派之前就拿掉了，见 takeDirFlag） */
const VALUE_FLAGS = new Set(["n", "version", "from", "mirror", "idle-timeout", "data", "name", "port"]);

/** 不管是哪一份的命令：实例标记文件不对时照样能跑 */
const ANY_INSTANCE = new Set([undefined, "help", "--help", "version", "--version", "init", "list"]);

/** 命令行用哪种语言 */
export function cliLanguage(env: NodeJS.ProcessEnv, dataDir: string, systemLocale: string = Intl.DateTimeFormat().resolvedOptions().locale): string {
  if (env.ERGO_LANGUAGE?.trim()) return env.ERGO_LANGUAGE.trim();
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(dataDir, "config", "language.json"), "utf8").replace(/^\uFEFF/, "")) as { language?: unknown };
    if (typeof raw.language === "string" && raw.language) return raw.language;
  } catch {
    // 没设过语言
  }
  return systemLocale.toLowerCase().startsWith("zh") ? "zh-CN" : "en";
}

function usage(ctx: CliContext): void {
  ctx.io.out(t("cli.help.text"));
}

function version(ctx: CliContext): number {
  const { layout } = ctx;
  const info = layout.info;
  ctx.io.out(
    t("cli.version.line", {
      version: info?.version ?? t("cli.status.dev"),
      kind: t(`cli.kind.${info?.kind ?? layout.kind}`),
      node: process.version,
      commit: info?.commit ?? "-",
    }),
  );
  return 0;
}

/**
 * 跑一条命令，回退出码。--dir <文件夹> 每条命令都认（放在命令前后都行）：管的就是那个文件夹那一份（认法见 instances.ts）。
 * main.ts 建上下文时已经按它认过；测试直接调这里时在这里认
 */
export async function runCli(fullArgv: readonly string[], given: CliContext): Promise<number> {
  const taken = takeDirFlag(fullArgv);
  if (taken.dir !== undefined && taken.dir.trim() === "") {
    given.io.err(t("cli.instance.dirMissing"));
    return 2;
  }
  const ctx = taken.dir === undefined ? given : contextForInstance(given, { dir: taken.dir });
  const argv = taken.argv;
  const args = parseArgs(argv, VALUE_FLAGS);
  if (ctx.instanceError && !ANY_INSTANCE.has(args.command)) {
    ctx.io.err(t("cli.instance.badMarker", ctx.instanceError));
    return 1;
  }
  // --dir 指的文件夹没有标记、又不是默认那份的数据目录：不是一份二狗（写错了的不能落到默认那份头上：start 会把它的登记改指那里）
  if (taken.dir !== undefined && !ANY_INSTANCE.has(args.command) && ctx.instanceName === undefined && !isDefaultDataDir(ctx, ctx.dataDir)) {
    ctx.io.err(t("cli.instance.notInstance", { dir: ctx.dataDir }));
    return 1;
  }
  const idleTimeoutMs = Number(flagString(args, "idle-timeout") ?? 7200) * 1000;
  switch (args.command) {
    case undefined:
    case "help":
    case "--help":
      usage(ctx);
      return 0;
    case "version":
    case "--version":
      return version(ctx);
    case "start":
      return cmdStart(ctx);
    case "stop":
      return cmdStop(ctx);
    case "restart":
      return cmdRestart(ctx);
    case "status":
      return cmdStatus(ctx, flagOn(args, "json"));
    case "logs": {
      const ac = new AbortController();
      process.once("SIGINT", () => ac.abort());
      return cmdLogs(ctx, Number(flagString(args, "n") ?? 50) || 50, flagOn(args, "f") || flagOn(args, "follow"), ac.signal);
    }
    case "open":
      return cmdOpen(ctx, flagOn(args, "print"));
    case "update": {
      const mirror = flagString(args, "mirror");
      const from = flagString(args, "from");
      const versionFlag = flagString(args, "version");
      return cmdUpdate(ctx, {
        check: flagOn(args, "check"),
        ...(versionFlag ? { version: versionFlag.replace(/^v/, "") } : {}),
        ...(from ? { from } : {}),
        ...(mirror === "cn" || mirror === "github" ? { mirror } : {}),
        allowUnsigned: flagOn(args, "allow-unsigned"),
        idleTimeoutMs,
      });
    }
    case "rollback":
      return cmdRollback(ctx, idleTimeoutMs);
    case "uninstall":
      return cmdUninstall(ctx, {
        yes: flagOn(args, "yes") || flagOn(args, "y"),
        ...(flagOn(args, "delete-data") ? { deleteData: true } : flagOn(args, "keep-data") ? { deleteData: false } : {}),
      });
    case "components":
      return cmdComponents(ctx, args.positional[0], args.positional[1], { acceptLicense: flagOn(args, "accept-license") });
    case "backup":
      // 原样转给备份、恢复的命令行工具
      return cmdBackupTool(ctx, "run-backup", argv.slice(argv.indexOf("backup") + 1));
    case "restore":
      return cmdBackupTool(ctx, "restore", argv.slice(argv.indexOf("restore") + 1));
    case "svc":
      // 原样转：连 --data-dir 这类开关也不解析
      return cmdSvc(ctx, argv.slice(argv.indexOf("svc") + 1));
    case "onboard":
      return cmdOnboard(ctx);
    case "notify":
      // 给项目的服务用的：报一个事件，叫醒等它的任务
      return cmdNotify(ctx, args.positional[0], args.flags.get("data"));
    case "init": {
      // 只看 --dir 和当前文件夹（ERGO_DATA_DIR、上级的标记文件不算：要建的就是这个文件夹）
      const name = flagString(args, "name");
      const port = flagString(args, "port");
      return cmdInit(ctx, { ...(taken.dir === undefined ? {} : { dir: taken.dir }), ...(name === undefined ? {} : { name }), ...(port === undefined ? {} : { port }) });
    }
    case "list":
      return cmdList(ctx, flagOn(args, "json"));
    case "unregister":
      return cmdUnregister(ctx);
    case "local-pairing":
      // 469：看、关"本机来的也要配对"（被关在外面时的退路）
      return cmdLocalPairing(ctx, args.positional[0]);
    default:
      ctx.io.err(t("cli.unknownCommand", { command: args.command }));
      usage(ctx);
      return 2;
  }
}
