// 番茄小说（fanqienovel.com）数据层
//
// ⚠️ 全部接口均 **2026-10 实测**（探测脚本 .temp/probe-fq*.mjs）。番茄与头条/抖音同属字节。
//
// ✅ 能拿到的（本模块已接）：
//   ① 书单：`GET /api/rank/list?type=N`（N = 0/1/2，实测 3 之后为空；合计去重 26 本）
//      → { data:{ list:[{ bookId, bookName, author, abstract, thumbUri }] }, code:0 }
//      **thumbUri 带签名**（`p3-reading-sign.fqnovelpic.com/…?x-signature=…`）→ 实测可显示。
//   ② 书籍页：`GET /page/<bookId>`（HTML，170KB+）→ 里面就是 `window.__INITIAL_STATE__`，
//      含 **完整章节表**：336 个 `itemId`（章节 id）+ 章节标题（"第一章 这块玉很古怪"…）。
//   ③ 正文：`GET /reader/<chapterId>`（HTML，44KB）→ `chapterData`：
//      `{ bookName, author, nextItemId, …, content:"<p>…</p>" }`
//      **content 是完整正文**（HTML 转义），`nextItemId` 可直接连读下一章。
//   ④ 登录：`sso.toutiao.com/passport/sso/get_qrcode/?service=https://fanqienovel.com`
//      → 200，`app_name: "番茄小说"`。**就是字节统一账号 SSO**，
//      可直接复用 `src/services/douyin-auth.js` 的 `requestLoginQr({hint})` / `checkLoginQr`。
//
// ❌ 拿不到的（实测，别再试）：
//   · **搜索**：`/search`、`/api/search/book`、`/api/search/v1`、`/api/book/search` → 404；
//     `/api/author/search/search_book/v1` → 200 但空体。所以书源只有榜单那 26 本。
//   · **分类/书库**：`/library` 是 SPA 空壳；`/api/library/list`、`/api/book/list`、
//     `/api/category/list` → 404。
//   · `/api/book/info` 要 `bookId` 参数（传 book_id 会返回"没有bookId"）；其它 `/api/book/*` 全 404。
//
// ⚠️⚠️ 两个**硬限制**（决定"能读到什么"，实测）：
//
//  ① **不是每章都能读正文**：实测某书前 6 章里 **1、5 章可读**（4301 / 3981 字），
//     2、3、4、6 章只有 **24 字**（服务端返回的占位）。
//     ⚠️ 注意：`needPay` / `isChapterLock` / `isPaidPublication` **全是 0/false**，
//     靠这几个字段**判断不出来**；只能按**正文长度**判定（< 60 字视为拿不到）。
//     所以页面上章节是否可读，要等真正打开才知道。
//
//  ② **拿到的正文也有字体反爬**：约 **16% 的常用字**被替换成**私用区(PUA)码点**
//     （U+E000–U+F8FF）。页面内联 `@font-face` 指向一个**自定义字体**
//     （实测 `lf6-awef.bytetos.com/obj/awesome-font/c/dc027189e0ba4cd.otf`，
//      `font-family:DNMrHsV173Pd4pgy`），**该字体是全局固定的**（对照多章同一个文件），
//     共 **362 个 PUA 字形**（第一章用到 224 个）。
//     字形渲染出来**确实是可读的汉字**（已肉眼确认），但 CFF 字形名全是 `gidXXXXX`（无语义），
//     必须**渲染字形 + 与参考字体做像素比对**才能还原。
//     **本工程尝试过并放弃**：像素相关 / 二值 IoU 的 top-1 命中率只有 **~56%**
//     （对照人工读出的 16 个字测的）。错的字会**篡改原文**，比显示方块更糟，所以不采用。
//     → 现状：`fetchFanqieChapter` 把 PUA 换成「□」并给出 `masked/ratio`，
//       UI 如实提示"该章含 N 个字体反爬字符"。要真正还原需要更强的字形比对
//       （多字体投票 / 轮廓曲率特征），属于 PC 侧离线工具，见 HANDOFF §14。

import { jsapiHttpRequest, jsapiStorageGet, jsapiStorageSet } from './libjsapi.js';
import { API_TIMEOUT_MS, DOUYIN_SHARE_UA } from '../config.js';

export const FANQIE_RANK_API = 'https://fanqienovel.com/api/rank/list';
export const FANQIE_PAGE = 'https://fanqienovel.com/page/';
export const FANQIE_READER = 'https://fanqienovel.com/reader/';

// 独立 storage 前缀，不要和 douyin_* / toutiao_* 混
export const FANQIE_KEYS = {
  session: 'fanqie_session',
  shelf: 'fanqie_shelf',
  progress: 'fanqie_progress',
  history: 'fanqie_history',
  downloads: 'fanqie_downloads'
};

const PC_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// 实测有书的 type 值（3 及以上都返回空）
const RANK_TYPES = [0, 1, 2];

function toInt(v, fallback) {
  const n = parseInt(v, 10);
  return isNaN(n) ? (fallback || 0) : n;
}

// 封面：番茄给的是**带签名**的（x-signature / tplv），实测可显示；无签名的一律不用
// ⚠️ 这里**不要用 `new URL()`** —— QuickJS 运行时里 URL 不一定存在，
//    异常会被吞掉导致**永远返回 false**（封面全丢，实测踩过）。
//    所以用纯正则取主机名。
export function isUsableFanqieCover(url) {
  const u = String(url || '').trim();
  if (u.indexOf('https://') !== 0) return false;
  const m = /^https:\/\/([^/?#:]+)/i.exec(u);
  if (!m) return false;
  const host = m[1].toLowerCase();
  if (!/(^|\.)(fqnovelpic\.com|fqnovel\.com|byteimg\.com)$/.test(host)) return false;
  return /[?&]x-signature=/i.test(u) || /~tplv-/i.test(u);
}

function pickCover(u) {
  const s = String(u || '').trim();
  return isUsableFanqieCover(s) ? s : '';
}

// 去掉正文里的 HTML（复用与头条同一套思路：Weex 的 <text> 不认 HTML）
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

// 从 HTML 里抠出 window.__INITIAL_STATE__ = {...} 的 JSON
export function extractInitialState(html) {
  const text = String(html || '');
  const at = text.indexOf('__INITIAL_STATE__');
  if (at < 0) return null;
  const brace = text.indexOf('{', at);
  if (brace < 0) return null;
  // 括号配平扫描（字符串里也有 {}，所以要跳过字符串与转义）
  let depth = 0, inStr = false, esc = false;
  for (let i = brace; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (esc) { esc = false; }
      else if (ch === '\\') { esc = true; }
      else if (ch === '"') { inStr = false; }
      continue;
    }
    if (ch === '"') { inStr = true; continue; }
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) {
        try { return JSON.parse(text.slice(brace, i + 1)); } catch (error) { return null; }
      }
    }
  }
  return null;
}

// 书单（type=0/1/2 三份，去重）
export function fetchFanqieRank(type) {
  const t = (type === 0 || type === 1 || type === 2) ? type : 0;
  const url = FANQIE_RANK_API + '?type=' + t;
  return jsapiHttpRequest({
    url: url,
    method: 'GET',
    headers: { 'User-Agent': PC_UA, Accept: 'application/json' },
    timeoutMs: API_TIMEOUT_MS
  }).then((body) => {
    const list = (body && body.data && body.data.list) || [];
    if (!Array.isArray(list) || !list.length) throw new Error('番茄书单返回为空（type=' + t + '）');
    return list.map((b) => ({
      kind: 'book',
      bookId: String(b.bookId || ''),
      title: String(b.bookName || ''),
      author: String(b.author || ''),
      abstract: String(b.abstract || '').replace(/\s+/g, ' ').trim(),
      cover: pickCover(b.thumbUri),
      rankType: t
    })).filter((b) => b.bookId);
  });
}

// 三份榜单合并去重（书量少，够书架用）
export async function fetchFanqieShelf() {
  const results = await Promise.all(RANK_TYPES.map((t) => fetchFanqieRank(t).catch(() => [])));
  const seen = {};
  const out = [];
  for (let i = 0; i < results.length; i++) {
    const list = results[i];
    for (let k = 0; k < list.length; k++) {
      const b = list[k];
      if (seen[b.bookId]) continue;
      seen[b.bookId] = true;
      out.push(b);
    }
  }
  if (!out.length) throw new Error('番茄书架为空（三个榜单都没数据）');
  return out;
}

// 书籍页 → 章节表。返回 { bookId, title, author, abstract, cover, chapters:[{id,title}] }
export function fetchFanqieBook(bookId, fallback) {
  const id = String(bookId || '').trim();
  if (!id) return Promise.reject(new Error('缺少 bookId'));
  const fb = fallback || {};
  return jsapiHttpRequest({
    url: FANQIE_PAGE + id,
    method: 'GET',
    headers: { 'User-Agent': PC_UA, Accept: 'text/html' },
    timeoutMs: API_TIMEOUT_MS
  }).then((body) => {
    const html = typeof body === 'string' ? body : '';
    const state = extractInitialState(html);
    if (!state) throw new Error('书籍页没有 __INITIAL_STATE__（可能被风控）');
    const chapters = extractChapters(html, state);
    if (!chapters.length) throw new Error('这本书没有解析到章节列表');
    return {
      kind: 'book',
      bookId: id,
      title: findBookTitle(state) || fb.title || '',
      author: findAuthor(state) || fb.author || '',
      abstract: String(fb.abstract || ''),
      cover: pickCover(findCover(state)) || pickCover(fb.cover),
      chapters: chapters
    };
  });
}

// 章节表：优先从 state 里递归找，找不到就退回 HTML 正则
function extractChapters(html, state) {
  const out = [];
  const seen = {};
  const push = (id, title) => {
    const key = String(id || '');
    if (!/^\d{6,25}$/.test(key) || seen[key]) return;
    seen[key] = true;
    out.push({ id: key, title: String(title || '').trim() || ('第 ' + (out.length + 1) + ' 章') });
  };

  // ① state 里找章节数组（元素同时含 id 与 title 的那种）
  (function walk(node, depth) {
    if (depth > 8 || !node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (let i = 0; i < node.length; i++) {
        const it = node[i];
        if (it && typeof it === 'object') {
          const id = it.itemId || it.item_id || it.chapterId || it.chapter_id;
          const title = it.title || it.chapterTitle || it.chapter_name || it.name;
          if (id && /^\d{6,25}$/.test(String(id))) push(id, title);
        }
        walk(it, depth + 1);
      }
      return;
    }
    const keys = Object.keys(node);
    for (let i = 0; i < keys.length; i++) walk(node[keys[i]], depth + 1);
  })(state, 0);

  // ② 退回 HTML：itemId + 紧随其后的 title
  if (!out.length) {
    const re = /"itemId"\s*:\s*"(\d{6,25})"/g;
    const ids = [];
    let m;
    while ((m = re.exec(html)) !== null) ids.push(m[1]);
    const titles = [];
    const tre = /"title"\s*:\s*"([^"]{2,60})"/g;
    while ((m = tre.exec(html)) !== null) titles.push(m[1]);
    for (let i = 0; i < ids.length; i++) push(ids[i], titles[i]);
  }
  return out;
}

function deepFind(node, predicate, depth) {
  const d = depth || 0;
  if (d > 8 || !node || typeof node !== 'object') return null;
  if (Array.isArray(node)) {
    for (let i = 0; i < node.length; i++) {
      const r = deepFind(node[i], predicate, d + 1);
      if (r) return r;
    }
    return null;
  }
  const keys = Object.keys(node);
  for (let i = 0; i < keys.length; i++) {
    const v = node[keys[i]];
    if (predicate(keys[i], v)) return v;
    const r = deepFind(v, predicate, d + 1);
    if (r) return r;
  }
  return null;
}

function findBookTitle(state) {
  return deepFind(state, (k, v) => (k === 'bookName' || k === 'book_name') && typeof v === 'string' && v.length > 1);
}
function findAuthor(state) {
  return deepFind(state, (k, v) => k === 'author' && typeof v === 'string' && v.length > 0);
}
function findCover(state) {
  return deepFind(state, (k, v) => (k === 'thumbUri' || k === 'thumb_url') && typeof v === 'string' && v.indexOf('http') === 0);
}

// 正文字体反爬：把 PUA 码点换成「□」并统计，让 UI 能如实提示（详见文件头 ②）
export function maskPua(text) {
  const s = String(text || '');
  let count = 0;
  const out = [];
  for (const ch of s) {
    const cp = ch.codePointAt(0);
    if (cp >= 0xE000 && cp <= 0xF8FF) { count++; out.push('□'); }
    else out.push(ch);
  }
  const total = [...s].length || 1;
  return {
    text: out.join(''),
    masked: count,
    total: total,
    // 被遮比例（用于提示语的强弱）
    ratio: Math.round((count / total) * 100)
  };
}

// 读一章：返回 { chapterId, bookName, author, title, content, masked, ratio, nextItemId, prevItemId, locked }
export function fetchFanqieChapter(chapterId, fallback) {
  const id = String(chapterId || '').trim();
  if (!id) return Promise.reject(new Error('缺少 chapterId'));
  const fb = fallback || {};
  return jsapiHttpRequest({
    url: FANQIE_READER + id,
    method: 'GET',
    headers: { 'User-Agent': PC_UA, Accept: 'text/html' },
    timeoutMs: API_TIMEOUT_MS
  }).then((body) => {
    const html = typeof body === 'string' ? body : '';
    const state = extractInitialState(html);
    if (!state) throw new Error('章节页没有 __INITIAL_STATE__（可能被风控）');
    const cd = deepFind(state, (k, v) => k === 'chapterData' && v && typeof v === 'object') || {};
    const raw = cd.content || deepFind(state, (k, v) => k === 'content' && typeof v === 'string' && v.length > 50) || '';
    const stripped = stripHtml(raw);
    const masked = maskPua(stripped);
    // 判定"这一章能不能读"：**只能按正文长度**。
    // 实测 needPay/isChapterLock/isPaidPublication 全是 0/false，靠它们判不出来。
    const locked = masked.total < 60;
    if (!masked.text) throw new Error('这一章没有正文');
    return {
      kind: 'chapter',
      chapterId: id,
      bookId: String(cd.bookId || fb.bookId || ''),
      bookName: String(cd.bookName || fb.bookName || ''),
      author: String(cd.author || fb.author || ''),
      title: String(fb.title || cd.title || ''),
      content: masked.text,
      masked: masked.masked,
      total: masked.total,
      ratio: masked.ratio,
      locked: locked,
      // nextItemId 可直接连读下一章（实测有值）
      nextItemId: String(cd.nextItemId || ''),
      prevItemId: String(cd.preItemId || cd.prevItemId || '')
    };
  });
}

// ---------------- 本地书架 / 进度 ----------------

export async function loadShelf() {
  try {
    const v = await jsapiStorageGet(FANQIE_KEYS.shelf);
    return Array.isArray(v) ? v : [];
  } catch (error) {
    return [];
  }
}

export function inShelf(shelf, bookId) {
  const id = String(bookId || '');
  return (Array.isArray(shelf) ? shelf : []).some((b) => b && String(b.bookId) === id);
}

// 加入/移出书架（返回新数组，便于调用方直接落盘）
export function toggleShelf(shelf, book) {
  const list = Array.isArray(shelf) ? shelf.slice() : [];
  const id = String((book && book.bookId) || '');
  if (!id) return list;
  const idx = list.findIndex((b) => b && String(b.bookId) === id);
  if (idx >= 0) {
    list.splice(idx, 1);
    return list;
  }
  list.unshift({
    bookId: id,
    title: String(book.title || ''),
    author: String(book.author || ''),
    abstract: String(book.abstract || '').slice(0, 120),
    cover: pickCover(book.cover),
    at: Date.now()
  });
  return list.slice(0, 60);
}

export async function persistShelf(shelf) {
  return jsapiStorageSet(FANQIE_KEYS.shelf, Array.isArray(shelf) ? shelf : []);
}

// 阅读进度：{ [bookId]: { chapterId, chapterIndex, title, at } }
export async function loadProgress() {
  try {
    const v = await jsapiStorageGet(FANQIE_KEYS.progress);
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
  } catch (error) {
    return {};
  }
}

export function saveProgressTo(all, bookId, entry) {
  const next = Object.assign({}, all || {});
  const id = String(bookId || '');
  if (!id) return next;
  next[id] = Object.assign({}, entry || {}, { at: Date.now() });
  return next;
}

export async function persistProgress(all) {
  return jsapiStorageSet(FANQIE_KEYS.progress, all || {});
}

// 阅读历史（最近读过的章节，去重置顶）
export async function loadReadHistory() {
  try {
    const v = await jsapiStorageGet(FANQIE_KEYS.history);
    return Array.isArray(v) ? v : [];
  } catch (error) {
    return [];
  }
}

// ============================================================
// 下载（离线缓存）
// ============================================================
// ⚠️ 设备端**没有文件 API**（native 只注册了 storage 与 http），
//    且 HANDOFF §9 记过：把二进制经 native http 的字符串通道搬回来会损坏
//    （实测 42% 字节非法 UTF-8，**曾导致词典笔软重启**）。
//    → 所以"下载"**只能是"把可读章节的正文文本缓存到本机 storage"**，
//      不是下载文件。这样离线也能翻已缓存的章。
//
// 存储策略（笔上空间有限，必须设上限）：
//   · 每本书最多缓存 `CACHE_MAX_CHAPTERS` 章（默认 40），超出丢最早缓存的；
//   · 单章正文超过 `CACHE_MAX_CHARS` 字（默认 6000）就截断；
//   · 全书缓存总量上限 `CACHE_MAX_TOTAL` 字（默认 300000，约 600KB 文本）。
export const CACHE_MAX_CHAPTERS = 40;
export const CACHE_MAX_CHARS = 6000;
export const CACHE_MAX_TOTAL = 300000;

// 读出全部缓存：{ bookId: { title, chapters: { chapterId: {t, c, at} }, at } }
export async function loadDownloads() {
  try {
    const v = await jsapiStorageGet(FANQIE_KEYS.downloads);
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
  } catch (error) {
    return {};
  }
}

export async function persistDownloads(all) {
  return jsapiStorageSet(FANQIE_KEYS.downloads, all || {});
}

// 某本书已缓存的章节 id 列表
export function downloadedIds(all, bookId) {
  const b = (all || {})[String(bookId || '')];
  return b && b.chapters ? Object.keys(b.chapters) : [];
}

export function isDownloaded(all, bookId, chapterId) {
  const b = (all || {})[String(bookId || '')];
  return !!(b && b.chapters && b.chapters[String(chapterId || '')]);
}

// 取缓存正文（没有则返回 null）
export function cachedChapter(all, bookId, chapterId) {
  const b = (all || {})[String(bookId || '')];
  const c = b && b.chapters && b.chapters[String(chapterId || '')];
  return c ? c : null;
}

// 写入一章（返回新的整体对象，便于调用方直接落盘）
export function putChapter(all, bookId, chapterId, title, content) {
  const bid = String(bookId || '');
  const cid = String(chapterId || '');
  if (!bid || !cid) return all || {};
  const next = Object.assign({}, all || {});
  const book = Object.assign({ chapters: {} }, next[bid]);
  book.chapters = Object.assign({}, book.chapters);
  book.title = book.title || '';
  book.chapters[cid] = {
    t: String(title || ''),
    c: String(content || '').slice(0, CACHE_MAX_CHARS),
    at: Date.now()
  };
  book.at = Date.now();
  next[bid] = book;
  return next;
}

// 裁剪：每本 ≤ N 章（丢最早的）、总量 ≤ M 字（丢最旧的书）
export function pruneDownloads(all) {
  const next = Object.assign({}, all || {});
  // ① 每本限章数
  Object.keys(next).forEach((bid) => {
    const book = next[bid];
    if (!book || !book.chapters) return;
    const ids = Object.keys(book.chapters);
    if (ids.length <= CACHE_MAX_CHAPTERS) return;
    ids
      .sort((a, b) => (book.chapters[a].at || 0) - (book.chapters[b].at || 0))
      .slice(0, ids.length - CACHE_MAX_CHAPTERS)
      .forEach((id) => { delete book.chapters[id]; });
  });
  // ② 限总量：按"书最后写入时间"从旧到新丢
  const sizeOf = (book) => {
    if (!book || !book.chapters) return 0;
    return Object.keys(book.chapters).reduce((n, id) => n + String(book.chapters[id].c || '').length, 0);
  };
  let total = Object.keys(next).reduce((n, bid) => n + sizeOf(next[bid]), 0);
  if (total <= CACHE_MAX_TOTAL) return next;
  const byAge = Object.keys(next).sort((a, b) => (next[a].at || 0) - (next[b].at || 0));
  for (let i = 0; i < byAge.length && total > CACHE_MAX_TOTAL; i++) {
    const bid = byAge[i];
    total -= sizeOf(next[bid]);
    delete next[bid];
  }
  return next;
}

// 下载统计（给 UI 显示）
export function downloadStat(all, bookId) {
  const ids = downloadedIds(all, bookId);
  const b = (all || {})[String(bookId || '')];
  let chars = 0;
  if (b && b.chapters) {
    ids.forEach((id) => { chars += String(b.chapters[id].c || '').length; });
  }
  return { chapters: ids.length, chars: chars };
}

// 批量下载一本书的正文（串行 + 限速，避免被风控）。
// 返回 { all, done, locked, failed, stopped, scanned, lockedAt } ——
// `all` 是**已完成部分的累计结果**，调用方应边下边落盘（否则中断就前功尽弃）。
//
// ★ 关键：**遇到锁定章不能停**。实测某书前 6 章是「可读/锁/锁/锁/可读/锁」——
//   看到第 2 章就停会白白漏掉第 5 章以及后面所有可读章。
//   所以策略是**跳过锁定章继续往后找**，直到：
//     · 存够 `maxChapters` 章可读正文，或
//     · 连续跳过 `skipLimit` 章都没遇到可读（说明后面基本都锁了，再扫是浪费），或
//     · 扫完 / 用户喊停。
//
// onProgress({ index, total, done, locked, failed, title }) 用于 UI 显示进度。
// 返回 false 表示"用户要停"，会在这一章之后停下（stopped=true）。
export async function downloadBook(book, options) {
  const opt = options || {};
  const existing = opt.existing || {};
  const chapters = (book && book.chapters) || [];
  const startAt = Math.max(0, toInt(opt.startAt, 0));
  const maxChapters = toInt(opt.maxChapters, CACHE_MAX_CHAPTERS) || CACHE_MAX_CHAPTERS;
  const skipLimit = toInt(opt.skipLimit, 60) || 60;   // 连续跳过多少章还没收获就收工
  const delayMs = toInt(opt.delayMs, 220);

  let all = existing;
  let done = 0, locked = 0, failed = 0, stopped = false, scanned = 0;
  let lockedAt = -1;        // 第一次遇到"服务端不给正文"的章序号
  let sinceGain = 0;        // 距离上一次成功缓存，跳过了多少章

  for (let i = startAt; i < chapters.length; i++) {
    if (done >= maxChapters) { stopped = true; break; }
    if (sinceGain >= skipLimit) { stopped = true; break; }
    const c = chapters[i];
    if (!c || !c.id) continue;
    if (isDownloaded(all, book.bookId, c.id)) { done++; continue; }

    if (opt.onProgress) {
      const keep = opt.onProgress({
        index: i, total: chapters.length, done: done, locked: locked, failed: failed, title: c.title
      });
      if (keep === false) { stopped = true; break; }
    }

    scanned++;
    try {
      const ch = await fetchFanqieChapter(c.id, {
        bookId: book.bookId, bookName: book.title, author: book.author, title: c.title
      });
      if (ch.locked) {
        locked++;
        if (lockedAt < 0) lockedAt = i;
        sinceGain++;
      } else {
        all = putChapter(all, book.bookId, c.id, c.title, ch.content);
        if (all[book.bookId]) all[book.bookId].title = book.title || all[book.bookId].title;
        done++;
        sinceGain = 0;
      }
    } catch (error) {
      failed++;
      sinceGain++;
    }
    // 串行限速：番茄有风控，别并发也别贴脸请求
    if (delayMs > 0) await sleep(delayMs);
  }

  return {
    all: pruneDownloads(all),
    done: done, locked: locked, failed: failed,
    stopped: stopped, scanned: scanned, lockedAt: lockedAt
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// 已缓存的书能不能"离线整本阅读"：统计缓存章数 / 总章数
export function offlineCoverage(all, bookId, totalChapters) {
  const stat = downloadStat(all, bookId);
  const total = toInt(totalChapters, 0);
  return {
    chapters: stat.chapters,
    chars: stat.chars,
    total: total,
    // 只算"占比"，不谎称已经下全
    percent: total > 0 ? Math.min(100, Math.round((stat.chapters / total) * 100)) : 0
  };
}



export function pushReadHistory(list, entry) {
  const arr = Array.isArray(list) ? list.slice() : [];
  const key = String((entry && entry.chapterId) || '');
  const rest = arr.filter((x) => x && String(x.chapterId) !== key);
  return [Object.assign({}, entry, { at: Date.now() })].concat(rest).slice(0, 80);
}

export async function persistReadHistory(list) {
  return jsapiStorageSet(FANQIE_KEYS.history, Array.isArray(list) ? list : []);
}

// 时间戳 → 相对时间
export function relativeTime(ts) {
  const t = toInt(ts, 0);
  if (!t) return '';
  const ms = t > 1e12 ? t : t * 1000;
  const diff = Date.now() - ms;
  if (diff < 60000) return '刚刚';
  const min = Math.floor(diff / 60000);
  if (min < 60) return min + ' 分钟前';
  const hour = Math.floor(min / 60);
  if (hour < 24) return hour + ' 小时前';
  const day = Math.floor(hour / 24);
  if (day < 30) return day + ' 天前';
  return new Date(ms).toISOString().slice(0, 10);
}
