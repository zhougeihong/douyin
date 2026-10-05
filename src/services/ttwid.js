// ttwid 自动注册：消掉手动 `npm run ttwid`。
//
// 为什么需要中转：ttwid 只随 Set-Cookie 下发（实测跟它的 redirect_url 后 body 里也没有），
// 而设备端 libjsapi 不回传响应头 → 必须经 relay 的 &meta=1 才能读到值。
// relay 已支持 POST 转发（register 接口是 POST）。
//
// 实测（2026-10）：
//   POST https://ttwid.bytedance.com/ttwid/union/register/
//   body {"region":"cn","aid":1768,"needFid":false,"service":"www.ixigua.com",
//         "migrate_info":{"ticket":"","source":"node"},"cbUrlProtocol":"https","union":true}
//   → {"error_code":0,"message":"union register success"} + Set-Cookie: ttwid=1%7C…
import { jsapiHttpRequest } from './libjsapi.js';
import { captureCookiesFromHeaders, mergeCookies, persistCookies, cookieSummary } from './session-cookies.js';
import { LOGIN_HELPER, API_RELAY } from '../config.js';

const REGISTER_URL = 'https://ttwid.bytedance.com/ttwid/union/register/';
const REGISTER_BODY = JSON.stringify({
  region: 'cn',
  aid: 1768,
  needFid: false,
  service: 'www.ixigua.com',
  migrate_info: { ticket: '', source: 'node' },
  cbUrlProtocol: 'https',
  union: true
});

// 可传入自定义中转地址（测试用）；默认取 LOGIN_HELPER，其次 API_RELAY
export function relayBaseFor(override) {
  const base = override || LOGIN_HELPER || API_RELAY || '';
  return String(base).replace(/\/$/, '');
}

export async function refreshTtwid(relayOverride) {
  const base = relayBaseFor(relayOverride);
  if (!base) {
    throw new Error('未配置中转（LOGIN_HELPER/API_RELAY 为空）：设备端读不到响应头，无法自动注册 ttwid');
  }
  const url = base + '/relay?url=' + encodeURIComponent(REGISTER_URL) + '&meta=1';
  const meta = await jsapiHttpRequest({
    url,
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    data: REGISTER_BODY,
    timeoutMs: 12000,
    withMeta: true,
    relayMeta: true,
    direct: true
  });

  // ttwid 在响应头里：先看 relay 信封的 headers，再从原始对象兜一层
  const found = Object.assign({}, captureCookiesFromHeaders(meta.raw), captureCookiesFromHeaders(meta.headers));
  const ttwid = found.ttwid;
  if (!ttwid) throw new Error('注册返回成功但响应头里没有 ttwid');

  mergeCookies({ ttwid: ttwid });
  await persistCookies();
  return { ttwid: ttwid, cookieText: cookieSummary() };
}
