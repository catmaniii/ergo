// 共享协议包：已配对设备多选管理的纯函数（123 号票）——延期后的到期日、哪台要跳过、跳过的原因怎么说。
// 守护进程判断、Web 上算按钮个数用的是同一份。
// 137 号票：配对请求像不像网络上的自动访问（按浏览器标识判断，给出原因）。
import { describe, expect, test } from "vitest";
import { automatedAccess, automatedAccessHint, DEVICE_BATCH_ACTIONS, deviceBatchSkip, deviceSkipPhrase, extendedExpiry } from "../src/index.ts";

const DAY = 24 * 3600_000;
const NOW = Date.parse("2026-10-14T09:00:00.000+08:00");

describe("延期后的到期日", () => {
  test("还没到期的：从原到期日往后推", () => {
    const expiresAt = "2027-01-01T00:00:00.000+08:00";
    expect(extendedExpiry(expiresAt, NOW, 90)).toBe(Date.parse(expiresAt) + 90 * DAY);
  });

  test("已经过期、作废的：从现在起算（不是从早就过了的到期日）", () => {
    expect(extendedExpiry("2026-09-01T00:00:00.000+08:00", NOW, 30)).toBe(NOW + 30 * DAY);
  });
});

describe("哪台要跳过", () => {
  const valid = { revoked: false };
  const revoked = { revoked: true };
  const deleted = { revoked: true, deletedAt: "2026-10-13T09:00:00.000+08:00" };

  test("有效的（含过期、作废的）三样都能做", () => {
    for (const action of DEVICE_BATCH_ACTIONS) expect(deviceBatchSkip(valid, action)).toBeUndefined();
  });

  test("吊销了的不能延期、不能再吊销，能删除", () => {
    expect(deviceBatchSkip(revoked, "extend")).toBe("revoked");
    expect(deviceBatchSkip(revoked, "revoke")).toBe("revoked");
    expect(deviceBatchSkip(revoked, "delete")).toBeUndefined();
  });

  test("删了的、没有的：一律跳过", () => {
    for (const action of DEVICE_BATCH_ACTIONS) {
      expect(deviceBatchSkip(deleted, action)).toBe("deleted");
      expect(deviceBatchSkip(undefined, action)).toBe("not_found");
    }
  });

  test("跳过的原因接在\"N 台\"后面", () => {
    expect(deviceSkipPhrase("extend", "revoked")).toBe("已经吊销了，不能延期");
    expect(deviceSkipPhrase("revoke", "revoked")).toBe("已经吊销了");
    expect(deviceSkipPhrase("delete", "deleted")).toBe("已经删除了");
    expect(deviceSkipPhrase("revoke", "not_found")).toBe("找不到了");
  });
});

const reasonOf = (ua: string) => automatedAccess(ua)?.reason;

describe("像不像网络上的自动访问（137 号票）", () => {
  test("无界面浏览器、自动化工具：算，原因里写出是哪个字眼", () => {
    const headless = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/134.0.0.0 Safari/537.36";
    expect(reasonOf(headless)).toBe("浏览器标识带「HeadlessChrome」，是无界面浏览器");
    expect(reasonOf("Mozilla/5.0 (Unknown; Linux x86_64) AppleWebKit/538.1 (KHTML, like Gecko) PhantomJS/2.1.1 Safari/538.1")).toBe("浏览器标识带「PhantomJS」，是无界面浏览器");
    expect(reasonOf("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 Headless")).toContain("「Headless」");
    expect(reasonOf("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 puppeteer")).toBe("浏览器标识带「puppeteer」，是自动化工具");
    expect(reasonOf("Mozilla/5.0 (X11; Linux x86_64) Playwright/1.50 Chrome/133.0.0.0 Safari/537.36")).toContain("「Playwright」，是自动化工具");
  });

  test("爬虫：带 bot、crawler、spider 的", () => {
    expect(reasonOf("Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)")).toBe("浏览器标识带「Googlebot」，是爬虫");
    expect(reasonOf("Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm) Chrome/116.0.1938.76 Safari/537.36")).toContain("「bingbot」");
    expect(reasonOf("Mozilla/5.0 (compatible; Baiduspider/2.0; +http://www.baidu.com/search/spider.html)")).toContain("「Baiduspider」");
    expect(reasonOf("Mozilla/5.0 (compatible; Bytespider; spider-feedback@bytedance.com)")).toContain("「Bytespider」");
    expect(reasonOf("Mozilla/5.0 (Windows NT 10.0; Win64; x64) SiteCrawler/1.0")).toBe("浏览器标识带「SiteCrawler」，是爬虫");
    expect(reasonOf("TelegramBot (like TwitterBot)")).toContain("是爬虫");
  });

  test("程序库、命令行工具、扫描程序：算", () => {
    expect(reasonOf("curl/8.4.0")).toBe("浏览器标识带「curl」，是程序库或命令行工具");
    expect(reasonOf("python-requests/2.31.0")).toBe("浏览器标识带「python-requests」，是程序库或命令行工具");
    expect(reasonOf("Go-http-client/1.1")).toBe("浏览器标识带「Go-http-client」，是程序库或命令行工具");
    expect(reasonOf("Wget/1.21.4")).toContain("「Wget」");
    expect(reasonOf("okhttp/4.12.0")).toContain("「okhttp」");
    expect(reasonOf("Mozilla/5.0 zgrab/0.x")).toBe("浏览器标识带「zgrab」，是扫描程序");
    expect(reasonOf("Mozilla/5.0 (compatible; CensysInspect/1.1; +https://about.censys.io/)")).toContain("是扫描程序");
  });

  test("没有浏览器标识：算", () => {
    expect(reasonOf("")).toBe("没有浏览器标识");
    expect(reasonOf("   ")).toBe("没有浏览器标识");
  });

  test("别的明显特征：带网址（爬虫的写法）、不是现在的浏览器的写法（不以 Mozilla/5.0 加括号里的系统开头）", () => {
    expect(reasonOf("Mozilla/5.0 (compatible; Example-Fetcher/1.0; +https://example.com/about)")).toBe("浏览器标识里带网址，是爬虫的写法");
    expect(reasonOf("Mozilla/5.0")).toBe("浏览器标识「Mozilla/5.0」不是浏览器的写法");
    expect(reasonOf("Mozilla/4.0 (compatible; MSIE 6.0; Windows NT 5.1)")).toBe("浏览器标识「Mozilla/4.0 (compatible; MSIE 6.0; Windows NT 5.1)」不是浏览器的写法");
    // 太长的只引前面一段
    const long = `Example/1.0 ${"x".repeat(200)}`;
    expect(reasonOf(long)).toBe(`浏览器标识「${long.slice(0, 60)}…」不是浏览器的写法`);
  });

  test("普通的浏览器（含 Linux 桌面的 Chrome、Firefox）不算：用户可能真有 Linux 电脑", () => {
    const browsers = [
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36",
      "Mozilla/5.0 (X11; Linux aarch64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36",
      "Mozilla/5.0 (X11; Linux x86_64; rv:140.0) Gecko/20100101 Firefox/140.0",
      "Mozilla/5.0 (X11; Ubuntu; Linux x86_64; rv:140.0) Gecko/20100101 Firefox/140.0",
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36 Edg/153.0.0.0",
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/19.0 Safari/605.1.15",
      "Mozilla/5.0 (iPhone; CPU iPhone OS 19_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/19.0 Mobile/15E148 Safari/604.1",
      "Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Mobile Safari/537.36",
      // 手机牌子里带 bot 字样的（CUBOT）不误认成爬虫
      "Mozilla/5.0 (Linux; Android 10; CUBOT X30) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36",
      "Mozilla/5.0 (Linux; Android 9; CUBOT_X19) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36",
      // 鸿蒙的浏览器和二狗 App 里的 ArkWeb
      "Mozilla/5.0 (Phone; OpenHarmony 5.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0.0.0 Safari/537.36 ArkWeb/4.1.6.1 Mobile HuaweiBrowser/5.0.4.300",
      "Mozilla/5.0 (Phone; OpenHarmony 5.1) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0.0.0 Safari/537.36 ArkWeb/5.1.0.1 Mobile",
    ];
    for (const ua of browsers) expect({ ua, automated: automatedAccess(ua) }).toEqual({ ua, automated: undefined });
  });

  test("配对卡和待我处理上的那句提示", () => {
    expect(automatedAccessHint("浏览器标识带「HeadlessChrome」，是无界面浏览器")).toBe("看起来像网络上的自动访问（浏览器标识带「HeadlessChrome」，是无界面浏览器），不是你的设备就拒绝");
  });
});
