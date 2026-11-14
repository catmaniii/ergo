// 466：agent-browser 换成 ego-browser 的一次性迁移——秘书用的 skill、各工具包（项目、没结束的任务现在生效的计划）。
// 只换这一项、原位换、别的不动；只做一次（记在 config/migrations.json，用户之后再勾回 agent-browser 不会又被换掉）；
// 本来就没有 agent-browser 的不动；归档的项目、结束的任务不动；每一处都记日志。
import fs from "node:fs";
import path from "node:path";
import type { PlanToolkit } from "@ergo/protocol";
import { describe, expect, it } from "vitest";
import {
  createOneTimeMigrations,
  EGO_SECRETARY_STEP,
  EGO_TOOLKITS_STEP,
  migrateSecretarySkillsToEgo,
  migrateToolkitsToEgo,
  replaceSkillName,
} from "../../src/skills/ego-browser-migration.ts";
import { createSkillLibrary } from "../../src/skills/library.ts";
import { createSecretarySkills } from "../../src/skills/secretary-skills.ts";
import { makeTempDir } from "../helpers/temp-dir.ts";

const NOW = "2026-11-14T10:00:00.000+08:00";
const kit = (skills: string[]): PlanToolkit => ({ skills, mcp: ["demo-mail"], bash: true, network: true });

function migrations() {
  const file = path.join(makeTempDir("ergo-migrations-"), "config", "migrations.json");
  return { file, migrations: createOneTimeMigrations(file, () => NOW) };
}

function secretary(content?: unknown) {
  const dataDir = makeTempDir("ergo-mig-data-");
  const file = path.join(dataDir, "config", "secretary-skills.json");
  if (content !== undefined) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(content));
  }
  const library = createSkillLibrary({ builtinDir: makeTempDir("ergo-mig-builtin-"), userDir: path.join(dataDir, "skills"), dataDir, now: () => NOW, log: () => {} });
  return { file, skills: createSecretarySkills({ file, library, log: () => {} }) };
}

function world() {
  const projects = [
    { id: "p-1", name: "记账本", state: "in_use" as const, charterConfirmed: true, toolkit: kit(["agent-browser", "demo-pdf"]) },
    { id: "p-2", name: "相册库", state: "in_use" as const, charterConfirmed: true, toolkit: kit(["demo-pdf"]) },
    { id: "p-3", name: "旧项目", state: "archived" as const, charterConfirmed: true, toolkit: kit(["agent-browser"]) },
    { id: "p-4", name: "还在立项", state: "in_use" as const, charterConfirmed: false, toolkit: kit(["agent-browser"]) },
  ];
  const tasks = [
    { id: "t-1", title: "每周汇总账单", state: "running" as const },
    { id: "t-2", title: "做完了的", state: "done" as const },
    { id: "t-3", title: "还没计划的", state: "planning" as const },
    { id: "t-4", title: "两样都有", state: "running" as const },
  ];
  const plans: Record<string, PlanToolkit> = { "t-1": kit(["demo-ocr", "agent-browser"]), "t-2": kit(["agent-browser"]), "t-4": kit(["ego-browser", "agent-browser"]) };
  const projectChanges: { id: string; toolkit: PlanToolkit; by: string; why: string }[] = [];
  const taskChanges: { taskId: string; toolkit: PlanToolkit; by: string; why: string }[] = [];
  return {
    projectChanges,
    taskChanges,
    deps: {
      projects: {
        list: () => projects,
        changeToolkit: (id: string, toolkit: PlanToolkit, change: { by: "system"; why: string }) => {
          projectChanges.push({ id, toolkit, ...change });
          return { changed: true };
        },
      },
      tasks: {
        list: () => tasks,
        confirmedPlan: (taskId: string) => (plans[taskId] ? { plan: { toolkit: plans[taskId] } } : undefined),
        changeToolkit: (input: { taskId: string; toolkit: PlanToolkit; by: "system"; why: string }) => {
          taskChanges.push(input);
          return { changed: true };
        },
      },
    },
  };
}

describe("名单里换一个名字", () => {
  it("原位换；换上的已经在就只去掉旧的；没有旧的是 undefined", () => {
    expect(replaceSkillName(["a", "agent-browser", "b"], "agent-browser", "ego-browser")).toEqual(["a", "ego-browser", "b"]);
    expect(replaceSkillName(["ego-browser", "agent-browser"], "agent-browser", "ego-browser")).toEqual(["ego-browser"]);
    expect(replaceSkillName(["a"], "agent-browser", "ego-browser")).toBeUndefined();
  });

  it("迁移记录：做过的步骤记在文件里；文件坏了当一步都没做过", () => {
    const { file, migrations: m } = migrations();
    expect(m.done("x")).toBe(false);
    m.mark("x");
    expect(m.done("x")).toBe(true);
    expect(JSON.parse(fs.readFileSync(file, "utf8"))).toEqual({ format: 1, done: { x: NOW } });
    fs.writeFileSync(file, "{坏的");
    expect(createOneTimeMigrations(file, () => NOW).done("x")).toBe(false);
  });
});

describe("秘书用的 skill", () => {
  it("名单里的 agent-browser 原位换成 ego-browser、记日志；只换一次：用户之后再勾回 agent-browser 不再换", () => {
    const { file, skills } = secretary({ format: 1, skills: ["yt-dlp", "agent-browser", "notes-style"] });
    const { migrations: m } = migrations();
    const log: string[] = [];
    expect(migrateSecretarySkillsToEgo({ migrations: m, secretarySkills: skills, log: (l) => log.push(l) })).toBe(true);
    expect(JSON.parse(fs.readFileSync(file, "utf8")).skills).toEqual(["yt-dlp", "ego-browser", "notes-style"]);
    expect(log).toEqual(["466 迁移：秘书用的 skill 里的 agent-browser 换成了 ego-browser（原位，别的没动）"]);
    expect(m.done(EGO_SECRETARY_STEP)).toBe(true);
    // 用户自己又勾回了 agent-browser（他导入的那份还在库里）：下次启动不再换
    fs.writeFileSync(file, JSON.stringify({ format: 1, skills: ["agent-browser"] }));
    expect(migrateSecretarySkillsToEgo({ migrations: m, secretarySkills: skills, log: (l) => log.push(l) })).toBe(false);
    expect(JSON.parse(fs.readFileSync(file, "utf8")).skills).toEqual(["agent-browser"]);
    expect(log).toHaveLength(1);
  });

  it("没有设置文件（用的默认名单）、名单里本来就没有 agent-browser：不动，也记下做过了", () => {
    for (const content of [undefined, { format: 1, skills: ["yt-dlp"] }]) {
      const { file, skills } = secretary(content);
      const before = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : undefined;
      const { migrations: m } = migrations();
      const log: string[] = [];
      expect(migrateSecretarySkillsToEgo({ migrations: m, secretarySkills: skills, log: (l) => log.push(l) })).toBe(false);
      expect(fs.existsSync(file) ? fs.readFileSync(file, "utf8") : undefined).toBe(before);
      expect(log).toEqual([]);
      expect(m.done(EGO_SECRETARY_STEP)).toBe(true);
    }
  });
});

describe("各工具包", () => {
  it("立项书确认了、没归档的项目，没结束的任务现在生效的计划：agent-browser 原位换成 ego-browser，别的（skill、MCP、开关）不动；改的人是 system，时间线写明", () => {
    const { deps, projectChanges, taskChanges } = world();
    const { migrations: m } = migrations();
    const log: string[] = [];
    expect(migrateToolkitsToEgo({ ...deps, migrations: m, log: (l) => log.push(l) })).toEqual({ projects: ["记账本"], tasks: ["每周汇总账单", "两样都有"] });
    expect(projectChanges).toEqual([{ id: "p-1", toolkit: kit(["ego-browser", "demo-pdf"]), by: "system", why: "二狗把 agent-browser 换成了 ego 浏览器（ego-browser）" }]);
    expect(taskChanges).toEqual([
      { taskId: "t-1", toolkit: kit(["demo-ocr", "ego-browser"]), by: "system", why: "二狗把 agent-browser 换成了 ego 浏览器（ego-browser）" },
      { taskId: "t-4", toolkit: kit(["ego-browser"]), by: "system", why: "二狗把 agent-browser 换成了 ego 浏览器（ego-browser）" },
    ]);
    expect(log).toEqual([
      "466 迁移：项目「旧项目」已归档，工具包里的 agent-browser 没换（取消归档后在项目页换）",
      "466 迁移：工具包里的 agent-browser 换成了 ego-browser（原位，别的没动）：项目「记账本」、任务「每周汇总账单」、任务「两样都有」",
    ]);
    expect(m.done(EGO_TOOLKITS_STEP)).toBe(true);
  });

  it("只做一次：再跑一遍什么都不动；改不了的（抛错）记日志、接着换别的", () => {
    const first = world();
    const { migrations: m } = migrations();
    migrateToolkitsToEgo({ ...first.deps, migrations: m, log: () => {} });
    const again = world();
    expect(migrateToolkitsToEgo({ ...again.deps, migrations: m, log: () => {} })).toEqual({ projects: [], tasks: [] });
    expect([again.projectChanges, again.taskChanges]).toEqual([[], []]);

    const failing = world();
    failing.deps.projects.changeToolkit = () => {
      throw new Error("项目在删除中");
    };
    const log: string[] = [];
    expect(migrateToolkitsToEgo({ ...failing.deps, migrations: migrations().migrations, log: (l) => log.push(l) }).tasks).toEqual(["每周汇总账单", "两样都有"]);
    expect(log).toContain("466 迁移：项目「记账本」的工具包没换成：项目在删除中");
  });
});
