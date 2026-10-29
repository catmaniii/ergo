// 主切面：角色（248 号票）——名字 + 音色绑成一个角色，设置 · 角色与声音里维护、每个 agent 只选一个。
// 用户 2026-10-22 定的三件事：
// - 角色只给 agent 用：选中一个角色就是同时启用它的名字和音色；
// - 每个 agent 可以选跟默认角色（没指定就用默认的角色）或者某个角色；
// - 旧配置（241 号票的 agent-profiles.json）自动迁移，一个不丢；旧的 GET /api/agent-profiles 只保留只读兼容。
// 这里跑的是真的守护进程（模型是 faux、合成服务是假的、参考音色是编的示例）：
// - 迁移：起之前放着旧配置和全局名字，起来之后角色表对得上、名字和音色都没丢、旧文件还在、再起一次不重复迁移；
// - 列表：秘书、每个在的项目维护者、每个在的任务维护者、记忆管理员，默认角色标出来，谁在用写清楚；
// - 增删改：名字不合规、音色不存在 400，默认角色不能删、在用角色不能删（说清是谁）；
// - 生效：改默认角色 → 没指定的 agent 名字和音色一起变（系统提示 + 假 TTS 的 voice_ref）；给某个 agent 指定角色 → 只有它变；
// - 语音插件停用：名字和角色照常，音色写"语音插件没启用"；
// - ⚙：一个角色下拉（跟默认 / 各角色），面板上是"现在：名字 · 音色"；
// - 旧接口：GET 还能读（从角色算出来的），PUT 回 400 指路。
import fs from "node:fs";
import {
  type AgentProfilesView,
  type AgentRolesView,
  type AssistantNameEventPayload,
  CHANNELS,
  type ConversationId,
  EVENT_TYPES,
  maintainerChannel,
  type MessageEventPayload,
} from "@ergo/protocol";
import { describe, expect, it } from "vitest";
import { dataDirLayout } from "../../src/config/data-dir.ts";
import type { FauxStep } from "../../src/runtime/index.ts";
import { startTestDaemon } from "../helpers/daemon.ts";
import { stripTimeMarkers } from "../helpers/echo.ts";
import { TestFrontend } from "../helpers/frontend.ts";
import { agentProfilesApi, agentRolesApi, agentSettingsApi } from "../helpers/http.ts";
import { waitUntil } from "../helpers/process.ts";
import { seedProject } from "../helpers/projects.ts";
import { agentVoiceSettled, importReferenceVoice, startFakeSpeechService } from "../helpers/tts.ts";
import { makeTempDir } from "../helpers/temp-dir.ts";
import { sendVoice } from "../helpers/voice.ts";

const { secretary: SECRETARY, assistantName: ASSISTANT } = CHANNELS;
const PM1 = maintainerChannel("pm-1");

const ECHO: FauxStep = { kind: "echo_context" };
const echoes = (n: number): FauxStep[] => Array.from({ length: n }, () => ECHO);
const say = (text: string): FauxStep => ({ kind: "reply", text });

const textOf = (payload: MessageEventPayload) => payload.message.parts.map((p) => (p.type === "text" ? p.text : "")).join("");
const messagesOf = (frontend: TestFrontend, channel: string) => frontend.events({ channel, type: EVENT_TYPES.message }).map((f) => f.payload as MessageEventPayload);
const turnEnds = (frontend: TestFrontend, channel: string) => frontend.events({ channel, type: EVENT_TYPES.turnEnd }).length;

/** 说一句，等这个会话又处理完一条，返回 agent 最后说的（回显的上下文去掉时间标记） */
async function say1(frontend: TestFrontend, text: string, conversation: ConversationId = SECRETARY): Promise<string> {
  const before = turnEnds(frontend, conversation);
  await frontend.sendText(text, { conversation });
  await waitUntil(() => turnEnds(frontend, conversation) > before, { timeoutMs: 30_000, describe: () => `等 ${conversation} 处理完「${text.slice(0, 10)}」` });
  const reply = messagesOf(frontend, conversation).findLast((m) => m.message.speaker === "agent");
  return stripTimeMarkers(reply ? textOf(reply) : "");
}

/** 回显里这一轮的系统提示（换了提示接着原会话时 pi 在会话中途记一条新的系统消息，取最后一条） */
const systemOf = (echo: string) => {
  const rest = echo.slice(echo.lastIndexOf("[system] "));
  const end = rest.search(/\n\n<cwd>|\n\[(user|assistant|tool|system)\] /);
  return end < 0 ? rest : rest.slice(0, end);
};

/** 角色表里的一行 */
const roleOf = (view: AgentRolesView, roleId: string) => view.roles.find((role) => role.id === roleId);
const agentRowOf = (view: AgentRolesView, agentId: string) => view.agents.find((agent) => agent.agentId === agentId);
const roleNamed = (view: AgentRolesView, name: string) => view.roles.find((role) => role.name === name);
const idsOf = (view: AgentRolesView) => view.agents.map((agent) => agent.agentId);

/** 起守护进程之前先造一份数据目录（旧配置、全局名字），起来之后用同一份 */
function seedDataDir(files: { legacy?: unknown; name?: string }): { dataDir: string; homeDir: string } {
  const dataDir = makeTempDir("ergo-roles-data-");
  const homeDir = makeTempDir("ergo-roles-home-");
  const layout = dataDirLayout(dataDir);
  fs.mkdirSync(layout.config, { recursive: true });
  if (files.legacy !== undefined) fs.writeFileSync(layout.agentProfilesFile, JSON.stringify(files.legacy));
  if (files.name !== undefined) fs.writeFileSync(layout.assistantNameFile, JSON.stringify({ format: 1, name: files.name }));
  return { dataDir, homeDir };
}

describe("迁移：旧的名字音色配置一个不丢地迁进角色表", () => {
  it("默认角色用全局名字；和默认角色不一样的 agent 各一个角色；旧文件保留；再起一次不重复迁移", async () => {
    const seeded = seedDataDir({
      legacy: { format: 1, agents: { secretary: { name: "小明" }, "pm-1": { name: "老王" } } },
      name: "阿福",
    });
    const td = await startTestDaemon({ reuse: seeded });
    seedProject(td.daemon, "记账本");
    td.daemon.tasks.createByRequest({ title: "整理笔记", summary: "整理笔记" });

    // 迁移写出来的文件：默认角色是全局名字（阿福）+ 全局选中的音色（这时还没有参考音色，所以没写进去）
    const stored = JSON.parse(fs.readFileSync(dataDirLayout(td.dataDir).agentRolesFile, "utf8")) as { defaultRoleId: string; roles: { id: string; name: string }[]; assignments: Record<string, string> };
    expect(stored.roles[0]).toMatchObject({ name: "阿福" });
    expect(stored.defaultRoleId).toBe(stored.roles[0]!.id);
    expect(stored.assignments["secretary"]).toBeDefined();
    expect(stored.assignments["pm-1"]).toBeDefined();
    // 旧文件保留不删
    expect(fs.existsSync(dataDirLayout(td.dataDir).agentProfilesFile)).toBe(true);

    // 接口读出来：名字一个不丢，默认角色上写着谁在用（没指定的都算）
    const listed = await agentRolesApi.list(td.url);
    expect(listed.status).toBe(200);
    const view = listed.body;
    expect(idsOf(view)).toEqual(["secretary", "pm-1", "tm-1", "memory-curator"]);
    expect(roleOf(view, view.defaultRoleId)!.name).toBe("阿福");
    expect(agentRowOf(view, "secretary")!.identity).toMatchObject({ name: "小明", nameSource: "own", defaultName: "阿福" });
    expect(agentRowOf(view, "pm-1")!.identity).toMatchObject({ name: "老王", nameSource: "own" });
    expect(agentRowOf(view, "tm-1")!.identity).toMatchObject({ name: "阿福", nameSource: "default" });
    expect(roleOf(view, view.defaultRoleId)!.usedBy).toEqual(expect.arrayContaining(["tm-1", "memory-curator"]));
    expect(view.voiceUnavailable).toBeUndefined();

    // 再起一次（同一份数据目录）：不重复迁移（旧配置改了也不管）
    await td.daemon.stop();
    fs.writeFileSync(dataDirLayout(td.dataDir).agentProfilesFile, JSON.stringify({ format: 1, agents: { "pm-2": { name: "小美" } } }));
    const again = await startTestDaemon({ reuse: { dataDir: td.dataDir, homeDir: td.homeDir } });
    const reloaded = (await agentRolesApi.list(again.url)).body;
    expect(roleNamed(reloaded, "小美")).toBeUndefined();
    expect(agentRowOf(reloaded, "secretary")!.identity.name).toBe("小明");
  });
});

describe("角色表：默认角色标出来，谁在用写清楚", () => {
  it("列出秘书、项目/任务维护者、记忆管理员；新建之后没人用；给 agent 指定之后谁在用跟着变", async () => {
    const td = await startTestDaemon();
    seedProject(td.daemon, "记账本");
    const listed = await agentRolesApi.list(td.url);
    expect(idsOf(listed.body)).toEqual(["secretary", "pm-1", "memory-curator"]);
    const defaultRole = roleOf(listed.body, listed.body.defaultRoleId)!;
    expect(defaultRole).toMatchObject({ name: "二狗", isDefault: true });
    expect(defaultRole.usedBy).toEqual(idsOf(listed.body));

    const created = await agentRolesApi.create(td.url, { name: "小明" });
    expect(created.status).toBe(200);
    const xiaoming = roleNamed(created.body, "小明")!;
    expect(xiaoming.usedBy).toEqual([]);

    const assigned = await agentRolesApi.assign(td.url, "pm-1", xiaoming.id);
    expect(assigned.status).toBe(200);
    expect(roleOf(assigned.body, xiaoming.id)!.usedBy).toEqual(["pm-1"]);
    expect(roleOf(assigned.body, assigned.body.defaultRoleId)!.usedBy).toEqual(["secretary", "memory-curator"]);
    expect(agentRowOf(assigned.body, "pm-1")!.identity.ownRoleId).toBe(xiaoming.id);

    // 恢复跟默认
    const restored = await agentRolesApi.assign(td.url, "pm-1", null);
    expect(agentRowOf(restored.body, "pm-1")!.identity.ownRoleId).toBeUndefined();
    expect(roleOf(restored.body, xiaoming.id)!.usedBy).toEqual([]);
  });
});

describe("角色的增删改：校验、默认唯一、删在用回 400", () => {
  it("名字不合规、音色不存在回 400；默认角色不能删；还有 agent 在用的不能删（说清是谁）；没人用的能删", async () => {
    const td = await startTestDaemon();
    seedProject(td.daemon, "记账本");

    for (const bad of ["一二三四五六七八九", "老\n王", "  "]) {
      const res = await agentRolesApi.create(td.url, { name: bad });
      expect(res.status).toBe(400);
      expect((res.body as { code?: string }).code).toBe("bad_request");
    }
    // 音色不存在（语音插件在，但还没导入参考音色）
    expect((await agentRolesApi.create(td.url, { name: "小周", voiceId: "v-9" })).status).toBe(400);

    const listed = await agentRolesApi.list(td.url);
    const defaultId = listed.body.defaultRoleId;
    expect((await agentRolesApi.remove(td.url, defaultId)).status).toBe(400);
    expect(((await agentRolesApi.remove(td.url, defaultId)).body as { message?: string }).message).toContain("默认角色不能删");

    const created = await agentRolesApi.create(td.url, { name: "小明" });
    const xiaoming = roleNamed(created.body, "小明")!;
    await agentRolesApi.assign(td.url, "pm-1", xiaoming.id);
    const refused = await agentRolesApi.remove(td.url, xiaoming.id);
    expect(refused.status).toBe(400);
    expect((refused.body as { message?: string }).message).toContain("项目「记账本」的维护者");

    await agentRolesApi.assign(td.url, "pm-1", null);
    expect((await agentRolesApi.remove(td.url, xiaoming.id)).status).toBe(200);

    // 改名 / 换音色只改点名的那个角色
    const other = await agentRolesApi.create(td.url, { name: "老王" });
    const wang = roleNamed(other.body, "老王")!;
    const renamed = await agentRolesApi.update(td.url, wang.id, { name: "老张" });
    expect(roleOf(renamed.body, wang.id)!.name).toBe("老张");
    expect(roleOf(renamed.body, renamed.body.defaultRoleId)!.name).toBe("二狗");
    // 不存在的角色
    expect((await agentRolesApi.update(td.url, "role-nope", { name: "小周" })).status).toBe(404);
    expect((await agentRolesApi.assign(td.url, "pm-1", "role-nope")).status).toBe(404);
    expect((await agentRolesApi.assign(td.url, "nobody", wang.id)).status).toBe(404);
  });
});

describe("生效：默认角色的名字和音色，没指定的 agent 跟着一起变", () => {
  it("改默认角色的名字 → 全局名字、名字频道的事件、秘书的 ⚙ 和下一轮的系统提示都变", async () => {
    const { url } = await startTestDaemon({ secretary: echoes(4) });
    const frontend = await TestFrontend.connect(url);
    await frontend.subscribe({ [SECRETARY]: 0, [ASSISTANT]: 0 });

    const listed = await agentRolesApi.list(url);
    const defaultId = listed.body.defaultRoleId;
    expect(roleOf(listed.body, defaultId)).toMatchObject({ name: "二狗" });
    expect(agentRowOf(listed.body, "secretary")!.identity).toMatchObject({ name: "二狗", roleId: defaultId, nameSource: "default" });

    // 改默认角色的名字 = 改全局名字（43 号票）：名字频道上一条事件
    expect((await agentRolesApi.update(url, defaultId, { name: "阿福" })).status).toBe(200);
    await expect.poll(async () => frontend.events({ channel: ASSISTANT, type: EVENT_TYPES.assistantName }).map((f) => (f.payload as AssistantNameEventPayload).name)).toEqual(["阿福"]);
    const panel = await agentSettingsApi.view(url, "secretary");
    expect(panel.body.identity).toMatchObject({ name: "阿福", defaultName: "阿福", roleId: defaultId });
    expect(panel.body.prompt.effective).toContain("阿福");

    // 下一轮起：真的交到模型手里的系统提示里也是新名字
    const echo = await say1(frontend, "你叫什么");
    expect(systemOf(echo)).toContain("阿福");
  });

  it("改默认角色的音色 → 它说出来的一切的 voice_ref 跟着变（合成请求里的参考录音是那个）", async () => {
    const tts = await startFakeSpeechService();
    const { url } = await startTestDaemon({ secretary: [say("好的，明早九点提醒你交报告。")], speechUrl: tts.url });
    const frontend = await TestFrontend.connect(url);
    await frontend.subscribe({ [SECRETARY]: 0 });
    const first = await importReferenceVoice(url, "音色甲");
    const second = await importReferenceVoice(url, "音色乙");

    const listed = await agentRolesApi.list(url);
    const defaultId = listed.body.defaultRoleId;
    // 默认角色的音色就是全局选中的那个（最早导入的）
    expect(roleOf(listed.body, defaultId)).toMatchObject({ voiceId: first.id, voiceName: "音色甲" });
    expect(agentRowOf(listed.body, "secretary")!.identity).toMatchObject({ voiceId: first.id, voiceSource: "default" });

    // 改默认角色的音色 = 在语音页里选一个
    expect((await agentRolesApi.update(url, defaultId, { voiceId: second.id })).status).toBe(200);
    await sendVoice(frontend, url, { text: "明天早上九点提醒我交报告" });
    const done = await agentVoiceSettled(frontend, "done");
    expect(done.referenceVoice).toEqual({ id: second.id, name: "音色乙" });
    expect(tts.requests.at(-1)!.voiceRef).toContain(second.id);
    expect(tts.requests.at(-1)!.voiceRef).not.toContain(first.id);
    // 语音页里"现在用的"也跟着是它（默认音色就是默认角色的音色）
    expect(roleOf((await agentRolesApi.list(url)).body, defaultId)).toMatchObject({ voiceId: second.id });
  });

  it("给某个 agent 指定另一个角色：只有它的名字和音色变，秘书照旧；恢复跟默认又回去", async () => {
    const tts = await startFakeSpeechService();
    const reply = "我是老王，管线那边我盯着。";
    const td = await startTestDaemon({ maintainer: (id) => (id === "pm-1" ? [say(reply), say("好")] : []), speechUrl: tts.url });
    seedProject(td.daemon, "记账本");
    const first = await importReferenceVoice(td.url, "音色甲");
    const second = await importReferenceVoice(td.url, "音色乙");
    const created = await agentRolesApi.create(td.url, { name: "老王", voiceId: second.id });
    const wang = roleNamed(created.body, "老王")!;

    const assigned = await agentRolesApi.assign(td.url, "pm-1", wang.id);
    expect(agentRowOf(assigned.body, "pm-1")!.identity).toMatchObject({ name: "老王", nameSource: "own", voiceId: second.id, voiceName: "音色乙", voiceSource: "own" });
    expect(agentRowOf(assigned.body, "secretary")!.identity).toMatchObject({ name: "二狗", nameSource: "default", voiceId: first.id });

    // pm-1 的 ⚙ 上是它自己的名字和音色
    const panel = await agentSettingsApi.view(td.url, "pm-1");
    expect(panel.body.identity).toMatchObject({ name: "老王", ownRoleId: wang.id, voiceName: "音色乙" });
    expect(panel.body.prompt.effective).toContain("用户叫你「老王」");

    // 它说出来的话用角色指定的那个音色
    const frontend = await TestFrontend.connect(td.url);
    await frontend.subscribe({ [PM1]: 0 });
    await sendVoice(frontend, td.url, { text: "你是谁" }, { conversation: PM1 });
    const done = await agentVoiceSettled(frontend, "done");
    expect(done.referenceVoice).toEqual({ id: second.id, name: "音色乙" });
    expect(tts.requests.at(-1)!.voiceRef).toContain(second.id);

    // 恢复跟默认：名字和音色都回到默认角色
    const restored = await agentRolesApi.assign(td.url, "pm-1", null);
    expect(agentRowOf(restored.body, "pm-1")!.identity).toMatchObject({ name: "二狗", voiceId: first.id, voiceSource: "default" });
    expect((await agentSettingsApi.view(td.url, "pm-1")).body.prompt.effective).not.toContain("用户叫你");
  });
});

describe("语音插件停用：名字和角色照常，音色写\"语音插件没启用\"", () => {
  it("列表照样列得出角色和名字；写音色回 400 带原因；分配角色照常", async () => {
    const td = await startTestDaemon({ plugins: ["reminders", "memory", "calendar", "browsing", "claude-code", "phone", "google", "looki"] });
    seedProject(td.daemon, "记账本");
    const listed = await agentRolesApi.list(td.url);
    expect(listed.status).toBe(200);
    expect(listed.body.voiceUnavailable).toBe("语音插件没启用");
    expect(listed.body.voices).toBeUndefined();
    expect(agentRowOf(listed.body, "secretary")!.identity).toMatchObject({ name: "二狗", voiceSource: "none" });

    const refused = await agentRolesApi.create(td.url, { name: "小周", voiceId: "v-1" });
    expect(refused.status).toBe(400);
    expect((refused.body as { message?: string }).message).toContain("语音插件没启用");

    const created = await agentRolesApi.create(td.url, { name: "小周" });
    expect(created.status).toBe(200);
    const zhou = roleNamed(created.body, "小周")!;
    const assigned = await agentRolesApi.assign(td.url, "pm-1", zhou.id);
    expect(assigned.status).toBe(200);
    expect(agentRowOf(assigned.body, "pm-1")!.identity).toMatchObject({ name: "小周", voiceSource: "none" });
    // ⚙ 面板上也写着
    expect((await agentSettingsApi.view(td.url, "pm-1")).body.voiceUnavailable).toBe("语音插件没启用");
  });
});

describe("⚙ 面板：一个角色下拉", () => {
  it("面板带着角色选项和现在的角色；指定之后 ownRoleId 变了，选项里默认角色标出来", async () => {
    const td = await startTestDaemon();
    const before = await agentSettingsApi.view(td.url, "secretary");
    expect(before.body.identity.ownRoleId).toBeUndefined();
    expect(before.body.roles).toHaveLength(1);
    expect(before.body.roles[0]).toMatchObject({ name: "二狗", isDefault: true });

    const created = await agentRolesApi.create(td.url, { name: "小明" });
    const xiaoming = roleNamed(created.body, "小明")!;
    await agentRolesApi.assign(td.url, "secretary", xiaoming.id);
    const after = await agentSettingsApi.view(td.url, "secretary");
    expect(after.body.identity).toMatchObject({ name: "小明", ownRoleId: xiaoming.id, defaultName: "二狗" });
    expect(after.body.roles.map((role) => role.name)).toContain("小明");
  });
});

describe("旧的 /api/agent-profiles：只保留只读兼容", () => {
  it("GET 还能读，返回从角色算出来的结果（形状照旧）；PUT 回 400 并指到角色接口", async () => {
    const td = await startTestDaemon();
    const created = await agentRolesApi.create(td.url, { name: "小明" });
    const xiaoming = roleNamed(created.body, "小明")!;
    await agentRolesApi.assign(td.url, "secretary", xiaoming.id);

    const listed = await agentProfilesApi.list(td.url);
    expect(listed.status).toBe(200);
    const view = listed.body as AgentProfilesView;
    const row = view.agents.find((agent) => agent.agentId === "secretary")!;
    expect(row.identity).toMatchObject({ name: "小明", nameSource: "own", ownRoleId: xiaoming.id });

    const refused = await agentProfilesApi.change(td.url, "secretary", { name: "阿福" });
    expect(refused.status).toBe(400);
    expect((refused.body as { message?: string }).message).toContain("/api/agent-roles/assignments/");
  });
});
