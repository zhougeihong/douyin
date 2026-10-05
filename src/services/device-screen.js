// 屏幕探测：从运行时自带的 cfg.json 读真实分辨率（参考项目 device.js 的真机验证做法），
// 并把结果挂到 globalThis.$shugeScreen —— 参考实现里原生侧会用到这个全局量。
// direction 为 90/270 时逻辑宽高互换。
let cached = null;

async function readCfgText() {
  try {
    const mod = await import('fs');
    const fs = mod && (mod.default || mod);
    if (!fs || typeof fs.readFile !== 'function') return '';
    const res = await fs.readFile('/etc/miniapp/resources/cfg.json');
    const value = res && typeof res === 'object' && 'result' in res ? res.result : res;
    if (typeof value === 'string') return value;
    if (value && typeof value === 'object') {
      const data = value.data !== undefined ? value.data : value.result;
      if (typeof data === 'string') return data;
    }
    return '';
  } catch (error) {
    return '';
  }
}

export async function detectScreen() {
  if (cached) return cached;
  let size = { w: 800, h: 254, raw: '默认', direction: 0 };
  const text = await readCfgText();
  if (text) {
    try {
      const cfg = JSON.parse(text);
      const sc = cfg && cfg.screen;
      if (sc && Number(sc.width) > 0 && Number(sc.height) > 0) {
        const d = Number(sc.direction || 0);
        const swap = d === 90 || d === 270;
        size = {
          w: swap ? Number(sc.height) : Number(sc.width),
          h: swap ? Number(sc.width) : Number(sc.height),
          raw: Number(sc.width) + 'x' + Number(sc.height),
          direction: d
        };
      }
    } catch (error) { /* 用默认 */ }
  }
  cached = size;
  try { globalThis.$shugeScreen = { w: size.w, h: size.h }; } catch (error) { /* 忽略 */ }
  return size;
}

export default { detectScreen };
