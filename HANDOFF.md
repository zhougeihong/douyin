# HANDOFF · 字节全家桶（有道词典笔 / Falcon-HaaS 运行时）
> 最后更新：当前版本 **1.0.2**，appid `8001790389478283`，应用名 **字节全家桶**。

---

## 0. 当前事实速查（**先读这一节**）

> 本文件是**按时间追加的日志**，下面的正文保留了完整的推演与踩坑过程，因此**必然存在
> "早前结论已被后来推翻"的段落**。为避免读者（包括下一个 AI 会话）读完全文才知道当前真相，
> 这一节汇总**此刻为真**的事实。**与本节冲突的，以本节为准。**

### 0.1 版本与开关（当前值）

| 项 | 当前值 | 说明 |
|---|---|---|
| `package.json` `version` | **1.0.2** | 产物 `8001790389478283.1_0_2.amr` |
| `package.json` `name` | **字节全家桶** | 显示名（appid 不变） |
| `API_RELAY` | **`''`（空）** | 空 = 直连。需要 PC 中转时才填 `http://<PC-IP>:8712` |
| `VIDEO_RELAY` | 未设（空） | 同上 |
| `LOGIN_HELPER` | `''`（空） | |
| `simulator.page` | `''`（空） | 空 = 从 app.json 的首页进入 |
| 模拟器屏幕 | **254×800（竖屏）** | 跑横屏页面前要临时改成 800×254，跑完记得还原 |

### 0.2 测试真实状态

- `node scripts/test-services.mjs` → **185 PASS / 0 FAIL**（Node 16 与"模拟 Node≥18 fetcsh"两种环境连跑多次一致）。
- **PASS 数会 ±几点浮动，这是设计如此、不是回归**：凡依赖第三方接口当时可用性的断言
  一律用 **NOTE**（不 FAIL）。接口抖动时某条从 PASS 变 NOTE，总数就动一下 ——
  **判断标准是 `FAIL = 0` 且退出码 0，不是 PASS 数恒定**。
- ⚠️ 早前版本这里曾**随 Node 版本飘**（Node16 绿、Node≥18 红）：旧断言只 `delete globalThis.$falcon`，
  而 **Node ≥18 自带全局 `fetch`**，通道链会退到 fetch 真发请求 → 断言假成功。
  **已修**：断言前同时 `globalThis.fetch = undefined`。改这条断言时别再只删 `$falcon`。
- ⚠️ **新加的断言必须环境无关**：不要在测试里打真实 probe/中转端点，
  否则 PASS 数会随"中转是否在跑"变化（probe 的断言已改成只考纯逻辑）。

### 0.3 假设状态（哪些还成立、哪些已被推翻）

| 假设 | 状态 | 依据 |
|---|---|---|
| 原生模块的 FFmpeg **没有 TLS** | ❌ **已推翻** | §13.7 诊断第 11 行 `原生 https 直连播放: OK 1280x720` —— **固件自带 TLS** |
| 抖音 CDN 落点**要求 Referer**，否则 403 | ❌ **已推翻（2026-10 对照实验）** | §15.8 ①：只带 UA 19/26 vs 带 Referer 18/26，**救回 0 条**。当年结论是样本太少 |
| 失败主机**多入口轮换就能绕过** | ⚠️ **部分成立** | §15.8 ②：**同一 uri 的落点主机固定不变**（连测 6 次同一台）。轮换只在"同一条 uri 会换主机"时有用；落在永久坏主机上的 uri **轮换无效** |
| 真机的 `{"error":3,…}` 是抖音返回的 | ❌ **已推翻** | §15.8 ③：抖音各层实测只返回 302 / 403 openresty / 空 200。`error:3` 是**原生 JS http 层**对网络失败（DNS/连接）的统一错误体 |
| 302 落点 CDN 主机**随机分配且部分坏** | ✅ **成立（真根因）** | §13.9；`v95-bjb-mc-cold.douyinvod.com` DNS **永久 ENOTFOUND** |
| `jsapiHttpRequest` 与 relay **都不跟随重定向** | ✅ 成立 | §12.10；测试桩会跟随（注释已改正），**两者行为不同** |
| 抖音 `play_addr` 的 douyinvod **直链恒 403** | ✅ 成立 | §13.2，六种组合都试过 |
| 头条视频直链可解 | ❌ **做不了** | §13.8：`playAuthTokenV2` 是**加密 JWE**，取不出内层 SigV4 凭据 |
| 番茄正文可整本读 | ❌ **做不到** | §14.2：付费章服务端只回占位 + 正文有**字体反爬** |

### 0.4 绝对禁令（违反会导致设备故障）

1. ⛔ **不要用 JS 的 http 通道去 GET 视频/媒体地址**。会把二进制灌进原生字符串通道，
   实测 **42% 字节非法 UTF-8**，**曾导致词典笔软重启**（§9、§13.10）。
   曾经的 `resolvePlainHttpUrl()` 正是这么干的，**已删除**（§15.1）。
2. ⛔ **不要用 `new URL()` 取 hostname**。**QuickJS 里没有 `URL`**，异常被吞会静默失效
   （番茄封面曾因此全丢，§14.3）。用正则取主机名。
3. ⛔ **`jsapiStorageSet` 的值必须自己能 JSON 序列化**；storage 契约是"存字符串、读回对象"。
4. ⛔ **Weex 只支持单类名选择器**；多类名选择器会被丢弃。

---

## 1. 目标设备与运行时（这些约束决定了几乎所有设计）

| 项 | 值 / 事实 |
|---|---|
| 运行时 | Falcon / HaaS UI 小程序，**Vue 2.6 + QuickJS**，页面用 `$falcon.Page` + `setRootComponent` |
| 屏幕 | **逻辑横屏 800×254**；物理 fb 254×800、direction=270 |
| `<video>` 组件 | **不存在**。真播放只能靠随包的原生模块（见 §4） |
| emoji | **屏幕不显示** → 全项目禁止 emoji，用中文/ASCII 标签 |
| CSS | Weex 风格：**只支持单类名选择器**（`.a.b{}` 会被丢弃并告警）；用 `class="btn btn-x"` + `.btn-x{}` |
| 响应头 | 原生 http **不回传 headers**（外层只有 `{result}`）→ 读不到 `Set-Cookie` |

## 2. 构建 / 测试 / 调试

```powershell
cd D:\douyin
npm run build      # aiot-cli -p → 产物 .falcon_/ + 8001790389478283.1_0_0.amr
npm test           # node scripts/test-services.mjs（当前 53 断言）
npm run ttwid      # 刷新 src/config.js 里的 DOUYIN_TTWID（分享页解析必需）
npm run relay      # PC 中转（LAN 模式，已支持 Range 透传 + &meta=1 回传响应头）
```

- CLI 位置：`D:\npm-global\aiot-cli.cmd`（`.ps1` 被执行策略拦截，**必须用 .cmd**）。
- 模拟器预览：`aiot-cli simulator ./`；把模拟器 `resources/cfg.json` 的 screen 改成 **800×254** 才能预览横屏（验证完记得还原）。截屏用 `PrintWindow`（`CopyFromScreen` 会被别的窗口抢焦点）。
- **⚠️ 编码坑**：不要用 PowerShell 的 `Get-Content/Set-Content` 改源码（本机默认 GBK，会写出 mojibake，曾毁掉 `src/services/video.js`）。要么用编辑器/`edit`/`write` 工具，要么 `.NET` + `new UTF8Encoding($false)`。

## 3. 设备端已实测事实（网络诊断输出，别再猜）

| 诊断行 | 实测结果 | 结论 |
|---|---|---|
| `0 运行模式` | 直连 https | `API_RELAY=''`，数据链路不依赖 PC |
| `1 直连热榜接口` | OK 48 条 | 固件 libcurl **自带 TLS**，直连可用 |
| `1 响应外层键` | `result`（无 header） | **读不到响应头** → 会话 Cookie 只能靠中转或粘贴 |
| `8 原生播放模块 video` | **可用** | `libs/*.so` 被成功加载，播放引擎就绪 |
| `9 页面导航 API` | `navTo` | ✅ 存在，解析成功后可跳进原生播放页 |
| `10 本机存储` | 读写正常 · 已保存登录态: 无 | ✅ storage JSON 契约修复生效（登录一次后应能跨重启保留） |
| `11 原生 https 直连播放` | **OK 1280x720** | 🎉 **固件 FFmpeg 自带 TLS** → 视频播放**不需要中转、不需要登录、不需要下载** |

## 4. 原生播放（已接入，未做真机画面验证）

- 引擎：`libs/libjsapi_better_video.so`（ELF **ARM 32 位**）——FFmpeg 4.4 解码 + libswscale + 直写 `/dev/fb0` + ALSA。
  **实测官方 aiot-cli 会同步 `libs/` 并打进 `.amr`**（这是它能生效的前提）。
- JS 桥：`src/services/native-player.js`，通过 `await import('video')`（该动态 import **实测构建后原样保留**）。契约见文件头注释。
- 播放页：`src/pages/player/player.vue` + `player.js`（横屏 800×254，控制栏唤出时用 `setView` 把画面收缩到 190px）。
- 地址改写：`nativePlayableUrl()` —— https 视频经 `VIDEO_RELAY` 改写成 http 中转（固件 FFmpeg 一般无 TLS）。
- 参考实现来源：`F:\Users\Administor\Downloads\better-video-player-main\better-video-player-main`（同款 .so 与播放页，其 README 有真机 profile）。

## 5. 数据链路现状

- 热榜（`60s-api.viki.moe`）**只给"话题"**：标题+封面+搜索链接，**没有视频文件** → 信息流里绝大多数条目天生播不了（UI 标为「话题」）。
- 免费直连的"视频列表"源**全部不可用**：抖音热视频榜返回空 `aweme_list`、`iteminfo` 未登录 `status_code=11110`、`/aweme/v1/web/aweme/detail/` **403**。
- 现有视频来源：① 已知链接（**实测 4 条只有 1 条有效**：`7419207373887147316`）② 用户「导入」分享链接（**已持久化**，重启后仍在，最前显示）③ 配置 `DOUYIN_VIDEO_PARSE_API` 自建解析服务 ④ 登录后 `iteminfo` 批量取。
- 分享页解析（`iesdouyin.com/share/video/<id>/`）是唯一免签名能拿 `play_addr` 的路，但**会被按 IP 限流**，且依赖 `ttwid`（会过期）。

## 6. 登录（两条路）

1. **扫码**：`sso.toutiao.com/passport/sso/…`。缺点：`app_name=今日头条APP`，**手机上显示今日头条**（见 §8 有抖音品牌入口）。抖音自有入口实测全不可用（`sso.douyin.com` 403 路由已封禁、`www.douyin.com/passport/…` error、`service=douyin.com` → `error_code 1069`）。
2. **手机号（爬网页端）**：实测只有这两个可用 ——
   - `…/passport/web/send_code/`（mobile+type+aid+service）→ 无效号返回 `1003 手机号错误`（说明在校验号码）
   - `…/passport/web/sms_login/`（mobile+code+…）→ 校验不过返回 `3052`
   - 其它（`/web/login/`、`/login_by_mobile/`、`/mobile_login/`、`/check_mobile/`）全 `16 该应用无权限`；`www.douyin.com/passport/web/*` 为 `22 非法应用`。
   - **必需请求头**：`Referer/Origin: https://www.toutiao.com/`（缺了会返回 16，设备端最初就是这么失败的）；16 时会自动换 POST 表单重试（16 表示没发短信，重试安全）。
3. **粘贴 Cookie 登录**（推荐，与固件无关）：电脑浏览器登录后复制整串 Cookie，在「我的」页粘贴保存。

## 7. 已知坑（踩过的，别重复）

1. **storage 值必须 JSON 字符串化**：`setStorage({key,data})` 塞对象会读回废值 → 曾导致"登录完退出小程序又要重新登录"。`src/services/libjsapi.js` 已统一 `JSON.stringify`/`parse`，并加了内存兜底 + 超时 + 同 key 写串行。
2. **原生响应包装**：真机 `http.request()` 返回 **Promise**，resolve 的是 `{result:"<body JSON 字符串>"}` 且**早于 success 回调**。必须剥壳（`unwrapEnvelope`），否则整层包装被当响应体 → 所有接口报"返回异常"。
3. **空响应当失败**：固件连不上时仍走 success 回调且内容为空，必须按失败处理，否则直连/中转互备失效。
4. **响应外层要留证据**：剥壳时保留原始外层对象（`__envelope`），否则诊断看不到固件是否回传 header。
5. **Cookie 脏数据**：错误体里的 `{error, errorMessage}` 曾被当 cookie 存下 → `hasLoginCookie()` 误判。现按名单+值格式过滤，载入时清洗。
6. **relay 崩溃**：`writeHead` 传 `undefined` 头值会抛 `ERR_HTTP_INVALID_HEADER_VALUE` 打死进程；已改为只挂存在的头，并加 `uncaughtException` 兜底。
7. **ttwid 会过期**：过期后分享页解析全失败（表现＝视频页没视频）。先 `npm run ttwid`。见 §8 有自动注册接口。

## 8. APK 反编译收获（重要，尚未接入）

来源：`D:\mydv_307552.apk`（myDV 安卓 TV 版），已解包到 `D:\douyin\.temp\apk\`。
公开仓库 `mytv-android/myDV` 只是发布壳，**源码在私有仓库 `myDV-Internal`**（读不到）。

**接口（dex 里提取）**

| 用途 | 接口 |
|---|---|
| **抖音品牌扫码登录** | `https://login.douyin.com/passport/web/get_qrcode/`、`check_qrconnect/`、`challenge/` |
| **ttwid 自动注册** | `https://ttwid.bytedance.com/ttwid/union/register/`、`https://login.douyin.com/ttwid/check/` |
| msToken | `https://mssdk.bytedance.com/web/r/token?ms_appid=6383&msToken=…` |
| 签名后调用 | `/aweme/v1/…`、`/aweme/v2/`、`/webcast/`、`https://www.douyin.com/service/2/abtest_config/` |

**签名脚本**：`assets/abogus.js`(4KB) + `assets/bdms.js`(147KB) + `assets/sign.js`(485KB) + `assets/abogus_dy.js`(538KB)，配合 `libquickjs-android-wrapper.so` 在 QuickJS 里跑。
`abogus.js` 接口：`initABogus()` → `bdms.init({aid:6383,pageId:6241,paths:['^/aweme/v1/',…]})`；`getABogus(query,data,uri)` 返回 `{"ok":true,"value":"<a_bogus>"}`。
它 hook 了 `XMLHttpRequest.open/send` 与 `window.fetch`，用"合成 XHR"让 bdms 注入签名再抓取。**加载顺序：abogus.js 必须在 bdms.js 之前。**

**建议的三步（已用 PC 实测校正，2026-10）**

| 步骤 | 实测结论 | 能否单独做 |
|---|---|---|
| ① 扫码换 `login.douyin.com/passport/web/get_qrcode/` | **被抖音反诈拦死**：任何参数组合都返回「您正在尝试访问的网站存在安全风险…已阻止此次访问」（带 csrf cookie / next / verifyFp 都一样）。myDV 能用是因为它带 a_bogus 签名 | ❌ **依赖 ③**，不能单独先做 |
| ② ttwid 自动注册 `ttwid.bytedance.com/ttwid/union/register/` | **接口可用**：`error_code=0 union register success`，`Set-Cookie: ttwid=…`。但跟它返回的 `redirect_url`（带 ticket）后，callback 只回 `{"status_code":0,"message":"callback success"}`，**body 里没有 ttwid** | ⚠️ 需要「中转 meta=1」才能读到值；且该接口是 **POST**，而中转目前只转发 GET → **要先给中转加 POST 支持** |
| ③ 接 a_bogus 签名 | 尚未开始。它是 ①（抖音品牌扫码）乃至 `/aweme/v1/` 视频列表的**前置条件** | ✅ 优先级最高 |

③ 的代价：包体 +~1.2MB；且 bdms/sign 是字节私有 SDK，**灰色地带，自用研究可以，别商用/分发**。
③ 的关键实现点：`abogus.js` 必须**先于** `bdms.js` 加载；运行时需提供 `XMLHttpRequest`（open/send 可被 hook）与 `window.fetch` 垫片；`getABogus(query, data, uri)` 返回 `{"ok":true,"value":"<a_bogus>"}`，把它拼进 query 即可。

## 9. 待办（按优先级，2026-10 校正）

> **排序已变**：APK 的 ①（抖音品牌扫码）实测被反诈拦截，**必须先有签名**，所以 ③ 升为最高价值项。

1. **验证 storage**（要真机）：装最新包 → 登录 → 完全退出小程序 → 重进，看「我的」是否仍登录；拿诊断第 **10 行**。若异常 → 改用随包原生模块的 `fs`（`custom_init_jsapis()` 已注册 `fs`）写文件持久化。
2. 拿诊断第 **9 行**（页面导航 API）→ 确认 `navTo` 是否存在，否则要换跳转方式。
3. **③ 接 a_bogus 签名**（★ **已尝试并判定为高风险，建议暂缓**）：
   - 2026-10 本地可行性验证（`.temp/abogus-test.mjs`）：在 Node 里给 `window/navigator/document/XMLHttpRequest/fetch/crypto/localStorage` 等造了最小浏览器环境，按 `abogus.js`→`bdms.js`→`initABogus()` 顺序加载；
     结果 `bdms.js` 初始化即报 `TypeError: undefined is not a function`（`bdms.js:2:131790`）。
   - 反查该处代码发现：**`bdms.js` 是一段序列化字节码 + 解释器 VM**（`function d(){for(;;){var t=o[a++]…}}`），它在初始化时调用某个宿主提供的原生函数 → 说明它**需要一个接近真实浏览器的环境（WebView 级）**，而我们的运行时是纯 QuickJS，本身也没有这些 API。
   - 因此：**要么补齐一整套浏览器 API 影子（工作量与不确定性都很大，且换到笔上也未必够）**，要么放弃。
   - **价值评估（为何可以不做）**：视频播放已确认**不需要签名也不需要中转**（固件 FFmpeg 自带 TLS）。签名只解锁两件"锦上添花"的事：① 推荐流视频列表 ② 抖音品牌扫码。
   - 替代方案（无需签名）：**导入分享链接**（已持久化）+ **登录后 iteminfo**（粘贴 Cookie，`bit_rate[].play_addr.url_list` 含直链）。
   - 若要继续，建议换到真实浏览器里先跑通（本会话曾评估用 tabbit/Playwright 控制浏览器验证），再评估移植到 QuickJS 的可行性。
4. **① 抖音品牌扫码**（③ 完成后即可做）：`login.douyin.com/passport/web/get_qrcode/` + `check_qrconnect/`，须带签名/msToken，否则返回反诈拦截页。
5. ~~② ttwid 自动注册~~ **✅ 已实现（2026-10，需中转）**：
   - relay 已支持 **POST 转发**（method + body + content-type，保留 Range/meta 逻辑）；
   - `src/services/ttwid.js` 的 `refreshTtwid(relayBase?)`：POST register → 从 meta 信封的 `set-cookie` 取 `ttwid` → 落 Cookie jar（`cookieHeader()` 优先用 jar 里的 ttwid）；
   - `fetchSharePage` 在分享页拿不到 `_ROUTER_DATA` 时**自动刷新一次并重试**（每会话一次），失败保留原错误；**未配中转时明确报错**，不会静默；
   - 实测：中转 `POST /relay?...&meta=1` → 上游 200 → 信封 `headers['set-cookie'] = ttwid=1%7C7LsDcCAMQ…` ✓，relay 存活 ✓；
   - 测试：`npm test` 56 PASS / 0 FAIL（含"未配中转报错"与"从 meta 信封取 ttwid"两条）。
   - 手动 `npm run ttwid` 仍可作为无中转时的兜底。
   - **"无需中转"的结论（2026-10 实测）**：ttwid **没有任何把值放进 body 的变体**——标准 body 与加 `returnTtwid/needTtwid` 都只回 `[status_code,message,redirect_url]`，值只在 `Set-Cookie`；`/ttwid/check/`（bytedance 与 douyin 域）要么 404 要么不给 cookie。所以**设备端运行时自愈确实做不到**，但 **ttwid 不需要设备端中转**：在 PC 上打包前刷一次（`npm run ttwid`）写进 `config.DOUYIN_TTWID` 即可，设备端只带一个字符串。中转自愈只是"便利"，不是必需。
6. 视频播放 —— **✅ 已解决：完全不需要中转（2026-10 真机实测）**
   - 诊断第 11 行 `原生 https 直连播放: OK 1280x720` → **固件 FFmpeg 自带 TLS**，把 https 播放地址直接交给原生播放器即可（302 与拉流 FFmpeg 自己完成）；
   - 因此 `config.VIDEO_RELAY` 已按默认 **置空**（保留为"无 TLS 固件"的兜底开关）；
   - 之前为"免中转"准备的两条路都**不再需要**：① 登录 + iteminfo 直链降级 http（代码保留，作为无 TLS 兜底）② 下载到笔内（**已放弃**：实测测试文件 42% 字节非法 UTF-8，原生 http 的字符串通道会损坏二进制；要做必须给原生模块加 `download(url,path)`，需 C++ + armv7 工具链）；
   - 回归方法：装包后跑网络诊断看第 11 行，`OK <W>x<H>` 即正常。
7. 真机确认：九键输入法手感、播放画面/声音/seek、横屏布局。
8. 手机号登录真机复测（Referer 修复后）；若仍 16 → 以「粘贴 Cookie」为主力。

## 10. 关键文件索引

| 文件 | 作用 |
|---|---|
| `src/config.js` | `API_RELAY=''`、`LOGIN_HELPER=''`、`VIDEO_RELAY=<PC中转>`、`DOUYIN_SSO_API`、`DOUYIN_TTWID`、`DOUYIN_VIDEO_PARSE_API`，以及全部实测注释 |
| `src/services/libjsapi.js` | 网络适配（通道链 libjsapi→fetch→tt、剥壳、`withMeta`、relay 互备、storage JSON 契约） |
| `src/services/session-cookies.js` | Cookie 提取/清洗/注入/诊断；`saveCookiesFromText`（粘贴登录） |
| `src/services/ttwid.js` | ttwid 自动注册（经中转 meta 读 Set-Cookie），分享页解析失败时自愈 |
| `src/services/douyin-auth.js` | 扫码登录 + 手机号登录（send_code / sms_login） |
| `src/services/douyin-api.js` | 热榜、热搜词、分享页解析、`fetchItemInfo`（登录态批量接口） |
| `src/services/video.js` | 信息流组装、按需解析、导入视频持久化、`resolveVideoForItem` |
| `src/services/native-player.js` | 原生播放桥 + `nativePlayableUrl` |
| `src/services/chat-api.js` | 多闪（抖音私信）PC 网关传输层：地址规范化/持久化 + `/api/*` 封装（Promise，复用 `jsapiHttpRequest`） |
| `src/services/toutiao-api.js` | 今日头条数据层：热榜 / 信息流分页 / **正文抽取（RENDER_DATA）** / 评论（本地）/ 独立 storage key |
| `src/pages/toutiao/toutiao.vue` | **今日头条页**（横屏 800×254）：观看（读正文）/点赞/我的/历史 + 二维码登录 + 评论 |
| `src/services/fanqie-api.js` | 番茄小说数据层：书单 `/api/rank/list` / 章节表 `/page/<id>` / 正文 `/reader/<id>` / PUA 掩码 / 本地书架·进度·历史 |
| `src/pages/fanqie/fanqie.vue` | **番茄小说页**（横屏 800×254）：书架 / 336 章目录 / 阅读（上下章）/ 我的 + 二维码登录 |
| `src/pages/index/index.vue` | **主主页 / 启动页**（launcher）：三个入口卡片「笔上抖音」「今日头条」「番茄小说」+ 各边登录态 + 多闪登录/观看历史入口 |
| `src/pages/douyin/douyin.vue` | 原抖音主页（**从 index 整体迁来**）：左侧分区栏 + 信息流/搜索/发布/消息/我的 + 原生播放 |
| `src/pages/chat-login/chat-login.vue` | **多闪扫码登录页**（横屏 800×254，与原抖音扫码弹层并存）：网关检测 + 二维码 + 应用内数字键盘改地址 |
| `src/pages/player/player.vue` | 横屏播放页（原生画面 + 控制栏 + 断点续播） |
| `src/components/PinyinIme.vue` | 六模式输入法（九键中文/全拼/英文/数字/符号/应用内剪贴板） |
| `libs/libjsapi_better_video.so` | 原生播放模块（armv7-glibc） |
| `scripts/relay-server.mjs` | PC 中转：https→http、Range 透传、`&meta=1` 回传响应头 |
| `.temp/apk/` | myDV APK 解包结果（接口与签名脚本）——**临时目录，别提交** |

## 12. 待整合：多闪（抖音私信）源码 · `D:\duoshan-pen-源码-20261004`

### 12.1 它的架构（已读源码 + README）

```
词典笔 App(miniapp) ──HTTP(127.0.0.1:8090)──> 笔端 dyserver(Go/aarch64) ──HTTPS/WSS──> 抖音
                                                    ↑ 登录态存这里（笔上，不在 App 里）
旧版电脑网关 dy-gateway/gateway.py（Python，0.0.0.0:8090，同一套 /api/*，README 说"已被守护进程取代，仅留参考"）
```

- miniapp 段与**我们同源**：Falcon/HaaS + `.falcon_` 产物；页面 `index`(登录/网关地址)、`chat-list`、`chat-detail`。
- **设计尺寸是竖屏 750×1600**（我们的是横屏 800×254）→ 页面版式**必须重做**，不能直接照搬。
- 客户端接口契约（`miniapp/src/utils/api.js`）：
  `/api/ping`、`/api/qr/new`、`/api/qr/status`、`/api/sessions`、`/api/messages?talker=`、`POST /api/send {talker,text}`；`config.js` 存网关地址（默认 `http://127.0.0.1:8090`，UI 只让填 IP 或 IP:端口）。
- `daemon.js` 用 `netstat/grep` + `import('bridge')` 检查/拉起**笔上**守护进程 → 用 PC 网关的话**这段不需要**。

### 12.2 两条可选后端路线

| 路线 | 需要什么 | 备注 |
|---|---|---|
| **A. PC 网关（推荐先走这条）** | PC 上 `pip install -r dy-gateway/requirements-gateway.txt` 后 `python gateway.py`（默认 0.0.0.0:8090）；App 里把网关地址填成 `192.168.x.x:8090` | 无需交叉编译，立刻可联调；登录态存在 PC |
| B. 笔端守护进程 | 需要 **arm64** 的 `dyserver`（README：`CGO_ENABLED=0 GOOS=linux GOARCH=arm64`），用 `安装多闪到词典笔.bat` 推到 `/userdisk/dypen/` | ⚠️ 先确认本机 ABI：我们的 `.so` 是 **armv7(32位)**，能跑说明系统支持 32 位；`dyserver` 是 arm64 → **能否运行必须先验证**（`uname -m`）。B 的好处是脱离电脑 |

### 12.3 整合步骤（建议顺序）

1. **先验证后端**：PC 上起 `gateway.py`，用浏览器/curl 打 `/api/ping`、`/api/status`；能通再往下。
2. **搬传输层**：`utils/api.js` + `utils/config.js` 移植进 `src/services/chat-api.js`（复用我们已有的 `jsapiHttpRequest`，注意我们的**剥壳**逻辑：真机返回 `{result:"…"}`）；地址默认值改成 PC 网关，UI 保留"只填 IP 或 IP:端口"。
3. **搬登录**（"把登录方式搬过来"）：`/api/qr/new` → 取二维码（**待确认返回体是 base64 还是图片 URL**，决定用 `<image>` 直接渲染还是先落地文件）→ `/api/qr/status` 轮询 → 成功后 `/api/sessions`。落在我们「我的」页或独立 `login` 页，横屏排版。
4. **搬聊天页**：`chat-list` / `chat-detail` 重排为 800×254（左侧分区栏加「消息」入口；详情页用 `scroller` + 底部输入栏，复用我们已有的六模式输入法组件而非系统键盘）。
5. **落盘用我们的 storage**：注意值必须 `JSON.stringify`（§7.1），别直接搬它的 `setStorage({data: 对象})` 写法。
6. 打包验证：`app.json` 注册新页面 → `npm run build` → 真机试。

### 12.4 待确认清单（动手前先查）

- [x] PC 网关能否直接跑通（Python 版本/依赖是否满足）→ **✅ 已跑通，见 §12.7**
- [x] `/api/qr/new` 返回的是 base64 图还是 URL → **✅ base64 PNG，见 §12.7**
- [ ] 本机 `uname -m`（armv7/aarch64）→ 决定路线 B 是否可行。
- [ ] 它 miniapp 的 `app.js` 里 `import('bridge')` 的作用（是否只是起守护进程）→ 读源码确认：**只是 `daemon.ensureDaemon()` 拉起笔上守护进程**；走路线 A（PC 网关）时**这段不需要**。

### 12.7 路线 A 实测记录（2026-10-04，第 1、2 步已完成）

**① 网关跑通（第 1 步）**

依赖不在系统 Python 里，已单独建 venv（**别用 `C:\Python314`**，`curl_cffi` 要 cp310+abi3 wheel，3.14 装不上）：

```powershell
$gw = "D:\duoshan-pen-源码-20261004\duoshan-pen\dy-gateway"
C:\Users\zhoum\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\python\python.exe -m venv "$gw\.venv"
& "$gw\.venv\Scripts\python.exe" -m pip install -r "$gw\requirements-gateway.txt"
& "$gw\.venv\Scripts\python.exe" -m pip install blackboxprotobuf --no-deps
& "$gw\.venv\Scripts\python.exe" -m pip install Pillow   # ← 清单里漏了，见下
```

- 用 DSH 自带 **Python 3.12.14** 建 venv 成功（`protobuf 7.36.2` / `curl_cffi 0.16.3` 都是预编译 wheel）。
- **⚠️ `requirements-gateway.txt` 漏了 `Pillow`**：`qrcode.make()` → `.save(PNG)` 需要 PIL，
  否则 `/api/qr/new` 一直是 `status=error` / `err=No module named 'PIL'`
  （表现极具迷惑性：接口 200、字段齐全、就是没有二维码）。
- 启动：`& "$gw\.venv\Scripts\python.exe" "$gw\gateway.py"`（默认 `0.0.0.0:8090`）。
- `/api/ping` → `{"ok": true, "app": "dy-gateway", "version": "1.0.0", "logged_in": false, "uname": "", "uid": 0, "wss": false, "uptime_s": 22}` ✓
- `/api/status` → `{"logged_in": false, "uname": "", "uid": 0}` ✓

**② `/api/qr/new` 返回体结构（用户要的答案）**

**是 base64 PNG，不是图片 URL** → 笔上直接 `<image :src="'data:image/png;base64,'+qr_png_b64">`，不用落地文件。

```json
{ "status": "generating", "qr_png_b64": "", "login_status": "", "err": "" }
```

四个字段固定都在（`/api/qr/status` 同构）。**关键是异步**：

| 时点 | status | qr_png_b64 | login_status | 含义 |
|---|---|---|---|---|
| `GET /api/qr/new` 首次 | `generating` | `""` | `""` | 起登录线程，**码还没算好** |
| 轮询 `/api/qr/status` ≈2s 后 | `waiting` | 非空(~4.6KB base64 / 3439B PNG / 850×850) | `new` | 可以扫了 |
| 手机扫码后 | `waiting` | 不变 | `scanned` | 等手机确认 |
| 确认后 | `confirmed` | `""` | `confirmed` | 成功，**且额外多返回 `uname`** |
| 失败 | `error` | `""` | `error` | 看 `err` |
| 已登录时再打 `/api/qr/new` | `confirmed` | — | — | 只回 `{status,uname}`，**没有后三个键** |

→ 所以**不能只调一次 `/api/qr/new` 就等图**，必须轮询；且 `qr_png_b64` 为空时不能当失败（`generating` 是正常中间态）。

**③ 传输层已移植（第 2 步）**

- 新增 `src/services/chat-api.js`（ESM + Promise + 复用 `jsapiHttpRequest`，细节见其文件头注释）；
  `src/config.js` 加 `CHAT_GATEWAY_DEFAULT` / `CHAT_GATEWAY_PORT=8090` / `CHAT_API_TIMEOUT_MS`。
- 地址规范化 `normalizeGatewayAddr()`：只填 IP → 补 `:8090`；容忍 `http://`、路径、空格；端口越界/非 ASCII 一律拒绝。
- 落盘走我们的 storage JSON 契约（`jsapiStorageGet/Set`），**没有照搬它 `setStorage({data:对象})` 的写法**。
- 网关上没实现 `/api/sms/send|submit`（源码里没有这两个路由），故未封装。

**④ 顺手挖出并修掉的 3 个 libjsapi 既有 bug**（都不在多闪代码里，是**本工程**的问题）

1. **`jsapiHttpRequest` 把 `method`/`data` 丢了**：`attempts.push({label,url,headers,relayMeta})` 没有带 `method`/`data`，
   于是 **所有请求都退化成 GET、POST body 被静默丢弃**。此前全项目只用 GET，所以一直没暴露；
   多闪 `/api/send`、`/api/rename`、`/api/read` 全是 POST，必然中招（实测网关回「参数错误」）。
2. **原生通道没带 `Content-Length`**：`gateway.py` 的 `do_POST` 用 `int(headers.get('Content-Length') or 0)` 决定读多少字节，
   缺这个头 → `read(0)` → body 变 `{}` → 网关报「参数错误」。已按 **UTF-8 字节数**补上（中文 3 字节/字，不能用 `String.length`）。
3. **剥壳对网关响应判断错误**：网关响应经真机原生层同样是 `{result:"{…ok/status…}"}`，
   剥壳必须**剥掉这一层**；曾一度按「result 里像业务体就不剥」写反，导致页面拿到 `undefined` 的 `ok/status`。
   现逻辑：`{result:"<字符串>"}` 一律是包装层（`result` 非字符串则不算）。

**⑤ 验证**

- `npm test` → **70 PASS / 0 FAIL**（原 56，新增 14 条：地址规范化 4 + 持久化 1 + 剥壳 3 + need_login 1 + POST body/头 3 + …）。
- 真网关端到端（`.temp/chat-live-check.mjs`，Node 真发请求 + 按真机契约包 `{result:"…"}`）→ 全 PASS：
  ping/status/qr/log/sessions(need_login)/send(need_login)/rename(POST 真生效)/read(POST 真生效)/log 29 行。
- `npm run build` → 打包成功（`8001790389478283.1_0_0.amr`，6.3MB）。

**⑥ 第 3 步：新的多闪扫码登录页（2026-10-04 追加）**

- `npm test` → **76 PASS / 0 FAIL**（再增 6 条：二维码 data URL 2 + 地址校验 2 + no_gateway 1 + 主机名放行 1）。
- 模拟器横屏实测通过，细节与踩坑记录见 **§12.8**。
- `src/services/chat-api.js` 的地址校验**收紧**了：纯数字+点的写法必须是合法 IPv4，
  否则 `192.168.1`（少打一段）会被静默补成 `http://192.168.1:8090` 存下来，之后只表现为「连不上」，
  用户看不出是地址打错。含字母的主机名照旧放行（局域网用电脑名也常见）。


### 12.5 本机环境已核查（2026-10）

- **Python 可用**：`C:\Python314\python.exe`（3.14.7）。⚠️ 依赖里有 **`curl_cffi`**（TLS 指纹，登录必需），3.14 很可能没有预编译 wheel → 优先用 **3.11/3.12**，或 DSH 自带 Python（`load_workspace_dependencies` 可拿路径）。
- 网关依赖清单（`dy-gateway/requirements-gateway.txt`，**该文件是 GBK 编码**，读取按 §2 的规则）：
  `protobuf>=5.27 loguru qrcode requests websocket-client curl_cffi aiofiles beautifulsoup4 cryptography ecdsa python-dotenv retry`
  ＋ 单独安装 `blackboxprotobuf --no-deps`（文件头注释说明的顺序：先装本文件，再装它）。
- 源码位置：`D:\duoshan-pen-源码-20261004\duoshan-pen\`
  - `miniapp/src/utils/{api.js(4.5KB),config.js(2.2KB),daemon.js(3.2KB)}` ← 要搬的传输层
  - `miniapp/src/pages/{index,chat-list,chat-detail}` ← 要搬并重排的页面（竖屏 750×1600 → 横屏 800×254）
  - `dy-gateway/gateway.py`（23.5KB，`ThreadingHTTPServer`，监听 `0.0.0.0:8090`，环境变量 `DY_GATEWAY_PORT` 可改端口）
  - `README.md`（4KB）＝安装/自启/FAQ；`安装多闪到词典笔.bat`、`启动多闪守护.bat`＝真机部署脚本

### 12.6 建议的第一批动作（新会话从这里开始）

1. `python gateway.py` 起网关 → `curl http://127.0.0.1:8090/api/ping`；再打 `/api/qr/new` **记录返回体结构**（base64/URL）与 `/api/status`。
2. 读 `miniapp/src/utils/api.js` + `config.js`，把传输层移植为 `src/services/chat-api.js`（复用 `jsapiHttpRequest`；**真机返回 `{result:"…"}` 要剥壳**；地址默认值改成 PC 网关，UI 保留"只填 IP 或 IP:端口"）。
3. 做登录（横屏）：`/api/qr/new` → `<image>` 显示二维码 → 轮询 `/api/qr/status` → 成功后 `/api/sessions`。
   **✅ 已完成（2026-10-04），但按用户要求"保留原有扫码登录页、另开一个"**：
   - 原抖音扫码弹层（index 页 `openLoginQr`，`loginQr` 弹层）**原封未动**；
   - 新增独立页 `src/pages/chat-login/`（已注册进 `app.json`），首页「我的」里加了入口「多闪扫码登录」。
   - 页面结构：顶栏（标题 + 网关状态点 + 检测/改地址）｜左侧二维码盒 174px｜右侧状态文案 + 获取二维码/返回；
     「改地址」是整屏覆盖的**应用内数字键盘**（0-9 . : + 粘贴/退格/保存/取消），因为笔上只有原生 `<input>` 能唤起系统键盘、
     而 IP 只需要数字，自建键盘比 PinyinIme 小得多。粘贴读的是 PinyinIme 那个应用内剪贴板（`douyin_ime_clipboard`）。
   - 二维码直接 `data:image/png;base64,` 给 `<image :src>`（**不用落地文件**）。
   - 登录成功后尝试跳 `chat-list`；该页还没做，所以会留在本页显示「已登录」并提示"会话列表页待做"，不报错。
4. 重排 `chat-list` / `chat-detail` 到 800×254，左分区栏加「消息」入口，输入用现成的 `PinyinIme.vue`。
5. `app.json` 注册页面 → `npm run build` → `npm test` → 真机验证。

### 12.8 模拟器横屏预览的正确姿势（踩过坑，别再试错）

想在模拟器里看某个**非首页**的页面（例如 `chat-login`）：

- 改 `src/app.json` 的 pages 顺序**没用** —— 启动页不是按 app.json 顺序定的，实测仍 `launchPage(index)`。
- ✅ 正确做法：改 **`package.json` 里的 `simulator.page`**（默认 `""`），填页面名如 `"chat-login"`，CLI 会把它传给 appx。
  验证完记得还原成 `""`。
- 模拟器 `resources/cfg.json` 的 `screen` 要改成 **800×254** 才是横屏（验证完还原成 254×800）。
- 截屏后**别移动鼠标/别让别的窗口抢焦点**：模拟器有左滑返回手势，鼠标一动就把你刚进的页 pop 掉了
   （日志里表现为 `LeftSwipeBackGesture Start` → `navToPage(index)`）。用 `PrintWindow` + `ClientToScreen` 精确定位点击。
- 点击坐标要用 **CSS 像素**：模拟器窗口 806×283、client **正好 800×254**、client 原点在屏幕 (50,50)（dpi=96，1:1）。
- ⚠️ 模拟器的 libcurl **没有 https**（`Protocol "https" not supported`），所以模拟器里任何 https 接口都会失败 ——
  这是既有的已知情况（真机固件自带 TLS），**不代表新代码有问题**。
- ⚠️ 模拟器里 `getAppDataDir failed, no package installed`，手改 `data/mini_app/sharedpreferences/app1/preferences.json`
  灌地址**不生效**；要在页面上用键盘输入再保存。

**已验证（模拟器实测截图）**：800×254 布局无溢出 · 数字键盘输入正确累加 · 保存后地址生效（`http://87:8090`）·
网关连不上时状态点变红 + 显示「连不上」与具体错误文案。**未验证**：真机上二维码能否被手机扫到、
真实抖音账号扫码登录（需用户拿手机扫）。

## 11. 会话中已交付的改动（累计）

删底部导航栏（改左侧竖排分区栏）· 全量去 emoji（头像/占位改作者首字）· 横屏 800×254 重排（含 254px 高适配、拼音键盘缩小）·
接入原生播放器与横屏播放页 · 点视频自动解析并跳播放 · 视频条目「按需解析 + 6 小时缓存 + 串行防限流」· 导入视频持久化 ·
手机号登录（网页端 passport）· 粘贴 Cookie 登录 · Cookie 清洗与防泄露（第三方域名不带 Cookie）· 登录态 iteminfo 通道 ·
storage JSON 契约修复 · ttwid 刷新 · 版本号 1.0.0。

**2026-10-04（多闪整合 · 第 1、2 步）**：跑通路线 A 的 PC 网关（含补装 Pillow）· 记录 `/api/qr/new` 为 **base64 PNG 且异步生成** ·
移植传输层 `src/services/chat-api.js` + config 网关地址 · 修掉 `libjsapi` 三个既有 bug（**POST 的 method/data 被丢**、
**原生通道缺 `Content-Length`**、**网关响应剥壳判反**）· `npm test` 70 PASS / 0 FAIL。

**2026-10-04（多闪整合 · 第 3 步）**：**保留**原抖音扫码登录弹层不动，另开独立页 `src/pages/chat-login/`（已注册 + 「我的」页有入口）·
二维码走 `data:image/png;base64` 直接给 `<image>` · 应用内数字键盘改网关地址 · 地址校验收紧（拒绝少打一段的 IP）·
模拟器横屏 800×254 实测通过 · `npm test` **76 PASS / 0 FAIL**。踩坑与模拟器正确用法见 §12.8。

**2026-10-04（主主页 / 启动页）**：appid 末尾 82→83（5 处同步）· 新增**主主页**（`pages/index/index`，启动页）带
「笔上抖音」「今日头条」两个入口卡片 + 三边登录态 · 原抖音主页**整体迁移**到 `pages/douyin/douyin`
（迁移保真：与原文件仅差 `name`/返回按钮 43 行）· 抖音页 rail 顶部加「返回」回主主页 ·
模拟器实测：主主页渲染正常 → 点入抖音 → 返回主主页，整条链路通。

**2026-10-04（今日头条 · 第 4 步）**：新增 `src/services/toutiao-api.js` + `src/pages/toutiao/`，主主页「今日头条」按钮已接通 ·
**观看＝读正文**（`RENDER_DATA` → `articleInfo.content`，实测 2000~4400 字）· 热榜 50 条 / 推荐 feed 分页 ·
点赞/历史用独立 `toutiao_*` storage · 二维码登录**复用现成的字节统一账号 SSO**（只加了 `requestLoginQr({hint})` 文案参数）·
**视频直链确认做不了**（字节混淆 JS VM，与 `a_bogus` 同类墙）· 修掉两个真 bug：文章页 302 不跟随、「我的」页与列表重叠 ·
`npm test` **95 PASS / 0 FAIL**。详见 §12.10 / §12.11。

**2026-10-04（今日头条 · 验收收尾）**：**「观看」阅读视图已在模拟器截图验收通过**（标题/作者/时间/正文/点赞/返回列表）·
热榜与推荐两个列表 + 封面图（走 `relayAssetUrl`）均确认 · 新增 `options.group` 深链（供 App 内跳转）·
记录两条验收踩坑：`simulator.page` **只能传纯页面名**（带 `?query` 会白屏）、`.falcon_\libs\*.so` 被僵尸模拟器占用会 EBUSY ·
临时改动（API_RELAY / simulator.page / cfg.json / prefs）已全部还原。
用户反馈：**点赞与登录可用** ✅。**仍未点验**：历史的交互。

**2026-10-04（抖音官方 web 视频流 ★）**：找到并接入**唯一能"刷视频"的源**
`www.douyin.com/aweme/v1/web/tab/feed/`（只需 ttwid，**不需要 a_bogus**）·
摸清两大坑：**该 feed 无游标**（靠 `refresh_index` 反复调累积，8 次得 39 条去重）、
**`play_addr` 里的 douyinvod 直链恒 403**（六种组合都试过），能播的是 `/aweme/v1/play/?video_id=<uri>`（302 → 200 video/mp4）·
`src/services/douyin-api.js` 新增 `fetchDouyinWebFeed()` / `douyinPlayUrl()`，`video.js` 把官方视频流放到信息流最前 ·
`npm test` **103 PASS / 0 FAIL**（+8 条，含"不得把 CDN 直链塞进 playCandidates"的防回归断言）· `npm run build` 通过 ·
详见 **§13**。

**2026-10-04（真机 open-failed 修复）**：真机点开视频报 `open-failed`，path 是那个 107 字节的 `/aweme/v1/play/` 入口。**根因**：该入口 302 的落点 douyinvod CDN **要求带 Referer**，而设备 FFmpeg 跟 302 时不带 → 403。
（PC 上六种组合实测钉死：无头 → 200；**只带 UA → 403**；带 Referer → 200。直链 CDN 六种组合全 403，不可用。）
**修法**：① relay 新增 `followUpstream()`（跟最多 3 跳、每跳保留 Range 并给抖音系域名补 Referer）；
② `native-player.js` 新增 `needsRelay()`/`relayPlayableUrl()`，跳板入口优先走中转；
③ 播放页直连失败时**自动改用中转重试一次**。
实测 `relay?url=<play入口>` → **206 video/mp4**，带 `content-range`（seek 可用）。

**2026-10-04（免中转方案 · 重要）**：用户追问"如何不用中转"，重查后发现**中转其实不是必需的**。
真因是**落点 CDN 主机每次随机**（部分要求 Referer、部分不要求），所以**换入口重试**即可绕过：
`aweme.snssdk.com` 入口单次 81% > `www.douyin.com` 单次 63%，**多入口轮换 → 22/22 = 100%**。
新增 `playUrlCandidates()` + 播放页 `startWithFallback()` 逐个入口试播，成功即止。
**`API_RELAY` 留空也能播**；中转降级为"更稳的兜底"。同时否掉了三条错路（douyinvod 直链全 403、
ratio 并非因果、detail/iteminfo/分享页都不给免 Referer 的地址）。详见 §13.5。
→ **真机播抖音视频必须配 `API_RELAY` 指向 PC 中转**。`npm test` **106 PASS / 0 FAIL**。

**2026-10-04（真机第三/四轮：黑屏排查）**：修完 open-failed 后真机变成黑屏（`play ok ?x?` → 再到
`play FAIL(全部 6 个入口): 模块已打开但无视频流`）。期间提过"模块可能没有 TLS"的假设，
**被随后的网络诊断推翻**（第 1 行 `OK 49 条`、第 11 行 `OK 1280x720` → HTTPS 完全正常）。
又证伪了"`ratio` 参数导致落点变差"。目前**PC 上候选全部 200、设备上全部无流**，
于是加了**诊断第 13 行**用设备自己的 JS 通道实测候选入口，让设备自证。详见 §13.5~§13.7。

**2026-10-04（番茄小说接入）**：主主页加第三个入口「番茄小说」。
摸清并接入番茄三条接口：**书单** `/api/rank/list?type=0|1|2`（26 本去重，封面带签名 ✅）、
**章节表** `/page/<bookId>`（336 章）、**正文** `/reader/<chapterId>`（`chapterData.content`，可连读）；
**登录白捡**（字节统一账号 SSO，`app_name=番茄小说`）。
**硬限制两条**：① 不是每章都有正文（实测 1、5 章可读，2/3/4/6 只有 24 字占位，
且 `needPay`/`isChapterLock` 全是 0/false，**只能按正文长度判**）；
② 正文字体反爬（16% 常用字被换成 PUA 码点，362 字形，**匹配命中率只 ~56%，放弃**，显示为 □）。
**踩到大坑**：`new URL()` 在 **QuickJS 里不存在**，异常被吞 → 封面判定恒 false（头条同 bug，一并修）。
`npm test` **169 PASS / 0 FAIL**。详见 **§14**。

**2026-10-04（番茄下载 + 改名/版本）**：番茄加**离线文本缓存**（"下载"）——
设备无文件 API 且二进制过 native http 会损坏（§9），所以缓存的是**可读章正文文本**，
上限：单章 6000 字 / 每本 40 章 / 总量 300000 字。阅读优先读缓存并标「离线缓存」，目录标「已存」。
**重要修正**：一开始"见锁定章就停"只下 23 章；实测锁定是**分散**的（前 6 章「可读/锁/锁/锁/可读/锁」），
改为**跳过继续找**后下满 40 章 · 24.2 千字。
**改名/版本**：`name = 字节全家桶`、`version = 1.0.2`（产物 `8001790389478283.1_0_2.amr`），
主主页顶栏与右下角显示名称与版本，顶栏补齐四边登录态。
`npm test` **187 PASS / 0 FAIL**。详见 **§14.5**。

**2026-10-04（真机软重启事故 + 修复）**：13.9 为定位黑屏加的"播放前探测"**导致词典笔软重启** ——
它用 JS 的 http 通道 `GET` 视频地址，把二进制灌进了原生字符串通道（§9 早有记录）。
**已删除该做法**（连同诊断第 13 行的媒体探测），改为
**按 CDN 主机黑名单**（`markHostBad` / `orderByHostHealth`）+ 原生播放器自己当探测器；
诊断第 13 行改成非侵入式（只报候选数与坏主机）；单次尝试上限降到 4。
详见 **§13.10**（含"绝不要用 JS 通道读视频字节"的硬约定与回归防线）。

**2026-10-04（头条视频解析 · 查清但做不了）**：把头条视频线彻查一轮。
`playAuthTokenV2` 解出是**字节 VOD 的 AWS SigV4 预签名取播放凭据**（`cn-north-1/vod`，~24h 有效），
`vod.bytedanceapi.com` 的 `GetPlayInfo` 端点**存在且认得该 Action**，但 token 外层是**加密 JWE**，
笔上取不出内层凭据 → `InvalidParameter`。抖音的 `/aweme/v1/play/` 对头条 vid **404**（不通用）。
→ 与 `a_bogus` 同一类墙，**需要真浏览器环境产出凭据**。本次只把页面上的提示说清楚。详见 **§13.8**。

## 13. 抖音官方 web 视频流（2026-10 接入 · **这是目前唯一能"刷视频"的源**）

### 13.1 接口（只需 ttwid，**不需要 a_bogus 签名**）

```
GET https://www.douyin.com/aweme/v1/web/tab/feed/?device_platform=webapp&aid=6383&channel=channel_pc_web&count=10
    Header: UA + Referer: https://www.douyin.com/ + Cookie: ttwid=…
→ { aweme_list:[…], has_more:1, status_code:0 }
```

**已实测可用**（`.temp/probe-dy-feed.mjs` / `probe-dy-accum.mjs` / `probe-dy-final.mjs`）。顺带确认同样免签名的另外两个：

| 接口 | 结果 |
|---|---|
| `aweme/v1/web/aweme/detail/?aweme_id=<id>` | ✅ `aweme_detail`（单条详情，status_code=0） |
| `aweme/v1/web/hot/search/list/` | ✅ 抖音热榜（web 版） |

仍然不可用的（别再试）：`iteminfo` → `status_code=11110`；`hotsearch/billboard/aweme/` → 空 `aweme_list`；
`www.douyin.com/aweme/v1/web/aweme/detail/` 在**未带 ttwid** 时 403。

### 13.2 两个必须知道的坑

**① 这个 feed 没有游标，一次只回 1~6 条**

返回里 `has_more=1`，但 **`max_cursor` / `min_cursor` / `cursor` 全部是 `undefined`** ——
没法用游标翻页。**但反复调用会不断给新内容**：打 `refresh_index=0..7` 共 8 次，
累积**去重后 39 条**。所以 `fetchDouyinWebFeed()` 是**并发打 6 次 + 按 aweme_id 去重**。

**② `play_addr.url_list` 里的 douyinvod CDN 直链恒 403 —— 千万不要用**

实测该数组前两项（`v26-web-prime.douyinvod.com` / `v11-web-prime.douyinvod.com`）：
**http/https、带不带 Referer、带不带 Range、PC/移动 UA —— 六种组合全部 403**。

能用的是**同一数组里的跳转入口**：

```
https://www.douyin.com/aweme/v1/play/?video_id=<play_addr.uri>&line=0&ratio=1080p&aid=6383
→ 302 → CDN → 200 video/mp4   （实测 4 种参数写法都通，带不带 Referer 都通）
```

**所以绝对不要把这些 CDN 直链塞进 `playCandidates`**：
`nativePlayableUrl()` 的优先级是「先挑直链 CDN」（见 `services/native-player.js`），
塞进去它就会选中一个 403 的地址，反而把能播的入口挤掉。本实现里 `playCandidates: []`。

### 13.3 接进信息流

`src/services/douyin-api.js` 新增：

- `DOUYIN_WEB_TAB_FEED` / `douyinPlayUrl(uri)`（纯函数，可单测）
- `fetchDouyinWebFeed()`：并发 6 次 + 去重，只保留带 `video.play_addr.uri` 的条目

`src/services/video.js` 把它放在信息流**最前面**，新顺序：

```
官方 web 视频流（自带 playUrl，点开即播）
  → 用户导入的真视频
  → 可解析的视频条目（video-link，点开时才解析分享页）
  → 抖音热榜话题（没有视频文件）
```

`dataSource` 现在形如 `官方视频流 18 条 + 1 条视频链接 + 抖音热榜`。

### 13.4 验证

- `npm test` → **0 FAIL**（稳定跑 3 次确认；PASS 数在 94~103 之间浮动，原因见下）
  > ⚠️ 这条是**当时**的记录，PASS 数早已增长。**当前真实状态见 §0.2**（185 PASS / 0 FAIL）。
  - 其中一条是**防回归的关键断言**：官方视频流**不得**把 `douyinvod` 直链放进 `playCandidates`
  - **测试卫生（本次一并修的）**：凡**依赖第三方接口当时可用性**的断言改成 `NOTE` 不算 FAIL
    （沿用本文件既有的"分享页限流只记 NOTE"约定）。此前它们会随机变红：
    例如热榜接口抖一下 → `hot-items` 为空 → 按下标取到的 `first` 落到别的源上；
    或官方视频流没数据 → `dataSource` 断言失败。现在**硬断言只留纯函数/契约类**
    （`douyinPlayUrl`、剥壳、storage 契约…），网络类只做信息记录。
- 真接口联调：热榜 50、feed 分页、正文 4239 字（头条）；抖音 web feed 累积 39 条去重、抽 3 条验证 `200 video/mp4`
- `nativePlayableUrl` 对 `/aweme/v1/play/` 入口**原样透传**（已单测确认），302 交给 FFmpeg
- `npm run build` 通过

**⚠️ 真机 open-failed 及修法（2026-10 真机回报，已修）**

真机上点开视频报 `play FAIL: open-failed`，path 正是那个 107 字节的 `/aweme/v1/play/` 入口。根因定位：

| 请求形态 | 结果 |
|---|---|
| `/aweme/v1/play/…` **原样（无任何头）** | hop1 302 → hop2 **200 video/mp4** |
| `/aweme/v1/play/…` **只带 UA、不带 Referer** | hop1 302 → hop2 **403** ← **设备 FFmpeg 就是这个情形** |
| `/aweme/v1/play/…` 带 UA **+ Referer** | hop1 302 → hop2 **200 video/mp4** |

即：**302 的落点 douyinvod CDN 要求带 Referer**，而**设备的 FFmpeg 跟 302 时不会把 Referer 带过去** → 403 → `open-failed`。

**试过但不可行的方案**：直接改用 `play_addr.url_list` 里的 douyinvod 直链 ——
实测 http/https、带不带 Referer/Range、PC/移动 UA **六种组合全部 403**（那些直链是签名且过期的）。

**采用的修法（两条腿）**：

1. **中转补齐头 + 跟跳转**（`scripts/relay-server.mjs`）：
   - 新增 `followUpstream()`：自动跟随最多 3 跳 302/301，**每跳都保留 Range 并补 Referer**；
   - 抖音系域名（douyin/iesdouyin/snssdk/amemv/**douyinvod**/douyinpic/…）自动加 `Referer: https://www.douyin.com/`。
   - 实测：`relay?url=<play入口>` → **206 video/mp4**，`content-range: bytes 0-200000/227968170`（**Range 正常 ⇒ seek 可用**）。
2. **路由 + 兜底重试**（`src/services/native-player.js` / `src/pages/player/player.vue`）：
   - 新增 `needsRelay(url)`：认出 `/aweme/v1/play/` 是"跳板入口"；
   - `nativePlayableUrl()` 对跳板入口**优先走中转**（没配中转才原样试）；
   - 新增 `relayPlayableUrl(url)`；播放页直连失败时**自动改用中转重试一次**（`relayTried` 防递归）。

**✅ 不用中转的办法（2026-10 实测找到，已实现）**

真机 `open-failed` 的**根因不是"必须中转"**，而是：`/aweme/v1/play/?video_id=…` 会 302 到
douyinvod 的 CDN，而**落点主机每次不同** —— 有的不带 Referer 就 200 video/mp4，有的必须带（403）。
设备的 FFmpeg 跟 302 时不带 Referer，所以**碰上后者就失败**。

于是解决思路是**换入口重试**（每次重新 302 = 重抽落点主机），而不是架中转。实测数据：

| 方案 | 无 Referer 成功率（22~28 条样本） |
|---|---|
| `www.douyin.com/aweme/v1/play/…` 单形态一次 | 10/16 ≈ **63%** |
| `aweme.snssdk.com/aweme/v1/play/…` 单形态一次 | 13/16 ≈ **81%**（**明显更稳**，换成这个域名落点不同） |
| **多形态轮换（3 入口 × 最多 2 轮）** | **22/22 = 100%** |

成功所需尝试次数分布：第 1 次 14 条、第 2 次 4 条、第 3 次 1 条、第 6 次 3 条。

**实现**（`src/services/native-player.js` + `src/pages/player/player.vue`）：

- 新增 `playUrlCandidates(url, candidates)`：从 `/aweme/v1/play/?video_id=<uri>` 抠出 `uri`，
  生成**同一视频的多个等价入口**（去重）：
  1. `aweme.snssdk.com/...?ratio=720p` ← 实测最稳，排第一
  2. `aweme.snssdk.com/...?ratio=540p`（换个 ratio 会重抽落点）
  3. `www.douyin.com/...?ratio=720p&aid=6383`
  4. 原始地址
  5. 若配了中转，再兜一层 relay
- 播放页新增 `startWithFallback(candidates, resumeMs)`：**逐个入口试播**，成功即止；
  重试期间不弹失败 toast，全部试完才提示一次。
- `douyin.vue` 把 `item.playCandidates` 一并传给播放页（`navTo` 与 `setPendingPlay` 两条路）。

→ **`API_RELAY` 留空也能播**。中转只是"更稳的兜底"，不再是必需项。

### 13.5 黑屏（play ok 但无画面）及修法（2026-10 真机第二轮）

修完 open-failed 后，真机变成：**不报错了，但全黑**，屏上诊断是

```
screen=800x254(cfg 254x800 dir270) | play ok ?x? rate=1 vol=70
```

`play ok ?x?` 说明原生模块**接受了地址**，但 `videoW/videoH` 为空 → 没有可用视频流。

**排查过程（以下都已排除，别再重复查）**：

- **不是编解码器问题**：取前 512KB 解析容器，得到 `ftyp=isom` + **`avc1` 命中 2 次** +
  `avcC/esds` —— 即 **H.264 + AAC**，与设备上"已验证能播"的格式一致
  （本机没有 ffprobe，是手写解析 MP4 的 `stsd`/配置盒判断的）。
- **不是地址形态问题**：`snssdk` 与 `douyin` 两个入口取的流都是 H.264 MP4。
- **注意**：期间还看到 `getaddrinfo ENOTFOUND v95-bjb-mc-cold.douyinvod.com` ——
  douyinvod 那批 CDN 主机**本身就不稳定**（连 DNS 都可能解析不出来），这正是必须轮换入口的原因。

**两个修法（都在 `src/pages/player/player.vue`）**：

1. **重试前先 `stop()`** ★ 最可能的元凶：
   上一个入口 open 失败后**直接** open 下一个，模块会返回 `ok:true` 但几何为空
   （正是 `play ok ?x?` 这个现象）。现在每次换入口前先 `bridge.stop()` 清状态、等 350ms 再 open。
2. **`ok` 但无尺寸 → 当软失败**：
   报 `ok` 不一定真能播。没拿到 `videoW/videoH` 时先等 600ms 用 `bridge.status()` 复查一次，
   仍然没有就判软失败，**继续试下一个入口**（不再停在黑屏上）。

另外把候选扩到 **7 个**（snssdk 的 720p/540p/480p/360p + douyin 的 720p/540p + 原地址；
配了中转再加一个）——多一个 ratio 就多一次重抽 CDN 主机的机会。

全部入口都失败时，屏上 `dbg` 与 `errorText` 都会显示
`play FAIL(全部 N 个入口): <原因>`，方便下次真机直接读原因。

**⚠️ 本轮改动尚未在真机验证**（我这边跑不了笔上的 `.so`）。预期看到 `play ok 1080x1920` 之类
**带尺寸**的输出；若仍是 `?x?`，把 `dbg` 那行截图给我继续查。

### 13.6 真机第三轮：`play FAIL(全部 6 个入口): 模块已打开但无视频流` → TLS 假设（**已被 13.7 推翻，仅存档**）

真机第三轮报 `play FAIL(全部 6 个入口): 模块已打开但无视频流`。
当时据此推测"模块没有 TLS"，并做了 `resolvePlainHttpUrl()`（解析 302 落点 → 换明文 http）。
**这个推测是错的**（见 13.7 的诊断：第 1/11 行都证明 https 正常）。
→ 该函数**已于 §15.1 删除**（它本身就对视频地址发 GET，违反禁令）。
下面这两条实测事实仍然成立，但**已无用途**（既然 TLS 正常，就不需要明文 http 那条路）。

仍然有效的两条实测事实（留档）：

| 落点 CDN | https 无 Referer | **http 无 Referer** |
|---|---|---|
| `v95-aw-cold.douyinvod.com` | 200 video/mp4 | **200 video/mp4** |
| `v5-gz2-colda.douyinvod.com` | 200 video/mp4 | **200 video/mp4** |

→ 落点 CDN **明文 http 也能播且不需要 Referer**（备用手段）。
另外：JS 通道**能否读到 302 的 `Location` 取决于固件外层形态** ——
外层带 `header` 能读到，只有 `result` 读不到（已用桩验证）。

### 13.7 真机第四轮：诊断推翻 TLS 假设，改为设备端自证

**我上一条判断（`13.6` 里"模块很可能没有 TLS"）被真机诊断直接推翻**：

```
1 直连热榜接口: OK 49 条
0 运行模式: 直连 https
11 原生 https 直连播放: OK 1280x720 → 固件 FFmpeg 自带 TLS，无需中转
```

→ **设备解 https 完全正常**，第 11 行那个探针用的**正是** `/aweme/v1/play/?video_id=…` 形态。

**又排除了一个假设**：以为是我多写了 `ratio=` 导致落点 CDN 变差。拿同一个 uri 对比测：

| 写法 | 结果 |
|---|---|
| `?video_id=<uri>`（探针写法，无参数） | 200 video/mp4 |
| `?video_id=<uri>&ratio=720p&line=0` | 200 video/mp4 |
| `douyin.com` 的同两种 | 200 / 403（主机差异） |

→ **`ratio` 不是原因**；PC 上各写法都能 200。

**当前矛盾**：**PC 上候选地址全部 200 video/mp4，设备上却全部 `ok 但无视频流`。**
既然盲改已经错了两次，这轮不再猜 —— **让设备自己报告**。

**新增诊断第 13 行**（`src/pages/douyin/douyin.vue`）：用**设备自己的 JS 通道**
去请求前 3 个候选播放入口，逐条打印
`OK/失败 + 耗时 + 内容长度 +（异常时的内容开头）`。

判读方法：

| 第 13 行结果 | 结论与下一步 |
|---|---|
| 三个候选都 `OK` 且拿到视频字节 | 设备取得到 → 问题在**原生模块**（编码/容器/参数），往那边修 |
| 三个候选都 `失败`/超时 | 设备取不到这些 URL（DNS/路由/风控）→ 要换 CDN 主机或入口 |
| 混着（有的 OK 有的失败） | 按可用的那条挑入口，把失败的剔掉 |

→ 拿到第 13 行后就能确定方向，不必再试错。

### 13.8 头条视频解析：又一轮尝试后的最终结论（2026-10）

用户要求"增加头条视频解析"，于是把头条视频这条线**再彻查了一遍**。结论：**仍然做不了**，
但这次把**为什么做不了**钉到了具体机制上（以前只知道"有个 JS VM 墙"）。

**头条视频条目手里有什么**（都可拿到）：

| 字段 | 值 |
|---|---|
| `videoId` | `v02d16g10004daubifnog65h8qgn1lrg`（与抖音 vid 同格式） |
| `videoDuration` | 174（秒） |
| `posterUrl` | 封面图 |
| `playUrlList` | **恒为 `null`** |
| `playAuthTokenV2` | 1072 字符，**单段 JWE（加密 JWT）** |

**逐条试过并全部失败的路**：

| 尝试 | 结果 |
|---|---|
| 抖音/字节 的 `/aweme/v1/play/?video_id=<头条vid>` | **404** —— 该入口不认头条 vid（换域名也一样） |
| `/video/url/v1/`、`/video/url/v2/`（带 video_id、带 token） | 200 但返回 **`_$jsvmprt` 混淆 JS VM**（72914 字节），非 JSON |
| `/api/video/play/`、`/api/pc/video/`、`/api/video/<vid>/` | 404 |
| 详情页 HTML 里搜 mp4/m3u8/douyinvod | **0 条** |
| `vod.bytedanceapi.com/?Action=GetPlayInfo&Version=2019-03-15` | **端点存在**（返回 RequestId/Action），但报 `InvalidParameter` —— 缺 `PlayInfoToken` |

**`playAuthTokenV2` 解出来是什么**（本轮最有价值的情报）：payload 是

```
{"GetPlayInfoToken":"Action=GetPlayInfo&Version=2019-03-15
  &X-Amz-Algorithm=AWS4-HMAC-SHA256
  &X-Amz-Credential=AKLTNjZjNjM4YWJjYmE4NGY1ODkwZmY5NDY1MTlkZjdkNmM%2F20261004%2Fcn-north-1%2Fvod%2Faws4_request
  &X-Amz-Date=20261004T120646Z&X-Amz-Expires=87840&X-Amz-NotSignBody=…"}
```

即**字节 VOD 的 AWS SigV4 预签名取播放信息凭据**（`cn-north-1/vod`，有效期 ~24h）。
**只要能取出这段 token，拿去 `vod.bytedanceapi.com` 的 `GetPlayInfo` 就能换到地址** ——
但外层 JWE 是**加密**的，没有密钥解不开。

→ **卡点是一个加密 token，不是"没有接口"。** 与抖音 `a_bogus` 同一类墙：
都需要**真浏览器/WebView 级环境**跑官方 JS 才能产出凭据，笔上的 QuickJS 做不到。

**本次实际改动**（`src/pages/toutiao/toutiao.vue` 的 `openItem`）：点开视频条目时明确提示
「这是视频条目：头条视频直链要加密 token，取不到（时长 X，该条也没有文字正文）」，
而不是丢一句"取正文失败"让人以为坏了。图文条目照常可读。

**以后要突破，方向只有一个**：在 **PC 上**用真浏览器环境跑通头条视频解析
（产出 PlayInfoToken，或用第三方解析服务），PC 侧解析好、把**可播地址**交给设备 ——
即复用我们已有的"PC 中转/解析"模式，而不是让笔去算 token。

### 13.9 真机第五轮：诊断第 13 行定位到真正根因 —— **落点 CDN 主机是坏的**

诊断第 13 行（设备端 JS 探针）给出决定性证据：

```
13 候选1 aweme.snssdk.com/aweme/v1/play/… OK 170ms len=90  内容「{"error":3,"result":{"errorMes
13 候选2 aweme.snssdk.com/aweme/v1/play/… OK 209ms len=83  内容「{"error":3,"result":{"errorMes
13 候选3 aweme.snssdk.com/aweme/v1/play/… OK 280ms len=90  内容「{"error":3,"result":{"errorMes
```

**设备 170ms 就拿到响应了** —— 既不是 TLS、也不是网络、更不是超时。
它拿到的是 **90 字节的 `{"error":3,…}` 错误 JSON，不是视频**。

**PC 侧复现出根因**：抖音会把某些视频解析到**已经坏掉的 CDN 主机**：

| uri | 302 落点主机 | DNS |
|---|---|---|
| 探针那个 id（设备已验证可播） | `v9-v2-mps-cdn.douyinvod.com` | ✅ 106.227.43.44 |
| feed#1 | `v26-cold-y` / `v95-aw-cold` | ✅ 有解析 |
| feed#2 | `v95-bjb-mc-cold.douyinvod.com` | ❌ **DNS ENOTFOUND** |

→ **同一个入口、同样不带参数，落点主机不同，命运就不同**：坏主机回 error:3，
播放器拿到它自然"打开了却没视频流"。

**修法（本轮）**：`src/services/native-player.js`

- `isErrorBody(text)`：认出"HTTP 200 但内容是 `{"error":N,…}` 的短 JSON" = 播放失败（**不是**视频）；
- **按 CDN 主机黑名单**：`markHostBad(url)` / `orderByHostHealth(urls)` / `badHostList()` ——
  失败过的落点主机沉底，好主机优先（坏主机是主机级问题，实测 `v95-bjb-mc-cold` 连 DNS 都没有）；
- 播放页 `mounted` 先 `orderByHostHealth(list)`，并把已知坏主机写进屏上 `dbg`。

> ⚠️ **这一版最初还加了 `probeCandidates()`（用 JS 通道预探视频地址）——
> 那个做法导致真机软重启，已在 13.10 删除。现在没有 `probeCandidates`。**

### 13.10 ⛔ 真机软重启事故：**绝不要用 JS 的 http 通道读视频字节**

**事故**：13.9 的"播放前探测"上线后，真机点视频 → 屏幕显示"正在查找可用视频" → **词典笔软重启**。

**原因（我写的代码）**：`probeCandidates()` 用 `jsapiHttpRequest` 去 `GET` **视频地址**，
等于把**视频二进制灌进原生 http 的字符串通道**。而 HANDOFF §9 早就记过这个坑：

> 实测测试文件 **42% 字节非法 UTF-8**，原生 http 的字符串通道会损坏二进制；
> 要做必须给原生模块加 `download(url,path)`，需 C++ + armv7 工具链。

同一轮我还给诊断加了第 13 行，做的也是同一件危险事（`GET` 视频地址读字节）。
→ **两处都已删除。**

**已改成安全的做法**：

1. **不做任何媒体探测** —— 不 `GET` 视频地址、不读视频字节。
2. **原生播放器自己当探测器**：它 open 失败很快（`ok` 但无尺寸，或 `open-failed`），
   失败时调 `markHostBad(path)` 把该 **CDN 落点主机**记入黑名单。
3. **`orderByHostHealth(candidates)`**：已知坏主机的候选**沉底**（不删，可能只是抖动），
   好主机保持原相对顺序。
4. 诊断第 13 行改成**非侵入式**：只报「候选数量 + 已知坏主机列表」，不发任何媒体请求。
5. 单次播放的尝试上限 `MAX_TRIES = 4`（原候选 7~8 个，太多次 stop/open 既慢又增加原生模块出错风险）。

**代码里的硬约定**（`src/services/native-player.js` 顶部有醒目注释）：

> ⛔ 绝对不要用 JS 的 http 通道去"探测"视频地址 —— 会把二进制灌进原生字符串通道，
> 实测会导致词典笔软重启。坏主机靠原生播放器的失败结果来发现。

**回归防线**：`scripts/test-services.mjs` 对应断言处写明了这个教训，
并有 `isErrorBody` / `markHostBad` / `orderByHostHealth` 的单测
（坏主机沉底、同域不同主机不误伤、排序不丢候选）。

**⚠️ 黑名单是内存级**（本次会话有效），没落盘 —— 先不做，它不是关键路径。

### 13.11 头条封面与评论（2026-10，用户要求补齐）

**① 封面：确诊「只有带签名的图片 URL 可用」**

| 来源 | URL 形态 | 结果 |
|---|---|---|
| 60s 聚合热榜 | `p3-sign.toutiaoimg.com/…?x-signature=…`（**带签名**） | ✅ **6/6 可用** |
| 头条自家 feed | `//p3.pstatp.com/list/190x124/…`（**未签名**） | ❌ **DNS 都解析不出来**（pstatp.com 已废） |
| 头条自家 feed | `http://p3.toutiaoimg.com/list/…`（**未签名**） | ❌ **403** |
| 详情页正文图 | `p*.toutiaoimg.com/…`（未签名） | ❌ 403（详情页里能 200 的**只有站点静态资源** `lf-dw.toutiaostatic.com`） |

试过但**全部无效**的改写：换主机（p1/p3/p6/p9）、换路径（`list`/`origin`/`large`/去掉前缀）、
加 `Referer`（toutiao.com / 文章页 / m 站）、加 `Origin`、加完整浏览器头（`Sec-Fetch-*` / `Accept`）
→ **一律 403**。所以**不是防盗链**，是**未签名就不给**。

**修法**：`toutiao-api.js` 新增 `isUsableCover(url)`（域名白名单 + 要求签名/tplv），
`pickCover()` 挑第一个可用封面，不可用的**直接返回 `''`**；页面在无封面时显示「头」字占位，
而不是去加载一张必然失败的图。

→ 热榜（60s 源）封面**现在能正常显示**；推荐 feed 因为**服务端就不给签名地址**只能显示占位。
**这是数据源限制，不是代码问题。**

**② 评论：线上拿不到 → 改为本地评论**

试过并失败的接口（都记进 `toutiao-api.js` 注释）：

| 接口 | 结果 |
|---|---|
| `/api/comment/list/`（group_id/item_id/offset/count/aid/app_name × PC/移动 UA × 带 Referer） | **恒定 500** |
| `/2/comment/list/`、`/api/comment/v1/list/`、`/api/pc/comment/list/`、`/m.toutiao.com/api/comment/list/` | 404 |
| `/article/comment/...` | 200 但返回 `_$jsvmprt` 混淆 JS VM |
| 详情页 `RENDER_DATA` | 只有 `articleInfo.commentCount`（数字），**没有评论正文** |

→ 与 `a_bogus` 同类：要评论内容必须过签名。

**所以实现的是「本地评论」**（`toutiao_comments`，按 groupId 分组，每条最多留 50 条）：

- 阅读视图里展示本地评论（可逐条删除）；
- 标题行同时显示**头条真实评论总数**（feed 的 `comments_count`）与本地条数，
  并明确标注"头条线上评论需签名，笔上取不到"，**不假装是抓来的**；
- 写评论复用工程现有的 **`PinyinIme`** 组件（六模式、支持中文），不自造键盘。

`npm test` → **139 PASS / 0 FAIL**（新增封面判定 7 条 + 本地评论 11 条）。

**旁证（本轮顺带确认，备用手段）**：302 落点的 CDN **明文 http 也能播且不需要 Referer**
（`v95-aw-cold` / `v5-gz2-colda` 两例都是 200 video/mp4）——
所以 `resolvePlainHttpUrl()` 保留为"多一种候选"，但**它不是本轮问题的解药**
（本轮根因是落点主机坏，不是协议）。

**已排除、别再走的思路**：

- **改用 `play_addr.url_list` 里的 douyinvod 直链** —— http/https、带不带 Referer/Range、
  PC/移动/FFmpeg UA **全部 403**（缺 302 才会补上的路径签名）。
- **换 ratio 让它别要求 Referer** —— 一度看着像因果（`1080p` 403 / `720p` 200），
  但**多样本证伪**：各 ratio 都只有 30~60% 成功；本轮进一步确认真正变量是**落点主机**。
- **猜测"模块没有 TLS"** —— 被诊断第 1/11 行推翻（`OK 49 条` / `OK 1280x720`）。
- **`aweme/v1/web/aweme/detail/`** 给的 `play_addr` 同样是需 Referer 的那种直链。
- **`iteminfo`** 仍 `status_code=11110`（未登录）；**分享页**会被限流。


删底部导航栏（改左侧竖排分区栏）· 全量去 emoji（头像/占位改作者首字）· 横屏 800×254 重排（含 254px 高适配、拼音键盘缩小）· 接入原生播放器与横屏播放页 · 点视频自动解析并跳播放 · 视频条目「按需解析 + 6 小时缓存 + 串行防限流」· 导入视频持久化 · 手机号登录（网页端 passport）· 粘贴 Cookie 登录 · Cookie 清洗与防泄露（第三方域名不带 Cookie）· 登录态 iteminfo 通道 · storage JSON 契约修复 · ttwid 刷新 · 版本号 1.0.0。

**2026-10-04（多闪整合 · 第 1、2 步）**：跑通路线 A 的 PC 网关（含补装 Pillow）· 记录 `/api/qr/new` 为 **base64 PNG 且异步生成** · 移植传输层 `src/services/chat-api.js` + config 网关地址 · 修掉 `libjsapi` 三个既有 bug（**POST 的 method/data 被丢**、**原生通道缺 `Content-Length`**、**网关响应剥壳判反**）· `npm test` 70 PASS / 0 FAIL。

**2026-10-04（多闪整合 · 第 3 步）**：**保留**原抖音扫码登录弹层不动，另开独立页 `src/pages/chat-login/`（已注册 + 「我的」页有入口）· 二维码走 `data:image/png;base64` 直接给 `<image>` · 应用内数字键盘改网关地址 · 地址校验收紧（拒绝少打一段的 IP）· 模拟器横屏 800×254 实测通过 · `npm test` **76 PASS / 0 FAIL**。踩坑与模拟器正确用法见 §12.8。

**2026-10-04（主主页 / 启动页 · 阶段性）**：appid 末尾 82→83（5 处同步）· 新增**主主页**（`pages/index/index`，启动页）带「笔上抖音」「今日头条」两个入口卡片 + 三边登录态 ·
原抖音主页**整体迁移**到 `pages/douyin/douyin`（迁移保真：与原文件仅差 `name`/返回按钮 43 行）· 抖音页 rail 顶部加「返回」回主主页 ·
模拟器实测：主主页渲染正常 → 点入抖音 → 返回主主页，整条链路通。

**2026-10-04（今日头条 · 第 4 步）**：新增 `src/services/toutiao-api.js` + `src/pages/toutiao/`，主主页「今日头条」按钮已接通 ·
**观看＝读正文**（`RENDER_DATA` → `articleInfo.content`，实测 2000~4400 字）· 热榜 50 条 / 推荐 feed 分页 · 点赞/历史用独立 `toutiao_*` storage ·
二维码登录**复用现成的字节统一账号 SSO**（只加了 `requestLoginQr({hint})` 文案参数）·
**视频直链确认做不了**（字节混淆 JS VM，与 `a_bogus` 同类墙）· 修掉两个真 bug：文章页 302 不跟随、「我的」页与列表重叠 ·
`npm test` **95 PASS / 0 FAIL**。详见 §12.10 / §12.11。

**2026-10-04（今日头条 · 验收收尾）**：**「观看」阅读视图已在模拟器截图验收通过**（标题/作者/时间/正文/点赞/返回列表）·
热榜与推荐两个列表 + 封面图（走 `relayAssetUrl`）均确认 · 新增 `options.group` 深链（供 App 内跳转）·
记录两条验收踩坑：`simulator.page` **只能传纯页面名**（带 `?query` 会白屏）、`.falcon_\libs\*.so` 被僵尸模拟器占用会 EBUSY ·
临时改动（API_RELAY / simulator.page / cfg.json / prefs）已全部还原；`npm test` 95 PASS / 0 FAIL，`npm run build` 通过。
**仍未点验**：二维码登录（需手机扫）、点赞与历史的交互。

### 12.9 主主页 / 启动页（2026-10-04）

**结构现状**

```
pages/index/index   ← 主主页（launcher，启动页）
   ├─ 笔上抖音  →  pages/douyin/douyin（原 index 全部内容整体迁来）
   ├─ 今日头条  →  待做（目前按钮点一下只提示"开发中"）
   ├─ 多闪私信登录 → pages/chat-login/chat-login
   └─ 观看历史  → 进抖音页后由其自己打开历史抽屉
```

**为什么主主页放在 `index` 而不是新起一个 `home` 页**

实测结论（§12.8 那条）：**设备启动的是 `index`**，改 app.json 的 pages 顺序**不会**改启动页。
所以把 launcher 做成 `index` 本身最稳。另外为防万一（万一设备按别的名字启动），`app.json` 里
把 `home` 也指向同一个文件 —— `home.js` 只有 133 字节的 re-export（`export { default } from './index.js'`），
所以 `navTo('home'|'index')` 都能进主主页，成本极低。

**迁移方法（可复用的安全姿势）**

2400 行的页面**不要**用 PowerShell 读写文本迁移 —— 我试了一次，中文注释当场变 mojibake
（`// 页面展示前必须设置根组件` → `// 椤甸潰灞曠ず…`），正是 §2 那个编码坑。
正确做法：

1. `Copy-Item` 做**字节级**复制（不经任何文本解码）；
2. 用 `Get-FileHash` 核对 md5 一致；
3. 再用 `edit` 工具做**定点**修改（改 import / 类名 / name / 加返回按钮）。

事后用 `Compare-Object` 比对确认"差异只有我有意改的那 43 行"，迁移保真度可证。

**已实测通过**：主主页 800×254 布局无溢出 · 点「笔上抖音」进抖音页 · 抖音页「返回」回主主页 ·
点「今日头条」显示"开发中"提示（不跳空页）。

### 12.10 今日头条：数据源与登录探测结果（2026-10-04，**实测**）

探测脚本：`.temp/probe-toutiao.mjs`、`.temp/probe-toutiao2.mjs`（`node .temp/probe-toutiao.mjs`）。

**✅ 好消息：一条完全可用的内容通路（未登录）**

| 接口 | 结果 |
|---|---|
| `https://60s-api.viki.moe/v2/toutiao` | **200，50 条热榜**；字段：`title` / `hot_value` / `cover` / `link` |
| `https://www.toutiao.com/api/pc/feed/?category=news_hot&max_behot_time=0` | **200，每页 15 条，未登录可拿**；`has_more` 翻页 |

PC feed 里的可用字段（**没有** `video_duration`/`has_video`，那两条查询串要用别的方式拿）：

```
title, abstract(摘要), image_url/middle_image(封面), source(来源),
source_url('/group/<id>/'), group_id, item_id, comments_count, behot_time(时间), image_list
```

**✅ 观看 = 读正文（这是最终采用的方案，实测可用）**

热榜 `link` 的 SPA 外壳确实抓不到东西，但**文章详情页可以**：

```
https://m.toutiao.com/article/<group_id>/     ← 必须移动端 UA；注意**不要**用 /i<id>/
→ HTML 里 <script id="RENDER_DATA" type="application/json"> 是 **URL 编码** 的 JSON
  decodeURIComponent 后取 articleInfo.content = 完整正文（实测 2000~4400 字，带 HTML 标签）
  另有 title / publishTime / mediaUser(作者) / diggCount / commentCount / posterUrl
```

**⚠️ 两个实测坑（都已在代码里处理，别再踩）**

1. **`https://m.toutiao.com/i<id>/` 会 302 跳**到 `/article/<id>/`，
   而 `jsapiHttpRequest` 与 relay **都不跟随重定向** → 直接抓 `/i` 只能拿到
   131 字节的 `Redirecting to <a href=…>` HTML，然后误报"没有 RENDER_DATA"。
   修法：**直接用规范地址 `/article/<id>/`**，并保留"从跳转页抠 URL 再抓一次"的兜底。
2. `category=video` / `news_video` / `entertainment` / `weitoutiao` 的 pc feed **全部返回空数组**，
   只有 `news_hot`、`media`、以及**不带 category** 能出数据。

**❌ 视频直链：确认做不了（别再试）**

视频条目有 `video_id` 且 `playAuthTokenV2` 非空，但 `playUrlList` 恒为 `null`。
要把 token 换成可播地址必须过字节的**混淆 JS VM**：

- `/video/url/v1|v2/` 返回的是 `_$jsvmprt` 混淆脚本（72914 字节），不是 JSON；
- `/api/video/<vid>/`、`/api/pc/video/play/` 直接 404；
- 移动页 HTML 里 **0 条** mp4/m3u8 直链。

→ 与抖音那边的 `a_bogus` 是同一类墙（§9）。所以**「观看」= 读正文**，
视频条目只标记「视频」+ 展示时长/播放量，点开仍走正文（多数带完整文字）。

**✅ 登录：头条品牌二维码现成可用（已实测）**

```
GET https://sso.toutiao.com/passport/sso/get_qrcode/?service=https%3A%2F%2Fwww.toutiao.com&need_logo=false&need_short_url=false
→ 200, body.data.qrcode = "iVBORw0KGgoAAAANSUhEUgAAAgAAAA..."   ← 直接是 base64 PNG
   body.data.app_name = "今日头条APP"
```

即：**就是抖音侧已经在用的那个字节统一账号 SSO**，但 `app_name` 本来就是「今日头条APP」——
所以"头条二维码登录"**不需要新东西**：`src/services/douyin-auth.js` 的 `requestLoginQr()` 打的
**就是**这个 URL（`service=https%3A%2F%2Fwww.toutiao.com`），`checkLoginQr()` 也照常用。
本次只补了一个 `requestLoginQr({hint})` 文案覆盖参数，好让头条入口显示
「请使用今日头条 APP 扫码登录」而不是默认的抖音文案（同一个 SSO，不同 service = 不同扫码端品牌）。

### 12.11 今日头条页：已交付内容与验证状态（2026-10-04）

**已交付**（`src/services/toutiao-api.js` + `src/pages/toutiao/toutiao.vue`，已注册进 `app.json`）

- 四个分区（左侧 rail，与原抖音页同款版式）：**观看 / 点赞 / 我的 / 历史**；
- 「观看」：热榜（50 条，`切到热榜/切到推荐` 切换）或推荐信息流（15 条/页，`加载更多` 翻页），
  点任意条目 → 右侧变阅读视图（标题+作者+时间+正文滚动 + 点赞/返回列表）；
- 「点赞」：`toutiao_likes` 存**条目快照**（不是只存 id，这样列表能独立渲染）；列表右侧有快捷「赞」；
- 「历史」：`toutiao_history` 去重置顶，上限 100 条；
- 「我的」：登录态、二维码登录/退出、已赞/历史计数、回主主页；
- 登录弹层复用 `requestLoginQr({hint})` + `checkLoginQr` 轮询（2s，连续失败 5 次才停）。
- **独立 storage 前缀** `toutiao_*`，与抖音的 `douyin_*` 完全分开（登出一边不影响另一边）。

**验证状态（诚实版）**

| 项 | 状态 |
|---|---|
| 数据层 vs 真接口（`.temp/toutiao-live-check.mjs`） | ✅ 全 PASS：热榜 50、feed 15+翻页、正文 4239 字 |
| 解析逻辑单测（`npm test`） | ✅ 95 PASS / 0 FAIL（头条新增 19 条断言） |
| 页面在模拟器渲染 + 列表出数据 | ✅ 已截图确认（经 relay 走 https） |
| 「我的」页版式 | ✅ 已确认（并修掉它与列表**叠在一起**的 bug） |
| **「观看」阅读视图** | ✅ **已截图确认**：标题/作者/时间/正文滚动/点赞/返回列表 全部正常 |
| 热榜列表 + 封面图 | ✅ 已截图确认（封面走 `relayAssetUrl` 中转） |
| 推荐信息流 + 封面图 | ✅ 已截图确认 |
| 二维码登录 / 点赞 / 历史 | ⚠️ 代码与数据层就绪，**模拟器未逐项点验**；登录需用户拿手机扫 |

**「观看」是怎么验收到的（方法可复用）**

模拟器的点击自动化很不稳（rail 上的「我的」点得中，顶栏「切到推荐/刷新」时灵时不灵），
所以卡了很久。最后有效的一步是：**先在列表上点一下 feed 行**（能点中），阅读视图就出来了。
虽然 `package.json` 的 `simulator.page` 只能传**纯页面名**（试过 `toutiao?group=…` →
实测 `launchPage(toutiao?group=…)` 直接**白屏**，查询串被当成了页面名的一部分），
但点击行是可行的，验收就走这条路。

→ 结论：**验收头条页时，用 `simulator.page = "toutiao"` 启动，然后在列表上点一行**，
比跟顶栏按钮较劲可靠得多。

**另一个坑：`.falcon_\libs\*.so` 被占用（EBUSY）**
残留的模拟器进程没退干净时，`aiot-cli simulator` 会因为
`EBUSY: resource busy or locked, unlink '.falcon_\libs\libjsapi_langningchen.so'` 直接失败。
处理：`Get-Process appx | Stop-Process -Force` 后再删该 `.so`，然后重跑。
**还有**：同时挂多个模拟器 job 会把机器内存吃光，PowerShell 本身会以
`OutOfMemoryException` / 退出码 `4294901760` 起不来 —— 验收前先 `job_list` 清掉僵尸 job。

**模拟器验收注意（汇总）**：模拟器 libcurl **没有 https**，所以要么把 `API_RELAY` 临时指向
`http://127.0.0.1:8712`（并跑 `npm run relay`）才能出数据，要么就只能看到空列表 ——
**空列表是环境限制，不是代码问题**（真机固件自带 TLS，不需要中转）。
验收完记得把 `API_RELAY`、`package.json` 的 `simulator.page`、模拟器 `cfg.json` 的 screen、
以及模拟器 `preferences.json` 全部还原。



## 14. 番茄小说（fanqienovel.com · 2026-10 接入）

主主页第三个入口。番茄与头条/抖音同属字节。

### 14.1 接口（`src/services/fanqie-api.js`）

| 用途 | 接口 | 实测 |
|---|---|---|
| 书单 | `GET /api/rank/list?type=N`（**N=0/1/2 有书，3 及以上为空**） | ✅ 200 JSON |
| 书籍页 | `GET /page/<bookId>` | ✅ 200 HTML（170KB+），内含 `window.__INITIAL_STATE__` |
| 正文 | `GET /reader/<chapterId>` | ✅ 200 HTML（44KB），`chapterData.content` = 正文 |
| 登录 | `sso.toutiao.com/passport/sso/get_qrcode/?service=https://fanqienovel.com` | ✅ 200，`app_name: "番茄小说"` |

- `rank/list` → `{ data: { list: [ { bookId, bookName, author, abstract, thumbUri } ] }, code: 0 }`
- **`thumbUri` 带签名**（`p3-reading-sign.fqnovelpic.com/…?x-signature=…`）→ ✅ **26/26 可显示**（与头条相反）
- 书籍页里 **336 个 `itemId`**（章节 id）+ 章节标题（"第一章 这块玉很古怪"…）
- 正文页 `chapterData`：`{ bookName, author, nextItemId, preItemId, content:"<p>…</p>" }`
  → `nextItemId` 可直接**连读下一章**
- **登录白捡**：就是字节统一账号 SSO，复用 `src/services/douyin-auth.js` 的
  `requestLoginQr({hint})` / `checkLoginQr`，扫码端显示「番茄小说」

❌ 拿不到的（实测）：**搜索**（`/search`、`/api/search/book`、`/api/search/v1`、`/api/book/search` 全 404；
`/api/author/search/search_book/v1` 200 但空体）、**分类/书库**（`/library` 是 SPA 空壳；
`/api/library/list`、`/api/book/list`、`/api/category/list` 全 404）。
→ **书源只有榜单 26 本**。

### 14.2 ★ 两个硬限制（决定"能读到什么"）

**① 不是每章都能读正文。** 实测某书前 6 章：**第 1、5 章可读**（4301 / 3981 字），
第 2、3、4、6 章只有 **24 字**（服务端占位）。

> ⚠️ `needPay` / `isChapterLock` / `isPaidPublication` **全是 0/false** ——
> **靠这些字段判断不出来**，只能按**正文长度**判定（`< 60` 字视为拿不到）。
> 代码：`fetchFanqieChapter` 的 `locked`；页面上会提示"这一章拿不到正文"。

**② 拿到的正文有字体反爬。** 约 **16% 的常用字**被替换成**私用区(PUA)码点**（U+E000–U+F8FF）。
页面内联 `@font-face` 指向自定义字体：

```
https://lf6-awef.bytetos.com/obj/awesome-font/c/dc027189e0ba4cd.otf   （font-family: DNMrHsV173Pd4pgy）
```

- 该字体**全局固定**（对照多章同一个文件）→ 映射只需生成一次
- 共 **362 个 PUA 字形**（第一章用到 224 个），CFF 字形名全是 `gidXXXXX`（**无语义**）
- 但**字形渲染出来确实是可读的汉字**（已肉眼确认：U+E4C5=去、U+E465=把、U+E436=了、
  U+E444=着、U+E4E4=头、U+E46D=吃…）
- **尝试过并放弃**：`.temp/fq-font-match.py` 用「渲染 + 归一化互相关」和「二值 IoU」做匹配，
  对照人工读出的 16 个字测 **top-1 命中率只有 ~56%**（细化 IoU 更差，19%）。
  **错的字会篡改原文，比显示方块更糟**，所以不采用。
- 现状：`maskPua()` 把 PUA 换成「□」并给出 `masked/ratio`，阅读页**如实提示**
  "该章含 N 个字体反爬字符（占 X%），已显示为 □"。

### 14.3 ★★ 踩坑：**QuickJS 里没有 `URL`**

番茄封面一开始**全部不显示**。原因：`isUsableFanqieCover()` 里用了 `new URL(u).hostname`，
而 **QuickJS 运行时没有 `URL`**，异常被 `catch` 吞掉 → **永远返回 `false`** → 封面全被丢弃。

- 表象极具迷惑性：`const` 常量（`/^https:\/\//i.test(u)`）为真，但带 `new URL` 的版本恒假。
- **修法**：封面判定一律用**纯正则**取主机名，不用 `URL`。
- **头条 `isUsableCover()` 有同一个 bug，已一并修掉**（它的封面此前也一直显示占位）。
- 回归断言：`test-services.mjs` 里 7 条封面判定用例会拦住这类退化。

### 14.4 页面与本地数据

`src/pages/fanqie/fanqie.vue`（横屏 800×254，左侧竖排 书架/最近/我的）：

- **书架**：榜单 26 本，封面走 `relayAssetUrl`（无 TLS 的模拟器靠中转，与抖音/头条同一套）
- **书页**：简介 + **336 章目录**，标出"在读"章
- **阅读**：正文 + 上一章/下一章（用 `nextItemId`/`preItemId`）+ 收藏 + 反爬提示
- **我的**：二维码登录 / 退出 / 回主主页
- 本地 storage（独立前缀，不与 `douyin_*`/`toutiao_*` 混）：
  `fanqie_session` / `fanqie_shelf`（上限 60 本）/ `fanqie_progress` / `fanqie_history`（上限 80 条，去重置顶）

主主页 `pages/index/index` 加第三个卡片「番茄小说」（橙色），
三个入口横排：`172px × 3 + 8px × 2`（原来两卡 266px 会溢出，已改）。

`npm test` → **169 PASS / 0 FAIL**。模拟器实测：书架（含封面）→ 336 章目录 → 第一章正文，全链路通。

### 14.5 下载（离线缓存）· 名称与版本（2026-10）

**"下载"在笔上不是"下文件"** —— 设备端**没有文件 API**（native 只注册了 storage 与 http），
且 HANDOFF §9 记过：二进制经 native http 的字符串通道会损坏
（实测 42% 字节非法 UTF-8，**曾导致词典笔软重启**）。

→ 所以实现的是**离线文本缓存**：把可读章的**正文文本**存进本机 storage，之后离线可翻。

**存储上限（笔上空间有限，必须设）**：

| 项 | 常量 | 值 |
|---|---|---|
| 单章正文截断 | `CACHE_MAX_CHARS` | 6000 字 |
| 每本最多缓存 | `CACHE_MAX_CHAPTERS` | 40 章（超出丢最早的） |
| 全书缓存总量 | `CACHE_MAX_TOTAL` | 300000 字（约 600KB，超出整本丢最旧的） |

**★ 遇到锁定章不能停（重要修正）**：一开始写成"见锁就停"，实测**只下到 23 章**。
原因是番茄的锁定是**分散**的 —— 实测前 6 章是「**可读/锁/锁/锁/可读/锁**」，
看到第 2 章就停会白白漏掉第 5 章以及后面所有可读章。

改成**跳过锁定章继续往后找**，直到：存够 `maxChapters` 章、或**连续跳过 `skipLimit`(60) 章都没收获**、
或扫完、或用户喊停。修正后同一本书**下到 40 章（本机上限）· 24.2 千字**。

**阅读优先读缓存**：`openChapter()` 先查 `cachedChapter()`，命中就不发网络请求，
并显示「离线缓存」标记；目录里缓存的章标「已存」。

**UI**：书页有「下载可读章节 / 继续下载 / 停止 / 清除缓存」+ 实时进度
（`第 N/336 章 · 已存 X · 跳过 Y · 章节名`），完成后如实说明停下原因
（存满上限 / 后面没可读章 / 用户停止）。

**★ 又一个 JS 数值坑（测试代码里踩的）**：断言数据写成
`{ 100000000000000001: true }` —— 18 位数字**超出双精度整数精确表示范围**，
被舍入成 `100000000000000000`，字符串 ID 查表全 miss → 所有章被当成"锁定章"，测试假失败。
**章节 id 一律当字符串处理**（产品代码没这问题，是测试桩写错）。

**名称与版本**：`package.json` → `name: "字节全家桶"`、`version: "1.0.2"`
（产物 `8001790389478283.1_0_2.amr`）；主主页顶栏与右下角都显示
「字节全家桶 / v1.0.2」，顶栏还加了番茄登录态（四边一目了然）。

`npm test` → **187 PASS / 0 FAIL**。模拟器实测：书架 → 下载 40 章 → 离线读第 1 章（标「离线缓存」），全通。

### 14.6 若要真正读完番茄，唯一的路

在 **PC 上**把字体比对做扎实（多参考字体投票 / 轮廓曲率特征 / 用小说语料做 n-gram 消歧），
生成完整映射表后再交给设备 —— 与头条视频同理，**都需要 PC 侧离线能力，笔上算不动**。

---

## 15. 外部评价的整改（2026-10）

收到一份外部代码评价（`评价.md`）。逐条核实后的处置如下 —— **结论：评价基本准确，主要问题都成立。**

### 15.1 🔴 删除 `resolvePlainHttpUrl()`（最严重的一条，**已删**）

**评价说**：`native-player.js` 自己写着"⛔ 绝对不要用 JS 的 http 通道去探测视频地址"，
可 80 行之后的 `resolvePlainHttpUrl()` 正是对视频入口 URL 发 GET；`player.vue` 在
`mounted()` 里无条件先调它。**完全属实。**

**它依据的前提也已被自己推翻**：注释里写的"模块很可能没有 TLS"，
在 §13.7 就被真机诊断否掉了（第 11 行 `OK 1280x720`）。

**两个分支都不利**（所以删掉没有任何损失）：

| 情形 | 后果 |
|---|---|
| 固件跟随 302 | body 就是完整 mp4 → **正是软重启场景** |
| 固件不跟随 | 拿不到 `Location` → 白等 8 秒，纯开销 |

**处置**：删掉 `resolvePlainHttpUrl` / `cachedPlainHttpUrl` / `locationFrom` /
`looksLikeMediaUrl` / `httpOf` / `LOCATION_CACHE` / `UA_FOR_RESOLVE`（共约 80 行），
以及 `player.vue` 的调用点与 import；`native-player.js` 现在**不再 import `jsapiHttpRequest`**。

**并加了源码级回归防线**（`test-services.mjs`）：断言 `native-player.js` 里
**不得出现 `jsapiHttpRequest` / `LOCATION_CACHE`**，也不得再导出那两个函数 —— 防止被写回来。

### 15.2 🔴 测试随 Node 版本飘（**已修，并实测复现+验证**）

**评价说**：实际 186 PASS / 1 FAIL，而 HANDOFF 写 187/0。**属实**（我这里是 Node 16 所以是绿的）。

根因：断言 `无通道环境错误信息` 之前只 `delete globalThis.$falcon`，
而 **Node ≥18 自带全局 `fetch`** → 通道链退到 fetch **真的把请求发出去了**并成功 →
`envError` 为空 → 断言失败。

**我做了什么**：写了一个 `--require` 的 fetch shim（把全局 fetch 打桩成**真实转发**），
**先精确复现了 `FAIL 无通道环境错误信息 = `（空）**，确认复现有效；
再改成断言前 `globalThis.fetch = undefined`（同时清 `tt`），**同一 shim 下转为 0 FAIL**。
两种环境（本机 Node 16 / 模拟 Node≥18）现在都是 **FAIL = 0、退出码 0**。

### 15.3 🟠 `fetchHotWords()` 未加保护（**已修**）

评价说得对：本文件开头的约定是"依赖第三方接口可用性的断言一律用 NOTE"，
但 `await fetchHotWords()` 裸调用，接口一抖就抛异常把整个套件带崩。**已包 try/catch 降级为 NOTE。**

### 15.4 🟠 无 git 仓库、无 .gitignore、70MB 临时文件（**已修**）

**评价说得对，而且这条风险最高**：`.temp/apk/` 是 21MB 的 myDV APK 解包产物，**含字节私有 SDK**；
§9.3 自己还提醒 abogus/bdms 是"灰色地带，别商用/分发"。**一旦误提交很难清理。**

**处置**：
- 根目录新建 `.gitignore`：`*.amr`、`.falcon_/`、`.falcon_tmp/`、`dist/`、`node_modules/`、
  **`.temp/`**、`libs/*.so`、编辑器/日志
- `.zcodeignore` 同步补上同样几项（它原本头部声称"同步自 .gitignore"，但那个文件并不存在）
- `git init` + **初始提交**（61 文件 / 15096 行）
- 用 `git check-ignore` 逐个验证：`.temp/apk`、`*.amr`、`.falcon_`、`node_modules`、
  `libs/*.so` **全部被挡住**；`git ls-files` 确认入库清单里没有它们

### 15.5 🟠 HANDOFF 是日志不是规格，内部自相矛盾（**已修**）

评价说得很准。**处置：在文件最顶部加 §0「当前事实速查」**，集中给出：

- **0.1 版本与开关当前值**（version 1.0.2 / `API_RELAY=''` / `simulator.page=''` …）
- **0.2 测试真实状态**（185 PASS / 0 FAIL；说明 PASS 数会因 NOTE 降级而小幅浮动，判断看 FAIL=0）
- **0.3 假设状态表**（每条标"成立/已推翻"+依据；**与正文冲突以 §0 为准**）
- **0.4 绝对禁令**（4 条会致设备故障的红线）

同时**修掉正文里两处矛盾**：文件头版本号 1.0.0→1.0.2；§13.4 的"94~103 PASS"标注为历史记录并指向 §0.2；
`test-services.mjs` 里"与 curl FOLLOWLOCATION 行为一致"的错注释改为如实说明
**桩跟随重定向、真实固件不跟随**。

### 15.6 未做的（以及为什么）

| 评价项 | 处置 |
|---|---|
| 🟡 两条并存播放路径（`nativePlayableUrl` vs `playUrlCandidates`） | **保留**。`nativePlayableUrl` 只被 `douyin.vue` 用来算"跳转前展示的地址"，不是播放路径本身；统一它要动 2491 行的页面，**当前风险 > 收益** |
| 🟡 `isErrorBody` 零调用者 | 保留定义 + 单测，但在注释里**明确标注"生产代码无调用者"**，并说明"确定不需要时连同测试一起删"。它把"什么算错误体"这条判据钉住了，留着有用 |
| 🟡 三个巨型页面无共享抽象 | **不动**。与评价者的第 5 条建议一致：**现在动它风险高于收益**，除非要继续加功能 |
| 🟡 relay 无鉴权/白名单、默认监听 0.0.0.0 | **未改**（属"自家局域网内可接受的取舍"，且改它会牵动真机联调）。**已知风险，记在此处** |
| 🟡 `package.json` 硬编码模拟器路径 / `native_play_history_v1` 无上限 / storage 契约不一致 | **未改**，记为已知项 |

### 15.7 本文件（HANDOFF）的读法

- **先读 §0**，那是当前真相。
- §13、§14、§15 是按时间追加的**历史与推演**，保留被证伪的假设是**故意的** ——
  目的是让后来者不重复踩坑（这也是评价里认可的最大价值）。
- 与 §0 冲突时，**以 §0 为准**。

### 15.8 ★ 抖音播放：本轮实测到的新事实（**关键，且推翻了旧结论**）

用户要求"抖音视频再修复一下"。趁这轮把播放链路重新实测了一遍，**三个新事实，其中一个推翻了
我前两轮都写进文档的结论**。

#### ① 推翻了「Referer 是 403 的原因」

§13.5 与之前的真机复盘都断言过："抖音 CDN 的 302 落点**要求带 Referer**，否则 403"。
本轮做了对照实验（26 个落点，同一批 uri，**只改 Referer**）：

| 请求头 | 结果 |
|---|---|
| **只带 UA** | OK **19** / 失败 7 |
| **带 `Referer: https://www.douyin.com/`** | OK **18** / 失败 8 |
| **被 Referer 救回** | **0 条** |

→ **Referer 与 403 无关**。之前那个结论是**样本太少**（只看个别主机）得出的。
失败其实是 **DNS 解析不了**（见 ②），跟请求头没关系。

#### ② 真正的失败模式：**落点 CDN 主机的 DNS 永久失败，且同一 uri 的主机固定不变**

- 失败几乎全集中在 `v95-bjb-mc-cold.douyinvod.com`：**DNS 连续三次都是 `ENOTFOUND`**
  （对照 `v5-gz2-colda` / `v26-web` 都能正常解析出 IP）。
- **同一个 uri 连续请求 6 次，302 落点主机完全相同**（都是那一台）。
- → **所以"多入口轮换"救不了一条落在坏主机上的 uri**：换 ratio / 换域名，
  它还是跳回同一台连不上的主机。（这正好解释了真机上"6 个入口全失败"。）

#### ③ 定位 `{"error":3,…}` 的来源：**不是抖音返回的**

真机诊断里那条 90 字节的 `{"error":3,"result":{"errorMes…}}` 一直是个谜。本轮把抖音各层
原始返回都打了一遍：

| 构造的请求 | 实际返回 |
|---|---|
| 乱编 video_id | `200`，**空 body** |
| 空 video_id | `200`，**空 body** |
| 直连 DNS 坏的主机 | **`getaddrinfo ENOTFOUND`**（异常，不是 JSON） |
| 好主机 + 乱编路径 | `403` + **`openresty` 的 HTML** |
| 正常入口 | `302` + `<a href=…>` 跳转体 |

→ **没有任何一层返回 `{"error":3}`**。结论：它是**原生 JS http 层**对网络失败
（DNS / 连接 / TLS 建立失败）的**统一错误体**，不是服务器响应。

**这条很重要**：真机上看到 `error:3` = **网络层根本没连上落点主机**，
而不是"抖音拒绝了这个请求"。所以别再往请求头/参数方向查了。

#### ④ 本轮改动：中转侧可达性探测（`&probe=1`）

既然坏主机是"连不上"而非"被拒绝"，就可以**让 PC 中转先探一遍**、把注定失败的候选提前剔掉。

- `scripts/relay-server.mjs` 新增 `&probe=1`：跟随 302 到落点，**只回**
  `{probe:1, ok, status, contentType, looksVideo, length}`，**不转发 body**；
  连不上时返回 **200 + `ok:false` + error**（而不是 502，否则设备分不清是入口坏还是中转坏）。
- `native-player.js` 新增 `probeCandidatesViaRelay(urls, opts)`：
  **没配中转就返回 `null`**（不改变原有直连行为）；探测本身异常也返回 `null`，不拦播放器。
- 设备端**只读几十字节 JSON**，**绝不自己发媒体请求**（守住 §9/§13.10 的禁令）。
  源码级断言钉住：`jsapiHttpRequest` 在 `native-player.js` 里只允许出现在
  `probeCandidatesViaRelay` 内，且 URL 必须带 `&probe=1`。
- 诊断页 13/14 行接入：能直接报出「N 个可达 / M 个连不上」以及**是哪台主机坏了**。

#### ⑤ 当前成功率（PC 侧实测，20 个 feed 视频）

```
可播 OK = 17 / 20     403 = 3     DNS 坏 = 0     错误 JSON = 0
```

`snssdk` 入口贡献 15/17 —— 印证 §13.5「首选 snssdk」是对的。
剩下 3 条就是落在坏主机上的，靠 §④ 的探测可以提前识别。

#### ⑥ 还能不能更好

- 坏主机（如 `v95-bjb-mc-cold`）**过一段时间可能恢复**，所以**不该硬编码黑名单**；
  现在靠**运行时发现**（`markHostBad` + 中转探测），这是对的。
- 客户端能做的到此为止：**换入口改变不了落点主机**（②）。真正的解法是
  "**提前知道哪条 uri 落在坏主机上就别选它**" —— 即多取几条 feed、优先挑能连上的。
  当前实现（多入口 + 坏主机黑名单 + 可选探测）已覆盖。

### 15.9 真机第五轮仍黑屏 —— 已排除清单与下一步（2026-10）

用户反馈"还是黑屏"。本轮**没有再盲改**，而是把能排除的都排除掉，并把最后的判据做成
**设备自己会报的对照实验**。**结论：我在 PC 侧已无法继续定位，需要真机那份诊断。**

#### 已用实验排除的原因（都不成立，别再往这些方向查）

| 曾怀疑 | 实验 | 结论 |
|---|---|---|
| 模块没有 TLS | 诊断第 11 行 | ❌ 排除：固定 id **能播** `OK 1280x720` |
| CDN 要求 Referer | 26 个落点对照 | ❌ 排除：只带 UA 19/26 vs 带 Referer 18/26，**救回 0** |
| 落点主机 DNS 坏 | 同 uri 连测 6 次 | ⚠️ 只解释了**少数** uri，不是全部 |
| 编码格式不对 | 解析 MP4 box | ❌ 排除：探针与 feed **都是 H.264 High@3.1 + AAC**，容器都是 `isom` |
| moov 在文件尾（要 seek） | 解析 box 顺序 | ❌ 排除：**两者 moov 都在文件头部**（153KB vs 328–938KB） |
| 播放参数不对 | 对比诊断 vs 播放页 | ❌ 排除：**参数完全相同**（`screenW/H=800x254`、`maxW/H=800x254`、rect 全屏） |
| 网络链路不通 | relay 访问日志 | ❌ 排除：中转日志显示 feed 与视频探针**都 200** |

**唯一剩下的差别就是 URL 本身**（即它最终落到哪台 CDN 主机、那台主机给出什么）。

#### 新加的对照实验（**下次真机只要报这两行**）

诊断里新增三步，把结论收敛成互斥的几种，不用再猜：

| 行 | 含义 | 怎么判读 |
|---|---|---|
| **12 feed 首条实播** | 用**和 11 行完全相同的方式**去播 feed 的第一条 | `ok=WxH` 有尺寸 → 能播（问题在别处）；`ok=?x?` → **确认"打开了但无视频流"**；`失败 xxx` → 看错误串 |
| **14 探测(直连入口)/(经中转)** | 让 PC 中转回报"这个入口连不连得上" | `连不上 + host=…` → 就是那台主机的问题；`可达` → 主机没问题，问题在解码 |
| **15 探测自检** | 用一个**已知能播**的固定地址探一次 | 自检挂 → 探测链路本身没工作，**14 行的结论不可信**；自检 OK → 14 行结论可信 |

**判读组合**：

- `12 失败` + `14 连不上` → **网络层**（设备到那台 CDN 主机不通）→ 换网络/等主机恢复/走中转
- `12 ok但无尺寸` + `14 可达` → **解码层**（能拿到字节但解不出）→ 这才需要查模块/编码
- `12 能播带尺寸` → 说明这条能播，黑屏是**播放页调度**问题（再单独查）

#### 本轮新增的代码

- 诊断新增 12/14/15 三步（都走**安全路径**：设备不读视频字节）
- 探测代码经确认**已正确打包**（`'&probe=1'` 是运行时字符串拼接，所以在压缩产物里
  搜不到字面量 —— 一开始我据此误判成"没打包"，**实际是搜错了**）
- 之前几轮加的 relay `&probe=1` 端点、主机黑名单、`orderByHostHealth` 都保留

#### 仍未解决的诚实说明

**我从 PC 无法复现这个黑屏**：PC 上 20 个 feed 视频可播 17 个，探针 URL 在真机上也确实能播。
所以剩下的只能是"**设备到具体 CDN 主机的网络/解码差异**"，这必须由设备侧数据来收口。
`12/14/15` 三行就是为此设计的 —— 有了它们，下一步能直接定位到层，不用再来回试。



