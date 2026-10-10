// skill 库和 MCP 登记的单元测试（27 号票）：
// - skill 库：框架自带的在前、skill 区里的在后；导入的规矩（绝对路径、含 SKILL.md、frontmatter 的名字和说明、不重名、不能从数据目录里导入），
//   复制一份进 skill 区（来源里有链接的整个拒绝，见 skill-collections.test.ts）；
// - MCP 登记：配置区的 mcp.json 现读，写错了一个都不用并说明哪里错；凭据按登记从守护进程的环境里取；
// - 登记的 MCP 工具进守卫的工具注册表：按登记的类别、"只读或幂等"、联网标记判（不写联网标记按要联网算）。
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { BUILTIN_TOOL_REGISTRY, judgeToolCall, registerTools } from "../../src/guard/index.ts";
import { createMcpService } from "../../src/mcp/mcp.ts";
import { readMcpRegistrations, serverEnv } from "../../src/mcp/registration.ts";
import { createSkillLibrary, frontmatter } from "../../src/skills/library.ts";
import { call, inChat, inTask, maintainer } from "../guard/helpers/guard-input.ts";
import { makeTempDir } from "../helpers/temp-dir.ts";
import { FAKE_MCP_SERVER, writeSkill } from "../helpers/toolkit.ts";

function library() {
  const builtinDir = makeTempDir("ergou-builtin-skills-");
  const dataDir = makeTempDir("ergou-data-");
  const userDir = path.join(dataDir, "skills");
  writeSkill(path.join(builtinDir, "zeta-builtin"), "zeta-builtin", "框架自带的");
  const logs: string[] = [];
  return { lib: createSkillLibrary({ builtinDir, userDir, dataDir, log: (l) => logs.push(l) }), builtinDir, dataDir, userDir, logs };
}

describe("skill 库", () => {
  it("框架自带的在前、skill 区里的在后，各自按名字排；和框架自带的同名的、没有 SKILL.md 的、隐藏目录不算", () => {
    const { lib, userDir, logs } = library();
    writeSkill(path.join(userDir, "beta"), "beta", "第二个");
    writeSkill(path.join(userDir, "alpha"), "alpha", "第一个");
    writeSkill(path.join(userDir, "dup"), "zeta-builtin", "同名");
    writeSkill(path.join(userDir, ".importing-x"), "x", "导入到一半");
    fs.mkdirSync(path.join(userDir, "empty"));
    expect(lib.list()).toEqual([
      { name: "zeta-builtin", description: "框架自带的", origin: "framework" },
      { name: "alpha", description: "第一个", origin: "imported" },
      { name: "beta", description: "第二个", origin: "imported" },
    ]);
    expect(logs.some((l) => l.includes("和框架自带的 zeta-builtin 同名"))).toBe(true);
    expect(lib.pathsOf(["beta", "nope"])).toEqual([path.join(userDir, "beta")]);
    expect(lib.missing(["alpha", "nope"])).toEqual(["nope"]);
  });

  it("导入：复制一份进 skill 区（目录名取来源的目录名，名字照 SKILL.md），来源删了库里照样有", () => {
    const { lib, userDir } = library();
    const source = writeSkill(path.join(makeTempDir("ergou-src-"), "notes"), "notes-style", "笔记的写法");
    fs.mkdirSync(path.join(source, "refs"));
    fs.writeFileSync(path.join(source, "refs", "a.md"), "参考");
    expect(lib.importFrom({ path: source })).toEqual({
      skills: [{ name: "notes-style", description: "笔记的写法", origin: "imported" }],
      report: [{ name: "notes-style", dir: ".", ok: true }],
      linked: [],
      excluded: [],
    });
    fs.rmSync(source, { recursive: true });
    const target = path.join(userDir, "notes");
    expect(fs.readFileSync(path.join(target, "refs", "a.md"), "utf8")).toBe("参考");
    expect(lib.list().map((s) => s.name)).toEqual(["zeta-builtin", "notes-style"]);
    expect(fs.readdirSync(userDir)).toEqual(["notes"]);
  });

  it("导入的规矩：绝对路径、是目录、含 SKILL.md、frontmatter 有名字（不太长）和说明、不重名、不在数据目录里", () => {
    const { lib, dataDir } = library();
    const root = makeTempDir("ergou-src-");
    const reject = (source: string) => {
      try {
        lib.importFrom({ path: source });
      } catch (err) {
        return { code: (err as { code?: string }).code, message: (err as Error).message };
      }
      throw new Error("该拒绝的没拒绝");
    };
    expect(reject("relative/dir")).toMatchObject({ code: "bad_params", message: expect.stringContaining("绝对路径") });
    expect(reject(path.join(root, "missing"))).toMatchObject({ code: "not_found" });
    fs.writeFileSync(path.join(root, "file.md"), "x");
    expect(reject(path.join(root, "file.md"))).toMatchObject({ code: "bad_params", message: expect.stringContaining("不是目录") });
    fs.mkdirSync(path.join(root, "no-skill"));
    expect(reject(path.join(root, "no-skill"))).toMatchObject({ code: "bad_params", message: expect.stringContaining("SKILL.md") });
    fs.mkdirSync(path.join(root, "no-front"));
    fs.writeFileSync(path.join(root, "no-front", "SKILL.md"), "# 没有 frontmatter\n");
    expect(reject(path.join(root, "no-front"))).toMatchObject({ message: expect.stringContaining("frontmatter") });
    // 名字照原样认（大写、空格都行，72 号票），只挡太长的
    expect(reject(writeSkill(path.join(root, "long"), "x".repeat(201), "x"))).toMatchObject({ message: expect.stringContaining("太长") });
    fs.mkdirSync(path.join(root, "no-desc"));
    fs.writeFileSync(path.join(root, "no-desc", "SKILL.md"), "---\nname: no-desc\n---\n");
    expect(reject(path.join(root, "no-desc"))).toMatchObject({ message: expect.stringContaining("description") });
    expect(reject(writeSkill(path.join(root, "dup"), "zeta-builtin", "x"))).toMatchObject({ code: "conflict" });
    expect(reject(writeSkill(path.join(dataDir, "notes", "in-data"), "in-data", "x"))).toMatchObject({ code: "not_allowed", message: expect.stringContaining("数据目录") });
  });

  it("frontmatter：单行的值（可以带引号）、多行的 > 和 | 块", () => {
    expect(frontmatter('---\nname: "a-b"\ndescription: \'说明\'\n---\n正文')).toEqual({ name: "a-b", description: "说明" });
    expect(frontmatter("---\nname: x\ndescription: >\n  第一行\n  第二行\n---\n")).toMatchObject({ name: "x", description: expect.stringContaining("第一行") });
    expect(frontmatter("没有 frontmatter")).toBeUndefined();
  });
});

/** 临时目录里写一份登记文件 */
function write(value: unknown): string {
  const file = path.join(makeTempDir("ergou-config-"), "mcp.json");
  fs.writeFileSync(file, typeof value === "string" ? value : JSON.stringify(value));
  return file;
}

describe("MCP 登记", () => {
  it("没有登记文件就是没登记；写错了一个都不用，说明哪里错", () => {
    expect(readMcpRegistrations(path.join(makeTempDir("ergou-config-"), "mcp.json"))).toEqual({ servers: {} });
    expect(readMcpRegistrations(write("{ 不是 JSON"))).toMatchObject({ servers: {}, problem: expect.stringContaining("不是合法的 JSON") });
    expect(readMcpRegistrations(write({ servers: { demo: { tools: {} } } }))).toMatchObject({ servers: {}, problem: expect.stringContaining("写得不对") });
    const ok = readMcpRegistrations(write({ servers: { demo: { command: "node", tools: { echo: { title: "回话" } } } } }));
    expect(ok.problem).toBeUndefined();
    expect(Object.keys(ok.servers)).toEqual(["demo"]);
  });

  it("仓库里的示例登记（config/mcp.example.json）照现在的格式读得进来", () => {
    const read = readMcpRegistrations(path.resolve(import.meta.dirname, "../../../../config/mcp.example.json"));
    expect(read.problem).toBeUndefined();
    expect(Object.keys(read.servers.notes!.tools)).toEqual(["search", "status", "share"]);
  });

  it("凭据按登记从守护进程的环境里取（变量名不分大小写），取不到的不给并列出来", () => {
    const registration = { command: "node", env: { PLAIN: "1", TOKEN: { fromEnv: "MY_TOKEN" }, OTHER: { fromEnv: "NOT_SET" } }, tools: {} };
    expect(serverEnv(registration, { my_token: "secret", PATH: "x" })).toEqual({ env: { PLAIN: "1", TOKEN: "secret" }, missing: ["NOT_SET"], secrets: ["secret"] });
  });

  it("登记的工具进守卫的工具注册表：按登记的类别、只读或幂等、联网标记判（不写联网标记按要联网算）", async () => {
    const file = write({
      servers: {
        notes: {
          title: "笔记服务",
          command: process.execPath,
          args: [FAKE_MCP_SERVER],
          tools: {
            search: { title: "搜索笔记", readOnlyOrIdempotent: true, network: false },
            publish: { title: "发布笔记", categories: ["external_send"], args: { to: { kind: "recipient" } }, network: true },
            sync: { title: "同步" },
          },
        },
      },
    });
    const mcp = createMcpService({ file, parentEnv: {}, cwd: makeTempDir("ergou-cwd-"), newJob: () => undefined, callTimeoutMs: 1000, log: () => {} });
    const descriptors = mcp.descriptors();
    expect(descriptors.map((d) => [d.name, d.title, d.network, d.readOnlyOrIdempotent])).toEqual([
      ["mcp__notes__search", "笔记服务：搜索笔记", false, true],
      ["mcp__notes__publish", "笔记服务：发布笔记", true, false],
      ["mcp__notes__sync", "笔记服务：同步", true, false],
    ]);
    const tools = registerTools(BUILTIN_TOOL_REGISTRY, ...descriptors);
    const online = maintainer({ toolkit: { bash: false, network: true } });
    const offline = maintainer({ toolkit: { bash: false, network: false } });
    expect(judgeToolCall({ ...inChat(online, call("mcp__notes__search", { q: "x" })), tools }).disposition).toBe("log_only");
    const publish = judgeToolCall({ ...inChat(online, call("mcp__notes__publish", { to: "老王" })), tools });
    expect(publish.categories).toEqual(["external_send"]);
    expect(publish.disposition).toBe("ask_first");
    // 联网关着：要联网的（包括没写联网标记的）硬拒绝，提示申请开联网；不联网的照常
    for (const name of ["mcp__notes__publish", "mcp__notes__sync"]) {
      const j = judgeToolCall({ ...inTask(offline, call(name, {})), tools });
      expect(j.hardRefusal).toContain("network_off");
      expect(j.explanation).toContain("提交工具包变更申请开联网");
    }
    expect(judgeToolCall({ ...inTask(offline, call("mcp__notes__search", {})), tools }).hardRefusal).toBeNull();
    // 会话里的工具：工具包列了才有，联网关着时没有要联网的
    expect(mcp.hostToolsFor({ mcp: [], network: true })).toEqual([]);
    expect(mcp.hostToolsFor({ mcp: ["notes"], network: false }).map((t) => t.spec.name)).toEqual(["mcp__notes__search"]);
    // 装配时在后台拉起了服务进程（拿参数说明）：停掉
    await mcp.stop();
  });
});
