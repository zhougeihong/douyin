// 原生视频播放桥（来自 better-video-player 项目，适配本工程）
// 为什么必须有它：这台笔的 Falcon/HaaS UI **没有 <video> 组件**，官方的 <video> 永远播不动。
// 真正的播放引擎是随包发布的原生模块 libjsapi_better_video.so：
//   FFmpeg(4.4) 解码 + libswscale 缩放 + 直写 /dev/fb0（逻辑横屏 800×254 → 物理 254×800，270°）
//   + ALSA 出声；JS 侧通过 import('video') 拿到该 C 模块。
//
// 原生模块契约（同步返回，来自参考项目真机验证）：
//   play({path, screenW, screenH, rectX, rectY, rectW, rectH, maxW, maxH, ratePermillage, volume})
//        -> {ok, error?, videoW?, videoH?, durationMs?}
//   pause()/resume()/stop()/seek(ms)/setRate(rate)/setVolume(0..100)/setView({rectX,rectY,rectW,rectH})
//   getPosition() -> {ms}   getDuration() -> {ms}   getStatus() -> {playing, eos, videoW, videoH, ok}
//
// 坐标系：rect 全部用**逻辑横屏 800×254**（与原生 blit 一致）；设备屏就是 800×254 逻辑。

import { API_RELAY, VIDEO_RELAY } from '../config.js';
import { jsapiHttpRequest } from './libjsapi.js';
// 上面这个 jsapiHttpRequest **只用于 probeCandidatesViaRelay**（读中转回的几十字节 JSON）。
// ⛔ 绝不能用它去 GET 视频/媒体地址 —— 二进制灌进原生字符串通道会导致词典笔软重启（见下方说明）。

export const SCREEN_W = 800;
export const SCREEN_H = 254;

let modState; // undefined=未探测, false=不可用, 否则为原生模块对象

function num(value, fallback) {
  const n = Number(value);
  return isFinite(n) ? n : fallback;
}

async function api() {
  if (modState !== undefined) return modState || null;
  try {
    const m = await import('video');
    const mod = m && (m.default || m);
    if (mod && typeof mod.play === 'function') {
      modState = mod;
      return mod;
    }
  } catch (error) {
    // 模块不存在（模拟器/浏览器预览）或加载失败
    console.log('[native-player] import(video) 失败: ' + (error && error.message));
  }
  modState = false;
  return null;
}

export async function available() {
  return !!(await api());
}

// 网络地址 → 原生解码器可读的地址。
//
// 真机实测（2026-10，抖音 web feed 的视频）：
//   `/aweme/v1/play/?video_id=…` 是**302 跳板**，落点 douyinvod 的 CDN **要求带 Referer**：
//   PC 上六种组合实测 —— 带 Referer → 200 video/mp4；**只带 UA 不带 Referer → 403**。
//   设备的 FFmpeg 跟 302 时不会把 Referer 带过去 → 真机直接 `open-failed`。
//   所以「跳转入口」这类**优先交给中转**（中转服务端已会跟 302 并补 Referer/Range）。
//
// 其余优先级：
//   ① **直链 CDN**（douyinvod 那类，不是 /aweme/v1/play 的 302 入口）→ https 换明文 http：
//      实测这类 CDN 支持 http + Range → 不需要 TLS 就能播；
//   ② 普通 https → 配了中转就过中转（顺带解决无 TLS 固件）；
//   ③ 都没配 → 原样返回（固件 FFmpeg 自带 TLS 时也能播）。
// 想强制直连：把 VIDEO_RELAY / API_RELAY 置空。
// 把地址包一层 PC 中转（设备端只读 body，读不到响应头，所以走中转由 PC 补齐头并跟跳转）
export function relayPlayableUrl(url) {
  const raw = String(url || '');
  if (!raw) return '';
  // 已经是中转地址就别再套一层
  if (/\/relay\?url=/.test(raw)) return raw;
  const relay = VIDEO_RELAY || API_RELAY;
  if (!relay || !/^https?:\/\//i.test(raw)) return '';
  return relay.replace(/\/$/, '') + '/relay?url=' + encodeURIComponent(raw);
}

// 这类地址必须走中转：它自己不返回媒体，只 302 到需要 Referer 的 CDN
export function needsRelay(url) {
  return /\/aweme\/v1\/play\//i.test(String(url || ''));
}

// ⛔ 绝对不要用 JS 的 http 通道去"探测"视频地址 —— 会把二进制灌进原生字符串通道。
// 已实测后果：**词典笔软重启**（HANDOFF §9 早有记录：原生 http 的字符串通道会损坏二进制，
// 42% 字节非法 UTF-8）。所以这里**不做任何媒体探测**，改用下面这套安全策略：
//
//   1) 原生播放器自己当探测器：它 open 失败很快（错误表现为 `ok` 但无尺寸，或 open-failed）；
//   2) **按 CDN 主机做黑名单**：某台落点主机失败过就不再选它（坏主机是主机级问题，
//      实测 `v95-bjb-mc-cold.douyinvod.com` 连 DNS 都解析不出来）。
//
// ★ 曾经这里还有一个 `resolvePlainHttpUrl()`（发 GET 读 302 的 Location 再换明文 http），
//   **已删除**，原因有三，别再写回来：
//     ① 它对**视频入口 URL 发 GET** —— 正是上面这条禁令禁止的事。若固件跟随 302，
//        body 就是完整 mp4 → 直接命中软重启场景；若不跟随，则拿不到 Location，纯属白等 8 秒。
//        两个分支都不利。
//     ② 它依据的前提（"模块很可能没有 TLS"）**已被真机诊断推翻**：
//        HANDOFF §13.7 —— 诊断第 11 行 `原生 https 直连播放: OK 1280x720`，
//        固件 FFmpeg 自带 TLS，根本不需要明文 http 这条路。
//     ③ 真正的根因是**落点 CDN 主机坏**（§13.9），修法是上面的主机黑名单，已经能治。

// 已知/已失败的 CDN 落点主机（内存级，本次会话有效）
const BAD_HOSTS = {};

function hostOf(url) {
  const m = /^https?:\/\/([^/?#]+)/i.exec(String(url || ''));
  return m ? m[1].toLowerCase() : '';
}

export function markHostBad(url, reason) {
  const h = hostOf(url);
  if (!h) return;
  BAD_HOSTS[h] = { reason: String(reason || '').slice(0, 60), at: Date.now() };
}

export function isHostBad(url) {
  const h = hostOf(url);
  return !!(h && BAD_HOSTS[h]);
}

export function badHostList() {
  return Object.keys(BAD_HOSTS);
}

// 把候选按"主机是否已知坏"排序：没坏过的排前面（保持原相对顺序），坏过的沉底。
// 注意：**不删除**坏主机的候选 —— 万一是临时抖动，沉底后仍有机会被试到。
export function orderByHostHealth(urls) {
  const list = (Array.isArray(urls) ? urls : []).filter(Boolean);
  const fresh = [];
  const stale = [];
  for (let i = 0; i < list.length; i++) {
    (isHostBad(list[i]) ? stale : fresh).push(list[i]);
  }
  return fresh.concat(stale);
}

// 判断一段响应是不是"播放失败"的错误 JSON（导出以便单测）。
// ⚠️ 只用于**文本类**响应（如 API 返回），**不要**拿它去判断视频地址 —— 别读视频字节。
// ⚠️ 目前生产代码**没有调用者**（保留是因为它把"什么算错误体"这条判据钉在了测试里，
//    将来若要判断纯文本 API 响应可直接用）。若确定不再需要，连同测试一起删掉即可。
export function isErrorBody(text) {
  const s = String(text || '').trim();
  if (!s) return false;                       // 空体不判死
  if (s.length > 2000) return false;          // 大响应不判（避免处理二进制）
  if (s.charAt(0) !== '{') return false;      // 非 JSON
  if (!/"error"\s*:/.test(s)) return false;
  return !/"aweme_list"|"video"|"play_addr"/.test(s);
}

// ★★ 播放前的**可达性探测**（安全版）：让 **PC 中转**去试，设备只读一个几十字节的 JSON。
//
// 为什么必须走中转：设备端的 JS 通道**绝不能自己去 GET 视频地址** ——
// 会把二进制灌进原生字符串通道，实测导致词典笔软重启（§9 / §13.10）。
// 而"这个入口最终连不连得上"又确实需要提前知道，因为实测（§13.9、§15.8）：
//   · 抖音会把视频解析到**已坏的 CDN 主机**（如 v95-bjb-mc-cold.douyinvod.com，DNS 永久 ENOTFOUND）；
//   · **同一个 uri 的落点主机是固定的**（连续 6 次请求都一样）→ 多入口轮换救不了它。
// 所以先用中转探一遍、把连不上的候选剔掉，能省掉设备上注定失败的播放尝试。
//
// 前提：配了 API_RELAY。没配就返回 null，调用方按原顺序试（不改变原有行为）。
export async function probeCandidatesViaRelay(urls, options) {
  const opt = options || {};
  const relay = opt.relay || API_RELAY || VIDEO_RELAY;
  if (!relay) return null;                     // 没中转就不探（不改变原有行为）
  const list = (Array.isArray(urls) ? urls : []).filter(Boolean).slice(0, opt.limit || 4);
  if (!list.length) return null;

  const good = [];
  const bad = [];
  for (let i = 0; i < list.length; i++) {
    const u = list[i];
    const probeUrl = relay.replace(/\/$/, '') + '/relay?url=' + encodeURIComponent(u) + '&probe=1';
    try {
      const body = await jsapiHttpRequest({ url: probeUrl, method: 'GET', timeoutMs: opt.timeoutMs || 9000 });
      const info = typeof body === 'string' ? JSON.parse(body) : body;
      if (info && info.ok) good.push(u);
      else bad.push({ url: u, error: (info && info.error) || ('status ' + (info && info.status)) });
    } catch (error) {
      // 探测本身失败（中转不通等）：**不要**因此判死候选，交回给播放器照常试
      return null;
    }
  }
  if (!good.length) return null;               // 全探挂也别拦着播放器，让它自己试
  return { good: good, bad: bad };
}

// ★ 这里原本有 `httpOf` / `looksLikeMediaUrl` / `locationFrom` / `resolvePlainHttpUrl` /
//   `cachedPlainHttpUrl` 一组函数（把 302 跳板解析成明文 http 直链）。
//   **2026-10 已整组删除**，理由见文件上方那段"⛔ / ★"注释（会对视频地址发 GET，违反禁令；
//   且依据的"模块没有 TLS"前提已被真机诊断推翻）。别再写回来。

//
// 实测（2026-10，真机 open-failed 复盘）：
//   `/aweme/v1/play/?video_id=<uri>` 会 302 到 douyinvod 的 CDN，而**落点主机每次不同**：
//   有的主机不带 Referer 就 200 video/mp4，有的必须带 Referer（否则 403）。
//   设备的 FFmpeg 跟 302 时不会带 Referer → 碰上后者就 open-failed。
//   单形态一次尝试：成功率仅 ~68%（22 条样本）；
//   **同一 uri 换域名/码率写成多个候选逐个重试 → 22/22 = 100%**（因为每次重新 302，
//   落点主机重抽，总有一次抽到"免 Referer"的主机）。
//
// 所以这里返回一个**候选列表**，由播放器按序尝试；不依赖 PC 中转。
export function playUrlCandidates(url, candidates) {
  const raw = String(url || '');
  const out = [];
  const push = (u) => { const s = String(u || ''); if (s && out.indexOf(s) < 0) out.push(s); };

  // 先把调用方给的候选（分享页解析结果等）放前面
  if (Array.isArray(candidates)) candidates.forEach(push);

  // 从 /aweme/v1/play/?video_id=<uri> 里抠出 uri：它同时可用于 snssdk 与 douyin 两个入口
  const uri = (/\bvideos?_id=([^&]+)/.exec(raw) || /[?&]video_id=([^&]+)/.exec(raw) || [])[1] || '';

  if (uri) {
    // aweme.snssdk.com 实测**明显更稳**（13/16 vs 10/16），所以排前面；
    // 多写几个 ratio：不同 ratio 会走不同的 CDN 主机，命中"免 Referer"那台的概率更高。
    push('https://aweme.snssdk.com/aweme/v1/play/?video_id=' + uri + '&ratio=720p&line=0');
    push('https://aweme.snssdk.com/aweme/v1/play/?video_id=' + uri + '&ratio=540p&line=0');
    push('https://aweme.snssdk.com/aweme/v1/play/?video_id=' + uri + '&ratio=480p&line=0');
    push('https://aweme.snssdk.com/aweme/v1/play/?video_id=' + uri + '&ratio=360p&line=0');
    push('https://www.douyin.com/aweme/v1/play/?video_id=' + uri + '&ratio=720p&line=0&aid=6383');
    push('https://www.douyin.com/aweme/v1/play/?video_id=' + uri + '&ratio=540p&line=0&aid=6383');
  }
  push(raw);

  // 配了中转就再兜一层（中转会补 Referer 并跟跳转）
  const relayed = relayPlayableUrl(raw);
  if (relayed) push(relayed);
  return out;
}

// ★ 这里原本还有 `nativePlayableUrl(url, candidates)`（"单值版"，返回第一个候选）。
//   **2026-10 已删除**，原因（两处都是真 bug，别再写回来）：
//     ① 它会优先挑 `play_addr.url_list` 里的**直链 CDN**（`isDirectCdn`）——
//        而 HANDOFF §13.2 实测那些直链**恒 403**（`douyin-api.js` 里自己都写了这条警告）；
//     ② 它把挑中的地址 `replace(/^https:/i,'http:')` **改写成明文 http** ——
//        那是"模块没有 TLS"的旧前提，早已被真机诊断推翻（§13.7 `OK 1280x720`）。
//   两者叠加会把好好的跳板入口换成打不开的地址。
//   现在**选地址的职责只有一处**：`playUrlCandidates()`（多候选）+ 播放页 `startWithFallback()`。

export async function play(opt) {
  const mod = await api();
  if (!mod) return { ok: false, error: 'no-video-module' };
  const options = opt || {};
  try {
    const result = mod.play({
      path: String(options.path || ''),
      screenW: num(options.screenW, SCREEN_W),
      screenH: num(options.screenH, SCREEN_H),
      rectX: num(options.rectX, 0),
      rectY: num(options.rectY, 0),
      rectW: num(options.rectW, SCREEN_W),
      rectH: num(options.rectH, SCREEN_H),
      maxW: num(options.maxW, 0),
      maxH: num(options.maxH, 0),
      // 原生契约用千分比：1000 = 1.0x
      ratePermillage: Math.round(num(options.rate, 1) * 1000),
      volume: num(options.volume, 70)
    });
    return result && typeof result === 'object' ? result : { ok: !!result };
  } catch (error) {
    return { ok: false, error: String((error && error.message) || error) };
  }
}

async function simple(name, arg) {
  const mod = await api();
  if (!mod || typeof mod[name] !== 'function') return { ok: false, error: 'no-video-module' };
  try {
    const result = arg === undefined ? mod[name]() : mod[name](arg);
    if (result && typeof result === 'object') return result;
    return { ok: result !== false };
  } catch (error) {
    return { ok: false, error: String((error && error.message) || error) };
  }
}

// 切换视频显示区域（控制栏唤出时把画面收缩到其上方，避免被 UI 遮住）
export function setView(rect) {
  const r = rect || {};
  return simple('setView', {
    rectX: num(r.rectX, 0),
    rectY: num(r.rectY, 0),
    rectW: num(r.rectW, SCREEN_W),
    rectH: num(r.rectH, SCREEN_H)
  });
}

export const pause = () => simple('pause');
export const resume = () => simple('resume');
export const stop = () => simple('stop');
export const seek = (ms) => simple('seek', Math.max(0, Math.round(Number(ms) || 0)));
export const setRate = (rate) => simple('setRate', Number(rate) || 1);
export const setVolume = (v) => simple('setVolume', Math.min(100, Math.max(0, Math.round(Number(v) || 0))));

export async function position() {
  const r = await simple('getPosition');
  return (r && num(r.ms, 0)) || 0;
}

export async function duration() {
  const r = await simple('getDuration');
  return (r && num(r.ms, 0)) || 0;
}

export async function status() {
  const mod = await api();
  if (!mod || typeof mod.getStatus !== 'function') {
    return { ok: false, playing: false, eos: false, videoW: 0, videoH: 0 };
  }
  try {
    const r = mod.getStatus();
    return r && typeof r === 'object' ? r : { ok: false, playing: false, eos: false, videoW: 0, videoH: 0 };
  } catch (error) {
    return { ok: false, playing: false, eos: false, videoW: 0, videoH: 0 };
  }
}

export default {
  available, play, pause, resume, stop, seek, setRate, setVolume, setView,
  position, duration, status, playUrlCandidates,
  orderByHostHealth, markHostBad, isHostBad, badHostList, probeCandidatesViaRelay,
  SCREEN_W, SCREEN_H
};
