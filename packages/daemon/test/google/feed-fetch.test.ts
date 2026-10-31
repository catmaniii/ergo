// 私密地址里哪一段能给人看（339 号票）：个人日历的 id 是完整邮箱，算账号、原样显示；共享、订阅的日历不算账号，id 照旧打码；
// 不是邮箱的 id 不原样显示（可能就是私钥那一段）。路径里的私钥任何时候都不出现。
import { describe, expect, it } from "vitest";
import { accountOf, maskAddress } from "../../src/google/feed-fetch.ts";
import { googleAddress, PRIVATE_TOKEN } from "../helpers/fake-ical.ts";

describe("私密地址里能给人看的那部分", () => {
  it.each([
    ["个人日历", googleAddress("chenxiao@gmail.com"), "chenxiao@gmail.com", "calendar.google.com · chenxiao@gmail.com"],
    ["自己域名的账号（带点、带加号）", googleAddress("chen.xiao+cal@corp.example.com"), "chen.xiao+cal@corp.example.com", "calendar.google.com · chen.xiao+cal@corp.example.com"],
    ["共享的日历", googleAddress("family123@group.calendar.google.com"), undefined, "calendar.google.com · f***@group.calendar.google.com"],
    ["订阅的节假日日历", googleAddress("zh-cn.china#holiday@group.v.calendar.google.com"), undefined, "calendar.google.com · z***@group.v.calendar.google.com"],
    ["id 的位置上不是邮箱（私钥在这一段）", `https://calendar.google.com/calendar/ical/${PRIVATE_TOKEN}/basic.ics`, undefined, "calendar.google.com · p***"],
    ["不是 Google 那种路径", `https://example.com/feeds/${PRIVATE_TOKEN}.ics`, undefined, "example.com"],
    ["不是网址", "日历地址", undefined, "***"],
  ])("%s", (_name, address, account, shown) => {
    expect(accountOf(address)).toBe(account);
    expect(maskAddress(address)).toBe(shown);
    expect(maskAddress(address)).not.toContain(PRIVATE_TOKEN);
  });
});
