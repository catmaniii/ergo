// 设置 · 数据源（295 号票）的请求体。名字和别的形状在 data-sources.ts（不引用 TypeBox）。
// - POST /api/data-sources/<id>：立即同步、断开（purge 为真是"连已导入的一起彻底删除"）、开关一种用法、填设置（值交给插件，
//   插件存进密钥区、测试连接；值不进日志、不进事件）、在电脑上打开它的文件夹（307 号票）。都带幂等键：断开并删的那一下同一个键重发只删一次。
//   300 号票：清掉几天的原始数据（插件自己存储里的，按本地日期）。
// - POST /api/import-folder：现在看一遍导入文件夹、在电脑上打开它。
// - POST /api/data-sources/<id>/push（299 号票）：设备交来的（手机上的二狗 App 读本机的通讯录、日历）；data 的样子由那个数据源定
//   （守护进程按数据源登记的 schema 查），同一个幂等键重发只收一次。
// - POST /api/data-sources/<id>/stored（343 号票）：已获取的一页；POST /api/data-sources/<id>/live：现查上游，open 是点开一条（只读，不用幂等键）。
import { type Static, Type } from "typebox";
import { DATA_SOURCE_STORED_MAX, DATA_SOURCE_USAGES, IMPORT_FOLDER_ACTIONS } from "./data-sources.ts";

const IdempotencyKey = Type.String({ minLength: 1, maxLength: 200 });

export const DataSourceActionBody = Type.Union([
  Type.Object({ action: Type.Literal("sync"), idempotencyKey: IdempotencyKey }, { additionalProperties: false }),
  Type.Object({ action: Type.Literal("disconnect"), purge: Type.Boolean(), idempotencyKey: IdempotencyKey }, { additionalProperties: false }),
  Type.Object({ action: Type.Literal("usage"), usage: Type.Enum(DATA_SOURCE_USAGES), on: Type.Boolean(), idempotencyKey: IdempotencyKey }, { additionalProperties: false }),
  Type.Object(
    { action: Type.Literal("configure"), values: Type.Record(Type.String(), Type.String({ maxLength: 4000 })), idempotencyKey: IdempotencyKey },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      action: Type.Literal("clear_raw"),
      dates: Type.Array(Type.String({ pattern: "^[0-9]{4}-[0-9]{2}-[0-9]{2}$" }), { minItems: 1, maxItems: 1000 }),
      idempotencyKey: IdempotencyKey,
    },
    { additionalProperties: false },
  ),
  Type.Object({ action: Type.Literal("open"), idempotencyKey: IdempotencyKey }, { additionalProperties: false }),
]);
export type DataSourceActionBody = Static<typeof DataSourceActionBody>;

export const ImportFolderActionBody = Type.Object({ action: Type.Enum(IMPORT_FOLDER_ACTIONS) }, { additionalProperties: false });
export type ImportFolderActionBody = Static<typeof ImportFolderActionBody>;

/** 设备交来的（299 号票）：data 由那个数据源按它登记的 schema 查（手机的见 phone-schema.ts） */
export const DataSourcePushBody = Type.Object({ data: Type.Unknown(), idempotencyKey: IdempotencyKey }, { additionalProperties: false });
export type DataSourcePushBody = Static<typeof DataSourcePushBody>;

/** 已获取的一页（343 号票）：offset 从 0 起，新的在前 */
export const DataSourceStoredBody = Type.Object(
  { offset: Type.Optional(Type.Integer({ minimum: 0 })), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: DATA_SOURCE_STORED_MAX })) },
  { additionalProperties: false },
);
export type DataSourceStoredBody = Static<typeof DataSourceStoredBody>;

/** 现查上游（343 号票）：不带 open 是列表；open 是点开一条取正文（Gmail 的邮件编号） */
export const DataSourceLiveBody = Type.Object({ open: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })) }, { additionalProperties: false });
export type DataSourceLiveBody = Static<typeof DataSourceLiveBody>;
