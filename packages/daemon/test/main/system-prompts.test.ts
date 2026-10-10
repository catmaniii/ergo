// 主切面：各 agent 的系统提示放进可编辑的 md 文件（71 号票）。
// - 设置里的"系统提示"经 HTTP：列出全部、看一份、保存（占位符写错的拒收，说清第几行错在哪）、恢复默认；改的存在数据目录配置区的 prompts/；
// - 改了秘书的提示或前缀：手头这一条处理完就按新的重新拉起，从下一轮起生效（不重启守护进程）；
// - 直接改数据目录里的文件也行：秘书下一轮（按文件的修改时间看出来）、维护者下一次被唤起时读到新的；
// - 启动时用户改的提示有错：守护进程不启动，报清楚是哪个文件哪一行，不默默用空串。
import fs from "node:fs";
import path from "node:path";
import { CHANNELS, EVENT_TYPES, maintainerChannel, type MessageEventPayload } from "@ergou/protocol";
import { describe, expect, it } from "vitest";
import { dataDirLayout } from "../../src/config/data-dir.ts";
import { startTestDaemon } from "../helpers/daemon.ts";
import { TestFrontend } from "../helpers/frontend.ts";
import { systemPromptsApi } from "../helpers/http.ts";
import { waitUntil } from "../helpers/process.ts";
import { makeTempDir } from "../helpers/temp-dir.ts";

const SECRETARY = CHANNELS.secretary;
const textOf = (payload: MessageEventPayload) => payload.message.parts.map((p) => (p.type === "text" ? p.text : "")).join("");

/**
 * faux 回显的上下文里生效的那条系统提示：换了系统提示接着会话时 pi 在中途记一条，生效的是最后一条。
 * 会话开头那条后面跟着工作目录和工具清单（<cwd>、[tool]），中途那条后面直接是用户消息
 */
function latestSystemPromptIn(seen: string): string {
  const latest = seen.slice(seen.lastIndexOf("[system] ") + "[system] ".length);
  const ends = ["\n\n<cwd>", "\n[user]"].map((m) => latest.indexOf(m)).filter((i) => i >= 0);
  return latest.slice(0, Math.min(...ends));
}

/** 发一句、等秘书回显上下文，取生效的那条系统提示 */
async function latestSystemPrompt(frontend: TestFrontend, text: string): Promise<string> {
  await frontend.sendText(text);
  await frontend.next(SECRETARY, EVENT_TYPES.message);
  const seen = textOf((await frontend.next(SECRETARY, EVENT_TYPES.message)).payload as MessageEventPayload);
  await frontend.next(SECRETARY, EVENT_TYPES.turnEnd);
  return latestSystemPromptIn(seen);
}

describe("设置里的系统提示（HTTP）", () => {
  it("列出全部、看一份；保存存进数据目录配置区的 prompts/；占位符写错的拒收、说清第几行；恢复默认删掉用户的那份", async () => {
    const { url, dataDir } = await startTestDaemon();
    const dir = dataDirLayout(dataDir).prompts;

    const list = await systemPromptsApi.list(url);
    expect(list.status).toBe(200);
    expect(list.body.userDir).toBe(dir);
    expect(list.body.prompts.map((p) => [p.id, p.group, p.state]).slice(0, 3)).toEqual([
      ["prefix", "prefix", "default"],
      ["secretary", "role", "default"],
      ["secretary-compaction", "role", "default"],
    ]);

    const detail = await systemPromptsApi.get(url, "secretary");
    expect(detail.status).toBe(200);
    expect(detail.body.content).toMatch(/^你是「二狗」的秘书/);
    expect(detail.body.content).toContain("用户叫你「{{名字}}」");
    expect(detail.body.placeholders).toEqual(expect.arrayContaining([expect.objectContaining({ name: "名字", kind: "value" }), expect.objectContaining({ name: "对话审批开着", kind: "flag" })]));
    expect(await systemPromptsApi.get(url, "nope")).toMatchObject({ status: 404, body: { code: "not_found" } });

    const bad = await systemPromptsApi.save(url, "secretary", "你是秘书。\n用户叫你「{{名子}}」。");
    expect(bad).toMatchObject({ status: 400, body: { code: "bad_request" } });
    expect(bad.body.message).toContain("第 2 行：不认得的占位符 {{名子}}");
    expect(fs.existsSync(path.join(dir, "secretary.md"))).toBe(false);

    const saved = await systemPromptsApi.save(url, "secretary", "你是我的管家「{{名字}}」。");
    expect(saved).toMatchObject({ status: 200, body: { state: "custom", content: "你是我的管家「{{名字}}」。" } });
    expect(fs.readFileSync(path.join(dir, "secretary.md"), "utf8")).toBe("你是我的管家「{{名字}}」。\n");
    expect((await systemPromptsApi.list(url)).body.prompts.find((p) => p.id === "secretary")?.state).toBe("custom");

    const reset = await systemPromptsApi.reset(url, "secretary");
    expect(reset).toMatchObject({ status: 200, body: { state: "default" } });
    expect(reset.body.content).toBe(detail.body.content);
    expect(fs.existsSync(path.join(dir, "secretary.md"))).toBe(false);
  });
});

describe("改了就生效，不用重启守护进程", () => {
  it("改了秘书的提示和前缀：从下一轮起按新的；恢复默认后又回到默认的", { timeout: 60_000 }, async () => {
    // faux 的剧本每个子进程从头来：改了提示重新拉起的子进程也是回显
    const echo = { kind: "echo_context" } as const;
    const { url } = await startTestDaemon({ secretary: [echo, echo, echo] });
    const frontend = await TestFrontend.connect(url);
    await frontend.subscribe({ [SECRETARY]: 0 });

    const before = await latestSystemPrompt(frontend, "第一句");
    expect(before).toMatch(/^你是「二狗」的秘书/);

    expect((await systemPromptsApi.save(url, "secretary", "你是我的管家「{{名字}}」。")).status).toBe(200);
    expect((await systemPromptsApi.save(url, "prefix", "我住在新加坡。")).status).toBe(200);
    expect(await latestSystemPrompt(frontend, "第二句")).toBe("我住在新加坡。\n\n你是我的管家「个人助理」。");

    await systemPromptsApi.reset(url, "secretary");
    await systemPromptsApi.reset(url, "prefix");
    expect(await latestSystemPrompt(frontend, "第三句")).toBe(before);
  });

  it("直接改数据目录里秘书的提示文件（没经设置页）：也是下一轮就读到新的", { timeout: 60_000 }, async () => {
    const echo = { kind: "echo_context" } as const;
    const td = await startTestDaemon({ secretary: [echo, echo] });
    const frontend = await TestFrontend.connect(td.url);
    await frontend.subscribe({ [SECRETARY]: 0 });
    expect(await latestSystemPrompt(frontend, "第一句")).toMatch(/^你是「二狗」的秘书/);

    const dir = dataDirLayout(td.dataDir).prompts;
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "secretary.md"), "你是直接改过的管家「{{名字}}」。");
    expect(await latestSystemPrompt(frontend, "第二句")).toBe("你是直接改过的管家「个人助理」。");
  });

  it("直接改数据目录里的文件：维护者下一次被唤起时读到新的", { timeout: 60_000 }, async () => {
    const td = await startTestDaemon({ maintainer: [{ kind: "echo_context" }] });
    const frontend = await TestFrontend.connect(td.url);
    const tm1 = maintainerChannel("tm-1");
    await frontend.subscribe({ [tm1]: 0 });
    const dir = dataDirLayout(td.dataDir).prompts;
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "task-maintainer.md"), "你是改过的任务维护者：被拉回 {{拉回次数}} 次后再犯就停下，交计划用 {{submit_plan}}。\r\n");

    const task = td.daemon.tasks.createByRequest({ title: "X 的调研", summary: "X 的调研" });
    td.daemon.tasks.writeBrief(task.id, { goal: "整理一份 X 的调研", acceptanceCriteria: ["附来源"], constraints: [], projects: [], memoryScope: "" });
    const reply = () =>
      frontend
        .events({ channel: tm1, type: EVENT_TYPES.message })
        .map((f) => f.payload as MessageEventPayload)
        .find((m) => m.message.speaker === "agent" && textOf(m).includes("[system] "));
    await waitUntil(() => reply() !== undefined, { timeoutMs: 30_000, describe: () => "等维护者回显上下文" });
    expect(latestSystemPromptIn(textOf(reply()!))).toBe("你是改过的任务维护者：被拉回 3 次后再犯就停下，交计划用 submit_plan。");
  });
});

describe("启动时查一遍", () => {
  it("数据目录里改过的提示有错：守护进程不启动，报清楚是哪个文件哪一行", async () => {
    const dataDir = makeTempDir("ergou-data-");
    const homeDir = makeTempDir("ergou-home-");
    const file = path.join(dataDirLayout(dataDir).prompts, "job-maintainer.md");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "你是定时作业的维护者。\n连续失败 {{连续失败次数}} 次暂停。\n");
    await expect(startTestDaemon({ reuse: { dataDir, homeDir } })).rejects.toThrow(`${file} 有错（改好，或者删掉它恢复默认）：\n第 2 行：不认得的占位符 {{连续失败次数}}`);
  });
});
