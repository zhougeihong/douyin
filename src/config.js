// 抖音第三方数据源与运行参数
// 以下接口于 2026-10 实测可用，均无需密钥：
// - DOUYIN_HOT_FEED_API   60s 公共实例（开源项目 vikiboss/60s），返回抖音热榜：标题/热度/封面图/链接
// - DOUYIN_HOT_WORDS_API  抖音官方 web 热搜词榜（iesdouyin.com），仅热词与热度，无封面图
// 视频解析（免后端）：请求 iesdouyin 分享页并从 _ROUTER_DATA 提取视频信息，
// 可拿到作者/标题/封面/播放地址（playwm 换 play 即无水印）。前提：
// 1) 请求头带 iPhone UA（默认 UA 会被当作桌面端，拿不到数据，由 libjsapi 显式传 header 覆盖）
// 2) Cookie 带 ttwid（仅存在于 Set-Cookie，libjsapi 读不到响应头，故写入本文件，过期后
//    执行 `npm run ttwid` 重新注册并自动更新）
// 也可改用自建解析实例（Douyin_TikTok_Download_API 等），配置后优先走它。

// ★ 应用版本与名称：**必须和 package.json 保持一致**（改版本时两处一起改）。
// 为什么要写在这里：真机排查第一件事是"用户装的是哪个包"，而运行时**读不到**可靠的
// 版本来源 —— `$falcon.__AppClazz.meta.version` / `__AppInfo` / `getApp()` 在模拟器上
// 全部取不到（实测显示"未知版本"），模板早前还硬编码回退成 '1.0.0'，
// 结果**装了新包也显示 1.0.0，无法判断版本**（真机上踩过，误事）。
// 所以这里放一份权威常量，页面直接用它。
export const APP_NAME = '字节全家桶';
export const APP_VERSION = '1.0.2';

// 主数据源：抖音热榜（含封面）
export const DOUYIN_HOT_FEED_API = 'https://60s-api.viki.moe/v2/douyin';

// 备用数据源：抖音官方热搜词榜（无封面）
export const DOUYIN_HOT_WORDS_API = 'https://www.iesdouyin.com/web/api/v2/hotsearch/billboard/word/';

// 扫码登录：字节统一账号 sso 接口（官方文案即"使用抖音 APP 扫码验证"，免密钥）。
// 实测这个入口的归属 App 固定是“今日头条APP”（响应里 app_name/web_name = 今日头条APP，
// 二维码指向 i.snssdk.com/passport/web/scan_index/ 头条侧扫码页），所以手机上会显示今日头条
// —— 但账号是字节统一账号，用抖音 APP 扫码同样能登录，登录态一致。
// 抖音自有入口实测全部不可用（2026-10 复测）：
//   sso.douyin.com/passport/...            → 403 路由已封禁
//   www.douyin.com/passport/web/get_qrcode → message: error
//   service=https://www.douyin.com          → error_code 1069（该应用无权限）
//   追加 aid=6383/2329/1128 或 app_name=douyin → error
// 想要真正的“抖音”品牌扫码，只能走抖音开放平台应用（client_key + 授权 scope）。
export const DOUYIN_SSO_API = 'https://sso.toutiao.com/passport/sso/';

// 解析分享页用的移动端 UA（必须，否则返回的是桌面版页面）
export const DOUYIN_SHARE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';

// ttwid Cookie（解析必需）。失效时执行 `npm run ttwid` 自动刷新。
export const DOUYIN_TTWID = '1%7CWl2EGjyHEAkr93hsksx9Y7otxqNjHb3Fr_uzmLMlb-k%7C1790927862%7Cedc037f0ad3c00daf075abab94bf23f6832048993d31bba116da84052c0496ef';

// 可选：第三方/自建解析实例地址（兼容 Douyin_TikTok_Download_API 响应），配置后优先于内置解析
export const DOUYIN_VIDEO_PARSE_API = '';

// 单次请求超时（毫秒），超时后自动切换下一数据源
export const API_TIMEOUT_MS = 12000;

// HTTPS 中转。
// 2026-10-02 笔端网络诊断实测（新诊断会打印真实响应体）：
//   1 直连热榜接口 → 拿到 {"code":200,…}，说明**固件 libcurl 自带 TLS，直连可用**；
//   2 经中转拉热榜 → 同样 200。
// 两条通路都通，此前“接口全部返回异常”的真凶是 libjsapi 没剥掉原生 {result:…} 包装
// （已修，见 src/services/libjsapi.js）。既然直连可用，就置空中转、不依赖 PC。
// 若日后发现**封面图 https 加载不出来**（图片走的是原生图像栈，与 libcurl 不同），
// 把它改回 'http://<PC局域网IP>:8712' 并在 PC 上常驻 `npm run relay`（脚本已默认
// RELAY_HOST=0.0.0.0），封面会自动改走中转；接口侧任何时候都会直连失败自动回退。
export const API_RELAY = '';

// 可选的“登录 Cookie 抓取助手”（PC 中转服务）——**默认留空 = 完全不开中转**。
// 为什么需要它：设备端 libjsapi 的原生 http 只回传响应体（外层形如 {"result":"<body>"}），
// 而会话是随 Set-Cookie 响应头下发的；中转的 &meta=1 只是替我们把响应头捎回来。
// 因此**只有当固件确实没把响应头放进原生响应对象时**才需要它。
// 判断方法：网络诊断里的「1 响应外层键」与「1 响应头含 Set-Cookie」两行——
//   · 若外层键里有 header/headers、或直接显示含 Set-Cookie → 留空即可，直连就能抓到会话；
//   · 若只有 result → 直连抓不到会话，两条路可选：
//       ① 临时填成 PC 中转地址（npm run relay）完成一次登录；
//       ② 用「我的 → 粘贴 Cookie 登录」：电脑浏览器登录后复制整串 Cookie 粘进来（推荐，永久不开中转）。
// 例：'http://192.168.10.23:8712'
export const LOGIN_HELPER = '';

// 原生播放器的视频中转（**实测已确认不需要，默认置空**）。
// 2026-10 真机诊断实测：`原生 https 直连播放: OK 1280x720` —— 固件的 FFmpeg **自带 TLS**，
// 把 https 播放地址直接交给原生播放器即可（302 跳转与拉流都由 FFmpeg 自己完成），
// 既不需要中转，也不需要登录。诊断里那一行同时就是回归用例。
// 这里是**兜底开关**：只有遇到确实没有 TLS 的固件才填中转地址
// （例 'http://192.168.10.23:8712'，relay 会把 https 拉回来用 http 转发）。
export const VIDEO_RELAY = '';

// 信息流最多加载条数
export const FEED_LIMIT = 20;

// ============================================================
// 多闪（抖音私信）· PC 网关
// ============================================================
// 架构（源码 D:\duoshan-pen-源码-20261004\duoshan-pen）：
//   词典笔 App ──HTTP(局域网)──> PC 网关 gateway.py ──HTTPS/WSS──> 抖音
// 登录态存在 **PC 网关**（dy-gateway/dy-session.json），App 里不存 Cookie。
//
// 我们走**路线 A：PC 网关**（dy-gateway/gateway.py，默认监听 0.0.0.0:8090）。
// 因此在笔上要填的是**电脑的局域网 IP**（如 192.168.1.100:8090），不是 127.0.0.1
// —— 127.0.0.1 只有在路线 B（笔端 dyserver 守护进程）下才成立。
// 这里只是「出厂默认值 + 提示用」，真机上以 UI 里填/存在 storage 的地址为准；
// 置空表示未配置，页面会引导用户填写。
export const CHAT_GATEWAY_DEFAULT = '';

// 没写端口时补的默认端口（与 gateway.py 的 DY_GATEWAY_PORT 默认值一致）
export const CHAT_GATEWAY_PORT = 8090;

// 聊天接口单次请求超时（毫秒）。二维码首帧要等网关现算，给得比普通接口宽一些。
export const CHAT_API_TIMEOUT_MS = 15000;
