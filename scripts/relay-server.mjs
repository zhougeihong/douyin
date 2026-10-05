// 本机 HTTPS 中转服务：给无 TLS 的模拟器 libcurl 提供“http 进、https 出”转发
// 用法：npm run relay        （监听 http://127.0.0.1:8712，端口可用 RELAY_PORT 覆盖）
// 请求：GET /relay?url=<encodeURIComponent(https地址)>&h=<encodeURIComponent(JSON(headers))>
// 场景：Windows 模拟器的原生 libcurl 未编译 HTTPS（Protocol "https" not supported），
//       信息流/扫码登录等 https 接口在模拟器内直连全失败；跑起本服务后，
//       libjsapi 适配层会自动把失败的 https 请求改走本机中转，模拟器恢复全功能。
//       真机固件 libcurl 自带 TLS，直连即可（把 src/config.js 的 API_RELAY 置空）。
import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// RELAY_HOST：默认 127.0.0.1（Windows 模拟器演示）。
// 真机（无 TLS 固件）中转：设为 0.0.0.0 监听局域网，词典笔用 http://<PC局域网IP>:8712 访问。
const HOST = process.env.RELAY_HOST || '127.0.0.1';
const PORT = Number(process.env.RELAY_PORT || 8712);
const LOG_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '.temp', 'relay-access.log');

function logAccess(target, status, req) {
  try {
    // 记录客户端 IP：一眼看出请求到底来自本机脚本还是词典笔（排查“笔端连不上中转”的关键）
    const from = (req && req.socket && req.socket.remoteAddress) || '-';
    fs.appendFileSync(LOG_FILE, new Date().toISOString() + ' ' + status + ' from=' + from + ' ' + target + '\n');
  } catch (e) { /* 日志失败不影响转发 */ }
}
const DEFAULT_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';

const server = http.createServer((req, res) => {
  let q;
  try {
    q = new URL(req.url, 'http://127.0.0.1');
  } catch (e) {
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'bad request' }));
    return;
  }

  if (q.pathname !== '/relay') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, msg: 'relay alive', usage: '/relay?url=<https地址>&h=<JSON headers>' }));
    return;
  }

  const target = q.searchParams.get('url') || '';
  // meta=1：把响应头一起回传（JSON 信封），设备端据此拿 Set-Cookie 做登录态
  const wantMeta = q.searchParams.get('meta') === '1';
  // probe=1：**只探测可达性**，不把媒体流传给设备。
  //   为什么需要：设备的 JS 通道**绝不能自己去 GET 视频地址**（二进制灌进原生字符串通道
  //   → 词典笔软重启，见 HANDOFF §9/§13.10）。所以把"这个入口最终能不能连上"这件事
  //   交给 PC 中转做，设备只读一个几十字节的 JSON。
  //   实测背景（§13.9）：抖音会把视频解析到**已坏的 CDN 主机**
  //   （如 v95-bjb-mc-cold.douyinvod.com，DNS 永久 ENOTFOUND），
  //   且**同一个 uri 的落点主机是固定的**（连续 6 次都一样）→ 多入口轮换救不了它。
  const wantProbe = q.searchParams.get('probe') === '1';
  let targetUrl;
  try {
    targetUrl = new URL(target);
  } catch (e) {
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ relay_error: 'bad url' }));
    return;
  }
  if (targetUrl.protocol !== 'https:') {
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ relay_error: 'only https targets are relayed' }));
    return;
  }

  let extraHeaders = {};
  try {
    extraHeaders = JSON.parse(q.searchParams.get('h') || '{}') || {};
  } catch (e) { /* 忽略坏的 header 参数 */ }

  // 转发 Range：原生视频解码器（FFmpeg）靠它做 seek，缺了就只能从头顺序读
  const range = req.headers['range'];
  const upstreamHeaders = Object.assign({
    'User-Agent': DEFAULT_UA,
    'Accept': '*/*',
    'Accept-Language': 'zh-CN,zh;q=0.9'
  }, extraHeaders);
  if (range) upstreamHeaders.Range = range;
  // 抖音系 CDN 的 302 落点**要求带 Referer**，否则一律 403：
  // 实测 https://www.douyin.com/aweme/v1/play/?video_id=… 会 302 到
  // douyinvod.com，而同一次请求**不带 Referer 时落点是 403 text/html**。
  // 设备的 FFmpeg 跟 302 时不会把 Referer 带过去，所以这条路必须由中转补齐。
  if (isDouyinHost(targetUrl.hostname) && !upstreamHeaders.Referer && !upstreamHeaders.referer) {
    upstreamHeaders.Referer = 'https://www.douyin.com/';
  }
  // POST 支持：ttwid 注册等接口是 POST，需要把方法与 body 一起转发
  const method = String(req.method || 'GET').toUpperCase();
  const bodyChunks = [];
  req.on('data', (c) => bodyChunks.push(c));
  req.on('end', () => {
    const reqBody = Buffer.concat(bodyChunks);
    if (reqBody.length) upstreamHeaders['Content-Length'] = reqBody.length;
    if (req.headers['content-type'] && !upstreamHeaders['Content-Type']) {
      upstreamHeaders['Content-Type'] = req.headers['content-type'];
    }

  // 跟随 302/301（最多 3 跳，且**每跳都带上 Reference/Range**）。
  // 抖音视频的 /aweme/v1/play/ 入口本身就是 302 跳板：不跟的话，
  // 设备拿到的只是那 600 字节的跳转体，FFmpeg 直接 open-failed。
  followUpstream(targetUrl, { method, headers: upstreamHeaders, body: reqBody, hops: 3 }, (ur) => {
    logAccess(target, ur.statusCode || 502, req);
    if (wantProbe) {
      // 只回"能不能连上 + 落点主机 + 状态码"，**不转发 body**，设备端拿到的永远是几百字节。
      // 判据：2xx/3xx 且 content-type 像媒体 → ok；否则不可达/不可播。
      const ct = String(ur.headers['content-type'] || '');
      const ok = (ur.statusCode >= 200 && ur.statusCode < 400);
      let landingHost = '';
      try { landingHost = new URL(target).hostname; } catch (e) { /* 忽略 */ }
      res.writeHead(200, { 'content-type': 'application/json', 'x-relayed': '1' });
      res.end(JSON.stringify({
        probe: 1,
        ok: ok,
        status: ur.statusCode || 502,
        contentType: ct,
        looksVideo: /video|octet-stream/i.test(ct),
        length: ur.headers['content-length'] || '',
        entryHost: landingHost
      }));
      ur.resume();   // 丢掉 body，避免上游连接挂住
      return;
    }
    if (wantMeta) {
      // 收全再回：设备端只能读 body，读不到响应头，所以把 header 塞进信封
      const chunks = [];
      ur.on('data', (c) => chunks.push(c));
      ur.on('end', () => {
        res.writeHead(200, { 'content-type': 'application/json', 'x-relayed': '1' });
        res.end(JSON.stringify({
          status: ur.statusCode || 502,
          headers: ur.headers,
          body: Buffer.concat(chunks).toString('utf8')
        }));
      });
      return;
    }
    // 注意：Node 对 undefined 的 header 值会直接抛 ERR_HTTP_INVALID_HEADER_VALUE
    // （曾因此把中转进程打死），所以只挂确实存在的头。
    const outHeaders = {
      'content-type': ur.headers['content-type'] || 'application/octet-stream',
      'accept-ranges': ur.headers['accept-ranges'] || 'bytes',
      'x-relayed': '1'
    };
    if (ur.headers['content-length']) outHeaders['content-length'] = ur.headers['content-length'];
    if (ur.headers['content-range']) outHeaders['content-range'] = ur.headers['content-range'];
    res.writeHead(ur.statusCode || 502, outHeaders);
    ur.pipe(res);
  }, (e) => {
    const msg = String(e && e.message || e);
    logAccess(target, 'ERR ' + msg, req);
    if (!res.headersSent) {
      // probe 模式**必须回 200 + ok:false**，不能用 502 —— 否则设备端把"连不上"当成
      // "中转本身出错"，分不清是入口坏还是中转坏（实测坏主机走这里）。
      if (wantProbe) {
        res.writeHead(200, { 'content-type': 'application/json', 'x-relayed': '1' });
        res.end(JSON.stringify({ probe: 1, ok: false, status: 0, error: msg }));
      } else {
        res.writeHead(502, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ relay_error: msg }));
      }
    } else {
      res.end();
    }
  });
  });
});

// 跟随上游 3xx（最多 hops 跳），每跳都保留方法/Range/Referer。
// 抖音视频的 /aweme/v1/play/ 入口就是 302 跳板，不跟的话设备只拿到跳转体 → FFmpeg open-failed。
function followUpstream(targetUrl, opt, onResponse, onError) {
  const hops = Number(opt.hops || 0);
  const u = https.request({
    hostname: targetUrl.hostname,
    port: 443,
    path: targetUrl.pathname + targetUrl.search,
    method: opt.method,
    headers: opt.headers,
    timeout: 20000
  }, (ur) => {
    const code = ur.statusCode || 0;
    if (code >= 301 && code <= 308 && ur.headers.location && hops > 0) {
      ur.resume();
      let next;
      try {
        next = new URL(ur.headers.location, targetUrl.href);
      } catch (e) {
        onError(new Error('bad redirect location: ' + ur.headers.location));
        return;
      }
      // 跳转到 CDN 后同样要带 Referer（实测不带就是 403）
      const nextHeaders = Object.assign({}, opt.headers);
      if (isDouyinHost(next.hostname) && !nextHeaders.Referer) {
        nextHeaders.Referer = 'https://www.douyin.com/';
      }
      delete nextHeaders['Content-Length'];
      followUpstream(next, {
        method: 'GET',                 // 3xx 之后一律 GET（视频跳转都是 GET）
        headers: nextHeaders,
        body: null,
        hops: hops - 1
      }, onResponse, onError);
      return;
    }
    onResponse(ur);
  });
  u.on('timeout', () => u.destroy(new Error('upstream timeout')));
  u.on('error', onError);
  if (opt.body && opt.body.length) u.write(opt.body);
  u.end();
}

function isDouyinHost(host) {
  return /(^|\.)(douyin\.com|iesdouyin\.com|snssdk\.com|amemv\.com|douyinvod\.com|douyinpic\.com|byteicdn\.com|bytedance\.com|pstatp\.com)$/i
    .test(String(host || ''));
}

server.on('clientError', (err, socket) => socket.destroy());

// 兜底：单个请求出错（例如上游返回怪异头）不能把常驻中转打死
process.on('uncaughtException', (err) => {
  console.error('[relay] uncaught: ' + ((err && err.stack) || err));
});
process.on('unhandledRejection', (err) => {
  console.error('[relay] unhandled rejection: ' + ((err && err.stack) || err));
});

server.listen(PORT, HOST, () => {
  console.log('[relay] listening on http://' + HOST + ':' + PORT + '  (https -> 本机转发)');
  if (HOST === '0.0.0.0') {
    console.log('[relay] 局域网模式：词典笔/真机侧 config.js 的 API_RELAY 填 http://<本机局域网IP>:' + PORT);
  } else {
    console.log('[relay] ⚠ 仅本机可访问（只够 Windows 模拟器用）。词典笔/真机需要局域网监听，');
    console.log('[relay]   请改用：npm run relay   （已默认 RELAY_HOST=0.0.0.0）');
  }
});
