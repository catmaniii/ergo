import './_isolate.mjs';   // 必须是第一个 import：先把数据目录换成临时目录
import test from 'node:test';
import assert from 'node:assert';
import { findServiceTreeTop } from '../src/winproc.mjs';

// 实测链条（2026-08-23 接管一个项目时抓到的真实进程树，路径和名字换成了示例）：
//   node(监听 8787) ← node(tsx) ← cmd /c "tsx src/bin/hub.ts" ← node(npm shim) ← powershell(ps1 重启循环) ← svchost
// 中间 cmd 与 npm shim 的命令行里没有项目路径——不能一遇到无关就停。
const T = '2026-08-23T10:00:00.000+08:00';
const chain = new Map([
  [27356, { pid: 27356, ppid: 26516, name: 'node.exe', start: T, cmd: 'node.exe --require C:\\dev\\my_app\\node_modules\\.pnpm\\tsx' }],
  [26516, { pid: 26516, ppid: 18640, name: 'node.exe', start: T, cmd: 'node "C:\\dev\\my_app\\node_modules\\.bin\\..\\tsx\\dist\\cli.mjs" "src/bin/hub.ts"' }],
  [18640, { pid: 18640, ppid: 9424, name: 'cmd.exe', start: T, cmd: 'C:\\WINDOWS\\system32\\cmd.exe /q /d /s /c "tsx src/bin/hub.ts"' }],
  [9424, { pid: 9424, ppid: 9048, name: 'node.exe', start: T, cmd: '"C:\\Users\\x\\nodejs\\current\\node.exe" C:\\Users\\x\\nodejs\\current/npm-cli.js' }],
  [9048, { pid: 9048, ppid: 2188, name: 'powershell.exe', start: T, cmd: '"powershell.exe" -NoProfile -WindowStyle Hidden -File "C:\\dev\\my_app\\scripts\\hub-loop.ps1"' }],
  [2188, { pid: 2188, ppid: 1680, name: 'svchost.exe', start: T, cmd: '' }],
]);

test('树顶：跨过 cmd/npm 这些中间环节，认到自带重启循环的 ps1', () => {
  assert.equal(findServiceTreeTop(27356, chain, ['C:\\dev\\my_app', 'hub-loop.ps1']), 9048);
});

test('树顶：绝不越过 svchost 这类系统宿主', () => {
  // 即使把 svchost 的命令行伪造成相关，它也在边界名单里，必须停下
  const evil = new Map(chain);
  evil.set(2188, { ...chain.get(2188), cmd: 'C:\\dev\\my_app fake' });
  assert.equal(findServiceTreeTop(27356, evil, ['C:\\dev\\my_app']), 9048);
});

test('树顶：没有相关祖先时就是它自己', () => {
  const lone = new Map([[100, { pid: 100, ppid: 2188, name: 'node.exe', start: T, cmd: 'node server.js' }], [2188, chain.get(2188)]]);
  assert.equal(findServiceTreeTop(100, lone, ['C:\\dev\\my_app']), 100);
});

test('树顶：父进程比子进程还晚启动 = PID 被复用了，立刻停（不然会杀错人）', () => {
  const reused = new Map([
    [200, { pid: 200, ppid: 300, name: 'node.exe', start: '2026-08-23T10:00:00.000+08:00', cmd: 'C:\\dev\\my_app\\a.js' }],
    [300, { pid: 300, ppid: 400, name: 'powershell.exe', start: '2026-08-23T11:00:00.000+08:00', cmd: 'C:\\dev\\my_app\\b.ps1' }],
  ]);
  assert.equal(findServiceTreeTop(200, reused, ['C:\\dev\\my_app']), 200);
});

test('树顶：环状父子关系不会把它卡死', () => {
  const cyc = new Map([
    [1, { pid: 1, ppid: 2, name: 'a.exe', start: T, cmd: 'x my_app' }],
    [2, { pid: 2, ppid: 1, name: 'b.exe', start: T, cmd: 'y my_app' }],
  ]);
  assert.equal(findServiceTreeTop(1, cyc, ['my_app']), 2);
});

test('树顶：绝不认到管理器自己头上——服务的 root 恰好是管理器路径的前缀时也一样', () => {
  // 管理器直接 spawn 的服务：node(监听) ← cmd 包装层 ← node lsm.mjs serve ← conhost --headless ← svchost
  // root 写成 C:\dev 时，管理器和 conhost 的命令行里都有它；不设边界的话树顶会一路认到 conhost，
  // taskkill /T 就把管理器和它起的每一个服务一起带走了（名下服务的 root 由接入的项目给）。
  const mgr = new Map([
    [500, { pid: 500, ppid: 400, name: 'node.exe', start: T, cmd: 'node C:\\dev\\w\\server.mjs' }],
    [400, { pid: 400, ppid: 300, name: 'cmd.exe', start: T, cmd: 'cmd.exe /d /s /c ""node" "server.mjs" >> "C:\\dev\\lsm\\logs\\o--w.out.log" 2>&1"' }],
    [300, { pid: 300, ppid: 200, name: 'node.exe', start: T, cmd: 'node C:\\dev\\lsm\\bin\\lsm.mjs serve --lifeline' }],
    [200, { pid: 200, ppid: 2188, name: 'conhost.exe', start: T, cmd: 'conhost.exe --headless node C:\\dev\\lsm\\bin\\lsm.mjs serve' }],
    [2188, chain.get(2188)],
  ]);
  assert.equal(findServiceTreeTop(500, mgr, ['C:\\dev', 'server.mjs']), 200, '不设边界就会认到 conhost（这条是在证明坑真实存在）');
  assert.equal(findServiceTreeTop(500, mgr, ['C:\\dev', 'server.mjs'], { stopAt: [300, 200] }), 400, '停在管理器下面：只杀 cmd 包装层和服务');
});
