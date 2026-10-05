// 重新注册 ttwid 并自动写入 src/config.js
// 用法：npm run ttwid（或 node scripts/refresh-ttwid.mjs）
// 抖音要求解析分享页时携带 ttwid Cookie；该值由字节跳动的公开注册接口签发，
// 只通过 Set-Cookie 返回，过期后重新运行本脚本即可。
import fs from 'node:fs';
import https from 'node:https';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const configPath = path.resolve(__dirname, '..', 'src', 'config.js');

const payload = JSON.stringify({
  region: 'cn',
  aid: 1768,
  needFid: false,
  service: 'www.ixigua.com',
  migrate_info: { ticket: '', source: 'node' },
  cbUrlProtocol: 'https',
  union: true
});

function registerTtwid() {
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'ttwid.bytedance.com',
      path: '/ttwid/union/register/',
      method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) },
      timeout: 15000
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const cookies = res.headers['set-cookie'] || [];
        const ttwid = cookies.reduce((found, line) => {
          if (found || !line.startsWith('ttwid=')) return found;
          return line.split(';')[0].split('=').slice(1).join('=');
        }, '');
        resolve(ttwid);
      });
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('ttwid 注册请求超时')));
    req.end(payload);
  });
}

const ttwid = await registerTtwid();
if (!ttwid) {
  console.error('未获取到 ttwid，请稍后重试');
  process.exit(1);
}

let config = fs.readFileSync(configPath, 'utf8');
if (!/export const DOUYIN_TTWID = '/.test(config)) {
  console.error('src/config.js 中未找到 DOUYIN_TTWID 配置项');
  process.exit(1);
}
config = config.replace(/export const DOUYIN_TTWID = '[^']*';/, "export const DOUYIN_TTWID = '" + ttwid + "';");
fs.writeFileSync(configPath, config, 'utf8');
console.log('ttwid 已更新到 src/config.js（长度 ' + ttwid.length + '）');
