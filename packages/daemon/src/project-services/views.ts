// 项目的服务（133 号票）的派生视图：一个服务（按 LSM 里的名字、转发的应用名）一行——最近一条 service_desired（该在 LSM 上还是撤下、
// 定义）、对它做完的结果（service_rollout，没有就是还没做完：上线中 / 撤下中）、LSM 里有没有它的登记、上线后挂了报过还没好的那次
// 故障（service_outage）和报过几次。删掉的项目的事件换成了"已删除"标记，整体重放之后行就没了。
// 257 号票：另一张表一个项目一行，记最新的那条"全部启动 / 全部关闭"（service_power）；每个服务那一行多记它照哪一条开关做完了
// （power_seq：上线的结果带着的、关闭做完记的）和关闭没做成的原因（power_failed）。
import type { DerivedView } from "../events/event-store.ts";
import { OPERATIONS_CHANNEL } from "../projects/api.ts";
import type { ReadonlyDatabase } from "../storage/sqlite.ts";
import {
  PROJECT_SERVICE_EVENTS,
  type ServiceDesiredPayload,
  type ServiceOutagePayload,
  type ServicePowerDonePayload,
  type ServicePowerPayload,
  type ServiceRolloutPayload,
} from "./events.ts";

export const projectServicesView: DerivedView = {
  name: "project_services",
  create(db) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS project_services (
        app TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        desired TEXT NOT NULL,
        desired_seq INTEGER NOT NULL,
        rollout TEXT,
        registered INTEGER NOT NULL DEFAULT 0,
        outage TEXT,
        outages INTEGER NOT NULL DEFAULT 0,
        power_seq INTEGER NOT NULL DEFAULT 0,
        power_failed TEXT
      );
      CREATE TABLE IF NOT EXISTS project_service_power (
        project_id TEXT PRIMARY KEY,
        power_on INTEGER NOT NULL,
        seq INTEGER NOT NULL
      );
    `);
    // 257 号票之前建的表没有这两列：之前的事件日志里没有开关的事件，默认值就对，加列不用补
    const columns = db.all<{ name: string }>("PRAGMA table_info(project_services)").map((c) => c.name);
    if (!columns.includes("power_seq")) db.exec("ALTER TABLE project_services ADD COLUMN power_seq INTEGER NOT NULL DEFAULT 0");
    if (!columns.includes("power_failed")) db.exec("ALTER TABLE project_services ADD COLUMN power_failed TEXT");
  },
  clear(db) {
    db.exec("DELETE FROM project_services; DELETE FROM project_service_power;");
  },
  apply(db, event) {
    if (event.channel !== OPERATIONS_CHANNEL) return;
    if (event.type === PROJECT_SERVICE_EVENTS.desired) {
      const p = event.payload as Partial<ServiceDesiredPayload>;
      if (typeof p.app !== "string" || typeof p.projectId !== "string") return;
      // 新的一条要求：结果、故障清掉（还没做完），LSM 里有没有登记照旧
      db.run(
        `INSERT INTO project_services (app, project_id, desired, desired_seq, rollout, registered, outage, outages) VALUES (?, ?, ?, ?, NULL, 0, NULL, 0)
         ON CONFLICT(app) DO UPDATE SET project_id = excluded.project_id, desired = excluded.desired, desired_seq = excluded.desired_seq, rollout = NULL, outage = NULL, outages = 0`,
        p.app,
        p.projectId,
        JSON.stringify(p),
        event.globalSeq,
      );
    } else if (event.type === PROJECT_SERVICE_EVENTS.rollout) {
      const p = event.payload as Partial<ServiceRolloutPayload>;
      if (typeof p.app !== "string" || typeof p.desiredSeq !== "number") return;
      // 257：上线时照的那一条开关就是它做到的；关闭没做成的原因随之清掉
      if (typeof p.powerSeq === "number") {
        db.run("UPDATE project_services SET rollout = ?, registered = ?, power_seq = ?, power_failed = NULL WHERE app = ? AND desired_seq = ?", JSON.stringify(p), p.registered ? 1 : 0, p.powerSeq, p.app, p.desiredSeq);
      } else {
        db.run("UPDATE project_services SET rollout = ?, registered = ? WHERE app = ? AND desired_seq = ?", JSON.stringify(p), p.registered ? 1 : 0, p.app, p.desiredSeq);
      }
    } else if (event.type === PROJECT_SERVICE_EVENTS.power) {
      const p = event.payload as Partial<ServicePowerPayload>;
      if (typeof p.projectId !== "string" || typeof p.on !== "boolean") return;
      db.run(
        "INSERT INTO project_service_power (project_id, power_on, seq) VALUES (?, ?, ?) ON CONFLICT(project_id) DO UPDATE SET power_on = excluded.power_on, seq = excluded.seq",
        p.projectId,
        p.on ? 1 : 0,
        event.globalSeq,
      );
    } else if (event.type === PROJECT_SERVICE_EVENTS.powerDone) {
      const p = event.payload as Partial<ServicePowerDonePayload>;
      if (typeof p.app !== "string" || typeof p.desiredSeq !== "number" || typeof p.powerSeq !== "number") return;
      db.run("UPDATE project_services SET power_seq = ?, power_failed = ? WHERE app = ? AND desired_seq = ?", p.powerSeq, p.ok ? null : (p.reason ?? ""), p.app, p.desiredSeq);
    } else if (event.type === PROJECT_SERVICE_EVENTS.outage) {
      const p = event.payload as Partial<ServiceOutagePayload>;
      if (typeof p.app !== "string" || typeof p.desiredSeq !== "number") return;
      if (p.down) db.run("UPDATE project_services SET outage = ?, outages = outages + 1 WHERE app = ? AND desired_seq = ?", JSON.stringify(p), p.app, p.desiredSeq);
      else db.run("UPDATE project_services SET outage = NULL WHERE app = ? AND desired_seq = ?", p.app, p.desiredSeq);
    }
  },
};

/** 一个服务现在的样子 */
export interface ServiceRow {
  app: string;
  projectId: string;
  desired: ServiceDesiredPayload;
  /** 最近一条 service_desired 的全局序号 */
  desiredSeq: number;
  /** 对它做完的结果；没有是还没做完 */
  rollout?: ServiceRolloutPayload;
  /** LSM 里有没有它的登记 */
  registered: boolean;
  /** 上线后挂了、报给了维护者、还没好的那次故障 */
  outage?: ServiceOutagePayload;
  /** 这一条要求上线以来报过几次故障（通知的幂等键用） */
  outages: number;
  /** 257：照哪一条"全部启动 / 全部关闭"做完了（它的全局序号；没做过的是 0） */
  powerSeq: number;
  /** 257：照 powerSeq 那一条关闭没做成的原因 */
  powerFailed?: string;
}

interface Raw {
  app: string;
  project_id: string;
  desired: string;
  desired_seq: number;
  rollout: string | null;
  registered: number;
  outage: string | null;
  outages: number;
  power_seq: number;
  power_failed: string | null;
}

const rowOf = (r: Raw): ServiceRow => ({
  app: r.app,
  projectId: r.project_id,
  desired: JSON.parse(r.desired) as ServiceDesiredPayload,
  desiredSeq: r.desired_seq,
  ...(r.rollout ? { rollout: JSON.parse(r.rollout) as ServiceRolloutPayload } : {}),
  registered: r.registered === 1,
  ...(r.outage ? { outage: JSON.parse(r.outage) as ServiceOutagePayload } : {}),
  outages: r.outages,
  powerSeq: r.power_seq,
  ...(r.power_failed === null ? {} : { powerFailed: r.power_failed }),
});

/** 全部，按项目、这一条的 key */
export function serviceRows(db: ReadonlyDatabase): ServiceRow[] {
  return db.all<Raw>("SELECT * FROM project_services ORDER BY project_id, app").map(rowOf);
}

export function serviceRow(db: ReadonlyDatabase, app: string): ServiceRow | undefined {
  const r = db.get<Raw>("SELECT * FROM project_services WHERE app = ?", app);
  return r && rowOf(r);
}

/** 257：一个项目的服务现在该全部开着还是全部关着，照的是哪一条（从没点过启动、关闭的：开着、0） */
export function servicePower(db: ReadonlyDatabase, projectId: string): { on: boolean; seq: number } {
  const r = db.get<{ power_on: number; seq: number }>("SELECT power_on, seq FROM project_service_power WHERE project_id = ?", projectId);
  return r ? { on: r.power_on === 1, seq: r.seq } : { on: true, seq: 0 };
}
