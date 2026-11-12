// ergo 命令里管服务的那一半：包一层服务管家（packages/supervisor，命令 lsm），用的人不用学 lsm。
//   - 服务管家的设置（manager.yaml）不在时写一份默认的；二狗的登记（registry/services/ergo-daemon.yaml）每次 start 按这次的安装重写——
//     路径都走安装目录的 current（切版本只要重启，不用改登记），端口按二狗的配置（config/ergo.json 的 ports.local）；
//     env 里用的人多加的项留着（手动登记的 MCP 把 fromEnv 的变量写在这里），我们自己的项照旧覆盖；
//   - 服务管家没在跑就把它起来（单独的小进程，不跟着这个命令退出）；
//   - start / stop / restart / status / logs 交给服务管家；svc <命令…> 原样转给 lsm。
// 开机自启（服务管家的计划任务）由安装脚本默认装（经 ergo svc install-autostart）；这里在每次按 current 重写登记时核对一下它还指着在用的版本，
// 改指了、而在跑的服务管家正是这个任务起的，就经任务把它重起成新版本（restartManagerViaTask）。
// 开机拉起哪些服务看服务管家的名单 registry/autostart.yaml：还没有时写一份只含二狗的，有了就再也不碰（用的人关掉后不会被下一次 start 打开）。
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { t } from "@ergo/protocol";
import { installPaths, readInstallState, writeInstallState } from "../release/layout.ts";
import { type AutostartTaskInfo, interceptTaskCommand, readAutostartTaskInfo, runTaskOp, sameDir, taskDataDir, taskInsideRoot, taskRunsScript } from "./autostart.ts";
import { type CliContext, daemonPort, daemonUrl, defaultSvcDataDir } from "./context.ts";

/** 二狗在服务管家里登记的 id */
export const DAEMON_SERVICE_ID = "ergo-daemon";
/** 第一次生成服务管家设置时用的端口（环境变量 ERGO_SVC_PORT 可以换，测试用它避开本机正在用的） */
export const DEFAULT_SVC_PORT = 7420;

export interface SvcPaths {
  registry: string;
  services: string;
  managerYaml: string;
  bootList: string;
  daemonEntry: string;
  state: string;
  daemonLog: string;
}

export function svcPaths(ctx: Pick<CliContext, "svcDataDir">): SvcPaths {
  const registry = path.join(ctx.svcDataDir, "registry");
  return {
    registry,
    services: path.join(registry, "services"),
    managerYaml: path.join(registry, "manager.yaml"),
    bootList: path.join(registry, "autostart.yaml"),
    daemonEntry: path.join(registry, "services", `${DAEMON_SERVICE_ID}.yaml`),
    state: path.join(ctx.svcDataDir, "state.json"),
    daemonLog: path.join(ctx.svcDataDir, "logs", `${DAEMON_SERVICE_ID}.out.log`),
  };
}

/** YAML 单引号字符串（反斜杠原样，单引号写两个）：Windows 路径写进去不会被当成转义 */
export function yamlQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/** 还没有 manager.yaml 时用的端口：ERGO_SVC_PORT，没设是 7420 */
function fallbackSvcPort(env: NodeJS.ProcessEnv): number {
  const port = Number(env.ERGO_SVC_PORT);
  return Number.isInteger(port) && port > 0 && port < 65536 ? port : DEFAULT_SVC_PORT;
}

/** 服务管家的地址（manager.yaml 的 bind、port；没有就是 ERGO_SVC_PORT 或默认的 7420） */
export function managerAddress(ctx: Pick<CliContext, "svcDataDir" | "env">): { bind: string; port: number } {
  try {
    const text = fs.readFileSync(svcPaths(ctx).managerYaml, "utf8");
    const port = Number(/^port:\s*(\d+)/m.exec(text)?.[1]);
    const bind = /^bind:\s*['"]?([0-9.a-zA-Z:]+)/m.exec(text)?.[1];
    return { bind: bind ?? "127.0.0.1", port: Number.isInteger(port) && port > 0 ? port : DEFAULT_SVC_PORT };
  } catch {
    return { bind: "127.0.0.1", port: fallbackSvcPort(ctx.env) };
  }
}

/** 默认的服务管家设置（ergo 第一次 start 时写）：只绑本机、不动别的进程（不自动清占端口的、哨兵关着） */
export function defaultManagerYaml(port: number): string {
  return [
    "# Service manager settings (written by the first `ergo start`; ergo never overwrites it). Fields: app/packages/supervisor/docs/service-schema.md and examples/registry/manager.yaml.",
    "bind: 127.0.0.1",
    `port: ${port}`,
    "probeIntervalMs: 5000",
    "# a registered port taken by another process is only reported, never cleared",
    "autoResolveConflicts: false",
    "sentinels:",
    "  port: false",
    "  scheduledTask: false",
    "  intervalMs: 60000",
    "projectRoots: []",
    "ignorePorts: [135, 139, 445, 3389, 5040, 5357]",
    "ignoreProcessNames: [svchost.exe, System, lsass.exe, services.exe, spoolsv.exe]",
    "profiles:",
    `  ergo: [${DAEMON_SERVICE_ID}]`,
    "auth:",
    "  enabled: false",
    "  passwordFile: .secrets/webui-password.txt",
    "",
  ].join("\n");
}

/** 默认的开机自启名单：只有二狗（格式和服务管家的 bootlist.mjs 读写的一样；用的人改过之后它整份重写，这几行注释也就没了） */
export function defaultBootListYaml(): string {
  return [
    "# Services the service manager starts in a new login session (written once by the first `ergo start`; ergo never changes it again).",
    "# Change it with the switch on a service's card in the service manager's web page, or `ergo svc autostart <id> on|off`.",
    "services:",
    `  - ${DAEMON_SERVICE_ID}`,
    "",
  ].join("\n");
}

/** 登记里用的路径：装好的用 current 指着的那个版本目录（current 只是一行文本，不能当目录用）；开发布局用仓库 */
export function entryPaths(ctx: Pick<CliContext, "layout">): { root: string; node: string; main: string; stop: string } {
  const { layout } = ctx;
  if (layout.kind === "installed" && layout.root) {
    // 每次 start 都按 current 重写登记，所以升级切版本后重起就是新版本
    const home = layout.home;
    const bundled = path.join(home, "node", "node.exe");
    return {
      root: path.join(home, "app"),
      node: fs.existsSync(bundled) ? bundled : layout.node,
      main: "packages/daemon/src/main.js",
      stop: "packages/daemon/src/stop.js",
    };
  }
  const ext = fs.existsSync(path.join(layout.appDir, "packages", "daemon", "src", "main.js")) ? "js" : "ts";
  return { root: layout.appDir, node: layout.node, main: `packages/daemon/src/main.${ext}`, stop: `packages/daemon/src/stop.${ext}` };
}

/** 二狗自己写进登记 env 的项（一行一行）。以后不再写某一项时，旧登记里的它会被当成用的人加的留下来（userEnvLines），到时要记下它的名字 */
function ownEnvLines(ctx: Pick<CliContext, "dataDir" | "svcDataDir">): string[] {
  return [
    "  - name: ERGO_DATA_DIR",
    "    from: literal",
    `    value: ${yamlQuote(ctx.dataDir)}`,
    // 服务管家拉服务时不传自己的 --data-dir、环境变量（hooks.mjs 的白名单）：二狗的体检要读它的注册表，得在这里写明它在哪
    "  - name: LSM_DATA_DIR",
    "    from: literal",
    `    value: ${yamlQuote(ctx.svcDataDir)}`,
    "  - name: DEEPSEEK_API_KEY",
    "    from: file",
    `    path: ${yamlQuote(path.join(ctx.dataDir, "secrets", "deepseek-api-key.txt"))}`,
    "    optional: true",
    // 自定义（OpenAI 兼容）服务商的 key（自定义服务商这一步）：和 DeepSeek 一样从密钥区注入（没有也能起来，optional）
    "  - name: CUSTOM_MODEL_API_KEY",
    "    from: file",
    `    path: ${yamlQuote(path.join(ctx.dataDir, "secrets", "custom-model-api-key.txt"))}`,
    "    optional: true",
  ];
}

/** 一行写完的 env: [{…}, {…}] 里的每个 {…}（引号里的括号不算） */
function flowMaps(text: string): string[] {
  const maps: string[] = [];
  let quote = "";
  let from = -1;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quote !== "") {
      if (c === quote) quote = "";
    } else if (c === "'" || c === '"') quote = c;
    else if (c === "{" && from < 0) from = i;
    else if (c === "}" && from >= 0) {
      maps.push(text.slice(from, i + 1).replace(/\s*\n\s*/g, " "));
      from = -1;
    }
  }
  return maps;
}

/** 一项 env 的名字（- name: X、- { name: X, … }，写在第几个都认）；没有名字是 undefined */
function envItemName(item: string): string | undefined {
  return /(?:^\s*(?:-\s+)?|[{,]\s*)name:\s*(['"]?)([^'"\s,}#]+)\1/m.exec(item)?.[2];
}

const leadingSpaces = (line: string) => line.length - line.trimStart().length;
const isListItem = (line: string) => /^\s*-(\s|$)/.test(line);

/**
 * 旧登记的 env 里用的人多加的项，原样的几行（缩进换成我们的，项上面的注释带着）。名字是我们自己写的不要（照旧覆盖），没有名字的不要（服务管家也不认）。
 * 守护进程没有 YAML 库（只有服务管家有），这里只认顶层 env: 这一段：缩进的、不缩进的列表，一行写完的 [{…}]，记事本存的 CRLF；
 * 别的写法读不出来就当没有。留下的是用的人写的原样，写错了由 lsm 报，和没经过这里时一样
 */
export function userEnvLines(oldEntry: string, ownNames: ReadonlySet<string>): string[] {
  const lines = oldEntry.split(/\r?\n/);
  const start = lines.findIndex((line) => /^env:(\s|$)/.test(line));
  if (start < 0) return [];
  // 到下一个顶层的键为止（不缩进的 - 是这个列表的项）
  let end = start + 1;
  while (end < lines.length && (lines[end]!.trim() === "" || /^(\s|#|-(\s|$))/.test(lines[end]!))) end++;
  const body = lines.slice(start + 1, end);
  const keep = (item: string) => {
    const name = envItemName(item);
    return name !== undefined && !ownNames.has(name);
  };

  const inline = lines[start]!.slice("env:".length).trim();
  if (inline !== "" && !inline.startsWith("#")) {
    return inline.startsWith("[") ? flowMaps([inline, ...body].join("\n")).filter(keep).map((map) => `  - ${map}`) : [];
  }

  const indent = leadingSpaces(body.find(isListItem) ?? "");
  const kept: string[] = [];
  let comments: string[] = [];
  let item: string[] | undefined;
  const finish = () => {
    if (item && keep(item.join("\n"))) kept.push(...item.map((line) => `  ${line.slice(Math.min(indent, leadingSpaces(line)))}`));
    item = undefined;
  };
  for (const line of body) {
    if (line.trim() === "") continue;
    if (isListItem(line) && leadingSpaces(line) === indent) {
      finish();
      item = [...comments, line];
      comments = [];
    } else if (line.trimStart().startsWith("#") && leadingSpaces(line) <= indent) {
      // 和列表一样缩进的注释说的是下一项；后面没有项了（说的是下一个顶层的键）就不要
      finish();
      comments.push(line);
    } else {
      item?.push(line);
    }
  }
  finish();
  return kept;
}

/** 登记文件的第一行（我们写的，不算用的人写在 exposure: 上面的注释） */
const ENTRY_HEAD = "# ergo daemon entry: rewritten by every `ergo start` and update (change ports in the ergo config file config/ergo.json). Items you add under env: and a top-level exposure: block are kept; everything else goes back to what ergo writes.";

/**
 * 旧登记里用的人写的顶层 exposure:（部署手册让在这里打开公网入口；服务管家的网页上开的也写在这里），原样的几行，紧贴在它上面的注释带着。
 * 我们不写这一段，所以整段都是用的人的。和 userEnvLines 一样只看文本：缩进的一段（到下一个顶层的键为止，段尾不缩进的注释说的是下一个键，不要）、
 * 一行写完的 exposure: {…}。值是空的、不是一段的（exposure: null、只有注释）当没有。留下的是用的人写的原样，写错了由 lsm 报
 */
export function userExposureLines(oldEntry: string): string[] {
  const lines = oldEntry.split(/\r?\n/);
  const start = lines.findIndex((line) => /^exposure:(\s|$)/.test(line));
  if (start < 0) return [];
  let top = start;
  while (top > 0 && lines[top - 1]!.startsWith("#") && lines[top - 1] !== ENTRY_HEAD) top--;
  const above = lines.slice(top, start);

  const inline = lines[start]!.slice("exposure:".length).trim();
  if (inline !== "" && !inline.startsWith("#")) {
    if (!inline.startsWith("{")) return [];
    const map = flowMaps([inline, ...lines.slice(start + 1)].join("\n"))[0];
    return map === undefined ? [] : [...above, `exposure: ${map}`];
  }

  let end = start + 1;
  while (end < lines.length && (lines[end]!.trim() === "" || /^(\s|#)/.test(lines[end]!))) end++;
  // 段尾的空行、不缩进的注释不是这一段的
  while (end > start + 1 && (lines[end - 1]!.trim() === "" || lines[end - 1]!.startsWith("#"))) end--;
  const body = lines.slice(start + 1, end);
  return body.some((line) => line.trim() !== "" && !line.trimStart().startsWith("#")) ? [...above, lines[start]!.trimEnd(), ...body] : [];
}

/** 二狗的登记（每次 start 重写，userEnv 是 env 里用的人多加的项，userExposure 是用的人写的公网入口）。DeepSeek 的 key 照旧由服务管家从数据目录的密钥区读出来注入（没有也能起来，optional） */
export function daemonEntryYaml(ctx: Pick<CliContext, "layout" | "dataDir" | "svcDataDir">, userEnv: readonly string[] = [], userExposure: readonly string[] = []): string {
  const p = entryPaths(ctx);
  const port = daemonPort(ctx);
  return [
    ENTRY_HEAD,
    `id: ${DAEMON_SERVICE_ID}`,
    "name: ergo",
    "project: ergo",
    `root: ${yamlQuote(p.root)}`,
    "kind: managed",
    "probe:",
    "  tier: linked",
    `  port: ${port}`,
    "  health:",
    `    url: http://127.0.0.1:${port}/healthz`,
    "    timeoutMs: 3000",
    "capabilities: [start, stop, restart, health]",
    "link:",
    "  enabled: true",
    "hooks:",
    "  start:",
    `    argv: [${yamlQuote(p.node)}, ${yamlQuote(p.main)}]`,
    "    detaches: false",
    "    readyTimeoutMs: 90000",
    "  stop:",
    `    cmd: ${yamlQuote(`"${p.node}" ${p.stop}`)}`,
    "    detaches: false",
    "    timeoutMs: 30000",
    "env:",
    ...ownEnvLines(ctx),
    ...userEnv,
    "autoRestart:",
    "  enabled: true",
    "  maxRetries: 5",
    "  backoffMs: [5000, 15000, 60000]",
    ...userExposure,
    "profiles: [ergo]",
    "onboarding:",
    "  removedScheduledTasks: []",
    "",
  ].join("\n");
}

/** 服务管家的设置、开机自启名单不在时写默认的（在就绝不改）；二狗的登记按这次的安装重写（env 里用的人多加的项、用的人写的公网入口留着）。回各写了什么 */
export function writeSvcConfig(ctx: CliContext): { managerCreated: boolean; bootListCreated: boolean; entryChanged: boolean } {
  const p = svcPaths(ctx);
  fs.mkdirSync(p.services, { recursive: true });
  let managerCreated = false;
  if (!fs.existsSync(p.managerYaml)) {
    fs.writeFileSync(p.managerYaml, defaultManagerYaml(fallbackSvcPort(ctx.env)));
    managerCreated = true;
  }
  let bootListCreated = false;
  try {
    // wx：已经有了就写不进去。服务管家关掉所有开关时写的是 services: []，所以"有文件"就是用的人定过了
    fs.writeFileSync(p.bootList, defaultBootListYaml(), { flag: "wx" });
    bootListCreated = true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
  }
  let old = "";
  try {
    old = fs.readFileSync(p.daemonEntry, "utf8");
  } catch {
    // 还没登记过
  }
  const ownNames = new Set(ownEnvLines(ctx).flatMap((line) => /^ {2}- name: (\S+)$/.exec(line)?.[1] ?? []));
  const entry = daemonEntryYaml(ctx, userEnvLines(old, ownNames), userExposureLines(old));
  if (old !== entry) fs.writeFileSync(p.daemonEntry, entry);
  return { managerCreated, bootListCreated, entryChanged: old !== entry };
}

/** 服务管家的命令行（lsm.mjs） */
export function lsmScript(ctx: Pick<CliContext, "layout">): string {
  return path.join(ctx.layout.appDir, "packages", "supervisor", "bin", "lsm.mjs");
}

function lsmEnv(ctx: CliContext): NodeJS.ProcessEnv {
  return { ...ctx.env, LSM_DATA_DIR: ctx.svcDataDir };
}

/** 跑一条 lsm 命令：capture 时收输出，不然直接打到终端。ergo 起 lsm 只有这一个入口，动计划任务的两条命令先过 autostart.ts 那一关 */
export function runLsm(ctx: CliContext, args: readonly string[], options: { capture?: boolean } = {}): { code: number; stdout: string; stderr: string } {
  const intercepted = interceptTaskCommand(ctx.env, args, { node: ctx.layout.node, script: lsmScript(ctx), dataDir: ctx.svcDataDir });
  if (intercepted) {
    if (!options.capture && intercepted.stdout) ctx.io.out(intercepted.stdout);
    if (!options.capture && intercepted.stderr) ctx.io.err(intercepted.stderr);
    return intercepted;
  }
  const r = spawnSync(ctx.layout.node, [lsmScript(ctx), ...args], {
    env: lsmEnv(ctx),
    encoding: "utf8",
    windowsHide: true,
    stdio: options.capture ? ["ignore", "pipe", "pipe"] : "inherit",
    maxBuffer: 64 * 1024 * 1024,
  });
  return { code: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

/** 服务管家在不在跑（它的接口回不回话；它刚起来、正在巡检时可能慢一两秒，没回话再问一次） */
export async function managerUp(ctx: CliContext, timeoutMs = 4000, tries = 2): Promise<boolean> {
  const { bind, port } = managerAddress(ctx);
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(`http://${bind}:${port}/api/auth/status`, { signal: AbortSignal.timeout(timeoutMs) });
      if (r.ok) return true;
    } catch (err) {
      // 连不上（没人听）就是没在跑，不用再问
      if ((err as { cause?: { code?: string } }).cause?.code === "ECONNREFUSED") return false;
    }
  }
  return false;
}

/** 账本里记的服务管家的 pid（它抢到端口后才写） */
export function managerPidFromState(ctx: CliContext): number | undefined {
  try {
    const st = JSON.parse(fs.readFileSync(svcPaths(ctx).state, "utf8")) as { manager?: { pid?: unknown } };
    return typeof st.manager?.pid === "number" ? st.manager.pid : undefined;
  } catch {
    return undefined;
  }
}

/**
 * 在跑的服务管家是在最近一次切版本之前起的（账本里记的起来的时间早于 current 那一行最后一次写的时间）：它跑的还是切之前那个版本的程序。
 * 谁切的都算（ergo update / rollback、重新跑安装脚本、没有这一条的旧版本的 ergo update），所以用 current 的修改时间，不另记一份
 */
export function managerOlderThanCurrent(ctx: CliContext): boolean {
  const { root } = ctx.layout;
  if (ctx.layout.kind !== "installed" || !root) return false;
  let startedAt: unknown;
  try {
    startedAt = (JSON.parse(fs.readFileSync(svcPaths(ctx).state, "utf8")) as { manager?: { startedAt?: unknown } }).manager?.startedAt;
  } catch {
    return false;
  }
  if (typeof startedAt !== "number") return false;
  try {
    // lstat：老安装的 current 是目录联接，看联接自己的时间
    return startedAt < fs.lstatSync(installPaths(root).current).mtimeMs;
  } catch {
    return false;
  }
}

/** 在跑的服务管家是 ergo 起的（install.json 记的 managerPid 和账本里的对得上）；只有装好的才记 */
export function managerStartedByErgo(ctx: CliContext): boolean {
  const { root } = ctx.layout;
  if (ctx.layout.kind !== "installed" || !root) return false;
  const pid = readInstallState(root).managerPid;
  return pid !== undefined && pid === managerPidFromState(ctx);
}

/**
 * 开机自启的任务正在跑一个服务管家，而且就是 ctx 用的这一个：任务归这个安装（指着安装目录里的某个版本）、状态是 Running、
 * 数据目录是这一份（--data-dir，没写是服务管家的默认位置）。调的人先确认服务管家在跑、不是 ergo 起的。
 * 任务指着安装目录以外（用的人自己的服务管家，比如开发机上那个）一律不算，不会被重起
 */
export function managerUnderTask(ctx: CliContext, task: AutostartTaskInfo | null | undefined): boolean {
  const { root } = ctx.layout;
  if (ctx.layout.kind !== "installed" || !root || !task || task.state !== "Running") return false;
  if (!taskInsideRoot(task.action, root)) return false;
  return sameDir(taskDataDir(task.action) ?? defaultSvcDataDir(ctx.env), ctx.svcDataDir);
}

async function waitManager(ctx: CliContext, up: boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if ((await managerUp(ctx, 800, 1)) === up) return true;
    if (Date.now() >= deadline) return false;
    await sleep(300);
  }
}

export type TaskRestart = "task" | "direct" | "failed";

/**
 * 开机自启的任务起的服务管家换成 ctx 这个版本（任务已经改指它了）：
 *   停任务（结束任务的 conhost，服务管家的 --lifeline 让它跟着退）→ 等端口空出来（等不到就结束账本里记的那个进程）→ 起任务 → 等它回话。
 * 托管的服务是各自的进程，不跟着停；新起的服务管家和上一个在同一个登录会话里，bootPlan 按"不是开机"处理，把在跑的服务认回来，不按开机名单重拉。
 * 旧版本目录因此不再被占着（程序、工作目录都在里面），下一次清理删得掉。
 * 任务起不来（不让起、起了没回话）就由 ergo 直接起（回 direct：这次是 ergo 起的那个，下次登录照旧归任务）；旧的停不下来回 failed，照旧跑着
 */
export async function restartManagerViaTask(ctx: CliContext, waits: { stopMs?: number; startMs?: number } = {}): Promise<TaskRestart> {
  const version = ctx.layout.info?.version ?? path.basename(ctx.layout.home);
  ctx.io.out(t("cli.autostart.restartingManager", { version }));
  const stop = runTaskOp(ctx.env, "stop");
  // 停任务没成也往下走：结束账本里记的那个服务管家，任务的 conhost 跟着它退
  if (!(await waitManager(ctx, false, waits.stopMs ?? 10_000)) && !(await stopManager(ctx))) {
    ctx.io.err(t("cli.autostart.managerStuck", { detail: stop.code === 0 ? "-" : stop.stderr.trim() || String(stop.code) }));
    return "failed";
  }
  const start = runTaskOp(ctx.env, "start");
  if (start.code === 0 && (await waitManager(ctx, true, waits.startMs ?? 45_000))) {
    ctx.io.out(t("cli.autostart.managerRestarted", { version }));
    return "task";
  }
  ctx.io.err(t("cli.autostart.managerTaskFailed", { detail: start.code === 0 ? t("cli.autostart.noAnswer") : start.stderr.trim() || String(start.code) }));
  try {
    await startManager(ctx);
    return "direct";
  } catch (err) {
    ctx.io.err(err instanceof Error ? err.message : String(err));
    return "failed";
  }
}

/** Windows 命令行里一个参数的写法（CommandLineToArgvW 的规矩） */
export function quoteArg(arg: string): string {
  if (arg !== "" && !/[\s"]/.test(arg)) return arg;
  return `"${arg.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, "$1$1")}"`;
}

/**
 * 起一个和这条命令断开的常驻进程（隐藏的窗口），回 pid。经 PowerShell 的 Start-Process（ShellExecute）起：
 * Node 自己的 spawn 会把可继承的句柄（比如调用方接在 ergo 的输出上的管道）一并传给它，常驻进程不退，调用方就一直等不到输出结束
 */
export function spawnDetachedHidden(file: string, args: readonly string[], cwd: string, env: NodeJS.ProcessEnv): number {
  const lit = (s: string) => `'${s.replace(/'/g, "''")}'`;
  const script = `$p = Start-Process -FilePath ${lit(file)} -ArgumentList ${lit(args.map(quoteArg).join(" "))} -WorkingDirectory ${lit(cwd)} -WindowStyle Hidden -PassThru; [Console]::Out.Write($p.Id)`;
  const r = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { env, encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  const pid = Number(r.stdout.trim());
  if (r.status !== 0 || !Number.isInteger(pid) || pid <= 0) throw new Error(`Start-Process ${file}: ${r.stderr.trim() || r.status}`);
  return pid;
}

/** 起服务管家（单独的小进程，不跟着这个命令退出），等它回话；回 pid */
export async function startManager(ctx: CliContext, timeoutMs = 45_000): Promise<number> {
  const pid = spawnDetachedHidden(ctx.layout.node, [lsmScript(ctx), "serve", "--quiet", "--data-dir", ctx.svcDataDir], path.dirname(path.dirname(lsmScript(ctx))), lsmEnv(ctx));
  if (ctx.layout.kind === "installed" && ctx.layout.root) writeInstallState(ctx.layout.root, { ...readInstallState(ctx.layout.root), managerPid: pid });
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await managerUp(ctx)) return pid;
    await sleep(500);
  }
  throw new Error(t("cli.svc.managerNoAnswer", { port: managerAddress(ctx).port, log: path.join(ctx.svcDataDir, "logs", "manager.log") }));
}

/** 停服务管家（它托管的服务是单独的进程，不跟着停）：结束账本里记的那个进程，等端口没人回话 */
export async function stopManager(ctx: CliContext, timeoutMs = 15_000): Promise<boolean> {
  if (!(await managerUp(ctx))) return true;
  const pid = managerPidFromState(ctx);
  if (pid === undefined) return false;
  try {
    process.kill(pid);
  } catch {
    // 已经没了
  }
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!(await managerUp(ctx, 800, 1))) return true;
    await sleep(300);
  }
  return false;
}

/** 服务管家里一个服务现在的样子（lsm status --json 里的一项，只取用到的） */
export interface ServiceSnapshot {
  id: string;
  state: string;
  tier?: string;
  pid?: number;
  port?: number;
  busy?: boolean;
  busyReason?: string;
  lastError?: string;
  runningSince?: number;
}

export interface SvcSnapshot {
  services: ServiceSnapshot[];
}

/** 服务管家的状态（管理器不在时 lsm 本地直连探一遍） */
export function svcSnapshot(ctx: CliContext): SvcSnapshot | undefined {
  const r = runLsm(ctx, ["status", "--json"], { capture: true });
  if (r.code !== 0) return undefined;
  try {
    return JSON.parse(r.stdout) as SvcSnapshot;
  } catch {
    return undefined;
  }
}

export function daemonSnapshot(ctx: CliContext): ServiceSnapshot | undefined {
  const s = svcSnapshot(ctx)?.services.find((x) => x.id === DAEMON_SERVICE_ID);
  if (!s) return undefined;
  const { id, state, tier, pid, port, busy, busyReason, lastError, runningSince } = s;
  return { id, state, ...(tier ? { tier } : {}), ...(pid ? { pid } : {}), ...(port ? { port } : {}), ...(busy ? { busy, ...(busyReason ? { busyReason } : {}) } : {}), ...(lastError ? { lastError } : {}), ...(runningSince ? { runningSince } : {}) };
}

const RUNNING = new Set(["RUNNING", "DEGRADED", "STARTING"]);

export function isRunning(s: ServiceSnapshot | undefined): boolean {
  return s !== undefined && RUNNING.has(s.state);
}

export type AutostartSync = "not-installed" | "no-task" | "elsewhere" | "current" | "moved" | "failed";

/**
 * 切版本后开机还能起来（新版本在新目录，任务里写死的是当时的 node 和程序路径）：
 * 任务指着这个安装目录里的别的版本，就用 ctx 这个版本重新注册一次。只有装好的才管，别的不动：
 *   - 源码跑的、npm 装的：任务不归这个安装管；
 *   - 没有任务：用的人撤掉了（或者查不了），不新建；
 *   - 指着安装目录以外：用的人自己装的服务管家，和卸载时一样不碰。
 * 重新注册失败只说一句，不耽误这次启动。known 是调的人刚读过的任务（省一次 PowerShell），没给就自己读。
 */
export function syncAutostart(ctx: CliContext, known?: { task: AutostartTaskInfo | null | undefined }): AutostartSync {
  const { layout } = ctx;
  if (layout.kind !== "installed" || !layout.root) return "not-installed";
  const action = (known ? known.task : readAutostartTaskInfo(ctx.env))?.action;
  if (!action) return "no-task";
  if (!taskInsideRoot(action, layout.root)) return "elsewhere";
  if (taskRunsScript(action, lsmScript(ctx))) return "current";
  const r = runLsm(ctx, ["install-autostart"], { capture: true });
  if (r.code !== 0) {
    ctx.io.err(t("cli.autostart.moveFailed", { detail: `${r.stdout}${r.stderr}`.trim() || "?" }));
    return "failed";
  }
  ctx.io.out(t("cli.autostart.moved", { version: layout.info?.version ?? path.basename(layout.home) }));
  return "moved";
}

/** 这次第一次写开机自启名单：告诉用的人一声，怎么关 */
export function tellBootListCreated(ctx: CliContext): void {
  ctx.io.out(t("cli.svc.bootListCreated", { file: svcPaths(ctx).bootList, id: DAEMON_SERVICE_ID }));
}

/**
 * 服务管家在跑、二狗的登记是最新的：管理器不在就起来，在就让它重读登记（注册表）。
 * 在跑的服务管家是开机自启的任务起的、跑的又是别的版本的程序——任务这次才被改指在用的版本，或者它是上一次切版本之前起的
 * （从没有这一条的旧版本升上来时，跑 update 的是旧的 ergo，不会重起它）——就经任务把它重起成在用的版本，和切版本时一样
 */
export async function ensureSvc(ctx: CliContext): Promise<{ startedManager: boolean }> {
  const { managerCreated, bootListCreated } = writeSvcConfig(ctx);
  if (managerCreated) ctx.io.out(t("cli.svc.managerConfigCreated", { file: svcPaths(ctx).managerYaml, port: managerAddress(ctx).port }));
  if (bootListCreated) tellBootListCreated(ctx);
  const installed = ctx.layout.kind === "installed" && !!ctx.layout.root;
  const task = installed ? readAutostartTaskInfo(ctx.env) : undefined;
  const up = await managerUp(ctx);
  // 在改指任务之前看：真的计划任务重新注册时会不会结束正在跑的实例没核实过，结束了的话之后就看不出它是任务起的了
  const underTask = up && !managerStartedByErgo(ctx) && managerUnderTask(ctx, task);
  const sync = syncAutostart(ctx, { task });
  const stale = sync === "moved" || (sync === "current" && managerOlderThanCurrent(ctx));
  if (up && underTask && stale && (await restartManagerViaTask(ctx)) !== "failed") return { startedManager: false };
  if (up) {
    // 每次都让它重读，不看这次写没写：用的人手加的 env 项和我们写出来的一字不差时文件不算变了，管理器不重读就拿不到。重读不动在跑的服务
    runLsm(ctx, ["reload"], { capture: true });
    return { startedManager: false };
  }
  ctx.io.out(t("cli.svc.startingManager", { port: managerAddress(ctx).port }));
  await startManager(ctx);
  return { startedManager: true };
}

/** 等二狗变成某种状态（每 interval 看一次） */
export async function waitForDaemon(ctx: CliContext, ok: (s: ServiceSnapshot | undefined) => boolean, timeoutMs: number, onWait?: (s: ServiceSnapshot | undefined) => void): Promise<ServiceSnapshot | undefined> {
  const deadline = Date.now() + timeoutMs;
  let last: ServiceSnapshot | undefined;
  let lastNote = Date.now();
  while (Date.now() < deadline) {
    last = daemonSnapshot(ctx);
    if (ok(last)) return last;
    if (onWait && Date.now() - lastNote > 30_000) {
      onWait(last);
      lastNote = Date.now();
    }
    await sleep(1000);
  }
  return undefined;
}

export async function cmdStart(ctx: CliContext): Promise<number> {
  await ensureSvc(ctx);
  ctx.io.out(t("cli.start.starting"));
  const r = runLsm(ctx, ["start", DAEMON_SERVICE_ID], { capture: true });
  const snap = daemonSnapshot(ctx);
  if (r.code !== 0 || !isRunning(snap)) {
    ctx.io.err(t("cli.start.failed", { detail: (snap?.lastError ?? `${r.stdout}${r.stderr}`).trim() || "?" }));
    ctx.io.err(t("cli.start.seeLogs"));
    return 1;
  }
  ctx.io.out(t("cli.start.done", { url: daemonUrl(ctx) }));
  return 0;
}

/** ergo onboard：把二狗起来，告诉用的人去网页走设置向导（向导只做网页，没有终端版） */
export async function cmdOnboard(ctx: CliContext): Promise<number> {
  const code = await cmdStart(ctx);
  if (code === 0) ctx.io.out(t("cli.onboard.openWizard", { url: daemonUrl(ctx) }));
  return code;
}

export async function cmdStop(ctx: CliContext): Promise<number> {
  if (!(await managerUp(ctx))) {
    ctx.io.out(t("cli.stop.managerDown"));
    return 0;
  }
  const r = runLsm(ctx, ["stop", DAEMON_SERVICE_ID], { capture: true });
  if (r.code !== 0) {
    ctx.io.err(t("cli.stop.failed", { detail: `${r.stdout}${r.stderr}`.trim() }));
    return 1;
  }
  ctx.io.out(t("cli.stop.done"));
  return 0;
}

export async function cmdRestart(ctx: CliContext): Promise<number> {
  await ensureSvc(ctx);
  ctx.io.out(t("cli.restart.restarting"));
  const r = runLsm(ctx, ["restart", DAEMON_SERVICE_ID], { capture: true });
  const snap = await waitForDaemon(ctx, isRunning, 90_000);
  if (r.code !== 0 || !snap) {
    ctx.io.err(t("cli.start.failed", { detail: `${r.stdout}${r.stderr}`.trim() || "?" }));
    return 1;
  }
  ctx.io.out(t("cli.start.done", { url: daemonUrl(ctx) }));
  return 0;
}

export interface StatusView {
  version?: string;
  install: { kind: string; root?: string; home: string; node: string };
  dataDir: string;
  svcDataDir: string;
  manager: { up: boolean; port: number };
  daemon?: ServiceSnapshot;
  url: string;
}

export async function statusView(ctx: CliContext): Promise<StatusView> {
  const up = await managerUp(ctx);
  const { layout } = ctx;
  return {
    ...(layout.info ? { version: layout.info.version } : {}),
    install: { kind: layout.info?.kind ?? layout.kind, ...(layout.root ? { root: layout.root } : {}), home: layout.home, node: layout.node },
    dataDir: ctx.dataDir,
    svcDataDir: ctx.svcDataDir,
    manager: { up, port: managerAddress(ctx).port },
    ...(up ? { daemon: daemonSnapshot(ctx) } : {}),
    url: daemonUrl(ctx),
  };
}

export async function cmdStatus(ctx: CliContext, json: boolean): Promise<number> {
  const v = await statusView(ctx);
  if (json) {
    ctx.io.out(JSON.stringify(v, null, 2));
    return 0;
  }
  ctx.io.out(t("cli.status.version", { version: v.version ?? t("cli.status.dev"), kind: t(`cli.kind.${v.install.kind}`) }));
  ctx.io.out(t("cli.status.installedAt", { dir: v.install.root ?? v.install.home }));
  ctx.io.out(t("cli.status.dataDir", { dir: v.dataDir }));
  ctx.io.out(v.manager.up ? t("cli.status.managerUp", { port: v.manager.port }) : t("cli.status.managerDown"));
  if (v.manager.up) {
    const d = v.daemon;
    if (!d) ctx.io.out(t("cli.status.daemonUnregistered"));
    else if (isRunning(d)) ctx.io.out(t("cli.status.daemonRunning", { state: d.state, url: v.url, pid: d.pid ?? "?" }) + (d.busy ? t("cli.status.busy", { reason: d.busyReason ?? "" }) : ""));
    else ctx.io.out(t("cli.status.daemonStopped", { state: d.state }) + (d.lastError ? ` — ${d.lastError}` : ""));
  }
  return 0;
}

/** 日志：服务管家记的二狗的命令行输出（最后 n 行；follow 时接着看新写的，Ctrl+C 退出） */
export async function cmdLogs(ctx: CliContext, lines: number, follow: boolean, signal?: AbortSignal): Promise<number> {
  const file = svcPaths(ctx).daemonLog;
  if (!fs.existsSync(file)) {
    ctx.io.out(t("cli.logs.none", { file }));
    return follow ? 0 : 1;
  }
  const text = fs.readFileSync(file, "utf8");
  const all = text.split(/\r?\n/);
  if (all[all.length - 1] === "") all.pop();
  for (const line of all.slice(-lines)) ctx.io.out(line);
  if (!follow) return 0;
  let offset = Buffer.byteLength(text, "utf8");
  while (!signal?.aborted) {
    await sleep(1000, undefined, { signal }).catch(() => {});
    let size = 0;
    try {
      size = fs.statSync(file).size;
    } catch {
      continue;
    }
    if (size < offset) offset = 0;
    if (size > offset) {
      const fd = fs.openSync(file, "r");
      const buf = Buffer.alloc(size - offset);
      fs.readSync(fd, buf, 0, buf.length, offset);
      fs.closeSync(fd);
      offset = size;
      for (const line of buf.toString("utf8").split(/\r?\n/).filter((l) => l !== "")) ctx.io.out(line);
    }
  }
  return 0;
}

/** 用浏览器打开二狗的网页（print 只打印地址） */
export function cmdOpen(ctx: CliContext, print: boolean): number {
  const url = daemonUrl(ctx);
  if (print) {
    ctx.io.out(url);
    return 0;
  }
  // 用 Windows 的默认浏览器打开（不经 cmd 的 start，地址里的 & 不会被拆开）
  const child = spawn("rundll32.exe", ["url.dll,FileProtocolHandler", url], { detached: true, stdio: "ignore", windowsHide: true });
  child.unref();
  ctx.io.out(t("cli.open.opened", { url }));
  return 0;
}

/** ergo svc <命令…>：原样转给服务管家（lsm），退出码照它的 */
export function cmdSvc(ctx: CliContext, args: readonly string[]): number {
  return runLsm(ctx, args).code;
}
