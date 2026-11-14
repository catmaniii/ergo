// 主切面：从 GitHub 装 skill（465）经 HTTP——预览、安装、放弃三个接口；装完的在工具包目录里带着来源，秘书的 skill 选择、
// 项目的工具包里选得到。下载那一层是假的（test/helpers/fake-github.ts），压缩包在测试里现做，绝不连真网络。
import fs from "node:fs";
import path from "node:path";
import { CHANNELS, METHODS, type ResponseFrame } from "@ergo/protocol";
import { describe, expect, it } from "vitest";
import { dataDirLayout } from "../../src/config/data-dir.ts";
import { startTestDaemon } from "../helpers/daemon.ts";
import { fakeGithub, githubArchive, skillMd } from "../helpers/fake-github.ts";
import { TestFrontend } from "../helpers/frontend.ts";
import { seedToolkitProject, toolkit, toolkitApi } from "../helpers/toolkit.ts";

const SHA = "0123456789abcdef0123456789abcdef01234567";
/** 路径的后面几段（用 / 连） */
const tail = (p: string, n: number) => p.split(path.sep).slice(-n).join("/");
const ok = (r: ResponseFrame) => {
  if (!r.ok) throw new Error(`请求失败：${r.error.code} ${r.error.message}`);
  return r.result;
};

describe("经 HTTP 从 GitHub 装 skill", () => {
  it("单个、集合：预览、安装；工具包目录里带来源，秘书和项目的工具包选得到；放弃清掉临时目录；出错回一句人话", async () => {
    const gh = fakeGithub();
    gh.reply("https://github.com/acme/habit/archive/HEAD.tar.gz", { status: 200, body: githubArchive(`habit-${SHA}`, { "SKILL.md": skillMd("habit", "记习惯"), "run.sh": "echo\n" }, SHA) });
    gh.reply("https://github.com/acme/pack/archive/v2.0.0.tar.gz", {
      status: 200,
      body: githubArchive("pack-2.0.0", { "README.md": "# pack\n\n一套假的 skill。\n", "skills/a/SKILL.md": skillMd("pack-a", "甲"), "skills/b/SKILL.md": skillMd("pack-b", "乙") }, SHA),
    });
    const td = await startTestDaemon({ components: { transport: gh.transport } });
    const staged = dataDirLayout(td.dataDir).githubSkills;

    const single = await toolkitApi.githubPreview(td.url, "https://github.com/acme/habit");
    expect(single).toMatchObject({ status: 200, body: { kind: "single", repo: "acme/habit", commit: SHA, single: { name: "habit", description: "记习惯" }, scripts: ["run.sh"] } });
    expect(fs.readdirSync(staged)).toEqual([single.body.previewId]);
    expect(await toolkitApi.githubInstall(td.url, { previewId: single.body.previewId })).toMatchObject({ status: 200, body: { skills: [{ name: "habit", github: { repo: "acme/habit", commit: SHA } }] } });

    const set = await toolkitApi.githubPreview(td.url, "https://github.com/acme/pack/tree/v2.0.0");
    expect(set).toMatchObject({ status: 200, body: { kind: "collection", collection: { name: "pack", version: "v2.0.0", description: "一套假的 skill。" } } });
    const { collection } = set.body;
    const installed = await toolkitApi.githubInstall(td.url, { previewId: set.body.previewId, collection: { ...collection!, members: ["skills/a"] } });
    expect(installed).toMatchObject({ status: 200, body: { collection: { name: "pack", skills: ["pack-a"], github: { repo: "acme/pack", ref: "v2.0.0", commit: SHA } } } });
    expect(fs.readdirSync(staged)).toEqual([]);

    const catalog = (await toolkitApi.catalog(td.url)).body;
    expect(catalog.skills.find((s) => s.name === "habit")).toMatchObject({ origin: "imported", github: { url: "https://github.com/acme/habit", repo: "acme/habit", commit: SHA } });
    expect(catalog.collections.find((c) => c.name === "pack")).toMatchObject({ source: "https://github.com/acme/pack/tree/v2.0.0", github: { ref: "v2.0.0" } });
    expect(catalog.skills.some((s) => s.name === "pack-b")).toBe(false);

    // 秘书的 skill 选择、项目的工具包里选得到
    expect(await toolkitApi.setSecretarySkills(td.url, ["habit", "pack-a"])).toMatchObject({ status: 200, body: { skills: ["habit", "pack-a"] } });
    const project = seedToolkitProject(td.daemon, "装了 GitHub skill 的项目", toolkit());
    const frontend = await TestFrontend.connect(td.url);
    await frontend.subscribe({ [CHANNELS.board]: 0 });
    expect(ok(await frontend.request(METHODS.setToolkit, { target: { kind: "project", projectId: project.id }, toolkit: toolkit({ skills: ["habit", "pack-a"] }) }, "k-gh"))).toMatchObject({ changed: true });
    // 装配时交给子进程的目录（数据目录按真实路径，临时目录的短名字会被展开，只比后面几段）
    const [habitDir, memberDir] = td.daemon.skills.pathsOf(["habit", "pack-a"]);
    expect([tail(habitDir!, 3), tail(memberDir!, 5)]).toEqual([`${path.basename(td.dataDir)}/skills/habit`, `${path.basename(td.dataDir)}/skills/pack/skills/a`]);

    // 放弃：临时目录清掉；再装同一个预览回 404 带一句人话
    const again = await toolkitApi.githubPreview(td.url, "acme/habit");
    expect(fs.readdirSync(staged)).toEqual([again.body.previewId]);
    expect(await toolkitApi.githubDiscard(td.url, again.body.previewId)).toMatchObject({ status: 200, body: { discarded: true } });
    expect(fs.readdirSync(staged)).toEqual([]);
    expect(await toolkitApi.githubInstall(td.url, { previewId: again.body.previewId })).toMatchObject({ status: 404, body: { message: expect.stringContaining("过期") } });

    // 认不出的地址、私有或不存在的仓库、请求体不对
    expect(await toolkitApi.githubPreview(td.url, "https://gitlab.com/acme/x")).toMatchObject({ status: 400, body: { message: expect.stringContaining("认不出这个地址") } });
    expect(await toolkitApi.githubPreview(td.url, "acme/private")).toMatchObject({ status: 404, body: { message: expect.stringContaining("私有仓库") } });
    expect(await toolkitApi.githubInstall(td.url, { previewId: "x", rename: "Bad Name" })).toMatchObject({ status: 400 });
  });
});
