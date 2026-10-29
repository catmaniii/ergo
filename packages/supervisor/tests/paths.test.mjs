// 数据目录（327 号票）：数据挪出代码目录、只在 paths.mjs 定一次；--data-dir / LSM_DATA_DIR 能指回旧的 LSM 目录接着用。
import { TEST_DATA_DIR } from './_isolate.mjs';   // 必须是第一个 import：先把数据目录换成临时目录
import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import * as paths from '../src/paths.mjs';
import { taskArgs } from '../src/autostart.mjs';
import { passwordFileOf } from '../src/auth.mjs';
import { loadCredentials } from '../src/vpsbilling.mjs';

const LSM = path.join(paths.ROOT, 'bin', 'lsm.mjs');
const inside = (dir, p) => !path.relative(dir, p).startsWith('..') && !path.isAbsolute(path.relative(dir, p));

test('数据目录的来源：命令行 --data-dir 先于 LSM_DATA_DIR，都没有时是 %LOCALAPPDATA%\\ergo\\supervisor', () => {
  const env = { LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local', LSM_DATA_DIR: 'D:\\from-env' };
  assert.deepEqual(paths.resolveDataDir({ argv: ['node', 'lsm.mjs', 'status', '--data-dir', 'D:\\from-flag'], env }), { dir: path.resolve('D:\\from-flag'), from: 'flag' });
  assert.deepEqual(paths.resolveDataDir({ argv: ['node', 'lsm.mjs', '--data-dir=D:\\eq', 'status'], env }), { dir: path.resolve('D:\\eq'), from: 'flag' });
  assert.deepEqual(paths.resolveDataDir({ argv: ['node', 'lsm.mjs', 'status'], env }), { dir: path.resolve('D:\\from-env'), from: 'env' });
  assert.deepEqual(paths.resolveDataDir({ argv: ['node', 'lsm.mjs'], env: { LOCALAPPDATA: env.LOCALAPPDATA } }),
    { dir: path.join(env.LOCALAPPDATA, 'ergo', 'supervisor'), from: 'default' });
  // 没有 LOCALAPPDATA（极少见）时按用户目录拼出同一个位置
  assert.equal(paths.defaultDataDir({}), path.join(os.homedir(), 'AppData', 'Local', 'ergo', 'supervisor'));
  // --data-dir 后面没跟东西不算
  assert.equal(paths.dataDirArg(['node', 'lsm.mjs', 'status', '--data-dir']), null);
});

test('命令自己的参数里去掉 --data-dir，别的原样留着', () => {
  assert.deepEqual(paths.withoutDataDirArg(['stop', '--data-dir', 'D:\\x', 'web', '--force']), ['stop', 'web', '--force']);
  assert.deepEqual(paths.withoutDataDirArg(['--data-dir=D:\\x', 'status']), ['status']);
  assert.deepEqual(paths.withoutDataDirArg(['status']), ['status']);
});

test('服务清单、账本、日志、密钥、网关路由表都在数据目录里，不在代码目录里；布局和 327 之前的 LSM 目录一样', () => {
  assert.equal(paths.DATA_DIR, TEST_DATA_DIR);
  assert.equal(paths.DATA_DIR_FROM, 'env');
  const data = [
    [paths.REGISTRY_DIR, 'registry'],
    [paths.SERVICES_DIR, 'registry/services'],
    [paths.OWNED_DIR, 'registry/services/owned'],
    [paths.MANAGER_YAML, 'registry/manager.yaml'],
    [paths.BOOT_FILE, 'registry/autostart.yaml'],
    [paths.TAILNET_FILE, 'registry/tailnet.yaml'],
    [paths.STATE_FILE, 'state.json'],
    [paths.LOGS_DIR, 'logs'],
    [paths.MANAGER_LOG, 'logs/manager.log'],
    [paths.AUDIT_LOG, 'logs/audit.log'],
    [paths.TAILNET_ROUTES, 'tailnet-routes.json'],
    [paths.SECRETS_DIR, '.secrets'],
    [paths.TAILNET_CERTS, '.secrets/tailnet'],
    [paths.VPS_STATE, 'vps-setup.json'],
    [paths.VPS_KEYS_DIR, '.secrets/vps-setup'],
  ];
  for (const [p, rel] of data) {
    // 相对位置和旧的 LSM 目录一字不差：--data-dir 指向旧目录就能原样接着用，搬家也是原样复制
    assert.equal(path.relative(paths.DATA_DIR, p).replace(/\\/g, '/'), rel);
    assert.ok(!inside(paths.ROOT, p), `${rel} 不该在代码目录里`);
  }
  assert.equal(paths.WEBUI_DIR, path.join(paths.ROOT, 'webui'));
});

test('manager.yaml 里的相对路径（口令文件、AccessKey）相对数据目录；绝对路径原样用', () => {
  assert.equal(paths.dataPath('.secrets/x.txt'), path.join(TEST_DATA_DIR, '.secrets', 'x.txt'));
  assert.equal(paths.dataPath('C:\\keys\\x.txt'), 'C:\\keys\\x.txt');
  assert.equal(passwordFileOf({}), path.join(TEST_DATA_DIR, '.secrets', 'webui-password.txt'));
  assert.equal(passwordFileOf({ auth: { passwordFile: '.secrets/other.txt' } }), path.join(TEST_DATA_DIR, '.secrets', 'other.txt'));
  assert.equal(passwordFileOf({ auth: { passwordFile: 'C:\\pw.txt' } }), 'C:\\pw.txt');

  const dir = path.join(TEST_DATA_DIR, '.secrets', 'alicloud_vps');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'ak.json'), '{"accessKeyId":"test-id","accessKeySecret":"test-secret"}');
  const c = loadCredentials('.secrets/alicloud_vps');
  assert.deepEqual([c.ok, c.accessKeyId, c.file], [true, 'test-id', path.join(dir, 'ak.json')]);
});

test('开机自启：数据目录不是默认位置时，计划任务的命令带上 --data-dir（计划任务看不到当时终端里的环境变量）', () => {
  const base = { node: 'D:\\node\\node.exe', root: 'D:\\app\\packages\\supervisor' };
  const entry = path.join(base.root, 'bin', 'lsm.mjs');
  assert.equal(taskArgs({ ...base, dataDir: 'C:\\x', dataDirFrom: 'default' }), `--headless "D:\\node\\node.exe" "${entry}" serve --lifeline --quiet`);
  assert.equal(taskArgs({ ...base, dataDir: 'D:\\old-lsm', dataDirFrom: 'env' }), `--headless "D:\\node\\node.exe" "${entry}" serve --lifeline --quiet --data-dir "D:\\old-lsm"`);
  assert.equal(taskArgs({ ...base, dataDir: 'D:\\old-lsm', dataDirFrom: 'flag' }), `--headless "D:\\node\\node.exe" "${entry}" serve --lifeline --quiet --data-dir "D:\\old-lsm"`);
});

test('lsm paths / validate 认 --data-dir：用的是指定的那份注册表', () => {
  const other = fs.mkdtempSync(path.join(os.tmpdir(), 'lsm-paths-'));
  try {
    fs.mkdirSync(path.join(other, 'registry', 'services'), { recursive: true });
    fs.writeFileSync(path.join(other, 'registry', 'services', 'one.yaml'),
      `id: one\nroot: ${JSON.stringify(other)}\nkind: external\nprobe:\n  tier: port\n  port: 18901\n`);
    const env = { ...process.env, LSM_DATA_DIR: TEST_DATA_DIR, LSM_QUIET: '1' };
    const out = execFileSync(process.execPath, [LSM, 'paths', '--data-dir', other], { env, encoding: 'utf8' });
    assert.match(out, new RegExp(`数据目录  ${other.replace(/\\/g, '\\\\')}`));
    assert.match(out, /命令行 --data-dir/);
    const v = execFileSync(process.execPath, [LSM, '--data-dir', other, 'validate'], { env, encoding: 'utf8' });
    assert.match(v, /注册表 1 个服务，全部通过校验/);
    // 没给 --data-dir 就是 LSM_DATA_DIR 那份（空的）
    const e = execFileSync(process.execPath, [LSM, 'paths'], { env, encoding: 'utf8' });
    assert.match(e, /环境变量 LSM_DATA_DIR/);
  } finally {
    fs.rmSync(other, { recursive: true, force: true });
  }
});
