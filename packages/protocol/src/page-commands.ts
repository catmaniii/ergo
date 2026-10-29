// 网页上下指令（134 号票第二部分，用户 2026-10-18：鸿蒙 App 的"浏览"里，网页的文本框、上传处被选中时旁边出现二狗的悬浮按钮，
// 点一下打字、长按说话，让二狗填这个框或替它选好文件）在协议里的那一半：
// - 页面桥（注入到"浏览"里的网页，packages/web/src/page-bridge/）报的框（PageField）：编号、种类、标签文字这些；密码、银行卡、
//   验证码类的框页面桥根本不列。149 号票（用户 2026-10-18："我在网页选中文本框的时候，二狗读不到文本框的内容"）起选中的框、
//   悬浮按钮所在的框带上框里现在的内容（PageField.value，截到 PAGE_FIELD_VALUE_MAX 字），框的列表照旧不带；
// - 149 号票起悬浮按钮背后就是秘书本人（用户 2026-10-18："干脆悬浮按钮的二狗和秘书的二狗是一个实体好了"）：按钮上打的字、说的话
//   作为一条消息发进秘书的主会话，带上网页上下文（browsing.ts 的 BrowsingContext，via: "button"），和浏览侧边栏发的同一种；
//   134 号票原来的一次性页面助手（POST /api/page-command）、145 号票的候选面板（POST /api/page-command/pick）不再有。
//   按住说的一段先送识别（POST /api/page-command/voice，PageVoiceBody → PageVoiceResult），认出来的字再发；
// - 要交的文件凭一次性的取件码下载（GET /api/page-files/<取件码>，PageCommandFile）；
// - 授权的文件夹（138 号票起叫这个名字；GET / PUT / PATCH /api/local-folders，列子文件夹 GET /api/local-folders/browse）：
//   守护进程那台电脑上的一份文件夹，秘书找文件时除了素材还搜这几个文件夹；设置 · 浏览与填框里能看能改，
//   在秘书的聊天里授权（快速动作 authorize_folders）的也是这一份。
// 秘书的操作只作用于一个框（悬浮按钮属于哪个框就是哪个框，侧边栏里是选中的那个）；一句话要填好几个框的以后再说。
import { type Static, Type } from "typebox";

/** 框的种类：单行文本、多行文本、可编辑区域（contenteditable）、选文件的框（含藏在网站自己画的"上传"按钮、拖放区后面的） */
export const PAGE_FIELD_KINDS = ["text", "textarea", "editable", "file"] as const;
export type PageFieldKind = (typeof PAGE_FIELD_KINDS)[number];

/** 框的编号的写法：页面桥按出现先后给 f1、f2…… */
export const PAGE_FIELD_ID = "^f[0-9]{1,6}$";

/** 一页最多列多少个框（多的不列） */
export const PAGE_FIELDS_MAX = 60;

/** 框里现在的内容最多带多少字（多的截掉，total 写一共多少字）：和秘书填字的上限一样 */
export const PAGE_FIELD_VALUE_MAX = 5000;

/** 框里现在的内容（149 号票）：文字（最多 PAGE_FIELD_VALUE_MAX 字）、一共多少字（比文字长就是截了） */
export const PageFieldValue = Type.Object({
  text: Type.String({ maxLength: PAGE_FIELD_VALUE_MAX }),
  total: Type.Integer({ minimum: 0 }),
});
export type PageFieldValue = Static<typeof PageFieldValue>;

/** 页面上一个能填的框：交给模型的就这些；框里现在的内容只在选中的框、悬浮按钮所在的框上带（value，149 号票），框的列表不带 */
export const PageField = Type.Object({
  id: Type.String({ pattern: PAGE_FIELD_ID }),
  kind: Type.Enum(PAGE_FIELD_KINDS),
  /** 标签文字：label、aria-label、title……取得到的第一个，截到 80 字；取不到是空串 */
  label: Type.String({ maxLength: 80 }),
  placeholder: Type.Optional(Type.String({ maxLength: 80 })),
  /** input 的 type（text、email、search、url、tel、number……） */
  inputType: Type.Optional(Type.String({ maxLength: 20 })),
  /** 选文件的框：accept（image/*、.pdf……） */
  accept: Type.Optional(Type.String({ maxLength: 200 })),
  /** 选文件的框：能不能选好几个 */
  multiple: Type.Optional(Type.Boolean()),
  /** 框里现在的内容（149 号票，文本框才有；网页上的东西，交给模型时标成外部数据） */
  value: Type.Optional(PageFieldValue),
});
export type PageField = Static<typeof PageField>;

/** 框里现在的内容收拾成 PageFieldValue（截到 PAGE_FIELD_VALUE_MAX 字） */
export function pageFieldValueOf(text: string): PageFieldValue {
  return { text: text.slice(0, PAGE_FIELD_VALUE_MAX), total: text.length };
}

/** 网页弹出的选文件对话框（App 拦下来了，134 号票的兜底那条路）：要什么类型、能不能选好几个 */
export const PageChooser = Type.Object({
  accept: Type.Array(Type.String({ maxLength: 100 }), { maxItems: 20 }),
  multiple: Type.Boolean(),
});
export type PageChooser = Static<typeof PageChooser>;

/** 录的一段语音最多多少字节（16 kHz 单声道 WAV 一分钟约 1.9 MB，和语音消息一样最长 60 秒） */
export const PAGE_COMMAND_AUDIO_MAX_BYTES = 3 * 1024 * 1024;
/** 悬浮按钮上打的字最多多少字 */
export const PAGE_COMMAND_TEXT_MAX = 2000;

/** POST /api/page-command/voice（149 号票）：悬浮按钮上按住说的一段（App 录的 WAV 或浏览器录的音频的 base64）送识别 */
export const PageVoiceBody = Type.Object({
  audio: Type.Object({
    base64: Type.String({ minLength: 1, maxLength: Math.ceil((PAGE_COMMAND_AUDIO_MAX_BYTES * 4) / 3) + 4 }),
    mime: Type.String({ minLength: 1, maxLength: 100 }),
  }),
});
export type PageVoiceBody = Static<typeof PageVoiceBody>;

/** 识别的结果：认出来的字；没认出、没听清是 ok: false 和原因 */
export const PageVoiceResult = Type.Union([Type.Object({ ok: Type.Literal(true), text: Type.String() }), Type.Object({ ok: Type.Literal(false), reason: Type.String() })]);
export type PageVoiceResult = Static<typeof PageVoiceResult>;

/** 拦下的选文件对话框当目标时，页面桥认不出是哪个框，框的编号写它（149 号票：秘书交文件、候选卡交进去时交给那个对话框） */
export const PAGE_CHOOSER_TARGET = "chooser";

/** 要交进上传框的一个文件：凭取件码下载（GET /api/page-files/<取件码>，几分钟内有效），名字、类型、大小、是不是图片（画缩略图） */
export const PageCommandFile = Type.Object({
  token: Type.String(),
  name: Type.String(),
  mime: Type.String(),
  size: Type.Integer({ minimum: 0 }),
  image: Type.Boolean(),
});
export type PageCommandFile = Static<typeof PageCommandFile>;

/** 候选最多几个（145 号票） */
export const PAGE_CANDIDATES_MAX = 12;

/** 候选的缩略图（149 号票，GET /api/page-files/<取件码>/thumb）长边多少像素：挑图片窗口里一格 80–96 CSS 像素，手机上三倍才清楚 */
export const PAGE_THUMB_EDGE = 320;

/** 交给上传框的文件最多几个；多于 PAGE_FILES_ASK_OVER 个的先让用户看一眼（149 号票起秘书给候选卡） */
export const PAGE_FILES_MAX = 30;
export const PAGE_FILES_ASK_OVER = 9;
/** 一个文件最大多少字节（App 先把它下载到自己的目录，再交给网页） */
export const PAGE_FILE_MAX_BYTES = 50 * 1024 * 1024;
/** 一次交的文件加起来最大多少字节 */
export const PAGE_FILES_TOTAL_MAX_BYTES = 200 * 1024 * 1024;

/** 授权的文件夹最多几个 */
export const LOCAL_FOLDERS_MAX = 20;

/** 授权的一个文件夹（守护进程那台电脑上的绝对路径）、现在在不在 */
export const LocalFolder = Type.Object({ path: Type.String(), exists: Type.Boolean() });
export type LocalFolder = Static<typeof LocalFolder>;

/** GET /api/local-folders 的响应 */
export const LocalFoldersView = Type.Object({ folders: Type.Array(LocalFolder) });
export type LocalFoldersView = Static<typeof LocalFoldersView>;

/** PUT /api/local-folders：整份换掉（绝对路径，得是文件夹） */
export const LocalFoldersBody = Type.Object({
  folders: Type.Array(Type.String({ minLength: 1, maxLength: 1000 }), { maxItems: LOCAL_FOLDERS_MAX }),
});
export type LocalFoldersBody = Static<typeof LocalFoldersBody>;

/**
 * PATCH /api/local-folders（138 号票，设置页的"添加文件夹"和每行的叉）：加几个、拿掉几个，响应是改完的 LocalFoldersView。
 * 加的要是存在的文件夹（绝对路径），加上以后最多 LOCAL_FOLDERS_MAX 个；已经有的、要拿掉却不在里面的不算错；
 * 列表里找不到了的文件夹照样留着（设置页标"找不到了"）
 */
export const LocalFoldersChangeBody = Type.Object({
  add: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 1000 }), { maxItems: LOCAL_FOLDERS_MAX })),
  remove: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 1000 }), { maxItems: 100 })),
});
export type LocalFoldersChangeBody = Static<typeof LocalFoldersChangeBody>;

/** 秘书在聊天里授权、取消授权文件夹的快速动作类型（138 号票；快速动作卡、工具调用的一句话按它认） */
export const AUTHORIZE_FOLDERS_ACTION = "authorize_folders";

/** 列子文件夹一次最多列几个（多的截断，响应里写着一共几个） */
export const FOLDER_BROWSE_MAX = 500;

/** 选文件夹的框里的一项：名字、完整路径 */
export const FolderEntry = Type.Object({ name: Type.String(), path: Type.String() });
export type FolderEntry = Static<typeof FolderEntry>;

/**
 * GET /api/local-folders/browse[?path=…]（138 号票，设置页"添加文件夹"的框）：列守护进程那台电脑上的文件夹，只列文件夹、不列文件，
 * 隐藏的、系统的不列（规则和 find_files 走文件夹时一样）。
 * - 不给路径（roots）：常用位置（图片、下载、桌面、文档、用户目录，存在的才列）和各个盘（Windows 上 C:、D:……，别的系统是 /）；
 * - 给了路径（folder）：它的子文件夹（按名字排，最多 FOLDER_BROWSE_MAX 个，total 是一共几个）和上一级（盘的根没有）；
 * - 读不了的（unreadable）：原因，和上一级（能退回去）
 */
export const FolderBrowseView = Type.Union([
  Type.Object({ kind: Type.Literal("roots"), places: Type.Array(FolderEntry), drives: Type.Array(FolderEntry) }),
  Type.Object({
    kind: Type.Literal("folder"),
    path: Type.String(),
    parent: Type.Optional(Type.String()),
    folders: Type.Array(FolderEntry),
    total: Type.Integer({ minimum: 0 }),
  }),
  Type.Object({ kind: Type.Literal("unreadable"), path: Type.String(), parent: Type.Optional(Type.String()), reason: Type.String() }),
]);
export type FolderBrowseView = Static<typeof FolderBrowseView>;

/**
 * 秘书会话里记下的一次网页指令（MessageEnvelope.pageCommand，134–148 号票）：在哪个网页、哪个框上说的，是不是说的（语音认出来的字）。
 * 这条用户消息由一次性的页面助手处理过了，不再交给秘书（不进秘书的输入队列）。149 号票起悬浮按钮发的是带 browsing 的普通消息，
 * 这个只留给以前的记录
 */
export const PageCommandMark = Type.Object({
  title: Type.String(),
  url: Type.String(),
  field: Type.String(),
  spoken: Type.Optional(Type.Boolean()),
});
export type PageCommandMark = Static<typeof PageCommandMark>;

/** 地址去掉查询串和 # 后面的（交给模型的只有这些） */
export function pageUrlForModel(url: string): string {
  const cut = url.search(/[?#]/);
  return cut < 0 ? url : url.slice(0, cut);
}
