// agent 自己申请目录授权（464，ADR-0049 第 6 条之后的"agent 申请"）：有目录授权表的 agent（个人助理、项目的负责人、任务的负责人；
// 子 agent、评审、记忆管理员没有）用 request_folder_grant 申请把一个范围之外的目录登记进它自己的那一份。
// - 工具只查 + 发一张"目录授权申请"卡（folder_grant_request），**不登记**：卡出在它自己的会话里（工具产生的卡片）、进待办；
//   发了就回"已发给用户，等确认"，不阻塞这一轮。守卫里它不改东西（只读或幂等、只看：再调一次只会回"已经在等"），也不登记路径参数，
//   所以不会因为目录在范围之外先弹审批；
// - 发卡前先查，查不过的直接回原因、不发卡：目录不对（和 ⚙ 里加的同一套：folder-grants.ts 的 resolve）；这个 agent 已经登记了、
//   要的操作都有了、没过期、期限也够（到期不早于这次要的，长期有效的最长；所有 agent 都能读的文件夹里只要读的也算）→ "已经有了"；
//   期限不够的（要延长：已有的有期限、这次要得更久或者要长期有效）照常发卡，卡上写"现在到某时，这次要延到某时"；
//   同一个 agent 同一个目录已经有一张没处理的申请卡 → "已经在等用户确认"；
// - 卡上写哪个 agent、目录、要的操作、多久、为什么；这个目录（或上级）已经登记了的写明已有什么，在授权的文件夹里的写明"读本来就行"；
// - 用户在卡上能去掉几样操作（不能加没要的）、改多久，再"同意"/"不同意"（都可附一句话）。同意：先按 ADR-0049 的校验并进它的表
//   （folder-grants.ts 的 merge：操作取并集、到期取更晚的，已有的那条不会被收窄；谁加的记"它申请、你同意的"），登记不成抛错、
//   卡上写原因、不算同意；不同意不登记；
// - 结果作为一条通知交回这个 agent 的会话（buildAgentNotice：负责人这时不在跑的照别的卡的结果那样叫醒，秘书的照常接着说）。
// 过期、没人理和别的等你拍板的卡一样（不另发明）。给模型看的话照旧中文（工具说明、工具结果、通知），给人看的走 t()。
import {
  clockLabel,
  PURGED_TEXT,
  type ConversationId,
  FOLDER_GRANT_MODES,
  FOLDER_GRANT_REASON_MAX,
  FOLDER_GRANT_REQUEST_DAYS_MAX,
  type FolderGrantMode,
  FolderGrantRequestApproveInput,
  FolderGrantRequestCardPayload,
  type InboxOrigin,
  internalMark,
  type MessageScope,
  nowIso,
  type ProjectInternal,
  t,
  Type,
} from "@ergo/protocol";
import { defineHostTool, type HostTool } from "../agent-manager/host-tools.ts";
import type { CardService } from "../cards/cards.ts";
import { type CardActionEffect, defineCardType } from "../cards/registry.ts";
import { buildAgentNotice } from "../conversation/messages.ts";
import { RequestRejected } from "../errors.ts";
import type { EventStore, NewEvent } from "../events/event-store.ts";
import { comparable, isWithin } from "../guard/index.ts";
import type { InboxService } from "../inbox/inbox.ts";
import { oneLine } from "../util/text.ts";
import { folderGrantExpired, type FolderGrantRecord, type FolderGrants } from "./folder-grants.ts";
import { REQUEST_FOLDER_GRANT_TOOL } from "./tool-names.ts";

export { REQUEST_FOLDER_GRANT_TOOL } from "./tool-names.ts";

const DAY_MS = 24 * 60 * 60 * 1000;

/** 有表的 agent 在哪：卡和结果的通知交到它的会话，待办里写它是谁、去哪 */
export interface FolderGrantOwner {
  /** 给人看的：个人助理是名字占位、项目「…」的负责人、任务「…」的负责人 */
  label: string;
  /** 它的会话：结果的通知交到这里（卡跟着工具调用出在这里） */
  conversation: ConversationId;
  /** 通知带的归属（项目、任务） */
  scope: MessageScope;
  /** 待办里的来源、"去看看 ›"去的地方，项目内部任务的标记 */
  source: string;
  origin: InboxOrigin;
  internal?: ProjectInternal | undefined;
}

export interface FolderGrantRequestsOptions {
  store: Pick<EventStore, "appendBatch">;
  cards: Pick<CardService, "buildCreate" | "get">;
  inbox: Pick<InboxService, "buildAdd" | "list" | "alert">;
  /** 目录授权表：查已有的、查目录、同意时并进去 */
  grants: Pick<FolderGrants, "list" | "resolve" | "merge">;
  /** 所有 agent 都能读的文件夹（授权的文件夹，每次现读；写法和守卫看到的一样） */
  authorizedFolders: () => readonly string[];
  /** 有表的 agent 在哪；没有表（子 agent、评审、记忆管理员，删掉了的项目）的是 undefined */
  ownerOf: (agentId: string) => FolderGrantOwner | undefined;
  /** 现在（毫秒） */
  now: () => number;
  /** 登记了一条之后（到期前提示马上看一遍：离到期已经不到三天的） */
  onRegistered?: () => void;
  log: (line: string) => void;
}

export interface FolderGrantRequests {
  /** 这个 agent 的申请工具（绑在它身上：只能申请进它自己的表） */
  tool(agentId: string): HostTool;
  /** 申请卡上的同意（input：收窄）、不同意 */
  decide(payload: FolderGrantRequestCardPayload, decision: { approved: true; input: FolderGrantRequestApproveInput } | { approved: false }, note: string | undefined, idempotencyKey: string): CardActionEffect<FolderGrantRequestCardPayload>;
}

/** 操作按读、写、删排好、去重 */
const sortedModes = (modes: readonly FolderGrantMode[]): FolderGrantMode[] => FOLDER_GRANT_MODES.filter((m) => modes.includes(m));

/** 选的天数换成到期时间：从现在起第几天的 23:59（守护进程这边的本地时间；和 ⚙ 里加的一样算） */
export function folderGrantExpiryAfter(days: number, now: number): string {
  const at = new Date(now + days * DAY_MS);
  at.setHours(23, 59, 0, 0);
  return nowIso(at);
}

// ───────────────────────── 给人看的 ─────────────────────────

const MODE_KEY = { read: "folders.grants.mode.read", write: "folders.grants.mode.write", delete: "folders.grants.mode.delete" } as const;

/** 操作怎么说（"读、写"） */
const modesText = (modes: readonly FolderGrantMode[]) =>
  sortedModes(modes)
    .map((m) => t(MODE_KEY[m]))
    .join(t("folders.grants.modeSep"));

/** 时间写给人看（2026-11-19 23:59） */
const timeText = (iso: string) => `${iso.slice(0, 10)} ${clockLabel(iso)}`;

/** 多久怎么说：长期有效、几天 */
const durationText = (days: number | undefined) => (days === undefined ? t("folders.request.forever") : t("folders.request.days", { count: days }));

/** 到期怎么说：长期有效、到某时 */
const expiryText = (expiresAt: string | undefined) => (expiresAt === undefined ? t("folders.request.forever") : t("folders.request.until", { at: timeText(expiresAt) }));

/** 卡的纯文本：谁申请什么、为什么；处理过的加一行结果 */
function cardText(p: FolderGrantRequestCardPayload): string {
  const head = t("folders.request.cardText", { agent: p.agentLabel, modes: modesText(p.modes), path: p.path, duration: durationText(p.days) });
  const result = p.decided
    ? p.decided.approved && p.decided.grant
      ? t("folders.request.cardApproved", { modes: modesText(p.decided.grant.modes), expiry: expiryText(p.decided.grant.expiresAt) })
      : t("folders.request.cardDenied")
    : undefined;
  return [head, t("folders.request.cardWhy", { why: p.why }), ...(result === undefined ? [] : [result])].join("\n");
}

// ───────────────────────── 给模型看的 ─────────────────────────

// @i18n-ignore-start model：工具说明、参数说明、工具结果、交给 agent 的通知
const TOOL_DESCRIPTION =
  "申请把一个你范围之外的目录登记进你自己的目录授权（读、写、删分开要）。什么时候用：接下来要反复在某个范围之外的目录里读写" +
  "（比如用户让你整理 D:\\笔记、往某个文件夹里导出东西），先申请一次，免得每次都弹审批；被拦下、说明里写着\"没登记\"的，也可以用它申请。" +
  "只要真需要的操作（只看就只要 read），能定期限就写 days（这件事三天做完写 3），why 写清要在里面做什么、为什么要这几种操作。" +
  "它只发一张申请卡给用户，不等结果、不阻塞这一轮：用户在卡上同意（可能去掉几样、改期限）之后才登记，结果会作为一条通知交给你，那时再接着做；" +
  "等的时候别反复申请，也别绕路去碰那个目录。已经登记了的（操作都有、期限也够）、已经在等用户确认的不会重复发卡；登记了但期限不够、要延长的，照样申请，写上要多久。" +
  "你自己改不了目录授权表，别用别的办法去改。" +
  "登记了也不放的：数据目录、程序目录，登记目录里的 .env、私钥这类密钥文件。";

const toolParams = Type.Object(
  {
    path: Type.String({ minLength: 1, maxLength: 1000, description: "要登记的目录，写完整路径（比如 D:\\笔记）；登记的是整个目录，不是单个文件" }),
    modes: Type.Array(Type.Enum(FOLDER_GRANT_MODES), {
      minItems: 1,
      maxItems: 3,
      uniqueItems: true,
      description: "要的操作：read 读（读、列、搜）、write 写（新建、改、覆盖）、delete 删（单独要，要了删不带写；移动要写和删）。只要真需要的",
    }),
    days: Type.Optional(Type.Integer({ minimum: 1, maximum: FOLDER_GRANT_REQUEST_DAYS_MAX, description: "要几天（到第几天的 23:59 为止）；能定期限就写，不写是长期有效" })),
    why: Type.String({ minLength: 1, maxLength: FOLDER_GRANT_REASON_MAX, description: "为什么要（用户在卡上看得到）：要在里面做什么、为什么要这几种操作" }),
  },
  { additionalProperties: false },
);

/** 一条登记说给模型听："读、写（长期有效）" */
const grantForModel = (modes: readonly FolderGrantMode[], expiresAt: string | undefined) => `${modesText(modes)}（${expiresAt === undefined ? "长期有效" : `到 ${timeText(expiresAt)}`}）`;

const alreadyText = (dir: string, covering: readonly FolderGrantRecord[], readable: boolean) =>
  [
    `不用申请，已经有了：${dir}`,
    ...covering.map((g) => `- 你的目录授权里登记了 ${g.path}：${grantForModel(g.modes, g.expiresAt)}`),
    ...(readable ? ["- 它在所有 agent 都能读的文件夹里：读本来就行"] : []),
    "直接做就行，不用等用户。",
  ].join("\n");

const waitingText = (dir: string, waiting: FolderGrantRequestCardPayload) =>
  `${dir} 已经有一张申请卡在等用户确认（要${modesText(waiting.modes)}）：先等它有结论，结果会作为一条通知交给你，别再发一张。`;

const sentText = (p: FolderGrantRequestCardPayload) =>
  `已发给用户，等确认：申请卡（${p.path}，要${modesText(p.modes)}，${p.days === undefined ? "长期有效" : `${p.days} 天`}）放进了用户的待办，也在这个会话里。` +
  "用户同意之前没有登记，别去碰这个目录；结果会作为一条通知交给你，那时再接着做。先告诉用户卡在这里、点同意就生效，这一轮可以先做别的或者先停下。";

function approvedNotice(p: FolderGrantRequestCardPayload, granted: { modes: FolderGrantMode[]; expiresAt?: string | undefined }, grant: FolderGrantRecord, note: string | undefined): string {
  const narrowed = granted.modes.length < p.modes.length ? `（你要的是${modesText(p.modes)}，用户只给了这些）` : "";
  const merged = grant.modes.length !== granted.modes.length || grant.expiresAt !== granted.expiresAt ? `并进原来那条之后现在是：${grantForModel(grant.modes, grant.expiresAt)}。` : "";
  return [
    `用户同意了你申请的目录授权：${p.path}，${grantForModel(granted.modes, granted.expiresAt)}${narrowed}。${merged}`,
    ...(note ? [`用户说：「${note}」`] : []),
    "现在在这个目录里做这几种操作不用再问；没给的照旧。接着做你要做的事。",
  ].join("\n");
}

const deniedNotice = (p: FolderGrantRequestCardPayload, note: string | undefined) =>
  `用户没同意你申请的目录授权：${p.path}（要${modesText(p.modes)}）${note ? `，用户说：「${note}」` : ""}。没有登记，这个目录照旧：碰它要先问用户，或者换个做法。`;
// @i18n-ignore-end

// ───────────────────────── 服务 ─────────────────────────

export function createFolderGrantRequests(options: FolderGrantRequestsOptions): FolderGrantRequests {
  const { store, cards, inbox, grants } = options;

  /** 在所有 agent 都能读的文件夹里（授权的文件夹按写的和守卫一样比） */
  const readableIn = (dir: string) => options.authorizedFolders().some((folder) => isWithin(dir, folder));

  /** 这个 agent 同一个目录还在等用户的那张申请卡 */
  const waitingFor = (agentId: string, dir: string): FolderGrantRequestCardPayload | undefined =>
    inbox
      .list()
      .flatMap((item) => (item.kind === "card" ? [cards.get(item.cardId)] : []))
      .flatMap((card) => (card?.type === "folder_grant_request" && card.status === "pending" ? [card.payload as FolderGrantRequestCardPayload] : []))
      .find((p) => p.agentId === agentId && comparable(p.path) === comparable(dir));

  const tool = (agentId: string): HostTool =>
    defineHostTool({
      name: REQUEST_FOLDER_GRANT_TOOL,
      title: t("folders.request.tool"),
      description: TOOL_DESCRIPTION,
      parameters: toolParams,
      // 只发一张卡：不改东西（再调一次只会回"已经在等"），不登记路径参数（不因为目录在范围之外先弹审批）
      readOnlyOrIdempotent: true,
      nature: "look",
      run(args) {
        const owner = options.ownerOf(agentId);
        // @i18n-ignore-next model：工具结果
        if (!owner) return { text: "你没有目录授权表（只有个人助理、项目和任务的负责人有），申请不了。要碰这个目录就先问用户。", isError: true };
        // @i18n-ignore-next model：工具结果
        if (args.why.trim() === "") return { text: "没发申请卡：why 要写清为什么要（用户在卡上看得到）。", isError: true };
        let dir: string;
        try {
          dir = grants.resolve(args.path);
        } catch (err) {
          // @i18n-ignore-next model：工具结果
          if (err instanceof RequestRejected) return { text: `没发申请卡：${err.message}`, isError: true };
          throw err;
        }
        const modes = sortedModes(args.modes);
        const now = options.now();
        const mine = grants.list().filter((g) => g.agentId === agentId && isWithin(dir, g.path));
        const active = mine.filter((g) => !folderGrantExpired(g, now));
        const readable = readableIn(dir);
        // 期限够不够：长期有效的总够；有期限的要不早于这次要的（这次要长期有效的，有期限的都不够）
        const wantUntil = args.days === undefined ? undefined : Date.parse(folderGrantExpiryAfter(args.days, now));
        const lastsLongEnough = (g: FolderGrantRecord) => g.expiresAt === undefined || (wantUntil !== undefined && Date.parse(g.expiresAt) >= wantUntil);
        // 要的操作都有了、期限也够（登记了的没过期；所有 agent 都能读的文件夹里的读也算，那里一直能读）；期限不够的照常发卡（要延长）
        if (modes.every((m) => active.some((g) => g.modes.includes(m) && lastsLongEnough(g)) || (m === "read" && readable))) {
          return { text: alreadyText(dir, active.filter((g) => g.modes.some((m) => modes.includes(m))), readable) };
        }
        const waiting = waitingFor(agentId, dir);
        if (waiting) return { text: waitingText(dir, waiting) };
        // 已有的那条：这个目录自己的（没过期的优先），没有就是登记了它的上级里最近的那条
        const exact = mine.find((g) => comparable(g.path) === comparable(dir));
        const nearest = (exact && !folderGrantExpired(exact, now) ? exact : undefined) ?? active.toSorted((a, b) => comparable(b.path).length - comparable(a.path).length)[0] ?? exact;
        const payload: FolderGrantRequestCardPayload = {
          agentId,
          agentLabel: owner.label,
          path: dir,
          modes,
          ...(args.days === undefined ? {} : { days: args.days }),
          why: args.why.trim(),
          ...(nearest
            ? { existing: { path: nearest.path, modes: nearest.modes, ...(nearest.expiresAt === undefined ? {} : { expiresAt: nearest.expiresAt }), expired: folderGrantExpired(nearest, now) } }
            : {}),
          ...(readable ? { readable: true as const } : {}),
        };
        const card = cards.buildCreate({ type: "folder_grant_request", urgency: "non_blocking", payload });
        const item = inbox.buildAdd({
          kind: "card",
          cardId: card.card.id,
          title: oneLine(t("folders.request.inboxTitle", { agent: owner.label, path: dir }), 80),
          source: owner.source,
          origin: owner.origin,
          ...internalMark(owner.internal),
          urgency: "non_blocking",
        });
        store.appendBatch([card.event, item.event]);
        inbox.alert(item.item);
        options.log(`${agentId} 申请目录授权：${dir}（${modes.join("、")}），卡 ${card.card.id}`);
        return { text: sentText(payload), cardIds: [card.card.id] };
      },
    });

  const decide: FolderGrantRequests["decide"] = (payload, decision, note, idempotencyKey) => {
    if (payload.decided) throw new RequestRejected("conflict", t("folders.request.decided"));
    const comment = note?.trim() || undefined;
    const at = nowIso(new Date(options.now()));
    const owner = options.ownerOf(payload.agentId);
    const notice = (text: string): NewEvent[] => (owner ? [buildAgentNotice(owner.conversation, text, `${idempotencyKey}#notice`, owner.scope).event] : []);
    if (!decision.approved) {
      options.log(`${payload.agentId} 申请的目录授权（${payload.path}）用户没同意`);
      return {
        status: "handled",
        payload: { ...payload, decided: { approved: false, at, ...(comment ? { note: comment } : {}) } },
        ...(comment ? { note: comment } : {}),
        events: notice(deniedNotice(payload, comment)),
      };
    }
    const input = decision.input ?? {};
    // 只能在要的操作里去掉几样，不能加没要的
    const modes = sortedModes(input.modes ?? payload.modes);
    const extra = modes.filter((m) => !payload.modes.includes(m));
    if (extra.length > 0) throw new RequestRejected("bad_params", t("folders.request.notRequested", { modes: modesText(extra) }));
    if (modes.length === 0) throw new RequestRejected("bad_params", t("folders.grants.noModes"));
    const days = input.days === undefined ? payload.days : (input.days ?? undefined);
    const expiresAt = days === undefined ? undefined : folderGrantExpiryAfter(days, options.now());
    // 登记不成（目录没了、不能登记、这个 agent 已经没有表了、超过上限）：抛错，卡上写原因，不算同意
    const grant = grants.merge({ agentId: payload.agentId, path: payload.path, modes, expiresAt, note: payload.why, addedBy: "request" });
    options.onRegistered?.();
    options.log(`${payload.agentId} 申请的目录授权用户同意了：${grant.path}（${grant.modes.join("、")}${grant.expiresAt === undefined ? "，长期有效" : `，到 ${grant.expiresAt}`}）`);
    const granted = { modes, ...(expiresAt === undefined ? {} : { expiresAt }) };
    return {
      status: "handled",
      payload: {
        ...payload,
        decided: { approved: true, at, ...(comment ? { note: comment } : {}), granted, grant: { modes: grant.modes, ...(grant.expiresAt === undefined ? {} : { expiresAt: grant.expiresAt }) } },
      },
      note: t("folders.request.approvedNote", { modes: modesText(grant.modes), expiry: expiryText(grant.expiresAt) }),
      events: notice(approvedNotice(payload, granted, grant, comment)),
    };
  };

  return { tool, decide };
}

/** "目录授权申请"卡：同意（approve，可以带收窄：勾着的操作、多久）、不同意（deny），都可附一句话 */
export function folderGrantRequestCardType(requests: Pick<FolderGrantRequests, "decide">) {
  return defineCardType({
    type: "folder_grant_request",
    version: 1,
    payload: FolderGrantRequestCardPayload,
    actions: {
      approve: { input: FolderGrantRequestApproveInput, run: ({ payload, input, note, idempotencyKey }) => requests.decide(payload, { approved: true, input }, note, idempotencyKey) },
      deny: { input: undefined, run: ({ payload, note, idempotencyKey }) => requests.decide(payload, { approved: false }, note, idempotencyKey) },
    },
    toText: cardText,
    // 彻底删除：用户在卡上附的那句话换成删除标记（处理结果里的那句卡片服务自己换）；申请的内容是 agent 写的，不动
    purge: (p) => (p.decided?.note === undefined ? p : { ...p, decided: { ...p.decided, note: PURGED_TEXT } }),
  });
}
