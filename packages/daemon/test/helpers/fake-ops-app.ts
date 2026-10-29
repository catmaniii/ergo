// 测试里的"使用中的项目的服务"（260 号票；268 号票改成回能念的 say）：起在随机端口上的一个小 HTTP 服务，扮演一个记账本项目跑在这台电脑上的
// 服务——首页给 LSM 的健康检查、前缀下自检看，本机调用口（默认 POST /ops）收二狗代秘书调的操作。调用口的约定照 ops.json 模板里写的：
// 请求体是 MCP tools/call 的 params（{ name, arguments }，验收的测试调用另带 _meta: { "ergo/test": true }），
// 回 { say, detail }（能念的那句和附件）或 MCP 的 CallToolResult（say 在 structuredContent.say），也可以回别的 JSON、纯文本。
// 认得的操作：
// - add_expense（有副作用的动作）：amount 是数字时记一笔、回"记好了：<备注> <金额> 元"；带测试标记的不记、回"测试：会记一笔……"；
//   缺 amount 回 400 + isError（服务端自己报参数错）；
// - list_expenses（只读查询）：回最近记的几笔和合计；
// - legacy_list（只读，旧写法）：回一段普通的 JSON，不带 say（二狗按结果补一句）；
// - leaky_query（自称只读）：往 writeDir 里写一个文件再回（验收"只读的真不写"不过）；
// - jammed：回 200 但 isError（服务端说做不了，say 说原因）；
// - slow：一直不回（测等不到）；
// - 别的：404 "没有这个操作"。
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { onTestFinished } from "vitest";

export interface FakeOpsCall {
  method: string;
  url: string;
  headers: http.IncomingHttpHeaders;
  body: string;
}

export interface FakeOpsApp {
  readonly url: string;
  readonly port: number;
  /** 收到的请求（首页的也在里面），按先后 */
  readonly seen: FakeOpsCall[];
  /** 调用口收到的调用（解析过的请求体），按先后 */
  calls(): Array<{ name?: unknown; arguments?: unknown; _meta?: Record<string, unknown> }>;
  /** 真记下的支出（带测试标记的不算） */
  expenses(): Array<{ amount: number; note: string; category: string }>;
  close(): Promise<void>;
}

export const FAKE_OPS_HOME = '<!doctype html>\n<html><head><meta charset="utf-8"><title>记账本</title></head><body><h1>记账本</h1></body></html>';

const json = (res: http.ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
};

export async function startFakeOpsApp(options: { path?: string; writeDir?: string } = {}): Promise<FakeOpsApp> {
  const opsPath = options.path ?? "/ops";
  const seen: FakeOpsCall[] = [];
  const expenses: Array<{ amount: number; note: string; category: string }> = [];
  const hanging = new Set<http.ServerResponse>();
  let leaks = 0;
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const record: FakeOpsCall = { method: req.method ?? "", url: req.url ?? "", headers: req.headers, body: Buffer.concat(chunks).toString("utf8") };
      seen.push(record);
      if (req.method === "GET" && (req.url === "/" || req.url === "")) {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        return void res.end(FAKE_OPS_HOME);
      }
      if (req.method !== "POST" || req.url !== opsPath) {
        res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
        return void res.end("没有这个地址");
      }
      let body: { name?: unknown; arguments?: Record<string, unknown>; _meta?: Record<string, unknown> };
      try {
        body = JSON.parse(record.body) as typeof body;
      } catch {
        res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
        return void res.end("请求体不是 JSON");
      }
      const args = body.arguments ?? {};
      const test = body["_meta"]?.["ergo/test"] === true;
      switch (body.name) {
        case "add_expense": {
          if (typeof args.amount !== "number") return json(res, 400, { say: "没记上：金额要写数字", isError: true });
          const item = { amount: args.amount, note: typeof args.note === "string" && args.note ? args.note : "支出", category: typeof args.category === "string" ? args.category : "other" };
          if (test) return json(res, 200, { say: `测试：会记一笔${item.note} ${item.amount} 元`, detail: item });
          expenses.push(item);
          return json(res, 200, { say: `记好了：${item.note} ${item.amount} 元`, detail: { id: expenses.length, ...item } });
        }
        case "list_expenses": {
          const total = expenses.reduce((s, e) => s + e.amount, 0);
          return json(res, 200, { say: `最近记了 ${expenses.length} 笔，合计 ${total} 元`, detail: { items: expenses, total } });
        }
        case "legacy_list":
          return json(res, 200, { items: [{ note: "午饭", amount: 32 }], total: 32 });
        case "leaky_query": {
          if (options.writeDir) fs.writeFileSync(path.join(options.writeDir, `leak-${++leaks}.txt`), "写了东西");
          return json(res, 200, { say: "查好了" });
        }
        case "jammed":
          return json(res, 200, { content: [{ type: "text", text: "账本文件被别的程序锁着" }], structuredContent: { say: "账本被锁着，稍后再试" }, isError: true });
        case "slow":
          hanging.add(res);
          return;
        default:
          res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
          return void res.end(`没有这个操作：${String(body.name)}`);
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    for (const res of hanging) res.destroy();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  };
  onTestFinished(close);
  return {
    url: `http://127.0.0.1:${port}`,
    port,
    seen,
    calls: () => seen.filter((r) => r.method === "POST" && r.url === opsPath).map((r) => JSON.parse(r.body) as { name?: unknown; arguments?: unknown; _meta?: Record<string, unknown> }),
    expenses: () => [...expenses],
    close,
  };
}

/** 记账本的运营接口清单（ops.json，268 号票的写法）：一个有副作用的动作、一个只读查询；调用口在服务 ledger 的 /ops */
export const LEDGER_OPS = {
  endpoint: { service: "ledger", path: "/ops" },
  tools: [
    {
      name: "add_expense",
      title: "记一笔支出",
      description: "记一笔支出：金额（元）、分类和备注。用户要记账时用。",
      userSays: ["记一笔午饭 32 块", "刚打车花了 25"],
      kind: "action",
      inputSchema: {
        type: "object",
        properties: {
          amount: { type: "number", description: "金额（元）" },
          category: { type: "string", enum: ["food", "transport", "other"], enumNames: ["吃饭", "交通", "其他"], default: "other", description: "分类" },
          note: { type: "string", default: "", description: "备注" },
        },
        required: ["amount"],
      },
      returns: "say 说记好了什么；detail 是这笔记录。",
      risk: "direct",
      test: { args: { amount: 1, note: "验收" }, sayIncludes: "测试" },
    },
    {
      name: "list_expenses",
      title: "查支出",
      description: "查最近记的支出和合计。用户问花了多少时用。",
      userSays: ["最近花了多少"],
      kind: "query",
      inputSchema: { type: "object", properties: {} },
      test: { args: {} },
    },
  ],
};
