// 设置向导里的开机自启开关（347 号票）：显示服务管家的计划任务现在开没开，能开能关。真的动任务还是 lsm 的 install-autostart / uninstall-autostart
// （ergo svc 同一套），先过 cli/autostart.ts 那一关：测试里永远碰不到真的任务。
// 不归这份安装管的不动，和 ergo uninstall、ergo start 核对任务是同一条规矩（342 号票）：
//   - 任务指着别处（用的人自己装的服务管家）：显示"开着，指着别处"，开关都不动它；
//   - 源码跑的（开发机上那个任务也许带着别的 --data-dir）：只显示，要改自己跑 ergo svc；
//   - 安装目录里的：能关；没有任务：能开。
// 自动拉起哪些服务不在这里改，页面写明去服务管家的网页或者 ergo svc autostart <id> on|off。
import { type AutostartView, t } from "@ergo/protocol";
import { readAutostartTaskAsync, runTaskCommand, taskInsideRoot, taskRunsScript } from "../cli/autostart.ts";
import { lsmScript, managerAddress } from "../cli/service.ts";
import { RequestRejected } from "../errors.ts";
import type { InstallLayout } from "../release/layout.ts";

export interface AutostartSwitch {
  view(): Promise<AutostartView>;
  /** 开或关；不归这份安装管的、动不了的抛 RequestRejected（写明原因） */
  set(enabled: boolean): Promise<AutostartView>;
}

export interface AutostartSwitchOptions {
  env: NodeJS.ProcessEnv;
  layout: InstallLayout;
  svcDataDir: string;
  log: (line: string) => void;
}

export function createAutostartSwitch(options: AutostartSwitchOptions): AutostartSwitch {
  const { env, layout, svcDataDir, log } = options;
  const script = lsmScript({ layout });
  const managerUrl = () => {
    const { bind, port } = managerAddress({ svcDataDir, env });
    return `http://${bind}:${port}`;
  };
  // 假任务不看系统：测试在哪都走得通
  const supported = process.platform === "win32" || Boolean(env.ERGO_AUTOSTART_TASK_FILE?.trim());
  let busy = false;

  const view = async (): Promise<AutostartView> => {
    const base = { managerUrl: managerUrl() };
    if (!supported) return { state: "unsupported", cannotChange: t("components.autostart.unsupported"), ...base };
    const action = await readAutostartTaskAsync(env);
    if (action === undefined) return { state: "unknown", cannotChange: t("components.autostart.unknown"), ...base };
    const mine = action !== "" && (layout.root !== undefined ? taskInsideRoot(action, layout.root) : taskRunsScript(action, script));
    if (action !== "" && !mine) return { state: "elsewhere", cannotChange: t("components.autostart.elsewhere"), ...base };
    const state = action === "" ? "off" : "on";
    return layout.kind === "dev" ? { state, cannotChange: t("components.autostart.dev"), ...base } : { state, ...base };
  };

  return {
    view,
    async set(enabled) {
      if (busy) throw new RequestRejected("conflict", t("components.autostart.busy"));
      busy = true;
      try {
        const now = await view();
        if (now.cannotChange !== undefined) throw new RequestRejected("not_allowed", now.cannotChange);
        if ((now.state === "on") === enabled) return now;
        const command = enabled ? "install-autostart" : "uninstall-autostart";
        const r = await runTaskCommand(env, command, { node: layout.node, script, dataDir: svcDataDir });
        const detail = `${r.stdout}${r.stderr}`.trim();
        // @i18n-ignore-next log：开关动了任务只进日志
        log(`开机自启：${command} 退出码 ${r.code}${detail ? `（${detail}）` : ""}`);
        if (r.code !== 0) throw new RequestRejected("not_allowed", t("components.autostart.failed", { detail: detail || String(r.code) }));
        return await view();
      } finally {
        busy = false;
      }
    },
  };
}
