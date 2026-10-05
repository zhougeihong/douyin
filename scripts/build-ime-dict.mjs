// 万象拼音词典裁剪构建脚本
// 数据源：amzxyz/rime_wanxiang（CC-BY-4.0，https://github.com/amzxyz/rime_wanxiang）
// 输入：.temp/zi.dict.yaml（单字表）+ .temp/jichu.dict.yaml（基础词库 2-4 字词）
// 输出：src/data/ime-dict.js（嵌入包内的小程序拼音输入法词典 + 合法音节表）
//
// 产出格式（紧凑行式，运行时按需懒解析）：
//   IME_CHARS: "ai 哎 63672|哀 123\n..."           每行：拼音 字 权重|字 权重...
//   IME_WORDS: "ni hao 你好 63831|你号 12\n..."    每行：拼音 词 权重|词 权重...
//   IME_ABBR:  "nh 你好 63831\n..."                简拼索引：各字首字母 词 权重
//   IME_SYLLABLES: "a,ai,an,..."                   词典中出现的全部合法音节
//
// 用法：先经中转下载两个词典到 .temp/（见文件头输入说明），再 node scripts/build-ime-dict.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const tempDir = path.join(root, '.temp');
const outFile = path.join(root, 'src', 'data', 'ime-dict.js');

// 裁剪参数：包体优先，取高频子集
const MAX_WORDS = 28000;        // 词库保留条数（按权重降序）
const MAX_CHARS_PER_SYL = 10;   // 每个音节保留的单字数（按权重降序）
const MAX_ABBR = 9000;          // 简拼索引覆盖的高频词数

// 带调拼音 -> 无调拼音（ü 归一为 v，与 RIME 全拼输入习惯一致）
function toneless(s) {
  return String(s)
    .normalize('NFD')
    .replace(/u\u0308/g, 'v') // ü 的两种形式：预组合 U+00FC 与 NFD 分解的 u+U+0308（含 ǚ 等）
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z]/g, '');
}

// 过滤：词只保留常用汉字（BMP 内 CJK 区），去掉生僻字与扩展区
function isCommonHan(word) {
  for (const ch of word) {
    const code = ch.codePointAt(0);
    if (code < 0x4e00 || code > 0x9fa5) return false;
  }
  return true;
}

// 解析 RIME dict yaml 正文段（跳过头部 ... 分隔符）
function parseDict(file) {
  const text = fs.readFileSync(file, 'utf8');
  const sep = text.indexOf('\n...\n');
  const body = sep >= 0 ? text.slice(sep + 5) : text;
  const out = [];
  for (const line of body.split('\n')) {
    const cols = line.split('\t');
    if (cols.length < 3) continue;
    const word = cols[0].trim();
    const py = cols[1].trim().split(/\s+/).map(toneless);
    const weight = Number(cols[2]);
    if (!word || !py.length || !Number.isFinite(weight)) continue;
    if (py.some((s) => !s)) continue;
    out.push({ word, py, weight });
  }
  return out;
}

// ---------- 1) 单字表 ----------
const ziEntries = parseDict(path.join(tempDir, 'zi.dict.yaml'));

// 每音节按权重保留 topN 单字；同时收集合法音节集合
const bySyl = new Map();
const syllables = new Set();
for (const e of ziEntries) {
  const syl = e.py[0];
  syllables.add(syl);
  if (!isCommonHan(e.word)) continue;
  if (!bySyl.has(syl)) bySyl.set(syl, []);
  bySyl.get(syl).push(e);
}

const charLines = [];
for (const [syl, list] of bySyl) {
  list.sort((a, b) => b.weight - a.weight);
  const top = list.slice(0, MAX_CHARS_PER_SYL);
  charLines.push(syl + '\t' + top.map((e) => e.word + ' ' + e.weight).join('|'));
}

// ---------- 2) 词库（2-4 字词） ----------
const ciEntries = parseDict(path.join(tempDir, 'jichu.dict.yaml'))
  .filter((e) => e.word.length >= 2 && e.word.length <= 4)
  .filter((e) => isCommonHan(e.word))
  .filter((e) => e.word.length === e.py.length); // 词长与音节数一致，剔除异常条目

ciEntries.sort((a, b) => b.weight - a.weight);
const keptWords = ciEntries.slice(0, MAX_WORDS);

// 同拼音聚合一行（去重同词取最大权重）
const wordMap = new Map(); // "ni hao" -> Map(word -> weight)
for (const e of keptWords) {
  const key = e.py.join(' ');
  if (!wordMap.has(key)) wordMap.set(key, new Map());
  const bucket = wordMap.get(key);
  if (!bucket.has(e.word) || bucket.get(e.word) < e.weight) bucket.set(e.word, e.weight);
}
const wordLines = [];
for (const [key, bucket] of wordMap) {
  const list = [...bucket.entries()].sort((a, b) => b[1] - a[1]);
  wordLines.push(key + '\t' + list.map(([w, wt]) => w + ' ' + wt).join('|'));
}

// ---------- 3) 简拼索引（高频词的各字首字母） ----------
const abbrMap = new Map(); // "nh" -> [[word, weight], ...]
for (const e of keptWords.slice(0, MAX_ABBR)) {
  const ab = e.word.split('').map((c, i) => (e.py[i] || '?')[0]).join('');
  if (ab.includes('?')) continue;
  if (!abbrMap.has(ab)) abbrMap.set(ab, []);
  abbrMap.get(ab).push([e.word, e.weight]);
}
const abbrLines = [];
for (const [ab, list] of abbrMap) {
  list.sort((a, b) => b[1] - a[1]);
  abbrLines.push(ab + '\t' + list.map(([w, wt]) => w + ' ' + wt).join('|'));
}

// ---------- 4) 输出 ----------
const header = `// 本文件由 scripts/build-ime-dict.mjs 自动生成，请勿手改
// 数据源：万象拼音 amzxyz/rime_wanxiang（开源协议 CC-BY-4.0）
// 单字 ${bySyl.size} 音节 / 词 ${wordLines.length} 组 / 简拼 ${abbrLines.length} 组

`;
const body = `export const IME_CHARS = ${JSON.stringify(charLines.join('\n'))};

export const IME_WORDS = ${JSON.stringify(wordLines.join('\n'))};

export const IME_ABBR = ${JSON.stringify(abbrLines.join('\n'))};

export const IME_SYLLABLES = ${JSON.stringify([...syllables].join(','))};
`;

fs.writeFileSync(outFile, header + body);

const kb = (n) => (n / 1024).toFixed(1) + 'KB';
console.log('[ime-dict] 单字组 ' + bySyl.size + '，词组 ' + wordLines.length +
  '，简拼组 ' + abbrLines.length + '，音节 ' + syllables.size);
console.log('[ime-dict] 输出 ' + outFile + ' 大小 ' + kb(fs.statSync(outFile).size));
