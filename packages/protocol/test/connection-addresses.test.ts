// 共享协议包：连接地址（364 号票）——手机 App 认不认、手填的能不能存、怎么排序。
import { describe, expect, test } from "vitest";
import { type ConnectionAddress, checkAppAddress, checkManualConnectionAddress, isLanHost, orderConnectionAddresses } from "../src/connection-addresses.ts";

const problem = (check: ReturnType<typeof checkAppAddress>) => (check.ok ? undefined : check.problem);

describe("App 认不认这个地址（和两个 App 的 checkServerAddress 同一条规矩；三边核对在 frontend/test/connect.test.ts）", () => {
  test("https 通过，没写 scheme 的按 https 补；# 后面的去掉", () => {
    expect(checkAppAddress("https://ergo.example.com/")).toEqual({ ok: true, url: "https://ergo.example.com/" });
    expect(checkAppAddress(" ergo.example.com ")).toEqual({ ok: true, url: "https://ergo.example.com/" });
    expect(checkAppAddress("https://ergo.example.com/#/inbox")).toEqual({ ok: true, url: "https://ergo.example.com/" });
  });

  test("http 只有本机调试的两个主机能用", () => {
    expect(checkAppAddress("http://127.0.0.1:8811").ok).toBe(true);
    expect(checkAppAddress("http://localhost:8811").ok).toBe(true);
    expect(problem(checkAppAddress("http://ergo.example.com"))).toBe("httpsOnly");
    expect(problem(checkAppAddress("http://192.168.1.2:8811"))).toBe("httpsOnly");
  });

  test("写法不对、带用户名密码、别的协议、空的都不行", () => {
    expect(problem(checkAppAddress(""))).toBe("empty");
    expect(problem(checkAppAddress("   "))).toBe("empty");
    expect(problem(checkAppAddress("ftp://ergo.example.com"))).toBe("malformed");
    expect(problem(checkAppAddress("WIFI:S:home;T:WPA;P:secret;;"))).toBe("malformed");
    expect(problem(checkAppAddress("https://user:pw@ergo.example.com"))).toBe("credentials");
    expect(problem(checkAppAddress(`https://${"a".repeat(600)}.example.com`))).toBe("tooLong");
  });
});

describe("手填的地址：不做局域网", () => {
  test("局域网、本机的地址不收，能从外面开的收", () => {
    expect(checkManualConnectionAddress("https://frp.example.com:8443/").ok).toBe(true);
    const lan = ["https://192.168.1.5/", "https://10.0.0.8:8811/", "https://172.20.1.1/", "https://169.254.1.1/", "https://nas/", "https://nas.local/", "https://[fd00::1]/", "http://127.0.0.1:8811", "https://localhost/"];
    expect(lan.filter((bad) => problem(checkManualConnectionAddress(bad)) !== "lan")).toEqual([]);
    expect(problem(checkManualConnectionAddress("http://frp.example.com/"))).toBe("httpsOnly");
  });

  test("tailnet 的 100.64.0.0/10 不算局域网（它是另一条路），公网 IP 也不算", () => {
    expect(isLanHost("100.101.102.103")).toBe(false);
    expect(isLanHost("203.0.113.9")).toBe(false);
    expect(isLanHost("ergo.tail1234.ts.net")).toBe(false);
    expect(isLanHost("172.32.0.1")).toBe(false);
  });
});

describe("排序", () => {
  const a = (kind: ConnectionAddress["kind"], url: string, reachable: boolean | null): ConnectionAddress => ({ kind, url, reachable });

  test("都打通了：公网 → tailnet；手填的（没测过）排在后面", () => {
    const list = orderConnectionAddresses([a("manual", "https://m/", null), a("tailnet", "https://t/", true), a("public", "https://p/", true)]);
    expect(list.map((x) => x.kind)).toEqual(["public", "tailnet", "manual"]);
  });

  test("打通过的排前面：公网打不通、tailnet 打通了，tailnet 在前；打不通的仍然列出", () => {
    const list = orderConnectionAddresses([a("public", "https://p/", false), a("tailnet", "https://t/", true)]);
    expect(list.map((x) => x.kind)).toEqual(["tailnet", "public"]);
  });

  test("没测过的排在打不通的前面；同一档按 公网 → tailnet → 手填", () => {
    const list = orderConnectionAddresses([a("public", "https://p/", false), a("manual", "https://m/", null), a("tailnet", "https://t/", null)]);
    expect(list.map((x) => x.kind)).toEqual(["tailnet", "manual", "public"]);
  });

  test("同一个地址只留一条：手填的和服务管家给的重了，留靠前的", () => {
    const list = orderConnectionAddresses([a("manual", "https://p/", null), a("public", "https://p/", true)]);
    expect(list).toEqual([a("public", "https://p/", true)]);
  });
});
