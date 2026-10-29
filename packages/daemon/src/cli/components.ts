// ergo components list | add <id> | remove <id> | import <文件或文件夹>（318 号票，接 323 的组件和下载器）：
// 只是二狗本机端口上组件接口（GET/POST /api/components…）的终端前端——下载、校验、装、离线导入都在守护进程里那一份，网页和这里共用。
// 二狗没在跑时说一句先 ergo start。
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { type ComponentImportResult, type ComponentsView, type ComponentView, componentBusy, t } from "@ergo/protocol";
import { type CliContext, daemonUrl } from "./context.ts";
import { sizeText } from "./texts.ts";

class DaemonDown extends Error {}

async function api<T>(ctx: CliContext, method: "GET" | "POST", route: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(new URL(route, daemonUrl(ctx)), {
      method,
      ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { "content-type": "application/json" } }),
      signal: AbortSignal.timeout(60_000),
    });
  } catch {
    throw new DaemonDown();
  }
  const text = await res.text();
  if (!res.ok) {
    let message = text;
    try {
      message = (JSON.parse(text) as { error?: { message?: string }; message?: string }).error?.message ?? message;
    } catch {
      // 不是 JSON
    }
    throw new Error(`${res.status} ${message}`);
  }
  return JSON.parse(text) as T;
}

function stateText(c: ComponentView): string {
  const base = t(`cli.components.state.${c.state}`);
  if (c.progress && c.progress.total > 0) return `${base} ${Math.floor((c.progress.done / c.progress.total) * 100)}%`;
  return base;
}

function printList(ctx: CliContext, view: ComponentsView): void {
  const rows = view.components.map((c) => [c.id, c.title, stateText(c), c.installedVersion ?? c.version, sizeText(c.size), c.defaultText]);
  const header = [t("cli.components.col.id"), t("cli.components.col.title"), t("cli.components.col.state"), t("cli.components.col.version"), t("cli.components.col.size"), t("cli.components.col.default")];
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i]!.length)));
  const line = (cells: string[]) => cells.map((c, i) => c.padEnd(widths[i]!)).join("  ").trimEnd();
  ctx.io.out(line(header));
  for (const r of rows) ctx.io.out(line(r));
  for (const c of view.components) {
    if (c.cannotInstall) ctx.io.out(t("cli.components.cannotInstall", { id: c.id, why: c.cannotInstall }));
    if (c.state === "failed" && c.error) ctx.io.out(t("cli.components.error", { id: c.id, why: c.error }));
  }
  ctx.io.out(view.manifest.signed ? t("cli.components.signed", { release: view.manifest.release }) : t("cli.components.unsigned", { release: view.manifest.release }));
}

/** 装 / 删：交给守护进程，等它不忙了（装的话每 10% 报一次进度） */
async function act(ctx: CliContext, id: string, action: "install" | "remove"): Promise<number> {
  let view = await api<ComponentsView>(ctx, "POST", `/api/components/${encodeURIComponent(id)}`, { action });
  let lastPct = -1;
  for (;;) {
    const c = view.components.find((x) => x.id === id);
    if (!c) {
      ctx.io.err(t("cli.components.unknown", { id }));
      return 1;
    }
    if (!componentBusy(c.state)) {
      if (c.state === "failed") {
        ctx.io.err(t("cli.components.error", { id, why: c.error ?? "?" }));
        return 1;
      }
      ctx.io.out(t("cli.components.now", { id, state: stateText(c) }));
      return action === "install" && c.state !== "installed" && c.state !== "provided" ? 1 : 0;
    }
    if (c.progress && c.progress.total > 0) {
      const pct = Math.floor((c.progress.done / c.progress.total) * 10) * 10;
      if (pct !== lastPct) {
        lastPct = pct;
        ctx.io.out(t("cli.components.progress", { id, pct, done: sizeText(c.progress.done), total: sizeText(c.progress.total) }));
      }
    }
    await sleep(1000);
    view = await api<ComponentsView>(ctx, "GET", "/api/components");
  }
}

export async function cmdComponents(ctx: CliContext, sub: string | undefined, arg: string | undefined): Promise<number> {
  try {
    switch (sub ?? "list") {
      case "list":
        printList(ctx, await api<ComponentsView>(ctx, "GET", "/api/components"));
        return 0;
      case "add":
      case "remove":
        if (!arg) {
          ctx.io.err(t("cli.components.needId"));
          return 2;
        }
        return await act(ctx, arg, sub === "add" ? "install" : "remove");
      case "import": {
        if (!arg) {
          ctx.io.err(t("cli.components.needFile"));
          return 2;
        }
        const r = await api<ComponentImportResult>(ctx, "POST", "/api/component-import", { path: path.resolve(arg) });
        ctx.io.out(t("cli.components.imported", { installed: r.installed.join(", ") || "-", matched: r.matched.length, unknown: r.unknown.length }));
        for (const m of r.missing) ctx.io.out(t("cli.components.stillMissing", { id: m.component, files: m.files.join(", ") }));
        return r.unknown.length > 0 && r.matched.length === 0 ? 1 : 0;
      }
      default:
        ctx.io.err(t("cli.components.usage"));
        return 2;
    }
  } catch (err) {
    if (err instanceof DaemonDown) {
      ctx.io.err(t("cli.components.daemonDown", { url: daemonUrl(ctx) }));
      return 1;
    }
    ctx.io.err(t("cli.components.failed", { detail: (err as Error).message }));
    return 1;
  }
}
