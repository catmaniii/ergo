// 目录授权快到期的提示（ADR-0049）：到期前 3 天（FOLDER_GRANT_REMIND_BEFORE_MS）在待办里放一条"目录授权快到期"（不卡任务），
// 每条授权只提示一次（记在授权上的 remindedAt）。到期后守卫按判定时的 now 自动不算它，不用这里做什么。
// 什么时候看：起来时一次、每天 09:00 一次（内部作业 folder_grant_expiry_check），加了一条授权之后一次（设置接口叫 check）——
// 加的时候离到期已经不到 3 天的，马上提示。
import { FOLDER_GRANT_MODES, FOLDER_GRANT_REMIND_BEFORE_MS, type FolderGrantExpiringData, t } from "@ergo/protocol";
import type { InboxService } from "../inbox/inbox.ts";
import type { Clock } from "../scheduler/clock.ts";
import type { InternalJobs } from "../scheduler/internal-jobs.ts";
import type { FolderGrants } from "./folder-grants.ts";

/** 操作怎么说 */
const MODE_KEY = { read: "folders.grants.mode.read", write: "folders.grants.mode.write", delete: "folders.grants.mode.delete" } as const;

/** 内部作业的名字 */
export const FOLDER_GRANT_EXPIRY_JOB = "folder_grant_expiry_check";

export interface FolderGrantRemindersOptions {
  grants: FolderGrants;
  inbox: Pick<InboxService, "add">;
  internalJobs: Pick<InternalJobs, "register">;
  clock: Pick<Clock, "now">;
  /** 给人看的这个 agent（个人助理的名字、项目「…」的负责人、任务「…」的负责人）；认不得的写 agent id */
  agentName: (agentId: string) => string;
  /** 到期时间怎么写给人看 */
  timeText: (iso: string) => string;
  log: (line: string) => void;
}

export interface FolderGrantReminders {
  start(): void;
  stop(): void;
  /** 看一遍：没提示过、三天内到期、还没到期的，各放一条 */
  check(): void;
}

export function createFolderGrantReminders(options: FolderGrantRemindersOptions): FolderGrantReminders {
  const { grants, inbox, internalJobs, clock } = options;
  const offs: Array<() => void> = [];

  const check = () => {
    const now = clock.now();
    const due = grants.list().filter((g) => {
      if (g.expiresAt === undefined || g.remindedAt !== undefined) return false;
      const at = Date.parse(g.expiresAt);
      return at > now && at - now <= FOLDER_GRANT_REMIND_BEFORE_MS;
    });
    for (const g of due) {
      const data: FolderGrantExpiringData = { grantId: g.id, agentId: g.agentId, path: g.path, expiresAt: g.expiresAt! };
      const modes = FOLDER_GRANT_MODES.filter((m) => g.modes.includes(m))
        .map((m) => t(MODE_KEY[m]))
        .join(t("folders.grants.modeSep"));
      inbox.add({
        kind: "notice",
        notice: "folder_grant_expiring",
        title: t("folders.grants.expiringTitle", { path: g.path }),
        body: t("folders.grants.expiringBody", { agent: options.agentName(g.agentId), path: g.path, modes, at: options.timeText(g.expiresAt!) }),
        source: t("folders.grants.source"),
        urgency: "non_blocking",
        data,
      });
    }
    if (due.length > 0) {
      grants.markReminded(due.map((g) => g.id));
      options.log(`目录授权：${due.length} 条三天内到期，已在待办里提示`);
    }
  };

  return {
    start() {
      offs.push(internalJobs.register({ name: FOLDER_GRANT_EXPIRY_JOB, schedule: { kind: "daily", time: "09:00" }, run: async () => check() }));
      check();
    },
    stop() {
      for (const off of offs.splice(0)) off();
    },
    check,
  };
}
