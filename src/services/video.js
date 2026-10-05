// 视频信息流数据服务：优先抖音热榜，其次官方热搜词榜，最终回退内置示例
import { fetchHotFeed, fetchHotWords, parseVideoByUrl, fetchDouyinWebFeed } from './douyin-api.js';
import { relayAssetUrl, jsapiStorageGet, jsapiStorageSet } from './libjsapi.js';
import { FEED_LIMIT } from '../config.js';
import { LOCAL_VIDEO_LIST } from '../data/local-videos.js';

const BUILTIN_DEMO_LIST = [
  {
    author: 'Falcon 官方',
    desc: '欢迎体验 Falcon 竖屏短片 #Falcon #IoT',
    music: 'Falcon Theme',
    emoji: '',
    scene: '光影之间',
    likes: 128000,
    comments: 5210,
    shares: 1024,
    bg: '#285c62',
    followed: true,
    live: false,
    title: '光影之间',
    url: 'https://example.com/video-1.mp4'
  },
  {
    author: '梦境影像',
    desc: '象之梦 · 短片选段 #影视 #剪辑',
    music: 'Elephant Dream',
    emoji: '',
    scene: '梦游森林',
    likes: 96000,
    comments: 3320,
    shares: 780,
    bg: '#34475e',
    followed: true,
    live: false,
    title: '梦游森林',
    url: 'https://example.com/video-2.mp4'
  },
  {
    author: '火线实验室',
    desc: '火焰特效一分钟速览 #特效 #科技',
    music: 'Blaze Beat',
    emoji: '',
    scene: '炽热现场',
    likes: 56000,
    comments: 1200,
    shares: 345,
    bg: '#a83c27',
    followed: false,
    live: true,
    title: '炽热现场',
    url: 'https://example.com/video-3.mp4'
  },
  {
    author: '辛特尔动画',
    desc: '奇幻动画片段 #动画',
    music: 'Sintel OST',
    emoji: '',
    scene: '雪原来信',
    likes: 152000,
    comments: 8900,
    shares: 2100,
    bg: '#426354',
    followed: false,
    live: false,
    title: '雪原来信',
    url: 'https://example.com/video-4.mp4'
  }
];

// 离线回退用列表：优先本地抓取样例（scripts/fetch-local-videos.mjs 生成），
// 为空时才用上面的内置示例。命中它说明接口全挂了，UI 会明确提示“离线样例”。
const FALLBACK_VIDEO_LIST = Array.isArray(LOCAL_VIDEO_LIST) && LOCAL_VIDEO_LIST.length
  ? LOCAL_VIDEO_LIST
  : BUILTIN_DEMO_LIST;

// ---------- 用户导入的视频（持久化） ----------
// 之前导入的视频只存在内存里，一重启就没了 —— 这正是“视频页老是没视频”的一个原因。
// 现在导入即落本机存储，启动时拼到信息流最前面（它们已带 playUrl，点开就能直接播）。
const IMPORTED_KEY = 'douyin_imported_videos_v1';

export async function loadImportedVideos() {
  try {
    const raw = await jsapiStorageGet(IMPORTED_KEY);
    const list = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return Array.isArray(list) ? list.filter((item) => item && item.playUrl) : [];
  } catch (error) {
    return [];
  }
}

export async function saveImportedVideo(item) {
  if (!item || !item.playUrl) return;
  try {
    const list = await loadImportedVideos();
    const key = item.videoId || item.playUrl;
    const next = [item].concat(list.filter((one) => (one.videoId || one.playUrl) !== key)).slice(0, 20);
    await jsapiStorageSet(IMPORTED_KEY, next);
  } catch (error) { /* 存储不可用则只在本次会话生效 */ }
}

// ---------- 可播放视频：按需解析 ----------
// 热榜接口给的是“热搜话题”（标题 + 封面 + 搜索链接），**没有视频文件**；
// 实测搜索页也拿不到视频数据（iesdouyin 分享搜索 404、douyin.com/search 是空壳 SPA），
// 所以“点一下话题就出视频”做不到。可行的是：把已知的抖音视频链接作为视频条目
// 放进信息流，用户点开/滑到该条时**按需解析**（分享页 → playUrl），解析结果落缓存。
//
// 必须按需而不是启动时批量：实测分享页会被抖音按 IP 限流（连续请求返回 2.5KB
// 风控页而非含 _ROUTER_DATA 的正常页），批量抓会把“导入”要用的额度一起烧掉。
// 因此同一时刻只允许一个解析在飞（串行队列）。
const VIDEO_LINK_LIMIT = 4;
const RESOLVE_CACHE_KEY = 'resolved_videos_v1';
const RESOLVE_TTL_MS = 6 * 60 * 60 * 1000;

let resolveChain = Promise.resolve();

export function isVideoLink(url) {
  const text = String(url || '');
  return /douyin\.com\/video\/\d+/.test(text) || /v\.douyin\.com\/[A-Za-z0-9_-]+/.test(text);
}

// 已知的抖音视频链接（scripts/fetch-local-videos.mjs 生成的数据）
export function knownPlayableLinks() {
  const list = Array.isArray(LOCAL_VIDEO_LIST) ? LOCAL_VIDEO_LIST : [];
  const links = [];
  list.forEach((item) => {
    const url = String((item && item.url) || '');
    if (isVideoLink(url) && links.indexOf(url) < 0) links.push(url);
  });
  return links.slice(0, VIDEO_LINK_LIMIT);
}

// 信息流里的“视频条目”：先不带 playUrl，点开时才解析出播放地址
function playableLinkItems() {
  return knownPlayableLinks().map((link, index) => ({
    source: 'video-link',
    author: '抖音视频',
    desc: '点击解析并播放',
    music: '原声',
    emoji: '',
    scene: '视频 ' + (index + 1),
    likes: 0,
    comments: 0,
    shares: 0,
    bg: ['#285c62', '#34475e', '#a83c27', '#426354'][index % 4],
    followed: false,
    live: false,
    title: '视频 ' + (index + 1),
    url: link,
    videoLink: link,
    cover: '',
    videoId: ''
  }));
}

async function readResolveCache() {
  try {
    const raw = await jsapiStorageGet(RESOLVE_CACHE_KEY);
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (parsed && typeof parsed === 'object') return parsed;
  } catch (error) { /* 无 storage 模块（浏览器预览）时无缓存 */ }
  return {};
}

async function writeResolveCache(cache) {
  try {
    await jsapiStorageSet(RESOLVE_CACHE_KEY, cache);
  } catch (error) { /* 写不了就算了，下次重新解析 */ }
}

// 按需解析一个视频条目：返回 { playUrl, cover, title, author, likes, ... }
// 命中缓存（6 小时内）直接返回，不再请求分享页
export async function resolveVideoForItem(item) {
  const link = (item && (item.videoLink || (isVideoLink(item.url) ? item.url : ''))) || '';
  if (!link) throw new Error('该条没有可解析的视频链接');

  const cache = await readResolveCache();
  const hit = cache[link];
  if (hit && hit.at && hit.data && hit.data.playUrl && Date.now() - hit.at < RESOLVE_TTL_MS) {
    return hit.data;
  }

  const task = resolveChain.then(() => parseVideoByUrl(link));
  resolveChain = task.catch(() => {});
  const parsed = await task;
  if (!parsed || !parsed.playUrl) throw new Error('没有解析到播放地址');

  const data = Object.assign({}, parsed, { cover: relayAssetUrl(parsed.cover || '') });
  cache[link] = { at: Date.now(), data: data };
  await writeResolveCache(cache);
  return data;
}

let normalizeSeq = 0;

function normalizeVideo(item, index) {
  const source = item || {};
  const statistics = source.statistics || {};
  return {
    // 保留既有 slideKey（重新 normalize 时不换 key，例如刷新后仍稳定）
    slideKey: source.slideKey || ('k' + (normalizeSeq++)),
    author: source.author || source.nickname || '抖音用户',
    desc: source.desc || source.title || '短视频',
    music: source.music || (source.source === 'hot-feed' ? '热榜现场' : '抖音热曲'),
    emoji: source.emoji || '',
    scene: source.scene || source.title || '短片',
    likes: Number(source.likes || statistics.diggCount || 0),
    comments: Number(source.comments || 0),
    shares: Number(source.shares || 0),
    bg: source.bg || ['#285c62', '#34475e', '#a83c27', '#426354'][index % 4],
    followed: !!source.followed,
    live: !!source.live,
    liked: !!source.liked,
    heart: false,
    paused: false,
    interval: Number(source.interval || 125),
    frames: Array.isArray(source.frames) ? source.frames : [],
    commentList: Array.isArray(source.commentList) && source.commentList.length
      ? source.commentList
      : [{ author: '影像爱好者', text: '氛围感很棒！' }],
    title: source.title || source.scene || '短片',
    url: source.url || source.link || source.video_url || '',
    playUrl: source.playUrl || '',
    // 播放候选地址（含直链 CDN）：播放时优先挑可走明文 http 的直链，尽量不用中转
    playCandidates: Array.isArray(source.playCandidates) ? source.playCandidates : [],
    cover: relayAssetUrl(source.cover || ''),
    videoId: source.videoId || source.itemId || '',
    // 可解析的视频链接（分享链接）；留到“点开该条”时才去解析出播放地址
    videoLink: source.videoLink || '',
    source: source.source || ''
  };
}

// 信息流 = 官方 web 视频首页（真能播）→ 可解析的视频条目 + 抖音热榜 → 官方热搜词榜 → 本地离线样例
// （附失败原因，便于在真机上诊断）
export async function fetchVideoList() {
  // 官方 web feed 放在最前面：它给的是**带可播地址的真视频**，是唯一能"刷视频"的源
  let webFeed = [];
  const errors = [];
  try {
    webFeed = await fetchDouyinWebFeed();
  } catch (error) {
    errors.push('官方视频流: ' + ((error && error.message) || '请求失败'));
  }

  const sources = [
    { name: '抖音热榜', load: fetchHotFeed },
    { name: '抖音热搜词', load: fetchHotWords }
  ];

  // 用户导入过的视频（已带 playUrl）优先：它们是真视频，且重启后仍在
  let imported = [];
  try {
    imported = await loadImportedVideos();
  } catch (error) { /* 忽略 */ }

  let feedName = '';
  let feedItems = [];
  for (let i = 0; i < sources.length; i++) {
    const current = sources[i];
    try {
      const items = await current.load();
      if (items && items.length) {
        feedName = current.name;
        feedItems = items;
        break;
      }
      errors.push(current.name + ': 无数据');
    } catch (error) {
      errors.push(current.name + ': ' + ((error && error.message) || '请求失败'));
    }
  }

  // 启动不发解析请求：热榜条目是话题、本身没有视频文件；
  // 官方 web feed 的条目**已经带 playUrl**，点开即播，不需要再解析。
  const videoItems = playableLinkItems();
  if (webFeed.length) {
    errors.push('官方视频流 ' + webFeed.length + ' 条（已带播放地址，点开即播）');
  }
  if (videoItems.length) {
    errors.push('另有 ' + videoItems.length + ' 条已知视频链接：点开会自动解析并播放；热榜条目是话题，本身没有视频文件');
  } else if (feedItems.length) {
    errors.push('热榜条目都是话题，本身没有视频文件；可用顶部“导入”粘贴分享链接生成视频条目');
  }

  if (webFeed.length || feedItems.length || videoItems.length || imported.length) {
    return {
      dataSource: [
        webFeed.length ? '官方视频流 ' + webFeed.length + ' 条' : '',
        imported.length ? imported.length + ' 条导入' : '',
        videoItems.length ? videoItems.length + ' 条视频链接' : '',
        feedName
      ].filter(Boolean).join(' + ') || feedName,
      offline: false,
      // 顺序：官方真视频（点开即播）→ 导入的真视频 → 可解析视频条目 → 热榜话题
      list: webFeed.concat(imported).concat(videoItems).concat(feedItems).slice(0, FEED_LIMIT).map(normalizeVideo),
      errors
    };
  }

  errors.push('接口全部失败，已回退离线样例（非真实抖音数据）。在“我的 → 网络诊断”可看到具体断点');
  return {
    dataSource: '离线样例',
    offline: true,
    list: FALLBACK_VIDEO_LIST.map(normalizeVideo),
    errors
  };
}
