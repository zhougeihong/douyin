#笔上抖音 · 词典笔 miniapp

有道词典笔 **Falcon / HaaS UI 小程序**（Vue 2.6 + QuickJS），逻辑横屏 **800×254**
（物理 fb 254×800，方向=270）。

> **本工程 1.0.8 起只做抖音。** 之前它叫「字节全家桶」，一个包里塞了四个功能；
> 现在今日头条 / 番茄小说 / 豆包 已是各自独立的 miniapp。完整记录见 `HANDOFF.md` §19。

**深度文档在 [`HANDOFF.md`](HANDOFF.md)** —— 那里的 **§0 是当前事实**（与正文冲突以 §0 为准），
§12~§18 是各功能的实测推演与踩坑记录。本 README 只讲"怎么跑"。

---

## 1. 四个 miniapp 的全局视图

| 目录 | 应用 | appid | 说明 |
|---|---|---|---|
| **`D:\douyin`** | **笔上抖音**（本工程） | 8001790389478283 | 唯一带**随包原生播放模块**（`libs/*.so`）的工程 |
| `D:\jinritoutiao` | 今日头条 | 8001790389478284 | 观看=读正文；视频直链做不了（见 HANDOFF §13.8） |
| `D:\fanqiexiaoshuo` | 番茄小说 | 8001790389478285 | 离线文本缓存；正文有字体反爬（§14） |
| `D:\doubao` | 豆包 | 8001790389478286 | OpenAI 兼容接口，**默认不带密钥**（§18） |

> ⚠️ 后面三个 appid 是**按本工程顺延的占位值**，未在平台注册；
> 装机前请换成真实 appid，否则可能装不上。**同一个 appid 装到笔上会互相覆盖。**

**图标**：本工程的 `icon.png` 是**原样的抖音图标**（黑底 + 抖音音符 + 底部词典笔，192×192，未改动）；
另外三个 app 的图标是**照各自官方图标量出几何后手绘的仿制图**，都保留"上半部分应用母题 +
下半部分词典笔"的家族构图（头条＝白底斜红带「头条」／番茄＝白底橙书签+番茄+白籽／豆包＝浅蓝底人像）。
生成脚本与说明见 `_split/gen-app-icons.py` 和 `_split/README.md`；
改完图标**必须重新 `npm run build`**，否则装到笔上还是旧图标。

## 2. 工作链

```powershell
npm test              # 5 个套件：player-api / douyin-preload / author-api / player / services
npm run build         # aiot-cli -p → .falcon_/ + 8001790389478283.1_1_1.amr
npm run check         # aiot-cli 检查
npm run relay         # PC 中转（模拟器没 TLS 时才需要）
npm run ttwid         # 刷新 config.js 里的 DOUYIN_TTWID（分享页解析必需，会过期）
npm run build:simulator   # 启模拟器预览
```

- CLI 在 `D:\npm-global\aiot-cli.cmd` —— **`.ps1` 会被执行策略拦，必须用 `.cmd`**。
- `node scripts/test-services.mjs` 单独跑时：**126 PASS / 0 FAIL / 4 NOTE**（判断标准是 FAIL=0）。
- 构建时的两条警告可忽略：`未找到以下模块: fs,video`（**固件原生模块**）、
  `object-fit 不是标准属性`（已有 `components/VideoPlayer.vue`）。

## 3. 目录结构（要点）

```
src/
  app.js                  应用入口（★ 必须在任何 import('video') 之前 detectScreen()，否则原生侧几何错→黑屏）
  app.json                注册 index/home（启动器）、douyin、player、author、blank
  config.js               全部实测注释 + 版本/名称权威常量 + API_RELAY / VIDEO_RELAY / LOGIN_HELPER / DOUYIN_TTWID
  pages/index/            启动页 launcher：一张「笔上抖音」卡 + 观看历史入口
  pages/douyin/           抖音主页：左栏分区（视频/搜索/发布/消息/我的/日志）+ 互动栏 + 日志面板
  pages/player/           横屏播放页（原生画面 + 控制栏 + 弹幕 + 断点续播 + 推荐）
  pages/author/           作者页（投稿列表；匿名只能拿到首屏）
  components/             拼音输入法（六模式输入法）/ ImeField / VideoPlayer / FramePlayer
  services/
    libjsapi.js           网络/存储适配层（原生 libjsapi → fetch → tt；剥壳；storage JSON 契约）
    native-player.js      原生播放桥 + 候选轮换 + 坏主机黑名单（★ 顶部有禁令注释，改前必读）
    douyin-api.js         官方 web 视频流 / 详情 / 相关推荐 / 弹幕 / 分享页解析
    douyin-auth.js        SSO 扫码 + 手机号登录   session-cookies.js / ttwid.js  登录态与 ttwid
    douyin-preload.js     首页预热（进 app 就缓存 feed，避免开头网络争用）
    author-api.js         作者页数据（SM3/F2 签名）   app-log.js  有界本地日志
    video.js / local-import.js / play-request.js / player-lifecycle.js / video-caps.js
    ime-engine.js + data/ime-dict.js   输入法引擎与词典（万象拼音 CC-BY-4.0）
libs/                     随包原生模块（armv7-glibc）：libjsapi_better_video.so 等
native/                   原生模块可重建源码 + FFmpeg 公共头 + 构建脚本 + 调度测试
scripts/                  测试套件 / 延迟中转 / ttwid 刷新 / 证据处理
profiles/                 设备画像与真机证据（截图、日志）
_split/                   ★ 1.0.8 拆分工具 + 内容快照（不进包、不参与构建，见 HANDOFF §19）
```

## 4. ⛔ 改代码前必须知道的四条红线（摘自 HANDOFF §0.4）

1. **不要用 JS 的 http 通道去 GET 视频/媒体地址** —— 会把二进制灌进原生字符串通道，
   实测 **42% 字节非法 UTF-8，曾导致词典笔软重启**。
2. **不要用 `new URL()`** —— QuickJS 里没有 `URL`，异常被吞会静默失效（用正则取主机名）。
3. **`jsapiStorageSet` 的值必须能自己 JSON 序列化**（契约是"存字符串、读回对象"）。
4. **Weex 只支持单类名选择器** —— `.a.b{}` 会被丢弃；emoji 不显示。

## 5. 真机验证要点

- 装包：`miniapp_cli install <amr>`（保留应用数据）；启动是位置参数：
  `miniapp_cli start 8001790389478283 index`（help 里的 `--index` 会被当字面脚本名）。
- 进 app 后左栏「日志」页可看本地状态与播放事件；**播放画面/声音/seek/倍速**是必测项
  （原生播放的回归方法见 HANDOFF §16）。
- 模拟器**没有 https**，要出数据得临时填 `API_RELAY` 并跑 `npm run relay`；
 横屏预览要把模拟器 `cfg.json` 的 `screen` 改成 800×254。**验收完都还原。**

## 6. 已知项

- `package.json` 硬编码了模拟器路径；`simulator.page` 为空。
- 中继无鉴权、默认监听 `0.0.0.0`（局域网内自用的取舍，HANDOFF §15.6 记为已知风险）。
- HANDOFF 里记录过多条**已被推翻的旧结论**（如"模块没有 TLS"、"'error:3' 是抖音返回的"），
  那是故意留的：读正文前先读 §0 的假设状态表。
