// 规则版事实抽取的词表：常见的活动、地点、人、身体和精神状态，以及互相排斥的几组说法。
// 中文为主；只求覆盖合成数据里常见的说法，不求全（抽不出来就不抽）。⑤ 号票或以后的数据要更多词时往这里加，
// 也可以给 RuleFactExtractor 传自己的词表。
// 190 号票照正式数据（fixtures/events.json 的正文，没看隐藏答案）补了一批词，条目后面标着"190"。
// 199 号票补了几样常见的说法（一个字的猫、打电话、坐高铁、找工作），标着"199"；事件的活动类型在 kg/relations.ts。
import type { EntityType } from "../domain/types.ts";

export interface LexiconEntry {
  /** 规范名：实体用它当名字 */
  name: string;
  type: EntityType;
  /** 别名：句子里出现这些也算这个实体，并登记成实体的别名 */
  aliases?: string[];
  /** 互相排斥的一组（同组的两样不会同时"更喜欢"，比如远程办公和坐班） */
  group?: string;
}

export interface Lexicon {
  entries: readonly LexiconEntry[];
  /** 泛指的人（"约朋友吃饭"里的朋友）：宾语开头是这些时去掉，剩下的才是活动 */
  persons: readonly string[];
  /** 城市等地名，以及地点常见的结尾（参加了 X、去了 X 里 X 是地点时记成 occurred_at） */
  places: readonly string[];
  placeSuffixes: readonly string[];
  /** 说自己的状态：规范名 → 说法 */
  states: Readonly<Record<string, readonly string[]>>;
}

export const DEFAULT_LEXICON: Lexicon = {
  entries: [
    // 社交
    { name: "聚会", type: "activity", aliases: ["派对", "party", "聚一聚", "聚聚"] },
    { name: "聚餐", type: "activity", aliases: ["饭局", "聚个餐", "吃饭局"] },
    { name: "生日会", type: "activity", aliases: ["生日派对", "生日聚会"] },
    { name: "见朋友", type: "activity", aliases: ["和朋友见面", "跟朋友见面", "见见朋友", "朋友见面"] },
    { name: "社交", type: "activity", aliases: ["社交活动", "应酬"] },
    { name: "团建", type: "activity", aliases: ["团队建设"] },
    { name: "年会", type: "activity" },
    { name: "吃饭", type: "activity", aliases: ["吃个饭", "吃顿饭"] },
    { name: "唱K", type: "activity", aliases: ["KTV", "唱歌"] },
    { name: "剧本杀", type: "activity" },
    { name: "桌游", type: "activity" },
    // 工作和学习
    { name: "技术交流", type: "activity", aliases: ["技术交流会", "技术分享会", "技术分享", "技术沙龙", "meetup", "技术讲座"] },
    { name: "分享会", type: "activity" },
    { name: "讲座", type: "activity" },
    { name: "读书会", type: "activity" },
    { name: "加班", type: "activity" },
    { name: "出差", type: "activity" },
    { name: "开会", type: "activity", aliases: ["会议"] },
    { name: "升职", type: "topic", aliases: ["晋升", "升迁"] },
    { name: "转岗", type: "topic", aliases: ["换岗位", "转去做产品"] },
    { name: "远程办公", type: "topic", aliases: ["在家办公", "居家办公", "远程工作"], group: "办公方式" },
    { name: "混合办公", type: "topic", aliases: ["混合办公模式"], group: "办公方式" },
    { name: "坐班", type: "topic", aliases: ["去公司上班", "到岗办公", "天天去公司", "回工位"], group: "办公方式" }, // 190：回工位
    { name: "站会", type: "activity", aliases: ["视频站会"] }, // 190
    { name: "小组长", type: "topic" }, // 190
    { name: "调薪", type: "topic", aliases: ["涨薪", "加薪"] }, // 190
    { name: "夜校", type: "activity" }, // 190
    { name: "通勤月卡", type: "topic", aliases: ["地铁通勤月卡", "地铁月卡", "月卡"] }, // 190
    // 运动和户外
    { name: "爬山", type: "activity", aliases: ["登山"] },
    { name: "徒步", type: "activity", aliases: ["远足", "hiking"] },
    { name: "跑步", type: "activity", aliases: ["夜跑", "晨跑", "跑步锻炼"] },
    { name: "健身", type: "activity", aliases: ["撸铁", "健身房"] },
    { name: "游泳", type: "activity" },
    { name: "骑行", type: "activity", aliases: ["骑车"] },
    { name: "露营", type: "activity" },
    { name: "羽毛球", type: "activity" },
    { name: "篮球", type: "activity" },
    { name: "郊游", type: "activity", aliases: ["春游", "秋游"] },
    // 休闲
    { name: "休息", type: "topic", aliases: ["歇一歇", "歇歇", "放松", "补觉", "躺平"] },
    { name: "宅家", type: "topic", aliases: ["待在家", "宅在家", "在家待着"] },
    { name: "看电影", type: "activity", aliases: ["电影"] },
    { name: "演唱会", type: "activity" },
    { name: "音乐节", type: "activity" },
    { name: "看展", type: "activity", aliases: ["展览", "展会"] },
    { name: "逛街", type: "activity", aliases: ["购物"] },
    { name: "旅行", type: "activity", aliases: ["旅游", "出去玩"] },
    { name: "度假", type: "activity" },
    { name: "吃辣", type: "topic", aliases: ["吃辣的", "辣的"] },
    { name: "香菜", type: "topic" }, // 190
    { name: "烧烤", type: "activity", aliases: ["撸串"] }, // 190
    { name: "围棋", type: "activity" }, // 190
    { name: "夜市", type: "place" }, // 190
    { name: "大理", type: "place" }, // 190
    { name: "咖啡馆", type: "place", aliases: ["咖啡店"] },
    { name: "民宿", type: "place" },
    { name: "市中心", type: "place" },
    { name: "被提前排满", type: "topic", aliases: ["提前排满", "排满", "排得满满的"] },
    { name: "被安排", type: "topic", aliases: ["被临时安排", "被别人安排", "被人安排"] }, // 192
    // 199：一个字的说法认不出来（宾语至少两个字），常见的放进词表（"狗"不放：会把"二狗"认成狗）；打电话、坐高铁、找工作是常见的说法
    { name: "猫", type: "topic", aliases: ["猫咪", "小猫"] }, // 199
    { name: "打电话", type: "activity", aliases: ["电话会", "打来电话", "打个电话", "通电话"] }, // 199
    { name: "高铁", type: "activity", aliases: ["动车"] }, // 199
    { name: "找工作", type: "topic", aliases: ["投简历", "换工作", "跳槽", "看机会"] }, // 199
  ],
  persons: ["几个朋友", "老同学", "朋友们", "朋友", "同事们", "同事", "家人", "爸妈", "父母", "大家", "他们", "她们"],
  places: ["北京", "上海", "杭州", "深圳", "广州", "成都", "南京", "苏州", "西安", "重庆", "武汉", "厦门", "青岛", "大理", "三亚", "丽江", "东京", "大阪", "首尔"],
  placeSuffixes: ["市", "省", "公园", "酒店", "民宿", "咖啡馆", "餐厅", "商场", "博物馆"],
  states: {
    忙: ["忙", "没空", "没时间", "事情多", "赶工", "加班"], // 190：加班
    累: ["累", "疲惫", "疲倦", "没精力", "精力不够", "没精神"],
    焦虑: ["焦虑", "压力大", "压力很大", "压力太大"],
    不舒服: ["身体不舒服", "生病", "不太舒服"],
  },
};

/** 规范名和别名 → 词条（按名字长的在前，句子里找宾语时长的先配） */
export function lexiconIndex(lexicon: Lexicon): { term: string; entry: LexiconEntry }[] {
  const terms: { term: string; entry: LexiconEntry }[] = [];
  for (const entry of lexicon.entries) for (const term of [entry.name, ...(entry.aliases ?? [])]) terms.push({ term, entry });
  return terms.toSorted((a, b) => b.term.length - a.term.length);
}
