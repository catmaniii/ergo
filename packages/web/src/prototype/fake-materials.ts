// 原型的假素材（158 号票：设置里删除素材的地方能看每条素材的内容）：照假会话里用户发的消息（FAKE_HISTORY）按 08 号票的切段规则编出来，
// 出处的消息就在假会话里，"跳到这条消息"跳得过去；另编两条不来自消息的（建议卡长期没处理、项目内部任务的审批决定）。
// 删除只在这一页的内存里（FakeDaemonHttp 记着删了哪些）。
// 165 号票：另编一条"你存的网页"（"浏览"的 ⋮ 菜单里存进素材的），"浏览"里存的（fakeSaveWebPage）也加进这一页的列表。
// 187 号票：另编三份九月的月结单（秘书主线里回话时调用记忆检索到的）。
// 167 号票（记忆 · 素材按时间范围浏览、搜、筛）：另编十几条"近几天的"（时间按打开页面的这一刻往前推，默认的近 7 天里有得看），
// 各种都有（说的话、语音、附件、存的网页、记忆命令、审批、关掉的卡、任务结局，几个会话）；按时间段、种类、会话、关键词筛照守护进程的口径
// （materials/facets.ts、memory/browse.ts）在这里再做一遍，搜的时候摘录换成命中的那一段。
import {
  type Card,
  CHANNELS,
  EVENT_TYPES,
  type MaterialDetailView,
  type MaterialFacet,
  type MaterialListFilter,
  type MaterialListItem,
  type MaterialScope,
  type MaterialSegmentView,
  type MessageEnvelope,
  type MessagePart,
  nowIso,
  SAVED_WEB_PAGE_CONTEXT,
  type SaveWebPageBody,
  type SaveWebPageResult,
  type VoiceRecord,
} from "../state/index.ts";
import { at, FAKE_CARDS, FAKE_HISTORY } from "./fake-conversations.ts";

/** 一条假素材：列表的一行和详情 */
interface FakeMaterial {
  item: MaterialListItem;
  detail: MaterialDetailView;
}

const QUOTE_LINE = /^ {0,3}>/;

/** 文字 part 按引用块切开：连续的引用行一段（外部、不可信，只记哈希，原文从消息里补），其余是用户打的字 */
function textSegments(text: string): MaterialSegmentView[] {
  const out: MaterialSegmentView[] = [];
  let group: { quote: boolean; lines: string[] } | undefined;
  const flush = () => {
    const body = group?.lines.join("\n").trim();
    if (group && body) out.push(group.quote ? { form: "quote", source: "external_untrusted", notes: [], sha256: "0".repeat(64), quoted: body } : { form: "typed", source: "self", notes: [], text: body });
  };
  for (const line of text.split("\n")) {
    const quote = QUOTE_LINE.test(line);
    if (group?.quote !== quote) {
      flush();
      group = { quote, lines: [] };
    }
    group.lines.push(line);
  }
  flush();
  return out;
}

const cardText = (cardId: string) => FAKE_CARDS.find((c: Card) => c.id === cardId)?.text.split("\n")[0];

function segmentsOf(message: MessageEnvelope, voices: ReadonlyMap<string, VoiceRecord>): MaterialSegmentView[] {
  return message.parts.flatMap((part: MessagePart): MaterialSegmentView[] => {
    switch (part.type) {
      case "text":
        return textSegments(part.text);
      case "image":
      case "file":
        return [{ form: "attachment", source: "external_untrusted", notes: [], label: part.name, media: { mediaId: part.mediaId, name: part.name, mime: part.mime }, part }];
      case "voice": {
        const text = part.voiceId === undefined ? undefined : voices.get(part.voiceId)?.recognition?.text;
        return text ? [{ form: "voice", source: "self", notes: ["transcribed"], text, media: { mediaId: part.mediaId }, part }] : [];
      }
      case "card_ref":
        return [{ form: "agent_output", source: "agent", notes: [], cardId: part.cardId, ...(cardText(part.cardId) ? { label: cardText(part.cardId)! } : {}) }];
      default:
        return [];
    }
  });
}

/** 摘录：本人的话加引用的说明，80 个字 */
function excerptOf(segments: readonly MaterialSegmentView[]): string {
  const text = segments
    .map((s) => (s.source === "self" ? s.text : s.label))
    .filter((t): t is string => t !== undefined && t.trim() !== "")
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
  return text.length > 80 ? `${text.slice(0, 80)}…` : text;
}

function fakeMaterials(): FakeMaterial[] {
  const voices = new Map<string, VoiceRecord>();
  for (const e of FAKE_HISTORY) if (e.type === EVENT_TYPES.voice) voices.set((e.payload as { voice: VoiceRecord }).voice.id, (e.payload as { voice: VoiceRecord }).voice);
  const seqs = new Map<string, number>();
  const out: FakeMaterial[] = [];
  for (const e of FAKE_HISTORY) {
    const seq = (seqs.get(e.channel) ?? 0) + 1;
    seqs.set(e.channel, seq);
    if (e.type !== EVENT_TYPES.message) continue;
    const message = (e.payload as { message: MessageEnvelope }).message;
    if (message.speaker !== "user" || message.relayedBy !== undefined) continue;
    // 284 号票：访谈里说了"这个别记"的那一句管理员忘掉了，不在素材里；访谈里说的话标着"来自访谈"
    const interview = (e.payload as { interviewId?: string }).interviewId !== undefined;
    if (interview && message.parts.some((p) => p.type === "text" && p.text.includes("这个别记"))) continue;
    const own = segmentsOf(message, voices);
    if (!own.some((s) => s.source === "self" || s.form === "attachment")) continue;
    // 访谈里管理员问的那一句排在前面当上下文（agent 的产出，只有说明；摘录不算它）
    const asked = (e.payload as { interviewQuestion?: string }).interviewQuestion;
    const segments: typeof own = interview && asked !== undefined ? [{ form: "agent_output", source: "agent", notes: [], label: `记忆管理员问：${asked}` }, ...own] : own;
    const fed = message.parts.some((p) => "asMaterial" in p && p.asMaterial === true);
    const id = `mat-fake-${message.id}`;
    const kind = fed ? "用户主动投喂的材料" : "用户发言";
    // 演示"不参与推断"：说过"别推断"的那一条
    const marks = {
      ...(message.parts.some((p) => p.type === "text" && p.text.includes("记账本最近老失败")) ? { noInfer: true as const } : {}),
      ...(interview ? { interview: true as const } : {}),
    };
    const context = [
      message.conversation.startsWith("maintainer:") ? "maintainer" : message.conversation,
      ...(segments.some((s) => s.form === "quote") ? ["with_quote"] : []),
      ...(segments.some((s) => s.form === "attachment") ? ["with_attachment"] : []),
      ...(interview ? ["interview"] : []),
    ];
    const item: MaterialListItem = { id, kind, time: message.time, conversation: message.conversation, excerpt: excerptOf(own), marks };
    out.push({
      item,
      detail: {
        id,
        kind,
        mode: "say",
        time: message.time,
        conversation: message.conversation,
        source: "self",
        context,
        segments,
        event: { channel: e.channel, seq, type: EVENT_TYPES.message },
        message: { id: message.id, state: "shown" },
        original: `originals/2026-10/${id}.json`,
        marks,
      },
    });
  }
  // 不来自消息的两条：建议卡长期没处理（系统观察到的，没有原文副本）、项目内部任务的审批决定（项目内部的记录）
  const stale: MaterialSegmentView = { form: "agent_output", source: "agent", notes: [], cardId: "c-st-1", label: cardText("c-st-1") ?? "建议发起任务" };
  out.push({
    item: { id: "mat-fake-stale", kind: "回避信号", time: at("10-13", "21:40"), excerpt: excerptOf([stale]), marks: {} },
    detail: {
      id: "mat-fake-stale",
      kind: "回避信号",
      mode: "do",
      time: at("10-13", "21:40"),
      source: "system",
      context: ["stale", "card:suggest_task"],
      segments: [stale],
      event: { channel: CHANNELS.cards, seq: 40, type: EVENT_TYPES.cardStale },
      cardId: "c-st-1",
      marks: {},
    },
  });
  const decision: MaterialSegmentView = { form: "choice", source: "self", notes: ["agent_proposed"], text: "批准：把 9 月账单导出到草稿区" };
  const internal = { projectId: "p-ledger", projectName: "记账本" };
  out.push({
    item: { id: "mat-fake-approval", kind: "审批决定", time: at("10-06", "21:35"), conversation: "maintainer:pm-ledger", excerpt: excerptOf([decision]), marks: { internal } },
    detail: {
      id: "mat-fake-approval",
      kind: "审批决定",
      mode: "do",
      time: at("10-06", "21:35"),
      conversation: "maintainer:pm-ledger",
      projectId: "p-ledger",
      source: "self",
      context: ["approval", "maintainer"],
      segments: [decision],
      event: { channel: CHANNELS.cards, seq: 12, type: EVENT_TYPES.card },
      recordId: "ap-fake-1",
      original: "originals/2026-10/mat-fake-approval.json",
      marks: { internal },
    },
  });
  out.push(
    savedPageMaterial("mat-fake-webpage", "wp-fake-1", 3, at("10-15", "20:10"), {
      title: "周末去杭州玩什么 - 旅行攻略",
      url: "https://travel.example.com/hangzhou",
      text: "杭州两日游\n\n第一天：西湖骑车环湖，断桥、白堤、苏堤一路过去，傍晚去湖滨看音乐喷泉。\n第二天：灵隐寺、龙井村喝茶，下午去河坊街。\n\n交通：地铁 1 号线到龙翔桥；西湖边共享单车很多。",
      truncated: true,
      total: 5200,
    }),
  );
  out.push(...recentMaterials());
  return out.toSorted((a, b) => Date.parse(b.item.time) - Date.parse(a.item.time));
}

/** 打开页面的这一刻往前 days 天的 hh:mm（本地时间） */
function ago(days: number, hm: string): string {
  const [h = 0, m = 0] = hm.split(":").map(Number);
  const now = new Date();
  return nowIso(new Date(now.getFullYear(), now.getMonth(), now.getDate() - days, h, m));
}

/** 一条近几天的假素材（不来自假会话里的消息：没有"跳到这条消息"） */
function recent(
  n: number,
  time: string,
  kind: string,
  mode: "say" | "do",
  segments: MaterialSegmentView[],
  extra: { conversation?: string; context?: string[]; source?: MaterialDetailView["source"]; cardId?: string; recordId?: string } = {},
): FakeMaterial {
  const id = `mat-fake-recent-${n}`;
  const source = extra.source ?? "self";
  return {
    item: { id, kind, time, ...(extra.conversation ? { conversation: extra.conversation } : {}), excerpt: excerptOf(segments), marks: {} },
    detail: {
      id,
      kind,
      mode,
      time,
      ...(extra.conversation ? { conversation: extra.conversation } : {}),
      source,
      context: extra.context ?? (extra.conversation ? [extra.conversation.startsWith("maintainer:") ? "maintainer" : extra.conversation] : []),
      segments,
      event: { channel: extra.conversation ?? CHANNELS.cards, seq: 200 + n, type: EVENT_TYPES.message },
      ...(extra.cardId ? { cardId: extra.cardId } : {}),
      ...(extra.recordId ? { recordId: extra.recordId } : {}),
      ...(source === "self" ? { original: `originals/2026-10/${id}.json` } : {}),
      marks: {},
    },
  };
}

const said = (text: string): MaterialSegmentView => ({ form: "typed", source: "self", notes: [], text });
const chose = (text: string): MaterialSegmentView => ({ form: "choice", source: "self", notes: ["agent_proposed"], text });
const fileSeg = (name: string, mime: string, size: number): MaterialSegmentView => {
  const mediaId = `${"c".repeat(58)}${String(size).padStart(6, "0").slice(-6)}`;
  return { form: "attachment", source: "external_untrusted", notes: [], label: name, media: { mediaId, name, mime }, part: { type: "file", mediaId, name, mime, size } };
};
const LEDGER = "maintainer:project-ledger";
const PHOTOS = "maintainer:project-photos";
const INVOICES = "maintainer:tm-invoices";

/** 近几天的十几条（167 号票）：默认的近 7 天、往前一段、近 30 天都有得看 */
function recentMaterials(): FakeMaterial[] {
  return [
    recent(1, ago(0, "09:12"), "用户发言", "say", [said("下周三上午体检，提前一天提醒我别吃早饭")], { conversation: CHANNELS.secretary }),
    recent(2, ago(0, "08:40"), "用户发言", "say", [{ form: "voice", source: "self", notes: ["transcribed"], text: "明天早上七点半叫我起床，顺便看看会不会下雨" }], {
      conversation: CHANNELS.secretary,
      context: [CHANNELS.secretary, "voice_transcript"],
    }),
    recent(3, ago(0, "08:05"), "显式记忆命令", "say", [said("我对芒果过敏")], { conversation: CHANNELS.secretary, context: ["command:remember", CHANNELS.secretary] }),
    savedPageMaterial("mat-fake-recent-4", "wp-fake-recent-4", 204, ago(1, "21:30"), {
      title: "秋季跑步入门：从 3 公里到 10 公里",
      url: "https://run.example.com/beginner",
      text: "第一周：每次跑 3 公里，跑走结合，心率别超过 150。\n第二周：加到 4 公里，每周三次。\n第四周：试着一口气跑完 5 公里。\n装备：一双合脚的跑鞋比什么都重要；天凉了跑前多热身五分钟。",
      truncated: false,
      total: 96,
    }),
    recent(5, ago(1, "20:15"), "用户发言", "say", [said("外卖单独算一类，别和餐饮混在一起")], { conversation: LEDGER }),
    recent(6, ago(1, "19:02"), "审批决定", "do", [chose("批准：把 10 月账单导出到草稿区")], { conversation: LEDGER, context: ["decision:approve", "maintainer"], recordId: "ap-fake-recent-6" }),
    recent(7, ago(2, "22:10"), "用户发言", "say", [fileSeg("保修卡-冰箱.pdf", "application/pdf", 182_000), said("冰箱的保修卡，到期前一个月提醒我")], {
      conversation: CHANNELS.secretary,
      context: [CHANNELS.secretary, "with_attachment"],
    }),
    recent(8, ago(3, "10:20"), "回避信号", "do", [{ form: "agent_output", source: "agent", notes: [], cardId: "c-fake-recent-8", label: "建议发起任务：每周整理一次相册" }], {
      context: ["dismissed", "card:suggest_task", "action:dismiss"],
      cardId: "c-fake-recent-8",
    }),
    recent(9, ago(4, "18:45"), "用户发言", "say", [said("重复的照片先别删，挪到一个文件夹里我看一眼")], { conversation: PHOTOS }),
    recent(10, ago(5, "12:00"), "澄清问题的回答", "say", [chose("只要国内的节假日"), said("周末照常休息")], { conversation: CHANNELS.secretary, context: ["card:questions"] }),
    recent(
      11,
      ago(6, "20:30"),
      "用户主动投喂的材料",
      "say",
      [fileSeg("九月发票汇总.xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", 24_576), said("这是九月的发票，按公司和个人分开")],
      { conversation: INVOICES, context: ["maintainer", "with_attachment"] },
    ),
    recent(12, ago(8, "09:00"), "用户发言", "say", [said("杭州那次算了，改去苏州，周六早上出发")], { conversation: CHANNELS.secretary }),
    recent(13, ago(9, "17:40"), "任务结局", "do", [chose("任务完成：整理九月的发票")], { context: ["outcome:completed", "by:maintainer"], recordId: "t-invoices" }),
    // 187 号票：秘书主线里"九月三张卡在吃上一共花了多少"那一段检索到的三份月结单（回话时调用记忆的详情里按 id 取）
    recent(14, ago(20, "21:05"), "用户主动投喂的材料", "say", [fileSeg("甲银行-9月月结单.pdf", "application/pdf", 96_000), said("甲银行九月的月结单，收着")], { conversation: CHANNELS.secretary, context: [CHANNELS.secretary, "with_attachment"] }),
    recent(15, ago(20, "21:06"), "用户主动投喂的材料", "say", [fileSeg("乙银行-9月月结单.pdf", "application/pdf", 88_000), said("乙银行的")], { conversation: CHANNELS.secretary, context: [CHANNELS.secretary, "with_attachment"] }),
    recent(16, ago(20, "21:08"), "用户主动投喂的材料", "say", [fileSeg("丙银行-9月账单.csv", "text/csv", 12_288)], { conversation: CHANNELS.secretary, context: [CHANNELS.secretary, "with_attachment"] }),
  ];
}

/** 种类（照守护进程的 materials/facets.ts：只看种类、说或做、各段的形态和情境） */
function facetsOf(d: MaterialDetailView): MaterialFacet[] {
  const forms = new Set(d.segments.map((s) => s.form));
  const command = d.kind === "显式记忆命令";
  const webPage = d.context.includes(SAVED_WEB_PAGE_CONTEXT);
  const out: MaterialFacet[] = [];
  if (!command && d.mode === "say" && !webPage && (forms.size === 0 || [...forms].some((f) => f !== "attachment" && f !== "voice" && f !== "web_page"))) out.push("said");
  if (!command && d.mode === "do") out.push("did");
  if (forms.has("attachment")) out.push("attachment");
  if (forms.has("voice")) out.push("voice");
  if (webPage) out.push("web_page");
  if (command) out.push("memory_command");
  return out;
}

/** 搜的那份文字：本人的话、引用的说明，存的网页接上正文 */
function searchableText(d: MaterialDetailView): string {
  return d.segments
    .flatMap((s) => [s.source === "self" ? s.text : s.label, s.saved?.text])
    .filter((t): t is string => t !== undefined && t.length > 0)
    .join("\n");
}

/** 命中的那一段（照守护进程：从最早出现的词前面留 20 个字起，一共 80 个字） */
function snippetOf(text: string, terms: readonly string[]): string {
  const flat = text.replace(/\s+/g, " ").trim();
  const lower = flat.toLowerCase();
  const hits = terms.map((t) => lower.indexOf(t)).filter((i) => i >= 0);
  const start = hits.length === 0 ? 0 : Math.max(0, Math.min(...hits) - 20);
  const end = Math.min(flat.length, start + 80);
  return `${start > 0 ? "…" : ""}${flat.slice(start, end)}${end < flat.length ? "…" : ""}`;
}

/** 一条你存的网页（165 号票）：用户主动投喂的材料，网页那一段只记网址、标题，详情里补上存下的正文 */
function savedPageMaterial(id: string, recordId: string, seq: number, time: string, page: Omit<SaveWebPageBody, "idempotencyKey">): FakeMaterial {
  const title = page.title.trim();
  const segment: MaterialSegmentView = {
    form: "web_page",
    source: "external_untrusted",
    notes: [],
    sha256: "0".repeat(64),
    label: title ? `${title}（${page.url}）` : page.url,
    url: page.url,
    saved: { title: page.title, text: page.text, truncated: page.truncated, total: page.total },
  };
  const kind = "用户主动投喂的材料";
  return {
    item: { id, kind, time, excerpt: excerptOf([segment]), marks: {} },
    detail: {
      id,
      kind,
      mode: "say",
      time,
      source: "self",
      context: [SAVED_WEB_PAGE_CONTEXT],
      segments: [segment],
      event: { channel: "materials", seq, type: EVENT_TYPES.webPageSaved },
      recordId,
      original: `originals/2026-10/${id}.json`,
      marks: {},
    },
  };
}

let cache: FakeMaterial[] | undefined;
/** "浏览"里存的（这一页里，新的在前）和同一个幂等键存过的结果 */
const savedHere: FakeMaterial[] = [];
const savedKeys = new Map<string, SaveWebPageResult>();
const all = () => [...savedHere, ...(cache ??= fakeMaterials())];

/** 原型："浏览"里存一页（165 号票）：加进这一页的假素材；同一个幂等键重发回第一次的结果 */
export function fakeSaveWebPage(body: SaveWebPageBody, time: string): SaveWebPageResult {
  const done = savedKeys.get(body.idempotencyKey);
  if (done) return done;
  const n = savedHere.length + 1;
  const result = { id: `wp-fake-saved-${n}`, materialId: `mat-fake-saved-${n}` };
  const { idempotencyKey: _key, ...page } = body;
  savedHere.unshift(savedPageMaterial(result.materialId, result.id, 100 + n, time, page));
  savedKeys.set(body.idempotencyKey, result);
  return result;
}

/** 范围里的假素材（新的在前），deleted 是这一页里删掉的；167 号票起再按 filter 筛（时间段、种类、会话、关键词，搜的时候摘录换成命中的那一段） */
export function fakeMaterialsIn(scope: MaterialScope | undefined, deleted: ReadonlySet<string>, filter: MaterialListFilter = {}): MaterialListItem[] {
  const inScope = (m: FakeMaterial): boolean => {
    if (scope === undefined) return true;
    if (scope.kind === "conversation") return m.item.conversation === scope.conversation;
    if (scope.kind === "material") return m.item.id === scope.materialId;
    return Date.parse(m.item.time) >= Date.parse(scope.from) && Date.parse(m.item.time) <= Date.parse(scope.to);
  };
  const from = filter.from === undefined ? -Infinity : Date.parse(filter.from);
  const to = filter.to === undefined ? Infinity : Date.parse(filter.to);
  const terms = (filter.query ?? "")
    .split(/\s+/)
    .filter((t) => t.length > 0)
    .map((t) => t.toLowerCase());
  const facets = filter.facets ?? [];
  return all()
    .filter((m) => {
      const time = Date.parse(m.item.time);
      if (deleted.has(m.item.id) || !inScope(m) || time < from || time > to) return false;
      if (filter.conversation !== undefined && m.item.conversation !== filter.conversation) return false;
      if (facets.length > 0 && !facetsOf(m.detail).some((f) => facets.includes(f))) return false;
      const text = searchableText(m.detail).toLowerCase();
      return terms.every((t) => text.includes(t));
    })
    .map((m) => (terms.length > 0 ? { ...m.item, excerpt: snippetOf(searchableText(m.detail), terms) } : m.item));
}

/** 一条假素材的详情；删掉的、没有的是 undefined。noInfer：这一页里标过不参与推断的 */
export function fakeMaterialDetail(id: string, deleted: ReadonlySet<string>, noInfer: ReadonlySet<string>): MaterialDetailView | undefined {
  if (deleted.has(id)) return undefined;
  const found = all().find((m) => m.item.id === id)?.detail;
  return found && noInfer.has(id) ? { ...found, marks: { ...found.marks, noInfer: true } } : found;
}

/** 有假素材的会话各有几条 */
export function fakeMaterialConversations(deleted: ReadonlySet<string>): Array<{ conversation: string; count: number }> {
  const counts = new Map<string, number>();
  for (const m of fakeMaterialsIn(undefined, deleted)) if (m.conversation !== undefined) counts.set(m.conversation, (counts.get(m.conversation) ?? 0) + 1);
  return [...counts].map(([conversation, count]) => ({ conversation, count }));
}
