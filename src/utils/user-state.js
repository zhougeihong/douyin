// 用户交互状态（点赞 / 关注 / 收藏）的本地持久化，经 libjsapi 原生 storage 模块保存。
// 结构：{ liked: {key:true}, followed: {'u:作者名':true}, collected: {key:true} }
import { jsapiStorageGet, jsapiStorageSet } from '../services/libjsapi.js';

const STATE_KEY = 'douyin_user_state';

const EMPTY_STATE = { liked: {}, followed: {}, collected: {} };

// 状态键：解析类条目用稳定 videoId；热榜/热搜条目 id 是加载顺序号，退回用标题
export function stateKeyOf(item) {
  if (!item) return '';
  const id = item.videoId;
  if (id && !/^(hot-|word-|local-)/.test(id)) return 'v:' + id;
  return 't:' + (item.title || item.desc || '');
}

export function followKeyOf(author) {
  return 'u:' + (author || '');
}

export async function loadUserState() {
  try {
    const stored = await jsapiStorageGet(STATE_KEY);
    const state = typeof stored === 'string' ? JSON.parse(stored) : stored;
    return Object.assign({}, EMPTY_STATE, state || {});
  } catch (error) {
    return { liked: {}, followed: {}, collected: {} };
  }
}

export function persistUserState(state) {
  return jsapiStorageSet(STATE_KEY, state).catch(() => {});
}

// ---------- 观看历史（找回刷掉的视频） ----------

const HIST_KEY = 'douyin_watch_history';
const HIST_LIMIT = 50;

export function historyKeyOf(item) {
  return stateKeyOf(item);
}

function normalizeEntry(item, ts) {
  return {
    key: stateKeyOf(item),
    videoId: item.videoId || '',
    title: item.title || item.scene || '视频',
    author: item.author || '抖音用户',
    desc: item.desc || '',
    cover: item.cover || '',
    likes: Number(item.likes || 0),
    url: item.url || '',
    playUrl: item.playUrl || '',
    source: item.source || '',
    ts: ts
  };
}

export async function loadHistory() {
  try {
    const stored = await jsapiStorageGet(HIST_KEY);
    const list = typeof stored === 'string' ? JSON.parse(stored) : stored;
    return Array.isArray(list) ? list : [];
  } catch (error) {
    return [];
  }
}

// 记录一条观看历史：最新在前、按 key 去重、上限 HIST_LIMIT，返回新列表
export function applyHistory(list, item, ts) {
  const entry = normalizeEntry(item, ts);
  const rest = (list || []).filter((h) => h.key !== entry.key);
  const next = [entry].concat(rest).slice(0, HIST_LIMIT);
  return next;
}

export function persistHistory(list) {
  return jsapiStorageSet(HIST_KEY, list || []).catch(() => {});
}

export async function addHistory(list, item) {
  const next = applyHistory(list, item, Date.now());
  await persistHistory(next);
  return next;
}

export async function removeHistory(list, key) {
  const next = (list || []).filter((h) => h.key !== key);
  await persistHistory(next);
  return next;
}

export async function clearHistory() {
  await persistHistory([]);
  return [];
}
