// 原型里的设置 · 插件（211 号票）：守护进程清单里的插件（提醒、记忆，213 号票起还有日历，214 号票加了语音，212 号票加了内置浏览器），
// 停用、启用、移除只在内存里，变了在插件频道上推新的状况（和守护进程一样，网页插件跟着装、停）。299 号票加了手机插件，296 号票加了 Looki，297 号票加了 Google，
// 305 号票加了 Claude Code（有了网页的那一半：设置 · Claude Code）。
// 地址带 ?demo-plugins-off=memory,reminders,calendar,voice,browsing,phone,google,looki 时那几个开头就是停用的（193 号票），
// ?demo-plugins-removed=reminders 时开头就是移除了的。给人看的字是守护进程按当前语言写的，原型里按打开时的语言挑中文或英文。
import { activeLocale, type PluginAction, type PluginActionResult, type PluginInfo, type PluginState, type PluginStatusEventPayload, type PluginsView } from "../state/index.ts";

/** 原型的演示数据：中文、英文各一句（守护进程那边是它的语言文件） */
const say = (zh: string, en: string) => (activeLocale().meta.id === "en" ? en : zh);

/** 插件给人看的样子（守护进程那一半：一句话、带来的工具和卡片、连数据删删哪些删不掉哪些；日历不拥有数据，没有连数据删） */
function about(name: string): Omit<PluginInfo, "state" | "needs" | "neededBy" | "stopsWith" | "startsWith"> {
  const backup = say("备份快照里的一份（随快照轮换消失：本机约 7 天，同步目录最长约 5 周）", "The copy in backup snapshots (goes away as snapshots rotate: about 7 days locally, up to about 5 weeks in the sync folder)");
  if (name === "reminders") {
    return {
      name,
      title: say("提醒", "Reminders"),
      summary: say("到点或者某件事发生时提醒你一声：简单提醒，不用 agent 干活", "Gives you a heads-up at a set time or when something happens — simple reminders, no agent work"),
      brings: {
        tools: [say("建简单提醒", "Create reminder"), say("改简单提醒", "Edit reminder"), say("取消简单提醒", "Cancel reminder"), say("归档简单提醒", "Archive reminder")],
        cards: [say("提醒卡", "Reminder cards")],
        jobs: [],
      },
      removal: {
        deletes: [
          say("全部提醒（看板、日历上的）和它们每一次的改动、触发记录", "All reminders (on the board and calendar) with every edit and firing record"),
          say("提醒卡的每个版本（聊天、待办里的）", "Every version of reminder cards (in chats and the inbox)"),
          say("待办里「提醒：……」「错过的提醒」这些通知", 'Inbox notices like "Reminder: …" and "Missed reminder"'),
        ],
        keeps: [say("聊天里提到过的提醒内容（你让它建提醒时说的话、它的回话）", "What the chat says about reminders (what you told it, its replies)"), backup],
      },
    };
  }
  if (name === "calendar") {
    return {
      name,
      title: say("日历", "Calendar"),
      summary: say(
        "按月看每天上班还是休息、当天的提醒、定时触发的任务和订阅的外部日历；只是合起来看，不存自己的数据",
        "A monthly view of which days you work or rest, with that day's reminders, scheduled tasks and subscribed external calendars — it only puts them together and keeps no data of its own",
      ),
      brings: { tools: [], cards: [], jobs: [] },
    };
  }
  if (name === "phone") {
    return {
      name,
      title: say("手机", "Phone"),
      summary: say(
        "手机上的二狗 App 读本机：从通讯录挑人进档案候选，手机日历放进二狗的日历，照片的时间地点和位置按天整理成摘要进记忆",
        "The Ergo app on your phone reads local data: pick contacts into profile suggestions, put the phone calendar into Ergo's calendar, and summarize photo times/places and locations into memory day by day",
      ),
      brings: { tools: [], cards: [], jobs: [] },
      removal: {
        deletes: [
          say("从通讯录挑的人的记录", "Records of the people picked from contacts"),
          say("手机日历同步来的日程和连接状况", "Events synced from the phone calendar and its connection status"),
          say(
            "照片、位置每天的摘要和连接状况，原始的照片时间地点和位置点（数据目录里的 phone 文件夹）",
            "Daily photo and location summaries and connection status, and the raw photo times/places and location points (the phone folder in the data directory)",
          ),
        ],
        keeps: [
          say("已经写进个人档案的、档案候选里还没处理的（要删先在设置 · 数据源里断开并连已导入的一起删）", "What's already in personal profiles, and suggestions not yet handled (to delete them, first disconnect in Settings · Data sources and delete what was imported)"),
          say(
            "照片、位置的摘要已经采成的记忆素材（要删先在设置 · 数据源里断开并连已导入的一起删，或者到记忆 · 素材里删）",
            "Memory materials already made from the photo and location summaries (to delete them, first disconnect with imported data in Settings · Data sources, or delete them in Memory · Materials)",
          ),
          backup,
        ],
      },
    };
  }
  if (name === "google") {
    return {
      name,
      title: "Google",
      summary: say("接 Google 账号里的数据：日历（私密 iCal 地址，只读，显示在日历里、问到安排时现查）、Gmail（应用专用密码，只读，问到时现搜现读，可选导入你发出的邮件）、联系人（导出的 vCard 放进导入文件夹，进档案候选核对卡）", "Brings in data from your Google account: Calendar (private iCal address, read-only, shown in the calendar and checked live when you ask about your schedule), Gmail (app password, read-only, searched and read live when you ask; optionally imports the mail you send) and Contacts (an exported vCard dropped into the import folder goes to the profile review card)"),
      brings: { tools: [say("查 Google 日历", "Check Google Calendar"), say("搜 Gmail 邮件", "Search Gmail"), say("读 Gmail 邮件", "Read a Gmail message")], cards: [], jobs: [] },
      removal: {
        deletes: [
          say("同步来的 Google 日历事件和日历的名字", "Synced Google Calendar events and calendar names"),
          say("填过的私密 iCal 地址（这台电脑的密钥区里）", "The private iCal addresses you entered (in this computer's secrets area)"),
          say("导入的你发出的邮件（开了「导入」才有）", "Imported mail you sent (only if Import was on)"),
          say("填过的 Gmail 地址和应用专用密码（这台电脑的密钥区里）", "The Gmail address and app password you entered (in this computer's secrets area)"),
          say("从 Google 联系人导入的记录", "Records imported from Google Contacts"),
        ],
        keeps: [say("聊天里提到过的日程", "Events mentioned in chats"), say("你发出的邮件整理成的素材：素材属于内核，要删请去 记忆 · 素材 的成批删除（记忆插件不在时是 设置 · 删除素材）", "Material made from the mail you sent: material belongs to the core; to delete it use bulk delete in Memory · Material (Settings · Delete material when the memory plugin is off)"), say("已经写进个人档案的、档案候选里还没处理的（要删先在设置 · 数据源里删除 Google · 联系人已导入的）", "What's already in personal profiles, and suggestions still waiting for review (to delete those, first delete what Google · Contacts imported in Settings · Data sources)"), backup],
      },
    };
  }
  if (name === "looki") {
    return {
      name,
      title: "Looki",
      summary: say(
        "接 Looki 挂脖相机的官方开放接口：每天的「时刻」（什么时候、在哪、在做什么）整理成素材，被问到「我昨天下午在干嘛」时现查",
        "Connects to the official open API of the Looki wearable camera: each day's moments (when, where, what you were doing) become materials, and are looked up on the spot when you ask “what was I doing yesterday afternoon”",
      ),
      brings: { tools: [say("查 Looki", "Look up Looki")], cards: [], jobs: [] },
      removal: {
        deletes: [say("从 Looki 导入的时刻和 AI 日记（记录）", "Moments and AI journals imported from Looki (the records)"), say("填过的 Looki API Key", "The Looki API key you entered")],
        keeps: [
          say(
            "由它们整理出的素材：素材属于内核，要删请去 记忆 · 素材 的成批删除；或者移除之前先在 设置 · 数据源 里断开 Looki、选「连已导入的一起删」",
            'Materials made from them: materials belong to the core — to delete them, use bulk delete in Memory · Materials, or before removing, disconnect Looki in Settings · Data sources and choose "Delete what was imported too"',
          ),
          say("聊天里查过 Looki 的那几轮（查到的时刻、二狗的回话）", "The chat turns that looked up Looki (the moments found, Ergo's replies)"),
          backup,
        ],
      },
    };
  }
  if (name === "browsing") {
    return {
      name,
      title: say("内置浏览器", "Built-in browser"),
      summary: say(
        "鸿蒙 App 里的「浏览」：浏览侧边栏、网页框上的悬浮按钮，替你读网页、填框、找文件交文件、点按钮，联网搜索也能用它",
        "Browse in the HarmonyOS app: the browse sidebar and the floating button on page fields; it reads pages, fills fields, finds and attaches files and clicks buttons for you, and web search can use it",
      ),
      brings: {
        tools: [
          say("读网页", "Read page"),
          say("填选中的框", "Fill selected field"),
          say("找文件", "Find files"),
          say("看图", "View images"),
          say("给选中的上传框交文件", "Attach files to selected upload field"),
          say("在内置浏览器里开网址", "Open URL in built-in browser"),
          say("看网页上能点的东西", "See what's clickable on the page"),
          say("点网页上的一个元素", "Click an element on the page"),
        ],
        cards: [say("网页候选卡", "Web page candidates card")],
        jobs: [],
      },
      removal: {
        deletes: [say("网页候选卡的每个版本（聊天、侧边栏里挑图片的那种卡）", "Every version of the web page candidates cards (the image-picking cards in chat and the sidebar)"), say("候选文件的缩略图缓存", "The thumbnail cache of candidate files")],
        keeps: [
          say(
            "存进素材的网页：素材属于内核，要删请去 记忆 · 素材 的成批删除（记忆插件不在时是 设置 · 删除素材）",
            "Web pages saved to materials: materials belong to the core; to delete them use bulk delete in Memory · Materials (Settings · Delete materials when the memory plugin is off)",
          ),
          say("聊天里浏览那几轮的消息和工具调用记录（你在侧边栏、悬浮按钮上说的话，它读到的网页、它的回话）", "The messages and tool call records of browsing turns in the chat (what you said in the sidebar or on the floating button, the pages it read, its replies)"),
          backup,
        ],
      },
    };
  }
  // 305 号票：Claude Code 插件（运行时；网页的那一半是设置 · Claude Code）。不拥有数据，没有连数据删
  if (name === "claude-code") {
    return {
      name,
      title: "Claude Code",
      summary: say("项目、任务的维护者能用本机的 Claude Code 跑会话；能接管本机已有的会话；设置里定新建时的默认文件夹", "Lets project and task maintainers run sessions with Claude Code on this computer, take over existing sessions, and set a default folder for new work"),
      brings: { tools: [], cards: [], jobs: [] },
    };
  }
  if (name === "voice") {
    return {
      name,
      title: say("语音", "Voice"),
      summary: say("按住说话发语音、识别成文字；二狗用语音回复、发语音，设置里管参考音色", "Hold to talk and send voice messages, transcribed to text; Ergo replies and sends messages by voice; manage reference voices in Settings"),
      brings: { tools: [say("口语总结", "Spoken summary"), say("发语音", "Send voice message")], cards: [], jobs: [] },
      removal: {
        deletes: [
          say("你发过的语音的录音", "Recordings of the voice messages you sent"),
          say("二狗合成出的语音（音频文件）", "Voice messages Ergo synthesized (the audio files)"),
          say("语音记录里的文字：识别出的文字、二狗念的原文（聊天里语音气泡的「转文字」）", 'Text in voice records: what was recognized and what Ergo read aloud ("To text" on voice bubbles in chats)'),
          say("参考音色（设置 · 语音里导入的录音和逐字稿）", "Reference voices (the recordings and transcripts imported in Settings · Voice)"),
          say("待办里「语音识别不可用」「要合成语音，得先导入参考音色」这两种说明", 'Notes in the inbox like "Speech recognition unavailable" and "Import a reference voice to get voice replies"'),
        ],
        keeps: [
          say("会话里转写成文字交给过二狗的那部分（二狗看到的语音转写、它的回话）：归会话，不删", "What reached Ergo as text in conversations (the transcripts Ergo saw and its replies): it belongs to the conversation and stays"),
          say(
            "素材库里由语音转写成的素材：素材属于内核，要删请去 记忆 · 素材 的成批删除（记忆插件不在时是 设置 · 删除素材）",
            "Materials transcribed from voice: materials belong to the core — to delete them, use bulk delete in Memory · Materials (Settings · Delete materials when the Memory plugin is gone)",
          ),
          backup,
        ],
      },
    };
  }
  return {
    name,
    title: say("记忆", "Memory"),
    summary: say("把你说过的话采成素材，记住、忘掉、彻底删除、别推断，二狗回答时检索记忆", "Turns what you've said into materials; remember, forget, purge and don't-infer commands; Ergo searches memory when answering"),
    brings: { tools: [say("检索素材", "Search materials"), say("读素材", "Read material")], cards: [say("记忆删除卡", "Memory deletion cards")], jobs: [] },
    removal: {
      deletes: [
        say("你让二狗「记住」的话（记忆命令里的那段内容）", 'What you asked Ergo to "remember" (the text in those memory commands)'),
        say("建议卡、提问卡长期没处理的记录", "Records of suggestion and question cards left unhandled for a long time"),
        say("记忆删除卡的每个版本（聊天、待办里的）", "Every version of memory deletion cards (in chats and the inbox)"),
      ],
      keeps: [
        say(
          "素材库里的素材（你说过的话、存过的网页、记住的话）：素材属于内核，要删请去 记忆 · 素材 的成批删除（记忆插件不在时是 设置 · 删除素材）",
          "Materials in the library (what you've said, saved web pages, things to remember): materials belong to the core — to delete them, use bulk delete in Memory · Materials (Settings · Delete materials when the Memory plugin is gone)",
        ),
        say(
          "忘掉、彻底删除、别推断这些记忆命令的记录：它们记着哪些素材删了，删了它们，删掉的素材重建时会回来",
          "Records of forget, purge and don't-infer commands: they note which materials were deleted; without them, deleted materials would come back on a rebuild",
        ),
        backup,
      ],
    },
  };
}

export class FakePlugins {
  private readonly states = new Map<string, PluginState>();

  constructor(off: ReadonlySet<string>, removed: ReadonlySet<string>) {
    for (const name of ["reminders", "memory", "calendar", "voice", "browsing", "claude-code", "phone", "google", "looki"]) this.states.set(name, removed.has(name) ? "removed" : off.has(name) ? "disabled" : "running");
  }

  /** 插件频道上的临时事件 plugin_status 的负载 */
  status(): PluginStatusEventPayload {
    return { plugins: [...this.states].map(([name, state]) => ({ name, title: about(name).title, state })) };
  }

  view(): PluginsView {
    return { plugins: [...this.states].map(([name, state]) => ({ ...about(name), state, needs: [], neededBy: [], stopsWith: [], startsWith: [] })) };
  }

  /** 停用、启用、移除（几个插件之间没有必需的依赖：只动它自己；日历要的提醒是可选的）；交回这次变了的和之后的清单 */
  act(name: string, action: PluginAction, purgeData: boolean): PluginActionResult {
    const state = this.states.get(name);
    if (state === undefined) throw new Error(say(`没有叫 ${name} 的插件`, `There's no plugin called ${name}`));
    const next: PluginState = action === "enable" ? "running" : action === "disable" ? (state === "removed" ? "removed" : "disabled") : "removed";
    const changed = next === state ? [] : [name];
    this.states.set(name, next);
    const purged = !(action === "remove" && purgeData)
      ? undefined
      : name === "browsing"
        ? { events: 0, cards: 2, inboxItems: 0, files: 1 }
        : name === "phone"
          ? { events: 9, cards: 0, inboxItems: 0, files: 0 }
        : name === "looki"
          ? { events: 128, cards: 0, inboxItems: 0, files: 1 }
        : { events: name === "reminders" ? 12 : 3, cards: name === "reminders" ? 4 : 1, inboxItems: 2, files: 0 };
    return { changed, ...(purged ? { purged } : {}), plugins: this.view().plugins };
  }
}
