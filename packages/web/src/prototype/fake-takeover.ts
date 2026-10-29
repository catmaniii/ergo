// 原型里本机的 Claude Code 会话（290 号票，编的；真的是守护进程经 SDK 的 listSessions 和 `claude agents --json` 列的）：
// 一个已经接管成任务 t-flaky 的（二狗在管）、一个在终端里开着的、一个停着的后台会话记着的、几个空闲的（有大会话、有没分支的）。
import type { ResumableSessionView } from "../state/index.ts";
import { FAKE_TAKEOVER_TASK } from "./fake-conversations.ts";

const MIN = 60_000;
const iso = (ms: number) => new Date(ms).toISOString();

/** 原型的本机会话（最近活动按现在往前推，免得"几分钟前"过时） */
export function fakeTakeoverSessions(now: number): ResumableSessionView[] {
  const task = FAKE_TAKEOVER_TASK;
  return [
    {
      id: "a41d2c90-7e3b-4f1a-8c5d-2b6e9f0a1c37",
      title: "记账本导出 CSV 和月度汇总",
      cwd: "D:\\code\\ledger",
      branch: "feat/export-csv",
      updatedAt: iso(now - 4 * MIN),
      bytes: 1_840_000,
      busy: "在终端里开着（进程 21844）",
    },
    {
      id: task.takeover!.sessionId,
      title: task.takeover!.title,
      cwd: task.workdir!,
      branch: "fix/flaky",
      updatedAt: iso(now - 26 * MIN),
      bytes: 2_412_000,
      busy: `任务 ${task.id}「${task.title}」在管（交还之前别的不能接管）`,
      heldBy: { kind: "task", id: task.id, title: task.title, maintainerId: task.maintainerId },
    },
    { id: "5c8e1f3a-2d4b-4a7c-9b16-e0f3d2a1b845", title: "家里的知识库整理成网站", cwd: "D:\\notes\\home-wiki", branch: "main", updatedAt: iso(now - 3 * 60 * MIN), bytes: 52_300_000 },
    { id: "9b2f6d14-8a3c-4e5f-a7d0-1c4b3e2f9a68", title: "照片按地点归档的脚本", cwd: "D:\\scripts\\photos", updatedAt: iso(now - 20 * 60 * MIN), bytes: 96_000 },
    {
      id: "e7a3b5c2-1f9d-4b8e-86a4-3d2c1b0f7e59",
      title: "夜里跑的数据整理",
      cwd: "D:\\code\\nightly-etl",
      branch: "main",
      updatedAt: iso(now - 2 * 24 * 60 * MIN),
      bytes: 640_000,
      busy: "有一个停着的后台会话记着它（c153a547），当作占着",
    },
  ];
}
