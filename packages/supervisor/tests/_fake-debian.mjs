// 测试用的"假 Debian"（321 号票）：在一个临时目录里搭出 VPS 的根目录（/etc、/var 落在里面），
// 系统命令（apt-get、systemctl、nginx、certbot、ufw……）换成 _fake-debian.sh 里的假货，
// 然后用 Git Bash 把生成的 VPS 脚本**真的跑一遍**——幂等、断了接着做、nginx -t 不过撤回、remove 原样撤，都在这里验。
// 绝不用 WSL 的 bash（C:\Windows\System32\bash.exe）：那是用户自己在用的 WSL，不能碰。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

// 系统自带的命令；nginx、certbot、ufw、headscale、curl 是装了对应的包才出现（_fake-debian.sh 的 pkg_bin）
const COMMANDS = ['dpkg-query', 'dpkg', 'apt-get', 'apt-config', 'systemctl', 'openssl', 'getent', 'id', 'useradd', 'userdel',
  'pkill', 'chown', 'journalctl', 'usermod', 'ss', 'sshd', 'ssh'];
export const PACKAGE_COMMANDS = ['nginx', 'certbot', 'ufw', 'headscale', 'curl'];

/** Git Bash 在哪（找不到就是 null，测试跳过）。只认 Git for Windows 的，不认 System32 下的 WSL。 */
export function gitBash() {
  if (process.platform !== 'win32') return fs.existsSync('/bin/bash') ? '/bin/bash' : null;
  const bases = [process.env.ProgramFiles, process.env['ProgramFiles(x86)'], 'C:\\Program Files'].filter(Boolean);
  for (const b of bases) {
    const p = path.join(b, 'Git', 'bin', 'bash.exe');
    if (fs.existsSync(p)) return p;
  }
  return null;
}

/** 一个假命令：_fake-debian.sh 整份抄进去、开头把命令名塞回参数里（一次调用只起一个 bash，Windows 上起进程很慢） */
const FAKE_SRC = fs.readFileSync(new URL('./_fake-debian.sh', import.meta.url), 'utf-8').replace(/\r\n/g, '\n');
const stub = (name) => `#!/usr/bin/env bash\nset -- ${name} "$@"\n${FAKE_SRC}`;

/** C:\a\b → /c/a/b（Git Bash 认的写法） */
export const toMsys = (p) => (process.platform === 'win32'
  ? p.replace(/^([A-Za-z]):[\\/]/, (_, d) => `/${d.toLowerCase()}/`).replace(/\\/g, '/')
  : p);

export function fakeDebian({ ip = '203.0.113.10' } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lsm-fakedeb-'));
  const root = path.join(dir, 'root');
  const fake = path.join(dir, 'fake');
  const bin = path.join(dir, 'bin');
  for (const d of [root, fake, bin, path.join(root, 'etc'), path.join(root, 'root', '.ssh')]) fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(root, 'etc', 'os-release'), 'PRETTY_NAME="Debian GNU/Linux 12 (bookworm)"\nNAME="Debian GNU/Linux"\nVERSION_ID="12"\nID=debian\n');
  fs.writeFileSync(path.join(fake, '_fake'), FAKE_SRC);
  for (const c of COMMANDS) fs.writeFileSync(path.join(bin, c), stub(c));
  const bash = gitBash();
  let callsSeen = 0;
  const p = (rel) => path.join(root, ...rel.split('/').filter(Boolean));
  return {
    dir, root, fake,
    /** 跑一份脚本，返回退出码、输出和这次的系统命令调用（异步：几条用例可以一起跑） */
    async run(script, extraEnv = {}) {
      const file = path.join(dir, `script-${Date.now()}-${Math.random().toString(16).slice(2)}.sh`);
      fs.writeFileSync(file, script);
      const env = { ...process.env, ERGO_TEST_ROOT: toMsys(root), FAKE: toMsys(fake), FAKE_BIN: toMsys(bin), FAKE_IP: ip, SCRIPT: toMsys(file), ...extraEnv };
      delete env.SSH_CONNECTION;
      const r = await new Promise((resolve) => {
        const child = spawn(bash, ['-c', 'export PATH="$FAKE_BIN:$PATH"; exec bash "$SCRIPT"'], { env, windowsHide: true });
        let stdout = '', stderr = '';
        child.stdout.on('data', (d) => { stdout += d; });
        child.stderr.on('data', (d) => { stderr += d; });
        const timer = setTimeout(() => child.kill(), 120000);
        child.on('close', (status) => { clearTimeout(timer); resolve({ status, stdout, stderr }); });
      });
      const all = this.calls();
      const calls = all.slice(callsSeen);
      callsSeen = all.length;
      return { code: r.status, out: r.stdout || '', err: r.stderr || '', calls };
    },
    calls() {
      try { return fs.readFileSync(path.join(fake, 'calls.log'), 'utf-8').split('\n').filter(Boolean); } catch { return []; }
    },
    path: p,
    exists: (rel) => fs.existsSync(p(rel)),
    read: (rel) => fs.readFileSync(p(rel), 'utf-8'),
    write: (rel, body) => { fs.mkdirSync(path.dirname(p(rel)), { recursive: true }); fs.writeFileSync(p(rel), body); },
    installed: (pkg) => fs.existsSync(path.join(fake, 'pkg', pkg)),
    active: (unit) => fs.existsSync(path.join(fake, 'svc', `${unit}.active`)),
    user: (u) => fs.existsSync(path.join(fake, 'user', u)),
    ufwActive: () => fs.existsSync(path.join(fake, 'ufw.active')),
    ufwRules: () => { try { return fs.readFileSync(path.join(fake, 'ufw.rules'), 'utf-8').split('\n').filter(Boolean); } catch { return []; } },
    /** 原来就装着的包（连同它带来的命令；nginx 连同它的目录和 nginx.conf，并且在跑） */
    preinstall(pkg) {
      fs.mkdirSync(path.join(fake, 'pkg'), { recursive: true });
      fs.writeFileSync(path.join(fake, 'pkg', pkg), '');
      if (PACKAGE_COMMANDS.includes(pkg)) fs.writeFileSync(path.join(bin, pkg), stub(pkg));
      if (pkg === 'nginx') {
        fs.writeFileSync(path.join(fake, 'pkg', 'nginx-common'), '');
        for (const d of ['sites-available', 'sites-enabled', 'conf.d']) fs.mkdirSync(path.join(root, 'etc', 'nginx', d), { recursive: true });
        fs.writeFileSync(path.join(root, 'etc', 'nginx', 'nginx.conf'), 'http {\n    include /etc/nginx/conf.d/*.conf;\n    include /etc/nginx/sites-enabled/*;\n}\n');
        fs.mkdirSync(path.join(fake, 'svc'), { recursive: true });
        fs.writeFileSync(path.join(fake, 'svc', 'nginx.active'), '');
      }
    },
    /** 预先摆好"原来就有"的东西 / 制造故障：mark('certbot-fail')、mark('ufw.active')、mark('listen/t-80', 'apache2') */
    mark(rel, body = '') { const f = path.join(fake, ...rel.split('/')); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, body); },
    unmark(rel) { fs.rmSync(path.join(fake, ...rel.split('/')), { force: true }); },
    cleanup() { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* Windows 上偶尔占着，留给系统清 */ } },
  };
}
