import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import https from 'node:https';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');
const outputFile = path.join(projectRoot, 'src', 'data', 'local-videos.js');

const DEFAULT_INPUT = [
  'https://www.douyin.com/video/7419207373887147316',
  'https://www.douyin.com/video/6937458117884880652',
  'https://www.douyin.com/video/7128880664625239300',
  'https://www.douyin.com/video/7253971059812519171'
];

function formatVideoEntry(item, index) {
  return {
    author: item.author || `本地抓取 ${index + 1}`,
    desc: item.desc || item.title || '本地抓取视频',
    music: item.music || '本地音乐',
    emoji: item.emoji || '🎬',
    scene: item.scene || item.title || '本地视频',
    likes: Number(item.likes || 0),
    comments: Number(item.comments || 0),
    shares: Number(item.shares || 0),
    bg: item.bg || ['#285c62', '#34475e', '#a83c27', '#426354'][index % 4],
    followed: !!item.followed,
    live: !!item.live,
    title: item.title || '本地视频',
    url: item.url || item.video || ''
  };
}

function extractTitle(html) {
  const patterns = [
    /<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i,
    /<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["']/i,
    /<title>([^<]+)<\/title>/i
  ];

  for (const pattern of patterns) {
    const match = html.match(pattern);
    if (match && match[1]) return match[1].replace(/\s+/g, ' ').trim();
  }

  return '本地抓取视频';
}

function extractCover(html) {
  const patterns = [
    /<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i,
    /"cover":"([^"]+)"/i,
    /"dynamic_cover":"([^"]+)"/i
  ];

  for (const pattern of patterns) {
    const match = html.match(pattern);
    if (match && match[1]) return match[1];
  }

  return 'https://picsum.photos/seed/local-video/640/960';
}

function httpGetText(url) {
  const client = url.startsWith('https:') ? https : http;
  return new Promise((resolve, reject) => {
    const request = client.get(url, { headers: { 'user-agent': 'Mozilla/5.0' } }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    });

    request.on('error', reject);
    request.setTimeout(20000, () => request.destroy(new Error('request_timeout')));
  });
}

async function scrapeOne(url, index) {
  try {
    const html = await httpGetText(url);
    const title = extractTitle(html);
    const cover = extractCover(html);
    return formatVideoEntry({
      author: '本地抓取',
      desc: title,
      music: '本地抓取',
      emoji: '🎬',
      scene: title,
      likes: 0,
      comments: 0,
      shares: 0,
      bg: ['#285c62', '#34475e', '#a83c27', '#426354'][index % 4],
      followed: false,
      live: false,
      title,
      cover,
      url
    }, index);
  } catch (error) {
    return formatVideoEntry({
      author: '本地抓取',
      desc: '抓取失败，使用本地示例',
      music: '本地示例',
      emoji: '🎬',
      scene: '抓取失败',
      likes: 0,
      comments: 0,
      shares: 0,
      bg: ['#285c62', '#34475e', '#a83c27', '#426354'][index % 4],
      followed: false,
      live: false,
      title: '抓取失败',
      url
    }, index);
  }
}

async function main() {
  const urls = process.argv.slice(2);
  const inputUrls = urls.length ? urls : DEFAULT_INPUT;
  const videos = await Promise.all(inputUrls.map(scrapeOne));
  const jsonFile = path.join(projectRoot, 'src', 'data', 'local-videos.json');
  const jsFileContent = `export const LOCAL_VIDEO_LIST = ${JSON.stringify(videos, null, 2)};\n\nexport default LOCAL_VIDEO_LIST;\n`;
  const jsonFileContent = JSON.stringify(videos, null, 2) + '\n';
  fs.writeFileSync(jsonFile, jsonFileContent, 'utf8');
  fs.writeFileSync(outputFile, jsFileContent, 'utf8');
  console.log(`已生成 ${videos.length} 条本地视频数据 -> ${jsonFile}`);
  console.log(`已同步生成运行时数据 -> ${outputFile}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
