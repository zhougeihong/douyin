// 内嵌拼音输入法引擎（数据源：万象拼音 amzxyz/rime_wanxiang，CC-BY-4.0）
// 词典由 scripts/build-ime-dict.mjs 生成为紧凑行式文本，首次使用时懒解析为索引。
// 核心能力：无调全拼串 -> 音节切分 -> 词/单字候选，支持简拼（各音节首字母）。
// 输入约定：ü 一律用 v 输入（与 RIME 全拼一致，如 nv=女、lv=率）。

import { IME_CHARS, IME_WORDS, IME_ABBR, IME_SYLLABLES } from '../data/ime-dict.js';

const MAX_SYL_LEN = 6; // 最长音节 zhuang/chuang/shuang 为 6
const MAX_CAND = 12;  // 候选上限

// ---------- 词典懒加载与索引 ----------

let charMap = null;    // 音节 -> [[字, 权重], ...]
let wordMap = null;    // 拼音串(空格分隔) -> [[词, 权重], ...]
let abbrMap = null;    // 简拼串 -> [[词, 权重], ...]
let syllableSet = null;

function parseEntryList(text) {
  const map = new Map();
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;
    // 键（拼音，可含空格）与值之间用 \t 分隔，值内用 "词 权重|词 权重" 格式
    const sp = line.indexOf('\t');
    if (sp < 0) continue;
    const key = line.slice(0, sp);
    const list = [];
    for (const seg of line.slice(sp + 1).split('|')) {
      const m = seg.match(/^(.+) (\d+)$/);
      if (m) list.push([m[1], Number(m[2])]);
    }
    if (list.length) map.set(key, list);
  }
  return map;
}

function ensureLoaded() {
  if (charMap) return;
  charMap = parseEntryList(IME_CHARS);
  wordMap = parseEntryList(IME_WORDS);
  abbrMap = parseEntryList(IME_ABBR);
  syllableSet = new Set(IME_SYLLABLES.split(','));
}

// ---------- 音节切分：贪心最长匹配 + 回溯补全 ----------

// 把无调拼音串切成音节数组；无法完全切分时返回 null
function segment(raw) {
  const s = String(raw || '').toLowerCase().replace(/[^a-z]/g, '');
  if (!s) return null;
  const result = [];

  function walk(start) {
    if (start === s.length) return true;
    // 单字母非合法音节开头直接失败（a-z 都是某些音节前缀，靠字典判定）
    const maxLen = Math.min(MAX_SYL_LEN, s.length - start);
    for (let len = maxLen; len >= 1; len--) {
      const piece = s.substr(start, len);
      if (!syllableSet.has(piece)) continue;
      result.push(piece);
      if (walk(start + len)) return true;
      result.pop();
    }
    return false;
  }

  return walk(0) ? result : null;
}

// ---------- 候选检索 ----------

// 分割点信息：把已确认音节渲染到拼音条上
function buildCandidates(raw) {
  ensureLoaded();
  const syls = segment(raw);
  const out = [];

  if (!syls) {
    // 切不开：尝试前缀容错——取能切分的最长前缀，剩余部分作为未完成音节
    return prefixFallback(raw);
  }

  const pyKey = syls.join(' ');

  // 1) 整串命中词库（含跨音节组合词，长度可短于音节数）
  const wordHit = wordMap.get(pyKey);
  if (wordHit) {
    for (const [w, wt] of wordHit) {
      out.push({ text: w, weight: wt, len: syls.length });
      if (out.length >= MAX_CAND) return out;
    }
  }

  // 2) 词库前缀匹配：输入是词的中途（如 nihao 还没打完 -> nih 命中"你好"）
  //    以音节前缀组合查词，取音节数最多的命中
  for (let take = syls.length - 1; take >= 1 && out.length < MAX_CAND; take--) {
    const subKey = syls.slice(0, take).join(' ');
    const subHit = wordMap.get(subKey);
    if (subHit) {
      for (const [w, wt] of subHit) {
        out.push({ text: w, weight: Math.floor(wt / 4), len: take });
        if (out.length >= MAX_CAND) break;
      }
      break; // 只取最长的一档前缀
    }
  }

  // 3) 逐字组合：每个音节取 top 单字，按权重积组合首候选
  if (out.length < MAX_CAND && syls.length > 1 && syls.length <= 5) {
    combineChars(syls, out);
  } else if (out.length < MAX_CAND && syls.length === 1) {
    const hit = charMap.get(syls[0]);
    if (hit) {
      for (const [c, wt] of hit) {
        out.push({ text: c, weight: wt, len: 1 });
        if (out.length >= MAX_CAND) break;
      }
    }
  }

  // 4) 简拼兜底：输入本身是简拼（如 nh）
  if (!out.length && /^[a-z]{2,5}$/.test(raw)) {
    const abHit = abbrMap.get(String(raw).toLowerCase());
    if (abHit) {
      for (const [w, wt] of abHit) {
        out.push({ text: w, weight: Math.floor(wt / 8), len: 0 });
        if (out.length >= MAX_CAND) break;
      }
    }
  }

  return out;
}

// 多音节逐字组合：每音节 top3 单字做笛卡尔组合，按权重积排序
function combineChars(syls, out) {
  const per = syls.map((syl) => (charMap.get(syl) || []).slice(0, 3)).filter((l) => l.length);
  if (per.length !== syls.length) return;
  const combos = [];
  const dfs = (i, str, score) => {
    if (i === per.length) {
      combos.push([str, score]);
      return;
    }
    for (const [c, wt] of per[i]) dfs(i + 1, str + c, score * wt);
  };
  dfs(0, '', 1);
  combos.sort((a, b) => b[1] - a[1]);
  for (const [str, score] of combos) {
    if (out.some((o) => o.text === str)) continue;
    out.push({ text: str, weight: Math.floor(score / 1000), len: syls.length });
    if (out.length >= MAX_CAND) break;
  }
}

// 切不开时的前缀容错：最长可切前缀的候选 + 剩余字母提示
function prefixFallback(raw) {
  const s = String(raw || '').toLowerCase().replace(/[^a-z]/g, '');
  for (let end = s.length - 1; end >= 2; end--) {
    const head = s.slice(0, end);
    const syls = segment(head);
    if (!syls) continue;
    const rest = s.slice(end);
    const list = buildCandidates(head).slice(0, MAX_CAND);
    return list.map((c) => ({ ...c, restChars: rest, len: c.len }));
  }
  return [];
}

// ---------- 九键（T9）：数字串 -> 中文候选 ----------
// 键位映射：2 abc / 3 def / 4 ghi / 5 jkl / 6 mno / 7 pqrs / 8 tuv / 9 wxyz。
// 拼音 ü 写作 v，落在 8 键（与全拼输入约定一致，如 nv=女 -> 68）。
// 索引懒构建：只在首次切到九键时调用 ensureT9()，不影响启动耗时。

const T9_GROUPS = ['abc', 'def', 'ghi', 'jkl', 'mno', 'pqrs', 'tuv', 'wxyz'];
const T9_DIGIT = {};
for (let g = 0; g < T9_GROUPS.length; g++) {
  for (let i = 0; i < T9_GROUPS[g].length; i++) T9_DIGIT[T9_GROUPS[g].charAt(i)] = String(g + 2);
}

const T9_CAND = 24;      // 九键候选总上限（前端分页显示）
const T9_PREDICT = 8;    // 前缀预测最多保留条数

let t9WordList = null;      // [{ d: 数字串, n: 音节数, list: [[词, 权重], ...] }]
let t9WordByDigits = null;  // Map 数字串 -> 同数字串的词条（桶内：音节数降序 + 词频降序）
let t9CharByDigits = null;  // Map 数字串 -> [[字, 权重], ...]（按字频降序）

// 音节拼写 -> 数字串；含非字母（理论上不会有）时返回空串表示不可索引
function syllableDigits(syl) {
  let d = '';
  for (let i = 0; i < syl.length; i++) {
    const n = T9_DIGIT[syl.charAt(i)];
    if (!n) return '';
    d += n;
  }
  return d;
}

function ensureT9() {
  if (t9WordByDigits) return;
  ensureLoaded();

  const byDigits = new Map();
  const list = [];
  wordMap.forEach((entries, key) => {
    const syls = key.split(' ');
    let d = '';
    for (let i = 0; i < syls.length; i++) {
      const part = syllableDigits(syls[i]);
      if (!part) { d = ''; break; }
      d += part;
    }
    if (!d) return;
    const item = { d: d, n: syls.length, list: entries };
    list.push(item);
    const bucket = byDigits.get(d);
    if (bucket) bucket.push(item);
    else byDigits.set(d, [item]);
  });
  // 同一数字串可能对应多个词：词长（音节数）优先，其次词频（取该词条首位权重）
  const topWeight = (entries) => (entries.length ? entries[0][1] : 0);
  byDigits.forEach((bucket) => {
    bucket.sort((a, b) => (b.n - a.n) || (topWeight(b.list) - topWeight(a.list)));
  });

  const charByDigits = new Map();
  charMap.forEach((entries, syl) => {
    const d = syllableDigits(syl);
    if (!d) return;
    const bucket = charByDigits.get(d);
    if (bucket) {
      for (let i = 0; i < entries.length; i++) bucket.push(entries[i]);
    } else {
      charByDigits.set(d, entries.slice());
    }
  });
  charByDigits.forEach((bucket) => bucket.sort((a, b) => b[1] - a[1]));

  t9WordList = list;
  t9WordByDigits = byDigits;
  t9CharByDigits = charByDigits;
}

// 查询九键候选。入参为纯数字串，返回 { digits, candidates }：
//   candidates [{ text, weight, len }]，len = 该候选消耗的数字位数（回退时剩余数字继续输入）
// 候选分层（词长优先 + 词频）：
//   1) 数字串整串命中词库：音节多的词在前，同长按词频
//   2) 数字串整串命中单字（IME_CHARS）
//   3) 逐字回退：前半段整词 + 后半段单字（拆点从长到短），如 64426744 -> 你好 + 是
//   4) 前缀预测：词的数字串比输入更长（还没打完），剩余位数少、词频高的在前
export function imeT9Query(rawDigits, limit) {
  ensureT9();
  const max = limit || T9_CAND;
  const d = String(rawDigits || '').replace(/[^0-9]/g, '');
  if (!d) return { digits: '', candidates: [] };

  const out = [];
  const seen = new Set();
  const push = (text, weight, len) => {
    if (!text || seen.has(text) || out.length >= max) return;
    seen.add(text);
    out.push({ text: text, weight: weight, len: len });
  };

  // 1) 整串命中词库
  const exact = t9WordByDigits.get(d);
  if (exact) {
    for (let i = 0; i < exact.length && out.length < max; i++) {
      const item = exact[i];
      for (let j = 0; j < item.list.length && out.length < max; j++) {
        push(item.list[j][0], item.list[j][1], d.length);
      }
    }
  }

  // 2) 整串命中单字（64 -> 你/泥/尼 …）
  const chars = t9CharByDigits.get(d);
  if (chars) {
    for (let i = 0; i < chars.length && out.length < max; i++) {
      push(chars[i][0], chars[i][1], d.length);
    }
  }

  // 3) 逐字回退：拆点长的优先，每档取前几个词 × 前几个字，权重按 词频 × 字频 / 10000 折算
  for (let cut = d.length - 1; cut >= 1 && out.length < max; cut--) {
    const heads = t9WordByDigits.get(d.slice(0, cut));
    const tails = t9CharByDigits.get(d.slice(cut));
    if (!heads || !tails) continue;
    for (let i = 0; i < heads.length && i < 3 && out.length < max; i++) {
      const head = heads[i].list[0];
      for (let j = 0; j < tails.length && j < 4 && out.length < max; j++) {
        push(head[0] + tails[j][0], Math.floor(head[1] * tails[j][1] / 10000), cut);
      }
    }
  }

  // 4) 前缀预测：词的数字串比输入更长（还没打完）。评分 = 词频 /(剩余位数 + 1)：
  //    既偏向高频词，又轻罚「需要再输入很多位」的长词。有界插入只保留前 T9_PREDICT 条，避免全量排序。
  if (out.length < max) {
    const best = [];
    for (let i = 0; i < t9WordList.length; i++) {
      const item = t9WordList[i];
      if (item.d.length <= d.length || item.d.indexOf(d) !== 0) continue;
      const extra = item.d.length - d.length;
      const weight = topWeightOf(item.list);
      const score = Math.floor(weight / (extra + 1));
      const last = best.length ? best[best.length - 1] : null;
      if (best.length >= T9_PREDICT && last
        && (score < last.score || (score === last.score && extra >= last.extra))) continue;
      let at = best.length;
      while (at > 0) {
        const prev = best[at - 1];
        if (prev.score > score || (prev.score === score && prev.extra <= extra)) break;
        at--;
      }
      best.splice(at, 0, { extra: extra, score: score, weight: weight, text: item.list[0][0] });
      if (best.length > T9_PREDICT) best.pop();
    }
    for (let i = 0; i < best.length && out.length < max; i++) {
      push(best[i].text, best[i].weight, d.length);
    }
  }

  return { digits: d, candidates: out };
}

function topWeightOf(entries) {
  return entries && entries.length ? entries[0][1] : 0;
}

// ---------- 对外接口 ----------

// 查询候选。返回 { syls, candidates, pending }：
//   syls       已切分音节（显示在拼音条上，音节间空格）
//   candidates 候选 [{ text, weight, len, restChars }]
//   pending    尚未形成完整音节的尾部字母（拼音条末尾浅色显示）
export function imeQuery(raw) {
  ensureLoaded();
  const s = String(raw || '').toLowerCase().replace(/[^a-z]/g, '');
  if (!s) return { syls: [], candidates: [], pending: '' };

  // 尾部未完成音节剥离：完整音节逐个贪心剥离，尾巴留作 pending
  const syls = [];
  let start = 0;
  while (start < s.length) {
    const maxLen = Math.min(MAX_SYL_LEN, s.length - start);
    let matched = 0;
    for (let len = maxLen; len >= 1; len--) {
      if (syllableSet.has(s.substr(start, len))) { matched = len; break; }
    }
    if (!matched) break;
    // 若剩余部分整体仍可能拼成更长输入，仅当取走后剩余为空或仍是合法序列前缀时才提交
    syls.push(s.substr(start, matched));
    start += matched;
  }
  const pending = s.slice(start);

  let candidates = syls.length
    ? buildCandidates(syls.join(' ')).slice(0, MAX_CAND)
    : [];

  // 简拼通道：整串命中简拼索引（如 zh=之后、nh=你好）。
  // 尾部有残留字母或整串切不出音节时，简拼是更可能的用户意图，置于候选前列。
  if (s.length >= 2 && s.length <= 6) {
    const abHit = abbrMap.get(s);
    if (abHit) {
      const abbrList = abHit.map(([w, wt]) => ({ text: w, weight: Math.floor(wt / 8), len: 0 }));
      candidates = (pending || !syls.length)
        ? abbrList.concat(candidates)
        : candidates.concat(abbrList);
      candidates = candidates.slice(0, MAX_CAND);
    }
  }

  return { syls, candidates, pending };
}

// 音节序列转显示串："ni hao" -> "ni hao"（保持输入的可读切分）
export function imeSyllableText(syls) {
  return (syls || []).join(' ');
}
