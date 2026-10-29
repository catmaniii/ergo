import { describe, expect, it } from "vitest";
import type { Evidence } from "../../src/domain/types.ts";
import { clauseContext } from "../../src/kg/context.ts";
import { isRecount, RuleFactExtractor, type FactDraft, type KgView } from "../../src/kg/extractor.ts";

const T = "2026-10-12T22:00:00+08:00";
const EMPTY: KgView = { findEntity: () => undefined, knownNames: () => [] };
const extractor = new RuleFactExtractor();

function ev(text: string, over: Partial<Evidence> = {}): Evidence {
  return { id: "ev-1", sourceLevel: "self", mode: "say", kind: "utterance", text, context: [], eventTime: T, observedAt: T, sourceRef: null, contentHash: "h", status: "active", ...over };
}

/** 方便比较：谓词、宾语名、否定 */
function brief(d: FactDraft): string {
  const obj = d.object.type === "value" ? d.object.value : "name" in d.object.ref ? d.object.ref.name : d.object.ref.id;
  return `${d.negated ? "¬" : ""}${d.predicate}(${obj})`;
}

const run = (text: string, over: Partial<Evidence> = {}, known: KgView = EMPTY) => extractor.extract(ev(text, over), known);
const briefs = (text: string, over: Partial<Evidence> = {}) => run(text, over).map(brief);

describe("规则版事实抽取：周末社交案例（任务书第 11 节）", () => {
  it("1. 拒绝周六聚会，说最近周末想好好休息", () => {
    const drafts = run("这周六的聚会我就不去了，最近周末想好好休息。", { context: ["weekend", "social"] });
    expect(drafts.map(brief)).toEqual(["declined(聚会)", "prefers(休息)"]);
    expect(drafts[0]!.context.toSorted()).toEqual(["social", "weekend"]);
    expect(drafts[1]!.signals.change).toContain("最近");
    expect(drafts[0]!.object).toEqual({ type: "entity", ref: { name: "聚会", type: "activity" } });
  });

  it("2. 主动报名参加工作日的技术交流会（技术交流会对到词表的技术交流）", () => {
    const drafts = run("主动报名参加了周三晚上的技术交流会。", { mode: "do", kind: "action", context: ["workday", "work", "social"] });
    expect(drafts.map(brief)).toEqual(["participated_in(技术交流)"]);
    expect(drafts[0]!.context).toContain("workday");
  });

  it("3. 再次推掉安排紧凑的周末活动", () => {
    expect(briefs("推掉了朋友安排得很紧凑的周末活动。", { mode: "do", kind: "action", context: ["weekend", "social"] })).toEqual(["declined(活动)"]);
  });

  it("4. 不反感见朋友，只是不喜欢周末被提前排满", () => {
    const drafts = run("我不反感见朋友，只是不喜欢周末被提前排满。", { context: ["weekend", "social"] });
    expect(drafts.map(brief)).toEqual(["¬dislikes(见朋友)", "dislikes(被提前排满)"]);
    expect(drafts.every((d) => d.signals.correction.length === 0)).toBe(true);
  });
});

describe("规则版事实抽取：常见说法", () => {
  it("喜欢 / 不喜欢 / 不想 / 想", () => {
    expect(briefs("我喜欢爬山")).toEqual(["prefers(爬山)"]);
    expect(briefs("我不太喜欢热闹的咖啡馆")).toEqual(["dislikes(咖啡馆)"]);
    expect(briefs("今年不想升职了")).toEqual(["¬prefers(升职)"]);
    expect(briefs("我想去杭州玩")).toEqual(["prefers(杭州玩)"]);
    expect(briefs("我对剧本杀不感兴趣")).toEqual(["¬prefers(剧本杀)"]);
    expect(briefs("爬山我很喜欢")).toEqual(["prefers(爬山)"]);
  });

  it("一句里两种场景各算各的", () => {
    const drafts = run("我喜欢热闹的音乐节，但不喜欢热闹的咖啡馆");
    expect(drafts.map(brief)).toEqual(["prefers(音乐节)", "dislikes(咖啡馆)"]);
    const split = run("工作日我愿意参加技术交流，周末不想参加", { context: ["social"] });
    expect(split.map(brief)).toEqual(["prefers(技术交流)", "declined(技术交流)"]);
    expect(split[0]!.context).toEqual(["social", "workday"]);
    expect(split[1]!.context).toEqual(["social", "weekend"]);
  });

  it("宾语在前一个分句：朋友约我去爬山，我没去", () => {
    expect(briefs("朋友约我周六去爬山，我没去。")).toEqual(["declined(爬山)"]);
  });

  it("主动约、去了某地、在做、说自己忙累", () => {
    expect(briefs("周末主动约朋友吃饭")).toEqual(["initiated(吃饭)"]);
    expect(briefs("上周去了杭州")).toEqual(["occurred_at(杭州)"]);
    expect(briefs("最近在忙一个新项目")).toEqual(["works_on(新项目)"]);
    expect(briefs("这两周太累了")).toEqual(["said_about(累)"]);
    expect(briefs("最近很忙，没空")).toEqual(["said_about(忙)"]);
    expect(briefs("今天不累")).toEqual(["¬said_about(累)"]);
  });

  it("「不是 X，是 Y」：X 取反、带纠正信号", () => {
    const drafts = run("不是不喜欢聚会，是不喜欢周末被排满");
    expect(drafts.map(brief)).toEqual(["¬dislikes(聚会)", "dislikes(被提前排满)"]);
    expect(drafts[0]!.signals.correction.length).toBeGreaterThan(0);
  });

  it("纠正：信号在前一个分句也算；「一直」= 不知道从什么时候起", () => {
    const drafts = run("记错了，我其实一直不喜欢爬山，喜欢的是徒步", { kind: "correction" });
    expect(drafts.map(brief)).toEqual(["dislikes(爬山)", "prefers(徒步)"]);
    expect(drafts[0]!.signals.correction).toEqual(expect.arrayContaining(["kind:correction", "其实一直", "记错"]));
    expect(drafts[0]!.validFrom).toBeNull();
  });

  it("有效期：上个月开始、去年、以前", () => {
    const [since] = run("我上个月开始不喜欢这个项目了");
    expect(brief(since!)).toBe("dislikes(项目)");
    expect(since!.validFrom).toBe("2026-09-01T00:00:00+08:00");
    expect(since!.validTo).toBeNull();
    const [lastYear] = run("去年喜欢远程办公");
    expect(lastYear).toMatchObject({ validFrom: "2025-01-01T00:00:00+08:00", validTo: "2026-01-01T00:00:00+08:00" });
    const [before, now] = run("我以前喜欢爬山，现在不喜欢了");
    expect([brief(before!), brief(now!)]).toEqual(["prefers(爬山)", "dislikes(爬山)"]);
    expect(before).toMatchObject({ validFrom: null, validTo: T });
    expect(now!.validFrom).toBeUndefined();
    expect(now!.signals.change).toContain("现在");
  });

  it("事情类的不挪有效期（用发生时间）", () => {
    const [d] = run("这周六的聚会我就不去了");
    expect(d!.validFrom).toBeUndefined();
  });

  it("别人做主语的分句不抽；别人转述的去掉开头照样抽", () => {
    expect(briefs("他不想去聚会")).toEqual([]);
    expect(briefs("同事说他其实很讨厌社交", { sourceLevel: "untrusted" })).toEqual(["dislikes(社交)"]);
  });

  it("抽不出来就不抽", () => {
    expect(briefs("今天天气不错")).toEqual([]);
    expect(briefs("我想了想")).toEqual([]);
    expect(briefs("嗯")).toEqual([]);
    expect(run("我喜欢爬山", { status: "forgotten", text: "" })).toEqual([]);
  });

  it("已知实体的名字也认", () => {
    const known: KgView = { findEntity: () => undefined, knownNames: () => ["二狗项目"] };
    expect(run("最近不想管二狗项目了", {}, known).map(brief)).toEqual(["¬prefers(二狗项目)"]);
  });

  it("同一条证据里重复的只留一条", () => {
    expect(briefs("我喜欢爬山，真的喜欢爬山")).toEqual(["prefers(爬山)"]);
  });
});

// 194 号票：规则版抽取的三个毛病。例句是自己写的（照着 events.json 正文里的说法），没看答案。
describe("194：星期词看前后字", () => {
  it("「那周一点都不忙」「这周一般」「两周一次」「这周天天加班」里没有星期几", () => {
    expect(clauseContext(["weekend", "work"], "其实那周一点都不忙")).toEqual(["weekend", "work"]);
    expect(clauseContext(["weekend"], "这周一般都在家")).toEqual(["weekend"]);
    expect(clauseContext(["weekend"], "这礼拜一直在出差")).toEqual(["weekend"]);
    expect(clauseContext(["weekend"], "这星期一点空都没有")).toEqual(["weekend"]);
    expect(clauseContext(["workday"], "读书会两周一次")).toEqual(["workday"]);
    expect(clauseContext(["workday"], "一周五天都在公司")).toEqual(["workday"]);
    expect(clauseContext(["workday"], "这周天天加班到十一点")).toEqual(["workday"]);
  });

  it("真说星期几的照样认：周一开会、每周二、下礼拜三、这周日、周五天气好", () => {
    expect(clauseContext([], "周一开会")).toContain("workday");
    expect(clauseContext(["weekend"], "每周二、周四去公司")).toEqual(["workday"]);
    expect(clauseContext([], "下礼拜三上午复查")).toContain("workday");
    expect(clauseContext(["workday"], "这周日去爬山")).toEqual(["weekend"]);
    expect(clauseContext(["workday"], "周日天气好就去爬山")).toEqual(["weekend"]);
    expect(clauseContext(["weekend"], "周一一早就要开会")).toEqual(["workday"]);
  });

  it("抽出来的事实场景不再被「周一点」带成工作日", () => {
    const drafts = run("其实那周一点都不忙。", { context: ["weekend", "work", "social"] });
    expect(drafts.map(brief)).toEqual(["¬said_about(忙)"]);
    expect(drafts[0]!.context.toSorted()).toEqual(["social", "weekend", "work"]);
  });
});

describe("194：复述以前说过的话不当成新说法", () => {
  it("认得出复述：上回说、上次跟你说、之前说过、以前说、跟你说过", () => {
    const yes = ["上回说团建那周要加班", "我上次跟你说周六要加班", "之前说过不吃香菜", "以前说放不放都行", "我跟你说过我不吃辣", "刚才讲到周末要加班"];
    expect(yes.filter((c) => !isRecount(c))).toEqual([]);
  });

  it("不是复述：上次说的那家店、没跟人说过话、我说先不了、以后我说、跟你说个事", () => {
    const no = ["上次说的那家店我去了", "就没跟人说过话", "我说先不了", "以后我说找地方看书", "跟你说个事", "以后约之前先跟我说一声"];
    expect(no.filter((c) => isRecount(c))).toEqual([]);
  });

  it("复述的分句跳过，不抽成新的「说自己忙」；它说的那件事留给后面的「不想去」当宾语", () => {
    const drafts = run("跟你更正一下：上次说周六的聚餐要加班去不了，其实那周一点也不忙，就是不想去。", { context: ["weekend", "social"] });
    expect(drafts.map(brief)).toEqual(["¬said_about(忙)", "declined(聚餐)"]);
    expect(drafts.every((d) => !d.span.includes("上次说"))).toBe(true);
    expect(drafts.every((d) => d.signals.correction.includes("更正"))).toBe(true);
  });

  it("复述带出来的旧说法也不抽：之前说过我不吃香菜", () => {
    expect(briefs("我之前说过我不吃香菜")).toEqual([]);
    expect(briefs("以前说放不放都行是不想麻烦大家")).toEqual([]);
  });

  it("说自己的状态（忙、累）不留给后面的分句当宾语：不再有「拒绝了忙」", () => {
    expect(briefs("最近很忙，不想去")).toEqual(["said_about(忙)"]);
    expect(briefs("周六的徒步我不去了，这周天天加班，周末只想睡觉")).toEqual(["declined(徒步)", "said_about(忙)", "prefers(睡觉)"]);
  });
});

describe("194：引号、冒号也分句", () => {
  it("回群消息：不再抽出「回：这个」这样的宾语，宾语沿用前面说的那件事", () => {
    const text = "阿杰在群里发了周六爬山的安排。我回：“这个我就不参加了，你们玩开心。”";
    const drafts = run(text, { context: ["weekend", "social"] });
    expect(drafts.map(brief)).toEqual(["declined(爬山)"]);
    expect(drafts[0]!.span).toBe("这个我就不参加了");
  });

  it("前面用顿号列了一串安排时，说不准不去的是哪一样，不沿用、不抽", () => {
    expect(briefs("老同学发了周末两日游的行程：上午爬山、下午唱歌、晚上烧烤。我回：“这次我就不去了，你们玩好。”", { context: ["weekend", "social"] })).toEqual([]);
  });

  it("回邮件：不再抽出「回邮件：以后」「以后」这样的宾语", () => {
    expect(briefs("领导往我日历里塞了三个会。我回邮件：“以后约之前先跟我说一声。”")).toEqual([]);
    expect(briefs("在群里回：“这次我就不去了，你们玩好。”")).toEqual([]);
  });

  it("冒号后面另起一句：跟你说个事：我其实不喜欢剧本杀", () => {
    const drafts = run("跟你说个事：我其实不喜欢剧本杀");
    expect(drafts.map(brief)).toEqual(["dislikes(剧本杀)"]);
    expect(drafts[0]!.span).toBe("我其实不喜欢剧本杀");
  });

  it("只引一个词的引号不分句（引号照旧去掉）", () => {
    expect(briefs("我挺喜欢“剧本杀”的")).toEqual(["prefers(剧本杀)"]);
    expect(briefs("我不太喜欢「网红」咖啡馆")).toEqual(["dislikes(咖啡馆)"]);
  });

  it("没配对的引号也当分句的边界，不留在分句里", () => {
    const drafts = run("我回：“这周六的聚会我就不去了");
    expect(drafts.map(brief)).toEqual(["declined(聚会)"]);
    expect(drafts[0]!.span).toBe("这周六的聚会我就不去了");
  });
});

describe("192：被……安排认成一个说法", () => {
  it("被临时安排、被别人安排、被领导安排：宾语是「被安排」，不把「安排」当后缀去掉", () => {
    expect(briefs("我不喜欢工作日被临时安排", { context: ["workday", "work"] })).toEqual(["dislikes(被安排)"]);
    expect(briefs("最受不了被别人安排得明明白白")).toEqual(["dislikes(被安排)"]);
    expect(briefs("我不想周末被领导安排")).toEqual(["¬prefers(被安排)"]);
  });

  it("被排满、被提前排满照旧是「被提前排满」", () => {
    expect(briefs("不喜欢周末被排满")).toEqual(["dislikes(被提前排满)"]);
    expect(briefs("我不喜欢周末被提前排满")).toEqual(["dislikes(被提前排满)"]);
  });

  it("不是被动的「安排」照旧当后缀去掉：推掉了周六的爬山安排 → 爬山", () => {
    expect(briefs("推掉了周六的爬山安排", { context: ["weekend"] })).toEqual(["declined(爬山)"]);
  });
});
