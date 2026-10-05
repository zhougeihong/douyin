// libjsapi 网络适配层
// 后端已移除，所有 API 请求统一经由 HaaS libjsapi 的原生 http 模块发起：
//   $falcon.jsapi.http.request(options)
// 原生层（libjsapi，模拟器 appx.exe / 设备 libjsapi.so）基于 libcurl 实现，
// 回调返回 { result } 或 { errorMessage }。浏览器预览与抖音容器环境没有
// $falcon.jsapi，此处自动降级到 fetch / tt.request，对上层保持同一接口。
//
// 模拟器/无 TLS 固件的 libcurl 直连 https 会失败，因此配置了 API_RELAY 时优先走
// 本机中转（npm run relay）；中转不可用时自动回退直连 https（真机固件自带 TLS），
// 反之直连失败也会再试中转——任何一条通路活着，信息流就不会退回本地样板。

import { API_RELAY } from '../config.js';

function getNativeHttp() {
  if (typeof $falcon !== 'undefined' && $falcon && $falcon.jsapi && $falcon.jsapi.http) {
    return $falcon.jsapi.http;
  }
  return null;
}

function getTtRequest() {
  if (typeof tt !== 'undefined' && tt && typeof tt.request === 'function') {
    return tt.request.bind(tt);
  }
  return null;
}

function parseBody(payload) {
  if (payload === null || payload === undefined) return null;
  if (typeof payload !== 'string') return payload;
  const text = payload.trim();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch (error) {
    return text;
  }
}

function withTimeout(promise, timeoutMs, label) {
  if (!timeoutMs || typeof promise.then !== 'function') return promise;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(label + ' 超时（' + timeoutMs + 'ms）'));
    }, timeoutMs);
    promise.then((value) => {
      clearTimeout(timer);
      resolve(value);
    }, (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

// ---------- 原生响应剥壳 ----------
// 原生 libjsapi 把响应体包在 { result: <响应体> } 里；而词典笔这类固件的
// http.request() 还会「返回 Promise，且 resolve 出来的也是这层包装」。
// 旧代码让 Promise 的结算和 success 回调赛跑，Promise 先到就把整层包装
// 当成了响应体 → payload.code 取不到 → 所有接口都报「返回异常」并回退本地样例。
const ENVELOPE_META_KEYS = ['result', 'status', 'statusCode', 'header', 'headers', 'errMsg', 'errorMessage'];

// 只有「payload 字段」出现在这里才说明包装内是业务响应：{code,data,message}/{word_list}/{active_time}…
const BUSINESS_KEYS = ['code', 'data', 'message', 'word_list', 'active_time', 'extra', 'item_list'];

function hasAnyKey(obj, keys) {
  for (let i = 0; i < keys.length; i++) {
    if (obj[keys[i]] !== undefined) return true;
  }
  return false;
}

// 大小写不敏感地判断请求头里有没有某个字段（避免和调用方已设的 Content-Length 重复）
function hasHeader(header, name) {
  if (!header || typeof header !== 'object') return false;
  const keys = Object.keys(header);
  for (let i = 0; i < keys.length; i++) {
    if (keys[i].toLowerCase() === name) return true;
  }
  return false;
}

// UTF-8 字节数（Content-Length 要的是字节数，不是字符数——中文一个字 3 字节）
function utf8ByteLength(text) {
  let bytes = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff) { bytes += 4; i += 1; } // 代理对（emoji 等）
    else bytes += 3;
  }
  return bytes;
}

function isEnvelope(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return false;
  // 包装层固定是 {result:"<body 字符串>"}：result 必须是字符串（null/对象都不算）。
  // 这条也是多闪 PC 网关（src/services/chat-api.js）能正常工作的前提——
  // 网关响应经真机原生层回来同样是 {result:"{…ok/status/qr_png_b64…}"}，
  // 必须剥掉这一层，页面才拿得到 ok/status；此处**不能**因为
  // 「result 里是网关业务 JSON」就把它当成业务体留在包装里。
  if (typeof obj.result !== 'string') return false;
  if (hasAnyKey(obj, BUSINESS_KEYS)) return false;
  const keys = Object.keys(obj);
  for (let i = 0; i < keys.length; i++) {
    if (ENVELOPE_META_KEYS.indexOf(keys[i]) < 0) return false;
  }
  // 到这一步：外层只有 result(+其它元信息键)，形如 {result:"<body 字符串>"}。
  // 这**就是**包装层，必须剥掉——网关响应也是这么包进来的（真机实测）。
  return true;
}

// 统一剥壳，直到拿到真正的响应体（最多 4 层，防御异常嵌套）
// 说明：不判断「result 里是不是业务体」，因为 {result:"<任意 body>"} 一律是包装层；
// 反过来把网关响应留在包装里，页面就会拿到 undefined 的 ok/status。
function unwrapEnvelope(value, depth) {
  const level = depth || 0;
  if (level >= 4 || value === null || value === undefined) return value;

  if (typeof value === 'string') {
    const text = value.trim();
    if (text.charAt(0) !== '{') return value; // HTML/纯文本直接就是响应体
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      return value;
    }
    return isEnvelope(parsed) ? unwrapEnvelope(parsed.result, level + 1) : parsed;
  }

  if (typeof value !== 'object') return value;
  return isEnvelope(value) ? unwrapEnvelope(value.result, level + 1) : value;
}

// 调用原生 libjsapi http 模块。兼容回调与 Promise 两种封装。
// 两者可能都结算（真机上 Promise 先到，且带的是包装层）。规则：
//   · 谁先给出**非空**响应体就以谁为准；
//   · 空响应先记账，等另一条通路；已知通路都报了空才按空响应结算 —— 这样
//     “Promise 先回 undefined、真正的响应随后走 success 回调”的固件不会被误杀。
function viaNativeJsapi(http, options, timeoutMs) {
  return withTimeout(new Promise((resolve, reject) => {
    let done = false;
    let emptyReports = 0;
    let expectsCallback = true;   // success 回调
    let expectsPromise = false;   // http.request() 返回的 thenable

    const finish = (value) => {
      if (done) return;
      done = true;
      resolve(value);
    };

    const report = (value) => {
      if (done) return;
      const body = unwrapEnvelope(value);
      if (body !== null && body !== undefined && body !== '') {
        // 把**原始外层对象**一起带出去：诊断要据此判断固件有没有回传响应头
        // （Set-Cookie 决定“不开中转能不能抓到登录会话”），所以剥壳不能丢掉它。
        finish({ __envelope: value, body: body });
        return;
      }
      emptyReports += 1;
      const expected = (expectsCallback ? 1 : 0) + (expectsPromise ? 1 : 0);
      if (emptyReports >= (expected || 1)) finish(null);
    };

    // POST body 必须自己带 Content-Length：
    // gateway.py 的 do_POST 用 `int(self.headers.get('Content-Length') or 0)` 决定读多少字节，
    // 缺这个头就 read(0) → body 变 {} → 网关回「参数错误」。
    // 真机上 libjsapi 是否自动补 Content-Length 未实测（也无从在 PC 上确认），
    // 这里显式补上最稳妥：值算对了，重复设置也无害；算错了才会真出问题，故按 UTF-8 字节数算。
    const header = Object.assign({}, options.header);
    if (options.data !== undefined && options.data !== null && options.method !== 'GET') {
      const payload = typeof options.data === 'string' ? options.data : JSON.stringify(options.data);
      if (!hasHeader(header, 'content-length')) header['Content-Length'] = utf8ByteLength(payload);
    }

    const params = {
      url: options.url,
      method: options.method,
      header: header,
      headers: header,
      data: options.data,
      success: (res) => {
        const body = res && res.result !== undefined ? res.result : res && res.data !== undefined ? res.data : res;
        report(body);
      },
      fail: (err) => {
        if (done) return;
        done = true;
        const message = (err && (err.errorMessage || err.message || err.error)) || 'libjsapi http 请求失败';
        reject(new Error(message));
      }
    };

    let returned;
    try {
      returned = http.request(params);
    } catch (error) {
      done = true;
      reject(error);
      return;
    }
    // 注意：必须在 http.request() 返回之后再注册，且这段同步代码先跑完，
    // 因此 expectsPromise 一定在 Promise 的 then 回调（微任务）之前置位。
    if (returned && typeof returned.then === 'function') {
      expectsPromise = true;
      returned.then(
        (value) => report(value),
        (error) => {
          if (done) return;
          done = true;
          reject(error instanceof Error ? error : new Error(errText(error)));
        }
      );
    }
  }), timeoutMs, 'libjsapi http');
}

function viaFetch(options, timeoutMs) {
  const init = {
    method: options.method,
    headers: options.header
  };
  if (options.data !== undefined && options.method !== 'GET') {
    init.body = typeof options.data === 'string' ? options.data : JSON.stringify(options.data);
  }
  return withTimeout(fetch(options.url, init).then(async (response) => {
    const text = await response.text();
    if (response.status >= 400) {
      throw new Error('HTTP ' + response.status + '：' + text.slice(0, 120));
    }
    return text;
  }), timeoutMs, 'fetch');
}

function viaTt(options, timeoutMs) {
  return withTimeout(new Promise((resolve, reject) => {
    getTtRequest()({
      url: options.url,
      method: options.method,
      header: options.header,
      data: options.data,
      success: (response) => {
        if (response && response.statusCode >= 400) {
          reject(new Error('HTTP ' + response.statusCode));
          return;
        }
        resolve(response && response.data);
      },
      fail: (error) => reject(new Error((error && error.errMsg) || 'tt.request 请求失败'))
    });
  }), timeoutMs, 'tt.request');
}

// 构造经本机中转的 http URL（仅 https 目标需要）
function buildRelayUrl(url, header) {
  return API_RELAY + '/relay?url=' + encodeURIComponent(url) +
    '&h=' + encodeURIComponent(JSON.stringify(header || {}));
}

function errText(error) {
  return (error && (error.message || error.errorMessage)) || '请求失败';
}

// 把响应体压成一行短预览，供错误信息/网络诊断在设备小屏上直接显示“到底收到了什么”。
// 这是排查“接口返回异常”的关键：是空响应、HTML 门户页，还是别的包装结构，一眼可辨。
export function previewPayload(payload, max) {
  const limit = max || 80;
  if (payload === null) return 'null（空响应）';
  if (payload === undefined) return 'undefined（空响应）';
  if (typeof payload === 'string') {
    const text = payload.trim();
    if (!text) return '空字符串';
    return text.length > limit ? text.slice(0, limit) + '…' : text;
  }
  if (typeof payload === 'object') {
    try {
      const text = JSON.stringify(payload);
      return text.length > limit ? text.slice(0, limit) + '…' : text;
    } catch (error) {
      return '[对象]';
    }
  }
  return String(payload).slice(0, limit);
}

// 单次请求：按 原生 libjsapi → fetch → tt.request 的优先级依次尝试，
// 前一个通道不存在或失败时自动换下一个（真机/模拟器走 native，浏览器预览走 fetch，
// 抖音等小程序容器走 tt.request），并把各通道的失败原因汇总抛出。
// 各通道共享同一份超时预算，避免逐个通道各等一次把页面卡死。
function sendOnce({ url, headers, method, data }, timeoutMs) {
  const options = {
    url,
    method: String(method || 'GET').toUpperCase(),
    header: headers || undefined,
    data
  };

  const nativeHttp = getNativeHttp();
  const channels = [];
  if (nativeHttp) channels.push({ label: 'libjsapi', run: (ms) => viaNativeJsapi(nativeHttp, options, ms) });
  if (typeof fetch === 'function') channels.push({ label: 'fetch', run: (ms) => viaFetch(options, ms) });
  if (getTtRequest()) channels.push({ label: 'tt.request', run: (ms) => viaTt(options, ms) });
  if (!channels.length) {
    return Promise.reject(new Error('当前运行环境无可用网络通道（libjsapi / fetch / tt.request）'));
  }

  const failures = [];
  const deadline = timeoutMs ? Date.now() + timeoutMs : 0;
  const attempt = (index) => {
    if (index >= channels.length) return Promise.reject(new Error(failures.join('；')));
    const remaining = deadline ? deadline - Date.now() : 0;
    if (deadline && remaining <= 200) {
      failures.push(channels[index].label + '：超时预算已用尽');
      return Promise.reject(new Error(failures.join('；')));
    }
    return channels[index].run(remaining)
      .then((rawValue) => {
        // 原生通道会把「原始外层对象」一起回传，其它通道就是普通值
        const isNative = !!(rawValue && typeof rawValue === 'object' && rawValue.__envelope !== undefined);
        const envelope = isNative ? rawValue.__envelope : rawValue;
        const value = isNative ? rawValue.body : rawValue;
        const body = parseBody(unwrapEnvelope(value));
        // 关键：原生 libcurl 在“连不上”时经常仍走 success 回调、内容为空
        //（无 TLS 的 https、中转地址不可达都会这样）。把空响应当失败处理，
        // 后面的通道/直连-中转互备才有机会接管，而不是把空体当成成功往下传。
        if (body === null || body === undefined || body === '') {
          throw new Error('响应为空（原生层把连不上的请求回调成了成功，检查固件 TLS 或中转地址）');
        }
        return { body: body, raw: envelope };
      })
      .catch((error) => {
        failures.push(channels[index].label + '：' + errText(error));
        return attempt(index + 1);
      });
  };
  return attempt(0);
}

// 收集响应头（只留我们关心的：cookie / location / status / content-type）。
// 原生实现若把响应头放在 raw.header / raw.headers 里，就能从这里读到 Set-Cookie。
function normalizeHeaders(source) {
  const out = {};
  const boxes = [source, source && source.header, source && source.headers,
    source && source.responseHeader, source && source.responseHeaders];
  boxes.forEach((box) => {
    if (!box || typeof box !== 'object') return;
    Object.keys(box).forEach((key) => {
      if (!/cookie|location|status|content-type/i.test(key)) return;
      out[key] = box[key];
    });
  });
  return out;
}

// withMeta 时组装 { body, headers, raw, envelopeKeys }
// raw = **原始外层对象**（原生是 {result:…} 这一层），诊断据此判断固件是否回传响应头
function buildMeta(result, attempt) {
  let body = result.body;
  const envelope = result.raw;
  let headers = normalizeHeaders(envelope);
  // 经中转且带 meta=1 时，relay 把响应包成 {status, headers, body}
  if (attempt.relayMeta && body && typeof body === 'object' && body.body !== undefined) {
    headers = normalizeHeaders(body.headers || body.header || body);
    body = parseBody(unwrapEnvelope(body.body));
  }
  return {
    body: body,
    headers: headers,
    raw: envelope,
    envelopeKeys: envelope && typeof envelope === 'object' ? Object.keys(envelope) : []
  };
}

// 统一出口：返回解析后的响应体（JSON 或文本）
// 配置了中转时先走中转（无 TLS 固件的确定性路径），中转失败再自动直连重试——
// 否则“中转服务没开 / PC 换了网段”会把整条数据链路一次性打死，信息流静默回退本地样板。
// opts.direct = true 时只用直连（网络诊断用）。
// opts.withMeta = true 时返回 { body, headers, raw }（登录抓 Cookie 用）。
// opts.relayMeta = true 表示 URL 已经是调用方自己拼好的中转 meta 请求（如登录链路走 PC 中转）。
export function jsapiHttpRequest({ url, method = 'GET', headers, data, timeoutMs = 12000, direct = false, withMeta = false, relayMeta = false }) {
  if (!url) return Promise.reject(new Error('请求缺少 url'));

  const attempts = [];
  if (!direct && API_RELAY && getNativeHttp() && /^https:/i.test(url)) {
    attempts.push({
      label: '中转',
      url: buildRelayUrl(url, headers) + (withMeta ? '&meta=1' : ''),
      headers: undefined,
      // method/data 必须一起带上：漏了会让所有请求退化成 GET，
      // POST body 也会被静默丢掉（多闪 /api/send 就靠它）。
      method: method,
      data: data,
      relayMeta: withMeta
    });
  }
  attempts.push({
    label: '直连',
    url: url,
    headers: headers,
    method: method,
    data: data,
    relayMeta: withMeta && relayMeta
  });

  const failures = [];
  const attempt = (index) => {
    if (index >= attempts.length) return Promise.reject(new Error(failures.join('；')));
    return sendOnce(attempts[index], timeoutMs)
      .then((result) => (withMeta ? buildMeta(result, attempts[index]) : result.body))
      .catch((error) => {
        failures.push(attempts[index].label + '：' + errText(error));
        return attempt(index + 1);
      });
  };
  return attempt(0);
}

// 资源 URL（封面图等）包裹：仅原生环境且配置了中转时生效，
// 让无 TLS 的模拟器能通过本机中转加载 https 图片；浏览器预览不受影响。
export function relayAssetUrl(url) {
  if (!API_RELAY || !url || url.indexOf('https://') !== 0) return url || '';
  const nativeHttp = getNativeHttp();
  if (!nativeHttp) return url;
  return API_RELAY + '/relay?url=' + encodeURIComponent(url);
}

// ---------- 原生 storage 模块（libjsapi sharedpreferences） ----------

function getNativeStorage() {
  if (typeof $falcon !== 'undefined' && $falcon && $falcon.jsapi && $falcon.jsapi.storage) {
    return $falcon.jsapi.storage;
  }
  return null;
}

function jsapiStorageCall(module, method, params) {
  return new Promise((resolve, reject) => {
    const callParams = Object.assign({}, params, {
      success: (res) => resolve(res && res.result !== undefined ? res.result : res),
      fail: (err) => {
        const message = (err && (err.errorMessage || err.message)) || 'storage 调用失败';
        reject(new Error(message));
      }
    });
    let returned;
    try {
      returned = module[method](callParams);
    } catch (error) {
      reject(error);
      return;
    }
    if (returned && typeof returned.then === 'function') {
      returned.then(resolve, reject);
    }
  });
}

// 本机存储适配（对齐参考项目真机验证过的契约）：
//   1) **值必须 JSON 序列化后再存**——这台笔的 storage 只可靠处理字符串，
//      直接塞对象会读回废值（曾导致“登录完退出小程序又变未登录”）；
//   2) 读写都加超时 + 内存兜底，storage 慢/失败也不至于让功能卡死；
//   3) 同一 key 的写入串行，避免乱序覆盖。
const storageMemory = {};
const storageWriteChains = {};

function storageTimeout(promise, ms, fallback) {
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve(fallback);
    }, ms);
    const done = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    Promise.resolve(promise).then(done, () => done(fallback));
  });
}

function parseStored(raw) {
  if (typeof raw !== 'string') return raw;
  const text = raw.trim();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch (error) {
    return raw;
  }
}

export function jsapiStorageGet(key) {
  const storage = getNativeStorage();
  if (!storage || typeof storage.getStorage !== 'function') {
    return key in storageMemory
      ? Promise.resolve(storageMemory[key])
      : Promise.reject(new Error('当前运行环境无 storage 模块'));
  }
  return storageTimeout(
    jsapiStorageCall(storage, 'getStorage', { key: key }).then((res) => {
      const raw = res && typeof res === 'object' && res.data !== undefined ? res.data : res;
      const value = parseStored(raw);
      if (value !== null && value !== undefined) storageMemory[key] = value;
      return value;
    }),
    1500,
    key in storageMemory ? storageMemory[key] : null
  ).catch(() => (key in storageMemory ? storageMemory[key] : null));
}

export function jsapiStorageSet(key, data) {
  // 内存先落地，保证本次会话内一定能读到
  storageMemory[key] = data;
  const storage = getNativeStorage();
  if (!storage || typeof storage.setStorage !== 'function') {
    return Promise.resolve(false);
  }
  const payload = JSON.stringify(data);
  const prev = storageWriteChains[key] || Promise.resolve();
  const next = prev.then(() => storageTimeout(
    jsapiStorageCall(storage, 'setStorage', { key: key, data: payload }),
    3000,
    null
  )).catch(() => null);
  storageWriteChains[key] = next;
  return next;
}

export function jsapiStorageRemove(key) {
  delete storageMemory[key];
  const storage = getNativeStorage();
  if (!storage || typeof storage.removeStorage !== 'function') {
    return Promise.resolve(false);
  }
  return jsapiStorageCall(storage, 'removeStorage', { key: key }).catch(() => false);
}

// 诊断用：存储读写回环自检（登录态 / Cookie / 导入视频都依赖它持久化）
export async function storageSelfCheck() {
  const storage = getNativeStorage();
  if (!storage || typeof storage.setStorage !== 'function') {
    return { ok: false, reason: '设备无 storage 模块（只能用内存，重启即丢）' };
  }
  const key = '__douyin_storage_probe';
  const token = 'p' + Date.now();
  try {
    await jsapiStorageSet(key, { token: token });
    const back = await jsapiStorageGet(key);
    const ok = !!(back && back.token === token);
    jsapiStorageRemove(key);
    return { ok: ok, reason: ok ? 'OK' : ('回环不一致：' + String(JSON.stringify(back)).slice(0, 60)) };
  } catch (error) {
    return { ok: false, reason: (error && error.message) || '写入失败' };
  }
}
