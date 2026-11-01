// 信是哪个任务、项目的（354 号票）：看自动播报开关、写转述来源都按它。项目内部任务的信（负责人、子 agent、评审）算项目的：
// 开关在项目上，秘书也看不到项目内部的任务。之前记下的信没有 owner：不能转述。
import { describe, expect, it } from "vitest";
import type { StoredEvent } from "../../src/events/event-store.ts";
import { jobSender, LETTER_EVENT, letterOwner, letterRelaySource, LETTERS_CHANNEL, projectSender, reviewerSender, subAgentSender, taskSender } from "../../src/secretary/letters.ts";

const CONV = "maintainer:tm-1" as const;
const STAGE = { stageId: "s1", title: "整理" };
const internal = { projectId: "p-1", projectName: "简报站" };
const task = { id: "t-5", title: "出日报", maintainerId: "tm-1" };
const letter = (payload: Record<string, unknown>) => ({ channel: LETTERS_CHANNEL, type: LETTER_EVENT, payload }) as unknown as StoredEvent;

describe("信是哪个任务、项目的", () => {
  it("任务自己的负责人、子 agent、评审：算这个任务", () => {
    expect(taskSender(task, "plain", CONV).owner).toEqual({ kind: "task", id: "t-5" });
    expect(subAgentSender(task, "long_running", "sa-1", CONV, STAGE).owner).toEqual({ kind: "task", id: "t-5" });
    expect(reviewerSender(task, "long_running", "review-1", STAGE).owner).toEqual({ kind: "task", id: "t-5" });
  });

  it("项目内部任务的：算项目（不说是哪个任务）", () => {
    expect(taskSender({ ...task, internal }, "plain", CONV).owner).toEqual({ kind: "project", id: "p-1" });
    expect(subAgentSender({ ...task, internal }, "long_running", "sa-1", CONV, STAGE).owner).toEqual({ kind: "project", id: "p-1" });
    expect(reviewerSender({ ...task, internal }, "long_running", "review-1", STAGE).owner).toEqual({ kind: "project", id: "p-1" });
  });

  it("项目的负责人算项目；定时作业有所属任务的算任务，76 号票之前没有的算作业", () => {
    expect(projectSender({ id: "p-1", name: "简报站", maintainerId: "pm-1" }, CONV, undefined).owner).toEqual({ kind: "project", id: "p-1" });
    expect(jobSender({ id: "j-1", title: "日报", maintainerId: "jm-1", ownerTaskId: "t-5" }, CONV).owner).toEqual({ kind: "task", id: "t-5" });
    expect(jobSender({ id: "j-1", title: "日报", maintainerId: "jm-1" }, CONV).owner).toEqual({ kind: "job", id: "j-1" });
  });

  it("转述来源：编号是任务、项目的，发信人是信上写的那个 agent；之前记下的信没有", () => {
    const owner = { kind: "task", id: "t-5" };
    expect(letterOwner(letter({ agentId: "sa-1", owner }))).toEqual(owner);
    expect(letterRelaySource(letter({ agentId: "sa-1", owner }))).toEqual({ source: "t-5", agentId: "sa-1" });
    expect(letterOwner(letter({ agentId: "tm-1" }))).toBeUndefined();
    expect(letterRelaySource(letter({ agentId: "tm-1" }))).toBeUndefined();
  });
});
