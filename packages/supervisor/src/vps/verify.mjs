// 装完自己验收（321 号票）：从电脑上走一遍 https 地址——证书是真的、没配对的设备进不去、
// 而且后面接的是二狗的外网端口 8811，**绝不是本机端口 8810**。
//
// 为什么能分出 8810 和 8811（二狗网关的行为，packages/daemon/src/gateway/gateway.ts）：
//  - 8811（外网端口）：不看 Host，没凭证时 GET /api/access 回 200 {"access":"none"}，GET /healthz 回 401；
//  - 8810（本机端口）：本机来的一律信任，只认 Host 是 127.0.0.1:8810 / localhost:8810——
//    经 nginx 原样转发 Host 时它回 403（拒了），nginx 把 Host 改写成 127.0.0.1 时它回 {"access":"local"}，等于整个公网免认证。
// 两种都算"接到了 8810"，拒绝并说明。
export const ERGO_LOCAL_PORT = 8810;
export const ERGO_EXTERNAL_PORT = 8811;

function json(body) {
  try { return JSON.parse(body); } catch { return null; }
}

/** 打两下（不带任何凭证）的结果 → 判断后面接的是谁。 */
export function classifyErgo({ access, health }) {
  if (access?.tlsError) return { verdict: 'cert', ok: false, why: `证书不对：${access.tlsError}` };
  if (access?.error) return { verdict: 'unreachable', ok: false, why: `连不上：${access.error}` };
  const a = json(access?.body);
  if (access?.status === 200 && a?.access === 'local') {
    return { verdict: 'local', ok: false, why: `接到了二狗的本机端口 ${ERGO_LOCAL_PORT}：不带凭证就被当成本机、完全信任——整个公网免认证。立刻停掉隧道，把它改接 ${ERGO_EXTERNAL_PORT}` };
  }
  if (access?.status === 403 && a?.code === 'forbidden') {
    return { verdict: 'local', ok: false, why: `像是接到了二狗的本机端口 ${ERGO_LOCAL_PORT}（它只认 127.0.0.1 的 Host，拒了这个请求）。隧道要接 ${ERGO_EXTERNAL_PORT}，不能接 ${ERGO_LOCAL_PORT}` };
  }
  if ([502, 503, 504].includes(access?.status)) {
    return { verdict: 'unreachable', ok: false, why: `nginx 回 ${access.status}：VPS 这头通了，后面的隧道没接上（电脑上的隧道服务起来了吗？二狗在跑吗？）` };
  }
  if (access?.status === 200 && a?.access === 'none') {
    if (health?.status === 401) return { verdict: 'external', ok: true, why: `接的是二狗的外网端口 ${ERGO_EXTERNAL_PORT}：没配对的设备只拿到配对页，别的一律 401` };
    return { verdict: 'unknown', ok: false, why: `/api/access 像二狗的外网端口，可不带凭证的 /healthz 回了 ${health?.status ?? health?.error ?? '?'}（应该是 401）——中间有东西不对，先别用` };
  }
  return { verdict: 'unknown', ok: false, why: `后面接的不像二狗（/api/access 回 ${access?.status}）` };
}

/** 真的打一遍：url 是站点的根（https://ergo.<IP>.sslip.io/）。headers 给测试改 Host 用。 */
export async function verifyErgo(exec, url, { headers = {} } = {}) {
  const access = await exec.request(new URL('/api/access', url).href, { headers });
  const health = access.tlsError || access.error ? null : await exec.request(new URL('/healthz', url).href, { headers });
  const r = classifyErgo({ access, health });
  return {
    ...r,
    cert: access.cert || null,
    hsts: !!access.headers?.['strict-transport-security'],
    checkedAt: Date.now(),
  };
}

/** headscale：https://<domain>/health 回 200 且证书真（headscale 0.23 起有 /health）。 */
export async function verifyHeadscale(exec, url) {
  const r = await exec.request(new URL('/health', url).href);
  if (r.tlsError) return { ok: false, why: `证书不对：${r.tlsError}`, checkedAt: Date.now() };
  if (r.error) return { ok: false, why: `连不上：${r.error}`, checkedAt: Date.now() };
  if (r.status !== 200) return { ok: false, why: `headscale 的 /health 回 ${r.status}`, cert: r.cert || null, checkedAt: Date.now() };
  return { ok: true, why: 'headscale 回话了，证书是真的', cert: r.cert || null, checkedAt: Date.now() };
}

/**
 * 站点（lsm vps site add，322）从外面验收：证书是真的、不带凭证进不去（401 / 403）。
 *  - 后面接的像二狗（/api/access 回 {"access": …}）：照上面 classifyErgo 分 8810 / 8811——接到 8810 一律红；
 *  - 502 / 503 / 504：VPS 这头通了，后面的服务没回话；
 *  - 不带凭证就能打开（2xx / 3xx）：没有认证把关。站点本来就是公开的（--public）才算过。
 */
export async function verifySite(exec, url, { isPublic = false } = {}) {
  const root = await exec.request(url);
  const base = { cert: root.cert || null, hsts: !!root.headers?.['strict-transport-security'], status: root.status ?? null, checkedAt: Date.now() };
  if (root.tlsError) return { ...base, verdict: 'cert', ok: false, why: `证书不对：${root.tlsError}` };
  if (root.error) return { ...base, verdict: 'unreachable', ok: false, why: `连不上：${root.error}` };
  const access = await exec.request(new URL('/api/access', url).href);
  const a = json(access.body);
  if (a && typeof a.access === 'string') {
    const health = await exec.request(new URL('/healthz', url).href);
    return { ...base, ...classifyErgo({ access, health }), ergo: true };
  }
  if ([502, 503, 504].includes(root.status)) {
    return { ...base, verdict: 'unreachable', ok: false, why: `nginx 回 ${root.status}：VPS 这头通了，后面的服务没回话（它在跑吗？听的是 127.0.0.1 上那个端口吗？）` };
  }
  if ([401, 403].includes(root.status)) return { ...base, verdict: 'auth', ok: true, why: `不带凭证打开回 ${root.status}：有认证把关` };
  if (root.status >= 200 && root.status < 400) {
    if (isPublic) return { ...base, verdict: 'open', ok: true, why: `不带凭证就能打开（回 ${root.status}）——你说过它本来就是公开的（--public）` };
    return {
      ...base, verdict: 'open', ok: false,
      why: `不带凭证就能打开（回 ${root.status}）：后面的服务没有认证把关，谁拿到地址都能进。它本来就是公开的就加 --public 重跑；不是的话先给它加上认证，或者撤掉（lsm vps site remove）`,
    };
  }
  return { ...base, verdict: 'unknown', ok: false, why: `打开回 ${root.status}，看不出后面是什么` };
}

/** 隧道的本机那头：只许是 8811。 */
export function localPortProblem(port) {
  if (Number(port) === ERGO_LOCAL_PORT) return `隧道绝不能接 ${ERGO_LOCAL_PORT}：那是二狗的本机端口，本机来的一律信任，接出去等于整个公网免认证。只能接外网端口 ${ERGO_EXTERNAL_PORT}`;
  if (!Number.isInteger(Number(port)) || port < 1 || port > 65535) return `端口不对：${port}`;
  return null;
}
