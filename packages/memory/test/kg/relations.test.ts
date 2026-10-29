// 199 号票：实体关系更丰富。例句都是自己写的（不看 fixtures/truth-kg），照常见的说法：别人来约用户、和谁一起、称呼和别名、几种简单句式。
import { afterEach, describe, expect, it } from "vitest";
import type { EvidenceDraft, Fact } from "../../src/domain/types.ts";
import type { MemoryEngine } from "../../src/engine.ts";
import { detectAliases, detectInvitation, detectPersons, leadBucket, RelationalFactExtractor, weekdayOf } from "../../src/kg/relations.ts";
import { LlmFactExtractor } from "../../src/kg/llm-extractor.ts";
import { FakeChatModel } from "../../src/llm/chat.ts";
import { closeEngines, openEngine, say } from "../rg/helpers.ts";

afterEach(closeEngines);

const names = (text: string) => detectPersons(text).map((p) => p.name);
const did = (id: string, text: string, at: string, context: string[] = []): EvidenceDraft => say(id, text, at, { mode: "do", kind: "action", context });

/** 一条事实的简写：主语.谓词(宾语)，用户做主语时省掉 */
function brief(engine: MemoryEngine, f: Fact): string {
  const name = (id: string) => engine.getEntity(id)?.name ?? id;
  const subject = f.subjectId === "en-user" ? "" : `${name(f.subjectId)}.`;
  const object = f.object.type === "entity" ? name(f.object.id) : f.object.value;
  return `${subject}${f.predicate}${f.negated ? "!" : ""}(${object})`;
}

function factsOf(engine: MemoryEngine, evidenceId: string): string[] {
  return engine.store.factsByEvidence(evidenceId).map((f) => brief(engine, f));
}

function extracted(drafts: EvidenceDraft[], now = "2026-10-20T12:00:00+08:00") {
  const t = openEngine(now);
  for (const d of drafts) t.engine.ingestEvidence(d);
  t.engine.extractFacts();
  return t.engine;
}

describe("人、称呼和关系", () => {
  it("外号、亲属称呼、工作上的角色、单位都认得；老毛病、小时候这类不是人", () => {
    expect(names("老王约小许和阿杰，王哥也来了")).toEqual(["老王", "小许", "阿杰", "王哥"]);
    expect(names("我妈和表姐打来电话，客户也在催")).toEqual(["妈", "表姐", "客户"]);
    expect(names("上海一家公司约用户二面")).toEqual(["上海一家公司"]);
    expect(names("腰椎的老毛病犯了，小时候也这样")).toEqual([]);
  });

  it("别名：括号里\"都叫他\"、\"也就是\"", () => {
    expect(detectAliases("隔壁组老张（大家都叫他张哥）约了周五吃饭").map((a) => [a.name, a.alias])).toEqual([["老张", "张哥"]]);
    expect(detectAliases("刘姐，也就是小刘，今天请假了").map((a) => [a.name, a.alias])).toEqual([["刘姐", "小刘"]]);
  });

  it("人和人的关系看称呼和旁边的说法：隔壁组 → 同事，大学同学 → 朋友，表姐 → 家人，客户 → 工作上的联系人", () => {
    const engine = extracted([
      did("ev-1", "隔壁组老张周三在部门群里约这周六上午打羽毛球。用户回他：“这周就不去了。”", "2026-03-13T21:00:00+08:00", ["weekend", "social"]),
      did("ev-2", "下午三点大学同学阿斌发消息，问晚上能不能见一面。用户回：“能！”", "2026-08-07T19:00:00+08:00"),
      say("ev-3", "表姐说中秋要来我家住两天。", "2026-09-01T20:00:00+08:00"),
      say("ev-4", "客户又拉了个电话会，我是真不爱打电话。", "2026-07-22T17:40:00+08:00", { context: ["workday"] }),
    ]);
    expect(factsOf(engine, "ev-1")).toContain("老张.colleague_of(用户)");
    expect(factsOf(engine, "ev-2")).toContain("阿斌.friend_of(用户)");
    expect(factsOf(engine, "ev-3")).toEqual(expect.arrayContaining(["表姐.family_of(用户)", "mentioned(表姐)"]));
    expect(factsOf(engine, "ev-4")).toEqual(expect.arrayContaining(["客户.work_contact_of(用户)", "mentioned(客户)", "dislikes(打电话)"]));
  });

  it("和谁一起：\"跟阿杰去\"\"陪我爸\"\"喊上老周和阿杰\"", () => {
    const engine = extracted([
      say("ev-1", "上周六跟阿杰去了趟海边，玩得挺开心。", "2026-06-08T20:00:00+08:00", { context: ["weekend", "leisure"] }),
      say("ev-2", "国庆回老家，陪我爸去医院复查。", "2026-10-03T09:30:00+08:00", { context: ["holiday", "family"] }),
      say("ev-3", "突然想吃烧烤，喊上老周和阿杰去江边烤了一下午。", "2026-09-12T18:00:00+08:00", { context: ["weekend"] }),
    ]);
    expect(factsOf(engine, "ev-1")).toContain("went_with(阿杰)");
    expect(factsOf(engine, "ev-2")).toEqual(expect.arrayContaining(["went_with(爸)", "爸.family_of(用户)"]));
    expect(factsOf(engine, "ev-3")).toEqual(expect.arrayContaining(["went_with(老周)", "went_with(阿杰)"]));
  });
});

describe("事件当实体：别人来约用户", () => {
  it("\"老张周三在部门群里约这周六上午打羽毛球\"：组织者、时间段、活动类型、提前多久约的、用户推掉了，当时说的理由照常抽", () => {
    const engine = extracted([did("ev-1", "小周周三在部门群里约这周六上午打羽毛球。用户周五晚上回他：“这周有点累，就不去了。”", "2026-03-13T21:00:00+08:00", ["weekend", "social"])]);
    const facts = factsOf(engine, "ev-1");
    const event = "小周约的羽毛球（2026-03-14）";
    expect(facts).toEqual(
      expect.arrayContaining([
        `declined(${event})`,
        `${event}.organized_by(小周)`,
        `${event}.in_slot(周末上午)`,
        `${event}.of_type(运动)`,
        `${event}.lead_time(提前1到3天约)`,
        "小周.colleague_of(用户)",
        "said_about(累)",
      ]),
    );
    // 188 的规则版把别人约的认成用户主动约的，这里换成了对事件的
    expect(facts.some((f) => f.startsWith("initiated("))).toBe(false);
  });

  it("\"老王组织的\"：组织了、用户去了", () => {
    const engine = extracted([did("ev-1", "老王组织的这周六上午爬山，用户周四就报了名，当天去了。", "2026-04-11T12:00:00+08:00", ["weekend"])]);
    expect(factsOf(engine, "ev-1")).toEqual(expect.arrayContaining(["participated_in(老王约的爬山（2026-04-11）)", "老王约的爬山（2026-04-11）.organized_by(老王)", "老王约的爬山（2026-04-11）.of_type(运动)"]));
  });

  it("当天才约的：下午四点多问今晚；地点是场所；\"不过去了\"里的\"去了\"不算去了", () => {
    const frame = detectInvitation({
      id: "ev-1",
      sourceLevel: "self",
      mode: "do",
      kind: "action",
      text: "下午四点多小周发消息，问今晚七点要不要去江边那家酒吧喝一杯。用户回：“今晚就不过去了，你们去吧。”",
      context: [],
      eventTime: "2026-02-27T17:20:00+08:00",
      observedAt: "2026-02-27T17:20:00+08:00",
      sourceRef: null,
      contentHash: "",
      status: "active",
    });
    expect(frame).toMatchObject({ response: "declined", lead: "当天才约", leadDays: 0, slot: "工作日晚上", place: "江边那家酒吧", kind: "聚餐" });
  });

  it("别人转述的不抽事件；用户约别人（\"约老周吃饭\"）不是邀约", () => {
    const engine = extracted([
      say("ev-1", "同事说：“老王约他周五吃饭，他没去。”", "2026-05-01T12:00:00+08:00", { sourceLevel: "untrusted" }),
      say("ev-2", "我晚上约老周吃饭，他说好。", "2026-05-02T12:00:00+08:00"),
    ]);
    expect(engine.store.listEntities().some((e) => e.type === "event")).toBe(false);
  });

  it("星期几、提前多久的档", () => {
    expect(weekdayOf("2026-03-14")).toBe(6);
    expect(weekdayOf("2026-03-16")).toBe(1);
    expect([leadBucket(0), leadBucket(3), leadBucket(4), leadBucket(-1)]).toEqual(["当天才约", "提前1到3天约", "提前4天以上约", undefined]);
  });
});

describe("实体对齐：老王 / 王哥", () => {
  it("先出现王哥、后来一句话里写明老王就是王哥：两个叫法是同一个实体，后来的事实都挂在它上面", () => {
    const engine = extracted([
      say("ev-1", "王哥今天在周会上把我的方案说成是他想的。", "2026-01-05T18:00:00+08:00", { context: ["workday", "work"] }),
      did("ev-2", "隔壁组老王（大家都叫他王哥）上周一在部门群里约这周五晚上吃烤鱼。用户没接龙，回他：“下回吧。”", "2026-01-16T10:00:00+08:00", ["workday", "social"]),
      did("ev-3", "老王上周四在部门群里约这周五晚上吃串串。用户回：“这周有点累，下次一定。”", "2026-02-12T18:00:00+08:00", ["workday", "social"]),
    ]);
    const wang = engine.store.findEntityByName("王哥")!;
    expect(engine.store.findEntityByName("老王")!.id).toBe(wang.id);
    expect(wang.aliases).toContain("老王");
    const organizers = engine.store.listFacts({ predicate: "organized_by" }).map((f) => (f.object as { id: string }).id);
    expect(organizers).toEqual([wang.id, wang.id]);
    expect(engine.store.revisions(wang.id, "entity").some((r) => r.causeEvidenceId === "ev-2" && r.reason.includes("实体对齐"))).toBe(true);
  });

  it("两个叫法先各自建了实体，后来才知道是同一个人：合并，留先建的，事实改挂过去", () => {
    const engine = extracted([
      say("ev-1", "王哥今天又在周会上抢话。", "2026-01-05T18:00:00+08:00", { context: ["workday"] }),
      say("ev-2", "老王下午找我借了个充电宝。", "2026-01-06T15:00:00+08:00", { context: ["workday"] }),
      say("ev-3", "老王，也就是王哥，下个月要调去别的组了。", "2026-01-20T12:00:00+08:00", { context: ["workday"] }),
    ]);
    const wang = engine.store.findEntityByName("王哥")!;
    expect(engine.store.findEntityByName("老王")!.id).toBe(wang.id);
    const mentioned = engine.store.listFacts({ predicate: "mentioned" }).map((f) => (f.object as { id: string }).id);
    expect(new Set(mentioned)).toEqual(new Set([wang.id]));
  });
});

describe("188 认不出的几种简单句式", () => {
  it("一条跑步记录也没有 → 没跑；跑了五公里、舒服 → 跑了、喜欢跑；我要天天这么跑 → 沿用上一样活动", () => {
    const engine = extracted([
      did("ev-1", "这周用户每天都是八点以后才起，手环里一条跑步记录也没有。", "2026-05-15T20:00:00+08:00", ["workday", "exercise"]),
      say("ev-2", "端午那天去江边跑了五公里，舒服。等忙完这阵，我要天天这么跑。", "2026-06-19T07:40:00+08:00", { context: ["holiday", "exercise"] }),
    ]);
    expect(factsOf(engine, "ev-1")).toEqual(["participated_in!(跑步)"]);
    expect(factsOf(engine, "ev-2")).toEqual(expect.arrayContaining(["participated_in(跑步)", "prefers(跑步)"]));
  });

  it("差点没赶上高铁 → 没坐上（照字面）；报销里已检票的车票 → 坐了，日子按票上写的", () => {
    const engine = extracted([
      say("ev-1", "早上差点没赶上八点那班高铁。", "2026-05-06T21:00:00+08:00"),
      did("ev-2", "用户提交了报销，附件里有一张 5 月 6 日 08:00 开往杭州东的高铁票，状态是已检票。", "2026-05-08T10:00:00+08:00"),
    ]);
    expect(factsOf(engine, "ev-1")).toEqual(["participated_in!(高铁)"]);
    const ticket = engine.store.factsByEvidence("ev-2")[0]!;
    expect(brief(engine, ticket)).toBe("participated_in(高铁)");
    expect(ticket.eventTime).toBe("2026-05-06T08:00:00+08:00");
  });

  it("最烦 X、在投简历；\"一天的累就没了\"不是在说累；问句和别人做主语的不抽", () => {
    const engine = extracted([
      say("ev-1", "供应商又打电话来催，我最烦打电话了。", "2026-01-20T16:20:00+08:00"),
      say("ev-2", "我在投简历了，这礼拜面了两家。", "2026-03-10T22:00:00+08:00"),
      say("ev-3", "回家抱着猫揉两下，一天的累就没了。", "2026-07-09T21:00:00+08:00"),
      say("ev-4", "上海到杭州的高铁要坐几个小时？", "2026-07-10T21:00:00+08:00"),
      say("ev-5", "小许要出差两周。", "2026-07-11T21:00:00+08:00"),
    ]);
    expect(factsOf(engine, "ev-1")).toContain("dislikes(打电话)");
    expect(factsOf(engine, "ev-2")).toContain("works_on(找工作)");
    expect(factsOf(engine, "ev-3")).not.toContain("said_about(累)");
    expect(factsOf(engine, "ev-4")).toEqual([]);
    expect(factsOf(engine, "ev-5").filter((f) => !f.includes("mentioned"))).toEqual([]);
  });

  it("规则版的 id 是 rule:4.1（207 修了问句和否定），引擎默认用它", () => {
    expect(new RelationalFactExtractor().id).toBe("rule:4.1");
    expect(openEngine("2026-10-20T12:00:00+08:00").engine.extractor.id).toBe("rule:4.1");
  });
});

describe("模型版：带证据 id 的三元组和别名，伪造的丢掉", () => {
  it("关系、别名写进图谱；伪造的证据 id、不在说法表里的值、原文里没有的叫法写入前丢掉；事件名补上日子", async () => {
    const model = new FakeChatModel(() => ({
      facts: [
        {
          evidence_id: "ev-1",
          predicate: "declined",
          object: { name: "老王约的火锅", type: "event" },
          negated: false,
          context: ["workday", "social"],
          statement: "用户 2026-01-16 推掉了老王约的火锅",
          span: "用户没接龙",
        },
      ],
      relations: [
        { evidence_id: "ev-1", subject: { name: "老王约的火锅", type: "event" }, predicate: "organized_by", object: { name: "老王", type: "person" }, span: "老王约这周五晚上吃火锅" },
        { evidence_id: "ev-1", subject: { name: "老王约的火锅", type: "event" }, predicate: "in_slot", object: { value: "工作日晚上" } },
        { evidence_id: "ev-1", subject: { name: "老王约的火锅", type: "event" }, predicate: "in_slot", object: { value: "周五晚上" } },
        { evidence_id: "ev-1", subject: { name: "老王约的火锅", type: "event" }, predicate: "lead_time", object: { value: "提前一周" } },
        { evidence_id: "ev-1", subject: { name: "老王", type: "person" }, predicate: "colleague_of", object: { name: "用户", type: "person" } },
        { evidence_id: "ev-9", subject: { name: "老王", type: "person" }, predicate: "friend_of", object: { name: "用户", type: "person" } },
        { evidence_id: "ev-1", subject: { name: "老王", type: "person" }, predicate: "likes_food", object: { name: "火锅", type: "activity" } },
      ],
      aliases: [
        { evidence_id: "ev-1", name: "老王", alias: "王哥" },
        { evidence_id: "ev-1", name: "老王", alias: "王总" },
        { evidence_id: "ev-7", name: "老王", alias: "王哥" },
      ],
    }));
    const extractor = new LlmFactExtractor(model);
    const { engine } = openEngine("2026-10-20T12:00:00+08:00", { extractor });
    engine.ingestEvidence(did("ev-1", "隔壁组老王（组里都喊他王哥）约这周五晚上吃火锅。用户没接龙。", "2026-01-16T10:40:00+08:00", ["workday", "social"]));
    const dropped: { reason: string }[] = [];
    await engine.extractPending({ dropped: dropped as never });
    const facts = factsOf(engine, "ev-1");
    expect(facts).toEqual(
      expect.arrayContaining(["declined(老王约的火锅（2026-01-16）)", "老王约的火锅（2026-01-16）.organized_by(老王)", "老王约的火锅（2026-01-16）.in_slot(工作日晚上)", "老王.colleague_of(用户)"]),
    );
    expect(facts).toHaveLength(4);
    expect(engine.store.findEntityByName("王哥")?.name).toBe("老王");
    expect(engine.store.findEntityByName("王总")).toBeUndefined();
    const reasons = dropped.map((d) => d.reason);
    expect(reasons).toEqual(
      expect.arrayContaining([
        expect.stringContaining("时间段不在说法表里"),
        expect.stringContaining("提前多久不在说法表里"),
        "关系里伪造的证据 id：ev-9",
        "关系的谓词不认得：likes_food",
        expect.stringContaining("别名的两个叫法原文里没有"),
        "别名里伪造的证据 id：ev-7",
      ]),
    );
    expect(extractor.aliasesOf(engine.getEvidence("ev-1")!, engine.kg.view())).toEqual([{ name: "老王", alias: "王哥", type: "person", span: "老王 / 王哥" }]);
  });
});
