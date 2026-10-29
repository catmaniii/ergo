// 用 Node 22 内置的 WebSocket 客户端连管理器，验证实时推送（接入层的 Node 客户端也将零依赖）
const ws = new WebSocket('ws://127.0.0.1:7420/ws');
ws.onopen = () => console.log('WS 已连接');
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  console.log('收到推送:', m.type, '| 服务数=', m.services?.length, '| 待摘任务=', m.sentinel?.duplicateTasks?.length);
  process.exit(0);
};
ws.onerror = () => { console.log('WS 错误'); process.exit(1); };
setTimeout(() => { console.log('超时：没收到推送'); process.exit(1); }, 8000);
