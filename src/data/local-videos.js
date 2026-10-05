// 已核实的可解析抖音视频链接（2026-10 用刷新后的 ttwid 逐个实测）。
// 注意：这里只放**实测能解析出 play_addr 的链接**——原文件里那 4 条是当年抓取失败留下的
// 占位数据，实测 3 条指向已删除的视频（分享页只返回 32613 字节的通用页），已删除。
// 想加真视频：在 App 顶部「导入」粘贴分享链接即可——导入的视频会持久化，重启后仍在。
export const LOCAL_VIDEO_LIST = [
  {
    "author": "抖音视频",
    "desc": "张含韵遇上张韶涵，两大美女同唱《遗失的美好》",
    "music": "原声",
    "emoji": "",
    "scene": "视频 1",
    "likes": 0,
    "comments": 0,
    "shares": 0,
    "bg": "#285c62",
    "followed": false,
    "live": false,
    "title": "视频 1",
    "url": "https://www.douyin.com/video/7419207373887147316"
  }
];

export default LOCAL_VIDEO_LIST;
