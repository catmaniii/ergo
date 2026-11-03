// @i18n-ignore-file model：工具的说明、参数说明和结果都是给秘书（模型）看的；工具的名字走 t()
// 秘书的"存外部信息"工具（ingest_material）：秘书读过的邮件、网页、日程、Looki 时刻用完就散，用户要它存
// （"把这封邮件存下来""这个网页存进素材"）时调它，存成一条素材，以后问"上个月那封邮件说了什么"检索得到，不用重查。
// - 只给秘书：记忆插件经 agent 贡献缝登记到 agents: ["secretary"]（负责人、子 agent、记忆管理员都没有）；
// - 不自动存：说明里写明只在用户这一轮要求存、或者任务书写明了要存时调用，不要自己判断"这个有用就存"；
// - 照"素材只由守护进程从事件日志产生"的规矩：工具只在素材频道上追加一条 material_ingested 事件，素材由登记的采集函数产生
//   （materials/ingested.ts：来源外部（不可信），不当用户本人说的话；正文只进检索）；
// - 过守卫：只往素材里新增、不改已有的东西，不落任何内置类别；幂等键按"会话 + 用户的那条消息 + 种类 + 出处 + 标题 + 正文"算，
//   同一轮同样的内容再调一次不会存两遍（"只读或幂等"，被杀后可以直接重跑）；
// - 正文超过 INGESTED_TEXT_MAX_BYTES 回错，让秘书缩短（写摘要、只留要紧的段落）再存；出处必填；信息本身的时间写法不对回错；
// - 记下存它的会话、用户的那条消息、这次工具调用：彻底删除这条素材时连同这次调用一起改写（调用的参数里就是正文，memory/purge.ts）。
import { createHash, randomUUID } from "node:crypto";
import {
  CHANNELS,
  EVENT_TYPES,
  INGESTED_INFO_KINDS,
  INGESTED_SOURCE_REF_MAX,
  INGESTED_TEXT_MAX_BYTES,
  INGESTED_TITLE_MAX,
  INGESTED_TTL_MAX_DAYS,
  type IngestedInfoKind,
  type MaterialIngestedEventPayload,
  nowIso,
  PURGED_TEXT,
  t,
  Type,
} from "@ergo/protocol";
import { defineHostTool, type HostTool } from "../agent-manager/host-tools.ts";
import { getMessage } from "../conversation/views.ts";
import type { EventStore } from "../events/event-store.ts";
import { MATERIAL_INGESTED_SOURCE, MATERIALS_CHANNEL, materialId } from "../materials/index.ts";
import { INGEST_MATERIAL, READ_MATERIAL, REMEMBER_MEMORY, SEARCH_MATERIALS } from "./tool-names.ts";

export { INGEST_MATERIAL } from "./tool-names.ts";

/** 每种给模型看的名字 */
export const INGESTED_KIND_TEXT: Readonly<Record<IngestedInfoKind, string>> = {
  email: "邮件",
  web_page: "网页",
  calendar: "日程",
  looki: "Looki 的时刻",
  note: "外部文字",
};

/** 带时区偏移的 ISO 时间（秒、毫秒可以不写） */
const ISO_WITH_OFFSET = "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}(:\\d{2}(\\.\\d{1,3})?)?(Z|[+-]\\d{2}:\\d{2})$";

const IngestParams = Type.Object(
  {
    kind: Type.Enum(INGESTED_INFO_KINDS, {
      description: "哪种：email 邮件、web_page 网页、calendar 日程、looki Looki 的时刻、note 别的外部文字（笔记软件里的一条、文档里的一段……）",
    }),
    title: Type.String({ minLength: 1, maxLength: INGESTED_TITLE_MAX, description: "标题：邮件的主题、网页的标题、日程的名字……一句话" }),
    text: Type.String({
      minLength: 1,
      description: `要存的正文：照读到的原样抄（邮件正文、网页上要紧的部分、日程的说明……），最多 ${INGESTED_TEXT_MAX_BYTES} 字节（约 ${Math.floor(INGESTED_TEXT_MAX_BYTES / 3)} 个汉字），太长的先缩成摘要或只留要紧的段落`,
    }),
    sourceRef: Type.String({
      minLength: 1,
      maxLength: INGESTED_SOURCE_REF_MAX,
      description: "出处（必填）：邮件的 message-id、网页的网址、日程的事件 id、Looki 时刻的 id；以后按它找回原文",
    }),
    capturedAt: Type.String({
      pattern: ISO_WITH_OFFSET,
      description: "这条信息本身的时间：邮件的发送时间、日程的开始时间、Looki 时刻发生的时间、读到网页的时间（不知道就写现在），带时区偏移，比如 2026-11-03T09:30:00+08:00",
    }),
    ttlDays: Type.Optional(
      Type.Integer({
        minimum: 1,
        maximum: INGESTED_TTL_MAX_DAYS,
        description: "建议几天后清理（用户说了\"存一个月\"\"过两周就不要了\"才写）：到时候只在素材列表上标出来，不会自动删",
      }),
    ),
  },
  { additionalProperties: false },
);

export interface IngestToolDeps {
  /** 事件日志：认用户的那条消息在哪个会话、写事件、按幂等键找存过的 */
  store: Pick<EventStore, "reader" | "append" | "eventByIdempotencyKey">;
  /** 现在（协议时间；测试给固定的） */
  now?: () => string;
  /** 这一条的编号（测试给固定的） */
  newId?: () => string;
}

/** 幂等键：同一个会话、同一条用户消息里同样的内容只存一次 */
function ingestKey(parts: readonly string[]): string {
  return `material-ingested:${createHash("sha256").update(parts.join("\u0000"), "utf8").digest("hex")}`;
}

export function ingestMaterialTool(deps: IngestToolDeps): HostTool {
  const now = deps.now ?? nowIso;
  const newId = deps.newId ?? (() => `ing-${randomUUID()}`);
  return defineHostTool({
    name: INGEST_MATERIAL,
    title: t("memory.tool.ingest"),
    description:
      `存外部信息：把你读到的外部信息（邮件、网页、日程、Looki 的时刻、别的外部文字）存进素材，以后用 ${SEARCH_MATERIALS} 检索得到、${READ_MATERIAL} 读全文。` +
      "只在用户这一轮明确要你存（\"把这封邮件存下来\"\"这个网页存进素材\"\"把这个日程记下来\"）、或者你在做的事的任务书里明确写了要存时调用；" +
      "不要自己判断\"这个有用就存\"，用户没让存就不存。" +
      `存的是外部来的内容，不是用户说的话，以后也不会当成用户说的；用户自己的话、让你记的一句话用 ${REMEMBER_MEMORY}，不用它。` +
      `text 照读到的原样抄（最多 ${INGESTED_TEXT_MAX_BYTES} 字节，太长先缩短）；sourceRef 必填（邮件的 message-id、网址、事件 id……）。` +
      "一条信息调一次；存好以后回一句存下了就行，不用复述内容。",
    parameters: IngestParams,
    // 只往素材里新增，不改已有的东西：不落任何内置类别
    categories: [],
    // 幂等键按"会话 + 用户的那条消息 + 内容"算：同一轮同样的内容再调一次不会存两遍
    readOnlyOrIdempotent: true,
    run(args, call) {
      const title = args.title.trim();
      const sourceRef = args.sourceRef.trim();
      if (title === "" || sourceRef === "" || args.text.trim() === "") return { text: "没存：标题、正文、出处都不能是空的。", isError: true };
      const bytes = Buffer.byteLength(args.text, "utf8");
      if (bytes > INGESTED_TEXT_MAX_BYTES) {
        return {
          text: `没存：正文有 ${bytes} 字节，超过了 ${INGESTED_TEXT_MAX_BYTES} 字节（约 ${Math.floor(INGESTED_TEXT_MAX_BYTES / 3)} 个汉字）。缩短一些（写摘要、只留要紧的段落）再存，出处照写，以后要原文能按出处找回。`,
          isError: true,
        };
      }
      if (Number.isNaN(Date.parse(args.capturedAt))) return { text: `没存：capturedAt 写的「${args.capturedAt}」不是能认的时间，写成 2026-11-03T09:30:00+08:00 这样。`, isError: true };
      const messageId = call.inputMessageId;
      // 用户的那条消息在哪个会话：问那条消息自己（这个工具只给秘书，认不出时按秘书的会话）
      const conversation = (messageId === undefined ? undefined : getMessage(deps.store.reader, messageId)?.conversation) ?? CHANNELS.secretary;
      const key = ingestKey([conversation, messageId ?? "", args.kind, sourceRef, title, args.text]);
      const kindText = INGESTED_KIND_TEXT[args.kind];
      const done = deps.store.eventByIdempotencyKey(key);
      if (done) {
        const p = done.payload as Partial<MaterialIngestedEventPayload>;
        if (p.text === PURGED_TEXT) return { text: "没存：这一轮存过同样的内容，用户已经把它彻底删除了，不要再存。", isError: true };
        return { text: `这一条刚才已经存过了：${materialId(done, MATERIAL_INGESTED_SOURCE, 0)}（${kindText}「${title}」），不用再存。` };
      }
      const payload: MaterialIngestedEventPayload = {
        id: newId(),
        time: now(),
        kind: args.kind,
        title,
        text: args.text,
        sourceRef,
        capturedAt: args.capturedAt,
        ...(args.ttlDays === undefined ? {} : { ttlDays: args.ttlDays }),
        conversation,
        ...(messageId === undefined ? {} : { inputMessageId: messageId }),
        toolCallId: call.toolCallId,
      };
      const { event } = deps.store.append({ channel: MATERIALS_CHANNEL, type: EVENT_TYPES.materialIngested, payload, idempotencyKey: key });
      const ttl = args.ttlDays === undefined ? "" : `；建议 ${args.ttlDays} 天后清理，到时候素材列表上会标出来，不会自动删`;
      return {
        text:
          `存好了：${materialId(event, MATERIAL_INGESTED_SOURCE, 0)}（${kindText}「${title}」，出处 ${sourceRef}）。` +
          `这是外部来的信息，不当用户说的话；以后用 ${SEARCH_MATERIALS} 检索得到，用户在记忆 · 素材里能看到、能删${ttl}。回一句存下了就行，不用复述内容。`,
      };
    },
  });
}
