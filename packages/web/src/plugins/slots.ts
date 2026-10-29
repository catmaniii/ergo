// 网页插件的类型化插槽（193 号票，ADR-0027）：网页核心在哪些地方留了口子、插件往里放什么。照 dsh 的 SlotMap（调研 19 §3.7.2）：
// 插槽是编译期的一张表，插件经宿主的 ctx.register(插槽, 条目) 往里放，核心按插槽取（plugins/react.tsx 的钩子），插件之间不互相 import。
// 每个插槽的条目有一个键（页面、设置分节、日历是 id，对话条目、详情是种类，卡片是卡片类型，看板条目是条目种类），同一个键只能一个插件登记；
// 有 order 的按它排。条目里给人看的字写成取值函数（get title() { return t("…"); }），跟着语言变。
// 只有类型，不在运行时引用 React（宿主 host.ts 在 Node 里也能跑）。
// 214 号票（语音插件）加了三种：输入框的语音模式（composerVoice）、整个页面挂一份的后台部件（background）、核心的设置页里由插件画的那几页（settingsPages）。
// 295 号票加了数据源（dataSources）：设置 · 数据源里一个数据源下面由插件画的那一块（填 API Key、地址，测试连接）。
import type { ComponentType, ReactNode } from "react";
import type { MorePage, Navigate, Route } from "../app/route.ts";
import type { RecordedVoice } from "../app/voice-session.ts";
import type { BoardEntry } from "../model/types.ts";
import type { CalendarCell, CalendarDayDetail, ChatItem, ChatItemKind, DataSourcesView, DataSourceView, DetailContent, DetailKind } from "../state/index.ts";
import type { CardProps } from "../ui/cards/CardShell.tsx";
import type { ChatItemActions } from "../ui/conversation/ChatItemView.tsx";
import type { IconName } from "../ui/icons.tsx";

/** 插件页面直接显示在导航里时整页的那一份：宽窄、这一页里点进去的那一项（item）和再下一级（sub） */
export interface PageSectionProps {
  wide: boolean;
  item: string | undefined;
  sub: string | undefined;
  navigate: Navigate;
}

/** 插件页面收进"更多"时右边（竖屏是整页）那一栏：onBack 回"更多"（宽屏没有） */
export interface PageColumnProps {
  item: string | undefined;
  sub: string | undefined;
  navigate: Navigate;
  onBack: (() => void) | undefined;
}

/**
 * 页面和路由：地址 #/more/<id>[/<item>[/<sub>]]，主导航里有一项（按 order 插进核心的几项里，state/nav.ts 的 CORE_NAV_ORDER），
 * 放不下时收进"更多"（"更多"里的入口）。直接显示在导航里时画 Section，收进"更多"时在"更多"右边那一栏画 Column。
 * 213 号票：有自己地址的页面（route，日历的 #/calendar）导航、"更多"里点了去那个地址，那一页整页画 Section，没有 Column
 */
export interface PageSlot {
  readonly id: string;
  readonly order: number;
  /** 没画导航图标的风格的退路（11 套风格按 data-nav="<id>" 各画了自己的） */
  readonly icon: IconName;
  /** 导航上的名字（两个字） */
  readonly navLabel: string;
  /** 页面标题 */
  readonly title: string;
  /** "更多"菜单里的一句说明 */
  readonly sub: string;
  /** 这一页里已经有的核心设置页：这一页在时设置列表里不再列它们（记忆页里有"成批删除"，记忆插件停用时设置里列出"删除素材"） */
  readonly covers?: readonly MorePage[];
  /**
   * 盖住的核心页在这一页里的地址（285 号票：记忆页的"档案"盖住"更多"里的个人档案，#/more/files[/<编号>] 换到 #/more/memory/files[/<编号>]，
   * "更多"里也不再列它）；给 undefined 的照旧去核心的那一页（只是设置里不列，比如成批删除）。item 是核心那一页地址里的下一级
   */
  readonly coverRoute?: (page: MorePage, item: string | undefined) => Route | undefined;
  /**
   * 这一页自己的地址（213 号票：日历是 #/calendar[/YYYY-MM | /YYYY-MM-DD]，35 号票起就在主导航上、不在 #/more 下面，搬进插件地址不变）：
   * 导航、"更多"里点了去这里，收进"更多"时也是整页。地址的拆拼还在核心的路由（app/route-hash.ts），核心按它画这一页的 Section
   * （item 是地址里的那一段）；插件停用时这个地址写"X插件没启用"。不给的是 #/more/<id>
   */
  readonly route?: Route;
  readonly Section: ComponentType<PageSectionProps>;
  /** 收进"更多"时右边那一栏；有自己地址的页面（route）不给，收进"更多"时也去它自己的地址 */
  readonly Column?: ComponentType<PageColumnProps>;
}

/** 设置分节：设置列表里核心的各页之后、"工具调用的完整内容"之前，按 order 排；画一项入口或者一块就地改的设置 */
export interface SettingsSectionSlot {
  readonly id: string;
  readonly order: number;
  readonly Section: ComponentType<{ navigate: Navigate }>;
}

/** 对话里一条怎么画（对话层），按会话条目的种类（state/chat-items.ts 的 ChatItemKind） */
export interface ChatItemSlot {
  readonly kind: ChatItemKind;
  readonly Item: ComponentType<{ item: ChatItem; actions: ChatItemActions }>;
}

/** 详情面板的正文，按条目详情的种类（state/chat-items.ts 的 DetailKind）；挂着的内部工具调用由核心接在后面 */
export interface DetailSlot {
  readonly kind: DetailKind;
  readonly Body: ComponentType<{ content: DetailContent; onOpen?: ((id: string) => void) | undefined }>;
}

/** 一种卡片怎么画（聊天、待办、任务详情里同一张），按卡片类型 */
export interface CardSlot {
  readonly type: string;
  readonly Card: ComponentType<CardProps<never>>;
}

/** 看板上一张条目卡要的：条目、多选（多选时点卡片是勾选）、从它的菜单里点"多选" */
export interface BoardEntryProps {
  entry: BoardEntry;
  selecting: boolean;
  checked: boolean;
  onToggle(): void;
  /** 从这一张开始多选（菜单里的"多选"） */
  onSelect(): void;
}

/**
 * 看板条目：按条目种类画卡片（连同长按 / 右键菜单和菜单项）。Scope 包在整个看板外面一次（菜单点了以后的对话框之类放在这里，
 * 画在看板那一栏的最后）；Entry 是每一张
 */
export interface BoardEntrySlot {
  readonly kind: BoardEntry["kind"];
  readonly Scope?: ComponentType<{ children: ReactNode }>;
  readonly Entry: ComponentType<BoardEntryProps>;
}

/** 日历：图例里的一项、每天格子里的小标、点开一天的一节（都排在核心的定时作业前面），按 order 排 */
export interface CalendarSlot {
  readonly id: string;
  readonly order: number;
  readonly Legend?: ComponentType;
  readonly CellMarks?: ComponentType<{ cell: CalendarCell }>;
  readonly Day?: ComponentType<{ day: CalendarDayDetail; navigate: Navigate }>;
}

/** 页签在主框架里挂的那一个要的（212 号票） */
export interface TabMountProps {
  /** 在这一页签上时秘书会话算不算在看（"浏览"右边的侧边栏开着：秘书新消息的提醒不再弹）；插件停用、卸下时核心当作不算 */
  watching(on: boolean): void;
}

/**
 * 主导航里由插件给的页签（212 号票："浏览"）：地址（#/browse）、在导航里排在哪（state/nav.ts 的 CORE_NAV_ORDER）、什么时候有（只在鸿蒙 App 里，
 * 有原生的内置浏览器时）照旧由核心定，插件给整页（Page）、侧边栏模式（?ergo=side，App 另开的 Web 组件）的整页（Side）、主框架里挂一次的
 * （Mount：接 store 的钩子，不画东西）。键是核心导航项的名字。插件停用了导航里没有这一项，地址还在的写"X插件没启用，这一页暂时看不到"，
 * 侧边栏模式整页写同一句
 */
export interface TabSlot {
  readonly id: string;
  readonly Page: ComponentType<{ wide: boolean }>;
  readonly Side?: ComponentType;
  readonly Mount?: ComponentType<TabMountProps>;
}

/**
 * 输入框的语音模式（214 号票）：有在用的就在输入框右边放"文字 / 语音"切换（话筒 / 键盘），语音模式下整个输入框换成 Input（"按住 说话"），
 * 录好的整段交给 onRecorded（输入框上传后连同引用的卡片、等着的附件发出去）。没有（语音插件停用了）时没有切换、一律打字，
 * 浏览器里记着的"语音模式"留着，启用回来照旧
 */
export interface ComposerVoiceSlot {
  readonly id: string;
  readonly Input: ComponentType<{ onRecorded(voice: RecordedVoice): void }>;
}

/** 整个页面挂一份、不画东西的后台部件（214 号票：agent 语音的自动播放）：挂在组合根（App.tsx），可以用状态层的钩子 */
export interface BackgroundSlot {
  readonly id: string;
  readonly Run: ComponentType;
}

/**
 * 核心的设置页里由插件画的那一页（214 号票：设置 · 语音）：地址（#/more/<页>）、名字、在设置列表里的位置留在核心（MorePage 的一种），
 * 页面内容由插件画；插件停用时设置列表里没有这一项，地址写"X插件没启用"（插件在 owns 里写明拥有它）
 */
export interface SettingsPageSlot {
  readonly id: MorePage;
  readonly Page: ComponentType<{ navigate: Navigate }>;
}

/**
 * 数据源的设置（295 号票）：设置 · 数据源（核心的页面，pages/more/DataSourcesPage.tsx）里一个数据源下面插件画的那一块——
 * 填 API Key、私密地址、选区域，测试连接。键是数据源的 id（守护进程那一半在数据契约里登记的）。填的值经
 * POST /api/data-sources/<id>（action configure）交给数据源，存进守护进程的密钥区；交回的整页交给 onView 换上。
 * 插件停用时这一块不画（那一行写"X插件没启用"）
 */
export interface DataSourceSlot {
  readonly id: string;
  readonly Panel: ComponentType<{ source: DataSourceView; onView(view: DataSourcesView): void }>;
}

/** 全部插槽 */
export interface SlotMap {
  pages: PageSlot;
  tabs: TabSlot;
  settingsSections: SettingsSectionSlot;
  settingsPages: SettingsPageSlot;
  composerVoice: ComposerVoiceSlot;
  background: BackgroundSlot;
  chatItems: ChatItemSlot;
  details: DetailSlot;
  cards: CardSlot;
  boardEntries: BoardEntrySlot;
  calendar: CalendarSlot;
  dataSources: DataSourceSlot;
}

export type SlotName = keyof SlotMap;

/** 每个插槽的条目按什么当键 */
export const SLOT_KEYS: { readonly [K in SlotName]: (entry: SlotMap[K]) => string } = {
  pages: (e) => e.id,
  tabs: (e) => e.id,
  settingsSections: (e) => e.id,
  settingsPages: (e) => e.id,
  composerVoice: (e) => e.id,
  background: (e) => e.id,
  chatItems: (e) => e.kind,
  details: (e) => e.kind,
  cards: (e) => e.type,
  boardEntries: (e) => e.kind,
  calendar: (e) => e.id,
  dataSources: (e) => e.id,
};

export const SLOT_NAMES = Object.keys(SLOT_KEYS) as SlotName[];
