// 从解析出的联系人整理出要进档案候选的人（301 号票，google/contact-offers.ts），示例联系人都是编的：
// - 用户自己那张（称呼、昵称是"我的名字"）：生日、纪念日、电话、住址进本人；上面写的相关的人带着"和我的关系"进来（有卡片的合上卡片）；
// - 档案里已有的人（按称呼、昵称对上）：卡片上有的都进；别的人有生日、纪念日、关系的才进，只有电话的不进、算个数；
// - 别人卡片上指向用户自己的只认两头一样的关系；指向别人的不要；
// - 几个电话取首选 / 手机 / 第一个，别的给 also；住址取首选 / 家里的；同一个称呼的几张卡片合成一个人；称呼太长的不进；
// - 纪念日起名字：Anniversary 叫"纪念日"、Other 叫"其他纪念日"、自己起的原样；先后：本人、已有的、带关系的、别的。
import { describe, expect, it } from "vitest";
import { offersFromContacts } from "../../src/google/contact-offers.ts";
import type { VcardContact } from "../../src/google/vcard.ts";

const card = (c: Partial<VcardContact> & { name: string }): VcardContact => ({ nicknames: [], anniversaries: [], phones: [], addresses: [], related: [], ...c });
const tel = (value: string, types: string[] = [], pref = false, label?: string) => ({ value, types, pref, ...(label === undefined ? {} : { label }) });

const ME = card({
  name: "陈晓",
  nicknames: ["晓晓"],
  birthday: { year: 1992, month: 5, day: 20 },
  anniversaries: [{ date: { year: 2018, month: 10, day: 1 }, label: "anniversary" }],
  phones: [tel("138 0000 0001", ["cell"]), tel("010-6000 0001", ["work"])],
  addresses: [tel("浙江省杭州市某某路 9 号", ["home"])],
  related: [
    { name: "张丽", types: [], label: "mother" },
    { name: "王大伟", types: [], label: "spouse" },
    { name: "小宝", types: [], label: "儿子" },
    { name: "某同事", types: [], label: "other" },
  ],
});
const MOM = card({ name: "张丽", birthday: { month: 3, day: 2 }, phones: [tel("0571-8800 0002", ["home"]), tel("139 0000 0002", ["cell"])] });
const ZHOU = card({ name: "周建国", nicknames: ["老周"], phones: [tel("137-0000-0003")], addresses: [tel("某某小区 3 栋", ["work"]), tel("某某路 3 号", ["home"])] });
const LI = card({ name: "李芳", anniversaries: [{ date: { year: 2012, month: 5, day: 20 }, label: "相识纪念日" }, { date: { month: 7, day: 7 }, label: "other" }] });
const ZHAO = card({ name: "赵六", phones: [tel("137 0000 0006")] });
const SUN = card({ name: "孙七", related: [{ name: "陈晓", types: ["friend"] }] });
const QIAN = card({ name: "钱八", related: [{ name: "我", types: [], label: "mother" }] });
const WU = card({ name: "武九", related: [{ name: "李芳", types: ["spouse"] }] });

const known = (...names: string[]) => (name: string) => names.includes(name);

describe("整理成档案候选", () => {
  it("本人那张进本人；它上面的家人带着关系进来；已有的人、有日子的人进；只有电话的不进", () => {
    const { offers, skipped } = offersFromContacts([ZHAO, MOM, ME, ZHOU, LI, SUN, QIAN, WU], { selfName: "陈晓", known: known("老周") });
    expect(offers.map((o) => [o.key, o.relation ?? ""])).toEqual([
      ["me", ""],
      ["周建国", ""],
      ["张丽", "母亲"],
      ["孙七", "朋友"],
      ["王大伟", "配偶"],
      ["小宝", "儿子"],
      ["李芳", ""],
    ]);
    // 赵六只有电话；钱八指向我的是"母亲"（反过来不对，不要）；武九的关系指向别人
    expect(skipped).toBe(3);
    expect(offers[0]).toEqual({
      key: "me",
      name: "陈晓",
      aliases: [],
      self: true,
      fields: [
        { field: "birthday", value: "1992-05-20" },
        { field: "anniversary:纪念日", value: "2018-10-01" },
        { field: "phone", value: "13800000001", also: ["01060000001"] },
        { field: "address", value: "浙江省杭州市某某路 9 号" },
      ],
    });
  });

  it("几个电话取手机、住址取家里的，别的给 also；首选优先；昵称是别名", () => {
    const { offers } = offersFromContacts([MOM, ZHOU, card({ name: "冯十", birthday: { month: 1, day: 1 }, phones: [tel("13700000010", ["cell"]), tel("010-10", ["work"], true)] })], { known: known("老周") });
    const byKey = new Map(offers.map((o) => [o.key, o]));
    expect(byKey.get("张丽")!.fields).toEqual([
      { field: "birthday", value: "03-02" },
      { field: "phone", value: "13900000002", also: ["057188000002"] },
    ]);
    expect(byKey.get("周建国")).toMatchObject({ aliases: ["老周"], fields: [{ field: "phone", value: "13700000003" }, { field: "address", value: "某某路 3 号", also: ["某某小区 3 栋"] }] });
    expect(byKey.get("冯十")!.fields).toContainEqual({ field: "phone", value: "01010", also: ["13700000010"] });
  });

  it("纪念日的名字：自己起的原样、Other 叫\"其他纪念日\"；没有\"我的名字\"时认不出本人那张", () => {
    const { offers } = offersFromContacts([ME, LI], { known: known() });
    expect(offers.find((o) => o.key === "李芳")!.fields).toEqual([
      { field: "anniversary:相识纪念日", value: "2012-05-20" },
      { field: "anniversary:其他纪念日", value: "07-07" },
    ]);
    expect(offers.some((o) => o.self)).toBe(false);
    // 陈晓当一个有生日的普通人
    expect(offers.find((o) => o.key === "陈晓")).toMatchObject({ name: "陈晓" });
  });

  it("同一个称呼的几张卡片合成一个人：电话合起来、生日取有的那张", () => {
    const { offers } = offersFromContacts([card({ name: "李芳", phones: [tel("13600000011", ["cell"])] }), card({ name: "李芳", birthday: { year: 1990, month: 8, day: 15 }, phones: [tel("136 0000 0011"), tel("021-12345678", ["home"])] })], { known: known() });
    expect(offers).toEqual([
      {
        key: "李芳",
        name: "李芳",
        aliases: [],
        fields: [
          { field: "birthday", value: "1990-08-15" },
          { field: "phone", value: "13600000011", also: ["02112345678"] },
        ],
      },
    ]);
  });

  it("称呼太长的不进（档案的称呼最多 20 个字）；档案里已有、却什么都没有的不进", () => {
    const long = card({ name: "Dr. Christopher Alexander Montgomery", birthday: { month: 2, day: 2 } });
    const empty = card({ name: "老周" });
    const { offers, skipped } = offersFromContacts([long, empty], { known: known("老周") });
    expect(offers).toEqual([]);
    expect(skipped).toBe(2);
  });

  it("本人那张上指向通讯录里另一张的（RELATED urn:uuid）也认；写的是昵称的合到那张卡片上", () => {
    const me = card({ name: "陈晓", related: [{ uid: "u-mom", types: ["parent"] }, { name: "老周", types: ["friend"] }] });
    const mom = card({ uid: "u-mom", name: "张丽", phones: [tel("13900000002")] });
    const { offers } = offersFromContacts([me, mom, ZHOU], { selfName: "陈晓", known: known() });
    expect(offers.map((o) => [o.key, o.relation])).toEqual([
      ["张丽", "父母"],
      ["周建国", "朋友"],
    ]);
  });
});
