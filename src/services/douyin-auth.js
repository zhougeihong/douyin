// 抖音扫码登录客户端（免后端、免密钥）
// 使用字节统一账号扫码登录接口（sso.toutiao.com，官方文案即"使用抖音 APP 扫码验证"）：
//   1. get_qrcode       获取二维码图片（base64 PNG）与轮询令牌 token
//   2. check_qrconnect  按 token 轮询：1 待扫 / 2 已扫 / 3 已确认 / 4 过期 / 5 拒绝
// 2026-10 实测可用；www.douyin.com 同类入口对第三方返回"该应用无权限"，故走 sso 域。
//
// 登录成功后会尽量把**登录 Cookie**收下来（登录态数据全靠它）：
//   · 原生响应对象里若带 header/headers（网络诊断会打印“响应外层键”）→ 直接取 Set-Cookie；
//   · 配了 LOGIN_HELPER（PC 中转）→ 用 &meta=1 让 relay 把响应头一并回传，最可靠；
//   · 兜底：扫描响应体 / 跳转 URL 里的 name=value。
// 另外会跟随 redirect_url 跳转链（最多 5 跳），逐跳收集 Cookie。

import { jsapiHttpRequest } from './libjsapi.js';
import { attachABogus } from './abogus.js';
import {
  captureCookiesFromHeaders,
  captureCookiesFromText,
  captureCookiesFromUrl,
  mergeCookies,
  persistCookies,
  cookieHeader,
  cookieCount,
  cookieKeys,
  hasLoginCookie
} from './session-cookies.js';
import { DOUYIN_SSO_API, DOUYIN_SHARE_UA, API_TIMEOUT_MS, LOGIN_HELPER } from '../config.js';

const STATUS_MAP = {
  '1': 'new',
  '2': 'scanned',
  '3': 'confirmed',
  '4': 'expired',
  '5': 'refused'
};

const MAX_REDIRECT_HOPS = 5;

function safeStringify(value) {
  try {
    return JSON.stringify(value);
  } catch (error) {
    return '';
  }
}

function bodyText(body) {
  return typeof body === 'string' ? body : safeStringify(body);
}

// 把一次响应里所有能读到的 Cookie 都收进 collected。
// 注意：**不扫请求 URL**（里面的 token=… 是接口参数，不是 cookie），
// 只扫响应头、响应体，以及响应里的跳转地址。
function absorbCookies(meta, url, collected) {
  if (!meta) return collected;
  Object.assign(collected, captureCookiesFromHeaders(meta.raw));
  Object.assign(collected, captureCookiesFromHeaders(meta.headers));
  Object.assign(collected, captureCookiesFromText(bodyText(meta.body)));
  const headers = meta.headers || {};
  const location = headers.location || headers.Location;
  if (location) Object.assign(collected, captureCookiesFromUrl(location));
  return collected;
}

// 配了 PC 中转（LOGIN_HELPER）时，让 relay 带上响应头回传 —— 这是拿到 Set-Cookie 最可靠的方式
function buildLoginRequest(rawUrl, headers) {
  if (!LOGIN_HELPER) return { url: rawUrl, relayMeta: false, headers: headers };
  const base = String(LOGIN_HELPER).replace(/\/$/, '');
  return {
    url: base + '/relay?url=' + encodeURIComponent(rawUrl) +
      '&meta=1&h=' + encodeURIComponent(safeStringify(headers || {})),
    relayMeta: true,
    headers: undefined
  };
}

// passport 接口的请求头：**必须带 Referer/Origin**，服务端靠它判定应用上下文，
// 缺了会返回 error_code 16「该应用无权限」（设备端最初就是这么失败的：只带了 Cookie）。
function passportHeaders(extra) {
  const headers = Object.assign({
    'User-Agent': DOUYIN_SHARE_UA,
    Referer: 'https://www.toutiao.com/',
    Origin: 'https://www.toutiao.com',
    Accept: 'application/json, text/plain, */*',
    'Accept-Language': 'zh-CN,zh;q=0.9'
  }, extra || {});
  const cookie = cookieHeader();
  if (cookie) headers.Cookie = cookie;
  return headers;
}

async function loginFetch(rawUrl, opts) {
  const options = opts || {};
  const headers = passportHeaders(options.headers);
  const signed = attachABogus(rawUrl, {
    headers: headers,
    method: options.method || 'GET',
    body: options.body || '',
    uri: options.uri || rawUrl.replace(/^https?:\/\/[^/]+/i, '') || '/',
    userAgent: headers['User-Agent'] || DOUYIN_SHARE_UA
  });
  const requestUrl = signed.url || rawUrl;
  const requestHeaders = signed.headers || headers;
  // POST 表单：中转只转发 GET，所以 POST 一律走直连
  if (String(options.method || 'GET').toUpperCase() === 'POST') {
    return jsapiHttpRequest({
      url: requestUrl,
      method: 'POST',
      headers: Object.assign({ 'Content-Type': 'application/x-www-form-urlencoded' }, requestHeaders),
      data: options.body || '',
      timeoutMs: API_TIMEOUT_MS,
      withMeta: true,
      direct: true
    });
  }
  const built = buildLoginRequest(requestUrl, requestHeaders);
  if (built.relayMeta) {
    try {
      return await jsapiHttpRequest({
        url: built.url,
        timeoutMs: API_TIMEOUT_MS,
        withMeta: true,
        relayMeta: true,
        direct: true
      });
    } catch (error) {
      // PC 中转没开 / 不在同网段 → 退回直连：登录本身不能因为中转不可用而失败
    }
  }
  return jsapiHttpRequest({ url: requestUrl, headers: requestHeaders, timeoutMs: API_TIMEOUT_MS, withMeta: true });
}

// 相对地址补全（QuickJS 里不一定有 URL 构造函数，手写一个够用的）
function absolutize(base, next) {
  if (/^https?:/i.test(next)) return next;
  const host = /^(https?:\/\/[^/]+)/i.exec(String(base || ''));
  if (!host) return '';
  return next.charAt(0) === '/' ? host[1] + next : host[1] + '/' + next;
}

// 从响应里找下一跳地址
function extractNextUrl(body) {
  const text = bodyText(body);
  const byField = text.match(/"(?:redirect_url|redirect_uri|url|location)"\s*:\s*"([^"]{8,400})"/i);
  const byJs = text.match(/location\.(?:href|replace)\s*[=(]\s*['"]([^'"]{8,400})/i);
  const matched = byField || byJs;
  return matched ? matched[1].replace(/\\\//g, '/') : '';
}

// 跟随登录跳转链，逐跳收集 Cookie（拿到会话 Cookie 的关键一步）
async function followLoginRedirect(startUrl, collected) {
  let url = startUrl;
  for (let hop = 0; hop < MAX_REDIRECT_HOPS && url; hop++) {
    let meta;
    try {
      meta = await loginFetch(url);
    } catch (error) {
      break;
    }
    absorbCookies(meta, url, collected);
    if (hasLoginCookie()) break; // 已经拿到会话 Cookie，不必继续追
    const headers = meta.headers || {};
    const location = headers.location || headers.Location || headers['Location'];
    const next = location || extractNextUrl(meta.body);
    if (!next) break;
    url = absolutize(url, String(next));
  }
  return collected;
}

// 获取登录二维码
// opts.hint —— 覆盖默认提示文案。这个 SSO 是**字节统一账号**，同一个接口换个
// service 就换了扫码端品牌：service=https://www.toutiao.com 时扫码页显示「今日头条APP」。
// 抖音与今日头条两个入口共用本函数，靠这个参数把提示文案说对。
export async function requestLoginQr(opts) {
  const hintOverride = (opts && opts.hint) || '';
  const url = DOUYIN_SSO_API + 'get_qrcode/?service=https%3A%2F%2Fwww.toutiao.com&need_logo=false&need_short_url=false';
  const meta = await loginFetch(url);
  const payload = meta.body;

  // 二维码请求本身会下发 csrf 等 Cookie，先收下，后续轮询要带回去
  const collected = {};
  absorbCookies(meta, url, collected);
  mergeCookies(collected);
  if (cookieCount() > 0) await persistCookies();

  const data = payload && payload.data;
  if (!payload || payload.error_code !== 0 || !data || !data.token || !data.qrcode) {
    throw new Error((payload && payload.data && payload.data.description) || '获取二维码失败');
  }
  let hint = hintOverride || '请使用抖音 APP 扫码登录';
  try {
    const copy = typeof data.copywriting === 'string' ? JSON.parse(data.copywriting) : data.copywriting;
    if (copy && copy.desc) hint = copy.desc.replace(/\[color=\w+\]/g, '').replace(/\[\/\]/g, '');
  } catch (error) { /* 文案解析失败时用默认提示 */ }
  return {
    token: data.token,
    image: 'data:image/png;base64,' + data.qrcode,
    hint,
    // 扫码端品牌：实测该入口固定返回“今日头条APP”（抖音自有入口已封禁/无权限），
    // 如实回传给界面显示，避免用户以为登错了账号
    appName: data.app_name || data.web_name || ''
  };
}

// 轮询二维码状态
export async function checkLoginQr(token) {
  const url = DOUYIN_SSO_API + 'check_qrconnect/?token=' + encodeURIComponent(token);
  const meta = await loginFetch(url);
  const payload = meta.body;
  if (!payload || payload.error_code !== 0 || !payload.data) {
    throw new Error((payload && payload.data && payload.data.description) || '轮询登录状态失败');
  }

  const collected = {};
  absorbCookies(meta, url, collected);

  const raw = String(payload.data.status);
  const status = STATUS_MAP[raw] || 'new';
  const result = { status, rawStatus: raw, user: null, redirectUrl: '', cookieCount: 0, cookieKeys: [] };

  const data = payload.data;
  if (data.redirect_url) result.redirectUrl = data.redirect_url;

  // 已扫/已确认时尽量提取用户标识（字段随服务端版本变化，做兼容提取）
  const user = {};
  const nick = data.name || data.nickname || data.screen_name || (data.user_info && (data.user_info.name || data.user_info.screen_name));
  const avatar = data.avatar_url || (data.user_info && data.user_info.avatar_url);
  const userId = data.user_id || data.user_id_str || (data.user_info && data.user_info.user_id);
  if (nick) user.nick = nick;
  if (avatar) user.avatar = avatar;
  if (userId) user.id = String(userId);
  if (user.nick || user.id) result.user = user;

  // 已确认且无用户信息时，从 redirect_url 提取 user_id 兜底
  if (status === 'confirmed' && !result.user && result.redirectUrl) {
    const match = result.redirectUrl.match(/user_id=(\d+)/);
    if (match) result.user = { id: match[1] };
  }

  // 登录成功：跟随跳转链把会话 Cookie 收齐并落盘（之后所有抖音请求都会带上）
  if (status === 'confirmed') {
    if (result.redirectUrl) {
      try {
        await followLoginRedirect(result.redirectUrl, collected);
      } catch (error) { /* 尽力而为，失败不影响登录态展示 */ }
    }
    mergeCookies(collected);
    if (hasLoginCookie()) await persistCookies();
    result.cookieCount = cookieCount();
    result.cookieKeys = cookieKeys();
  }

  return result;
}

// ---------- 手机号登录（爬网页端 passport 接口） ----------
// 实测（2026-10，sso.toutiao.com 的 web 端接口）：
//   POST/GET /passport/web/send_code/   mobile+type+aid → 无效号码返回 error_code 1003「手机号错误」
//                                        （即接口在校验手机号，有效号码会下发短信）
//   POST/GET /passport/web/sms_login/   mobile+code+type+aid → 验证不通过返回 3052
//   而 /passport/web/login/、/login_by_mobile/、/mobile_login/、check_mobile 都返回 16「该应用无权限」
// 因此只有 send_code + sms_login 这一条链可用。
// 用 GET + query 而不是 POST：中转服务只转发 GET，这样登录响应才能经 LOGIN_HELPER 拿到 Set-Cookie。
const SMS_TYPE = 24;   // 短信登录场景
const SMS_AID = 13;    // 头条（字节统一账号）

function queryString(params) {
  const source = params || {};
  return Object.keys(source)
    .map((key) => key + '=' + encodeURIComponent(source[key]))
    .join('&');
}

// 把 passport 的错误码翻译成人能看懂的提示（并把码带在末尾，便于定位）
function describePassportError(payload) {
  const data = (payload && payload.data) || {};
  const code = Number((payload && payload.error_code !== undefined ? payload.error_code : data.error_code));
  const desc = data.description || (payload && payload.message) || '';
  const map = {
    0: '',
    7: '访问太频繁，请稍后再试',
    16: '该应用无权限（服务端未接受请求的应用上下文，通常是缺 Referer 或该入口已关闭）',
    22: '非法应用（aid 不被接受）',
    1002: '请先填写手机号',
    1003: '手机号格式不正确',
    3052: '验证码错误或已失效（请重新获取）'
  };
  const text = map[code] || (desc && desc !== 'error' ? desc : '请求失败');
  return text + '（error_code ' + code + '）';
}

// 把 URL / 响应体里能读到的 Cookie 收下（与扫码链路共用逻辑）
function collectFrom(meta, url) {
  const collected = {};
  absorbCookies(meta, url, collected);
  mergeCookies(collected);
  return collected;
}

function normalizeMobile(mobile) {
  return String(mobile || '').replace(/[^\d]/g, '');
}

// 发送短信验证码
export async function sendSmsCode(mobile) {
  const m = normalizeMobile(mobile);
  if (!/^1\d{10}$/.test(m)) throw new Error('请输入 11 位手机号');
  const params = { mobile: m, type: SMS_TYPE, aid: SMS_AID, service: 'https://www.toutiao.com' };
  const url = DOUYIN_SSO_API + 'web/send_code/?' + queryString(params);
  let meta = await loginFetch(url);
  collectFrom(meta, url);
  await persistCookies();

  let payload = meta.body;
  // 16 = 应用上下文没被接受（此时不会下发短信），换 POST 表单再试一次；
  // 只有确认“没发出短信”的错误码才重试，避免给用户发两条。
  if (Number(payload && payload.error_code) === 16) {
    const postUrl = DOUYIN_SSO_API + 'web/send_code/';
    meta = await loginFetch(postUrl, { method: 'POST', body: queryString(params) });
    collectFrom(meta, postUrl);
    payload = meta.body;
  }

  const code = Number(payload && payload.error_code);
  if (code === 0) return { ok: true, description: '验证码已发送' };
  const error = new Error(describePassportError(payload));
  error.code = code;
  throw error;
}

// 用手机号 + 验证码登录；成功后 Cookie 落盘，后续抖音请求自动带上（登录态）
export async function loginBySmsCode(mobile, code) {
  const m = normalizeMobile(mobile);
  const c = String(code || '').replace(/[^\d]/g, '');
  if (!/^1\d{10}$/.test(m)) throw new Error('请输入 11 位手机号');
  if (!/^\d{4,6}$/.test(c)) throw new Error('请输入短信验证码');

  const params = { mobile: m, code: c, type: SMS_TYPE, aid: SMS_AID, service: 'https://www.toutiao.com' };
  const url = DOUYIN_SSO_API + 'web/sms_login/?' + queryString(params);
  let meta = await loginFetch(url);
  let collected = collectFrom(meta, url);
  let payload = meta.body;

  if (Number(payload && payload.error_code) === 16) {
    const postUrl = DOUYIN_SSO_API + 'web/sms_login/';
    meta = await loginFetch(postUrl, { method: 'POST', body: queryString(params) });
    collected = collectFrom(meta, postUrl);
    payload = meta.body;
  }

  // 成功时服务端可能同时用 redirect 下发会话，跟着走一遍把 Cookie 收全
  const redirect = extractNextUrl(payload) || '';
  if (Number(payload && payload.error_code) === 0 && redirect) {
    try {
      await followLoginRedirect(redirect, collected);
    } catch (error) { /* 尽力而为 */ }
    mergeCookies(collected);
  }

  const code0 = Number(payload && payload.error_code);
  const ok = code0 === 0;
  if (ok && hasLoginCookie()) await persistCookies();

  const nick = (m || '').replace(/^(\d{3})\d{4}(\d{4})$/, '$1****$2');
  return {
    ok: ok,
    errorCode: code0,
    descriptions: ok ? '' : describePassportError(payload),
    user: ok ? { nick: nick, id: m } : null,
    redirectUrl: redirect,
    cookieCount: cookieCount(),
    cookieKeys: cookieKeys()
  };
}
