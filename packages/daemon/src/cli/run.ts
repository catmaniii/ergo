// ergo 命令的分派（318 号票）：入口见 main.ts（启动器跑它）；测试直接调 runCli。
import fs from "node:fs";
import path from "node:path";
import { t } from "@ergo/protocol";
import { flagOn, flagString, parseArgs } from "./args.ts";
import { cmdComponents } from "./components.ts";
import type { CliContext } from "./context.ts";
import { cmdLogs, cmdOpen, cmdRestart, cmdSvc, cmdStart, cmdStatus, cmdStop } from "./service.ts";
import { cmdUninstall } from "./uninstall.ts";
import { cmdRollback, cmdUpdate } from "./versions.ts";

/** 带值的开关 */
const VALUE_FLAGS = new Set(["n", "version", "from", "mirror", "idle-timeout"]);

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

/** 跑一条命令，回退出码 */
export async function runCli(argv: readonly string[], ctx: CliContext): Promise<number> {
  const args = parseArgs(argv, VALUE_FLAGS);
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
      return cmdComponents(ctx, args.positional[0], args.positional[1]);
    case "svc":
      // 原样转：连 --data-dir 这类开关也不解析
      return cmdSvc(ctx, argv.slice(argv.indexOf("svc") + 1));
    case "onboard":
      ctx.io.out(t("cli.onboard.notYet"));
      return cmdStart(ctx);
    default:
      ctx.io.err(t("cli.unknownCommand", { command: args.command }));
      usage(ctx);
      return 2;
  }
}
