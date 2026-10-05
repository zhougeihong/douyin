// video 组件能力探测记录。
// 本项目在两种形态下运行，video 的用法完全不同：
//   · 浏览器预览 / 支持 HTML5 的容器：标准的 play()/pause()/currentTime/duration + play/timeupdate/ended 事件
//   · 词典笔等 falcon(Weex 风格) 原生运行时：只有 play-status 属性 + auto-play/loop，
//     事件是 start/pause/finish/fail，没有 play()/currentTime/duration
// 由 VideoPlayer 挂载时上报，网络诊断页据此显示，避免再靠猜。

let caps = null;

export function reportVideoCaps(next) {
  caps = Object.assign({}, caps || {}, next || {});
}

export function readVideoCaps() {
  return caps;
}

export function videoCapsText() {
  if (!caps) return '未检测（信息流里还没有带播放地址的视频）';
  if (!caps.hasNode) return '没有渲染出 video 节点（运行时不认识该组件）';
  if (caps.html5) return 'HTML5 模式（play()/currentTime 可用）';
  return 'Weex 模式（仅 play-status + start/pause/finish/fail）';
}
