// 抖音第三方 API 客户端（纯前端，经 libjsapi 发起请求）
// 数据源见 src/config.js 中的说明。所有请求都通过 libjsapi 适配层发出。

import { jsapiHttpRequest, previewPayload } from './libjsapi.js';
import { cookieHeader, hasLoginCookie } from './session-cookies.js';
import { refreshTtwid } from './ttwid.js';
import {
  DOUYIN_HOT_FEED_API,
  DOUYIN_HOT_WORDS_API,
  DOUYIN_SHARE_UA,
  DOUYIN_TTWID,
  DOUYIN_VIDEO_PARSE_API,
  API_TIMEOUT_MS
} from '../config.js';

// 只给字节系域名带 Cookie。给 60s 这类第三方热榜接口带登录 Cookie 属于泄露，坚决不带。
const COOKIE_HOSTS = /(^|\.)(douyin\.com|iesdouyin\.com|snssdk\.com|toutiao\.com|douyinpic\.com|amemv\.com)$/i;

function hostOf(url) {
  const match = /^https?:\/\/([^/?#]+)/i.exec(String(url || ''));
  return match ? match[1].split(':')[0] : '';
}

function withCookies(url, baseHeaders) {
  const headers = Object.assign({}, baseHeaders || {});
  if (COOKIE_HOSTS.test(hostOf(url))) {
    const cookie = cookieHeader();
    if (cookie) headers.Cookie = cookie;
  }
  return headers;
}

// 从分享文案/链接中提取视频 id
export function extractVideoId(text) {
  const raw = String(text || '').trim();
  if (!raw) return '';
  let match = raw.match(/video\/(\d+)/) || raw.match(/note\/(\d+)/);
  if (match) return match[1];
  match = raw.match(/(\d{14,})/);
  return match ? match[1] : '';
}

// ============================================================
// 抖音官方 web 视频首页（2026-10 实测可用，只需 ttwid，不需要 a_bogus）
// ============================================================
// `GET https://www.douyin.com/aweme/v1/web/tab/feed/?device_platform=webapp&aid=6383&channel=channel_pc_web&count=10`
//   → { aweme_list:[…], has_more:1, status_code:0 }
//
// 实测结论（别凭直觉改）：
//   · **一次只回 1~6 条，且不给 max_cursor/min_cursor** → 没法用游标翻页；
//     但**反复调用会不断给新内容**（打 `refresh_index=0..N`，8 次累积到 39 条去重）。
//     所以这里并发打若干次再按 aweme_id 去重。
//   · 播放地址：`video.play_addr.url_list[0..1]` 那两个 **douyinvod CDN 直链恒 403**
//     （http/https、带不带 Referer、带不带 Range 全试过，一律 403）→ **不能用**。
//     能用的是同一数组里那个跳转入口：
//       https://www.douyin.com/aweme/v1/play/?video_id=<play_addr.uri>&line=0&ratio=1080p&aid=6383
//     它 302 到 CDN 后是 **200 video/mp4**（跟随跳转即可，实测 4 种参数写法都通）。
//   · 所以本函数**不往 playCandidates 里塞 CDN 直链** —— 塞了会被优先挑中，而它们是 403。
//     （历史上 `nativePlayableUrl()` 正是"优先挑直链 CDN"的那个函数，**已删除**，见 §15.12。
//      现在选地址只有一处：`playUrlCandidates()` + 播放页 `startWithFallback()`。）
//
// 备选接口（同样免签名，已实测）：
//   `aweme/v1/web/aweme/detail/?aweme_id=<id>` → aweme_detail（单条视频详情）
//   `aweme/v1/web/hot/search/list/`            → 抖音热榜（web 版）
export const DOUYIN_WEB_TAB_FEED = 'https://www.douyin.com/aweme/v1/web/tab/feed/';
// 并发打几次（每次成本很小，但真机上是串行 TLS，6 次能拿 30+ 条且不至于太慢）
const TAB_FEED_CALLS = 6;

function tabFeedUrl(refreshIndex) {
  return DOUYIN_WEB_TAB_FEED +
    '?device_platform=webapp&aid=6383&channel=channel_pc_web' +
    '&count=10&refresh_index=' + refreshIndex;
}

// play_addr.uri → 可直接交给原生播放器的地址（302 由 FFmpeg 自己跟）
export function douyinPlayUrl(uri) {
  const id = String(uri || '').trim();
  if (!id) return '';
  return 'https://www.douyin.com/aweme/v1/play/?video_id=' + encodeURIComponent(id) +
    '&line=0&ratio=1080p&aid=6383';
}

function firstUrl(box) {
  const list = (box && box.url_list) || [];
  for (let i = 0; i < list.length; i++) {
    if (list[i]) return String(list[i]);
  }
  return '';
}

// 官方 web feed 的一条 → 本工程的信息流条目形态
function mapWebAweme(a, index) {
  const video = (a && a.video) || {};
  const addr = video.play_addr || {};
  const stats = (a && a.statistics) || {};
  const author = (a && a.author) || {};
  const uri = addr.uri || '';
  const playUrl = douyinPlayUrl(uri);
  const desc = String((a && a.desc) || '').trim();
  return {
    source: 'douyin-web-feed',
    videoId: String((a && a.aweme_id) || ''),
    // 视频条目已带 playUrl，点开即播，不需要再解析
    playUrl: playUrl,
    playCandidates: [],
    title: desc || ('抖音视频 ' + (index + 1)),
    desc: desc || '抖音推荐',
    author: author.nickname || '抖音用户',
    cover: firstUrl(video.cover) || firstUrl(video.origin_cover) || firstUrl(video.dynamic_cover),
    // duration 是**毫秒**
    durationMs: Number(video.duration || 0),
    likes: Number(stats.digg_count || 0),
    comments: Number(stats.comment_count || 0),
    shares: Number(stats.share_count || 0),
    // 分享页链接：解析失败时的兜底入口
    url: a && a.aweme_id ? ('https://www.douyin.com/video/' + a.aweme_id) : '',
    music: (video.music && video.music.title) || '',
    createTime: Number((a && a.create_time) || 0)
  };
}

// 打一次 web feed
async function fetchTabFeedOnce(refreshIndex) {
  const url = tabFeedUrl(refreshIndex);
  const payload = await jsapiHttpRequest({
    url: url,
    headers: withCookies(url, {
      'User-Agent': DOUYIN_SHARE_UA,
      Referer: 'https://www.douyin.com/',
      Accept: 'application/json, text/plain, */*'
    }),
    timeoutMs: API_TIMEOUT_MS
  });
  if (!payload || typeof payload !== 'object') {
    throw new Error('web feed 返回异常：' + previewPayload(payload));
  }
  if (payload.status_code !== 0) {
    throw new Error('web feed status_code=' + payload.status_code);
  }
  const list = payload.aweme_list;
  return Array.isArray(list) ? list : [];
}

// 抖音官方 web 视频首页：并发多次 + 去重，返回可直接播放的条目列表
export async function fetchDouyinWebFeed() {
  const results = await Promise.all(
    Array.from({ length: TAB_FEED_CALLS }, (unused, i) => fetchTabFeedOnce(i).catch(() => []))
  );
  const seen = {};
  const out = [];
  for (let i = 0; i < results.length; i++) {
    const list = results[i];
    for (let k = 0; k < list.length; k++) {
      const a = list[k];
      if (!a || !a.aweme_id) continue;
      const id = String(a.aweme_id);
      if (seen[id]) continue;
      // 只要带得动播放地址的（要有 video.play_addr.uri）
      const uri = ((a.video || {}).play_addr || {}).uri;
      if (!uri) continue;
      seen[id] = true;
      out.push(mapWebAweme(a, out.length));
    }
  }
  if (!out.length) throw new Error('web feed 没有拿到任何带播放地址的视频');
  return out;
}

// 60s 实例：抖音热榜，含标题/热度/封面/链接（第三方域名，不带 Cookie）
export async function fetchHotFeed() {
  const payload = await jsapiHttpRequest({
    url: DOUYIN_HOT_FEED_API,
    headers: withCookies(DOUYIN_HOT_FEED_API),
    timeoutMs: API_TIMEOUT_MS
  });
  if (!payload || payload.code !== 200 || !Array.isArray(payload.data)) {
    throw new Error('热榜接口返回异常：' + previewPayload(payload));
  }
  return payload.data.map((item, index) => ({
    source: 'hot-feed',
    author: '抖音热榜',
    title: (item && item.title) || '热榜视频',
    likes: Number((item && item.hot_value) || 0),
    comments: 0,
    shares: 0,
    cover: (item && item.cover) || '',
    link: (item && item.link) || '',
    videoId: extractVideoId(item && item.link) || 'hot-' + (index + 1),
    eventTime: (item && item.event_time) || ''
  }));
}

// 抖音官方 web 热搜词榜（备用，无封面；字节系域名，登录后会带 Cookie）
export async function fetchHotWords() {
  const payload = await jsapiHttpRequest({
    url: DOUYIN_HOT_WORDS_API,
    headers: withCookies(DOUYIN_HOT_WORDS_API),
    timeoutMs: API_TIMEOUT_MS
  });
  const words = payload && Array.isArray(payload.word_list) ? payload.word_list : [];
  if (!words.length) throw new Error('热搜词接口返回异常：' + previewPayload(payload));
  return words.map((item, index) => ({
    source: 'hot-words',
    author: '抖音热搜',
    title: (item && item.word) || '热搜',
    likes: Number((item && item.hot_value) || 0),
    comments: 0,
    shares: 0,
    cover: '',
    link: 'https://www.douyin.com/search/' + encodeURIComponent((item && item.word) || ''),
    videoId: 'word-' + (index + 1),
    eventTime: (payload && payload.active_time) || ''
  }));
}

// ---------- 视频解析：iesdouyin 分享页 -> _ROUTER_DATA -> item_list ----------

// 请求分享页 HTML。必须带移动端 UA 与 ttwid Cookie，否则拿到的是无数据的桌面版页面。
// 登录后优先带完整登录 Cookie；若带 Cookie 反而拿不到数据，自动退回只带 ttwid 重试一次。
// ttwid 失效是最常见的失败原因：配了中转时会**自动重新注册一次**再重试，免掉手动 `npm run ttwid`。
let ttwidRefreshTried = false;

async function fetchSharePage(url) {
  const ttwidOnly = 'ttwid=' + DOUYIN_TTWID;
  const candidates = [];
  if (hasLoginCookie()) candidates.push(cookieHeader());
  candidates.push(ttwidOnly);

  let lastError = null;
  for (let i = 0; i < candidates.length; i++) {
    const cookie = candidates[i];
    if (i > 0 && cookie === candidates[0]) continue;
    const headers = { 'User-Agent': DOUYIN_SHARE_UA, Cookie: cookie };
    let html;
    try {
      html = await jsapiHttpRequest({ url, headers, timeoutMs: API_TIMEOUT_MS });
    } catch (error) {
      lastError = error;
      continue;
    }
    if (typeof html === 'string' && html.indexOf('_ROUTER_DATA') >= 0) return html;
    lastError = new Error('分享页返回异常：' + previewPayload(html)
      + '（ttwid 可能已失效，执行 npm run ttwid 刷新）');
  }

  // 一次机会：自动重新注册 ttwid（需要中转），成功就用新 ttwid 再请求一次
  if (!ttwidRefreshTried) {
    ttwidRefreshTried = true;
    try {
      const fresh = await refreshTtwid();
      const html = await jsapiHttpRequest({
        url,
        headers: { 'User-Agent': DOUYIN_SHARE_UA, Cookie: 'ttwid=' + fresh.ttwid },
        timeoutMs: API_TIMEOUT_MS
      });
      if (typeof html === 'string' && html.indexOf('_ROUTER_DATA') >= 0) return html;
      lastError = new Error('自动刷新 ttwid 后分享页仍异常：' + previewPayload(html));
    } catch (error) {
      // 没配中转 / 注册失败：保留原始错误，提示里已说明可手动刷新
    }
  }

  throw lastError || new Error('分享页请求失败');
}

function extractShareItem(html) {
  const match = html.match(/window\._ROUTER_DATA\s*=\s*(\{[\s\S]*?\})\s*<\/script>/);
  if (!match) return null;

  let router;
  try {
    router = JSON.parse(match[1]);
  } catch (error) {
    return null;
  }

  const pages = (router && router.loaderData) || {};
  for (const key in pages) {
    const page = pages[key];
    if (!page || typeof page !== 'object' || !page.videoInfoRes) continue;
    let info = page.videoInfoRes;
    if (typeof info === 'string') {
      try {
        info = JSON.parse(info);
      } catch (error) {
        continue;
      }
    }
    const items = info && info.item_list;
    if (Array.isArray(items) && items.length) return items[0];
  }
  return null;
}

function mapShareItem(item, sourceUrl) {
  const video = item.video || {};
  const playAddr = video.play_addr || {};
  const urlList = (playAddr.url_list || []).map(String);
  // 登录态 iteminfo 的直链 CDN 藏在 video.bit_rate[].play_addr.url_list 里，一并收进候选
  (Array.isArray(video.bit_rate) ? video.bit_rate : []).forEach((one) => {
    const list = (one && one.play_addr && one.play_addr.url_list) || [];
    list.forEach((u) => {
      const text = String(u);
      if (urlList.indexOf(text) < 0) urlList.push(text);
    });
  });
  const coverList = (video.cover && video.cover.url_list) || [];
  // 直链 CDN（不是 /aweme/v1/play 那个 302 入口）优先：原生解码器可以把 https 换成
  // 明文 http 直接播（实测 CDN 支持 http + Range），从而**不依赖中转**。
  const direct = urlList.filter(isDirectCdnUrl);
  const entry = urlList.find((u) => !isDirectCdnUrl(u)) || '';
  const prefer = direct[0] || entry || urlList[0] || '';
  const statistics = item.statistics || {};
  return {
    source: 'share-parse',
    author: (item.author && item.author.nickname) || '抖音用户',
    title: item.desc || '解析视频',
    likes: Number(statistics.digg_count || 0),
    comments: Number(statistics.comment_count || 0),
    shares: Number(statistics.share_count || 0),
    cover: coverList[0] || '',
    playUrl: String(prefer).replace('/playwm/', '/play/'),
    // 全部候选：播放时从中挑一条可用 http 直链，尽量不走中转
    playCandidates: urlList.map((u) => String(u).replace('/playwm/', '/play/')),
    link: sourceUrl,
    videoId: item.aweme_id || playAddr.uri || ''
  };
}

// 直链 CDN：排除 /aweme/v1/play(wm) 这种需要 302 跳转的入口
function isDirectCdnUrl(url) {
  const text = String(url || '');
  if (!/^https?:\/\//i.test(text)) return false;
  if (text.indexOf('/aweme/v1/play') >= 0) return false;
  return /douyinvod|douyinpic|bytecdn|pstatp|amemv|snssdk|bytedance|ixigua|zjcdn|byteimg/i.test(text);
}

// 第三方/自建解析实例（Douyin_TikTok_Download_API 兼容格式）
async function parseViaExternalApi(rawUrl) {
  const endpoint = DOUYIN_VIDEO_PARSE_API.replace(/\/$/, '') +
    '/api/hybrid/video_data?url=' + encodeURIComponent(rawUrl) + '&minimal=true';
  const payload = await jsapiHttpRequest({ url: endpoint, timeoutMs: API_TIMEOUT_MS });
  const item = payload && payload.data ? payload.data : payload;
  if (!item || !item.aweme_id) throw new Error('解析实例未返回视频数据');
  const playAddr = (item.video && item.video.play_addr) || {};
  const urlList = playAddr.url_list || [];
  const coverList = (item.video && item.video.cover && item.video.cover.url_list) || [];
  const statistics = item.statistics || {};
  return {
    source: 'parse-api',
    author: (item.author && item.author.nickname) || '抖音用户',
    title: item.desc || '解析视频',
    likes: Number(statistics.digg_count || 0),
    comments: Number(statistics.comment_count || 0),
    shares: Number(statistics.share_count || 0),
    cover: coverList[0] || '',
    playUrl: urlList[0] ? String(urlList[0]).replace('/playwm/', '/play/') : '',
    link: rawUrl,
    videoId: item.aweme_id
  };
}

// 登录态的批量 JSON 接口：一次拿多个视频的完整信息（体积小、比分享页快得多）。
// 未登录时抖音直接返回 status_code 11110，所以未登录就跳过，不浪费一次请求。
export async function fetchItemInfo(itemIds) {
  const ids = (itemIds || []).filter(Boolean);
  if (!ids.length) throw new Error('缺少 item_ids');
  if (!hasLoginCookie()) throw new Error('未登录，跳过 iteminfo（抖音返回 11110）');

  const url = 'https://www.iesdouyin.com/web/api/v2/aweme/iteminfo/?item_ids=' + ids.join(',');
  const payload = await jsapiHttpRequest({
    url,
    headers: withCookies(url, { 'User-Agent': DOUYIN_SHARE_UA }),
    timeoutMs: API_TIMEOUT_MS
  });
  const list = payload && payload.item_list;
  if (!Array.isArray(list) || !list.length) {
    throw new Error('iteminfo 无数据（status_code=' + ((payload && payload.status_code) || '?') + '）');
  }
  return list.map((item) => mapShareItem(item, ''));
}

// 按分享链接/文案解析视频。优先配置的解析实例，否则走内置分享页解析
export async function parseVideoByUrl(rawUrl) {
  if (DOUYIN_VIDEO_PARSE_API) {
    try {
      return await parseViaExternalApi(rawUrl);
    } catch (error) {
      // 实例失败时退回内置解析
    }
  }

  const videoId = extractVideoId(rawUrl);

  // 登录态优先走批量 JSON 接口：同样能拿到无水印 play_addr，但响应只有几 KB
  if (videoId && hasLoginCookie()) {
    try {
      const items = await fetchItemInfo([videoId]);
      if (items.length) return items[0];
    } catch (error) {
      // 退回分享页解析
    }
  }

  // 有 id 直接构造分享页；纯短链则跟随重定向解析返回的页面
  const target = videoId
    ? 'https://www.iesdouyin.com/share/video/' + videoId + '/'
    : String(rawUrl || '').trim();
  if (!target) throw new Error('链接为空');

  const html = await fetchSharePage(target);
  let item = extractShareItem(html);

  if (!item && !videoId) {
    // 重定向页只含路由信息时，从 lastPath 提取 id 再解析一次
    const match = html.match(/lastPath":"(\d{8,})"/);
    if (match) {
      const retryHtml = await fetchSharePage('https://www.iesdouyin.com/share/video/' + match[1] + '/');
      item = extractShareItem(retryHtml);
    }
  }

  if (!item) throw new Error('未能从分享页解析出视频（ttwid 可能已失效，执行 npm run ttwid 刷新）');
  return mapShareItem(item, rawUrl);
}
