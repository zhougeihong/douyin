// 前端签名适配层：把 ByteDance a_bogus 运行时包装成一个轻量接口，
// 避免将私有 SDK 直接塞进业务代码里，并确保在无签名运行时时给出清晰错误。
// 对接方式：
//   1) 运行时里若存在 window.getABogus / window.bdms.init._v[2].p[42]，直接用它；
//   2) 否则返回 { ok:false }，由调用方按普通 GET/POST 继续跑，
//      不会因为签名缺失直接炸掉整个链路。
//
// 这部分实现遵守“无后端 + 前端可执行”的边界：只做签名适配，不做暗网/私有依赖落地。

function getGlobal() {
  if (typeof globalThis !== 'undefined') return globalThis;
  if (typeof window !== 'undefined') return window;
  return null;
}

export function hasABogusRuntime() {
  const root = getGlobal();
  if (!root) return false;
  if (typeof root.getABogus === 'function') return true;
  if (root.bdms && typeof root.bdms.init === 'function' && root.bdms.init && root.bdms.init._v) return true;
  return false;
}

export function buildABogusQuery(query, data, uri, userAgent) {
  const root = getGlobal();
  if (!root || typeof root.getABogus !== 'function') {
    return { ok: false, value: '', note: '签名运行时未可用：未发现 window.getABogus' };
  }

  try {
    const raw = root.getABogus(query || '', data || '', uri || '', userAgent || '');
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (parsed && parsed.ok && parsed.value) {
      return { ok: true, value: String(parsed.value), raw: parsed };
    }
    return { ok: false, value: '', note: parsed && parsed.error ? parsed.error : 'ABogus returned invalid payload' };
  } catch (error) {
    return { ok: false, value: '', note: error && error.message ? error.message : '签名运行时异常' };
  }
}

function parseUrl(rawUrl) {
  try {
    const url = new URL(String(rawUrl || ''));
    return {
      base: url.origin + url.pathname,
      search: url.search.replace(/^\?/, ''),
      pathname: url.pathname,
      searchParams: url.searchParams
    };
  } catch (error) {
    const text = String(rawUrl || '');
    const idx = text.indexOf('?');
    return {
      base: idx >= 0 ? text.slice(0, idx) : text,
      search: idx >= 0 ? text.slice(idx + 1) : '',
      pathname: idx >= 0 ? text.slice(0, idx).split('/').slice(3).join('/') : text,
      searchParams: null
    };
  }
}

export function attachABogus(rawUrl, options) {
  const url = String(rawUrl || '');
  if (!url || !hasABogusRuntime()) {
    return {
      url,
      note: '签名运行时未可用：继续按普通请求链路运行',
      headers: (options && options.headers) || {}
    };
  }

  const config = options || {};
  const parsed = parseUrl(url);
  const qs = (config.queryString || parsed.search || '').trim();
  const uri = config.uri || parsed.pathname || '/';
  const body = config.body || '';
  const userAgent = config.userAgent || '';
  const generated = buildABogusQuery(qs, body, uri, userAgent);

  if (!generated.ok) {
    return {
      url,
      note: generated.note || '签名运行时未可用：继续按普通请求链路运行',
      headers: config.headers || {}
    };
  }

  const base = parsed.base;
  const nextQuery = qs ? (qs + '&a_bogus=' + encodeURIComponent(generated.value)) : ('a_bogus=' + encodeURIComponent(generated.value));
  return {
    url: base + '?' + nextQuery,
    note: '签名已注入',
    headers: config.headers || {}
  };
}

export function withABogus(rawUrl, options) {
  return attachABogus(rawUrl, options || {});
}
