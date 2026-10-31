// ergo 命令里管服务的那一半（318 号票）：包一层服务管家（packages/supervisor，命令 lsm），用的人不用学 lsm。
//   - 服务管家的设置（manager.yaml）不在时写一份默认的；二狗的登记（registry/services/ergo-daemon.yaml）每次 start 按这次的安装重写——
//     路径都走安装目录的 current（切版本只要重启，不用改登记），端口按二狗的配置（config/ergo.json 的 ports.local）；
//   - 服务管家没在跑就把它起来（单独的小进程，不跟着这个命令退出）；
//   - start / stop / restart / status / logs 交给服务管家；svc <命令…> 原样转给 lsm。
// 开机自启（服务管家的计划任务）由首次设置向导（319 号票的 ergo onboard）装，这里不装。
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { t } from "@ergo/protocol";
import { readInstallState, writeInstallState } from "../release/layout.ts";
import { type CliContext, daemonPort, daemonUrl } from "./context.ts";

/** 二狗在服务管家里登记的 id */
export const DAEMON_SERVICE_ID = "ergo-daemon";
/** 第一次生成服务管家设置时用的端口（环境变量 ERGO_SVC_PORT 可以换，测试用它避开本机正在用的） */
export const DEFAULT_SVC_PORT = 7420;

export interface SvcPaths {
  registry: string;
  services: string;
  managerYaml: string;
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

/** 二狗的登记（每次 start 重写）。DeepSeek 的 key 照旧由服务管家从数据目录的密钥区读出来注入（没有也能起来，optional） */
export function daemonEntryYaml(ctx: Pick<CliContext, "layout" | "dataDir">): string {
  const p = entryPaths(ctx);
  const port = daemonPort(ctx);
  return [
    "# ergo daemon entry: rewritten by every `ergo start` (change ports in the ergo config file config/ergo.json).",
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
    "  - name: ERGO_DATA_DIR",
    "    from: literal",
    `    value: ${yamlQuote(ctx.dataDir)}`,
    "  - name: DEEPSEEK_API_KEY",
    "    from: file",
    `    path: ${yamlQuote(path.join(ctx.dataDir, "secrets", "deepseek-api-key.txt"))}`,
    "    optional: true",
    // 自定义（OpenAI 兼容）服务商的 key（自定义服务商这一步）：和 DeepSeek 一样从密钥区注入（没有也能起来，optional）
    "  - name: CUSTOM_MODEL_API_KEY",
    "    from: file",
    `    path: ${yamlQuote(path.join(ctx.dataDir, "secrets", "custom-model-api-key.txt"))}`,
    "    optional: true",
    "autoRestart:",
    "  enabled: true",
    "  maxRetries: 5",
    "  backoffMs: [5000, 15000, 60000]",
    "profiles: [ergo]",
    "onboarding:",
    "  removedScheduledTasks: []",
    "",
  ].join("\n");
}

/** 服务管家的设置在不在、不在写默认的；二狗的登记按这次的安装重写。回登记变没变 */
export function writeSvcConfig(ctx: CliContext): { managerCreated: boolean; entryChanged: boolean } {
  const p = svcPaths(ctx);
  fs.mkdirSync(p.services, { recursive: true });
  let managerCreated = false;
  if (!fs.existsSync(p.managerYaml)) {
    fs.writeFileSync(p.managerYaml, defaultManagerYaml(fallbackSvcPort(ctx.env)));
    managerCreated = true;
  }
  const entry = daemonEntryYaml(ctx);
  let old = "";
  try {
    old = fs.readFileSync(p.daemonEntry, "utf8");
  } catch {
    // 还没登记过
  }
  if (old !== entry) fs.writeFileSync(p.daemonEntry, entry);
  return { managerCreated, entryChanged: old !== entry };
}

/** 服务管家的命令行（lsm.mjs） */
export function lsmScript(ctx: Pick<CliContext, "layout">): string {
  return path.join(ctx.layout.appDir, "packages", "supervisor", "bin", "lsm.mjs");
}

function lsmEnv(ctx: CliContext): NodeJS.ProcessEnv {
  return { ...ctx.env, LSM_DATA_DIR: ctx.svcDataDir };
}

/** 跑一条 lsm 命令：capture 时收输出，不然直接打到终端 */
export function runLsm(ctx: CliContext, args: readonly string[], options: { capture?: boolean } = {}): { code: number; stdout: string; stderr: string } {
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

/** 服务管家在跑、二狗的登记是最新的：管理器不在就起来，在就让它重读登记 */
export async function ensureSvc(ctx: CliContext): Promise<{ startedManager: boolean }> {
  const { managerCreated, entryChanged } = writeSvcConfig(ctx);
  if (managerCreated) ctx.io.out(t("cli.svc.managerConfigCreated", { file: svcPaths(ctx).managerYaml, port: managerAddress(ctx).port }));
  if (await managerUp(ctx)) {
    if (entryChanged) runLsm(ctx, ["reload"], { capture: true });
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
