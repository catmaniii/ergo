// 设置里 agent 的联网搜索、读网页（154 号票起；162 号票改成队列，182 号票起四种方式）：数据目录配置区的 web-settings.json 是真相，只由设置接口写；
// 没有文件按默认（DeepSeek → 浏览器 → agent-browser → 鸿蒙 App 的内置浏览器，都启用）；没配 DeepSeek 的 key 时实际的顺序里没有它；
// 154 号票的旧文件（format 1）读成队列；162 号票存的三项读成四项（内置浏览器加在最后、启用），认不得的方式跳过；文件读不出来按默认用、
// 写明原因，存一次就覆盖；存之前查合规（四种各一项、至少留一个用得上的）；改了通知听的人（秘书重新装配）；
// DeepSeek 的 key 只说配没配、从哪来；最近一次余额不足照 DeepSeek 客户端报的。
import fs from "node:fs";
import path from "node:path";
import type { WebMethod, WebSettings } from "@ergo/protocol";
import { describe, expect, it } from "vitest";
import { createWebSettings } from "../../src/web/index.ts";
import { makeTempDir } from "../helpers/temp-dir.ts";

const queue = (...entries: [WebMethod, boolean][]): WebSettings => ({ queue: entries.map(([method, enabled]) => ({ method, enabled })) });
const INITIAL = queue(["deepseek", true], ["browser", true], ["agent-browser", true], ["app-browser", true]);

function setup(options: { key?: boolean; balanceLowAt?: string; content?: string } = {}) {
  const file = path.join(makeTempDir("ergo-web-settings-"), "config", "web-settings.json");
  if (options.content !== undefined) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, options.content);
  }
  const log: string[] = [];
  let key = options.key ?? true;
  const make = () => createWebSettings({ file, deepseekKey: () => key, lsm: () => true, balanceLowAt: () => options.balanceLowAt, log: (l) => log.push(l) });
  return {
    file,
    log,
    make,
    setKey: (v: boolean) => {
      key = v;
    },
  };
}

describe("设置里的联网搜索队列", () => {
  it("没有文件：DeepSeek → 浏览器 → agent-browser → 鸿蒙 App 的内置浏览器，都启用；配了 key 时实际也是；key 只说配没配、从哪来；不写文件", () => {
    const { make, file } = setup();
    expect(make().view()).toEqual({
      settings: INITIAL,
      effective: ["deepseek", "browser", "agent-browser", "app-browser"],
      deepseekKey: { configured: true, envVar: "DEEPSEEK_API_KEY", secretFile: "secrets/deepseek-api-key.txt", lsm: true },
    });
    expect(fs.existsSync(file)).toBe(false);
  });

  it("没配 DeepSeek 的 key：实际的顺序里没有它（存着的不变）；配上了马上按存着的", () => {
    const { make, setKey } = setup({ key: false });
    const settings = make();
    expect(settings.view()).toMatchObject({ settings: INITIAL, effective: ["browser", "agent-browser", "app-browser"], deepseekKey: { configured: false } });
    setKey(true);
    expect(settings.view().effective).toEqual(["deepseek", "browser", "agent-browser", "app-browser"]);
  });

  it("存：整份写进文件（format 2），马上生效、通知听的人；重启后照文件", () => {
    const { make, file, log } = setup();
    const settings = make();
    const heard: number[] = [];
    const off = settings.onChange(() => heard.push(1));
    const next = queue(["app-browser", true], ["browser", true], ["agent-browser", true], ["deepseek", false]);
    expect(settings.change(next)).toMatchObject({ settings: next, effective: ["app-browser", "browser", "agent-browser"] });
    expect(settings.current()).toEqual(next);
    expect(JSON.parse(fs.readFileSync(file, "utf8"))).toEqual({ format: 2, ...next });
    expect(heard).toEqual([1]);
    expect(log.at(-1)).toBe("联网设置改了：鸿蒙 App 的内置浏览器 → 二狗自带的浏览器搜索 → agent-browser（停用：DeepSeek 付费搜索）");
    off();
    settings.change(INITIAL);
    expect(heard).toEqual([1]);
    expect(make().current()).toEqual(INITIAL);
  });

  it("不合规的不存：四种不是各一项、一个启用的都没留（没 key 时只启用 DeepSeek 不算）", () => {
    const { make, file } = setup({ key: false });
    const settings = make();
    expect(settings.problem(queue(["deepseek", true], ["browser", false], ["agent-browser", false], ["app-browser", false]))).toBe("至少要留一种启用的方式（没配 DeepSeek 的 key，只启用它不算）");
    expect(settings.problem(queue(["deepseek", true], ["deepseek", true], ["browser", true], ["agent-browser", true]))).toMatch(/^队列里要四种方式各一项/);
    // DeepSeek 存着启用、另外留了一种：没 key 也能存（配上 key 马上用上）
    expect(settings.problem(queue(["deepseek", true], ["browser", false], ["agent-browser", true], ["app-browser", false]))).toBeUndefined();
    expect(fs.existsSync(file)).toBe(false);
  });

  it("154 号票的旧文件（format 1）读成队列：默认浏览器的浏览器排第一；记一条日志；存一次写成 format 2", () => {
    const { make, file, log } = setup({ content: JSON.stringify({ format: 1, search: "browser", deepseekFetch: false }) });
    const settings = make();
    expect(settings.view()).toMatchObject({
      settings: queue(["browser", true], ["deepseek", true], ["agent-browser", true], ["app-browser", true]),
      effective: ["browser", "deepseek", "agent-browser", "app-browser"],
    });
    expect(settings.view().settingsFileError).toBeUndefined();
    expect(log.some((l) => l.startsWith("联网设置是 154 号票的旧格式"))).toBe(true);
    settings.change(settings.current());
    expect(JSON.parse(fs.readFileSync(file, "utf8")).format).toBe(2);
    const old = setup({ content: JSON.stringify({ format: 1, search: "deepseek", deepseekFetch: true }) });
    expect(old.make().current()).toEqual(INITIAL);
  });

  it("162 号票存的三项（182 号票）：鸿蒙 App 的内置浏览器加在最后、启用，存着的顺序和开关不变；认不得的方式跳过；记日志，不立刻改写文件", () => {
    const three = { format: 2, queue: [{ method: "browser", enabled: true }, { method: "tavily", enabled: true }, { method: "deepseek", enabled: false }, { method: "agent-browser", enabled: true }] };
    const content = JSON.stringify(three);
    const { make, file, log } = setup({ content });
    const settings = make();
    expect(settings.view()).toMatchObject({ settings: queue(["browser", true], ["deepseek", false], ["agent-browser", true], ["app-browser", true]), effective: ["browser", "agent-browser", "app-browser"] });
    expect(settings.view().settingsFileError).toBeUndefined();
    expect(log).toContain("联网设置的文件里认不得的方式跳过：tavily");
    expect(log).toContain("联网设置的文件里没有鸿蒙 App 的内置浏览器（182 号票新加的），加在最后、启用；设置页保存后写进文件");
    expect(fs.readFileSync(file, "utf8")).toBe(content);
    settings.change(settings.current());
    expect(JSON.parse(fs.readFileSync(file, "utf8")).queue).toHaveLength(4);
  });

  it("文件读不出来（不是 JSON、不合规、方式重复）：按默认用、写明原因、记日志；存一次就覆盖，提示消失", () => {
    const dup = { format: 2, queue: [{ method: "deepseek", enabled: true }, { method: "deepseek", enabled: true }, { method: "browser", enabled: true }] };
    for (const content of ["{坏的", JSON.stringify({ format: 2, queue: [] }), JSON.stringify({ format: 1, search: "baidu", deepseekFetch: true }), JSON.stringify(dup)]) {
      const { make, log } = setup({ content });
      const settings = make();
      const view = settings.view();
      expect(view.settings).toEqual(INITIAL);
      expect(view.settingsFileError).toBeTruthy();
      expect(log.some((l) => l.startsWith("联网设置的文件读不出来："))).toBe(true);
      expect(settings.change(INITIAL).settingsFileError).toBeUndefined();
    }
  });

  it("最近一次余额不足照 DeepSeek 客户端报的", () => {
    const { make } = setup({ balanceLowAt: "2026-10-18T10:30:00.000+08:00" });
    expect(make().view().deepseekBalanceLowAt).toBe("2026-10-18T10:30:00.000+08:00");
  });
});
