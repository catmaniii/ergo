// 公网入口的 nginx 站点配置（规格第 6 节）：二狗生成，逐项断言——支持 WebSocket、放大 client_max_body_size、
// 加长 proxy_read_timeout、每个 location 都覆盖写 X-Forwarded-For 和 X-Real-IP、带 HSTS，上游指向 VPS 上
// 只绑本机地址的隧道端口，域名按 ergou.<VPS>.sslip.io。
import { describe, expect, it } from "vitest";
import { nginxSiteConfig } from "../../src/deploy/nginx.ts";
import { type PublicAccess, publicAccessDefaults } from "../../src/deploy/public-access.ts";

/** 解析出来的 nginx 配置：指令（名字和参数），块（名字、参数和里面的指令） */
interface Directive {
  name: string;
  args: string[];
  children?: Directive[];
}

/** 很小的 nginx 配置解析器：够用来断言结构（引号、注释、块） */
function parseNginx(text: string): Directive[] {
  const tokens: string[] = [];
  const re = /#[^\n]*|"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|[{};]|[^\s{};]+/g;
  for (const m of text.matchAll(re)) if (!m[0].startsWith("#")) tokens.push(m[0]);
  let i = 0;
  const block = (): Directive[] => {
    const out: Directive[] = [];
    while (i < tokens.length && tokens[i] !== "}") {
      const words: string[] = [];
      while (tokens[i] !== ";" && tokens[i] !== "{") {
        if (i >= tokens.length) throw new Error("配置没写完");
        words.push(tokens[i++]!.replace(/^"(.*)"$/, "$1"));
      }
      const [name = "", ...args] = words;
      if (tokens[i++] === "{") {
        out.push({ name, args, children: block() });
        if (tokens[i++] !== "}") throw new Error("块没闭合");
      } else out.push({ name, args });
    }
    return out;
  };
  const top = block();
  if (i !== tokens.length) throw new Error("多出来的 }");
  return top;
}

const all = (ds: Directive[], name: string) => ds.filter((d) => d.name === name);
const one = (ds: Directive[], name: string) => {
  const found = all(ds, name);
  expect(found, `${name} 应该正好一条`).toHaveLength(1);
  return found[0]!;
};
const headers = (ds: Directive[]) => Object.fromEntries(all(ds, "proxy_set_header").map((d) => [d.args[0]!.toLowerCase(), d.args.slice(1).join(" ")]));

/** nginx 的大小写法（256m、1g）换成字节 */
function bytes(size: string): number {
  const m = /^(\d+)([kmg]?)$/i.exec(size);
  if (!m) throw new Error(`看不懂的大小：${size}`);
  return Number(m[1]) * { "": 1, k: 1024, m: 1024 ** 2, g: 1024 ** 3 }[m[2]!.toLowerCase() as "" | "k" | "m" | "g"];
}

/** nginx 的时间写法（3600s、1h、60m）换成秒 */
function seconds(time: string): number {
  const m = /^(\d+)(ms|s|m|h|d)?$/.exec(time);
  if (!m) throw new Error(`看不懂的时间：${time}`);
  return Number(m[1]) * { ms: 0.001, s: 1, m: 60, h: 3600, d: 86400 }[(m[2] ?? "s") as "s"];
}

const ACCESS: PublicAccess = publicAccessDefaults({ vpsHost: "203.0.113.10", sshUser: "root", sshKey: "C:\\keys\\vps.pem" });

function generated(access: PublicAccess = ACCESS) {
  const text = nginxSiteConfig(access);
  const top = parseNginx(text);
  const server = one(top, "server");
  const locations = all(server.children!, "location");
  return { text, top, server, body: server.children!, locations };
}

describe("nginx 站点配置", () => {
  it("域名按 ergou.<VPS>.sslip.io，证书沿用 VPS 上 Let's Encrypt 的现有路径", () => {
    const { body } = generated();
    expect(one(body, "server_name").args).toEqual(["ergou.203.0.113.10.sslip.io"]);
    // 默认站在本机前门（按 SNI 分流）后面：只听本机地址
    expect(one(body, "listen").args).toEqual(["127.0.0.1:8443", "ssl"]);
    expect(one(body, "ssl_certificate").args).toEqual(["/etc/letsencrypt/live/ergou.203.0.113.10.sslip.io/fullchain.pem"]);
    expect(one(body, "ssl_certificate_key").args).toEqual(["/etc/letsencrypt/live/ergou.203.0.113.10.sslip.io/privkey.pem"]);
  });

  it("上游指向 VPS 上只绑本机地址的隧道端口（每个 location 都是）", () => {
    const { locations } = generated();
    expect(locations.length).toBeGreaterThanOrEqual(2);
    for (const loc of locations) expect(one(loc.children!, "proxy_pass").args).toEqual(["http://127.0.0.1:18811"]);
  });

  it("每个 location 都覆盖写 X-Forwarded-For 和 X-Real-IP（不是追加：客户端带来的前缀不算数），也传 Host", () => {
    const { locations, text } = generated();
    for (const loc of locations) {
      const h = headers(loc.children!);
      expect(h["x-real-ip"], `location ${loc.args.join(" ")}`).toBe("$remote_addr");
      expect(h["x-forwarded-for"], `location ${loc.args.join(" ")}`).toBe("$remote_addr");
      expect(h.host).toBe("$host");
      expect(h["x-forwarded-proto"]).toBe("$scheme");
    }
    expect(text).not.toContain("$proxy_add_x_forwarded_for");
  });

  it("支持 WebSocket：/ws 升级连接（HTTP/1.1、Upgrade、Connection）", () => {
    const { top, locations } = generated();
    const map = one(top, "map");
    expect(map.args[0]).toBe("$http_upgrade");
    const variable = map.args[1]!;
    expect(Object.fromEntries(map.children!.map((d) => [d.name, d.args[0]]))).toEqual({ default: "upgrade", "''": "close" });
    const ws = locations.find((l) => l.args.join(" ") === "/ws")!;
    expect(ws).toBeDefined();
    expect(one(ws.children!, "proxy_http_version").args).toEqual(["1.1"]);
    const h = headers(ws.children!);
    expect(h.upgrade).toBe("$http_upgrade");
    expect(h.connection).toBe(variable);
  });

  it("放大了 client_max_body_size（够单个 200 MB 的文件），加长了 proxy_read_timeout（远长于默认的 60 秒）", () => {
    const { body, locations } = generated();
    expect(bytes(one(body, "client_max_body_size").args[0]!)).toBeGreaterThanOrEqual(200 * 1024 ** 2);
    expect(seconds(one(body, "proxy_read_timeout").args[0]!)).toBeGreaterThanOrEqual(3600);
    expect(seconds(one(body, "proxy_send_timeout").args[0]!)).toBeGreaterThanOrEqual(3600);
    // location 里没有改小它们
    for (const loc of locations) {
      for (const d of all(loc.children!, "proxy_read_timeout")) expect(seconds(d.args[0]!)).toBeGreaterThanOrEqual(3600);
      expect(all(loc.children!, "client_max_body_size")).toEqual([]);
    }
  });

  it("带 HSTS（一年，always）；location 里没有自己的 add_header（否则会把 server 里的 HSTS 顶掉）", () => {
    const { body, locations } = generated();
    const hsts = all(body, "add_header").find((d) => d.args[0] === "Strict-Transport-Security")!;
    expect(hsts).toBeDefined();
    expect(Number(/max-age=(\d+)/.exec(hsts.args[1]!)?.[1])).toBeGreaterThanOrEqual(365 * 24 * 3600);
    expect(hsts.args).toContain("always");
    for (const loc of locations) expect(all(loc.children!, "add_header")).toEqual([]);
  });

  it("配置里的值都能改：自定义域名、监听写法（比如前门开了 proxy_protocol）、证书目录、客户端地址的来源、隧道端口", () => {
    const { body, locations } = generated(
      publicAccessDefaults({
        vpsHost: "203.0.113.10",
        sshUser: "admin",
        sshKey: "C:\\keys\\vps.pem",
        domain: "ergou.example.org",
        tunnelPort: 19000,
        nginx: { listen: "127.0.0.1:8443 ssl proxy_protocol", certificateDir: "/etc/letsencrypt/live/203.0.113.10.sslip.io", clientAddress: "$proxy_protocol_addr" },
      }),
    );
    expect(one(body, "server_name").args).toEqual(["ergou.example.org"]);
    expect(one(body, "listen").args).toEqual(["127.0.0.1:8443", "ssl", "proxy_protocol"]);
    for (const loc of locations) expect(headers(loc.children!)).toMatchObject({ "x-real-ip": "$proxy_protocol_addr", "x-forwarded-for": "$proxy_protocol_addr" });
    expect(one(body, "ssl_certificate").args).toEqual(["/etc/letsencrypt/live/203.0.113.10.sslip.io/fullchain.pem"]);
    for (const loc of locations) expect(one(loc.children!, "proxy_pass").args).toEqual(["http://127.0.0.1:19000"]);
  });
});
