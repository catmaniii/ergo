// VPS 订阅：签名、凭证解析、订阅查询拼装、提醒规则、通知去重。全部离线，不碰阿里云。
import './_isolate.mjs';   // 必须是第一个 import：先把数据目录换成临时目录
import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as vb from '../src/vpsbilling.mjs';
import { toastXml } from '../src/notify.mjs';

test('阿里云签名 V3：和官方文档的固定参数示例逐字一致', () => {
  const r = vb.signRequest({
    method: 'POST', host: 'ecs.cn-shanghai.aliyuncs.com', action: 'RunInstances', version: '2014-05-26',
    query: { ImageId: 'win2019_1809_x64_dtc_zh-cn_40G_alibase_20230811.vhd', RegionId: 'cn-shanghai' },
    accessKeyId: 'YourAccessKeyId', accessKeySecret: 'YourAccessKeySecret',
    date: '2023-10-26T10:22:32Z', nonce: '3156853299f313e23d1673dc12e1703d',
  });
  assert.equal(r.hashedCanonicalRequest, '7ea06492da5221eba5297e897ce16e55f964061054b7695beedaac1145b1e259');
  assert.equal(r.signature, '06563a9e1b43f5dfe96b81484da74bceab24a1d853912eee15083a6f0f3283c0');
  assert.equal(r.headers.authorization, 'ACS3-HMAC-SHA256 Credential=YourAccessKeyId,SignedHeaders=host;x-acs-action;x-acs-content-sha256;x-acs-date;x-acs-signature-nonce;x-acs-version,Signature=06563a9e1b43f5dfe96b81484da74bceab24a1d853912eee15083a6f0f3283c0');
  // RFC 3986：encodeURIComponent 放过的 ! ' ( ) * 也要编码；~ 不编码；JSON 数组参数（PublicIpAddresses）整串编码
  assert.equal(vb.percentEncode("a b*~'()!"), 'a%20b%2A~%27%28%29%21');
  assert.equal(vb.percentEncode('["203.0.113.10"]'), '%5B%22203.0.113.10%22%5D');
});

test('只读 AccessKey：控制台下载的 CSV（含多列、BOM）和 JSON 都认；读不到时报错不回显内容', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lsm-ak-'));
  const f = (name, body) => { const p = path.join(dir, name); fs.writeFileSync(p, body); return p; };
  let c = vb.loadCredentials(f('a.csv', 'AccessKey ID,AccessKey Secret\r\nLTAI5tIDxxxx,SeCrEt123\r\n'));
  assert.deepEqual([c.ok, c.accessKeyId, c.accessKeySecret], [true, 'LTAI5tIDxxxx', 'SeCrEt123']);
  c = vb.loadCredentials(f('b.csv', '﻿UserPrincipalName,AccessKeyId,AccessKeySecret\nlsm-ro@123.onaliyun.com,LTAI5tIDyyyy,SeCrEt456\n'));
  assert.deepEqual([c.ok, c.accessKeyId, c.accessKeySecret], [true, 'LTAI5tIDyyyy', 'SeCrEt456']);
  c = vb.loadCredentials(f('c.json', '{"accessKeyId":"LTAI5tIDzzzz","accessKeySecret":"SeCrEt789"}'));
  assert.deepEqual([c.ok, c.accessKeyId], [true, 'LTAI5tIDzzzz']);
  c = vb.loadCredentials(path.join(dir, 'nope.csv'));
  assert.equal(c.ok, false);
  assert.equal(c.missing, true);
  c = vb.loadCredentials(f('bad.json', '{"accessKeyId": "LTAI5tLEAK", oops'));
  assert.equal(c.ok, false);
  assert.doesNotMatch(c.why, /LTAI5tLEAK/);
  c = vb.loadCredentials(f('half.csv', 'AccessKey ID,AccessKey Secret\nLTAI5tONLYID\n'));
  assert.equal(c.ok, false);
  assert.doesNotMatch(c.why, /LTAI5tONLYID/);
});

test('只读 AccessKey：「创建成功」页存下来的逐行文本（夹着登录名、空密码、安全邮箱）只取 ID 和 Secret', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lsm-ak-'));
  const p = path.join(dir, '登录名称 someone@1234567890.ona.txt');
  // 和真文件同构（逐行「标签 值」、CRLF、无 BOM、末行无换行、空值行带一个尾随空格），值是假的
  fs.writeFileSync(p, ['登录名称 someone@1234567890.onaliyun.com', '登录密码 ', 'AccessKey ID LTAI-FAKE-ID-FOR-TESTS',
    'AccessKey Secret fake-secret-for-tests', 'SecurityPhoneDevice ', 'SecurityEmailDevice x@example.com'].join('\r\n'));
  const c = vb.loadCredentials(p);
  assert.deepEqual([c.ok, c.accessKeyId, c.accessKeySecret], [true, 'LTAI-FAKE-ID-FOR-TESTS', 'fake-secret-for-tests']);
  // 冒号分隔（半角 / 全角）也认
  const q = path.join(dir, 'colon.txt');
  fs.writeFileSync(q, 'AccessKey ID: LTAIcolon\nAccessKey Secret：SecretColon\n');
  assert.deepEqual([vb.loadCredentials(q).accessKeyId, vb.loadCredentials(q).accessKeySecret], ['LTAIcolon', 'SecretColon']);
  // 不带空格的 CSV 表头不能被当成「标签 + 值」
  const r = path.join(dir, 'nospace.csv');
  fs.writeFileSync(r, 'AccessKeyId,AccessKeySecret\nLTAInospace,SecretNoSpace\n');
  assert.deepEqual([vb.loadCredentials(r).accessKeyId, vb.loadCredentials(r).accessKeySecret], ['LTAInospace', 'SecretNoSpace']);
});

test('只读 AccessKey 指向目录：恰好一个文件能读出来就用它；没有、或有好几个都报错（只报文件名）', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lsm-akdir-'));
  assert.equal(vb.loadCredentials(dir).missing, true);                       // 空目录 = 还没配
  fs.writeFileSync(path.join(dir, 'readme.txt'), '这里放 AccessKey\n');
  assert.equal(vb.loadCredentials(dir).ok, false);
  fs.writeFileSync(path.join(dir, 'ak.txt'), 'AccessKey ID LTAIdir\r\nAccessKey Secret SecretDir');
  const c = vb.loadCredentials(dir);
  assert.deepEqual([c.ok, c.accessKeyId, path.basename(c.file)], [true, 'LTAIdir', 'ak.txt']);
  fs.writeFileSync(path.join(dir, 'ak2.csv'), 'AccessKey ID,AccessKey Secret\nLTAIdup,SecretDup\n');
  const dup = vb.loadCredentials(dir);
  assert.equal(dup.ok, false);
  assert.match(dup.why, /ak\.txt/);
  assert.doesNotMatch(dup.why, /SecretDir|SecretDup|LTAI/);
});

const CFG = { ...vb.BILLING_DEFAULTS };
const fakeCall = (fixtures) => async ({ action }) => fixtures[action] || { ok: false, code: 'X', why: `没有 ${action}` };
function credFile() {
  const p = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'lsm-ak-')), 'ak.csv');
  fs.writeFileSync(p, 'AccessKey ID,AccessKey Secret\nLTAIx,sec\n');
  return p;
}

test('订阅查询：费用中心的包年包月订阅 + 余额拼成一份；最先到期的排前面；某项失败只记这一项；没凭证不联网', async () => {
  const cfg = { ...CFG, site: 'intl', region: 'ap-southeast-1', credentials: credFile() };
  // 形状照费用中心接口的真实返回（账号、ID、时间都是编的）
  const ok = {
    QueryAvailableInstances: { ok: true, data: { Success: true, Data: { TotalCount: 2, InstanceList: [
      { Status: 'Normal', SubscriptionType: 'Subscription', EndTime: '2027-01-31T16:00:00Z', InstanceID: 'vps1', ProductCode: 'swas',
        CreateTime: '2026-01-01T00:00:00Z', RenewalDurationUnit: 'M', Region: 'ap-southeast-1', SubStatus: 'Normal', RenewStatus: 'ManualRenewal' },
      { Status: 'Normal', SubscriptionType: 'Subscription', EndTime: '2026-12-01T16:00:00Z', InstanceID: 'dom1', ProductCode: 'domain', RenewStatus: 'AutoRenewal' },
      { Status: 'Normal', SubscriptionType: 'PayAsYouGo', EndTime: '2999-09-08T16:00:00Z', InstanceID: 'cdt', ProductCode: 'cdt' },   // 按量的不算订阅
    ] } } },
    QueryAccountBalance: { ok: true, data: { Success: true, Data: { AvailableAmount: '0.00', AvailableCashAmount: '0.00', CreditAmount: '0.00', Currency: 'USD' } } },
  };
  let hosts = new Set();
  const spy = (fx) => async (req) => { hosts.add(req.host); return fakeCall(fx)(req); };
  const b = await vb.fetchBilling(cfg, { call: spy(ok) });
  assert.equal(b.ok, true);
  assert.deepEqual([...hosts], ['business.ap-southeast-1.aliyuncs.com']);          // 国际站只打国际站的费用中心
  assert.deepEqual(b.subscriptions.map((s) => s.id), ['dom1', 'vps1']);           // 先到期的在前，按量的剔掉
  const vps = b.subscriptions[1];
  assert.deepEqual([vps.productName, vps.regionName, vps.isVps, vps.renewStatus], ['轻量应用服务器', '新加坡', true, 'ManualRenewal']);
  // 没写 region 就不标「这台 VPS」（默认不猜地域）
  const noRegion = await vb.fetchBilling({ ...cfg, region: null }, { call: fakeCall(ok) });
  assert.equal(noRegion.subscriptions.some((s) => s.isVps), false);
  assert.equal(vps.endTime, Date.parse('2027-01-31T16:00:00Z'));
  assert.equal(b.subscriptions[0].isVps, false);
  assert.deepEqual([b.balance.available, b.balance.currency], [0, 'USD']);
  assert.doesNotMatch(JSON.stringify(b), /"sec"|LTAIx/);   // 结果里没有凭证

  const partial = await vb.fetchBilling(cfg, { call: fakeCall({ ...ok, QueryAccountBalance: { ok: false, why: '没权限' } }) });
  assert.equal(partial.ok, false);
  assert.equal(partial.subscriptions.length, 2);
  assert.deepEqual(partial.errors, [{ part: '余额', why: '没权限' }]);

  const none = await vb.fetchBilling(cfg, { call: fakeCall({ ...ok, QueryAvailableInstances: { ok: true, data: { Data: { InstanceList: [] } } } }) });
  assert.deepEqual(none.subscriptions, []);

  const unconfigured = await vb.fetchBilling({ ...cfg, credentials: path.join(os.tmpdir(), 'lsm-no-such-ak.csv') },
    { call: () => assert.fail('没凭证就不该联网') });
  assert.equal(unconfigured.configured, false);
});

test('订阅提醒：手动续费到期前 7 天黄、3 天红；自动续费只在余额不够时提醒；已到期 / 即将停服红；欠费红', () => {
  const now = Date.parse('2026-10-14T04:00:00Z');
  const day = 86400000;
  const sub = (o = {}) => ({ id: 'vps1', productName: '轻量应用服务器', regionName: '杭州', isVps: true, status: 'Normal', renewStatus: 'ManualRenewal', endTime: now + 200 * day, ...o });
  const bill = (subs, balance = { available: 0, currency: 'USD' }) => ({ configured: true, subscriptions: subs, balance });
  const keys = (b, cfg = CFG) => vb.billingAlerts(b, cfg, now).map((a) => `${a.key}:${a.level}`);

  assert.deepEqual(keys(bill([sub()])), []);                                          // 还早，余额 0 也不报（minBalance 默认 0）
  assert.deepEqual(keys({ configured: false }), []);
  assert.deepEqual(keys(bill([sub({ endTime: now + 6 * day })])), ['expiry:vps1:warn']);
  assert.deepEqual(keys(bill([sub({ endTime: now + 2 * day })])), ['expiry:vps1:bad']);
  const t = vb.billingAlerts(bill([sub({ endTime: now + 6 * day })]), CFG, now)[0].text;
  assert.match(t, /轻量应用服务器 · 杭州（这台 VPS）6 天后（2026-10-20）到期，是手动续费——去费用中心续费/);
  assert.match(vb.billingAlerts(bill([sub({ endTime: now + 5 * day, renewStatus: 'NotRenewal' })]), CFG, now)[0].text, /到期不续费/);
  // 自动续费：余额够（或不设线）就不打扰；设了线且不够才提醒，并且不再单独报余额
  assert.deepEqual(keys(bill([sub({ endTime: now + 2 * day, renewStatus: 'AutoRenewal' })])), []);
  const lowCfg = { ...CFG, minBalance: 15 };
  assert.deepEqual(keys(bill([sub({ endTime: now + 5 * day, renewStatus: 'AutoRenewal' })]), lowCfg), ['expiry:vps1:warn']);
  assert.deepEqual(keys(bill([sub()]), lowCfg), ['balance:warn']);
  // 已到期 / 即将停服 / 欠费
  assert.deepEqual(keys(bill([sub({ status: 'Expired', endTime: now - day })])), ['expiry:vps1:bad']);
  assert.deepEqual(keys(bill([sub({ status: 'WaitForExpire', endTime: now + 30 * day })])), ['expiry:vps1:bad']);
  assert.deepEqual(keys(bill([sub()], { available: -3, currency: 'USD' })), ['balance:bad']);
  // 多个订阅各自一条 key：一天一次的去重按订阅分开算
  assert.deepEqual(keys(bill([sub({ endTime: now + 6 * day }), sub({ id: 'dom1', isVps: false, productName: '域名', regionName: null, endTime: now + 3 * day })])),
    ['expiry:vps1:warn', 'expiry:dom1:bad']);
});

test('系统通知：同一条一天（北京时间）最多弹一次，升级成 bad 当天再弹一次', () => {
  const t0 = Date.parse('2026-10-14T04:00:00Z');                   // 北京 12:00
  const warn = [{ key: 'balance', level: 'warn', text: 'x' }];
  let r = vb.dueNotifications(warn, {}, t0);
  assert.equal(r.due.length, 1);
  r = vb.dueNotifications(warn, r.notified, t0 + 3 * 3600000);
  assert.equal(r.due.length, 0);
  const bad = [{ key: 'balance', level: 'bad', text: 'y' }];
  r = vb.dueNotifications(bad, r.notified, t0 + 4 * 3600000);
  assert.equal(r.due.length, 1);
  r = vb.dueNotifications(bad, r.notified, t0 + 5 * 3600000);
  assert.equal(r.due.length, 0);
  r = vb.dueNotifications(bad, r.notified, Date.parse('2026-10-14T16:30:00Z'));   // 北京已是 15 号
  assert.equal(r.due.length, 1);
});

test('杂项：没写 billing 就是没开；通知 XML 转义', () => {
  assert.equal(vb.billingConfig({ vps: { host: 'x' } }), null);
  assert.equal(vb.billingConfig({ vps: { billing: { minBalance: 30 } } }).remindDays, 7);
  const x = toastXml("余额 < ¥50 & 'x'", ['a', 'b'], 'http://127.0.0.1:7420/');
  assert.match(x, /余额 &lt; ¥50 &amp; &apos;x&apos;/);
  assert.match(x, /launch="http:\/\/127\.0\.0\.1:7420\/"/);
});
