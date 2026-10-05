// 登录态 Cookie 存储 / 提取 / 注入。
//
// 为什么需要这套东西：抖音的“登录态数据”（关注流、个人信息、更稳的接口配额）
// 都靠 Cookie。而 libjsapi 的原生 http **读不到响应头**（Set-Cookie 拿不到），
// 所以登录后我们按可靠性从高到低依次尝试：
//   1) 原生响应对象里若带 header/headers 字段（网络诊断会打印“响应外层键”），直接取 Set-Cookie；
//   2) 经 PC 中转（relay 的 &meta=1）拿响应头 —— 这是最可靠的一条；
//   3) 扫描可读到的响应体 / 跳转 URL 里的 name=value（尽力而为）。
// 取到后存本机，后续所有抖音请求都带上，实现“登录状态下的视频展示”。
import { jsapiStorageGet, jsapiStorageSet, jsapiStorageRemove } from './libjsapi.js';
import { DOUYIN_TTWID } from '../config.js';

const COOKIE_KEY = 'douyin_login_cookies_v1';

// 抖音/头条系关心的会话 cookie 名
const KNOWN_NAMES = [
  'sessionid', 'sessionid_ss', 'sid_tt', 'sid_guard', 'sid_ucp_v1', 'ssid_ucp_v1',
  'uid_tt', 'uid_tt_ss', 'passport_csrf_token', 'passport_csrf_token_default',
  'odin_tt', 'ttwid', 'msToken', 's_v_web_id', 'tt_scid', 'store-idc', 'store-country-code'
];

let jar = {};
let hydrated = false;

function isSessionName(name) {
  // 裸 token=… 是接口请求参数（如轮询令牌），不是 cookie，别当会话项注入
  if (name === 'token' || name === 'access_token' || name === 'refresh_token') return false;
  if (KNOWN_NAMES.indexOf(name) >= 0) return true;
  return /session|sid_|ttwid|msToken|passport_csrf/i.test(name);
}

// 从任意文本里扫 name=value（JSON、HTML、header 串都适用）。
// 值里排除 ; , 空白 引号 尖括号 反斜杠 以及 & = —— 否则 query 串里会把
// “csrf123456&other=1” 整体当成一个 cookie 的值。
// 同时兼容 JSON 形态 "name":"value"（有些登录响应会把会话直接放在 body 里，
// 这种不需要读响应头就能抓到，是“不开中转”的关键路径）。
function scanText(text, out) {
  const source = String(text || '');
  const patterns = [
    /([A-Za-z][A-Za-z0-9_.-]{2,30})=([^;,\s"'<>\\&=]{6,300})/g,
    /"([A-Za-z][A-Za-z0-9_.-]{2,30})"\s*:\s*"([^"]{6,300})"/g
  ];
  patterns.forEach((re) => {
    let match;
    while ((match = re.exec(source))) {
      const name = match[1];
      if (!isSessionName(name)) continue;
      if (out[name] === undefined) out[name] = match[2];
    }
  });
  return out;
}

export function captureCookiesFromText(text) {
  return scanText(text, {});
}

// 跳转 URL 的 query / hash 里可能带 token 类参数
export function captureCookiesFromUrl(url) {
  const text = String(url || '');
  if (!text) return {};
  const out = {};
  const query = text.indexOf('?') >= 0 ? text.slice(text.indexOf('?') + 1) : '';
  scanText(query, out);
  const hash = text.indexOf('#') >= 0 ? text.slice(text.indexOf('#') + 1) : '';
  scanText(hash, out);
  return out;
}

// 原生响应对象（或 relay meta 信封）里的响应头
export function captureCookiesFromHeaders(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object') return out;
  const containers = [raw, raw.header, raw.headers, raw.responseHeader, raw.responseHeaders];
  containers.forEach((box) => {
    if (!box || typeof box !== 'object') return;
    Object.keys(box).forEach((key) => {
      if (!/cookie/i.test(key)) return;
      const value = box[key];
      if (Array.isArray(value)) value.forEach((one) => scanText(String(one).split(';')[0], out));
      else scanText(String(value).split(';')[0], out);
    });
  });
  // 有些实现直接把 set-cookie 放在响应体外的独立字段
  ['set-cookie', 'setCookie', 'Set-Cookie', 'cookie', 'cookies'].forEach((key) => {
    const value = raw[key];
    if (!value) return;
    if (Array.isArray(value)) value.forEach((one) => scanText(String(one).split(';')[0], out));
    else scanText(String(value).split(';')[0], out);
  });
  return out;
}

// 明显不是 cookie 的名字（错误体、字段名等），任何来源都拒收
const BLOCKED_NAMES = [
  'error', 'errormessage', 'errcode', 'errmsg', 'message', 'description', 'code', 'data',
  'status', 'statuscode', 'result', 'token', 'accesstoken', 'type', 'mobile', 'password'
];

function isCookieValue(value) {
  const text = String(value || '');
  if (text.length < 6 || text.length > 300) return false;
  return !/[\s"'<>\\;,&=]/.test(text);
}

// 自动抓取时严格过滤；用户手动粘贴时放宽（那份就是完整 Cookie 串）
export function isAcceptableCookie(name, value, strict) {
  if (!name || BLOCKED_NAMES.indexOf(String(name).toLowerCase()) >= 0) return false;
  if (!isCookieValue(value)) return false;
  return strict === false ? true : isSessionName(name);
}

export function mergeCookies(pairs, strict) {
  const source = pairs || {};
  const useStrict = strict !== false;
  Object.keys(source).forEach((key) => {
    const value = source[key];
    if (value === undefined || value === null || value === '') return;
    if (!isAcceptableCookie(key, value, useStrict)) return;
    jar[key] = String(value);
  });
  return Object.keys(jar);
}

export function cookieKeys() {
  return Object.keys(jar);
}

export function cookieCount() {
  return Object.keys(jar).length;
}

// 是否存在“真正代表登录态”的 cookie（ttwid 只是设备标识，不算登录）
export function hasLoginCookie() {
  return Object.keys(jar).some((key) => key !== 'ttwid');
}

// 组装 Cookie 请求头：ttwid（优先用登录时拿到的）+ 其余登录 cookie
export function cookieHeader() {
  const parts = [];
  const ttwid = jar.ttwid || DOUYIN_TTWID;
  if (ttwid) parts.push('ttwid=' + ttwid);
  Object.keys(jar).forEach((key) => {
    if (key === 'ttwid') return;
    parts.push(key + '=' + jar[key]);
  });
  return parts.join('; ');
}

// 诊断用摘要（只列名字，不泄露值）
export function cookieSummary() {
  const keys = Object.keys(jar).filter((key) => key !== 'ttwid');
  if (!keys.length) return jar.ttwid ? '未获取到登录 Cookie（仅 ttwid 设备标识）' : '无 Cookie';
  return keys.length + ' 项：' + keys.slice(0, 4).join(',') + (keys.length > 4 ? ' …' : '');
}

export function currentJar() {
  return Object.assign({}, jar);
}

// 手动保存 Cookie（不依赖响应头，因而完全不需要中转）：
// 用户在电脑浏览器登录后，从开发者工具里复制整串 Cookie 粘进来即可。
// 这里用宽松过滤：粘贴的就是完整 Cookie 串，除了明显的错误字段名都留下。
export async function saveCookiesFromText(text) {
  const pairs = {};
  // 直接按 Cookie 串语法解析（name=value; name=value…），并兼容换行/逗号分隔
  String(text || '').split(/[;\n\r,]+/).forEach((part) => {
    const item = part.trim();
    if (!item) return;
    const eq = item.indexOf('=');
    if (eq <= 0) return;
    const name = item.slice(0, eq).trim();
    const value = item.slice(eq + 1).trim();
    if (isAcceptableCookie(name, value, false)) pairs[name] = value;
  });
  // 兜底：整串里再扫一遍（JSON 形态等）
  scanText(text, pairs);
  mergeCookies(pairs, false);
  await persistCookies();
  return { keys: cookieKeys(), count: cookieCount(), parsed: Object.keys(pairs).length };
}

// 诊断用：原生响应对象里到底有没有响应头（决定能否不开中转抓 Set-Cookie）
export function inspectRawForCookies(raw) {
  const found = captureCookiesFromHeaders(raw);
  return {
    envelopeKeys: raw && typeof raw === 'object' ? Object.keys(raw) : [],
    cookieNames: Object.keys(found),
    hasHeaders: !!(raw && typeof raw === 'object' && (raw.header || raw.headers || raw.responseHeader || raw.responseHeaders))
  };
}

export function clearCookies() {
  jar = {};
  hydrated = true;
  return jsapiStorageRemove(COOKIE_KEY).catch(() => {});
}

export function persistCookies() {
  return jsapiStorageSet(COOKIE_KEY, jar).catch(() => {});
}

// 启动时把本机存储里的 Cookie 灌进内存（之后 cookieHeader() 可同步调用）
// 顺带清洗历史脏数据：早期版本会把 {error, errorMessage} 这类错误字段当成 cookie 存下来，
// 那会让 hasLoginCookie() 误判为已登录，所以载入时按严格规则过一遍。
export async function loadCookies() {
  if (hydrated) return jar;
  hydrated = true;
  try {
    const stored = await jsapiStorageGet(COOKIE_KEY);
    const parsed = typeof stored === 'string' ? JSON.parse(stored) : stored;
    if (parsed && typeof parsed === 'object') {
      const clean = {};
      Object.keys(parsed).forEach((key) => {
        if (isAcceptableCookie(key, parsed[key], true)) clean[key] = parsed[key];
      });
      jar = clean;
      if (Object.keys(clean).length !== Object.keys(parsed).length) await persistCookies();
    }
  } catch (error) { /* 无 storage 模块（浏览器预览）时忽略 */ }
  return jar;
}
