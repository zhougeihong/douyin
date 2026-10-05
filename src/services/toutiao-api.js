// 今日头条数据层
//
// ⚠️ 所有接口都是 **2026-10 实测**（探测脚本 .temp/probe-toutiao*.mjs），不要凭直觉改：
//
// ① 热榜（未登录可用）
//    https://60s-api.viki.moe/v2/toutiao
//    → { code, message, data:[{ title, hot_value, cover, link }] }  50 条
//    link 指向 www.toutiao.com/trending/<id>/，是 SPA 外壳，**未登录抓不到内容**。
//
// ② 信息流（未登录可用，分页靠 max_behot_time）
//    https://www.toutiao.com/api/pc/feed/?category=news_hot&utm_source=toutiao&max_behot_time=<ts>
//    → { has_more, data:[{ title, abstract, image_url, source, source_url, group_id,
//                          behot_time, comments_count, tag_url, video_id, has_video,
//                          video_duration_str, video_play_count, ... }] }
//    注意：`category=video` / `news_video` / `entertainment` / `weitoutiao` **全部返回空数组**，
//    只有 `news_hot`、`media`、以及**不带 category** 三条能出数据。别浪费时间试其它类目。
//
// ③ 正文（未登录可用 ★ 这是"观看"的落地方式）
//    https://m.toutiao.com/i<group_id>/   （必须用**移动端 UA**）
//    → HTML 里有 <script id="RENDER_DATA" type="application/json"> ，内容是 **URL 编码** 的 JSON，
//      decodeURIComponent 后取 articleInfo.content = **完整正文**（实测 2000~3500 字，带 HTML 标签）。
//      同时能拿到 title / publishTime / mediaUser(作者) / diggCount / commentCount /
//      videoId / videoDuration / posterUrl(封面)。
//
// ④ 视频直链：**做不了**（2026-10 多轮实测确认，别再试）
//
//    视频条目有 video_id、playAuthTokenV2 非空、posterUrl 有封面，但 playUrlList 恒为 null。
//    逐条试过并全部失败的路：
//      · douyin/字节 的 /aweme/v1/play/?video_id=<头条vid>  → **404**（该入口不认头条 vid）
//      · /video/url/v1|v2/（带 video_id、带 token）→ 200 但返回的是 **`_$jsvmprt` 混淆 JS VM**
//        （72914 字节），不是 JSON —— 和抖音 a_bogus 同一类墙
//      · /api/video/play/、/api/pc/video/、/video/play/ → 404
//      · VOD 的 `vod.bytedanceapi.com/?Action=GetPlayInfo&Version=2019-03-15` **端点存在**
//        （返回 RequestId/Action），但需要 `PlayInfoToken`；而 `playAuthTokenV2` 是
//        **单段 JWE（加密 JWT）**——载荷是 `{"GetPlayInfoToken":"Action=GetPlayInfo&
//        X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=AKLT…/cn-north-1/vod/aws4_request…"}`
//        但整串是**加密**的，没有密钥取不出内层 token → 只能拿到 InvalidParameter。
//      · 详情页 HTML 里 **0 条** mp4/m3u8/douyinvod 直链。
//
//    → 与抖音那边的 a_bogus 属同一类墙。所以**「观看」= 读正文**，
//      视频条目只标记「视频」+ 展示时长/播放量，点开仍走正文（多数带完整文字）。
//      要比"读正文"更近一步，只能上真机浏览器环境（WebView 级）跑官方 JS，笔上跑不了。

import { jsapiHttpRequest, jsapiStorageGet, jsapiStorageSet } from './libjsapi.js';
import { API_TIMEOUT_MS, DOUYIN_SHARE_UA } from '../config.js';

export const TOUTIAO_HOT_API = 'https://60s-api.viki.moe/v2/toutiao';
export const TOUTIAO_FEED_API = 'https://www.toutiao.com/api/pc/feed/';
export const TOUTIAO_MOBILE_DETAIL = 'https://m.toutiao.com/article';

// 头条用自己独立的 storage 前缀，**不要**和抖音的 douyin_* 混（登录态/点赞/历史都分开）
export const TOUTIAO_KEYS = {
  session: 'toutiao_session',
  cookies: 'toutiao_cookies',
  likes: 'toutiao_likes',
  history: 'toutiao_history',
  comments: 'toutiao_comments'
};

const PC_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';

// ------------------------------------------------------------------
// 小工具
// ------------------------------------------------------------------

function toInt(v, fallback) {
  const n = parseInt(v, 10);
  return isNaN(n) ? (fallback || 0) : n;
}

// 把 //p3.pstatp.com/... 这种协议相对 URL 补全
function normalizeUrl(u) {
  const s = String(u || '').trim();
  if (!s) return '';
  if (s.indexOf('//') === 0) return 'https:' + s;
  if (s.indexOf('http://') === 0) return 'https://' + s.slice(7);
  return s;
}

// ★ 头条封面：**只有「带签名」的图片 URL 能用**（2026-10 实测，别再试别的写法）。
//
// 实测结论：
//   · 聚合接口（60s）给的封面是 `p3-sign.toutiaoimg.com/…~tplv…&x-signature=…` → **6/6 可用**；
//   · 头条自家 feed 给的封面是**未签名**的：
//       `//p3.pstatp.com/list/190x124/…` → **DNS 都解析不出来**（pstatp.com 已废）
//       `http://p3.toutiaoimg.com/list/…`  → **403**（试过换主机 p1/p3/p6/p9、换路径
//         list/origin/large、加 Referer/Origin/完整浏览器头 —— **一律 403**，不是防盗链问题）
//   · 详情页里能 200 的图片只有**站点静态资源**（`lf-dw.toutiaostatic.com/obj/toutiao-duanwai/…`），
//     正文/封面图同样 403。
// → 所以**未签名的封面无法显示**，这不是我们的 bug。这里做两件事：
//     ① 只放行"已知可用"的域名（带签名的那个 + 静态站）；
//     ② 其余（pstatp/toutiaoimg 未签名）一律返回 ''，让页面显示占位而不是去加载必失败的图。
const COVER_OK_HOSTS = /(^|\.)(toutiaoimg\.com|toutiaostatic\.com|byteimg\.com)$/i;
const SIGNED_OR_SIGN_HOST = /-sign\.toutiaoimg\.com$/i;

export function isUsableCover(url) {
  const u = normalizeUrl(url);
  if (!u || u.indexOf('https://') !== 0) return false;
  // ⚠️ 不要用 `new URL()` —— QuickJS 里 URL 不一定存在，异常被吞会导致永远 false（番茄那边踩过）
  const m = /^https:\/\/([^/?#:]+)/i.exec(u);
  if (!m) return false;
  const host = m[1].toLowerCase();
  if (!COVER_OK_HOSTS.test(host)) return false;
  // 静态资源站直接可用
  if (/toutiaostatic\.com$/.test(host)) return true;
  // 带签名的图片站可用
  if (SIGNED_OR_SIGN_HOST.test(host)) return true;
  // 其余 toutiaoimg/byteimg：**只有带签名参数**才可用
  return /[?&](x-signature|tplv|x-expires)=/i.test(u) || /~tplv-/i.test(u);
}

// 选一个真正能用的封面（没有就返回 ''，页面据此显示占位）
function pickCover() {
  for (let i = 0; i < arguments.length; i++) {
    const u = normalizeUrl(arguments[i]);
    if (isUsableCover(u)) return u;
  }
  return '';
}

// {url_list:[...]} → 第一个非空 URL
function firstUrl(box) {
  const list = (box && box.url_list) || [];
  for (let i = 0; i < list.length; i++) {
    if (list[i]) return String(list[i]);
  }
  return '';
}

// image_list 是数组，元素可能是字符串或 {url}
function firstUrlOf(list) {
  if (!Array.isArray(list) || !list.length) return '';
  const v = list[0];
  if (typeof v === 'string') return v;
  return (v && (v.url || (v.url_list && v.url_list[0]))) || '';
}

// 去掉正文里的 HTML 标签，得到纯文本（Weex 的 <text> 不认 HTML）
export function stripHtml(html) {
  return String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// 从移动端详情页 HTML 里抽 <script id="RENDER_DATA"> 的 URL 编码 JSON
export function extractRenderData(html) {
  const text = String(html || '');
  const m = /<script[^>]*id=["']RENDER_DATA["'][^>]*>([\s\S]*?)<\/script>/i.exec(text);
  if (!m) return null;
  let decoded;
  try {
    decoded = decodeURIComponent(m[1]);
  } catch (error) {
    // URL 编码坏了也别整页报废：去掉首尾空白直接试
    decoded = m[1];
  }
  try {
    return JSON.parse(decoded);
  } catch (error) {
    return null;
  }
}

// 把 RENDER_DATA 收敛成页面要用的结构
export function normalizeArticle(renderData, fallback) {
  const fb = fallback || {};
  const rd = renderData || {};
  const ai = rd.articleInfo || {};
  const seo = rd.seoTDK || {};
  const mediaUser = ai.mediaUser || {};
  const content = stripHtml(ai.content || '');
  const groupId = String(ai.gid || fb.groupId || '');
  return {
    kind: 'article',
    groupId: groupId,
    title: ai.title || seo.title || fb.title || '',
    author: mediaUser.name || mediaUser.screenName || ai.source || fb.source || '今日头条',
    abstract: seo.abstract || fb.abstract || '',
    content: content,
    contentLength: content.length,
    publishTime: toInt(ai.publishTime, toInt(fb.publishTime, 0)),
    cover: pickCover(ai.posterUrl, fb.imageUrl, fb.cover),
    diggCount: toInt(ai.diggCount, 0),
    commentCount: toInt(ai.commentCount, toInt(fb.commentsCount, 0)),
    // 视频元信息保留：播放地址拿不到（见文件头 ④），但至少能告诉用户这是条视频
    videoId: ai.videoId || fb.videoId || '',
    videoDuration: toInt(ai.videoDuration, 0),
    videoPlayable: false,
    hasVideo: !!(ai.videoId || fb.videoId || fb.hasVideo)
  };
}

// ------------------------------------------------------------------
// 接口
// ------------------------------------------------------------------

// 热榜（50 条，带封面与热度）
export function fetchToutiaoHot() {
  // 注意：本接口（60s 聚合）给的 cover 是**带签名**的 → 实测可用，是唯一能稳定出图的热榜源。
  return jsapiHttpRequest({
    url: TOUTIAO_HOT_API,
    method: 'GET',
    headers: { 'User-Agent': PC_UA, Accept: 'application/json' },
    timeoutMs: API_TIMEOUT_MS
  }).then((body) => {
    const list = (body && body.data) || [];
    if (!Array.isArray(list) || !list.length) throw new Error('头条热榜返回为空');
    return list.map((it) => ({
      kind: 'hot',
      title: String(it.title || ''),
      hotValue: toInt(it.hot_value, 0),
      cover: pickCover(it.cover),
      link: String(it.link || ''),
      // trending/<id> 里的 id 有时能对上 group_id，用于尝试取正文
      groupId: (String(it.link || '').match(/trending\/(\d+)/) || [])[1] || ''
    }));
  });
}

// 信息流（分页：maxBehotTime 传上一页最后一条的 behot_time）
export function fetchToutiaoFeed(maxBehotTime) {
  const ts = maxBehotTime || '0';
  const url = TOUTIAO_FEED_API + '?category=news_hot&utm_source=toutiao&max_behot_time=' + encodeURIComponent(ts);
  return jsapiHttpRequest({
    url: url,
    method: 'GET',
    headers: { 'User-Agent': PC_UA, Accept: 'application/json' },
    timeoutMs: API_TIMEOUT_MS
  }).then((body) => {
    const list = (body && body.data) || [];
    const items = list
      // 过滤广告位：is_feed_ad 为真时是投放，不是内容
      .filter((it) => !it.is_feed_ad)
      .map((it) => {
        const groupId = String(it.group_id || (String(it.source_url || '').match(/(\d+)/) || [])[1] || '');
        return {
          kind: 'feed',
          groupId: groupId,
          title: String(it.title || ''),
          abstract: String(it.abstract || ''),
          // 头条自家 feed 的封面未签名，实测一律不可用 → pickCover 会返回 ''（页面显示占位）
          cover: pickCover(it.image_url, it.middle_image, firstUrlOf(it.image_list)),
          source: String(it.source || it.chinese_tag || ''),
          commentsCount: toInt(it.comments_count, 0),
          behotTime: toInt(it.behot_time, 0),
          videoId: String(it.video_id || ''),
          hasVideo: !!it.has_video,
          videoDurationStr: String(it.video_duration_str || ''),
          videoPlayCount: toInt(it.video_play_count, 0)
        };
      });
    // has_more 为 0 表示到底了
    const hasMore = !!(body && body.has_more);
    const nextMax = items.length ? String(items[items.length - 1].behotTime) : '';
    return { items: items, hasMore: hasMore, nextMaxBehotTime: nextMax };
  });
}

// 取正文（"观看"的落地实现）。必须走 m.toutiao.com + 移动端 UA，否则拿不到 RENDER_DATA。
//
// ⚠️ 实测坑：`https://m.toutiao.com/i<id>/` 会 **302 跳**到 `/article/<id>/`，
// 而我们的 jsapiHttpRequest（以及 relay）**都不跟随重定向** —— 直接抓 /i 只会拿到
// 一个 131 字节的 "Redirecting to <a href=…>" HTML。所以这里：
//   ① 先用规范地址 /article/<id>/（实测 200 直出 RENDER_DATA）；
//   ② 万一还是拿到跳转页，就从 body 里抠出目标 URL 再抓一次。
const REDIRECT_HINT = /Redirecting to <a\s+href=["']([^"']+)["']/i;

function fetchArticleHtml(url) {
  return jsapiHttpRequest({
    url: url,
    method: 'GET',
    headers: { 'User-Agent': DOUYIN_SHARE_UA, Accept: 'text/html' },
    timeoutMs: API_TIMEOUT_MS
  }).then((body) => (typeof body === 'string' ? body : ''));
}

export function fetchToutiaoArticle(groupId, fallback) {
  const id = String(groupId || '').trim();
  if (!id) return Promise.reject(new Error('缺少 groupId'));
  const canonical = 'https://m.toutiao.com/article/' + id + '/';
  return fetchArticleHtml(canonical).then((html) => {
    let text = html;
    const jump = REDIRECT_HINT.exec(text);
    if (jump && !/id=["']RENDER_DATA["']/i.test(text)) {
      // 被跳转了：按 Location 里的地址再抓一次
      return fetchArticleHtml(jump[1]).then((html2) => finishArticle(html2, fallback));
    }
    return finishArticle(text, fallback);
  });
}

function finishArticle(html, fallback) {
  const rd = extractRenderData(html);
  if (!rd) throw new Error('正文页没有 RENDER_DATA（可能被风控或该条是纯话题页）');
  const article = normalizeArticle(rd, fallback);
  if (!article.content) throw new Error('该条没有可读正文（可能是纯视频/话题）');
  return article;
}

// 时间戳 → 相对时间（小屏上比绝对时间好读）
export function relativeTime(ts) {
  const t = toInt(ts, 0);
  if (!t) return '';
  // 头条给的是秒级时间戳
  const ms = t > 1e12 ? t : t * 1000;
  const diff = Date.now() - ms;
  if (diff < 0) return '刚刚';
  const min = Math.floor(diff / 60000);
  if (min < 1) return '刚刚';
  if (min < 60) return min + ' 分钟前';
  const hour = Math.floor(min / 60);
  if (hour < 24) return hour + ' 小时前';
  const day = Math.floor(hour / 24);
  if (day < 30) return day + ' 天前';
  return new Date(ms).toISOString().slice(0, 10);
}

// ============================================================
// 评论
// ============================================================
// ⚠️ 头条的**线上评论列表拿不到**（2026-10 多轮实测）：
//   · `/api/comment/list/` 各种参数组合（group_id/item_id/offset/count/aid/app_name/
//     带 Referer、PC 与移动 UA）→ **恒定 500 Internal Server Error**；
//   · `/2/comment/list/`、`/api/comment/v1/list/`、`/api/pc/comment/list/` → 404；
//   · `/article/comment/...` → 200 但返回的是 `_$jsvmprt` 混淆 JS VM；
//   · 详情页 RENDER_DATA 里有 `articleInfo.commentCount`（如 6560），但**没有评论正文**。
//   → 结论：要评论内容必须过签名（与 a_bogus 同类）。
//
// 所以这里的评论是**本地评论**：存在本机 storage，按 groupId 分组。
// 列表里展示的 `commentsCount` 是头条给的**真实评论总数**（来自 feed）。
// 页面上会明确标注"本地评论"与"头条 N 条评论"，不会假装是抓来的。

// 读出全部本地评论：{ groupId: [ {id, text, at} ] }
export async function loadComments() {
  try {
    const v = await jsapiStorageGet(TOUTIAO_KEYS.comments);
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
  } catch (error) {
    return {};
  }
}

export function commentsOf(all, groupId) {
  const key = String(groupId || '');
  const list = (all && all[key]) || [];
  return Array.isArray(list) ? list : [];
}

// 追加一条本地评论（返回新的整体对象，便于调用方直接落盘）
export function appendComment(all, groupId, text) {
  const key = String(groupId || '');
  const body = String(text || '').trim();
  if (!key || !body) return all;
  const next = Object.assign({}, all || {});
  const list = Array.isArray(next[key]) ? next[key].slice() : [];
  list.push({
    id: 'c' + Date.now() + '_' + Math.floor(Math.random() * 1000),
    text: body.slice(0, 200),
    at: Date.now()
  });
  // 每个条目最多留 50 条，避免撑爆笔上的存储
  next[key] = list.slice(-50);
  return next;
}

export function removeComment(all, groupId, id) {
  const key = String(groupId || '');
  const next = Object.assign({}, all || {});
  const list = Array.isArray(next[key]) ? next[key] : [];
  next[key] = list.filter((c) => c && c.id !== id);
  return next;
}

export async function persistComments(all) {
  return jsapiStorageSet(TOUTIAO_KEYS.comments, all || {});
}

// 本地评论总条数（用于列表角标）
export function localCommentCount(all, groupId) {
  return commentsOf(all, groupId).length;
}

