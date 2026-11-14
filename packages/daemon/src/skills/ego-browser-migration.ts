// 466：agent 用的浏览器从 agent-browser 换成 ego 浏览器（ego lite 的 ego-browser 命令，框架自带 skill ego-browser）。
// 已经存着的选择启动时迁移一次，只换这一项、别的不动：
// - 秘书用的 skill（config/secretary-skills.json）：名单里的 agent-browser 原位换成 ego-browser（没有文件的用默认名单，默认已经是 ego-browser）；
// - 各工具包：立项书确认了、没归档的项目的工具包，没结束的任务现在生效的计划里的工具包（定时触发的流程也在这里），
//   skill 里的 agent-browser 原位换成 ego-browser——走各自的"改工具包"（时间线上记一笔"二狗把 agent-browser 换成了 ego 浏览器"，
//   负责人按新工具包重新装配），改的人记 system。归档的项目、结束的任务不动（改不了；取消归档后在项目页手动换），记日志。
// - 联网设置的队列不在这里：存着的 agent-browser 读的时候原位换成 ego-browser（web/web-settings.ts）。
// "只迁一次"：做过的步骤记在 config/migrations.json（OneTimeMigrations），用户之后自己再勾回 agent-browser 不会又被换掉。
// 用户自己导入的 agent-browser skill 留在库里不删，只是不再默认勾上。每一处换了什么都记日志。
import fs from "node:fs";
import { type PlanToolkit, type Project, t, type Task, ENDED_TASK_STATES } from "@ergo/protocol";
import { writeJsonAtomic } from "../util/json-file.ts";

/** 换掉的那个 skill */
export const LEGACY_BROWSER_SKILL = "agent-browser";
/** 换上的那个（框架自带） */
export const EGO_BROWSER_SKILL = "ego-browser";
/** 迁移记录里的步骤名 */
export const EGO_SECRETARY_STEP = "466-ego-browser-secretary-skills";
export const EGO_TOOLKITS_STEP = "466-ego-browser-toolkits";

/** 名单里的 from 原位换成 to（to 已经在名单里时只去掉 from）；名单里没有 from 是 undefined（纯函数） */
export function replaceSkillName(skills: readonly string[], from: string, to: string): string[] | undefined {
  if (!skills.includes(from)) return undefined;
  return skills.includes(to) ? skills.filter((s) => s !== from) : skills.map((s) => (s === from ? to : s));
}

/** 只做一次的迁移做过哪几步（config/migrations.json） */
export interface OneTimeMigrations {
  done(step: string): boolean;
  /** 记下做完了（写文件；写不了抛） */
  mark(step: string): void;
}

interface MigrationsFile {
  format: 1;
  done: Record<string, string>;
}

/** 读不出来、写错了的文件当成一步都没做过（迁移本身每一处都查"有没有 agent-browser"，再做一遍也只换还没换的） */
export function createOneTimeMigrations(file: string, now: () => string): OneTimeMigrations {
  const read = (): MigrationsFile => {
    try {
      const parsed: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
      if (typeof parsed === "object" && parsed !== null && "done" in parsed && typeof parsed.done === "object" && parsed.done !== null) {
        return { format: 1, done: Object.fromEntries(Object.entries(parsed.done).filter((e): e is [string, string] => typeof e[1] === "string")) };
      }
    } catch {
      // 没有文件、读不了：一步都没做过
    }
    return { format: 1, done: {} };
  };
  return {
    done: (step) => read().done[step] !== undefined,
    mark(step) {
      const before = read();
      writeJsonAtomic(file, { format: 1, done: { ...before.done, [step]: now() } } satisfies MigrationsFile);
    },
  };
}

/**
 * 秘书用的 skill：名单里的 agent-browser 换成 ego-browser（只做一次）。replace 是 SecretarySkills.replace（没有文件、没有它、
 * 文件坏了都不动）。返回换没换
 */
export function migrateSecretarySkillsToEgo(deps: { migrations: OneTimeMigrations; secretarySkills: { replace(from: string, to: string): boolean }; log: (line: string) => void }): boolean {
  if (deps.migrations.done(EGO_SECRETARY_STEP)) return false;
  const changed = deps.secretarySkills.replace(LEGACY_BROWSER_SKILL, EGO_BROWSER_SKILL);
  if (changed) deps.log(`466 迁移：秘书用的 skill 里的 agent-browser 换成了 ego-browser（原位，别的没动）`); // @i18n-ignore log
  try {
    deps.migrations.mark(EGO_SECRETARY_STEP);
  } catch (err) {
    deps.log(`466 迁移：记不下"秘书的 skill 迁移过了"：${err instanceof Error ? err.message : String(err)}；下次启动再看一遍`); // @i18n-ignore log
  }
  return changed;
}

/** 迁移工具包要的：项目（列出、改工具包）、任务（列出、现在生效的计划、改工具包） */
export interface EgoToolkitMigrationDeps {
  migrations: OneTimeMigrations;
  projects: {
    list(): readonly Pick<Project, "id" | "name" | "state" | "charterConfirmed" | "toolkit">[];
    changeToolkit(projectId: string, toolkit: PlanToolkit, change: { by: "system"; why: string }): { changed: boolean };
  };
  tasks: {
    list(): readonly Pick<Task, "id" | "title" | "state">[];
    confirmedPlan(taskId: string): { plan: { toolkit: PlanToolkit } } | undefined;
    changeToolkit(input: { taskId: string; toolkit: PlanToolkit; by: "system"; why: string }): { changed: boolean };
  };
  log: (line: string) => void;
}

/** 各工具包里的 agent-browser 换成 ego-browser（只做一次）。返回换了的项目、任务的名字 */
export function migrateToolkitsToEgo(deps: EgoToolkitMigrationDeps): { projects: string[]; tasks: string[] } {
  const result = { projects: [] as string[], tasks: [] as string[] };
  if (deps.migrations.done(EGO_TOOLKITS_STEP)) return result;
  const why = t("toolkit.egoBrowserMigrated");
  const failed = (what: string, err: unknown) => deps.log(`466 迁移：${what}的工具包没换成：${err instanceof Error ? err.message : String(err)}`); // @i18n-ignore log
  // @i18n-ignore-start log
  for (const project of deps.projects.list()) {
    if (!project.charterConfirmed || !project.toolkit) continue;
    const skills = replaceSkillName(project.toolkit.skills, LEGACY_BROWSER_SKILL, EGO_BROWSER_SKILL);
    if (!skills) continue;
    if (project.state === "archived") {
      deps.log(`466 迁移：项目「${project.name}」已归档，工具包里的 agent-browser 没换（取消归档后在项目页换）`);
      continue;
    }
    try {
      if (deps.projects.changeToolkit(project.id, { ...project.toolkit, skills }, { by: "system", why }).changed) result.projects.push(project.name);
    } catch (err) {
      failed(`项目「${project.name}」`, err);
    }
  }
  for (const task of deps.tasks.list()) {
    if (ENDED_TASK_STATES.includes(task.state)) continue;
    const toolkit = deps.tasks.confirmedPlan(task.id)?.plan.toolkit;
    const skills = toolkit && replaceSkillName(toolkit.skills, LEGACY_BROWSER_SKILL, EGO_BROWSER_SKILL);
    if (!toolkit || !skills) continue;
    try {
      if (deps.tasks.changeToolkit({ taskId: task.id, toolkit: { ...toolkit, skills }, by: "system", why }).changed) result.tasks.push(task.title);
    } catch (err) {
      failed(`任务「${task.title}」`, err);
    }
  }
  if (result.projects.length > 0 || result.tasks.length > 0) {
    deps.log(
      `466 迁移：工具包里的 agent-browser 换成了 ego-browser（原位，别的没动）：${[...result.projects.map((n) => `项目「${n}」`), ...result.tasks.map((n) => `任务「${n}」`)].join("、")}`,
    );
  }
  // @i18n-ignore-end
  try {
    deps.migrations.mark(EGO_TOOLKITS_STEP);
  } catch (err) {
    deps.log(`466 迁移：记不下"工具包迁移过了"：${err instanceof Error ? err.message : String(err)}；下次启动再看一遍`); // @i18n-ignore log
  }
  return result;
}
