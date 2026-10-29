// 业务层：我的名字（249 号票）—— 用户**自己**的名字怎么存、怎么查、怎么清除，以及它怎么进系统提示。
// 光看这一层，不起守护进程：
// - 存在数据目录配置区的 config/user-name.json（{ format: 1, name }），没有这个文件就是没设；
// - 启动时读入；读坏了、内容不对、名字不合规只当没设（记一行日志，不覆盖文件），不让守护进程起不来；
// - 改名字照 checkAssistantName 的规矩查（不合规抛 RequestRejected，网关回 400 带原因），null / 空串 / 只有空白 = 清除；
// - 有变化才写、才叫 onChange（秘书、记忆管理员、维护者据此从下一轮起按新的系统提示重新装配）；
// - 系统提示：设了就在前缀后面加一句"用户叫「…」"；没设时和以前**逐字节一样**（前缀、角色提示一个字都不变）。
// 它和个人助理的名字（43 号票）各存各的文件，改一个不动另一个。
import fs from "node:fs";
import path from "node:path";
import { ASSISTANT_NAME_MARK, type AssistantNameEventPayload, CHANNELS, EVENT_TYPES } from "@ergo/protocol";
import { describe, expect, it } from "vitest";
import { createAssistantNameService } from "../../src/assistant/index.ts";
import { dataDirLayout } from "../../src/config/data-dir.ts";
import { openEventStore } from "../../src/events/event-store.ts";
import { createPromptLibrary } from "../../src/prompts/library.ts";
import { createUserNameService, type UserNameService } from "../../src/user-name/index.ts";
import { makeTempDir } from "../helpers/temp-dir.ts";

function setup(options: { file?: string } = {}) {
  const root = makeTempDir();
  const layout = dataDirLayout(root);
  const logs: string[] = [];
  const file = options.file ?? layout.userNameFile;
  const service = createUserNameService({ layout: { ...layout, userNameFile: file }, log: (line) => logs.push(line) });
  service.start();
  const read = (): unknown => JSON.parse(fs.readFileSync(file, "utf8"));
  return { service, file, logs, read, layout };
}

describe("我的名字：存取、校验、清除", () => {
  it("没设：current 是 undefined、view 是空的（界面上照旧）", () => {
    const { service } = setup();
    expect(service.current()).toBeUndefined();
    expect(service.view()).toEqual({});
  });

  it("设了：去掉首尾空白存下，文件是 { format: 1, name }，view 里有 name", () => {
    const { service, read, file } = setup();
    expect(service.change("  文翰 ")).toEqual({ name: "文翰", changed: true });
    expect(service.current()).toBe("文翰");
    expect(service.view()).toEqual({ name: "文翰" });
    expect(read()).toEqual({ format: 1, name: "文翰" });
    expect(path.basename(file)).toBe("user-name.json");
  });

  it("同样的名字再改一次没有变化：不写文件、不叫 onChange", () => {
    const { service } = setup();
    service.change("文翰");
    const changed: Array<string | undefined> = [];
    service.onChange((name) => changed.push(name));
    expect(service.change("文翰")).toEqual({ name: "文翰", changed: false });
    expect(changed).toEqual([]);
  });

  it("不规范的名字被拒（空的除外——空的是清除），什么都不改", () => {
    const { service, file } = setup();
    for (const bad of ["一二三四五六七八九", "文\n翰", "文\u0007翰", "文⟦翰"]) {
      expect(() => service.change(bad)).toThrow(/名字/);
    }
    expect(service.current()).toBeUndefined();
    // 一次都没写成功：文件还没建出来
    expect(fs.existsSync(file)).toBe(false);
  });

  it("清除：null、空串、只有空白都算清除，删掉文件，回到没设", () => {
    const { service, file } = setup();
    const changed: Array<string | undefined> = [];
    service.onChange((name) => changed.push(name));
    service.change("文翰");
    expect(fs.existsSync(file)).toBe(true);
    expect(service.change(null)).toEqual({ changed: true });
    expect(service.current()).toBeUndefined();
    expect(service.view()).toEqual({});
    expect(fs.existsSync(file)).toBe(false);
    // 再清除一次：没有变化
    expect(service.change("")).toEqual({ changed: false });
    expect(changed).toEqual(["文翰", undefined]);
  });

  it("只有空白也是清除（不是报错）", () => {
    const { service, file } = setup();
    service.change("文翰");
    expect(service.change("  　 ")).toEqual({ changed: true });
    expect(service.current()).toBeUndefined();
    expect(fs.existsSync(file)).toBe(false);
  });
});

describe("我的名字：文件读坏了只当没设，不覆盖它", () => {
  it.each<[string, string]>([
    ["不是 JSON", "不是 JSON"],
    ["内容不对（少了 format）", JSON.stringify({ name: "文翰" })],
    ["名字太长", JSON.stringify({ format: 1, name: "一二三四五六七八九" })],
  ])("%s：current 是 undefined，记了一行日志，文件原样留着", (_case, content) => {
    const { layout } = setup();
    fs.mkdirSync(layout.config, { recursive: true });
    fs.writeFileSync(layout.userNameFile, content);
    const logs: string[] = [];
    const service = createUserNameService({ layout, log: (line) => logs.push(line) });
    service.start();
    expect(service.current()).toBeUndefined();
    expect(fs.readFileSync(layout.userNameFile, "utf8")).toBe(content);
    expect(logs.join("\n")).toMatch(/我的名字的配置文件/);
  });

  it("停掉再起：名字还在（文件是真相）", () => {
    const root = makeTempDir();
    const layout = dataDirLayout(root);
    const first = createUserNameService({ layout, log: () => {} });
    first.start();
    first.change("文翰");
    first.stop();
    const second = createUserNameService({ layout, log: () => {} });
    second.start();
    expect(second.current()).toBe("文翰");
    second.stop();
  });
});

describe("我的名字和助理的名字：各存各的、互不影响", () => {
  it("改我的名字不动助理的名字和它的名字频道；改助理的名字也不动我的名字", () => {
    const root = makeTempDir();
    const layout = dataDirLayout(root);
    fs.mkdirSync(layout.db, { recursive: true });
    const store = openEventStore({ file: path.join(layout.db, "ergo.db"), views: [], log: () => {} });
    const assistant = createAssistantNameService({ store, layout, log: () => {} });
    assistant.start();
    const userName: UserNameService = createUserNameService({ layout, log: () => {} });
    userName.start();

    userName.change("文翰");
    assistant.change("阿福", "settings");
    expect(userName.current()).toBe("文翰");
    expect(assistant.current()).toBe("阿福");
    // 两个文件各是各的
    expect(JSON.parse(fs.readFileSync(layout.userNameFile, "utf8"))).toEqual({ format: 1, name: "文翰" });
    expect(JSON.parse(fs.readFileSync(layout.assistantNameFile, "utf8"))).toEqual({ format: 1, name: "阿福" });
    // 名字频道上只有助理的名字那次改名（我的名字不走事件）
    const nameEvents = store.read(CHANNELS.assistantName, 0, EVENT_TYPES.assistantName).map((event) => event.payload as AssistantNameEventPayload);
    expect(nameEvents).toEqual([{ name: "阿福", source: "settings" }]);

    // 清除我的名字也不动助理的名字
    userName.change(null);
    expect(assistant.current()).toBe("阿福");
    assistant.stop();
    store.close();
  });
});

/** 系统提示里那句（249 号票，设了名字才有） */
const LINE = (name: string) => `用户叫「${name}」，需要称呼用户时用这个名字（对话、念给用户听的话都可以这样叫）。`;

describe("系统提示：设了名字加一句，没设一个字都不变", () => {

  it("没设：withPrefix 和以前逐字节一样（前缀空、前缀非空都对得上）", () => {
    const root = makeTempDir();
    const userDir = path.join(root, "prompts");
    const plain = createPromptLibrary({ log: () => {} });
    expect(plain.withPrefix("你是维护者。")).toBe("你是维护者。");
    // 设了名字的对照：多一句（只有这一句在前面、空一行）
    const named = createPromptLibrary({ userName: () => "文翰", log: () => {} });
    expect(named.withPrefix("你是维护者。")).toBe(`${LINE("文翰")}\n\n你是维护者。`);
    // 前缀有内容：用户自己的那段还是最前，名字那句跟在它后面
    fs.mkdirSync(userDir, { recursive: true });
    fs.writeFileSync(path.join(userDir, "prefix.md"), "我住在新加坡，回答用简体中文。\n");
    const withoutName = createPromptLibrary({ userDir, log: () => {} });
    const withName = createPromptLibrary({ userDir, userName: () => "文翰", log: () => {} });
    expect(withoutName.withPrefix("你是维护者。")).toBe("我住在新加坡，回答用简体中文。\n\n你是维护者。");
    expect(withName.withPrefix("你是维护者。")).toBe(`我住在新加坡，回答用简体中文。\n\n${LINE("文翰")}\n\n你是维护者。`);
  });

  it("名字现取：改了（设了、清了）下一次装配就是新的；空串当没设", () => {
    let name: string | undefined;
    const library = createPromptLibrary({ userName: () => name, log: () => {} });
    expect(library.withPrefix("你是维护者。")).toBe("你是维护者。");
    name = "文翰";
    expect(library.withPrefix("你是维护者。")).toContain(LINE("文翰"));
    name = undefined;
    expect(library.withPrefix("你是维护者。")).toBe("你是维护者。");
    name = "   ";
    expect(library.withPrefix("你是维护者。")).toBe("你是维护者。");
  });

  it("和 241 号票那句（agent 自己的名字）不是一回事：一个在前缀后面，一个在角色提示末尾", () => {
    const library = createPromptLibrary({ userName: () => "文翰", agentName: () => "阿福", log: () => {} });
    const withPrefix = library.withPrefix("你是维护者。");
    expect(withPrefix).toContain(LINE("文翰"));
    expect(withPrefix).not.toContain("用户叫你");
    // 角色提示（带 agent id 的维护者那份）末尾才是"用户叫你「阿福」"
    const rendered = library.render("plain-task", { 连续失败几次暂停: "3", 对话审批开着: false, 定时触发: false }, "tm-1");
    expect(rendered.trimEnd().endsWith("用户叫你「阿福」：自我介绍、说到你自己时用这个名字。")).toBe(true);
    expect(rendered).not.toContain(ASSISTANT_NAME_MARK);
  });
});
