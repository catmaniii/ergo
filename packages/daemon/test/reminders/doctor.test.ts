// 提醒插件的体检项（414，src/reminders/doctor.ts）"时区"：配置文件里的时区和这台电脑的一样是正常（写现在的时区），
// 不一样是注意（写两个时区，修法说怎么改）；标记在装配时算好（插件 setup 里，以前只记一行日志）。
import { describe, expect, it } from "vitest";
import { runDoctorCheck } from "../../src/doctor/checks.ts";
import { timezoneCheck, timezoneFinding, zoneMismatch } from "../../src/reminders/doctor.ts";

describe("提醒的时区", () => {
  it("一样：没有标记、正常；不一样：标记记下两个时区、注意", async () => {
    expect(zoneMismatch("Asia/Shanghai", "Asia/Shanghai")).toBeUndefined();
    const mismatch = zoneMismatch("Asia/Shanghai", "America/New_York");
    expect(mismatch).toEqual({ configured: "Asia/Shanghai", local: "America/New_York" });
    expect(timezoneFinding(undefined, "Asia/Shanghai")).toEqual({ level: "ok", fact: { key: "reminders.doctor.timezone.ok", params: { zone: "Asia/Shanghai" } } });
    expect(timezoneFinding(mismatch, "America/New_York")).toEqual({
      level: "warn",
      fact: { key: "reminders.doctor.timezone.mismatch", params: { configured: "Asia/Shanghai", local: "America/New_York" } },
      fix: { key: "reminders.doctor.timezone.fix" },
    });
    const check = timezoneCheck(mismatch, "America/New_York");
    expect(check).toMatchObject({ id: "timezone", title: "reminders.doctor.timezone.title", cost: "passive" });
    expect((await runDoctorCheck(check)).level).toBe("warn");
  });
});
