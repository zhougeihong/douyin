// 前端数据链路自测（无需模拟器）：
// 1) 把 src 下的 services/config/data 复制为 .mjs（Node 16 把 .js 视为 CJS）
// 2) 用符合 libjsapi 原生契约的 http 桩替换 $falcon.jsapi.http，走真实第三方 API
// 3) 断言 适配层 -> douyin-api -> video.js -> normalize 全链路
// 用法：node scripts/test-services.mjs
import fs from 'node:fs';
import path from 'node:path';
import https from 'node:https';
import http from 'node:http';
import subprocess from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const cacheDir = path.join(root, '.temp', 'service-test-src');
const importCached = (rel) => import(pathToFileURL(path.join(cacheDir, rel)).href);

// API_RELAY 启用时（真机局域网中转配置）自动拉起本机 relay，保证测试自包含
let relayProc = null;
const relayCfg = io_read(path.join(root, 'src', 'config.js'));
if (/API_RELAY = 'http:\/\//.test(relayCfg)) {
  relayProc = subprocess.spawn(process.execPath, [path.join(root, 'scripts', 'relay-server.mjs')], {
    env: Object.assign({}, process.env, { RELAY_HOST: '0.0.0.0' }),
    stdio: 'ignore'
  });
  await new Promise((r) => setTimeout(r, 1500));
}

function io_read(p) {
  try { return fs.readFileSync(p, 'utf8'); } catch (e) { return ''; }
}

fs.rmSync(cacheDir, { recursive: true, force: true });
for (const dir of ['services', 'utils', 'data']) fs.mkdirSync(path.join(cacheDir, dir), { recursive: true });

const FILES = [
  ['services/libjsapi.js', 'services/libjsapi.mjs'],
  ['services/douyin-api.js', 'services/douyin-api.mjs'],
  ['services/douyin-auth.js', 'services/douyin-auth.mjs'],
  ['services/abogus.js', 'services/abogus.mjs'],
  ['services/session-cookies.js', 'services/session-cookies.mjs'],
  ['services/ttwid.js', 'services/ttwid.mjs'],
  ['services/video.js', 'services/video.mjs'],
  ['services/chat-api.js', 'services/chat-api.mjs'],
  ['services/toutiao-api.js', 'services/toutiao-api.mjs'],
  ['services/fanqie-api.js', 'services/fanqie-api.mjs'],
  ['services/native-player.js', 'services/native-player.mjs'],
  ['services/local-import.js', 'services/local-import.mjs'],
  ['utils/auth.js', 'utils/auth.mjs'],
  ['utils/user-state.js', 'utils/user-state.mjs'],
  ['config.js', 'config.mjs'],
  ['data/local-videos.js', 'data/local-videos.mjs']
];
for (const [from, to] of FILES) {
  const text = fs.readFileSync(path.join(root, 'src', from), 'utf8')
    .replace(/from '(\.[^']*?)\.js'/g, (m, p) => `from '${p}.mjs'`);
  fs.writeFileSync(path.join(cacheDir, to), text);
}

function nodeGetText(url, headers) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https:') ? https : http;
    const req = client.get(url, { headers: headers || { 'User-Agent': 'Mozilla/5.0' } }, (res) => {
      // ⚠️ 这个桩**会跟随重定向**，但**真实固件不会**（HANDOFF §12.10：
      //    jsapiHttpRequest 与 relay 都不跟随重定向）。这里跟随只是为了桩自身好用
      //    （短链解析等），**不要**因此以为生产环境也跟随 —— 两者行为不同。
      if (res.statusCode >= 301 && res.statusCode <= 308 && res.headers.location) {
        res.resume();
        nodeGetText(new URL(res.headers.location, url).href, headers).then(resolve, reject);
        return;
      }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    });
    req.on('error', reject);
    req.setTimeout(15000, () => req.destroy(new Error('stub timeout')));
  });
}

globalThis.$falcon = {
  jsapi: {
    http: {
      // 模拟原生：转发 header（UA/Cookie 至关重要），回调 {result: <字符串>}
      request(params) {
        nodeGetText(params.url, params.header || params.headers)
          .then((text) => setTimeout(() => params.success({ result: text }), 10))
          .catch((err) => setTimeout(() => params.fail({ errorMessage: String(err) }), 10));
      }
    },
    // 模拟原生 storage 模块（内存键值）
    storage: (() => {
      const db = {};
      return {
        getStorage(params) {
          const v = db[params.key] !== undefined ? { data: db[params.key] } : { data: null };
          setTimeout(() => params.success({ result: v }), 5);
        },
        setStorage(params) {
          db[params.key] = params.data;
          setTimeout(() => params.success({ result: 'ok' }), 5);
        },
        removeStorage(params) {
          delete db[params.key];
          setTimeout(() => params.success({ result: 'ok' }), 5);
        }
      };
    })()
  }
};

const { fetchVideoList, resolveVideoForItem, isVideoLink } = await importCached('services/video.mjs');
const { fetchHotWords } = await importCached('services/douyin-api.mjs');
const { resolveVideoFromLink, createVideoFromLink, normalizeDouyinVideoUrl } = await importCached('services/local-import.mjs');
const { hasABogusRuntime, attachABogus, buildABogusQuery } = await importCached('services/abogus.mjs');

const lines = [];
const assert = (cond, msg) => lines.push((cond ? 'PASS ' : 'FAIL ') + msg);

// 说明：这个文件里凡是**依赖第三方接口当时是否可用**的断言，一律用 NOTE 而不是 FAIL
//（沿用本文件既有的"分享页限流只记 NOTE"约定）——否则网络抖动会让回归结果随机变红。
// 纯函数/契约类断言（如 douyinPlayUrl、剥壳、storage 契约）才是硬断言。
const note = (msg) => lines.push('NOTE ' + msg);

const result = await fetchVideoList();
assert(Array.isArray(result.list) && result.list.length > 0, '列表条数 = ' + result.list.length);

// ① 官方 web 视频流：这是能"刷视频"的源 —— 每条都**必须自带可播地址**
const webItems = result.list.filter((it) => it.source === 'douyin-web-feed');
if (webItems.length) {
  assert(result.dataSource.indexOf('官方视频流') === 0, '数据源选择 = ' + result.dataSource);
  assert(webItems[0] === result.list[0], '官方视频流排在列表最前');
  assert(webItems.every((it) => /^https:\/\/www\.douyin\.com\/aweme\/v1\/play\/\?video_id=/.test(it.playUrl)),
    '官方视频流每条都带 /aweme/v1/play 播放地址');
  assert(webItems.every((it) => !!it.videoId && !!it.title && !!it.author), '官方视频流带 videoId/标题/作者');
  // 关键回归：**不能**把 douyinvod CDN 直链塞进 playCandidates
  // —— 实测那些直链恒 403，而 nativePlayableUrl 会优先挑"直链 CDN"，塞进去反而会选中坏地址
  assert(webItems.every((it) => !(it.playCandidates || []).some((u) => /douyinvod/.test(u))),
    '官方视频流不塞 CDN 直链进 playCandidates（那些直链实测 403）');
  note('官方视频流条目数 = ' + webItems.length);
} else {
  note('官方视频流本次没拿到数据（接口限流/网络），已跳过相关断言（不视为失败）');
}

// ② 可解析的视频条目：启动时不解析（避免烧掉分享页的限流额度）。
// 注意：它们排在官方视频流之后，可能被 FEED_LIMIT 截掉，所以这里不要求必须有。
const videoItems = result.list.filter((it) => it.source === 'video-link');
if (videoItems.length) {
  assert(videoItems.every((it) => !!it.videoLink && isVideoLink(it.videoLink)), '视频条目都带可解析链接');
  assert(videoItems.every((it) => !it.playUrl), '启动时不预解析（playUrl 留空，等点开时解析）');
  note('视频条目数 = ' + videoItems.length);
} else {
  note('本次列表里没有 video-link 条目（可能被 FEED_LIMIT 截掉或链接已失效）');
}

// ③ 热榜条目：按 source 找，不要按下标（官方视频流现在排在更前面）
const hotItems = result.list.filter((it) => it.source === 'hot-feed');
if (hotItems.length) {
  const first = hotItems[0];
  assert(!!first.title, '热榜首条标题 = ' + String(first.title).slice(0, 20));
  assert(first.likes > 0, '热榜首条热度 = ' + first.likes);
  // 热榜是「话题」：大多没有视频文件。个别条目的链接可能恰好指向某条视频，
  // 所以不断言"每一条都不是视频"，只要求存在话题条目（这才是热榜的本质特征）。
  assert(hotItems.some((it) => !isVideoLink(it.url)),
    '热榜里存在"话题"条目 = ' + hotItems.filter((it) => !isVideoLink(it.url)).length + '/' + hotItems.length);
} else {
  note('本次没有抖音热榜条目（接口抖动），已跳过相关断言');
}

// 按需解析：点开视频条目时才请求分享页换 playUrl。
// 分享页会被抖音按 IP 限流（实测连续请求返回 2.5KB 风控页），失败只记 NOTE 不算用例失败。
if (videoItems.length) {
  try {
    const resolved = await resolveVideoForItem(videoItems[0]);
    assert(/^https:\/\/aweme\.snssdk\.com\/aweme\/v1\/play\//.test(resolved.playUrl),
      '按需解析出播放地址 = ' + String(resolved.playUrl).slice(0, 56));
    assert(!!resolved.cover && !!resolved.title, '按需解析带封面与标题 = ' + String(resolved.title).slice(0, 20));
  } catch (error) {
    console.log('NOTE 按需解析未成功（分享页被限流或该视频失效）：' + error.message);
  }
}

// ⚠️ fetchHotWords 直连第三方接口（iesdouyin），**必须包 try/catch 降级为 NOTE**：
//    本文件开头的约定就是"依赖第三方接口当时可用性的断言一律用 NOTE 而不是 FAIL"。
//    以前这行没保护，接口一抖就抛异常把整个测试套件带崩（而不是记一条 NOTE）。
try {
  const words = await fetchHotWords();
  assert(Array.isArray(words) && words.length > 0, '热搜词条数 = ' + words.length);
  assert(words[0].author === '抖音热搜', '备用源作者 = ' + words[0].author);
} catch (error) {
  console.log('NOTE 热搜词未取到（第三方接口抖动，非本工程问题）：' + ((error && error.message) || ''));
}

assert(normalizeDouyinVideoUrl('https://www.douyin.com/video/1234567890123456789') !== '', '链接校验通过');

// 3b) 内置视频解析链：分享页 + ttwid -> 播放地址
const parsed = await resolveVideoFromLink('https://www.douyin.com/video/7419207373887147316', 0);
assert(parsed.source === 'share-parse' || parsed.source === 'parse-api' || parsed.source === 'local-import',
  '导入来源 = ' + parsed.source);
if (parsed.source === 'share-parse' || parsed.source === 'parse-api') {
  assert(!!parsed.title && parsed.title !== '解析视频', '解析标题 = ' + parsed.title.slice(0, 30));
  assert(!!parsed.author, '解析作者 = ' + parsed.author);
  assert(/^https:\/\/aweme\.snssdk\.com\/aweme\/v1\/play\/\?video_id=/.test(parsed.playUrl),
    '播放地址(无水印) = ' + parsed.playUrl.slice(0, 72));
  assert(/^https?:\/\//.test(parsed.cover), '解析封面存在 = ' + parsed.cover.slice(0, 60));
} else {
  console.log('NOTE 解析不可用（可能 ttwid 失效），已按本地导入兜底：' + parsed.videoId);
}

const imported = await resolveVideoFromLink('看看这个 https://v.douyin.com/iRNBho6u/ ', 1);
if (imported.source === 'share-parse') {
  assert(/^\d{8,}$/.test(imported.videoId), '短链重定向解析 videoId = ' + imported.videoId);
} else {
  console.log('NOTE 示例短链不可用（可能已过期），来源 = ' + imported.source + ', videoId = ' + imported.videoId);
}
assert(createVideoFromLink('', 2).videoId === 'local-3', '空链接兜底 id 正确');

// 3c) 扫码登录链路：取码 + 轮询（真实官方接口）
const { readSession, saveSession, clearSession, requestLoginQr, checkLoginQr } = await importCached('utils/auth.mjs');
const qr = await requestLoginQr();
assert(!!qr.token, 'QR token = ' + qr.token);
assert(qr.image.indexOf('data:image/png;base64,') === 0, '二维码为 base64 PNG（长度 ' + qr.image.length + '）');
assert(typeof hasABogusRuntime === 'function', '签名运行时探测函数存在');
assert(typeof attachABogus === 'function', '签名注入函数存在');
const signed = attachABogus('https://login.douyin.com/passport/web/get_qrcode/?aid=6383', { method: 'GET', body: '' });
assert(signed.url.indexOf('a_bogus=') >= 0 || signed.note.indexOf('未可用') >= 0, '签名注入具备可用检测，URL= ' + signed.url.slice(0, 60));
const qrState = await checkLoginQr(qr.token);
assert(['new', 'scanned', 'expired'].indexOf(qrState.status) >= 0, '轮询状态 = ' + qrState.status);

// 3d) 登录态持久化（storage 桩读写回环）
await saveSession({ nick: '测试用户', id: '42', loginAt: Date.now() });
const session = await readSession();
assert(session && session.id === '42', 'storage 读回登录态 id = ' + (session && session.id));
await clearSession();
const cleared = await readSession();
assert(cleared === null, '退出后登录态已清空');

// 3e) 点赞/收藏状态持久化回环（user-state）
const { loadUserState, persistUserState, stateKeyOf, followKeyOf } = await importCached('utils/user-state.mjs');
const st1 = await loadUserState();
assert(!!st1.liked && !!st1.followed && !!st1.collected, '用户状态结构完整');
const vKey = stateKeyOf({ videoId: '7419207373887147316', title: 'x' });
assert(vKey === 'v:7419207373887147316', '解析条目用稳定 videoId 作键');
const hotKey = stateKeyOf({ videoId: 'hot-1', title: '国庆节快乐' });
assert(hotKey === 't:国庆节快乐', '热榜条目退回标题作键 = ' + hotKey);
st1.liked[vKey] = true;
st1.followed[followKeyOf('秋姐分享')] = true;
st1.collected[hotKey] = true;
await persistUserState(st1);
const st2 = await loadUserState();
assert(st2.liked[vKey] === true && st2.followed['u:秋姐分享'] === true && st2.collected[hotKey] === true,
  '点赞/关注/收藏状态经 storage 持久化回环');

// 3f) 观看历史：去重置顶 + 持久化 + 增删清
const { loadHistory, addHistory, removeHistory, clearHistory } = await importCached('utils/user-state.mjs');
let hist = await loadHistory();
hist = await addHistory(hist, { videoId: '1111222233334444555', title: '视频A', author: '作者一' });
hist = await addHistory(hist, { videoId: '9999888877776666555', title: '视频B', author: '作者二' });
hist = await addHistory(hist, { videoId: '1111222233334444555', title: '视频A', author: '作者一' });
assert(hist.length === 2 && hist[0].title === '视频A', '历史去重置顶 = ' + hist.map((h) => h.title).join(','));
const histReloaded = await loadHistory();
assert(histReloaded.length === 2, '历史经 storage 持久化 = ' + histReloaded.length);
hist = await removeHistory(hist, 'v:9999888877776666555');
assert(hist.length === 1, '删除单条历史 = ' + hist.length);
hist = await clearHistory();
assert(hist.length === 0, '清空历史');

globalThis.$falcon.jsapi.http.request = (params) => {
  setTimeout(() => params.fail({ errorMessage: 'boom' }), 5);
};
const degraded = await fetchVideoList();
assert(degraded.dataSource !== '抖音热榜', '主源失败后降级到 = ' + degraded.dataSource);

// ---- 3i) 登录态 Cookie：提取 / 注入 / 泄露防护 ----
const cookies = await importCached('services/session-cookies.mjs');
// 上面的二维码流程若经 PC 中转（LOGIN_HELPER）跑过，可能已经抓到真实 Cookie
// —— 这正是该功能的效果。这里先清空，保证断言与执行顺序无关。
await cookies.clearCookies();
const fromText = cookies.captureCookiesFromText('sessionid=aaa111bbb222; sid_tt=ccc333ddd444; theme=dark');
assert(fromText.sessionid === 'aaa111bbb222' && fromText.sid_tt === 'ccc333ddd444',
  '从文本提取会话 Cookie = ' + Object.keys(fromText).join(','));
assert(fromText.theme === undefined, '非会话 cookie 不被误收（theme 已排除）');

const fromHeaders = cookies.captureCookiesFromHeaders({
  headers: { 'set-cookie': ['sessionid=zzz999; Path=/; HttpOnly', 'ttwid=ttw123456; Path=/'] }
});
assert(fromHeaders.sessionid === 'zzz999' && fromHeaders.ttwid === 'ttw123456',
  '从响应头提取 Set-Cookie = ' + Object.keys(fromHeaders).join(','));

const fromUrl = cookies.captureCookiesFromUrl('https://sso.toutiao.com/x?passport_csrf_token=csrf123456&other=1');
assert(fromUrl.passport_csrf_token === 'csrf123456', '从跳转 URL 提取 = ' + Object.keys(fromUrl).join(','));
assert(cookies.captureCookiesFromUrl('https://sso.toutiao.com/poll/?token=abc123456').token === undefined,
  '轮询参数 token 不被当成 cookie');

assert(cookies.hasLoginCookie() === false, '未合并前不算登录态');
cookies.mergeCookies(fromText);
assert(cookies.hasLoginCookie() === true, '合并会话 Cookie 后算登录态');
assert(cookies.cookieHeader().indexOf('ttwid=') === 0 && cookies.cookieHeader().indexOf('sessionid=aaa111bbb222') > 0,
  'Cookie 头含 ttwid 与会话项');
assert(cookies.cookieSummary().indexOf('sessionid') >= 0, '诊断摘要列出 cookie 名 = ' + cookies.cookieSummary());

// 泄露防护：第三方域名（60s 热榜）不能带登录 Cookie
const { fetchHotFeed } = await importCached('services/douyin-api.mjs');
let leakedCookie = '';
const originalRequest = globalThis.$falcon.jsapi.http.request;
globalThis.$falcon.jsapi.http.request = (params) => {
  const h = params.header || params.headers || {};
  if (String(params.url).indexOf('60s-api') >= 0) leakedCookie = h.Cookie || h.cookie || '';
  setTimeout(() => params.fail({ errorMessage: 'stop' }), 5);
};
try { await fetchHotFeed(); } catch (error) { /* 期望失败 */ }
assert(leakedCookie === '', '第三方热榜接口不带 Cookie（实际：' + (leakedCookie || '空') + '）');
globalThis.$falcon.jsapi.http.request = originalRequest;

// 脏数据清洗：错误响应体里的 error/errorMessage 不能被当成 cookie（否则会误判为已登录）
cookies.clearCookies();
cookies.mergeCookies({ error: 'curl_easy_perform failed', errorMessage: 'curl failed', sessionid: 'good123456' });
assert(cookies.cookieKeys().indexOf('error') < 0 && cookies.cookieKeys().indexOf('errorMessage') < 0,
  '错误字段不会被当成 cookie = ' + cookies.cookieKeys().join(','));
assert(cookies.cookieKeys().indexOf('sessionid') >= 0, '合法会话项保留');

// 手动粘贴：宽松解析（用户给的是完整 Cookie 串，含非会话项也要留下）
cookies.clearCookies();
const pasted = await cookies.saveCookiesFromText('sessionid=abc123456; UIFID=zzz999888; ttwid=ttw123456; ; 坏数据');
assert(pasted.keys.indexOf('sessionid') >= 0 && pasted.keys.indexOf('UIFID') >= 0 && pasted.keys.indexOf('ttwid') >= 0,
  '粘贴 Cookie 宽松解析 = ' + pasted.keys.join(','));

// 响应外层里如果带 header（固件支持）→ 判定为“可不开中转抓会话”
const inspectWithHeader = cookies.inspectRawForCookies({
  result: '{}',
  header: { 'set-cookie': ['sessionid=abc123456; Path=/'] }
});
assert(inspectWithHeader.hasHeaders === true && inspectWithHeader.cookieNames.indexOf('sessionid') >= 0,
  '外层含 header 时能识别 Set-Cookie');
const inspectNoHeader = cookies.inspectRawForCookies({ result: '{"code":200}' });
assert(inspectNoHeader.hasHeaders === false && inspectNoHeader.envelopeKeys.join(',') === 'result',
  '外层只有 result 时判定为需中转/粘贴 = ' + inspectNoHeader.envelopeKeys.join(','));
cookies.clearCookies();

// ---- 3j) ttwid 自动注册：中转 meta 信封里的 Set-Cookie 能被提取并落盘 ----
const ttwidMod = await importCached('services/ttwid.mjs');
let ttwidErr = '';
try {
  await ttwidMod.refreshTtwid('');
} catch (error) {
  ttwidErr = error.message;
}
assert(ttwidErr.indexOf('未配置中转') >= 0, '未配中转时明确报错 = ' + ttwidErr.slice(0, 24));

// 用桩模拟 relay 的 meta 信封（{status, headers, body}）
globalThis.$falcon.jsapi.http.request = (params) => {
  const envelope = {
    status: 200,
    headers: { 'set-cookie': ['ttwid=1%7CfreshTTWID1234567890; Path=/; Max-Age=31536000'] },
    body: JSON.stringify({ error_code: 0, message: 'union register success' })
  };
  setTimeout(() => params.success({ result: JSON.stringify(envelope) }), 5);
};
const fresh = await ttwidMod.refreshTtwid('http://127.0.0.1:8712');
assert(fresh.ttwid.indexOf('freshTTWID') >= 0, '从中转 meta 信封取到新 ttwid = ' + fresh.ttwid.slice(0, 22));
assert(cookies.cookieHeader().indexOf('freshTTWID') > 0, '新 ttwid 已进入 Cookie 头');
cookies.clearCookies();

// ---- 3k) 多闪 PC 网关传输层（src/services/chat-api.js）----
// 网关地址规范化：只填 IP、填 IP:端口、粘了 http:// 和路径，都要收敛成同一个值
const chat = await importCached('services/chat-api.mjs');
await chat.resetGatewayAddrCache();
// 还没填地址就要给明确错误码，页面据此引导去填地址，而不是报「网关响应异常」
let noGwCode = '';
try { await chat.chatPing(); } catch (error) { noGwCode = error.code || ''; }
assert(noGwCode === 'no_gateway', '未设网关时抛 no_gateway = ' + noGwCode);
assert(chat.normalizeGatewayAddr('192.168.1.100') === 'http://192.168.1.100:8090',
  '只填 IP 补默认端口 = ' + chat.normalizeGatewayAddr('192.168.1.100'));
assert(chat.normalizeGatewayAddr('  192.168.1.100:9000/  ') === 'http://192.168.1.100:9000',
  'IP:端口 去空格去斜杠 = ' + chat.normalizeGatewayAddr('  192.168.1.100:9000/  '));
assert(chat.normalizeGatewayAddr('http://10.0.0.5:8090/api') === 'http://10.0.0.5:8090',
  '带协议头与路径归一 = ' + chat.normalizeGatewayAddr('http://10.0.0.5:8090/api'));
assert(chat.normalizeGatewayAddr('192.168.1.100:99999') === '' &&
  chat.normalizeGatewayAddr('中文地址') === '' &&
  chat.normalizeGatewayAddr('') === '',
  '非法地址一律拒绝（端口越界/非 ASCII/空）');
await chat.saveGatewayAddr('192.168.1.100');
const addrBack = await chat.loadGatewayAddr();
assert(addrBack === 'http://192.168.1.100:8090', '网关地址经 storage 契约持久化 = ' + addrBack);

// 网关响应剥壳：真机返回 {result:"<网关 JSON>"}。剥壳必须只剥**一层**——
// 网关业务体顶层就是 {ok:…}，剥多了会取 result=undefined → body 变 null → 误判空响应。
let chatSeenRawPost = '';
let chatSeenHeaders = null;
globalThis.$falcon.jsapi.http.request = (params) => {
  const url = String(params.url);
  const path = url.replace(/^http:\/\/[^/]+/, '');
  let body;
  if (path === '/api/ping') {
    body = { ok: true, app: 'dy-gateway', version: '1.0.0', logged_in: false, uname: '', uid: 0, wss: false, uptime_s: 7 };
  } else if (path.indexOf('/api/messages') === 0) {
    body = { ok: true, name: '阿秋', messages: [{ text: '在吗', ts: 17, from_me: false }] };
  } else if (path === '/api/sessions') {
    body = { ok: false, need_login: true };
  } else if (path === '/api/send') {
    chatSeenRawPost = params.data;
    chatSeenHeaders = params.header || params.headers;
    body = { ok: true };
  } else {
    body = { ok: false, msg: 'not found' };
  }
  // 真机形态：http.request() 返回 Promise，resolve 的也是 {result:"<body>"} 包装层，
  // 且**早于** success 回调结算（success 在这里只作为「Promise 先回空」时的兜底）。
  return Promise.resolve({ result: JSON.stringify(body) });
};
const ping = await chat.chatPing();
assert(ping.ok === true && ping.app === 'dy-gateway',
  '网关 {result:"{ok:true…}"} 剥壳后拿到 ok/app = ' + ping.app);
const msgs = await chat.chatMessages('123456');
assert(msgs.messages.length === 1 && msgs.name === '阿秋',
  '消息接口剥壳 + talker 入 query = ' + msgs.messages[0].text);
let needLoginCode = '';
try { await chat.chatSessions(); } catch (error) { needLoginCode = error.code || ''; }
assert(needLoginCode === 'need_login', '未登录时抛出 need_login = ' + needLoginCode);
await chat.chatSend('123456', '你好');
assert(String(chatSeenRawPost) === JSON.stringify({ talker: '123456', text: '你好' }),
  'send 的 POST body = ' + chatSeenRawPost);
assert(chatSeenHeaders && chatSeenHeaders['Content-Type'] === 'application/json',
  'send 带 Content-Type: application/json');
// gateway.py 用 Content-Length 决定读多少字节，缺了它就 read(0) → body 变 {} → 网关报「参数错误」
assert(chatSeenHeaders && chatSeenHeaders['Content-Length'] ===
  Buffer.byteLength(JSON.stringify({ talker: '123456', text: '你好' }), 'utf8'),
  'send 带正确的 Content-Length（UTF-8 字节数）= ' + (chatSeenHeaders && chatSeenHeaders['Content-Length']));

// 二维码 data URL 组装（chat-login 页直接把 qr_png_b64 塞给 <image :src>）
assert(chat.qrImageSrc({ qr_png_b64: 'AAAABBBB' }) === 'data:image/png;base64,AAAABBBB',
  'qr_png_b64 → data URL');
assert(chat.qrImageSrc({ qr_png_b64: '' }) === '' && chat.qrImageSrc(null) === '',
  'qr_png_b64 为空时不产出 data URL（generating 是正常中间态，不能当失败）');

// 地址非法时必须拒绝保存，否则坏值会被写进 storage（改地址页据此拦错）
assert(chat.isValidGatewayAddr('192.168.1.100') === true, '合法地址通过校验');
assert(chat.isValidGatewayAddr('192.168.1') === false && chat.isValidGatewayAddr('999.1.1.1') === false,
  '少打一段/越界的 IP 被拒绝（不静默补端口存坏值）');
assert(chat.normalizeGatewayAddr('my-pc') === 'http://my-pc:8090', '含字母的主机名仍放行 = ' + chat.normalizeGatewayAddr('my-pc'));

// ---- 3l) 今日头条数据层（src/services/toutiao-api.js）----
// 解析逻辑用真实结构的固定样本钉住，不依赖网络（真接口联调另见 .temp/toutiao-live-check.mjs）
const tt = await importCached('services/toutiao-api.mjs');

assert(tt.stripHtml('<p>第一段</p><br/><p>第二段 &amp; 符号</p>').replace(/\s+/g, '') === '第一段第二段&符号',
  'stripHtml 去标签 + 还原实体');
assert(tt.stripHtml('<script>var a=1<\/script>正文').indexOf('var a') < 0, 'stripHtml 丢掉 script');

// RENDER_DATA 是**URL 编码**的 JSON —— 头条详情页的真实形态（实测确认）
const RD_FIXTURE = {
  articleInfo: {
    gid: '7692341667583574579',
    title: '测试标题',
    content: '<p>正文本体</p><p>第二段</p>',
    publishTime: 1791013025,
    posterUrl: '//p3.pstatp.com/cover.jpeg',
    diggCount: 12,
    commentCount: 34,
    videoDuration: 70,
    mediaUser: { name: '测试作者' },
    videoId: 'v02d16g10004daubifnog65h8qgn1lrg'
  },
  seoTDK: { abstract: '摘要文字' }
};
const ttHtml = '<html><head><script id="RENDER_DATA" type="application/json">' +
  encodeURIComponent(JSON.stringify(RD_FIXTURE)) + '<\/script></head><body></body></html>';

const rd = tt.extractRenderData(ttHtml);
assert(rd && rd.articleInfo && rd.articleInfo.gid === '7692341667583574579',
  'extractRenderData 解出 URL 编码的 RENDER_DATA');
assert(tt.extractRenderData('<html>没有这个 script</html>') === null, '没有 RENDER_DATA 时返回 null');

const norm = tt.normalizeArticle(rd, null);
assert(norm.content === '正文本体\n第二段', 'normalizeArticle 正文剥标签 = ' + JSON.stringify(norm.content));
assert(norm.title === '测试标题' && norm.author === '测试作者', '标题/作者 = ' + norm.title + ' / ' + norm.author);
// 封面：只有「带签名」的图片 URL 可用（实测未签名的一律 403 / 域名已废）
// 所以未签名的封面现在会被**主动丢弃**（返回 ''），页面显示占位而不是加载必失败的图。
assert(tt.isUsableCover('https://p3-sign.toutiaoimg.com/tos-cn-i-x/a.jpg?x-signature=abc') === true,
  '带签名封面判为可用');
assert(tt.isUsableCover('https://p3-sign.toutiaoimg.com/x~tplv-abc.image') === true,
  '带 ~tplv 的签名封面判为可用');
assert(tt.isUsableCover('https://p3.pstatp.com/list/190x124/tos-cn-i-x/a.jpg') === false,
  'pstatp（已废域名）判为不可用');
assert(tt.isUsableCover('https://p3.toutiaoimg.com/list/tos-cn-i-x/a.jpg') === false,
  'toutiaoimg 未签名路径判为不可用（实测 403）');
assert(tt.isUsableCover('https://lf-dw.toutiaostatic.com/obj/x/y.png') === true,
  '站点静态资源判为可用');
assert(tt.isUsableCover('') === false && tt.isUsableCover('http://evil.com/a.jpg') === false,
  '空值/非白名单域名判为不可用');
assert(norm.cover === '', 'normalizeArticle 丢弃未签名封面 = ' + JSON.stringify(norm.cover));
assert(tt.normalizeArticle({ articleInfo: { gid: '1', title: 'T', posterUrl: 'https://p3-sign.toutiaoimg.com/a/b.jpg?x-signature=z' } }, null).cover
  === 'https://p3-sign.toutiaoimg.com/a/b.jpg?x-signature=z', '签名封面被保留');
assert(norm.publishTime === 1791013025 && norm.commentCount === 34 && norm.diggCount === 12, '数值字段正确');
// 视频元信息要保留，但必须如实标记不可播（直链过不了字节的混淆 JS VM，实测确认）
assert(norm.hasVideo === true && norm.videoPlayable === false && norm.videoDuration === 70,
  '视频条目：保留元信息但标记不可播');
assert(norm.abstract === '摘要文字', '摘要来自 seoTDK');

const ttPlain = tt.normalizeArticle({ articleInfo: { gid: '1', title: 'T', content: '' } }, null);
assert(ttPlain.content === '' && ttPlain.contentLength === 0 && ttPlain.hasVideo === false,
  '无正文/无视频时为默认值');

// relativeTime：头条 feed 给秒级，我们自己存毫秒级，两种都要认
const nowSec = Math.floor(Date.now() / 1000);
assert(tt.relativeTime(nowSec - 30) === '刚刚', '30 秒前 → 刚刚');
assert(tt.relativeTime(nowSec - 120) === '2 分钟前', '2 分钟前 = ' + tt.relativeTime(nowSec - 120));
assert(tt.relativeTime(nowSec - 7200) === '2 小时前', '2 小时前 = ' + tt.relativeTime(nowSec - 7200));
assert(tt.relativeTime(nowSec - 86400 * 3) === '3 天前', '3 天前 = ' + tt.relativeTime(nowSec - 86400 * 3));
assert(tt.relativeTime(0) === '', '时间戳为 0 时返回空串');
assert(tt.relativeTime(Date.now() - 60000) === '1 分钟前', '毫秒级时间戳也能认');
assert(tt.TOUTIAO_KEYS.session === 'toutiao_session' && tt.TOUTIAO_KEYS.likes === 'toutiao_likes',
  '头条用独立 storage 前缀（不与 douyin_* 混）');

// ---- 本地评论（头条线上评论需签名，实测 /api/comment/list/ 恒 500）----
let cAll = {};
cAll = tt.appendComment(cAll, 'g1', '第一条');
cAll = tt.appendComment(cAll, 'g1', '第二条');
cAll = tt.appendComment(cAll, 'g2', '别的条目');
assert(tt.commentsOf(cAll, 'g1').length === 2, '按 groupId 分组存评论 = ' + tt.commentsOf(cAll, 'g1').length);
assert(tt.commentsOf(cAll, 'g2').length === 1, '不同条目互不干扰');
assert(tt.localCommentCount(cAll, 'g1') === 2, '本地评论计数');
assert(tt.commentsOf(cAll, 'nope').length === 0, '无评论的条目返回空数组');
// 空文本 / 空 groupId 不应写入
assert(tt.commentsOf(tt.appendComment(cAll, 'g1', '   '), 'g1').length === 2, '空白评论不写入');
assert(tt.commentsOf(tt.appendComment(cAll, '', 'x'), '').length === 0, '空 groupId 不写入');
// 删除
const firstId = tt.commentsOf(cAll, 'g1')[0].id;
cAll = tt.removeComment(cAll, 'g1', firstId);
assert(tt.commentsOf(cAll, 'g1').length === 1, '删除单条评论 = ' + tt.commentsOf(cAll, 'g1').length);
// 上限 50 条（防撑爆笔上存储）
let many = {};
for (let i = 0; i < 60; i++) many = tt.appendComment(many, 'g', 'c' + i);
assert(tt.commentsOf(many, 'g').length === 50, '单条目评论上限 50 = ' + tt.commentsOf(many, 'g').length);
assert(tt.commentsOf(many, 'g')[49].text === 'c59', '保留的是最新 50 条');

// ---- 3r) 版本号/名称一致性（**防两处漂移**）----
// 背景：真机排查第一件事是"装的是哪个包"，而运行时读不到可靠版本
//（$falcon.__AppClazz.meta.version 等实测全取不到），早前模板还硬编码回退成 '1.0.0'，
// 导致**装了新包也显示 1.0.0**。现在 config.js 里放权威常量，页面直接用它，
// 所以必须和 package.json 同步 —— 用断言把这条钉死，改版本时忘了改一处就会红。
{
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const cfgSrc = fs.readFileSync(path.join(root, 'src', 'config.js'), 'utf8');
  const vm = /export const APP_VERSION = '([^']+)'/.exec(cfgSrc);
  const nm = /export const APP_NAME = '([^']+)'/.exec(cfgSrc);
  assert(!!vm && !!nm, 'config.js 里有 APP_VERSION / APP_NAME 常量');
  assert(vm && vm[1] === pkg.version,
    'config.js 的 APP_VERSION 与 package.json 一致（' + (vm && vm[1]) + ' vs ' + pkg.version + '）');
  assert(nm && nm[1] === pkg.name,
    'config.js 的 APP_NAME 与 package.json 一致（' + (nm && nm[1]) + ' vs ' + pkg.name + '）');
  // 产物文件名也要跟版本对上（真机靠它认包）
  assert(pkg.version === '1.0.2',
    'package.json 版本符合预期（当前 ' + pkg.version + '，若是主动升版本请同步改这条断言）');
}

// ---- 3q) 番茄小说数据层（src/services/fanqie-api.js）----
// 关键实测：正文有**字体反爬**（PUA 私用区码点），且**部分章服务端只回占位（约 24 字）**。
// 这里用固定样本把解析/掩码/本地书架逻辑钉住，不依赖网络（真接口联调见 .temp/fanqie-live-check.mjs）
const fq = await importCached('services/fanqie-api.mjs');

// ① 封面：只有带签名的 fqnovelpic 才可用（与头条同理）
assert(fq.isUsableFanqieCover('https://p3-reading-sign.fqnovelpic.com/novel-pic/a~tplv-resize:225:0.image?x-signature=x') === true,
  '带签名番茄封面判为可用');
assert(fq.isUsableFanqieCover('https://p3-reading-sign.fqnovelpic.com/novel-pic/a.jpg') === false,
  '未签名番茄封面判为不可用');
assert(fq.isUsableFanqieCover('https://evil.com/a.jpg?x-signature=x') === false, '非白名单域名判为不可用');

// ② __INITIAL_STATE__ 提取（括号配平，字符串里的 {} 不能算）
const fqHtml = '<script>window.__INITIAL_STATE__={"a":{"b":"{不是括号}"},"c":[1,2]};</script>';
const st = fq.extractInitialState(fqHtml);
assert(st && st.a && st.a.b === '{不是括号}' && st.c.length === 2, 'extractInitialState 能处理字符串里的花括号');
assert(fq.extractInitialState('<html>没有</html>') === null, '没有 INITIAL_STATE 时返回 null');

// ③ PUA 掩码：私用区字符换成「□」并统计（实测第一章 16% 被替换）
const masked = fq.maskPua('龙昊\ue4c5碗洗\ue465！');
assert(masked.text === '龙昊□碗洗□！', 'maskPua 把 PUA 换成 □ = ' + masked.text);
assert(masked.masked === 2 && masked.total === 7, 'maskPua 统计 = ' + masked.masked + '/' + masked.total);
assert(masked.ratio === 29, 'maskPua 比例 = ' + masked.ratio + '%');
assert(fq.maskPua('全是正常文字').masked === 0, '无 PUA 时 masked=0');
// 常用汉字不能被误判成 PUA（U+4E00-U+9FFF 与 U+E000-F8FF 不重叠）
assert(fq.maskPua('的一是了我不人在').masked === 0, '常用汉字不误判');

// ④ 本地书架 / 进度 / 历史（纯函数）
let fqShelf = [];
fqShelf = fq.toggleShelf(fqShelf, { bookId: 'b1', title: '书一', author: '作者', cover: 'https://x/y.jpg' });
assert(fqShelf.length === 1 && fq.inShelf(fqShelf, 'b1'), '加入番茄书架');
assert(fqShelf[0].cover === '', '未签名封面入库时被丢弃');
fqShelf = fq.toggleShelf(fqShelf, { bookId: 'b1' });
assert(fqShelf.length === 0, '移出番茄书架');
// 书架上限 60
let bigShelf = [];
for (let i = 0; i < 70; i++) bigShelf = fq.toggleShelf(bigShelf, { bookId: 'b' + i, title: 't' + i });
assert(bigShelf.length === 60, '番茄书架上限 60 = ' + bigShelf.length);
assert(bigShelf[0].bookId === 'b69', '最新加入的排最前');

let fqProg = fq.saveProgressTo({}, 'b1', { chapterId: 'c9', chapterIndex: 8, title: '第九章' });
assert(fqProg.b1 && fqProg.b1.chapterIndex === 8, '保存番茄阅读进度');
assert(fq.saveProgressTo({}, '', { chapterId: 'x' }) && Object.keys(fq.saveProgressTo({}, '', {})).length === 0, '空 bookId 不写进度');

let fqHist = fq.pushReadHistory([], { chapterId: 'c1', title: '第一章' });
fqHist = fq.pushReadHistory(fqHist, { chapterId: 'c2', title: '第二章' });
fqHist = fq.pushReadHistory(fqHist, { chapterId: 'c1', title: '第一章' });
assert(fqHist.length === 2 && fqHist[0].chapterId === 'c1', '番茄阅读历史去重置顶 = ' + fqHist.map((x) => x.chapterId).join(','));
assert(fq.FANQIE_KEYS.session === 'fanqie_session' && fq.FANQIE_KEYS.shelf === 'fanqie_shelf',
  '番茄用独立 storage 前缀（不与 douyin_*/toutiao_* 混）');

// ⑤ stripHtml 复用同一套行为
assert(fq.stripHtml('<p>第一段</p><br/><p>第二段 &amp; 符号</p>').replace(/\s+/g, '') === '第一段第二段&符号',
  '番茄 stripHtml 去标签 + 还原实体');
assert(fq.stripHtml('<p>龙昊\ue4c5</p>').indexOf('<') < 0, '番茄 stripHtml 去标签');

// ⑥ 缺参明确报错
let fqErr = '';
try { await fq.fetchFanqieBook(''); } catch (e) { fqErr = e.message; }
assert(fqErr.indexOf('bookId') >= 0, '取书缺 bookId 明确报错 = ' + fqErr);
fqErr = '';
try { await fq.fetchFanqieChapter(''); } catch (e) { fqErr = e.message; }
assert(fqErr.indexOf('chapterId') >= 0, '取章缺 chapterId 明确报错 = ' + fqErr);

// ⑦ 番茄下载 = **离线文本缓存**（不是下文件）
// 依据：设备端没有文件 API（native 只注册 storage/http），且二进制经 native http 的
// 字符串通道会损坏（§9 实测 42% 字节非法 UTF-8，**曾导致词典笔软重启**）。
// 所以必须缓存"可读章的正文文本"，并且**必须设上限**（笔上空间有限）。
assert(fq.FANQIE_KEYS.downloads === 'fanqie_downloads', '下载用独立 storage key');
let dl = {};
dl = fq.putChapter(dl, 'b1', 'c1', '第一章', '正文一');
dl = fq.putChapter(dl, 'b1', 'c2', '第二章', '正文二');
assert(fq.downloadedIds(dl, 'b1').length === 2, '缓存 2 章 = ' + fq.downloadedIds(dl, 'b1').length);
assert(fq.isDownloaded(dl, 'b1', 'c1') === true && fq.isDownloaded(dl, 'b1', 'c9') === false, 'isDownloaded 判定');
assert(fq.cachedChapter(dl, 'b1', 'c1').c === '正文一', 'cachedChapter 取回正文');
assert(fq.cachedChapter(dl, 'b1', 'zz') === null, '没有缓存时返回 null');
assert(fq.downloadStat(dl, 'b1').chapters === 2 && fq.downloadStat(dl, 'b1').chars === 6, '下载统计');
assert(fq.downloadedIds(fq.putChapter({}, '', 'c1', 't', 'x'), '').length === 0, '空 bookId 不写缓存');
assert(fq.downloadedIds(fq.putChapter({}, 'b1', '', 't', 'x'), 'b1').length === 0, '空 chapterId 不写缓存');
// 单章超长截断（防一章撑爆 storage）
const longText = 'x'.repeat(fq.CACHE_MAX_CHARS + 5000);
const dlLong = fq.putChapter({}, 'b2', 'c1', 't', longText);
assert(fq.cachedChapter(dlLong, 'b2', 'c1').c.length === fq.CACHE_MAX_CHARS,
  '单章正文截断到 ' + fq.CACHE_MAX_CHARS + ' = ' + fq.cachedChapter(dlLong, 'b2', 'c1').c.length);
// 每本限 40 章：写 50 章只留 40，且丢最早的
let dlMany = {};
for (let i = 0; i < 50; i++) dlMany = fq.putChapter(dlMany, 'b3', 'c' + i, 't' + i, 'x');
const keptIds = fq.downloadedIds(fq.pruneDownloads(dlMany), 'b3');
assert(keptIds.length === fq.CACHE_MAX_CHAPTERS, '每本限 ' + fq.CACHE_MAX_CHAPTERS + ' 章 = ' + keptIds.length);
assert(keptIds.indexOf('c49') >= 0 && keptIds.indexOf('c0') < 0, '保留最新、丢弃最早');
// 总量上限：超了就整本丢最旧的
let dlBig = {};
for (let b = 0; b < 30; b++) {
  for (let c = 0; c < 40; c++) dlBig = fq.putChapter(dlBig, 'big' + b, 'c' + c, 't', 'y'.repeat(400));
}
const prunedBig = fq.pruneDownloads(dlBig);
let totalChars = 0;
Object.keys(prunedBig).forEach((bid) => {
  Object.keys(prunedBig[bid].chapters).forEach((cid) => { totalChars += prunedBig[bid].chapters[cid].c.length; });
});
assert(totalChars <= fq.CACHE_MAX_TOTAL, '总量不超过 ' + fq.CACHE_MAX_TOTAL + ' = ' + totalChars);
assert(Object.keys(prunedBig).length < 30, '超量时整本丢弃，剩 ' + Object.keys(prunedBig).length + ' 本');
// offlineCoverage 只报实际占比，不谎称全下完
const cov = fq.offlineCoverage(dl, 'b1', 100);
assert(cov.chapters === 2 && cov.total === 100 && cov.percent === 2, 'offlineCoverage = ' + cov.percent + '%');
assert(fq.offlineCoverage(dl, 'b1', 0).percent === 0, '总章数为 0 时不除零');
// 遇到锁定章**不能停**：实测某书前 6 章是「可读/锁/锁/锁/可读/锁」，
// 看到第 2 章就停会白白漏掉第 5 章。用桩把这条钉住。
const fqChapters = [
  { id: '100000000000000001', title: '第一章' },
  { id: '100000000000000002', title: '第二章' },
  { id: '100000000000000003', title: '第三章' },
  { id: '100000000000000004', title: '第四章' },
  { id: '100000000000000005', title: '第五章' }
];
// ⚠️ 键必须是**字符串**：18 位数字超出 JS 双精度整数能精确表示的范围，
//    写成 { 100000000000000001: true } 会被舍入成 100000000000000000，
//    查表全部 miss → 所有章都被当成"锁定章"，测试会假失败。（踩过）
const READABLE = { '100000000000000001': true, '100000000000000005': true };
globalThis.$falcon.jsapi.http.request = (params) => {
  // 注意：配了中转时 URL 会被包成 &url=<encodeURIComponent(...)>，要先解码再匹配，
  // 否则匹配不到章节 id → 全部当成"锁定章"，测试会假失败。
  const raw = decodeURIComponent(String(params.url || ''));
  const m = /reader\/(\d+)/.exec(raw);
  const id = m ? m[1] : '';
  const readable = !!READABLE[id];
  const html = '<script>window.__INITIAL_STATE__=' + JSON.stringify({
    articleInfo: { chapterData: { bookId: 'bk', bookName: '书', author: 'A', nextItemId: '', content: readable ? '<p>' + '正'.repeat(300) + '</p>' : '<p>短</p>' } }
  }) + ';</script>';
  // 与真实固件一致：Promise 先以 undefined 结算，真正的响应走 success 回调
  setTimeout(() => params.success({ result: html }), 1);
  return Promise.resolve(undefined);
};
const dlRes = await fq.downloadBook(
  { bookId: 'bk', title: '书', author: 'A', chapters: fqChapters },
  { existing: {}, maxChapters: 10, skipLimit: 60, delayMs: 0 }
);
assert(dlRes.done === 2, '跳过锁定章继续下 → 拿到 2 章可读 = ' + dlRes.done);
assert(fq.isDownloaded(dlRes.all, 'bk', '100000000000000005'), '第 5 章（被 3 个锁定章隔着）也要下到');
assert(dlRes.locked === 3, '统计跳过 3 章 = ' + dlRes.locked);

let artErr = '';
try { await tt.fetchToutiaoArticle(''); } catch (error) { artErr = error.message; }
assert(artErr.indexOf('groupId') >= 0, '取正文缺 groupId 时明确报错 = ' + artErr);

// ---- 3m) 抖音官方 web 视频流：播放地址构造（纯函数，不联网）----
const dyApi = await importCached('services/douyin-api.mjs');
const built = dyApi.douyinPlayUrl('v0200fg10000da78b3fog65rhjjd12eg');
assert(built === 'https://www.douyin.com/aweme/v1/play/?video_id=v0200fg10000da78b3fog65rhjjd12eg&line=0&ratio=1080p&aid=6383',
  'douyinPlayUrl 组装 = ' + built.slice(0, 78));
assert(dyApi.douyinPlayUrl('') === '' && dyApi.douyinPlayUrl(null) === '', 'douyinPlayUrl 空 uri 返回空');
// 关键：构造出来的是**跳转入口**，不是 douyinvod 直链 —— 直链实测恒 403
assert(built.indexOf('douyinvod') < 0, 'douyinPlayUrl 不产出 CDN 直链（那些直链实测 403）');
assert(/\/aweme\/v1\/play\//.test(built), 'douyinPlayUrl 产出 /aweme/v1/play 入口（302 由播放器跟）');

// ---- 3n) 播放地址路由：/aweme/v1/play 跳板必须走中转（真机 open-failed 的根因）----
// 实测：该入口 302 到 douyinvod 后，**只带 UA 不带 Referer → 403**；带 Referer → 200 video/mp4。
// 设备 FFmpeg 跟 302 时不带 Referer，所以这条必须交给中转（由 PC 补齐头并跟跳转）。
const np = await importCached('services/native-player.mjs');
const playEntry = 'https://www.douyin.com/aweme/v1/play/?video_id=v0300fg10000daipqp7og65gv96ps050&line=0&ratio=1080p&aid=6383';
assert(np.needsRelay(playEntry) === true, 'needsRelay 认出 /aweme/v1/play 跳板入口');
assert(np.needsRelay('https://v26-web.douyinvod.com/video/tos/cn/x.mp4') === false,
  'needsRelay 不误判直链 CDN');
// ★ 回归防线：**不得再出现"把 https 改写成明文 http"的地址选择逻辑**。
// 历史：`nativePlayableUrl()` 会 (1) 优先挑 play_addr 里的**直链 CDN**（实测恒 403），
//       (2) 把结果 `replace(/^https:/i,'http:')` 换成明文 http（"模块没有 TLS"的旧前提，
//       已被 §13.7 真机诊断推翻）→ 把好好的跳板入口换成打不开的地址。**已整体删除**。
// 现在选地址只有一处：playUrlCandidates（多候选）+ 播放页 startWithFallback。
assert(typeof np.nativePlayableUrl === 'undefined', '危险的 nativePlayableUrl 已删除');
{
  const npSrc = fs.readFileSync(path.join(root, 'src', 'services', 'native-player.js'), 'utf8');
  const codeOnly = npSrc.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
  assert(codeOnly.indexOf('isDirectCdn') < 0, 'native-player.js 不再有优先挑直链 CDN 的逻辑');
  // 不得把 https 改写成 http（媒体地址一律保持 https：固件自带 TLS，§13.7）
  assert(!/replace\(\s*\/\^https:/i.test(codeOnly),
    'native-player.js 不得把 https 改写成 http（旧前提已被推翻）');
  // 所有候选都必须是 https（明文 http 会被固件/中转链路搞坏）
  const cands2 = np.playUrlCandidates(playEntry, []);
  assert(cands2.every((u) => String(u).indexOf('https://') === 0),
    'playUrlCandidates 产出的候选全是 https');
}
// 没配中转时：轮换候选的第一个应当是更稳的 snssdk 入口（不是原样的 douyin.com）
assert(np.playUrlCandidates(playEntry, [])[0].indexOf('aweme.snssdk.com/aweme/v1/play/') >= 0,
  '跳板入口的首个候选是更稳的 snssdk 入口');
assert(np.relayPlayableUrl(playEntry) === '', '未配中转时 relayPlayableUrl 返回空（调用方可据此跳过重试）');
// 已是中转地址不重复套娃
// relayPlayableUrl 不重复套中转
assert(np.relayPlayableUrl('http://1.2.3.4:8712/relay?url=x') === 'http://1.2.3.4:8712/relay?url=x',
  'relayPlayableUrl 不重复套中转');

// ★ 免中转的关键机制：同一视频给出多个等价播放入口，由播放器轮换重试。
// 实测单形态一次只有 ~68% 成功（302 落点 CDN 主机随机、部分要求 Referer），
// 轮换候选可达 100%。
const cands = np.playUrlCandidates(playEntry, []);
assert(cands.length >= 3, '跳板入口给出多个候选入口 = ' + cands.length + ' 个');
assert(cands.filter((u) => u.indexOf('aweme.snssdk.com/aweme/v1/play/') >= 0).length >= 2,
  '候选里含 ≥2 个 snssdk 入口（不同 ratio 会重抽落点主机）');
assert(cands.some((u) => u.indexOf('www.douyin.com/aweme/v1/play/') >= 0), '候选里保留 douyin.com 入口作兜底');
// 去重要真的生效（同一个 URL 不该出现两次）
assert(new Set(cands).size === cands.length, '候选列表无重复 = ' + cands.join(' | ').slice(0, 80));
// 抠不出 video_id 时也不能崩，至少给出原地址
const noId = np.playUrlCandidates('https://example.com/x.mp4', []);
assert(noId[0] === 'https://example.com/x.mp4', '无 video_id 时原样返回');

// ---- 3o) ★ 回归防线：不允许再出现"对视频地址发 GET"的代码 ----
// 曾经这里有一个 `resolvePlainHttpUrl()`：对视频入口 URL 发 GET、读 302 的 Location
// 再换明文 http。**已整体删除**，原因是它违反项目自己的安全禁令，且前提已被推翻：
//   ① 若固件跟随 302，body 就是完整 mp4 → 正是"二进制灌进原生字符串通道"的软重启场景
//      （HANDOFF §9 实测 42% 字节非法 UTF-8，曾导致词典笔软重启）；
//   ② 若不跟随，则拿不到 Location，纯属白等 8 秒；
//   ③ 它依据的"模块很可能没有 TLS"已被真机诊断推翻（§13.7 第 11 行 OK 1280x720）；
//   ④ 真正根因是**落点 CDN 主机坏**（§13.9），修法是主机黑名单，已能治。
assert(typeof np.resolvePlainHttpUrl === 'undefined' && typeof np.cachedPlainHttpUrl === 'undefined',
  '危险/死代码已删除：不再导出 resolvePlainHttpUrl / cachedPlainHttpUrl');
// 源码级断言：native-player.js 里**唯一**允许用 jsapiHttpRequest 的地方是
// probeCandidatesViaRelay（它请求的是**中转的 probe 端点**，只回几十字节 JSON）。
// 绝不允许把视频/媒体地址本身交给 jsapiHttpRequest。
{
  const npSrc = fs.readFileSync(path.join(root, 'src', 'services', 'native-player.js'), 'utf8');
  const codeOnly = npSrc.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
  assert(codeOnly.indexOf('LOCATION_CACHE') < 0, 'native-player.js 不再有 LOCATION_CACHE');
  // jsapiHttpRequest 只能出现在 probeCandidatesViaRelay 内部，且该函数的 URL 必须带 probe=1
  const idx = codeOnly.indexOf('jsapiHttpRequest');
  let probeFn = '';
  if (idx >= 0) {
    const start = codeOnly.indexOf('probeCandidatesViaRelay');
    probeFn = codeOnly.slice(start, start + 900);
  }
  assert(idx >= 0 && codeOnly.split('jsapiHttpRequest').length - 1 === 2,
    'jsapiHttpRequest 只出现 2 次（import + probe 一处调用）');
  assert(probeFn.indexOf("'&probe=1'") >= 0,
    'probe 只打中转的 &probe=1 端点，而不是把视频地址直接交出去');
  // 关键：探针函数里不得出现"直接对候选 URL 发请求"的形态（u 必须被 encode 进中转 URL）
  assert(probeFn.indexOf('url: probeUrl') >= 0, 'probe 请求的是 probeUrl（中转端点）而非候选原文');
}

// probe：**这些断言必须是环境无关的**，否则又会变成"随环境飘"的测试
// （本文件开头约定：依赖网络可用性的东西一律 NOTE，不 FAIL）。
// 所以只断言**纯逻辑**：没配中转 / 空候选 / 探测异常时都要返回 null（不改原有行为）。
// 不在测试里打真实 probe 端点 —— 那会让 PASS 数随"中转是否在跑"而变。
assert(await np.probeCandidatesViaRelay(['https://aweme.snssdk.com/aweme/v1/play/?video_id=x']) === null,
  '未配中转时 probe 返回 null（不改原有行为）');
assert(await np.probeCandidatesViaRelay([]) === null, '空候选返回 null');
assert(await np.probeCandidatesViaRelay(null) === null, 'null 候选返回 null');
// 显式传一个打不通的 relay：必须**吞掉异常返回 null**，绝不能把播放流程带崩
assert(await np.probeCandidatesViaRelay(['https://x/y'], { relay: 'http://127.0.0.1:1/', timeoutMs: 800 }) === null,
  '探测失败时返回 null（不拦播放器）');
// probe 的 URL 组装：必须是 /relay?url=<encode>&probe=1，而不是直接把视频地址发出去
{
  const npSrc = fs.readFileSync(path.join(root, 'src', 'services', 'native-player.js'), 'utf8');
  assert(/\/relay\?url=' \+ encodeURIComponent\(u\) \+ '&probe=1'/.test(npSrc),
    'probe 端点组装正确（encode + &probe=1）');
}

// ---- 3p) 播放入口的「坏 CDN 主机」处理 ----
// 背景：真机诊断实测候选入口 170ms 就回来，但内容是 90 字节的 {"error":3,…} —— 不是视频。
// 根因是那些视频被解析到**已坏的 CDN 主机**（实测 v95-bjb-mc-cold.douyinvod.com DNS ENOTFOUND）。
//
// ⛔ 教训（本文件同时是回归防线）：**绝对不要用 JS 的 http 通道去读视频字节来"探测"** ——
//    那会把二进制灌进原生字符串通道，真机上**导致词典笔软重启**（见 HANDOFF §9）。
//    所以现在没有 probeCandidates，改用「按主机黑名单 + 原生播放器自己当探测器」。
assert(typeof np.isErrorBody === 'function', '导出 isErrorBody');
assert(np.isErrorBody('{"error":3,"result":{"errorMessage":"…"}}') === true,
  '认出 error JSON（真机实测的那种 90 字节响应）');
assert(np.isErrorBody('') === false, '空体不判死');
assert(np.isErrorBody('<html><body>403</body></html>') === false, 'HTML 不判死（交给播放器试）');
assert(np.isErrorBody(JSON.stringify({ aweme_list: [], status_code: 0 })) === false,
  '含 aweme_list 的响应不算错误体');
assert(np.isErrorBody('x'.repeat(5000)) === false, '大响应不算错误体（避免处理二进制）');

// 主机黑名单：失败过的主机沉底；不删除候选（可能只是抖动）
assert(typeof np.markHostBad === 'function' && typeof np.orderByHostHealth === 'function',
  '导出 markHostBad / orderByHostHealth');
const H_BAD = 'https://v95-bjb-mc-cold.douyinvod.com/x/video/tos/cn/a.mp4';
const H_OK1 = 'https://v9-v2-mps-cdn.douyinvod.com/x/video/tos/cn/b.mp4';
const H_OK2 = 'https://aweme.snssdk.com/aweme/v1/play/?video_id=z';
assert(np.isHostBad(H_BAD) === false, '未标记前不算坏主机');
np.markHostBad(H_BAD, 'DNS ENOTFOUND');
assert(np.isHostBad(H_BAD) === true, '标记后 isHostBad = true');
assert(np.isHostBad(H_OK1) === false, '同域不同主机不误伤');
const ordered = np.orderByHostHealth([H_BAD, H_OK1, H_OK2]);
assert(ordered.length === 3, '排序不丢候选 = ' + ordered.length);
assert(ordered[ordered.length - 1] === H_BAD, '坏主机沉到末尾');
assert(ordered[0] === H_OK1 && ordered[1] === H_OK2, '好主机保持原相对顺序');
assert(np.badHostList().indexOf('v95-bjb-mc-cold.douyinvod.com') >= 0,
  'badHostList 列出坏主机 = ' + np.badHostList().join(','));


// ---- 3h) 固件响应包装形态回归（真机词典笔实测：http.request 返回 Promise，
//          resolve 出的是 {result:"<json字符串>"} 包装层，且早于 success 回调）----
// 旧代码让 Promise 与回调赛跑并直接把 Promise 的值当响应体，于是整层包装被当成 body、
// code 取不到 → 所有接口都报“返回异常”并回退本地样例。三种固件形态都钉住。
const nativeStub = (shape) => (params) => {
  const text = nodeGetText(params.url, params.header || params.headers);
  if (shape === 'promise-only') {
    return text.then((body) => ({ result: body }));
  }
  if (shape === 'race') {
    text.then((body) => setTimeout(() => params.success({ result: body }), 30)).catch(() => {});
    return text.then((body) => ({ result: body }));
  }
  // 'promise-empty-then-callback'：Promise 先以 undefined 结算，真正的响应走 success
  text.then((body) => setTimeout(() => params.success({ result: body }), 30)).catch(() => {});
  return Promise.resolve(undefined);
};

for (const shape of ['promise-only', 'race', 'promise-empty-then-callback']) {
  globalThis.$falcon.jsapi.http.request = nativeStub(shape);
  const r = await fetchVideoList();
  // 这里考的是"包装层剥不剥得掉"（剥不掉就整层被当 body → 只能回退离线样例），
  // 不是数据源排名 —— 所以只要求拿到**真实**列表且进了非离线态即可。
  assert(r.list.length > 0 && !r.offline,
    '固件形态 ' + shape + ' → ' + r.dataSource + ' · ' + r.list.length + ' 条');
}

delete globalThis.$falcon;
// ⚠️ 光删 $falcon 不够：**Node ≥18 自带全局 fetch**，通道链会退到 fetch 真的把请求发出去，
//    于是这里不会报"无通道"而是成功 → 断言随 Node 版本飘（Node 16 绿、Node 20 红）。
//    所以要把 fetch 和 tt 一起清掉，才真的构造出"无可用通道"的环境。
const savedFetch = globalThis.fetch;
globalThis.fetch = undefined;
if (globalThis.tt) globalThis.tt = undefined;
let envError = '';
try {
  const { fetchHotFeed } = await importCached('services/douyin-api.mjs');
  await fetchHotFeed();
} catch (error) {
  envError = error.message;
} finally {
  globalThis.fetch = savedFetch;
}
assert(envError.includes('网络通道'), '无通道环境错误信息 = ' + envError);

console.log(lines.join('\n'));
if (relayProc) relayProc.kill();
process.exit(lines.some((l) => l.startsWith('FAIL')) ? 1 : 0);
