// 测试用的假 MCP 服务（27 号票）：MCP 的 stdio 传输，每行一个 JSON-RPC 2.0 消息，只实现 initialize、tools/list、tools/call。
// 不连任何真的服务。环境变量：
// - FAKE_MCP_LOG：记录文件（JSONL），起来时记一行 { started: { pid, ppid, token } }，每次调用记一行 { call, args }；
// - FAKE_MCP_TOKEN：守护进程按登记注入的"凭据"（测试看它到没到服务进程、有没有漏给 agent）。
// 工具：echo（原样回一句话）、env_token（把凭据原样写进 stderr 和结果：测试看守护进程擦没擦掉）、send_note（"发一条笔记"：只记下来）、
// wait（等 ms 毫秒再回）、status（只读的状态）；240 号票加上"旅行相册"那三个带参的（person.rename、filter.set、slideshow.start：
// 秘书带参调 MCP 那个真实场景，参数到了服务进程、结果回到秘书手边）。
import fs from "node:fs";

const log = (entry) => {
  if (process.env.FAKE_MCP_LOG) fs.appendFileSync(process.env.FAKE_MCP_LOG, `${JSON.stringify(entry)}\n`);
};
log({ started: { pid: process.pid, ppid: process.ppid, token: process.env.FAKE_MCP_TOKEN ?? null } });

const TOOLS = [
  { name: "echo", description: "原样回一句话（FAKE_ECHO_DESCRIPTION）", inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } },
  { name: "env_token", description: "报凭据在不在", inputSchema: { type: "object", properties: {} } },
  { name: "send_note", description: "发一条笔记给某人", inputSchema: { type: "object", properties: { to: { type: "string" }, text: { type: "string" } }, required: ["to", "text"] } },
  { name: "wait", description: "等一会儿再回", inputSchema: { type: "object", properties: { ms: { type: "number" } } } },
  { name: "status", description: "看看状态（只读）", inputSchema: { type: "object", properties: {} } },
  { name: "person.rename", description: "把相册里的一个人改个名字", inputSchema: { type: "object", properties: { id: { type: "string" }, name: { type: "string" } }, required: ["id", "name"] } },
  { name: "filter.set", description: "按人筛选相册", inputSchema: { type: "object", properties: { personId: { type: "string" } }, required: ["personId"] } },
  { name: "slideshow.start", description: "开始放映", inputSchema: { type: "object", properties: { intervalMs: { type: "number" } } } },
];

const reply = (id, result) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
const text = (t, isError = false) => ({ content: [{ type: "text", text: t }], ...(isError ? { isError: true } : {}) });

async function call(name, args) {
  log({ call: name, args });
  switch (name) {
    case "echo":
      return text(`echo: ${args.text}`);
    case "env_token":
      process.stderr.write(`env_token 被调用了，token=${process.env.FAKE_MCP_TOKEN ?? "none"}\n`);
      return text(`token=${process.env.FAKE_MCP_TOKEN ?? "none"}`);
    case "send_note":
      return text(`已发给 ${args.to}`);
    case "wait":
      await new Promise((r) => setTimeout(r, Number(args.ms ?? 1000)));
      return text("等好了");
    case "status":
      return text("一切正常（假 MCP 的状态）");
    case "person.rename":
      // 真实的 MCP 服务会自己校验必填参数、报错：240 号票把这句原样带回秘书（二狗不替服务端校验）
      return args?.name === undefined ? text("改名字要写 name", true) : text(`已把 ${args.id} 改名成 ${args.name}`);
    case "filter.set":
      return text(`筛选到 ${args.personId}`);
    case "slideshow.start":
      return text(`开始放映，每张 ${args.intervalMs ?? "默认"} 毫秒`);
    default:
      return text(`没有这个工具：${name}`, true);
  }
}

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  for (let at = buffer.indexOf("\n"); at >= 0; at = buffer.indexOf("\n")) {
    const line = buffer.slice(0, at).trim();
    buffer = buffer.slice(at + 1);
    if (!line) continue;
    const message = JSON.parse(line);
    if (message.id === undefined) continue;
    if (message.method === "initialize") reply(message.id, { protocolVersion: message.params?.protocolVersion ?? "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "fake-mcp", version: "1" } });
    else if (message.method === "tools/list") reply(message.id, { tools: TOOLS });
    else if (message.method === "tools/call") void call(message.params.name, message.params.arguments ?? {}).then((result) => reply(message.id, result));
    else process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "没有这个方法" } })}\n`);
  }
});
process.stdin.on("end", () => process.exit(0));
