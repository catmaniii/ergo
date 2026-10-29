/**
 * 接入层的最小示范服务（也是它的端到端测试）。
 * 它演示的三件事，正是一个项目接入后能拿到的东西：
 *   1. linked 档探活——连接在 = 服务真的活着
 *   2. busy 自报——「正在跑任务，重启会中断」
 *   3. 优雅停机——领域知识写在服务自己的进程里，管理器只负责在正确的时机喊一声
 *
 * 跑法：lsm start link-demo
 * 观察：lsm status 会看到 tier=linked；curl /busy/on 之后卡片变黄并显示忙碌原因
 */
import http from 'node:http';
import { link } from '../clients/lsm-link.mjs';

const PORT = Number(process.env.DEMO_PORT || 7999);
let busy = false;
let drained = false;

const server = http.createServer((req, res) => {
  if (req.url === '/busy/on') { busy = true; lsm.notifyBusy(); }
  if (req.url === '/busy/off') { busy = false; lsm.notifyBusy(); }
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ ok: true, busy, drained, pid: process.pid }));
});

const lsm = link({
  port: PORT,
  version: '1.0.0',
  logs: [],
  busy: () => (busy ? { busy: true, reason: '示范任务进行中' } : { busy: false }),
  health: () => 'ok',
  // 这里就是「领域知识该待的地方」：比如等 TTS 空闲、落盘当前进度，写在这里而不是外部脚本
  onShutdown: async () => {
    console.log('[demo] 收到停机指令，开始收尾…');
    await new Promise((r) => setTimeout(r, 800));
    drained = true;
    console.log('[demo] 收尾完成，退出');
  },
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[demo] listening on 127.0.0.1:${PORT}  接入层=${lsm.enabled ? '已启用' : '未启用（没有 LSM_* 身份，照常独立运行）'}`);
});
