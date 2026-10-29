// 115 号票：来信在会话里折成一行。守护进程写的几种通知开头的标记和协议包的那一份一样（Web 按它认哪些折）；
// 交给秘书的通知上存一句话总结（任务做完的由运行时拼，几件、几封并在一起的写几件），旧的信没有总结的取原话的第一句。
import { LETTER_TAGS, letterKindOf } from "@ergo/protocol";
import { describe, expect, test } from "vitest";
import { buildAgentNotice } from "../../src/conversation/messages.ts";
import { NUDGE_PREFIX } from "../../src/guard/index.ts";
import { runPendingNudge } from "../../src/scheduled-jobs/texts.ts";
import { letterNoticeSummary } from "../../src/secretary/letter-texts.ts";
import { describeLetter, LETTER_EVENT, LETTERS_CHANNEL } from "../../src/secretary/letters.ts";
import { MAINTAINER_LETTER_TAG, TASK_DONE_TAG } from "../../src/secretary/notice-tags.ts";
import { taskDoneItemSummary, taskDoneSummary } from "../../src/secretary/task-done.ts";
import { nudgeOf } from "../../src/tasks/workflow-run.ts";
import type { StoredEvent } from "../../src/events/event-store.ts";

describe("通知开头的标记和协议包的一样", () => {
  test("任务做完、维护者来信、计划检查（守卫里另写的那一份、定时运行的收尾提醒）", () => {
    expect(TASK_DONE_TAG).toBe(LETTER_TAGS.task_done);
    expect(MAINTAINER_LETTER_TAG).toBe(LETTER_TAGS.maintainer_letter);
    expect(NUDGE_PREFIX).toBe(LETTER_TAGS.plan_check);
    expect(runPendingNudge(["s2「发周报」"]).startsWith(LETTER_TAGS.plan_check)).toBe(true);
    const nudge = nudgeOf({ steps: [{ id: "s2", title: "发周报", tool: "write", args: {}, after: [] }] } as never, [{ kind: "pending", step: "s2", message: "s2 没做" }] as never);
    expect(nudge.text.startsWith(LETTER_TAGS.plan_check)).toBe(true);
  });

  test("交给 agent 的通知 Web 认得出是来信", () => {
    const { message } = buildAgentNotice("secretary", `${TASK_DONE_TAG}后台有一件事做完了`, "k-1", {}, { summary: "t-1「下歌」做完了" });
    expect(letterKindOf(message)).toBe("task_done");
    expect(message.summary).toBe("t-1「下歌」做完了");
  });
});

/** secretary_letters 频道上的一封信（只有交的时候要看的几项） */
const letter = (payload: Record<string, unknown>) => ({ channel: LETTERS_CHANNEL, type: LETTER_EVENT, payload: { to: "secretary", from: "任务 t-1 的维护者", text: "", ...payload } }) as unknown as StoredEvent;

describe("一句话总结", () => {
  test("任务做完的一件：哪个任务（运行写第几次），交了几个文件；几件并在一起的写几件、各是哪件", () => {
    expect(taskDoneItemSummary("t-1「去把《晴天》的音频下下来」", 0)).toBe("t-1「去把《晴天》的音频下下来」做完了");
    expect(taskDoneItemSummary("t-5「AI 日报」第 2 次运行", 1)).toBe("t-5「AI 日报」第 2 次运行做完了，交了 1 个文件");
    const one = { name: "t-5「AI 日报」第 2 次运行", summary: "t-5「AI 日报」第 2 次运行做完了，交了 1 个文件" };
    expect(taskDoneSummary([one])).toBe(one.summary);
    expect(taskDoneSummary([one, { name: "t-1「下歌」", summary: "t-1「下歌」做完了" }])).toBe("2 件事做完了：t-5「AI 日报」第 2 次运行、t-1「下歌」");
  });

  test("维护者来信：一封是它给的总结，几封用分号连起来；102 号票时记下的信没有总结，取原话的第一句", () => {
    expect(describeLetter(letter({ text: "官方有录音室版和现场版。我先下了录音室版", summary: "先下了录音室版" })).summary).toBe("先下了录音室版");
    expect(describeLetter(letter({ text: "官方有录音室版和现场版。我先下了录音室版" })).summary).toBe("官方有录音室版和现场版");
    expect(letterNoticeSummary(["先下了录音室版"])).toBe("先下了录音室版");
    expect(letterNoticeSummary(["先下了录音室版", "发票里有 3 张抬头写错了"])).toBe("2 封来信：先下了录音室版；发票里有 3 张抬头写错了");
  });
});
