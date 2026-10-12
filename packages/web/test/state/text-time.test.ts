// 前端状态层：发起任务时从写的话里认出时间（97 号票）。用户 2026-10-12：写"明天早上8点调研一下……"、选了"定时"没动时间，
// 建出的是每天 09:00（对话框的默认）——说了几点就得按几点。这里是认时间的纯函数（表格测试：哪天、反复、时段、钟点，
// 边界和不该认的），以及对话框"没动过就自动填、动过就不覆盖、不一致时提示"的状态层函数。界面靠截图核对。
import { describe, expect, test } from "vitest";
import {
  describeSchedule,
  fillWhenFromText,
  initialWhenFields,
  NOT_TOUCHED,
  type TaskKind,
  type TextTime,
  timeFromText,
  touchWhen,
  type WhenFields,
  whenTextHint,
  type WhenTouched,
  withClockTime,
} from "../../src/state/index.ts";

/** 2026-10-12 是周一；此刻晚上 9 点半（用户是晚上写的） */
const NOW = new Date(2026, 9, 12, 21, 30);
/** 同一天早上 7 点 */
const MORNING = new Date(2026, 9, 12, 7, 0);

/** 认出的结果写成一行：[一次 / 反复, 时间表的中文写法, 原话片段] */
const brief = (found: TextTime | undefined, now: Date = NOW) => found && [found.mode, describeSchedule(found.schedule, now), found.quote];

describe("从写的话里认出时间", () => {
  test.each([
    // 用户这次的原话
    ["明天早上8点调研一下最新的AI的新闻，总结成文本发给我，加上超链接", "10 月 13 日（周二）08:00", "明天早上8点"],
    // 哪天
    ["今晚10点提醒我收衣服", "10 月 12 日（周一）22:00", "今晚10点"],
    ["今天晚上11点备份一下照片", "10 月 12 日（周一）23:00", "今天晚上11点"],
    ["明早7点半叫我", "10 月 13 日（周二）07:30", "明早7点半"],
    ["明晚8点", "10 月 13 日（周二）20:00", "明晚8点"],
    ["明天 上午 10 点 开会前把材料整理好", "10 月 13 日（周二）10:00", "明天 上午 10 点"],
    ["后天下午3点", "10 月 14 日（周三）15:00", "后天下午3点"],
    ["大后天上午10点", "10 月 15 日（周四）10:00", "大后天上午10点"],
    ["下周一早上9点出周报", "10 月 19 日（周一）09:00", "下周一早上9点"],
    ["下星期三下午2点", "10 月 21 日（周三）14:00", "下星期三下午2点"],
    ["周三晚上7点", "10 月 14 日（周三）19:00", "周三晚上7点"],
    ["星期五中午12点", "10 月 16 日（周五）12:00", "星期五中午12点"],
    ["礼拜天下午两点", "10 月 18 日（周日）14:00", "礼拜天下午两点"],
    ["这周五早上8点", "10 月 16 日（周五）08:00", "这周五早上8点"],
    // 周几的字和中文的钟点连着写
    ["周三八点", "10 月 14 日（周三）08:00", "周三八点"],
    ["下周一十点", "10 月 19 日（周一）10:00", "下周一十点"],
    // 今天是周一、钟点还没过：就是今天；过了就是下周一
    ["周一晚上10点", "10 月 12 日（周一）22:00", "周一晚上10点"],
    ["周一早上8点", "10 月 19 日（周一）08:00", "周一早上8点"],
    ["10月20日上午10点", "10 月 20 日（周二）10:00", "10月20日上午10点"],
    ["11月1号早上8点", "11 月 1 日（周日）08:00", "11月1号早上8点"],
    ["十月二十号晚上八点", "10 月 20 日（周二）20:00", "十月二十号晚上八点"],
    ["15号上午10点交", "10 月 15 日（周四）10:00", "15号上午10点"],
    // 这个月的 5 号过了：下个月；1 月 5 号过了：明年
    ["5号9点", "11 月 5 日（周四）09:00", "5号9点"],
    ["1月5号9点", "2027 年 1 月 5 日（周二）09:00", "1月5号9点"],
    // 只有钟点：今天这个钟点过了就是明天，没过就是今天
    ["8点调研一下", "10 月 13 日（周二）08:00", "8点"],
    ["22点提醒我", "10 月 12 日（周一）22:00", "22点"],
    ["23:00 备份", "10 月 12 日（周一）23:00", "23:00"],
    ["20:00 发我", "10 月 13 日（周二）20:00", "20:00"],
    ["二十点", "10 月 13 日（周二）20:00", "二十点"],
    // 时段
    ["中午12点", "10 月 13 日（周二）12:00", "中午12点"],
    ["中午1点", "10 月 13 日（周二）13:00", "中午1点"],
    ["下午两点", "10 月 13 日（周二）14:00", "下午两点"],
    ["傍晚6点", "10 月 13 日（周二）18:00", "傍晚6点"],
    ["凌晨3点", "10 月 13 日（周二）03:00", "凌晨3点"],
    ["夜里11点", "10 月 12 日（周一）23:00", "夜里11点"],
    // 晚上 12 点是 0 点（过了这一天的半夜）；晚上、夜里的 1–4 点是半夜（不是下午）
    ["晚上12点", "10 月 13 日（周二）00:00", "晚上12点"],
    ["明晚12点", "10 月 14 日（周三）00:00", "明晚12点"],
    ["夜里2点", "10 月 13 日（周二）02:00", "夜里2点"],
    // 钟点的各种写法
    ["8点半", "10 月 13 日（周二）08:30", "8点半"],
    ["8点一刻", "10 月 13 日（周二）08:15", "8点一刻"],
    ["8点三刻", "10 月 13 日（周二）08:45", "8点三刻"],
    ["8点15", "10 月 13 日（周二）08:15", "8点15"],
    ["8点15分", "10 月 13 日（周二）08:15", "8点15分"],
    ["8点钟", "10 月 13 日（周二）08:00", "8点钟"],
    ["8：30", "10 月 13 日（周二）08:30", "8：30"],
    ["十点半", "10 月 13 日（周二）10:30", "十点半"],
    ["早上八点二十", "10 月 13 日（周二）08:20", "早上八点二十"],
    ["两点开会", "10 月 13 日（周二）02:00", "两点"],
    ["十点", "10 月 13 日（周二）10:00", "十点"],
    ["晚上8:30", "10 月 13 日（周二）20:30", "晚上8:30"],
    // 不相干的数字不误认：后面的数量词、前面的"昨天"
    ["调研3家公司，明天下午4点前给我", "10 月 13 日（周二）16:00", "明天下午4点"],
    ["昨晚8点的会议纪要整理一下，明天早上9点发我", "10 月 13 日（周二）09:00", "明天早上9点"],
  ])("一次：%s → %s", (text, at, quote) => {
    expect(brief(timeFromText(text, NOW))).toEqual(["at", at, quote]);
  });

  test.each([
    ["每天早上8点出一份早报", "每天 08:00", "每天早上8点"],
    ["每日9点", "每天 09:00", "每日9点"],
    ["天天晚上10点", "每天 22:00", "天天晚上10点"],
    ["每晚9点半", "每天 21:30", "每晚9点半"],
    ["每天8点10条新闻", "每天 08:00", "每天8点"],
    ["每周一三五晚上7点", "每周一、三、五 19:00", "每周一三五晚上7点"],
    ["每周一和周四上午10点", "每周一、四 10:00", "每周一和周四上午10点"],
    ["每周一三五八点", "每周一、三、五 08:00", "每周一三五八点"],
    ["每周一、三、五 8:00", "每周一、三、五 08:00", "每周一、三、五 8:00"],
    ["每个星期天晚上8点", "每周日 20:00", "每个星期天晚上8点"],
    ["每周一到周五早上8点", "每周一、二、三、四、五 08:00", "每周一到周五早上8点"],
    ["工作日早上9点", "按我的工作日 09:00", "工作日早上9点"],
    ["每个工作日下午6点", "按我的工作日 18:00", "每个工作日下午6点"],
    ["每月15号上午10点", "每月 15 号 10:00", "每月15号上午10点"],
    ["每月1号和15号9点", "每月 1、15 号 09:00", "每月1号和15号9点"],
    ["每个月30号晚上8点", "每月 30 号 20:00（没有这天的月份在月底）", "每个月30号晚上8点"],
    // 晚上 12 点是过了这一天的 0 点：每周五晚上 12 点是每周六 00:00
    ["每周五晚上12点", "每周六 00:00", "每周五晚上12点"],
  ])("反复：%s → %s", (text, schedule, quote) => {
    expect(brief(timeFromText(text, NOW))).toEqual(["repeat", schedule, quote]);
  });

  test("只有钟点：今天这个钟点还没过就是今天（早上 7 点写的 8 点是今天 8 点）", () => {
    expect(brief(timeFromText("8点调研一下", MORNING), MORNING)).toEqual(["at", "10 月 12 日（周一）08:00", "8点"]);
  });

  test.each([
    // 写了哪天没写钟点、写了反复没写钟点
    "明天调研一下最新的AI新闻",
    "每天帮我看一下新闻",
    "每周一出周报",
    // 不相干的数字
    "总结成3点发给我",
    "给我3点建议",
    "第2点改一下",
    "有两点要注意",
    "简单一点，快一点",
    "下载10首歌",
    "Wi-Fi 7 的路由器买3个，预算2000以内",
    "版本号写成1.8",
    // 过去的时间：说的是之前的事，不是什么时候做
    "总结一下昨天晚上8点的会",
    "上周三下午3点的会议纪要",
    "今天早上8点开会的纪要整理一下",
    "这周一早上8点的会",
    // 写了哪天、但写法认不出：不当成只有钟点
    "每月最后一天8点",
    "周末早上9点",
    // 钟点不对、日子不存在
    "25点",
    "2月30号8点",
  ])("认不出：%s", (text) => {
    expect(timeFromText(text, NOW)).toBeUndefined();
  });
});

describe("发起对话框：写的话里有时间就按它定", () => {
  /** 写一段话：认出时间，按动过哪几栏填 */
  const write = (fields: WhenFields, touched: WhenTouched, text: string, kind: TaskKind = "plain") => {
    const found = timeFromText(text, NOW);
    return { found, fields: fillWhenFromText(fields, touched, found, kind, NOW) };
  };
  const start = initialWhenFields(NOW);

  test("一开始：现在做一次；定时默认每天 09:00", () => {
    expect(start.when).toBe("once");
    expect(start.timedMode).toBe("repeat");
    expect(describeSchedule(start.schedule)).toBe("每天 09:00");
    expect(describeSchedule(start.doAt)).toBe("10 月 13 日（周二）09:00");
  });

  test("写\"明天早上8点……\"、没动过：自动切到定时 · 某个时间做一次，明天 08:00；提示按你写的定在哪", () => {
    const { found, fields } = write(start, NOT_TOUCHED, "明天早上8点调研一下最新的AI的新闻，总结成文本发给我，加上超链接");
    expect(fields.when).toBe("schedule");
    expect(fields.timedMode).toBe("at");
    expect(describeSchedule(fields.doAt)).toBe("10 月 13 日（周二）08:00");
    // 换成反复做时是同一个钟点；只提醒我的提醒时间也是它
    expect(describeSchedule(fields.schedule)).toBe("每天 08:00");
    expect(describeSchedule(fields.remindAt)).toBe("10 月 13 日（周二）08:00");
    expect(whenTextHint({ found, fields, touched: NOT_TOUCHED, kind: "plain", remindMode: "time" })).toEqual({
      tone: "auto",
      text: "按你写的「明天早上8点」定在 10 月 13 日（周二）08:00",
    });
  });

  test("写\"每天早上8点……\"：定时 · 按时间表反复做，每天 08:00", () => {
    const { found, fields } = write(start, NOT_TOUCHED, "每天早上8点出一份早报，汇总昨天的科技新闻");
    expect(fields.when).toBe("schedule");
    expect(fields.timedMode).toBe("repeat");
    expect(describeSchedule(fields.schedule)).toBe("每天 08:00");
    expect(describeSchedule(fields.doAt)).toBe("10 月 13 日（周二）08:00");
    expect(whenTextHint({ found, fields, touched: NOT_TOUCHED, kind: "plain", remindMode: "time" })).toEqual({ tone: "auto", text: "按你写的「每天早上8点」定成每天 08:00" });
  });

  test("先点了\"定时\"再写：定时那几栏没动过，照样按写的填", () => {
    const touched = touchWhen(NOT_TOUCHED, "when");
    const { fields } = write({ ...start, when: "schedule" }, touched, "明天早上8点调研一下");
    expect(fields.when).toBe("schedule");
    expect(fields.timedMode).toBe("at");
    expect(describeSchedule(fields.doAt)).toBe("10 月 13 日（周二）08:00");
  });

  test("自己改过定时那几栏：再改写的话不覆盖；和写的不一样时提示（照样能发起）", () => {
    const first = write(start, NOT_TOUCHED, "明天早上8点调研一下").fields;
    // 手动改成每天 09:00（换成按时间表反复做）
    const touched = touchWhen(NOT_TOUCHED, "timed");
    expect(touched.when).toBe(true);
    const mine: WhenFields = { ...first, timedMode: "repeat", schedule: { kind: "daily", time: "09:00" } };
    const { found, fields } = write(mine, touched, "明天早上8点调研一下AI新闻");
    expect(fields).toEqual(mine);
    expect(whenTextHint({ found, fields, touched, kind: "plain", remindMode: "time" })).toEqual({ tone: "warn", text: "你写的是「明天早上8点」，这里定的是每天 09:00" });
    // 还是做一次、手动改成 9 点：也标出来
    const nine: WhenFields = { ...first, doAt: withClockTime(first.doAt, "09:00") };
    expect(whenTextHint({ found, fields: nine, touched, kind: "plain", remindMode: "time" })).toEqual({ tone: "warn", text: "你写的是「明天早上8点」，这里定的是 10 月 13 日（周二）09:00" });
    // 改回和写的一样：不再提示
    expect(whenTextHint({ found, fields: first, touched, kind: "plain", remindMode: "time" })).toBeUndefined();
  });

  test("自己选了\"现在做一次\"：不切到定时；提示写的时间和选的不一样", () => {
    const touched = touchWhen(NOT_TOUCHED, "when");
    const { found, fields } = write(start, touched, "明天早上8点调研一下");
    expect(fields.when).toBe("once");
    expect(whenTextHint({ found, fields, touched, kind: "plain", remindMode: "time" })).toEqual({ tone: "warn", text: "你写的是「明天早上8点」，这里选的是现在做一次" });
  });

  test("写的话里的时间删掉了：没动过的回到一开始的样子", () => {
    const first = write(start, NOT_TOUCHED, "明天早上8点调研一下").fields;
    const { found, fields } = write(first, NOT_TOUCHED, "调研一下");
    expect(found).toBeUndefined();
    expect(fields.when).toBe("once");
    expect(fields.timedMode).toBe("repeat");
    expect(describeSchedule(fields.schedule)).toBe("每天 09:00");
    expect(whenTextHint({ found, fields, touched: NOT_TOUCHED, kind: "plain", remindMode: "time" })).toBeUndefined();
  });

  test("长程任务（不能定时）：不切到定时；提示长程任务只能现在做", () => {
    const { found, fields } = write(start, NOT_TOUCHED, "明天早上8点开始调研路由器", "long_running");
    expect(fields.when).toBe("once");
    expect(whenTextHint({ found, fields, touched: NOT_TOUCHED, kind: "long_running", remindMode: "time" })).toEqual({
      tone: "warn",
      text: "你写了「明天早上8点」：长程任务只能现在做；要按时间做选普通任务或流程",
    });
    // 换回普通任务（"什么时候做"没动过）：自动切到定时
    expect(fillWhenFromText(fields, NOT_TOUCHED, found, "plain", NOW).when).toBe("schedule");
    // 动过"定时"的换成长程任务：只能现在做一次
    expect(fillWhenFromText({ ...fields, when: "schedule" }, touchWhen(NOT_TOUCHED, "when"), found, "long_running", NOW).when).toBe("once");
  });

  test("只提醒我：提醒时间没动过就按写的填；动过不覆盖、不一样时提示", () => {
    const touched = touchWhen(NOT_TOUCHED, "when");
    const { found, fields } = write({ ...start, when: "remind" }, touched, "明晚8点交房租");
    expect(fields.when).toBe("remind");
    expect(describeSchedule(fields.remindAt)).toBe("10 月 13 日（周二）20:00");
    expect(whenTextHint({ found, fields, touched, kind: "plain", remindMode: "time" })).toEqual({ tone: "auto", text: "按你写的「明晚8点」定在 10 月 13 日（周二）20:00" });
    const mine = touchWhen(touched, "remind");
    const changed: WhenFields = { ...fields, remindAt: { kind: "daily", time: "09:00" } };
    const again = write(changed, mine, "明晚8点交房租和水电");
    expect(again.fields.remindAt).toEqual({ kind: "daily", time: "09:00" });
    expect(whenTextHint({ found: again.found, fields: again.fields, touched: mine, kind: "plain", remindMode: "time" })).toEqual({
      tone: "warn",
      text: "你写的是「明晚8点」，这里定的是每天 09:00",
    });
    // 事件发生时提醒：不比时间
    expect(whenTextHint({ found, fields, touched, kind: "plain", remindMode: "event" })).toBeUndefined();
  });
});
