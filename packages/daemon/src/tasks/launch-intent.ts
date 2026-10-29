// 任务的发起：只有用户点明了才发起（规格第 7 节，ADR 0019，58 号票）。"点明"由运行时判定，不由秘书自报：
// 秘书的 start_workflow（流程）、create_task（长程任务）执行前看用户这一轮说了什么，没点明的拒绝，并告诉秘书按普通对话处理、
// 最多给一张"建议发起任务"卡（卡上"作为流程""作为长程任务"两个按钮由用户点）。
//
// 点明有三种（发起对话框里先选了种类的不经秘书，见 tasks.ts 的 startFromButton）：
// - 输入 `/workflow`、`/task`（打的字开头就是这个命令；310 号票起是英文的，中文的老写法 `/流程`、`/任务` 和 175 号票的 `/ergo_workflow`、
//   `/ergo_task` 照样认）；
// - 用祈使的说法要发起（白名单，58 号票最后一轮核对定的：黑名单补不完）。只看用户自己说的话（打的字、语音转写；
//   引用块、引用的卡片不算），一句一句地看，一句话**开头**就是发起的说法才算：
//   - 流程："按流程做 X""按照这个流程做：X""照那条流程办""用流程帮我 X""发起（一个）流程：X""作为流程来做"；
//   - 长程任务："发起（一个）长程任务：X""建个长程任务 X""开个长程任务 X""作为长程任务"；只说"发起任务""建个任务"的按长程任务；
//   - 说法前面只许有称呼（"二狗，"）、客气词（请、麻烦、帮我、能不能……），以及原来就算点明的几个引子
//     （"这件事""这次""就""不管怎样都""不如"）；别的一律不算（"上礼拜按流程做过""他问要不要按流程做""文档里写着：按流程做"）；
//   - 说法后面：冒号之后是要做的事，不再看；否则同一句里跟着"的、了、过、是、时"（说的是这件事本身）、否定或贬低
//     （没必要、不如、太麻烦、算了……）、"还是""或者"（拿不定）、问功能的词（怎么、多久、什么、区别……）的不算；
//     后面几句里收回（"算了""不用了""没必要"）的也不算；
//   - 问句不算（以问号结尾，或者以"吗""么""呢"收尾），客气的请求除外（"能帮我按流程做吗？"）。
//   两种都说了的按流程（说得更具体）。宁可漏判（秘书最多给一张建议卡，用户点一下就建出），不要误判。
// @i18n-ignore-file data：这里的说法认用户的中文输入；交回秘书的拒绝原因（launchRefusal、delegateRefusal）给模型看，照旧中文（172 号票）
import { forModel, type PlannedTaskKind, TASK_KIND_LABEL } from "@ergo/protocol";
import { ownWords, type OwnWordsSource, type UserTurn } from "../quick-actions/index.ts";
import { commandAt, LAUNCH_COMMAND_ALIASES, LAUNCH_COMMANDS, launchCommandText } from "../slash-commands/commands.ts";

/** 一句话（连同它结尾的标点）：句号、叹号、问号、分号、换行 */
const SENTENCES = /[^。！？!?；;\n]+[。！？!?；;\n]?/g;
/** 分句：逗号、顿号 */
const CLAUSE = /[，,、]/;
/** 问句的收尾（去掉结尾的标点和空白之后） */
const QUESTION_ENDINGS = ["吗", "么", "呢", "没有", "嘛"];
/** 客气的请求（问句的样子，其实是要你做）的说法 */
const POLITE_REQUEST = /帮我|帮忙|给我|替我|麻烦|请|能不能|可不可以|能否|可否|行不行|好不好/;
/** 商量的问句（还没定要不要做）：不算点明 */
const DELIBERATION = /要不要|该不该|需不需要|是不是|有没有必要|用不用|是否|值不值得|还是/;

/** 称呼 */
const ADDRESS = "(?:二狗|狗子|你|您)";
/** 客气词 */
const POLITE = "(?:请|麻烦|劳驾|拜托|帮个忙|(?:能不能|可不可以|能否|可否|能|可以)?\\s*(?:你|您)?\\s*(?:帮我|替我|给我|帮忙)|能不能|可不可以|能否|可否)";
/** 原来就算点明的几个引子（"这件事作为流程来做吧""这次用流程做""不管怎样都按流程做""不如发起任务慢慢弄"） */
const LEAD_IN = "(?:这件事|这事|这个|这次|这回|那就|就|直接|不管怎样|无论如何|反正|总之|不如|干脆)(?:都|也)?";
/** 句首：说法前面只许有这些 */
const LEAD = new RegExp(`^\\s*(?:(?:${ADDRESS}|${POLITE}|${LEAD_IN})\\s*[，,、]?\\s*)*`);

/** 斜杠命令：打的字开头就是它（登记在二狗的斜杠命令表里，82 号票；这里照旧导出，别处不用改引用） */
export { LAUNCH_COMMAND_ALIASES, LAUNCH_COMMANDS, launchCommandText };

/** 点明流程的祈使说法（从句首起）：发起、建、作为、用（一个）流程；按（照）（这个）流程做、办、处理…… */
const WORKFLOW_SAYINGS = [
  /^(?:发起|新建|建|开|起)\s*(?:一个|一条|个|条)?\s*流程(?!图)/,
  /^(?:作为|当作|当成|做成|用)\s*(?:一个|一条|个|条)?\s*流程(?!图)/,
  /^(?:按照|按|照)\s*(?:这个|那个|这条|那条|这|那|一个|一条|个|条)?\s*流程\s*(?:来)?\s*(?:做|办|处理|执行|跑|走|弄|搞|进行)/,
];
/** 点明长程任务的祈使说法（从句首起）：发起、建、作为（一个）长程任务；只说了发起、建（一个）任务 */
const LONG_RUNNING_SAYINGS = [
  /^(?:发起|新建|建|开|起|作为|当作|当成|做成|用|按)\s*(?:一个|个)?\s*长程任务/,
  /^(?:发起|新建|建|开)\s*(?:一个|个)?\s*任务/,
];

/** 说法后面紧跟着这些：说的是这件事本身，不是要做（"发起任务的时候""按流程做了""发起任务是要花钱的"） */
const ABOUT_IT = /^\s*(?:的|了|过|是|时|会|还是|或)/;
/** 说法后面（同一句里）有这些就不算：否定、贬低、拿不定、问功能本身 */
const AFTER_REJECTS =
  /还是|或者|不如|不用|不要|不必|不需要|不想|不行|不好|不了|不值|没必要|没用|没意思|没什么|用不着|犯不着|无需|无须|甭|算了|拉倒|作罢|免了|太|麻烦|费劲|多余|反而|的话|的时候|报错|出错|失败|有问题|有什么用|干嘛|何必|怎么|怎样|多久|多少|什么|哪|为什么|为啥|区别|意思|是否|会不会|能不能|要不要|好不好|行不行/;
/** 后面几句里收回 */
const TAKEN_BACK = /算了|不用了|不要了|不了|免了|拉倒|作罢|没必要|不必了/;
/** 句末的语气词和标点：看说法后面的话时先去掉 */
const TAIL = /[\s\p{P}\p{S}吗么呢吧啊呀哈嘛啦]+$/u;

/** 用户点明了要发起哪种任务，以及点明的话从哪里来（打的字、语音转写） */
export interface LaunchIntent {
  kind: PlannedTaskKind;
  source: OwnWordsSource;
}

function isQuestion(sentence: string): boolean {
  if (/[？?]\s*$/.test(sentence)) return true;
  const body = sentence.replace(/[\s\p{P}\p{S}]+$/u, "");
  return QUESTION_ENDINGS.some((ending) => body.endsWith(ending));
}

/** 问句里算不算点明：客气的请求算，商量的不算 */
const politeRequest = (sentence: string) => POLITE_REQUEST.test(sentence) && !DELIBERATION.test(sentence);

/** 一段话（句首或分句首）去掉称呼、客气词、引子之后，开头是不是发起的说法：是哪种、说法后面剩下的话 */
function sayingAt(text: string): { kind: PlannedTaskKind; after: string } | undefined {
  const rest = text.slice(LEAD.exec(text)?.[0].length ?? 0);
  for (const [kind, sayings] of [
    ["workflow", WORKFLOW_SAYINGS],
    ["long_running", LONG_RUNNING_SAYINGS],
  ] as const) {
    for (const saying of sayings) {
      const found = saying.exec(rest);
      if (found) return { kind, after: rest.slice(found[0].length) };
    }
  }
  return undefined;
}

/** 一句话算不算点明（见文件开头）；算的话是哪种 */
function launchIn(sentence: string): PlannedTaskKind | undefined {
  if (isQuestion(sentence) && !politeRequest(sentence)) return undefined;
  const found = sayingAt(sentence);
  if (!found) return undefined;
  // 冒号之后是要做的事
  if (/^\s*[：:]/.test(found.after)) return found.kind;
  if (ABOUT_IT.test(found.after)) return undefined;
  const after = found.after.replace(TAIL, "");
  if (AFTER_REJECTS.test(after)) return undefined;
  // 两种都说了的按流程："发起任务，按流程做"
  const more = after.split(CLAUSE).slice(1).some((clause) => sayingAt(clause)?.kind === "workflow");
  return more ? "workflow" : found.kind;
}

/** 这段话里点明了哪种：一句一句看，后面几句里收回的不算；两种都点明了的按流程 */
function launchInText(text: string): PlannedTaskKind | undefined {
  const sentences = text.match(SENTENCES) ?? [];
  let kind: PlannedTaskKind | undefined;
  sentences.forEach((sentence, i) => {
    const found = launchIn(sentence);
    if (!found || sentences.slice(i + 1).some((later) => TAKEN_BACK.test(later))) return;
    if (kind !== "workflow") kind = found;
  });
  return kind;
}

/** 用户这一轮点明了要发起哪种任务；没点明是 undefined */
export function launchIntent(turn: UserTurn): LaunchIntent | undefined {
  const words = ownWords(turn);
  for (const { text, source } of words) {
    // 命令后面是空白、标点或者什么都没有（"/流程图怎么画"不是命令；规则在 slash-commands/commands.ts，skill 的展开也照它让路）
    // 310 号票：/workflow、/task，中文的老写法和 175 号票的 /ergo_workflow、/ergo_task 一样算
    for (const kind of ["workflow", "long_running"] as const) if ([LAUNCH_COMMANDS[kind], ...LAUNCH_COMMAND_ALIASES[kind]].some((writing) => commandAt(text, writing))) return { kind, source };
  }
  const found = words.map((w) => ({ kind: launchInText(w.text), source: w.source }));
  const workflow = found.find((f) => f.kind === "workflow");
  if (workflow) return { kind: "workflow", source: workflow.source };
  const longRunning = found.find((f) => f.kind === "long_running");
  if (longRunning) return { kind: "long_running", source: longRunning.source };
  return undefined;
}

/**
 * 秘书要发起这种任务，用户这一轮点明了没有：点明的种类和它要的一样就是 undefined（可以建），
 * 否则是交回秘书的原因（没点明、点明的是另一种）
 */
export function launchRefusal(turn: UserTurn, wanted: PlannedTaskKind, tools: Readonly<Record<PlannedTaskKind, string>> & { suggest: string }): string | undefined {
  return forModel(() => launchRefusalText(turn, wanted, tools));
}

function launchRefusalText(turn: UserTurn, wanted: PlannedTaskKind, tools: Readonly<Record<PlannedTaskKind, string>> & { suggest: string }): string | undefined {
  const intent = launchIntent(turn);
  if (intent?.kind === wanted) return undefined;
  if (intent) {
    return `用户这一轮点明的是${TASK_KIND_LABEL[intent.kind]}，不是${TASK_KIND_LABEL[wanted]}：用 ${tools[intent.kind]} 发起。（只说“发起任务”没说种类的按长程任务。）`;
  }
  return (
    `用户这一轮没有点明要发起任务（一句话开头就是“按流程做：……”“发起一个流程：……”“发起任务：……”“建个长程任务……”这类祈使的说法，或者输入 ${launchCommandText("workflow")}、${launchCommandText("long_running")}），不能建任务。` +
    `按普通对话处理：能直接回答的直接回答；你觉得该发起任务时，最多用 ${tools.suggest} 给一张“建议发起任务”卡，用户点卡上的“作为流程”或“作为长程任务”才建出。`
  );
}

/**
 * 秘书要把一件事交给后台（delegate_task，75 号票）：用户这一轮点明了要发起流程或长程任务时不行——用户要的是那种做法，
 * 交回秘书的原因里指向该用的工具；没点明是 undefined（交给后台不用点明）
 */
export function delegateRefusal(turn: UserTurn, tools: Readonly<Record<PlannedTaskKind, string>> & { suggest: string }): string | undefined {
  const intent = launchIntent(turn);
  if (!intent) return undefined;
  return (
    `用户这一轮点明了要发起${forModel(() => TASK_KIND_LABEL[intent.kind])}，不能交给后台做成普通任务：用 ${tools[intent.kind]} 发起。` +
    `（拿不准用户要流程还是长程任务时，用 ${tools.suggest} 给一张建议卡让用户点。）`
  );
}
