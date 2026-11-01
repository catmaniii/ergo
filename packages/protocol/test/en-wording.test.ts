// 379 号票：英文语言文件里同一个东西用同一种说法。翻教程时查出来的，一条条核对完之后用这里守着，别再长回去。
import fs from "node:fs";
import { describe, expect, it } from "vitest";

const DIR = new URL("../locales/en/", import.meta.url);
const EN: Record<string, string> = Object.assign(
  {},
  ...fs
    .readdirSync(DIR)
    .filter((file) => file.endsWith(".json") && !file.startsWith("_"))
    .map((file) => JSON.parse(fs.readFileSync(new URL(file, DIR), "utf8")) as Record<string, string>),
);
const hits = (pattern: RegExp) => Object.keys(EN).filter((key) => pattern.test(EN[key]!));

describe("英文的说法", () => {
  it("产品名写 ergo，只有句首可以大写；手机系统设置路径里的是 App 在手机上的显示名，照它写", () => {
    const wrong: string[] = [];
    for (const [key, value] of Object.entries(EN)) {
      for (const found of value.matchAll(/\bErgo\b/g)) {
        const before = value.slice(0, found.index);
        const after = value.slice(found.index + found[0].length);
        const sentenceStart = /(^|[.!?]\s+|\n\s*)$/.test(before);
        const appLabel = before.endsWith("Settings · Apps & services · ") && after.startsWith(" · Permissions");
        // 一个词的值不是句子，是产品名本身
        if ((!sentenceStart || value === "Ergo") && !appLabel) wrong.push(`${key}: ${value}`);
      }
    }
    expect(wrong).toEqual([]);
  });

  it("嵌进别的句子的词组不算句首", () => {
    for (const key of ["eventSources.dataDir", "guard.judge.areas.program", "projectServices.port.daemonLocal", "projectServices.port.daemonExternal"]) {
      expect(EN[key]).toMatch(/^ergo's /);
    }
  });

  it("立项：提示里说的就是卡片按钮上的字", () => {
    const button = EN["ui.cards.suggestProject.kickoff"]!;
    expect(button).toBe("Start project");
    expect(EN["pages.projects.newToast"]).toContain(`Tap "${button}"`);
    expect(EN["pages.projects.new.hint"]).toContain(`Tap "${button}"`);
    expect(hits(/Kick off/)).toEqual([]);
  });

  it("等我只有一种说法，等你这个状态只有一种说法", () => {
    expect(hits(/Waiting on me/)).toEqual([]);
    // "等你处理"那一栏的名字（手册的章节名、锚点用的是它）；别的"等你"都写 Waiting for you
    expect(hits(/[Ww]aiting on you/).toSorted()).toEqual(["ui.inboxBar.count", "ui.inboxBar.label", "ui.marks.waitingOnYou"]);
    expect(EN["state.board.status.waiting"]).toBe(EN["pages.tasks.status.waiting"]);
    expect(EN["model.labels.taskStatus.waitingForUser"]).toBe(EN["protocol.tasks.state.waitingForUser"]);
    expect(EN["state.stageGraph.look.waiting"]).toBe(EN["protocol.activity.state.waitingForUser"]);
  });

  it("手机系统设置路径只有一种写法", () => {
    const paths = new Set(Object.values(EN).flatMap((value) => value.match(/Settings [·›] Apps[^,.;]*Permissions/g) ?? []));
    expect([...paths]).toEqual(["Settings · Apps & services · Ergo · Permissions"]);
  });

  it("彻底删除只有一种说法：Delete completely（名词、过去式跟着它）", () => {
    expect(hits(/[Pp]ermanently/)).toEqual([]);
    expect(hits(/\b[Pp]urg(?:e|es|ed|ing)\b/).filter((key) => !/\{purged\}|\{label\}/.test(EN[key]!))).toEqual([]);
    for (const key of ["protocol.memoryCommand.purge", "pages.materialDetail.confirmButton.purge", "pages.personalFiles.mode.purge", "pages.personalFiles.confirm.purge"]) {
      expect(EN[key]).toBe("Delete completely");
    }
    for (const key of ["protocol.memoryDelete.purge.done", "state.detailContent.purged.purge"]) expect(EN[key]).toBe("Completely deleted");
  });

  it("定时任务的提示写对话框里那个选项的字", () => {
    expect(EN["pages.projects.noScheduled"]).toContain(`"${EN["pages.startTask.title"]}"`);
    expect(EN["pages.projects.noScheduled"]).toContain(`"${EN["state.triggers.when.schedule"]}" under "${EN["pages.startTask.when"]}"`);
  });

  it("bge-m3 的大小和组件页显示的一样（清单合计 586,779,294 字节，组件页按 1024 算，559.6 MB）", () => {
    expect(EN["materials.modelMissing.hint"]).toContain("about 560 MB");
    const manifest = JSON.parse(fs.readFileSync(new URL("../../daemon/src/components/manifest.json", import.meta.url), "utf8")) as { components: { id: string }[] };
    const sizes: number[] = [];
    const walk = (value: unknown): void => {
      if (Array.isArray(value)) value.forEach(walk);
      else if (typeof value === "object" && value !== null) {
        const record = value as Record<string, unknown>;
        if (typeof record.size === "number") sizes.push(record.size);
        else Object.values(record).forEach(walk);
      }
    };
    walk(manifest.components.find((component) => component.id === "bge-m3"));
    expect(Math.round(sizes.reduce((a, b) => a + b, 0) / 1_048_576)).toBe(560);
  });
});
