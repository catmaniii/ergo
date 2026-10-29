// ergo update / rollback（318 号票）：新版本进新目录、二狗空闲时切，旧版本留一份（rollback 切回它）。
// 更新：查最新版本（GitHub / npmmirror 挑快的，或者 --from、ERGO_RELEASE_URL 给的地址）→ 下发布包（断了接着下）→ 发布公钥验校验值清单的签名、
//      发布包的 sha256 对上清单 → 解到 versions\<版本>\（先解到 .partial，完整了才改名）→ 切过去。
// 切过去：二狗在跑就请服务管家"等空闲再停"（有任务在执行、有有副作用的调用在跑时不停）→ 停了以后把 current 改指新版本 →
//        服务管家是 ergo 起的就重起它（它也换成新版本的代码；托管的服务是单独的进程，不受影响）→ 重写登记、把二狗起来。
//        最后只留在用的和上一个版本，别的删掉（正被占用删不掉的留着，下次再删）。
// 源码装的（install.ps1 -FromSource）：交给安装脚本拉新代码、构建进新的版本目录，再照上面切过去。开发模式（--link）、npm 装的给一句怎么更新。
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { t } from "@ergo/protocol";
import { fetchErrorText } from "./texts.ts";
import { type ReleaseIndex, orderSources, verifyRelease } from "../release/fetch.ts";
import {
  compareVersions,
  currentVersionName,
  installPaths,
  listVersions,
  pruneVersions,
  readInstallState,
  readVersionInfo,
  switchCurrent,
  writeInstallState,
} from "../release/layout.ts";
import { releasePublicKey } from "../release/public-key.ts";
import { extractZip } from "../release/zip.ts";
import { renameRetrying } from "../util/atomic-file.ts";
import type { CliContext } from "./context.ts";
import {
  DAEMON_SERVICE_ID,
  daemonSnapshot,
  isRunning,
  managerPidFromState,
  managerUp,
  runLsm,
  startManager,
  stopManager,
  waitForDaemon,
  writeSvcConfig,
} from "./service.ts";

export interface UpdateOptions {
  check: boolean;
  version?: string;
  from?: string;
  mirror?: "cn" | "github";
  allowUnsigned: boolean;
  /** 等二狗空闲最多多久（毫秒） */
  idleTimeoutMs: number;
}

/** 包管理器装的（Scoop、winget）：更新、卸载交给它们 */
export function packageManagerOf(home: string): "scoop" | "winget" | undefined {
  if (/[\\/]scoop[\\/]apps[\\/]/i.test(home)) return "scoop";
  if (/[\\/]Microsoft[\\/]WinGet[\\/]Packages[\\/]/i.test(home)) return "winget";
  return undefined;
}

function needInstalled(ctx: CliContext): string | undefined {
  const { layout } = ctx;
  const manager = packageManagerOf(layout.home);
  if (manager) {
    ctx.io.out(t(`cli.update.${manager}`));
    return undefined;
  }
  if (layout.kind === "npm") {
    ctx.io.out(t("cli.update.npm"));
    return undefined;
  }
  if (layout.kind !== "installed" || !layout.root) {
    ctx.io.out(t("cli.update.dev"));
    return undefined;
  }
  if (layout.info?.kind === "link") {
    ctx.io.out(t("cli.update.link"));
    return undefined;
  }
  return layout.root;
}

/**
 * 切到 versions\<target>：二狗在跑就等它空闲再停，切完重起服务管家（是 ergo 起的那个）和二狗。
 * 回 true 是切过去了
 */
export async function switchTo(ctx: CliContext, root: string, target: string, idleTimeoutMs: number): Promise<boolean> {
  const from = currentVersionName(root);
  const managerWasUp = await managerUp(ctx);
  const daemonWasRunning = managerWasUp && isRunning(daemonSnapshot(ctx));
  if (daemonWasRunning) {
    ctx.io.out(t("cli.switch.waitingIdle"));
    runLsm(ctx, ["stop", DAEMON_SERVICE_ID, "--when-idle"], { capture: true });
    const stopped = await waitForDaemon(ctx, (s) => s !== undefined && !isRunning(s) && s.state !== "STOPPING", idleTimeoutMs, (s) =>
      ctx.io.out(t("cli.switch.stillBusy", { reason: s?.busyReason ?? s?.state ?? "?" })),
    );
    if (!stopped) {
      runLsm(ctx, ["cancel-stop", DAEMON_SERVICE_ID], { capture: true });
      ctx.io.err(t("cli.switch.idleTimeout"));
      return false;
    }
  }
  // 服务管家：ergo 起的那个才重起（开机自启的计划任务起的，交给它自己的看门狗，见 dev.md）
  const state = readInstallState(root);
  const ours = managerWasUp && state.managerPid !== undefined && state.managerPid === managerPidFromState(ctx);
  if (ours) await stopManager(ctx);
  // 切不过去（目录联接建不了这类）：在用的版本不变，下面照原样把服务管家和二狗起来
  let switched = false;
  try {
    switchCurrent(root, target);
    switched = true;
    writeInstallState(root, { ...readInstallState(root), ...(from && from !== target ? { previous: from } : {}) });
    ctx.io.out(t("cli.switch.switched", { from: from ?? "-", to: target }));
  } catch (err) {
    ctx.io.err(t("cli.switch.failed", { detail: err instanceof Error ? err.message : String(err) }));
  }
  writeSvcConfig(ctx);
  if (ours) await startManager(ctx);
  else if (managerWasUp) runLsm(ctx, ["reload"], { capture: true });
  if (daemonWasRunning) {
    const r = runLsm(ctx, ["start", DAEMON_SERVICE_ID], { capture: true });
    if (r.code !== 0 || !isRunning(daemonSnapshot(ctx))) ctx.io.err(t("cli.start.failed", { detail: `${r.stdout}${r.stderr}`.trim() || "?" }));
    else ctx.io.out(t(switched ? "cli.switch.restarted" : "cli.switch.restartedOld"));
  }
  if (!switched) return false;
  const keep = [target, ...(from && from !== target ? [from] : [])];
  const pruned = pruneVersions(root, keep);
  if (pruned.removed.length > 0) ctx.io.out(t("cli.switch.pruned", { versions: pruned.removed.join(", ") }));
  if (pruned.busy.length > 0) ctx.io.out(t("cli.switch.pruneBusy", { versions: pruned.busy.join(", ") }));
  return true;
}

/** 源码装的更新：交给安装脚本（版本目录里留着的 install.ps1）拉代码、构建进新的版本目录，不切；回新版本目录的名字 */
function buildFromSource(ctx: CliContext, root: string, ref: string | undefined): string | undefined {
  const script = path.join(root, "install.ps1");
  if (!fs.existsSync(script)) {
    ctx.io.err(t("cli.update.noInstallScript", { file: script }));
    return undefined;
  }
  const before = new Set(listVersions(root).map((v) => v.name));
  const r = spawnSync(
    "powershell.exe",
    ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script, "-FromSource", ...(ref ? ["-Ref", ref] : []), "-InstallDir", root, "-NoSwitch", "-NoPath", "-NoOnboard"],
    { stdio: "inherit", env: ctx.env, windowsHide: false },
  );
  if (r.status !== 0) return undefined;
  return listVersions(root).find((v) => !before.has(v.name))?.name;
}

export async function cmdUpdate(ctx: CliContext, options: UpdateOptions): Promise<number> {
  const root = needInstalled(ctx);
  if (!root) return 0;
  const current = ctx.layout.info!;
  if (current.kind === "source") {
    if (options.check) {
      ctx.io.out(t("cli.update.sourceCheck", { ref: current.ref ?? "main" }));
      return 0;
    }
    const built = buildFromSource(ctx, root, current.ref);
    if (!built) {
      ctx.io.err(t("cli.update.sourceFailed"));
      return 1;
    }
    return (await switchTo(ctx, root, built, options.idleTimeoutMs)) ? 0 : 1;
  }

  const state = readInstallState(root);
  const url = options.from ?? ctx.env.ERGO_RELEASE_URL ?? state.source?.url;
  const mirror = options.mirror ?? state.source?.mirror;
  const transport = ctx.transport();
  const signal = AbortSignal.timeout(6 * 60 * 60_000);
  const sources = await orderSources({ ...(url ? { url } : {}), ...(mirror ? { mirror } : {}), transport, signal });
  let index: ReleaseIndex | undefined;
  let source = sources[0]!;
  for (const s of sources) {
    try {
      index = await s.index(transport, signal, options.version);
      source = s;
      break;
    } catch (err) {
      ctx.io.err(t("cli.update.indexFailed", { source: s.title, detail: fetchErrorText(err) }));
    }
  }
  if (!index) return 1;
  const cmp = compareVersions(index.version, current.version);
  if (options.check || (cmp <= 0 && !options.version)) {
    ctx.io.out(cmp > 0 ? t("cli.update.available", { version: index.version, current: current.version }) : t("cli.update.upToDate", { version: current.version }));
    return 0;
  }
  const publicKey = releasePublicKey(ctx.env);
  if (!publicKey && !options.allowUnsigned) {
    ctx.io.err(t("cli.update.noPublicKey"));
    return 1;
  }
  const paths = installPaths(root);
  const target = path.join(paths.versions, index.version);
  if (!readVersionInfo(target)) {
    const dl = path.join(paths.downloads, index.version);
    ctx.io.out(t("cli.update.downloading", { version: index.version, source: source.title }));
    let lastPct = -1;
    try {
      await source.download(index, transport, dl, {
        signal,
        log: () => {},
        onBytes: (done, total) => {
          const pct = total > 0 ? Math.floor((done / total) * 10) * 10 : 0;
          if (pct !== lastPct) {
            lastPct = pct;
            ctx.io.out(t("cli.update.progress", { pct, mb: (done / 1e6).toFixed(0), total: (total / 1e6).toFixed(0) }));
          }
        },
      });
    } catch (err) {
      ctx.io.err(t("cli.update.downloadFailed", { detail: fetchErrorText(err) }));
      return 1;
    }
    const verified = await verifyRelease(dl, index, publicKey, { allowUnsigned: options.allowUnsigned });
    if (!verified.ok) {
      ctx.io.err(t("cli.update.verifyFailed", { detail: verified.reason }));
      return 1;
    }
    ctx.io.out(publicKey ? t("cli.update.verified", { comment: verified.trustedComment }) : t("cli.update.unsigned"));
    const partial = `${target}.partial`;
    fs.rmSync(partial, { recursive: true, force: true });
    await extractZip(verified.zip, partial);
    if (readVersionInfo(partial)?.version !== index.version) {
      fs.rmSync(partial, { recursive: true, force: true });
      ctx.io.err(t("cli.update.badPackage", { version: index.version }));
      return 1;
    }
    renameRetrying(partial, target);
    fs.rmSync(dl, { recursive: true, force: true });
  }
  if (url || mirror) writeInstallState(root, { ...readInstallState(root), source: { ...(url ? { url } : {}), ...(mirror ? { mirror } : {}) } });
  return (await switchTo(ctx, root, index.version, options.idleTimeoutMs)) ? 0 : 1;
}

export async function cmdRollback(ctx: CliContext, idleTimeoutMs: number): Promise<number> {
  const root = needInstalled(ctx);
  if (!root) return 0;
  const current = currentVersionName(root);
  const state = readInstallState(root);
  const versions = listVersions(root).filter((v) => v.name !== current);
  const previous = versions.find((v) => v.name === state.previous) ?? versions.at(-1);
  if (!previous) {
    ctx.io.err(t("cli.rollback.none"));
    return 1;
  }
  ctx.io.out(t("cli.rollback.to", { version: previous.info.version, name: previous.name }));
  return (await switchTo(ctx, root, previous.name, idleTimeoutMs)) ? 0 : 1;
}
