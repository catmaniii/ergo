// 312 号票：系统里的 ergou 换成了 ergo，兼容期旧名字照样认（读新旧都认、新的优先，写只写新的）。这里逐处核对守护进程这边认旧名字的地方：
// 数据目录和环境变量、数据目录里旧名字的文件、配对 cookie、交给子进程的环境变量和测试标记、Claude Code 插件和 MCP 服务的旧名字、
// 会话文件里旧名字的自定义类型、事件来源和项目操作的旧写法、守卫认旧的数据目录名、旧的临时目录、skill 集合的旧清单、用户语言文件里的旧 key、
// 部署时停用旧名字的 nginx 站点。经网关的（cookie、旧名字的事件库）另见 test/main/old-names.test.ts，迁移脚本见 test/migrate/。
// 这里刻意写着旧名字（ergou），是兼容的测试。
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ensureWorkTempDir } from "../src/agent-manager/work-temp.ts";
import { rewriteSetCookie, withoutOwnCookies } from "../src/apps/proxy.ts";
import { createAppRegistry } from "../src/apps/registry.ts";
import { hostToolNameOf } from "../src/claude-code/child/host-tools.ts";
import { buildSkillPlugin } from "../src/claude-code/skill-plugin.ts";
import { loadConfig } from "../src/config/config.ts";
import { dataDirLayout } from "../src/config/data-dir.ts";
import { envValue, oldEnvNamesIn, oldNameNotes, pathOrOld, withOldEnvNames } from "../src/config/old-names.ts";
import { slashPassthroughText } from "../src/conversation/agent-input.ts";
import { remoteScript } from "../src/deploy/deploy.ts";
import { dataDirMentions } from "../src/guard/bottom-line-risk.ts";
import { readLocaleRoot } from "../src/i18n/files.ts";
import { DEVICE_COOKIE, oldCookieClears, PAIRING_COOKIE, readCookieOrOld } from "../src/pairing/credentials.ts";
import { callBody } from "../src/project-ops/call.ts";
import { parseOpsManifest } from "../src/project-ops/manifest.ts";
import { problemText } from "../src/project-ops/problems.ts";
import { runScriptOp } from "../src/project-ops/script.ts";
import { lsmDefinition, normalizeService, serviceProblems } from "../src/project-services/spec.ts";
import { buildChildEnv } from "../src/process/child-env.ts";
import { isSessionType, SCOPE_REVIEW_ENTRY, SESSION_INPUT_TAG, type SessionRewriteRequest } from "../src/runtime/host-protocol.ts";
import { runSessionRewrite } from "../src/runtime/index.ts";
import { createSkillLibrary } from "../src/skills/library.ts";
import { ergoCommandsIn } from "../src/slash-commands/commands.ts";
import { eventShellEnv } from "../src/tasks/workflow-events.ts";
import { makeTempDir } from "./helpers/temp-dir.ts";
import { writeSkill } from "./helpers/toolkit.ts";

/** 有网页的一条服务（环境变量另给） */
const item = (env: Array<{ name: string; value: string }> = []) => ({ key: "web", name: "网页", means: "service" as const, instructions: "网页", capabilities: {}, service: { name: "web", command: "node s.mjs", port: 18080, web: {}, env } });
const user = (text: string) => ({ speaker: "user" as const, parts: [{ type: "text" as const, text }] });

function write(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

describe("环境变量：新名字优先，没设看旧名字", () => {
  it("envValue、交给子进程的另带旧名字、启动时认出还在用旧名字的", () => {
    expect(envValue({ ERGOU_MODELS_DIR: " D:/old " }, "ERGO_MODELS_DIR")).toBe("D:/old");
    expect(envValue({ ERGO_MODELS_DIR: "D:/new", ERGOU_MODELS_DIR: "D:/old" }, "ERGO_MODELS_DIR")).toBe("D:/new");
    expect(envValue({ ERGO_MODELS_DIR: "  ", ERGOU_MODELS_DIR: "D:/old" }, "ERGO_MODELS_DIR")).toBe("D:/old");
    expect(envValue({}, "ERGO_MODELS_DIR")).toBeUndefined();
    expect(withOldEnvNames({ ERGO_OPS_OP: "x", TMPDIR: "t" })).toEqual({ ERGO_OPS_OP: "x", ERGOU_OPS_OP: "x", TMPDIR: "t" });
    expect(oldEnvNamesIn({ ERGOU_DATA_DIR: "D:/d", ERGOU_TEST_WORKERS: "", PATH: "p", ERGO_X: "1" })).toEqual([{ old: "ERGOU_DATA_DIR", name: "ERGO_DATA_DIR" }]);
  });
});

describe("数据目录", () => {
  it("ERGO_DATA_DIR 没设看旧的 ERGOU_DATA_DIR；两个都设了用新的", () => {
    const home = makeTempDir("ergo-home-");
    expect(loadConfig({ env: { ERGOU_DATA_DIR: path.join(home, "old") }, homeDir: home })).toMatchObject({ dataDir: path.join(home, "old"), dataDirFrom: "env_old" });
    expect(loadConfig({ env: { ERGO_DATA_DIR: path.join(home, "new"), ERGOU_DATA_DIR: path.join(home, "old") }, homeDir: home })).toMatchObject({ dataDir: path.join(home, "new"), dataDirFrom: "env" });
  });

  it("默认 ~/.ergo；~/.ergo 不在而 ~/.ergou 在时用 ~/.ergou（启动时提示一次）；两个都在用新的", () => {
    const home = makeTempDir("ergo-home-");
    expect(loadConfig({ env: {}, homeDir: home })).toMatchObject({ dataDir: path.join(home, ".ergo"), dataDirFrom: "default" });
    fs.mkdirSync(path.join(home, ".ergou"));
    const old = loadConfig({ env: {}, homeDir: home });
    expect(old).toMatchObject({ dataDir: path.join(home, ".ergou"), dataDirFrom: "default_old" });
    expect(oldNameNotes(old, dataDirLayout(old.dataDir), {}).join("\n")).toContain("npm run migrate:ergo");
    fs.mkdirSync(path.join(home, ".ergo"));
    expect(loadConfig({ env: {}, homeDir: home })).toMatchObject({ dataDir: path.join(home, ".ergo"), dataDirFrom: "default" });
  });

  it("数据目录里的 config/ergou.json、db/ergou.db：新名字的不在时用旧的（配置照样读得到），两个都在、都不在用新的", () => {
    const dataDir = makeTempDir("ergo-data-");
    expect(dataDirLayout(dataDir)).toMatchObject({ configFile: path.join(dataDir, "config", "ergo.json"), eventsDb: path.join(dataDir, "db", "ergo.db") });
    write(path.join(dataDir, "config", "ergou.json"), JSON.stringify({ ports: { local: 18123, external: 18124 } }));
    write(path.join(dataDir, "db", "ergou.db"), "");
    const layout = dataDirLayout(dataDir);
    expect(layout).toMatchObject({ configFile: path.join(dataDir, "config", "ergou.json"), eventsDb: path.join(dataDir, "db", "ergou.db") });
    expect(loadConfig({ env: { ERGO_DATA_DIR: dataDir }, homeDir: dataDir }).ports).toEqual({ local: 18123, external: 18124 });
    const notes = oldNameNotes({ dataDir, dataDirFrom: "env" }, layout, { ERGOU_MODELS_DIR: "x" });
    expect(notes).toEqual([expect.stringContaining("ergou.json"), expect.stringContaining("ergou.db"), "环境变量 ERGOU_MODELS_DIR 是旧名字（照样认）：换成 ERGO_MODELS_DIR"]);
    write(path.join(dataDir, "db", "ergo.db"), "");
    expect(dataDirLayout(dataDir).eventsDb).toBe(path.join(dataDir, "db", "ergo.db"));
    expect(pathOrOld(path.join(dataDir, "nothing", "ergo.json"))).toBe(path.join(dataDir, "nothing", "ergo.json"));
  });
});

describe("配对 cookie", () => {
  it("读时新旧都认（新的优先），请求里带着旧名字的回应时清掉", () => {
    expect(DEVICE_COOKIE).toBe("__Host-ergo-device");
    expect(readCookieOrOld("__Host-ergou-device=OLD", DEVICE_COOKIE)).toBe("OLD");
    expect(readCookieOrOld("__Host-ergou-device=OLD; __Host-ergo-device=NEW", DEVICE_COOKIE)).toBe("NEW");
    expect(readCookieOrOld("a=1", DEVICE_COOKIE)).toBeUndefined();
    expect(oldCookieClears("__Host-ergou-device=OLD; __Host-ergou-pairing=P", [DEVICE_COOKIE, PAIRING_COOKIE])).toEqual([
      "__Host-ergou-device=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=Strict",
      "__Host-ergou-pairing=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=Strict",
    ]);
    expect(oldCookieClears("__Host-ergo-device=NEW", [DEVICE_COOKIE])).toEqual([]);
  });

  it("转发给本机服务时旧名字的二狗 cookie 同样不转、不许服务写", () => {
    const registry = createAppRegistry();
    registry.register({ name: "intel", target: "http://127.0.0.1:5173" });
    const app = registry.get("intel")!;
    expect(withoutOwnCookies("sid=1; __Host-ergou-device=x; __Host-ergo-device=y; __Host-ergou-pairing=z")).toBe("sid=1");
    expect(rewriteSetCookie("__Host-ergou-device=x; Path=/; Secure", app)).toBeUndefined();
  });
});

describe("交给子进程、项目服务的：新旧两个名字都带", () => {
  it("项目操作的测试标记：_meta 里新旧两个键", () => {
    expect(JSON.parse(callBody("add", { a: 1 }, true))).toEqual({ name: "add", arguments: { a: 1 }, _meta: { "ergo/test": true, "ergou/test": true } });
  });

  it("项目操作的脚本：早先写的读 ERGOU_OPS_* 照样有值", async () => {
    const workdir = makeTempDir("ergo-ops-old-");
    write(
      path.join(workdir, "ops.mjs"),
      'process.stdout.write(JSON.stringify({ say: [process.env.ERGOU_OPS_PROJECT, process.env.ERGOU_OPS_OP, process.env.ERGOU_OPS_TEST, process.env.ERGO_OPS_OP].join(" ") }));\n',
    );
    const result = await runScriptOp({ workdir, file: "ops.mjs", args: [], projectId: "p-1", name: "report", arguments: {}, test: true, timeoutMs: 30_000 });
    expect(result).toMatchObject({ ok: true, reply: { say: "p-1 report 1 report" } });
  });

  it("有网页的服务：交给 LSM 的定义里 ERGO_BASE_PATH 另带一份旧名字的；方案里自己写旧名字的也拒", () => {
    const root = fs.realpathSync.native(makeTempDir("ergo-spec-"));
    const records = path.join(root, "projects", "p-1");
    const workdir = path.join(records, "workdir");
    fs.mkdirSync(workdir, { recursive: true });
    const ctx = { projectId: "p-1", workdir, records, takenPorts: () => new Map<number, string>() };
    const service = normalizeService(item().service, ctx);
    expect(lsmDefinition(service, { title: "网页", projectName: "简报站" }, "D:/s").env).toEqual([
      { name: "ERGO_BASE_PATH", from: "literal", value: "/apps/p-1-web" },
      { name: "ERGOU_BASE_PATH", from: "literal", value: "/apps/p-1-web" },
    ]);
    expect(serviceProblems(item([{ name: "ERGOU_BASE_PATH", value: "/x" }]), ctx)).toHaveLength(1);
  });

  it("事件触发的流程里 bash 的环境变量：ERGO_EVENT_* 另带一份旧名字的", () => {
    const env = eventShellEnv([{ source: "folder", event: "created", at: "2026-10-26T10:00:00.000+08:00", summary: "a.pdf", data: { path: "D:\\收件箱\\a.pdf", name: "a.pdf" } }]);
    expect(env).toMatchObject({ ERGO_EVENT_1_PATH: "D:\\收件箱\\a.pdf", ERGOU_EVENT_1_PATH: "D:\\收件箱\\a.pdf", ERGOU_EVENT_1_NAME: "a.pdf" });
  });
});

describe("Claude Code：插件、MCP 服务以前叫 ergou", () => {
  it("接管的旧会话记录里 mcp__ergou__<工具> 同样换回二狗的工具名", () => {
    expect(hostToolNameOf("mcp__ergo__submit_plan")).toBe("submit_plan");
    expect(hostToolNameOf("mcp__ergou__submit_plan")).toBe("submit_plan");
    expect(hostToolNameOf("mcp__notes__search")).toBe("mcp__notes__search");
  });

  it("拼插件时旧名字的插件目录（缓存）顺手删掉，新的叫 ergo", () => {
    const runtimeDir = makeTempDir("ergo-claude-runtime-");
    write(path.join(runtimeDir, "ergou", "skills", "old", "SKILL.md"), "旧的");
    const skill = writeSkill(path.join(makeTempDir("ergo-skill-src-"), "tdd"), "tdd", "测试驱动");
    const built = buildSkillPlugin(runtimeDir, [skill]);
    expect(built.root).toBe(path.join(runtimeDir, "ergo"));
    expect(fs.existsSync(path.join(runtimeDir, "ergou"))).toBe(false);
    expect(JSON.parse(fs.readFileSync(path.join(runtimeDir, "ergo", ".claude-plugin", "plugin.json"), "utf8"))).toMatchObject({ name: "ergo" });
  });

  it("按旧习惯打的 /ergou:<目录名> 换成 /ergo:<目录名>（后面的话照留）", () => {
    const ctx = {
      slashPassthrough: true,
      ergoCommands: ergoCommandsIn("task"),
      skillDirs: ["/skills/weekly-report"],
      skillCommands: () => [{ command: "weekly-report", name: "weekly-report", description: "写周报", dir: "/skills/weekly-report" }],
      runtimeSlash: { skillCommands: (dirs: readonly string[]) => dirs.map((d) => `ergo:${d.split("/").at(-1)!}`), commands: () => ["compact"] },
    };
    expect(slashPassthroughText(ctx, user("/ergou:weekly-report 写本周的"))).toBe("/ergo:weekly-report 写本周的");
    expect(slashPassthroughText(ctx, user("/ergou:unknown"))).toBe("/ergou:unknown");
  });
});

describe("会话文件里旧名字的自定义类型", () => {
  it("isSessionType 新旧都认；彻底删除（一次性子进程）照样找得到旧名字的输入标记、范围审视的副本", async () => {
    expect(isSessionType("ergou-input", SESSION_INPUT_TAG)).toBe(true);
    expect(isSessionType("ergo-input", SESSION_INPUT_TAG)).toBe(true);
    expect(isSessionType("ergou-input-context", SESSION_INPUT_TAG)).toBe(false);
    const dir = makeTempDir("ergo-rewrite-old-");
    const file = path.join(dir, "2026-10-01T00-00-00.000Z_s-1.jsonl");
    const text = [
      { type: "session", version: 3, id: "s-1", timestamp: "2026-10-01T00:00:00.000Z", cwd: dir },
      { type: "custom", id: "e1", parentId: null, timestamp: "2026-10-01T00:00:01.000Z", customType: "ergou-input", data: { inputId: "m-1" } },
      { type: "message", id: "e2", parentId: "e1", timestamp: "2026-10-01T00:00:02.000Z", message: { role: "user", content: [{ type: "text", text: "我的身份证号是 110101" }], timestamp: 1 } },
      { type: "custom", id: "e3", parentId: "e2", timestamp: "2026-10-01T00:00:03.000Z", customType: "ergou-scope-review", data: { findings: [{ summary: "身份证号 110101" }] } },
    ]
      .map((e) => JSON.stringify(e))
      .join("\n");
    fs.writeFileSync(file, `${text}\n`);
    const request: SessionRewriteRequest = { sessionDir: dir, inputIds: ["m-1"], toolCallIds: [], toolResultLines: [], marker: "[已删除]", summaryMarker: "[摘要已删除]", customTypes: [SCOPE_REVIEW_ENTRY] };
    await runSessionRewrite(request, { env: buildChildEnv(process.env, {}) });
    const after = fs.readFileSync(file, "utf8");
    expect(after).not.toContain("110101");
    expect(after).toContain("[已删除]");
  });
});

describe("存着的旧写法", () => {
  it("项目的运营接口清单里二狗自带动作写作 ergou 的照样认；早先存下的问题 code 照样说得出", () => {
    const parsed = parseOpsManifest(JSON.stringify({ tools: [{ name: "status", impl: { type: "ergou", action: "status" } }] }));
    expect(parsed).toMatchObject({ kind: "ok", ops: [{ name: "status", impl: { type: "ergo", action: "status" } }] });
    expect(problemText({ code: "ergouAction" as never, params: { name: "a", action: "b", actions: "c" } })).toBe(problemText({ code: "ergoAction", params: { name: "a", action: "b", actions: "c" } }));
  });

  it("用户语言文件里的旧 key 换成新的（同一份文件里新旧都写了的新的为准）", () => {
    const root = makeTempDir("ergo-locales-");
    write(path.join(root, "ja", "protocol.json"), JSON.stringify({ "protocol.eventSources.ergou.label": "旧", "protocol.eventSources.ergou.hint": "旧的提示", "protocol.eventSources.ergo.hint": "新的提示" }));
    const messages = readLocaleRoot(root).dirs[0]!.files[0]!.messages;
    expect(messages).toEqual({ "protocol.eventSources.ergo.label": "旧", "protocol.eventSources.ergo.hint": "新的提示" });
  });

  it("skill 区里清单还是旧名字（ergou-collection.json）的集合照样认", () => {
    const dataDir = makeTempDir("ergo-data-");
    const userDir = path.join(dataDir, "skills");
    writeSkill(path.join(userDir, "pack", "alpha"), "alpha", "第一个");
    const manifest = { format: 1, name: "pack", source: "s", version: "1", description: "d", members: ["alpha"], importedFrom: "D:/x", importedAt: "2026-10-01T00:00:00.000+08:00" };
    write(path.join(userDir, "pack", "ergou-collection.json"), JSON.stringify(manifest));
    const lib = createSkillLibrary({ builtinDir: makeTempDir("ergo-builtin-skills-"), userDir, dataDir, log: () => {} });
    expect(lib.list()).toEqual([expect.objectContaining({ name: "alpha", collection: "pack" })]);
  });
});

describe("守卫、临时目录、部署", () => {
  it("守卫认旧的数据目录名（迁移后是指到数据目录的目录联接）和它的短名", () => {
    const home = "C:\\Users\\me";
    const ctx = { dataDir: `${home}\\.ergo`, areas: [], homeDir: home, ownDirs: [] };
    expect(dataDirMentions("cat ~/.ergou/secrets/deepseek-api-key.txt", ctx).dataDir).toBe(true);
    expect(dataDirMentions('type "C:\\Users\\ME~1\\ERGOU~1\\secrets\\k.txt"', ctx).dataDir).toBe(true);
    expect(dataDirMentions("cat ~/.ergo/secrets/k.txt", ctx).dataDir).toBe(true);
    expect(dataDirMentions("cat ~/notes/a.txt", ctx).dataDir).toBe(false);
  });

  it("写在旧名字的数据目录下的路径照数据目录里的同一处判：自己的工作目录还算自己的，密钥区照样挡", () => {
    const home = "C:\\Users\\me";
    const secrets = { dir: `${home}\\.ergo\\secrets`, title: "密钥区", secrets: true };
    const ctx = { dataDir: `${home}\\.ergo`, areas: [secrets], homeDir: home, ownDirs: [`${home}\\.ergo\\projects\\p-1\\workdir`] };
    expect(dataDirMentions("python C:\\Users\\me\\.ergou\\projects\\p-1\\workdir\\build.py", ctx)).toMatchObject({ dataDir: false, areas: [] });
    expect(dataDirMentions("type C:\\Users\\me\\.ergou\\secrets\\k.txt", ctx).areas).toEqual([secrets]);
    expect(dataDirMentions("type C:\\Users\\me\\.ergou\\config\\ergo.json", ctx).dataDir).toBe(true);
  });

  it("工作目录里旧的临时目录 .ergou-tmp：新的还没有时改名过来，里面的东西照留", () => {
    const cwd = makeTempDir("ergo-cwd-");
    write(path.join(cwd, ".ergou-tmp", "keep.txt"), "x");
    ensureWorkTempDir(path.join(cwd, ".ergo-tmp"), Date.now(), () => {});
    expect(fs.existsSync(path.join(cwd, ".ergou-tmp"))).toBe(false);
    expect(fs.readFileSync(path.join(cwd, ".ergo-tmp", "keep.txt"), "utf8")).toBe("x");
  });

  it("部署 nginx 站点：旧名字的站点从 sites-enabled 拿掉（在 nginx -t 之前），没通过时连它一起恢复", () => {
    const script = remoteScript("server {}\n");
    const off = script.indexOf("rm -f /etc/nginx/sites-enabled/ergou.conf");
    expect(off).toBeGreaterThan(script.indexOf("ln -sf /etc/nginx/sites-available/ergo.conf /etc/nginx/sites-enabled/ergo.conf"));
    expect(off).toBeLessThan(script.indexOf("if nginx -t"));
    expect(script).toContain("ln -sf /etc/nginx/sites-available/ergou.conf /etc/nginx/sites-enabled/ergou.conf");
  });
});
