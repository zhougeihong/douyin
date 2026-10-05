// 多闪（抖音私信）传输层 —— 对 PC 网关（dy-gateway/gateway.py）的 HTTP 客户端
//
// 移植自 D:\duoshan-pen-源码-20261004\duoshan-pen\miniapp\src\utils\{api.js,config.js}，
// 但按本工程的既有约定重写，**不是照搬**：
//   1) 网络统一走 src/services/libjsapi.js 的 jsapiHttpRequest()
//      —— 它已处理真机 `{result:"…"}` 剥壳、通道降级（libjsapi→fetch→tt）、超时预算；
//      原 api.js 自带一份 extractBody 剥壳，这里**删掉**，避免两套剥壳互相打架。
//   2) storage 走 jsapiStorageGet/Set（值已 JSON.stringify，见 HANDOFF §7.1）；
//      原 config.js 直接 setStorage({data: 字符串})，不走我们的 storage JSON 契约。
//   3) 原文件是 CommonJS（require/module.exports），本工程是 ESM（import/export）。
//   4) 回调风格（callback(err,res)）全部改成 Promise，和其它 service 一致。
//
// 网关接口契约（已对 gateway.py 实测 2026-10，见 HANDOFF §12）：
//   GET  /api/ping           → {ok,app,version,logged_in,uname,uid,wss,uptime_s}
//   GET  /api/status         → {logged_in,uname,uid}
//   GET  /api/qr/new         → {status,qr_png_b64,login_status,err}   ← 二维码是 **base64 PNG**
//   GET  /api/qr/status      → {status,qr_png_b64,login_status,err}
//   GET  /api/sessions       → {ok,uname,sessions:[{talker,name,last_text,last_time,unread}]}
//                            → 未登录时 {ok:false,need_login:true}
//   GET  /api/messages?talker= → {ok,name,messages:[{text,ts,from_me,server_id?}]}
//   GET  /api/log            → {ok,lines:[…]}
//   GET  /api/logout         → {ok}
//   POST /api/send   {talker,text}      → {ok} / {ok:false,msg} / {ok:false,need_login:true}
//   POST /api/rename {talker,name}      → {ok}
//   POST /api/read   {talker}           → {ok}
//   GET  /api/sms/send  /api/sms/submit → 网关**未实现**（gateway.py 里没有这两个路由），
//                                          调用会拿到 {"ok":false,"msg":"not found"}，故不封装。
//
// 注意：网关是局域网 http（不是 https），因此不会走 libjsapi 的 https 中转逻辑。

import {
  CHAT_GATEWAY_DEFAULT,
  CHAT_GATEWAY_PORT,
  CHAT_API_TIMEOUT_MS
} from '../config.js';
import { jsapiHttpRequest, jsapiStorageGet, jsapiStorageSet } from './libjsapi.js';

// storage key（沿用原 miniapp 的 key 名，便于两边对照排查）
export const GATEWAY_ADDR_KEY = 'dy_gateway_addr';

// ------------------------------------------------------------
// 网关地址：规范化 / 校验 / 持久化
// ------------------------------------------------------------

// 把用户输入收敛成 'http://host[:port]'。
// 容忍：带 http:// 前缀、带路径、带空格、只写 IP、写 IP:端口。
// 返回 '' 表示不合法（UI 据此报错，不要静默存坏值）。
export function normalizeGatewayAddr(raw) {
  let s = String(raw === null || raw === undefined ? '' : raw).trim();
  if (!s) return '';
  s = s.replace(/^https?:\/\//i, '');   // 去掉协议头（网关只有 http）
  s = s.split('/')[0];                  // 去掉尾部路径/斜杠
  s = s.trim();
  if (!s) return '';
  // 只留 ip / 域名 / 端口；其余字符（中文、空格、query）一律判非法
  if (!/^[0-9a-zA-Z.\-:]+$/.test(s)) return '';
  if (s.indexOf(':') < 0) s = s + ':' + CHAT_GATEWAY_PORT;
  // 端口必须是 1..65535 的纯数字，避免 '192.168.1.1:' / ':abc' 之类存进去
  const m = /^([^:]+):(\d{1,5})$/.exec(s);
  if (!m) return '';
  const port = parseInt(m[2], 10);
  if (!(port >= 1 && port <= 65535)) return '';
  const host = m[1];
  if (!host) return '';
  // 纯数字+点的写法一律当 IP，那就必须是合法 IPv4：
  // 否则 '192.168.1'（少打一段）会被悄悄补成 'http://192.168.1:8090' 存下来，
  // 之后只表现为「连不上」，用户根本看不出是地址打错了。
  // 含字母的仍按主机名放行（局域网里用电脑名也常见）。
  if (/^[0-9.]+$/.test(host) && !isIPv4(host)) return '';
  return 'http://' + host + ':' + port;
}

function isIPv4(host) {
  const parts = host.split('.');
  if (parts.length !== 4) return false;
  for (let i = 0; i < 4; i++) {
    if (!/^\d{1,3}$/.test(parts[i])) return false;
    if (parseInt(parts[i], 10) > 255) return false;
  }
  return true;
}

export function isValidGatewayAddr(raw) {
  return normalizeGatewayAddr(raw) !== '';
}

// 内存缓存：避免每次请求都读 storage（与 libjsapi 的 storage 内存兜底互补）
let cachedAddr = '';
let addrLoaded = false;

export function getGatewayAddr() {
  return cachedAddr;
}

// 读一次并缓存。永远 resolve（读不到就给默认值），不 reject —— 页面 onLoad 不该被它打断。
export function loadGatewayAddr() {
  if (addrLoaded) return Promise.resolve(cachedAddr);
  return jsapiStorageGet(GATEWAY_ADDR_KEY).then((stored) => {
    const normalized = normalizeGatewayAddr(stored);
    if (normalized) {
      cachedAddr = normalized;
    } else if (CHAT_GATEWAY_DEFAULT) {
      cachedAddr = normalizeGatewayAddr(CHAT_GATEWAY_DEFAULT);
    }
    addrLoaded = true;
    return cachedAddr;
  }).catch(() => {
    cachedAddr = CHAT_GATEWAY_DEFAULT ? normalizeGatewayAddr(CHAT_GATEWAY_DEFAULT) : '';
    addrLoaded = true;
    return cachedAddr;
  });
}

// 保存地址。不合法返回 false 且**不写 storage**（避免把坏值持久化）。
export function saveGatewayAddr(raw) {
  const normalized = normalizeGatewayAddr(raw);
  if (!normalized) return Promise.resolve(false);
  cachedAddr = normalized;
  addrLoaded = true;
  // 存字符串；jsapiStorageSet 内部会 JSON.stringify（§7.1 的 storage 契约）
  return jsapiStorageSet(GATEWAY_ADDR_KEY, normalized).then(() => true);
}

// 测试用：清掉内存缓存
export function resetGatewayAddrCache() {
  cachedAddr = '';
  addrLoaded = false;
}

// ------------------------------------------------------------
// 传输
// ------------------------------------------------------------

function requireAddr() {
  if (!cachedAddr) {
    const error = new Error('未设置网关地址（在「我的」页填电脑的局域网 IP:端口）');
    error.code = 'no_gateway';
    throw error;
  }
  return cachedAddr;
}

function request(path, { method = 'GET', data } = {}) {
  let base;
  try {
    base = requireAddr();
  } catch (error) {
    return Promise.reject(error);
  }
  return jsapiHttpRequest({
    url: base + path,
    method: method,
    headers: { 'Content-Type': 'application/json' },
    data: data,
    timeoutMs: CHAT_API_TIMEOUT_MS
  });
}

function get(path) {
  return request(path, { method: 'GET' });
}

function post(path, body) {
  return request(path, { method: 'POST', data: JSON.stringify(body) });
}

// 网关把「业务失败」也放在 200 里（ok:false + msg），
// 这里统一成一个 Error，方便页面只写一次 catch。
function fail(res, fallback) {
  const error = new Error((res && res.msg) || fallback);
  error.payload = res;
  if (res && res.need_login) error.code = 'need_login';
  return error;
}

// ------------------------------------------------------------
// 接口封装
// ------------------------------------------------------------

// 网关探测（带运行状态）。返回原始 ping 体，页面据此显示「已连接/连不上」。
export function chatPing() {
  return get('/api/ping').then((res) => {
    if (!res || typeof res !== 'object' || res.ok !== true) {
      throw fail(res, '网关响应异常（不是 dy-gateway？）');
    }
    return res;
  });
}

// 登录态（轻量，不带 wss/uptime）
export function chatStatus() {
  return get('/api/status');
}

// 发起扫码登录 / 取当前二维码。
// 返回 {status,qr_png_b64,login_status,err}；已登录时网关直接回 {status:'confirmed',uname}。
// status: generating（正在生成，qr_png_b64 为空）/ waiting（二维码已就绪）/ confirmed / error
export function chatQrNew() {
  return get('/api/qr/new');
}

// 轮询扫码状态。返回体与 chatQrNew 同构。
export function chatQrStatus() {
  return get('/api/qr/status');
}

// 把 qr_png_b64 转成 <image> 能直接用的 data URL（空串表示还没生成）
export function qrImageSrc(res) {
  const b64 = res && res.qr_png_b64;
  return b64 ? 'data:image/png;base64,' + b64 : '';
}

// 会话列表。未登录 → 抛 code==='need_login' 的错。
export function chatSessions() {
  return get('/api/sessions').then((res) => {
    if (res && res.need_login) throw fail(res, '未登录');
    if (!res || !Array.isArray(res.sessions)) throw fail(res, '会话列表格式异常');
    return res;
  });
}

// 某个会话的消息记录（网关最多给最近 100 条，读取时顺带把未读清零）
export function chatMessages(talker) {
  if (talker === null || talker === undefined || talker === '') {
    return Promise.reject(new Error('缺少 talker'));
  }
  return get('/api/messages?talker=' + encodeURIComponent(String(talker))).then((res) => {
    if (res && res.need_login) throw fail(res, '未登录');
    if (!res || !Array.isArray(res.messages)) throw fail(res, '消息格式异常');
    return res;
  });
}

// 发私信
export function chatSend(talker, text) {
  if (!talker || !text) return Promise.reject(new Error('talker 与 text 都不能为空'));
  return post('/api/send', { talker: String(talker), text: String(text) }).then((res) => {
    if (res && res.need_login) throw fail(res, '未登录');
    if (!res || res.ok !== true) throw fail(res, '发送失败');
    return res;
  });
}

// 手动备注昵称
export function chatRename(talker, name) {
  if (!talker || !name) return Promise.reject(new Error('talker 与 name 都不能为空'));
  return post('/api/rename', { talker: String(talker), name: String(name) }).then((res) => {
    if (!res || res.ok !== true) throw fail(res, '改名失败');
    return res;
  });
}

// 标记已读（网关侧清零未读；不传 talker 则全部清零）
export function chatRead(talker) {
  const body = talker ? { talker: String(talker) } : {};
  return post('/api/read', body).then((res) => {
    if (!res || res.ok !== true) throw fail(res, '标记已读失败');
    return res;
  });
}

// 网关日志（排查用，最多 80 行）
export function chatLog() {
  return get('/api/log');
}

// 退出登录（清网关侧登录态与 dy-session.json）
export function chatLogout() {
  return get('/api/logout');
}
