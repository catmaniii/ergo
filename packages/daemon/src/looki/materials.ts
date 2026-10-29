// Looki 的记录怎么变成素材、彻底删除时怎么改写（296 号票；303 号票的写法，手册第 7 节"把记录写成素材"）。
// - 时刻 → 观察到的本人行为（本人做的，能撑关于用户的结论）：text 是标题、描述各一行，time 是开始，场景给结束时间和地点（时刻的位置名），
//   敏感类别按记录写窄——时刻写空的：地点放在 scene.place，位置没打开推断时证据里只去掉地点、这条照读（303 号票定的）；
// - AI 日记 → 别人写给你的（Looki 的 AI 替你写的：只当背景、不撑结论）：说明是"Looki · 标题"加摘要，全文只进检索（indexText），
//   按条标了情绪、健康（日记里常有心情、饮食）——这两类默认没打开推断，所以默认只进检索、不读成证据。
// 采集规则只看事件本身（ADR-0006）：时间、场景、敏感类别都在负载里，不读时钟、设置、插件的状态；已经彻底删除改写过的不再采。
import { type EventType, PURGED_TEXT } from "@ergo/protocol";
import type { DataSource } from "../data-sources/api.ts";
import { dataSourceMaterial } from "../data-sources/material.ts";
import type { PurgeRewriter } from "../events/purge.ts";
import type { MaterialSource } from "../materials/capture.ts";
import { LOOKI_JOURNAL, LOOKI_MOMENT, type LookiJournalPayload, type LookiMomentPayload } from "./api.ts";

/** 时刻的采集规则 */
export function momentMaterialSource(source: Pick<DataSource, "id" | "sensitive">): MaterialSource {
  return {
    name: "looki-moment",
    eventType: LOOKI_MOMENT as EventType,
    capture: (event) => {
      const p = event.payload as Partial<LookiMomentPayload>;
      if (typeof p.text !== "string" || p.text.length === 0 || p.text === PURGED_TEXT || typeof p.start !== "string") return [];
      return [
        dataSourceMaterial(source, {
          kind: "observed_behavior",
          text: p.text,
          time: p.start,
          scene: { ...(p.end === undefined ? {} : { end: p.end }), ...(p.place === undefined ? {} : { place: p.place }) },
          sensitive: [],
          ...(p.momentId === undefined ? {} : { recordId: p.momentId }),
        }),
      ];
    },
  };
}

/** 日记的采集规则 */
export function journalMaterialSource(source: Pick<DataSource, "id" | "sensitive">): MaterialSource {
  return {
    name: "looki-journal",
    eventType: LOOKI_JOURNAL as EventType,
    capture: (event) => {
      const p = event.payload as Partial<LookiJournalPayload>;
      if (typeof p.text !== "string" || p.text.length === 0 || p.text === PURGED_TEXT || typeof p.time !== "string") return [];
      return [
        dataSourceMaterial(source, {
          kind: "received_writing",
          text: p.text,
          time: p.time,
          ...(typeof p.content === "string" && p.content.length > 0 ? { indexText: p.content } : {}),
          sensitive: ["emotion", "health"],
          ...(p.journalId === undefined ? {} : { recordId: p.journalId }),
        }),
      ];
    },
  };
}

/** 彻底删除：标题、描述、地点、原文都是用户的数据，一起换掉（id、日期、起止时间留着：去重、"已删除"的位置） */
export const momentPurge: PurgeRewriter = {
  eventType: LOOKI_MOMENT,
  rewrite: (event) => {
    const { momentId, date, start, end } = event.payload as LookiMomentPayload;
    return { momentId, date, start, ...(end === undefined ? {} : { end }), title: PURGED_TEXT, description: PURGED_TEXT, text: PURGED_TEXT } satisfies LookiMomentPayload;
  },
};

/** 彻底删除：标题、摘要、全文一起换掉 */
export const journalPurge: PurgeRewriter = {
  eventType: LOOKI_JOURNAL,
  rewrite: (event) => {
    const { journalId, date, time, kind } = event.payload as LookiJournalPayload;
    return { journalId, date, time, ...(kind === undefined ? {} : { kind }), title: PURGED_TEXT, summary: PURGED_TEXT, content: PURGED_TEXT, text: PURGED_TEXT } satisfies LookiJournalPayload;
  },
};
