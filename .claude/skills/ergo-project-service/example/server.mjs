import http from "node:http";

const port = Number(process.env.PORT);
let count = 0;

const json = (res, status, body) => {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
};

// 报事件：两个变量由二狗注入，每次现取；本机单独跑时没有，就不报。二狗停着时连不上，服务不能跟着崩
async function notify(event, data) {
  const { ERGO_NOTIFY_URL: url, ERGO_SERVICE_TOKEN: token } = process.env;
  if (!url || !token) return;
  try {
    const res = await fetch(url, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ event, data }) });
    if (!res.ok) console.error(`事件被拒：${res.status} ${await res.text()}`);
  } catch (err) {
    console.error(`事件没报上：${err.message}`);
  }
}

// 页面只用相对地址：浏览器眼里它在 /apps/<应用名>/ 下面
const PAGE = `<!doctype html><meta charset="utf-8"><title>计数器</title>
<button id="add">加一</button> <span id="n"></span>
<script>
const show = (v) => { n.textContent = v.count; };
fetch("api/count").then((r) => r.json()).then(show);
add.onclick = () => fetch("api/count", { method: "POST" }).then((r) => r.json()).then(show);
</script>`;

http.createServer((req, res) => {
  const path = req.url.split("?")[0];
  if (path === "/health") return json(res, 200, { ok: true });
  if (path === "/") { res.writeHead(200, { "content-type": "text/html; charset=utf-8" }); return res.end(PAGE); }
  if (path === "/api/count") {
    if (req.method === "POST" && ++count % 100 === 0) void notify("计数满百", { count });
    return json(res, 200, { count });
  }
  if (path === "/ops" && req.method === "POST") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      let call;
      try {
        call = JSON.parse(body);
      } catch {
        return json(res, 400, { say: "请求体不是 JSON", isError: true });
      }
      const { name, arguments: args = {}, _meta } = call ?? {};
      if (name === "get_count") return json(res, 200, { say: `现在是 ${count}`, detail: { count } });
      if (name === "add_count") {
        if (!_meta?.["ergo/test"]) count += args.by ?? 1;
        return json(res, 200, { say: `加好了，现在是 ${count}` });
      }
      json(res, 404, { say: `没有 ${name} 这个操作`, isError: true });
    });
    return;
  }
  json(res, 404, { error: "没有这个地址" });
}).listen(port, "127.0.0.1");
