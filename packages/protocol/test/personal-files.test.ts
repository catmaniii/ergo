// 个人档案（281 号票）两边共用的规矩：字段叫什么、秘书写的字段名怎么认、哪些算号码、号码怎么逐位分组、值合不合规；接口的路径。
// 302 号票：内置字段"纪念日"（能有几个、各带名字）。
// 285 号票：档案里的人分组（家人、重要的人、其他人），没选的按"和我的关系"猜。
// 示例号码都是编的。
import { describe, expect, it } from "vitest";
import {
  checkPersonalNote,
  checkPersonalValue,
  checkPersonName,
  guessPersonGroup,
  HTTP_PATHS,
  isAnnualField,
  isNumberField,
  monthDayOf,
  numberGroups,
  parseHttpPath,
  personalFieldLabel,
  personalFieldOf,
  personalFieldOrder,
  PERSON_FIELDS,
  PERSON_GROUPS,
  SELF_FIELDS,
  spelledNumber,
  withheldFromModel,
} from "../src/index.ts";

describe("字段", () => {
  it("本人和重要的人默认的字段、名字（姓名 / 称呼，手机 / 电话，单位和职位 / 单位或学校）", () => {
    expect(SELF_FIELDS.map((f) => personalFieldLabel("self", f))).toEqual(["姓名", "身份证号", "护照号", "驾照号", "生日", "纪念日", "手机", "邮箱", "住址", "单位和职位", "过敏和用药"]);
    expect(PERSON_FIELDS.map((f) => personalFieldLabel("person", f))).toEqual(["称呼", "别名", "和我的关系", "生日", "纪念日", "电话", "住址", "单位或学校", "过敏和用药"]);
    expect(personalFieldLabel("self", "custom:车牌号")).toBe("车牌号");
    expect(personalFieldLabel("person", "anniversary:结婚纪念日")).toBe("结婚纪念日");
  });

  it.each<[string, "self" | "person", string, string | undefined]>([
    ["编号", "self", "id_card", "id_card"],
    ["名字", "self", "身份证号", "id_card"],
    ["别的说法", "self", "手机号", "phone"],
    ["别的说法", "person", "电话号码", "phone"],
    ["本人没有的默认字段当自定义的", "self", "和我的关系", "custom:和我的关系"],
    ["重要的人没有护照号：当自定义的", "person", "护照号", "custom:护照号"],
    ["自定义", "self", " 车牌号 ", "custom:车牌号"],
    ["写好了前缀的原样", "person", "custom:学号", "custom:学号"],
    ["纪念日：名字就叫纪念日的那一个", "self", "纪念日", "anniversary:纪念日"],
    ["纪念日的编号也一样", "person", "anniversary", "anniversary:纪念日"],
    ["名字带纪念日的认成内置纪念日里的一个", "person", "结婚纪念日", "anniversary:结婚纪念日"],
    ["写好了纪念日前缀的原样", "self", "anniversary:恋爱纪念日", "anniversary:恋爱纪念日"],
    ["写好了自定义前缀的纪念日还是自定义（283 的写法）", "self", "custom:结婚纪念日", "custom:结婚纪念日"],
    ["名字带生日的还是自定义", "person", "女儿生日", "custom:女儿生日"],
    ["纪念日的名字太长认不出", "self", "anniversary:一二三四五六七八九十一二三四五六七八九十一", undefined],
    ["空的认不出", "self", "  ", undefined],
    ["名字太长认不出", "self", "一二三四五六七八九十一二三四五六七八九十一", undefined],
  ])("秘书写的字段名：%s（%s「%s」→ %s）", (_case, kind, raw, field) => {
    expect(personalFieldOf(kind, raw)).toBe(field);
  });
});

describe("内置字段纪念日（302 号票）", () => {
  it("283 时建了同名的自定义字段、还没有这个纪念日的：接着写那个自定义字段，不另起一个；两个都有的写纪念日", () => {
    expect(personalFieldOf("self", "结婚纪念日", ["birthday", "custom:结婚纪念日"])).toBe("custom:结婚纪念日");
    expect(personalFieldOf("self", "anniversary:结婚纪念日", ["custom:结婚纪念日"])).toBe("custom:结婚纪念日");
    expect(personalFieldOf("self", "结婚纪念日", ["custom:结婚纪念日", "anniversary:结婚纪念日"])).toBe("anniversary:结婚纪念日");
    expect(personalFieldOf("self", "纪念日", ["custom:纪念日"])).toBe("custom:纪念日");
    expect(personalFieldOf("self", "恋爱纪念日", ["custom:结婚纪念日"])).toBe("anniversary:恋爱纪念日");
  });

  it("档案上的先后：纪念日排在生日后面，一个都没有列空的那个，有了按第一次写的先后换成那几个；自定义的在最后", () => {
    expect(personalFieldOrder("person", [])).toEqual(PERSON_FIELDS);
    expect(personalFieldOrder("person", ["custom:车牌号", "anniversary:结婚纪念日", "phone", "anniversary:相识纪念日", "anniversary:结婚纪念日"])).toEqual([
      "name",
      "aliases",
      "relation",
      "birthday",
      "anniversary:结婚纪念日",
      "anniversary:相识纪念日",
      "phone",
      "address",
      "work",
      "health",
      "custom:车牌号",
    ]);
  });

  it("每个纪念日都是每年的日子、写的日子不算号码；占位置的那个空的不是", () => {
    expect(isAnnualField("anniversary:结婚纪念日")).toBe(true);
    expect(isAnnualField("anniversary:相识那天")).toBe(true);
    expect(isAnnualField("anniversary")).toBe(false);
    expect(isNumberField("anniversary:结婚纪念日", "2018年10月1日")).toBe(false);
    expect(withheldFromModel("anniversary:结婚纪念日", "2018年10月1日")).toBe(false);
  });
});

describe("号码：逐位列出", () => {
  it("证件号、电话算号码；自定义字段里有 6 位以上数字也算；别的不算", () => {
    expect(isNumberField("id_card", "")).toBe(true);
    expect(isNumberField("phone", "13800001111")).toBe(true);
    expect(isNumberField("custom:车牌号", "浙A12345")).toBe(false);
    expect(isNumberField("custom:社保卡号", "1234567890")).toBe(true);
    expect(isNumberField("address", "文三路 188888 号")).toBe(false);
  });

  it("18 位身份证号 6 · 8 · 4，11 位手机号 3 · 4 · 4，别的每 4 位一组；空白不算一位", () => {
    expect(numberGroups("11010119900307123X").map((g) => g.join(""))).toEqual(["110101", "19900307", "123X"]);
    expect(numberGroups("138 0000 1111").map((g) => g.join(""))).toEqual(["138", "0000", "1111"]);
    expect(numberGroups("E12345678").map((g) => g.join(""))).toEqual(["E123", "4567", "8"]);
    expect(spelledNumber("13800001111")).toBe("1 3 8 · 0 0 0 0 · 1 1 1 1");
  });
});

describe("值合不合规", () => {
  it("号码去掉中间的空白，身份证号、护照号的字母写成大写；别的只去首尾空白", () => {
    expect(checkPersonalValue("phone", " 138 0000 1111 ")).toEqual({ ok: true, value: "13800001111" });
    expect(checkPersonalValue("id_card", "11010119900307123x")).toEqual({ ok: true, value: "11010119900307123X" });
    expect(checkPersonalValue("address", "  文三路 18 号 ")).toEqual({ ok: true, value: "文三路 18 号" });
  });

  it.each<[string, string, RegExp]>([
    ["空的", "  ", /不能是空的/],
    ["太长", "字".repeat(201), /最多 200 个字/],
    ["有换行", "文三路\n18 号", /不能有换行/],
  ])("%s：不合规", (_case, raw, reason) => {
    const result = checkPersonalValue("address", raw);
    expect(result.ok ? "" : result.error).toMatch(reason);
  });

  it("记下的事可以有换行、最多 1000 字；称呼 1–20 个字", () => {
    expect(checkPersonalNote(" 腿脚不好，\n爬楼吃力 ")).toEqual({ ok: true, value: "腿脚不好，\n爬楼吃力" });
    expect(checkPersonalNote("").ok).toBe(false);
    expect(checkPersonName(" 妈妈 ")).toEqual({ ok: true, value: "妈妈" });
    expect(checkPersonName("一".repeat(21)).ok).toBe(false);
  });
});

describe("接口的路径", () => {
  it("列表、一份、删", () => {
    expect(HTTP_PATHS.personalFiles).toBe("/api/personal-files");
    expect(parseHttpPath(HTTP_PATHS.personalFiles)).toEqual({ route: "personal_files" });
    expect(parseHttpPath(HTTP_PATHS.personalFile("p-1"))).toEqual({ route: "personal_file", personId: "p-1" });
    expect(parseHttpPath(HTTP_PATHS.personalFileDelete("me"))).toEqual({ route: "personal_file_delete", personId: "me" });
    // 283 号票：二狗了解到的
    expect(HTTP_PATHS.personalFileLearned("p-1")).toBe("/api/personal-files/p-1/learned");
    expect(parseHttpPath(HTTP_PATHS.personalFileLearned("p-1"))).toEqual({ route: "personal_file_learned", personId: "p-1" });
    expect(parseHttpPath("/api/personal-files/me/other")).toBeUndefined();
  });
});

// 283 号票：生日、纪念日的每年提醒；不进整理提示的字段
describe("每年的日子", () => {
  it("生日和名字里带生日、纪念日的自定义字段算；别的不算", () => {
    expect(isAnnualField("birthday")).toBe(true);
    expect(isAnnualField("custom:结婚纪念日")).toBe(true);
    expect(isAnnualField("custom:女儿生日")).toBe(true);
    expect(isAnnualField("custom:车牌号")).toBe(false);
    expect(isAnnualField("phone")).toBe(false);
  });

  it.each<[string, { month: number; day: number } | undefined]>([
    ["3月2日", { month: 3, day: 2 }],
    ["3 月 2 号", { month: 3, day: 2 }],
    ["1990年3月2日", { month: 3, day: 2 }],
    ["1990-03-02", { month: 3, day: 2 }],
    ["1990/3/2", { month: 3, day: 2 }],
    ["03-02", { month: 3, day: 2 }],
    ["2月29日", { month: 2, day: 29 }],
    ["每年 12 月 31 日", { month: 12, day: 31 }],
    ["2月30日", undefined],
    ["农历八月十五", undefined],
    ["农历8月15日", undefined],
    ["中秋节", undefined],
    ["13800001111", undefined],
  ])("认公历的某月某日：%s", (value, expected) => {
    expect(monthDayOf(value)).toEqual(expected);
  });

  it("纪念日这类自定义字段写的日子不算号码（不用逐位核对）；别的自定义字段 6 位以上数字照旧算", () => {
    expect(isNumberField("custom:结婚纪念日", "2018年10月1日")).toBe(false);
    expect(isNumberField("custom:车牌号", "沪A123456")).toBe(true);
  });

  it("不进整理提示的：号码类、自定义里的一串数字、住址；别的照常", () => {
    expect(withheldFromModel("id_card", "110101199003071234")).toBe(true);
    expect(withheldFromModel("phone", "13800001111")).toBe(true);
    expect(withheldFromModel("address", "文三路 18 号")).toBe(true);
    expect(withheldFromModel("custom:社保号", "12345678")).toBe(true);
    expect(withheldFromModel("birthday", "1990年3月2日")).toBe(false);
    expect(withheldFromModel("work", "某研究所")).toBe(false);
    expect(withheldFromModel("custom:结婚纪念日", "2018年10月1日")).toBe(false);
  });
});

describe("档案里的人分组（285 号票）", () => {
  it("三组：家人、重要的人、其他人（本人那份不分组，列表上单独一组\"我\"）", () => {
    expect(PERSON_GROUPS).toEqual(["family", "important", "others"]);
  });

  it("没选分组的按和我的关系猜：父母、配偶、子女、兄弟姐妹（连同排行、口语的叫法）归家人", () => {
    const family = ["母亲", "妈妈", "老妈", "父亲", "爸", "妻子", "老婆", "丈夫", "老公", "爱人", "配偶", "女儿", "儿子", "大女儿", "小儿子", "哥哥", "二哥", "姐姐", "弟弟", "妹妹", "亲姐姐", "我妈", "我的女儿", "爷爷", "外婆", "岳母", "婆婆", "孙女"];
    const english = ["Mother", "father", "wife", "husband", "son", "daughter", "brother", "sister"];
    // 猜错的列出来（应该一个都没有）
    expect([...family, ...english].filter((r) => guessPersonGroup(r) !== "family")).toEqual([]);
  });

  it("猜不出的、没写关系的归其他人；猜不会猜成重要的人", () => {
    expect(["同事", "朋友", "表弟", "堂妹", "装修师傅", "妈妈的同事", "老师", "邻居", "", "  "].filter((r) => guessPersonGroup(r) !== "others")).toEqual([]);
    expect(guessPersonGroup(undefined)).toBe("others");
  });
});
