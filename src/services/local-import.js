// 分享链接导入：不依赖后端。
// 默认走 douyin-api 内置解析（iesdouyin 分享页 + ttwid，免费可用），
// 拿到作者/标题/封面/播放地址；配置 DOUYIN_VIDEO_PARSE_API 时优先走外部解析实例，
// 两级都失败则退回普通条目生成。
import { parseVideoByUrl, extractVideoId } from './douyin-api.js';
import { relayAssetUrl } from './libjsapi.js';

const PALETTE = ['#285c62', '#34475e', '#a83c27', '#426354', '#688044'];

export function normalizeDouyinVideoUrl(rawUrl) {
  const cleaned = String(rawUrl || '').trim();
  if (!cleaned) return '';
  if (cleaned.indexOf('douyin.com') < 0 && cleaned.indexOf('iesdouyin.com') < 0) {
    return '';
  }
  return cleaned;
}

export function createVideoFromLink(rawUrl, index = 0) {
  const url = normalizeDouyinVideoUrl(rawUrl);
  const videoId = extractVideoId(url) || 'local-' + (index + 1);
  const title = '导入视频 ' + (index + 1);

  return {
    author: '本地导入',
    desc: url || title,
    music: '本地导入',
    emoji: '',
    scene: title,
    likes: 0,
    comments: 0,
    shares: 0,
    bg: PALETTE[index % PALETTE.length],
    followed: false,
    live: false,
    title,
    url,
    cover: '',
    videoId,
    source: 'local-import',
    commentList: [{ author: '影像爱好者', text: '视频链接已加入列表！' }]
  };
}

export async function resolveVideoFromLink(rawUrl, index = 0) {
  const url = normalizeDouyinVideoUrl(rawUrl);
  if (!url) throw new Error('请输入正确的抖音分享链接');

  try {
    const parsed = await parseVideoByUrl(url);
    if (parsed) {
      return {
        ...parsed,
        cover: relayAssetUrl(parsed.cover || ''),
        music: '原声',
        emoji: '',
        scene: parsed.title,
        bg: PALETTE[index % PALETTE.length],
        followed: false,
        live: false,
        commentList: [{ author: '影像爱好者', text: parsed.playUrl ? '解析成功，已导入！' : '已导入，未取得播放地址' }]
      };
    }
  } catch (error) {
    // 解析不可用（ttwid 失效等）时退回普通导入
  }

  return createVideoFromLink(url, index);
}
