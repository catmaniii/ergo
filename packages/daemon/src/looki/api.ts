// Looki 插件对外的（296 号票，ADR-0027）：内核、别的插件、测试只从这里拿 Looki 插件的东西——插件名、数据源 id、按需查的工具名、
// 导入的记录（事件）的频道、类型和负载；不 import 插件的别的文件（test/looki/boundary.test.ts 检查，例外写在那里）。

/** 插件名：配置 plugins.disabled / plugins.removed、设置 · 插件里写的就是它，定了别改 */
export const LOOKI_PLUGIN = "looki";

/** 数据源 id：用法开关、密钥区（secrets/data-sources/looki.json）、同步记录按它记，定了别改 */
export const LOOKI_SOURCE_ID = "looki";

/** 按需查的工具名（给秘书） */
export const LOOKI_QUERY_TOOL = "query_looki";

/** 导入的记录：守护进程内部的频道（不是前端协议的频道，前端订阅不了） */
export const LOOKI_CHANNEL = "looki";
/** 一个时刻一条 */
export const LOOKI_MOMENT = "looki_moment";
/** 一篇 AI 日记一条 */
export const LOOKI_JOURNAL = "looki_journal";

/** 区域：中国区（open.looki.tech）、海外（open.looki.ai） */
export const LOOKI_REGIONS = ["cn", "global"] as const;
export type LookiRegion = (typeof LOOKI_REGIONS)[number];

/** 时刻里有哪些媒体（照片视频本身不导入，只记有没有） */
export type LookiMediaKind = "photo" | "video" | "audio";

/**
 * 一个时刻的记录（looki_moment 的负载）：Looki 按拍到的照片视频自动切出来的一段——标题、描述、起止时间、地点。
 * 只存整理好的文字和时间地点；封面文件、预签名的下载链接（1 小时失效）一概不存
 */
export interface LookiMomentPayload {
  /** Looki 的时刻 id（去重、素材指向原始记录用） */
  momentId: string;
  /** 哪一天（Looki 给的 date，YYYY-MM-DD） */
  date: string;
  /** 开始（带时区偏移的 ISO） */
  start: string;
  /** 结束（带时区偏移的 ISO） */
  end?: string;
  title: string;
  description: string;
  /** 地点（给人看的名字：时刻上的，没有就取封面文件上的） */
  place?: string;
  /** 有哪些媒体 */
  media?: LookiMediaKind[];
  /** 素材的原文：标题、描述各一行（采集规则切段的位置） */
  text: string;
}

/**
 * 一篇 AI 日记的记录（looki_journal 的负载）：Looki 的 AI 按一天拍到的替你写的。当"别人写给你的"采成素材——摘要当说明，
 * 全文只进检索（不进切段、不进原文副本），按条标了情绪、健康（日记里常有心情、饮食）：这两类默认没打开推断，所以默认只进检索
 */
export interface LookiJournalPayload {
  /** Looki 的日记 id */
  journalId: string;
  /** 哪一天（YYYY-MM-DD） */
  date: string;
  /** 记录时间（带时区偏移的 ISO） */
  time: string;
  /** Looki 的种类（DIARY……） */
  kind?: string;
  title: string;
  /** 摘要 */
  summary: string;
  /** 全文 */
  content: string;
  /** 素材的说明：Looki · 标题，下一行摘要 */
  text: string;
}
