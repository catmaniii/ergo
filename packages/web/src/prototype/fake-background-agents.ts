// 原型的背后的 agent：照守护进程 sub-agents/background.ts 会给的编。全部是虚构的。
// - 相册库的负责人：两个子 agent 正在跑（一个刚调完工具、一个在等你批准），一个做完了，一次评审做完了，一个老的（以前跑的，没记它说的话、被守护进程重启打断）；
// - 「换新电脑」的负责人：一个做完了、一个失败了；记账本的负责人：一次评审，都做完了（标题栏入口写"背后的 agent（1）"）；
// 运行中的开始时间按打开页面的时候往前算（用时不会写成几十天）。
import type { BackgroundAgentEntry, BackgroundAgentList, BackgroundAgentRow, BackgroundAgentTranscript } from "../state/index.ts";
import { ownMaintainerId } from "../state/index.ts";

const at = (md: string, hm: string) => `2026-${md}T${hm}:00+08:00`;
const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();

const PHOTOS_TASK = { taskId: "t-photos", taskTitle: "家庭照片整理与去重" };
const PC_TASK = { taskId: "t-newpc", taskTitle: "换新电脑：把旧电脑的资料搬过去" };

interface FakeAgent {
  row: () => BackgroundAgentRow;
  instructions?: string;
  entries: () => BackgroundAgentEntry[];
  saidRecorded: boolean;
}

const call = (callId: string, tool: string, argsSummary: string, resultSummary: string, atTime: string, outcome = "done"): BackgroundAgentEntry => ({ kind: "tool_call", callId, tool, argsSummary, outcome, resultSummary, at: atTime });

const AGENTS: Readonly<Record<string, Readonly<Record<string, FakeAgent>>>> = {
  "project-photos": {
    "sa-4": {
      saidRecorded: true,
      instructions: "按年份给 2024 年的照片建事件目录\n只建目录、挪文件，不删任何东西；拿不准的放进「待确认」",
      row: () => ({
        agentId: "sa-4",
        kind: "sub_agent",
        ...PHOTOS_TASK,
        stageId: "s2",
        stageTitle: "按事件新建目录",
        step: "2024 年",
        brief: "按年份给 2024 年的照片建事件目录",
        state: "running",
        startedAt: ago(7),
        toolCalls: 14,
        lastStep: { tool: "bash", argsSummary: "python group_by_event.py --year 2024 --dry-run", at: ago(1) },
        tokens: 86_000,
        cacheHitTokens: 41_000,
      }),
      entries: () => [
        { kind: "input", text: "你是子 agent sa-4：替任务 t-photos「家庭照片整理与去重」做阶段 s2「按事件新建目录」里的「2024 年」这一步。\n负责人给你的工作说明：\n按年份给 2024 年的照片建事件目录\n只建目录、挪文件，不删任何东西；拿不准的放进「待确认」", at: ago(7) },
        { kind: "said", text: "先看一下 2024 年有多少张照片、拍摄时间能读出多少。", at: ago(7) },
        call("call-sa4-1", "ls", "照片/2024", "1,208 个文件", ago(6.5)),
        call("call-sa4-2", "bash", "exiftool -T -DateTimeOriginal 照片/2024 | sort | uniq -c | head", "2024:01:02 … 共 1,171 张有拍摄时间，37 张没有", ago(6)),
        { kind: "said", text: "**1,171 张**有拍摄时间，按相隔超过两天分成事件；37 张没有时间的放进「待确认」。先试跑一遍看分组对不对。", at: ago(5) },
        call("call-sa4-3", "bash", "python group_by_event.py --year 2024 --dry-run", "分出 43 个事件，最大的「2024-10 三亚」214 张", ago(1)),
      ],
    },
    "sa-3": {
      saidRecorded: true,
      instructions: "按年份给 2023 年的照片建事件目录",
      row: () => ({
        agentId: "sa-3",
        kind: "sub_agent",
        ...PHOTOS_TASK,
        stageId: "s2",
        stageTitle: "按事件新建目录",
        step: "2023 年",
        brief: "按年份给 2023 年的照片建事件目录",
        state: "running",
        startedAt: ago(9),
        toolCalls: 9,
        lastStep: { tool: "write", argsSummary: "照片/2023/事件清单.md", at: ago(2) },
        tokens: 54_000,
        cacheHitTokens: 22_000,
      }),
      entries: () => [
        { kind: "input", text: "你是子 agent sa-3：替任务 t-photos「家庭照片整理与去重」做阶段 s2「按事件新建目录」里的「2023 年」这一步。\n负责人给你的工作说明：\n按年份给 2023 年的照片建事件目录", at: ago(9) },
        { kind: "said", text: "2023 年的照片按拍摄时间分了 31 个事件，清单写好了，接着挪文件。", at: ago(3) },
        call("call-sa3-1", "write", "照片/2023/事件清单.md", "写好了", ago(2)),
      ],
    },
    "sa-2": {
      saidRecorded: true,
      instructions: "扫描家庭网盘里的重复照片，列清单",
      row: () => ({
        agentId: "sa-2",
        kind: "sub_agent",
        ...PHOTOS_TASK,
        stageId: "s1",
        stageTitle: "扫描重复照片",
        brief: "扫描家庭网盘里的重复照片，列清单",
        state: "done",
        outcome: "done",
        startedAt: at("10-06", "09:10"),
        endedAt: at("10-06", "09:48"),
        toolCalls: 23,
        tokens: 112_000,
        cacheHitTokens: 70_000,
      }),
      entries: () => [
        { kind: "input", text: "你是子 agent sa-2：替任务 t-photos「家庭照片整理与去重」做阶段 s1「扫描重复照片」。\n负责人给你的工作说明：\n扫描家庭网盘里的重复照片，列清单", at: at("10-06", "09:10") },
        { kind: "said", text: "先按文件大小粗筛，再对同样大小的算哈希。", at: at("10-06", "09:11") },
        call("call-sa2-1", "bash", "fdupes -r 网盘/照片 > dup-raw.txt", "找到 214 组重复", at("10-06", "09:30")),
        call("call-sa2-2", "write", "dup.md", "写好了", at("10-06", "09:46")),
        { kind: "said", text: "清单写在 dup.md：**214 组**重复照片，占 18.6 GB。", at: at("10-06", "09:47") },
        { kind: "result", text: "子 agent sa-2 做阶段 s1「扫描重复照片」，做完了，交回的结果：\n清单写在 dup.md：214 组重复照片，占 18.6 GB。", at: at("10-06", "09:48") },
      ],
    },
    "review-t-photos-s1-1": {
      saidRecorded: true,
      row: () => ({
        agentId: "review-t-photos-s1-1",
        kind: "reviewer",
        ...PHOTOS_TASK,
        stageId: "s1",
        stageTitle: "扫描重复照片",
        state: "done",
        outcome: "done",
        startedAt: at("10-06", "09:52"),
        endedAt: at("10-06", "09:56"),
        toolCalls: 4,
        tokens: 18_000,
        cacheHitTokens: 0,
      }),
      entries: () => [
        { kind: "input", text: "评审任务「家庭照片整理与去重」的阶段 s1「扫描重复照片」。\n交付件：dup.md\n验收标准：\n1. 清单覆盖两个目录", at: at("10-06", "09:52") },
        { kind: "said", text: "读一下 dup.md，核对两个目录都在里面。", at: at("10-06", "09:53") },
        call("call-rv-1", "read", "dup.md", "214 组重复照片……", at("10-06", "09:54")),
        call("call-rv-2", "submit_review", "results=[{\"index\":1,\"passed\":true}]", "结论已提交。", at("10-06", "09:56")),
      ],
    },
    "sa-1": {
      saidRecorded: false,
      instructions: "看一下网盘里还有哪些照片目录",
      row: () => ({
        agentId: "sa-1",
        kind: "sub_agent",
        ...PHOTOS_TASK,
        stageId: "s1",
        stageTitle: "扫描重复照片",
        brief: "看一下网盘里还有哪些照片目录",
        state: "stopped",
        outcome: "interrupted",
        startedAt: at("10-05", "21:30"),
        endedAt: at("10-05", "21:41"),
        toolCalls: 3,
        tokens: 9_000,
        cacheHitTokens: 0,
      }),
      entries: () => [call("call-sa1-1", "ls", "网盘/照片", "共 6 个目录", at("10-05", "21:32")), { kind: "result", text: "子 agent sa-1 做阶段 s1「扫描重复照片」，被打断了（守护进程重启），没有结果。", at: at("10-05", "21:41") }],
    },
  },
  "project-ledger": {
    "review-t-ledger-v1-s2-2": {
      saidRecorded: true,
      row: () => ({
        agentId: "review-t-ledger-v1-s2-2",
        kind: "reviewer",
        taskId: "t-ledger-v1",
        taskTitle: "记账本第一版",
        stageId: "s2",
        stageTitle: "按月出报表",
        state: "done",
        outcome: "done",
        startedAt: at("09-05", "11:50"),
        endedAt: at("09-05", "11:58"),
        toolCalls: 3,
        tokens: 14_000,
        cacheHitTokens: 0,
      }),
      entries: () => [{ kind: "said", text: "九月份月报的合计和对账单对得上。", at: at("09-05", "11:57") }],
    },
  },
  [ownMaintainerId("t-newpc")]: {
    "sa-6": {
      saidRecorded: true,
      instructions: "导出浏览器书签和密码库",
      row: () => ({
        agentId: "sa-6",
        kind: "sub_agent",
        ...PC_TASK,
        stageId: "s3b",
        stageTitle: "导出书签和密码库",
        brief: "导出浏览器书签和密码库",
        state: "failed",
        outcome: "error",
        startedAt: at("10-06", "19:00"),
        endedAt: at("10-06", "19:06"),
        toolCalls: 2,
        tokens: 6_000,
        cacheHitTokens: 0,
      }),
      entries: () => [{ kind: "said", text: "密码库要主密码才能导出，我没有。", at: at("10-06", "19:05") }, { kind: "result", text: "子 agent sa-6 做阶段 s3b，出错了：这一轮出错了", at: at("10-06", "19:06") }],
    },
    "sa-5": {
      saidRecorded: true,
      instructions: "盘点旧电脑上的资料",
      row: () => ({
        agentId: "sa-5",
        kind: "sub_agent",
        ...PC_TASK,
        stageId: "s1a",
        stageTitle: "盘点资料",
        brief: "盘点旧电脑上的资料",
        state: "done",
        outcome: "done",
        startedAt: at("10-06", "09:20"),
        endedAt: at("10-06", "09:40"),
        toolCalls: 11,
        tokens: 30_000,
        cacheHitTokens: 8_000,
      }),
      entries: () => [{ kind: "said", text: "资料盘点好了，清单在 inventory.md。", at: at("10-06", "09:39") }, { kind: "result", text: "子 agent sa-5 做阶段 s1a「盘点资料」，做完了，交回的结果：\n资料盘点好了，清单在 inventory.md。", at: at("10-06", "09:40") }],
    },
  },
};

export function fakeBackgroundAgents(maintainerId: string): BackgroundAgentList {
  return { agents: Object.values(AGENTS[maintainerId] ?? {}).map((a) => a.row()) };
}

export function fakeBackgroundTranscript(agentId: string): BackgroundAgentTranscript | undefined {
  for (const group of Object.values(AGENTS)) {
    const agent = group[agentId];
    if (agent) return { agent: agent.row(), ...(agent.instructions ? { instructions: agent.instructions } : {}), entries: agent.entries(), saidRecorded: agent.saidRecorded };
  }
  return undefined;
}
