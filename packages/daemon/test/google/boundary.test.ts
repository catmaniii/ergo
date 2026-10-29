// Google 插件的边界（297 号票，ADR-0027，照日历插件的 test/calendar/boundary.test.ts）：
// 1. 组合根（daemon.ts）里不出现 Google 插件：不建它的服务、不 import 它的内部；
// 2. google 目录之外只从 google/api.ts 拿它的东西，写明的例外只有插件清单列它；
// 3. 数据契约的形状：登记三个数据源（Google · 日历、298 号票的 Google · Gmail、301 号票的 Google · 联系人：认导入文件夹里的 vCard）、
//    移除时连数据删删 google 频道的六类事件和密钥区里的私密地址、Gmail 地址和密码；日历插件是可选依赖（wants）；只有导入的你发出的邮件
//    采成素材（一条采集规则、一个彻底删除的改写函数），不经 ctx.agent 登记工具（按需查的工具由内核替数据源给秘书）。
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { DataSource } from "../../src/data-sources/api.ts";
import { googlePlugin } from "../../src/google/plugin.ts";
import type { ContractContext } from "../../src/plugins/host.ts";
import type { PluginDataRemoval } from "../../src/plugins/removal.ts";

const srcRoot = path.resolve(import.meta.dirname, "../../src");

function sourceFiles(dir: string): Array<{ path: string; content: string }> {
  return fs
    .readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((d) => d.isFile() && d.name.endsWith(".ts"))
    .map((d) => {
      const file = path.join(d.parentPath, d.name);
      return { path: path.relative(srcRoot, file).split(path.sep).join("/"), content: fs.readFileSync(file, "utf8") };
    });
}

/** 去掉注释（注释里提到不算） */
const withoutComments = (code: string) => code.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");

/** 写明的例外：谁 → Google 的哪个文件 */
const ALLOWED = ["plugins/manifest.ts → google/plugin.ts"];

describe("Google 插件的边界", () => {
  const files = sourceFiles(srcRoot);

  it("组合根里不出现 Google 插件", () => {
    const root = withoutComments(files.find((f) => f.path === "daemon.ts")!.content);
    expect(root).not.toMatch(/createGoogleCalendar|googlePlugin|createGooglePlugin/);
    expect(root).not.toMatch(/from\s+["']\.\/google\//);
  });

  it("google 目录之外只 import google/api.ts（例外写明）", () => {
    const imports = files
      .filter((f) => !f.path.startsWith("google/"))
      .flatMap((f) => [...f.content.matchAll(/from\s+["']([^"']*google\/[^"']+)["']/g)].map((m) => `${f.path} → ${path.posix.normalize(path.posix.join(path.posix.dirname(f.path), m[1]!))}`));
    expect(imports.filter((i) => !i.endsWith("→ google/api.ts") && !ALLOWED.includes(i))).toEqual([]);
    expect(imports).toContain("plugins/manifest.ts → google/plugin.ts");
  });

  it("数据契约：三个数据源、移除时删六类事件和密钥区里的两个文件；只有你发出的邮件采成素材、不登记卡片和前端请求；日历是可选依赖", () => {
    const sources: DataSource[] = [];
    const removals: PluginDataRemoval[] = [];
    const other: string[] = [];
    const materialSources: Array<{ name: string; eventType: string }> = [];
    const purges: Array<{ eventType: string }> = [];
    const ctx = {
      plugin: "google",
      dataSources: { register: (s: DataSource) => sources.push(s) },
      removal: { declare: (r: PluginDataRemoval) => removals.push(r) },
      cardTypes: { register: () => other.push("cardTypes") },
      purge: { register: (...r: Array<{ eventType: string }>) => purges.push(...r), registerQuotes: () => other.push("quotes") },
      materialSources: { register: (m: { name: string; eventType: string }) => materialSources.push(m) },
      requests: { register: () => other.push("requests") },
      runtimes: { register: () => other.push("runtimes") },
      active: () => {
        throw new Error("不该在登记时取服务");
      },
    } as unknown as ContractContext;
    googlePlugin.contracts!(ctx);
    expect(sources.map((s) => [s.id, s.title])).toEqual([
      ["google-calendar", "Google · 日历"],
      ["google-gmail", "Google · Gmail"],
      ["google-contacts", "Google · 联系人"],
    ]);
    // 联系人只有导入文件夹这一种用法：认 .vcf，没有连接、同步
    expect(sources[2]!.files?.map((f) => f.extensions)).toEqual([[".vcf", ".vcard"]]);
    expect([sources[2]!.status, sources[2]!.sync, sources[2]!.usages.query]).toEqual([undefined, undefined, undefined]);
    // 日程走 299 号票定的路：数据源的 calendar() 交给日历插件；"共几条"由它数
    expect([typeof sources[0]!.calendar, typeof sources[0]!.count]).toEqual(["function", "function"]);
    // Gmail：按需查默认开、导入（只导我发出的）默认关；登记财务、健康两类（每封按关键词写窄）
    expect(sources[1]!.usages).toMatchObject({ query: { default: true }, import: { default: false, schedule: { kind: "every", minutes: 60 }, syncOnConnect: true } });
    expect(sources[1]!.sensitive).toEqual(["finance", "health"]);
    expect(materialSources.map((m) => [m.name, m.eventType])).toEqual([["google-gmail-sent", "google_gmail_sent"]]);
    expect(purges.map((p) => p.eventType)).toEqual(["google_gmail_sent"]);
    expect(other).toEqual([]);
    expect(removals).toHaveLength(1);
    expect(removals[0]).toMatchObject({
      events: [
        { channel: "google", type: "google_calendar_item" },
        { channel: "google", type: "google_calendar_feed" },
        { channel: "google", type: "google_gmail_sent" },
        { channel: "google", type: "google_gmail_cursor" },
        { channel: "google", type: "google_contact" },
        { channel: "google", type: "google_contacts_offered" },
      ],
      files: ["secrets/data-sources/google-calendar.json", "secrets/data-sources/google-gmail.json"],
    });
    expect((googlePlugin.wants ?? []).map((k) => k.id)).toEqual(["calendar"]);
    expect(googlePlugin.views ?? []).toEqual([]);
  });
});
