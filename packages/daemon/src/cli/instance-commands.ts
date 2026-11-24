// 多份二狗的三条命令（468，认法和登记 id 的规则见 instances.ts）：
//   ergo init [--name <名字>] [--port <本机端口>]   把一个空文件夹变成新的一份：挑端口、写配置和标记文件、建数据目录骨架、在服务管家里登记、
//                                                  加进开机自启名单；不启动，打出网页地址，下一步 ergo onboard
//   ergo list [--json]                             这台电脑上的各份：默认那份 + 服务管家里登记的（以服务管家的登记为准）
//   ergo unregister                                停掉这一份、从服务管家里拿掉（登记、开机自启名单）；文件夹和数据原样留着
// 场景（profiles）的 ergo：登记里自带 profiles: [ergo]，服务管家算场景成员时把它和 manager.yaml 里列的合在一起，所以不改 manager.yaml；
// 拿掉登记它也跟着出了场景。
import fs from "node:fs";
import path from "node:path";
import { t } from "@ergo/protocol";
import { prepareDataDir } from "../config/config.ts";
import { dataDirLayout, resolveDataDir } from "../config/data-dir.ts";
import { comparable, isWithin } from "../guard/paths.ts";
import { type CliContext, contextForInstance, daemonUrl } from "./context.ts";
import {
  DEFAULT_SERVICE_ID,
  findMarkerDir,
  INSTANCE_MARKER,
  INSTANCE_NAME_MAX,
  instancePorts,
  nameProblem,
  pickPorts,
  portBusy,
  readMarker,
  registeredInstances,
  registeredPorts,
  serviceIdOf,
  writeMarker,
} from "./instances.ts";
import { addToBootList, isRunning, managerAddress, managerUp, runLsm, svcPaths, svcSnapshot, writeSvcConfig } from "./service.ts";

export interface InitOptions {
  /** --dir 给的文件夹（没给是当前文件夹） */
  dir?: string;
  name?: string;
  port?: string;
}

/** 默认那份的数据目录：服务管家里 ergo-daemon 登记的，没登记是 ~/.ergo */
export function defaultInstanceDir(ctx: Pick<CliContext, "svcDataDir" | "homeDir">): string {
  return registeredInstances(ctx.svcDataDir).find((i) => i.id === DEFAULT_SERVICE_ID)?.dataDir ?? resolveDataDir({}, ctx.homeDir);
}

/** 这个文件夹是默认那份的数据目录：~/.ergo、环境变量 ERGO_DATA_DIR 的、服务管家里 ergo-daemon 登记的 */
export function isDefaultDataDir(ctx: Pick<CliContext, "svcDataDir" | "homeDir" | "env">, dir: string): boolean {
  const candidates = [resolveDataDir({}, ctx.homeDir), resolveDataDir(ctx.env, ctx.homeDir), defaultInstanceDir(ctx)];
  return candidates.some((d) => comparable(d) === comparable(dir));
}

/** 新的一份不能用的端口：服务管家登记里已占的、管理器的、各份（含默认那份）配置里的 */
function takenPorts(ctx: CliContext): Set<number> {
  const taken = new Set<number>(registeredPorts(ctx.svcDataDir));
  taken.add(managerAddress(ctx).port);
  const dirs = [defaultInstanceDir(ctx), ...registeredInstances(ctx.svcDataDir).flatMap((i) => (i.dataDir ? [i.dataDir] : []))];
  for (const dir of dirs) {
    const ports = instancePorts(dir);
    taken.add(ports.local);
    taken.add(ports.external);
  }
  return taken;
}

/** 名字：--name，没给取文件夹名（大写字母换成小写）；不合规时有终端就问一句，没终端要 --name */
async function pickName(ctx: CliContext, folder: string, flag: string | undefined): Promise<string | undefined> {
  const bad = (name: string, problem: string) => {
    ctx.io.err(t(`cli.init.name.${problem}`, { name, max: INSTANCE_NAME_MAX }));
    return undefined;
  };
  if (flag !== undefined) {
    const problem = nameProblem(flag);
    return problem === undefined ? flag : bad(flag, problem);
  }
  const fromFolder = path.basename(folder).toLowerCase();
  if (nameProblem(fromFolder) === undefined) return fromFolder;
  const answer = (await ctx.io.ask(t("cli.init.askName", { folder: path.basename(folder), max: INSTANCE_NAME_MAX }))).trim();
  if (answer === "") {
    ctx.io.err(t("cli.init.needName", { folder: path.basename(folder) }));
    return undefined;
  }
  const problem = nameProblem(answer);
  return problem === undefined ? answer : bad(answer, problem);
}

/** 不能在这里建：在别的一份的文件夹里、在服务管家或程序的目录里。能建是 undefined */
function placeProblem(ctx: CliContext, target: string): string | undefined {
  const parent = path.dirname(target);
  const marked = parent === target ? undefined : findMarkerDir(parent);
  if (marked !== undefined) return t("cli.init.insideInstance", { dir: marked });
  const instances = [defaultInstanceDir(ctx), ...registeredInstances(ctx.svcDataDir).flatMap((i) => (i.dataDir ? [i.dataDir] : []))];
  const inside = instances.find((dir) => isWithin(target, dir) || isWithin(dir, target));
  if (inside !== undefined) return t("cli.init.insideInstance", { dir: inside });
  for (const dir of [ctx.svcDataDir, ctx.installRoot]) if (isWithin(target, dir) || isWithin(dir, target)) return t("cli.init.insideProgram", { dir });
  return undefined;
}

/** ergo init：把一个空文件夹变成新的一份二狗 */
export async function cmdInit(ctx: CliContext, options: InitOptions): Promise<number> {
  const target = path.resolve(ctx.cwd, options.dir ?? ".");
  if (fs.existsSync(target) && !fs.statSync(target).isDirectory()) {
    ctx.io.err(t("cli.init.notFolder", { dir: target }));
    return 1;
  }
  if (fs.existsSync(path.join(target, INSTANCE_MARKER))) {
    ctx.io.err(t("cli.init.already", { dir: target }));
    return 1;
  }
  if (fs.existsSync(target) && fs.readdirSync(target).length > 0) {
    ctx.io.err(t("cli.init.notEmpty", { dir: target }));
    return 1;
  }
  const place = placeProblem(ctx, target);
  if (place !== undefined) {
    ctx.io.err(place);
    return 1;
  }
  const name = await pickName(ctx, target, options.name);
  if (name === undefined) return 2;
  const serviceId = serviceIdOf(name);
  // 和服务管家里已有的登记重名（文件名、登记里的 id 都看，不分大小写）
  const services = svcPaths(ctx).services;
  const clash = (() => {
    try {
      return fs.readdirSync(services).some((file) => {
        if (!file.toLowerCase().endsWith(".yaml")) return false;
        if (file.slice(0, -".yaml".length).toLowerCase() === serviceId) return true;
        const id = /^id:\s*['"]?([^'"\s#]+)/m.exec(fs.readFileSync(path.join(services, file), "utf8"))?.[1];
        return id?.toLowerCase() === serviceId;
      });
    } catch {
      return false;
    }
  })();
  if (clash) {
    ctx.io.err(t("cli.init.taken", { name, id: serviceId }));
    return 1;
  }
  // 端口：--port 给了本机端口时外网用 +1，被占了就不建；没给自动挑
  const taken = takenPorts(ctx);
  let ports: { local: number; external: number } | undefined;
  if (options.port !== undefined) {
    const local = Number(options.port);
    if (!Number.isInteger(local) || local < 1024 || local > 65534) {
      ctx.io.err(t("cli.init.badPort", { port: options.port }));
      return 2;
    }
    const busy = [local, local + 1].filter((p) => taken.has(p));
    for (const p of [local, local + 1]) if (!busy.includes(p) && (await portBusy(p))) busy.push(p);
    if (busy.length > 0) {
      ctx.io.err(t("cli.init.portTaken", { ports: busy.join(", ") }));
      return 1;
    }
    ports = { local, external: local + 1 };
  } else {
    ports = await pickPorts(taken);
    if (ports === undefined) {
      ctx.io.err(t("cli.init.noPorts"));
      return 1;
    }
  }

  // 写：配置（端口）→ 数据目录骨架（和守护进程第一次起来时建的同一套）→ 标记文件 → 登记。
  // 登记没成时这个文件夹已经是一份了，在里面 ergo start 就会重新登记
  const layout = dataDirLayout(target);
  fs.mkdirSync(layout.config, { recursive: true });
  fs.writeFileSync(layout.configFile, `${JSON.stringify({ ports }, null, 2)}\n`);
  prepareDataDir(layout);
  writeMarker(target, name);
  const instance = contextForInstance(ctx, { dir: target });
  ctx.io.out(t("cli.init.created", { name, dir: target, id: serviceId, local: ports.local, external: ports.external }));
  writeSvcConfig(instance);
  if (await managerUp(instance)) runLsm(instance, ["reload"], { capture: true });
  if (addToBootList(instance)) ctx.io.out(t("cli.init.registered", { id: serviceId }));
  ctx.io.out(t("cli.init.done", { url: daemonUrl(instance), dir: target }));
  return 0;
}

/** ergo list 的一行 */
export interface InstanceRow {
  id: string;
  name?: string;
  dataDir: string;
  url: string;
  /** 服务管家里的状态（没登记是 undefined） */
  state?: string;
  running: boolean;
  autostart: boolean;
  registered: boolean;
  /** 就是这条命令认的那一份 */
  current: boolean;
}

export function instanceRows(ctx: CliContext): InstanceRow[] {
  const registered = registeredInstances(ctx.svcDataDir);
  const snapshot = registered.length > 0 ? svcSnapshot(ctx) : undefined;
  const byId = new Map((snapshot?.services ?? []).map((s) => [s.id, s as typeof s & { autostart?: boolean }]));
  const rows: InstanceRow[] = [];
  const row = (id: string, dataDir: string, isRegistered: boolean): InstanceRow => {
    const s = byId.get(id);
    let name: string | undefined;
    try {
      name = readMarker(dataDir)?.name;
    } catch {
      name = undefined;
    }
    return {
      id,
      ...(name === undefined ? {} : { name }),
      dataDir,
      url: `http://127.0.0.1:${instancePorts(dataDir).local}/`,
      ...(s ? { state: s.state } : {}),
      running: isRunning(s),
      autostart: s?.autostart === true,
      registered: isRegistered,
      current: ctx.serviceId === id && comparable(ctx.dataDir) === comparable(dataDir),
    };
  };
  // 默认那份：登记了、或者它的数据目录在，才列
  const def = registered.find((i) => i.id === DEFAULT_SERVICE_ID);
  const defDir = def?.dataDir ?? resolveDataDir({}, ctx.homeDir);
  if (def || fs.existsSync(defDir)) rows.push(row(DEFAULT_SERVICE_ID, defDir, def !== undefined));
  for (const i of registered) if (i.id !== DEFAULT_SERVICE_ID && i.dataDir) rows.push(row(i.id, i.dataDir, true));
  // 这条命令认的那一份有标记、却没登记（unregister 过）：也列上
  if (ctx.serviceId !== DEFAULT_SERVICE_ID && !rows.some((r) => r.id === ctx.serviceId)) rows.push(row(ctx.serviceId, ctx.dataDir, false));
  return rows;
}

/** ergo list：这台电脑上的各份二狗 */
export function cmdList(ctx: CliContext, json: boolean): number {
  const rows = instanceRows(ctx);
  if (json) {
    ctx.io.out(JSON.stringify(rows, null, 2));
    return 0;
  }
  if (rows.length === 0) {
    ctx.io.out(t("cli.list.none"));
    return 0;
  }
  for (const r of rows) {
    const name = r.id === DEFAULT_SERVICE_ID ? t("cli.list.defaultName") : (r.name ?? r.id);
    const state = !r.registered ? t("cli.list.unregistered") : r.running ? t("cli.list.running") : t("cli.list.stopped", { state: r.state ?? "-" });
    ctx.io.out(
      t("cli.list.row", { mark: r.current ? "*" : " ", name, id: r.id, state, url: r.url, dir: r.dataDir, autostart: r.autostart ? t("cli.list.autostart") : "" }),
    );
  }
  if (rows.some((r) => r.current)) ctx.io.out(t("cli.list.currentNote"));
  return 0;
}

/** ergo unregister：停掉这一份、从服务管家里拿掉；文件夹和数据原样留着 */
export async function cmdUnregister(ctx: CliContext): Promise<number> {
  if (ctx.serviceId === DEFAULT_SERVICE_ID) {
    ctx.io.err(t("cli.unregister.default"));
    return 1;
  }
  const entry = svcPaths(ctx).daemonEntry;
  if (!fs.existsSync(entry)) {
    ctx.io.out(t("cli.unregister.notRegistered", { name: ctx.instanceName ?? ctx.serviceId, dir: ctx.dataDir }));
    return 0;
  }
  // 先停（服务管家不在跑时 lsm 本地直连停）；停不下来就不拿掉登记，免得留下没人管的进程
  const stop = runLsm(ctx, ["stop", ctx.serviceId], { capture: true });
  if (stop.code !== 0) {
    ctx.io.err(t("cli.unregister.stopFailed", { detail: `${stop.stdout}${stop.stderr}`.trim() || String(stop.code) }));
    return 1;
  }
  ctx.io.out(t("cli.unregister.stopped", { id: ctx.serviceId }));
  runLsm(ctx, ["autostart", ctx.serviceId, "off"], { capture: true });
  fs.rmSync(entry, { force: true });
  if (await managerUp(ctx)) runLsm(ctx, ["reload"], { capture: true });
  // 它名下的服务（项目上线的、组件装的）照旧在服务管家里：说一声
  const ownedDir = path.join(svcPaths(ctx).services, "owned", ctx.serviceId);
  const owned = fs.existsSync(ownedDir) ? fs.readdirSync(ownedDir).filter((f) => f.toLowerCase().endsWith(".yaml")) : [];
  if (owned.length > 0) ctx.io.out(t("cli.unregister.owned", { list: owned.map((f) => `${ctx.serviceId}--${f.slice(0, -".yaml".length)}`).join(", ") }));
  ctx.io.out(t("cli.unregister.done", { id: ctx.serviceId, dir: ctx.dataDir }));
  return 0;
}
