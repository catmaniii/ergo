// 不自己建临时目录的测试文件，第一行 import 它（327 号票）：数据目录的默认位置不再是代码目录，
// 而 src/ 里的模块一被加载就会定下数据目录（log.mjs 还会当场建 logs/）。ES 模块按 import 的先后求值，
// 所以排在第一个 import 的这里先把数据目录换成一个新的临时目录——绝不碰本机正在用的那份，
// 哪怕你的终端里 LSM_DATA_DIR 正指着它。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'lsm-test-'));
process.env.LSM_DATA_DIR = TEST_DATA_DIR;
process.on('exit', () => {
  try { fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true }); } catch {}
});
