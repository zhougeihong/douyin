<template>
  <div class="page" @touchstart="onStart" @touchmove="onMove" @touchend="onEnd" @touchcancel="onCancel">

    <!-- 顶部导航 -->
    <div class="topbar" v-if="dockIdx === 0">
      <div class="tab" @click="selectFeed('live')">
        <text class="tab-txt" :class="[tab === 'live' ? 'tab-active' : '']">直播</text>
        <text class="tab-dot" v-if="tab === 'live'"></text>
      </div>
      <div class="tab" @click="selectFeed('rec')">
        <text class="tab-txt" :class="[tab === 'rec' ? 'tab-active' : '']">推荐</text>
        <text class="tab-line" v-if="tab === 'rec'"></text>
      </div>
      <div class="tab" @click="selectFeed('follow')">
        <text class="tab-txt" :class="[tab === 'follow' ? 'tab-active' : '']">关注</text>
        <text class="tab-line" v-if="tab === 'follow'"></text>
      </div>
    </div>

    <div class="input-bar" v-if="dockIdx === 0">
      <ImeField :value="manualUrl" placeholder="输入抖音分享链接，可自动加入视频列表"
        :active="imeTarget === 'manualUrl'" name="manualUrl" @ime-focus="onImeFocus" />
      <div class="import-btn" @click="addVideoFromUrl">
        <text class="publish-label">导入</text>
      </div>
    </div>

    <!-- 离线回退提示：接口未连通时明确告知（否则只会看到本地样例却不知道原因），点击重试 -->
    <div class="offline-tip" v-if="dockIdx === 0 && offlineFallback" @click="reloadVideos">
      <text class="offline-tip-txt">! 接口未连通，当前为离线样例 · 点此重试</text>
    </div>

    <!-- 视频流 -->
    <div class="feed" v-if="dockIdx === 0">
      <div class="slide" v-for="(item, i) in visibleList" :key="item.slideKey || (item.author + item.scene)"
        :style="{ transform: 'translate(0, ' + ((i - cur) * HEIGHT + dragY) + 'px)', transition: moving ? 'none' : 'transform 220ms ease-out' }">

        <!-- 封面：数据源提供真实封面图时显示封面，否则用本地演示画面。
             视频条目点封面即“解析出播放地址并播放” -->
        <div class="cover-art" v-if="!playingOf(i)" :style="{ backgroundColor: item.bg }" @click="onCoverTap(item)">
          <image class="cover-img" v-if="item.cover" :src="item.cover" mode="aspectFill"></image>
          <div class="cover-fallback" v-else>
            <text class="art-mark">{{ avatarChar(item) }}</text>
            <text class="art-title">{{ item.scene }}</text>
            <text class="art-caption">{{ itemKind(item) }}</text>
          </div>
          <div class="cover-hint" v-if="coverHint(item)">
            <text class="cover-hint-txt">{{ coverHint(item) }}</text>
          </div>
        </div>

        <!-- 内置播放器：帧动画 -->
        <FramePlayer
          v-if="item.frames.length"
          :frames="item.frames"
          :interval="item.interval"
          :playing="playingOf(i)"
          @toggle-play="togglePlayback(i)">
        </FramePlayer>

        <!-- 解析出播放地址时真实播放（web 预览/支持 video 的环境）；设备端无 video 组件时由封面层兜底 -->
        <!-- 解析出播放地址时真实播放。注意：设备运行时没有 <video> 组件，
             所以有原生模块时不在页内播，改为点开进入原生横屏播放页（player） -->
        <VideoPlayer
          v-if="item.playUrl && cur === i && !nativeVideoReady"
          class="vp-layer"
          :key="item.videoId || item.url"
          :src="item.playUrl"
          :autoplay="true"
          :muted="false"
          :paused="item.paused"
          :frame-width="WIDTH"
          :frame-height="HEIGHT"
          :ctrl-bottom="48"
          @doubletap="like(i)">
        </VideoPlayer>

        <!-- 播放器控制条 -->
        <div class="ctrl">
          <text class="ctrl-nav" @click.stop="jumpVideo(-1)">上一条视频</text>
          <text class="ctrl-btn" v-if="item.frames.length" @click="togglePause(i)">{{ playingOf(i) ? '暂停' : '播放' }}</text>
          <text class="ctrl-txt">{{ itemKind(item) }} · {{ (i + 1) + ' / ' + visibleList.length }}</text>
          <text class="ctrl-nav" @click.stop="jumpVideo(1)">下一条视频</text>
        </div>

        <!-- 底部作者信息（不用 emoji：词典笔屏幕不显示 emoji） -->
        <div class="meta">
          <div class="author-row">
            <text class="author-name">@{{ item.author }}</text>
          </div>
          <text class="desc">{{ item.desc }}</text>
          <div class="music-row">
            <text class="music-label">原声</text>
            <text class="music-txt">{{ item.music }}</text>
          </div>
        </div>

        <!-- 右侧互动栏：全部用中文标签，状态靠颜色区分 -->
        <div class="actions">
          <div class="avatar" :style="{ backgroundColor: item.bg }">
            <text class="avatar-txt">{{ avatarChar(item) }}</text>
          </div>
          <div class="follow-mark" v-if="canFollow(item)" @click="followAuthor(i)">
            <text class="follow-mark-txt">{{ item.followed ? '已关注' : '关注' }}</text>
          </div>
          <div class="act" @click="like(i)">
            <text class="act-ic" :class="[item.liked ? 'ic-on' : '']">赞</text>
            <text class="act-num" :class="[item.liked ? 'num-on' : '']">{{ fmt(item.likes + (item.liked ? 1 : 0)) }}</text>
          </div>
          <div class="act" @click="collectItem(i)">
            <text class="act-ic" :class="[item.collected ? 'ic-col' : '']">藏</text>
            <text class="act-num" :class="[item.collected ? 'num-col' : '']">{{ item.collected ? '已藏' : '收藏' }}</text>
          </div>
          <div class="act" @click="openComments(i)">
            <text class="act-ic">评</text>
            <text class="act-num">{{ fmt(item.comments) }}</text>
          </div>
          <div class="act" @click="openShare(i)">
            <text class="act-ic">转</text>
            <text class="act-num">{{ fmt(item.shares) }}</text>
          </div>
        </div>

        <!-- 双击点赞提示 -->
        <div class="heart" v-if="item.heart">已赞</div>
      </div>
    </div>

    <scroller class="subpage" v-if="dockIdx === 1" show-scrollbar="false">
      <text class="page-heading">搜索视频</text>
      <div class="search-row">
        <ImeField :value="searchQuery" placeholder="搜索当前视频列表"
          :active="imeTarget === 'searchQuery'" name="searchQuery" @ime-focus="onImeFocus" />
        <text class="search-clear" v-if="searchQuery" @click="searchQuery = ''">清除</text>
      </div>
      <text class="search-count">当前结果 {{ searchResults.length }} 条</text>
      <div class="search-empty" v-if="!searchResults.length">
        <text class="empty-title">{{ searchQuery ? '没有匹配的视频' : '当前列表暂无视频' }}</text>
        <text class="page-copy">结果来自本地视频列表</text>
      </div>
      <div class="search-result" v-for="result in searchResults" :key="result.index" @click="openVideo(result.index)">
        <div class="search-result-cover" :style="{ backgroundColor: result.item.bg }">
          <image class="search-result-image" v-if="result.item.cover" :src="result.item.cover" mode="aspectFill"></image>
          <text class="search-result-emoji" v-else>{{ avatarChar(result.item) }}</text>
        </div>
        <div class="search-result-copy">
          <text class="search-result-title">{{ result.item.title || result.item.scene }}</text>
          <text class="search-result-desc">{{ result.item.desc }}</text>
          <text class="search-result-author">@{{ result.item.author }}</text>
        </div>
      </div>
    </scroller>

    <div class="subpage" v-if="dockIdx === 2">
      <text class="page-heading">发布作品</text>
      <text class="page-copy">写下作品标题，加入本地演示信息流。</text>
      <ImeField :value="draft" placeholder="此刻想分享什么？"
        :active="imeTarget === 'draft'" name="draft" @ime-focus="onImeFocus" />
      <div class="publish-btn" @click="publishPost"><text class="publish-label">发布</text></div>
    </div>

    <div class="subpage" v-if="dockIdx === 3">
      <text class="page-heading">消息</text>
      <div class="empty-state" v-if="!notifications.length">
        <text class="empty-title">暂时没有新消息</text>
        <text class="page-copy">收到的点赞和评论会显示在这里。</text>
      </div>
      <div class="notice-row" v-for="(notice, i) in notifications" :key="i">
        <text class="notice-mark">·</text>
        <text class="notice-copy">{{ notice }}</text>
      </div>
    </div>

    <scroller class="subpage" v-if="dockIdx === 4" show-scrollbar="false">
      <text class="page-heading">我的主页</text>
      <text class="profile-version">v{{ appVersion || '未知版本' }}{{ API_RELAY ? ' · 中转模式' : ' · 直连模式' }}</text>
      <div class="profile-history-btn" @click="runNetDiag">
        <text class="profile-history-txt">网络诊断{{ netDiagRunning ? '（运行中…）' : '' }}</text>
        <text class="profile-history-arrow">›</text>
      </div>
      <div class="net-diag" v-if="netDiag.length">
        <text class="net-diag-row" v-for="(step, i) in netDiag" :key="i">{{ step }}</text>
      </div>
      <div class="profile-user" v-if="session">
        <div class="profile-avatar">
          <text class="profile-avatar-txt">{{ avatarLetter }}</text>
        </div>
        <div class="profile-user-copy">
          <text class="profile-nick">{{ session.nick || '抖音用户' }}</text>
          <text class="profile-uid">ID {{ session.id || '未知' }} · {{ loginTimeText }}</text>
        </div>
        <div class="profile-logout" @click="logoutAccount">
          <text class="profile-logout-txt">退出</text>
        </div>
      </div>
      <div class="profile-login" v-else>
        <text class="profile-handle">未登录</text>
        <div class="profile-login-btn" @click="openLoginQr">
          <text class="publish-label">扫码登录</text>
        </div>
        <text class="profile-copy">使用抖音 APP 扫描二维码完成登录，无需账号密码，登录态保存在本机。</text>

        <!-- 多闪（抖音私信）登录：另一条独立通道，走 PC 网关 gateway.py，与上面抖音扫码互不影响 -->
        <text class="profile-section">多闪 · 抖音私信登录</text>
        <div class="profile-login-btn" @click="openChatLogin">
          <text class="publish-label">多闪扫码登录</text>
        </div>
        <text class="profile-copy">走电脑上的 gateway.py 网关：先在电脑运行网关，再进这个页面填电脑的局域网 IP:端口，然后用抖音 APP 扫码。登录态保存在电脑网关，笔上不存。</text>

        <!-- 手机号登录：走网页端 passport 接口（获取验证码 + 校验），成功后同样会抓下登录 Cookie -->
        <text class="profile-section">手机号登录</text>
        <div class="phone-row">
          <ImeField :value="phone" placeholder="11 位手机号" :active="imeTarget === 'phone'"
            name="phone" @ime-focus="onImeFocus" />
        </div>
        <div class="phone-row">
          <ImeField :value="smsCode" placeholder="短信验证码" :active="imeTarget === 'smsCode'"
            name="smsCode" @ime-focus="onImeFocus" />
          <div class="phone-btn" @click="sendCode">
            <text class="phone-btn-txt">{{ smsCountdown > 0 ? smsCountdown + 's' : '获取验证码' }}</text>
          </div>
        </div>
        <div class="phone-login-btn" @click="phoneLogin">
          <text class="publish-label">手机号登录</text>
        </div>
        <text class="profile-copy">验证码登录走的是网页端 passport 接口，全程直连、不需要中转。会话 Cookie 随响应头下发，而本机固件不回传响应头（实测外层只有 result），所以验证码登录后若提示未取到会话，请用下面的「粘贴 Cookie 登录」补齐。</text>

        <!-- 不依赖响应头的登录方式：电脑浏览器登录后把整串 Cookie 粘进来 -->
        <text class="profile-section">粘贴 Cookie 登录（无需中转）</text>
        <div class="phone-row">
          <ImeField :value="cookieDraft" placeholder="粘贴整串 Cookie" :active="imeTarget === 'cookieDraft'"
            name="cookieDraft" @ime-focus="onImeFocus" />
          <div class="phone-btn" @click="applyPastedCookies">
            <text class="phone-btn-txt">保存</text>
          </div>
        </div>
        <text class="profile-copy">电脑浏览器登录抖音后，从开发者工具 → Network → 任一请求 → Request Headers 里复制整串 Cookie（含 sessionid、ttwid 等）粘进来即可，完全不需要 PC 中转。</text>
      </div>
      <text class="profile-copy">视频数据来自抖音第三方数据源，经 libjsapi 原生通道加载。当前数据源：{{ dataSource }}。</text>
      <text class="profile-copy">{{ cookieLine }}</text>
      <div class="profile-errors" v-if="sourceErrors.length">
        <text class="profile-error-row" v-for="(err, i) in sourceErrors" :key="i">· {{ err }}</text>
      </div>
      <div class="profile-stats">
        <div class="profile-stat"><text class="stat-number">{{ list.length }}</text><text class="stat-label">作品</text></div>
        <div class="profile-stat"><text class="stat-number">{{ likedCount }}</text><text class="stat-label">已点赞</text></div>
        <div class="profile-stat"><text class="stat-number">{{ collectedCount }}</text><text class="stat-label">收藏</text></div>
      </div>
      <text class="profile-section">观看历史</text>
      <div class="profile-history-btn" @click="openHistory">
        <text class="profile-history-txt">找回刷掉的视频{{ history.length ? '（' + history.length + '）' : '' }}</text>
        <text class="profile-history-arrow">›</text>
      </div>
      <text class="profile-section">我的收藏</text>
      <div class="video-search-empty" v-if="!collectedItems.length">
        <text class="video-search-empty-text">还没有收藏，点右侧「藏」收藏喜欢的视频</text>
      </div>
      <div class="profile-work" v-for="result in collectedItems" :key="result.index" @click="openVideo(result.index)">
        <text class="profile-work-title">{{ result.item.collected ? '已藏' : '未藏' }}　{{ result.item.title || result.item.scene }}</text>
        <text class="profile-work-desc">{{ result.item.author }} · {{ result.item.desc }}</text>
      </div>
      <text class="profile-section">我的作品</text>
      <ImeField :value="myVideoQuery" placeholder="搜索标题、作者或描述"
        :active="imeTarget === 'myVideoQuery'" name="myVideoQuery" @ime-focus="onImeFocus" />
      <text class="video-search-count">{{ myVideoResults.length }} 条视频</text>
      <div class="video-search-empty" v-if="!myVideoResults.length">
        <text class="video-search-empty-text">{{ myVideoQuery ? '没有匹配的视频' : '当前列表暂无视频' }}</text>
      </div>
      <div class="profile-work" v-for="result in myVideoResults" :key="result.index" @click="openVideo(result.index)">
        <text class="profile-work-title">{{ result.item.collected ? '已藏' : '未藏' }}　{{ result.item.title || result.item.scene }}</text>
        <text class="profile-work-desc">{{ result.item.author }} · {{ result.item.desc }}</text>
      </div>
    </scroller>

    <!-- 扫码登录弹层：二维码为官方接口签发的 base64 PNG -->
    <div class="qr-overlay" v-if="loginQr" @click="closeLoginQr">
      <div class="qr-panel" @click.stop>
        <text class="qr-title">抖音扫码登录</text>
        <image class="qr-img" :src="loginQr.image" mode="aspectFit"></image>
        <text class="qr-hint">{{ loginQr.hint }}</text>
        <!-- 说明扫码端品牌：唯一免密钥可用的入口是字节统一账号 SSO，其 app_name 就是“今日头条APP”，
             抖音自己的入口已封禁/无权限（详见 config.js 注释），这里如实告知，避免误以为登错账号 -->
        <text class="qr-note">扫码确认页可能显示「今日头条」：字节统一账号体系，抖音账号用抖音 APP 扫码即可登录{{ loginQr.appName ? '（本次扫码端：' + loginQr.appName + '）' : '' }}</text>
        <text class="qr-status">{{ loginStatusText }}</text>
        <div class="qr-actions">
          <div class="qr-btn" @click="openLoginQr">
            <text class="qr-btn-txt">刷新</text>
          </div>
          <div class="qr-btn qr-btn-ghost" @click="closeLoginQr">
            <text class="qr-btn-ghost-txt">关闭</text>
          </div>
        </div>
      </div>
    </div>

    <!-- 观看历史抽屉：在第一个视频处继续往回滑或从"我的"页进入 -->
    <div class="sheet-backdrop" v-if="showHistory" @click="closeHistory">
      <div class="history-sheet" @click.stop>
        <text class="sheet-title">观看历史{{ history.length ? ' · ' + history.length : '' }}</text>
        <text class="history-tip">刷掉的视频都在这里，点击找回</text>
        <div class="history-empty" v-if="!history.length">
          <text class="video-search-empty-text">还没有观看记录</text>
        </div>
        <scroller class="history-list" v-else>
          <div class="history-row" v-for="(h, i) in history" :key="h.key + '-' + i" @click="jumpToHistory(h)">
            <image class="history-cover" v-if="h.cover" :src="h.cover" mode="aspectFill"></image>
            <div class="history-cover history-cover-ph" v-else>
              <text class="history-cover-emoji">视频</text>
            </div>
            <div class="history-copy">
              <text class="history-title">{{ h.title }}</text>
              <text class="history-meta">@{{ h.author }} · {{ fmtTime(h.ts) }}</text>
            </div>
            <text class="history-del" @click.stop="removeHistoryItem(h)">×</text>
          </div>
        </scroller>
        <div class="history-actions">
          <div class="qr-btn" @click="clearHistoryItems">
            <text class="qr-btn-txt">清空记录</text>
          </div>
          <div class="qr-btn qr-btn-ghost" @click="closeHistory">
            <text class="qr-btn-ghost-txt">关闭</text>
          </div>
        </div>
      </div>
    </div>

    <div class="sheet-backdrop" v-if="commentIndex >= 0 || shareIndex >= 0" @click="closeSheets">
      <div class="comment-sheet" v-if="commentIndex >= 0" @click.stop>
        <text class="sheet-title">评论 {{ fmt(list[commentIndex].comments) }}</text>
        <div class="comment-row" v-for="(comment, i) in list[commentIndex].commentList" :key="i">
          <text class="comment-author">{{ comment.author }}</text>
          <text class="comment-copy">{{ comment.text }}</text>
        </div>
        <div class="comment-entry">
          <ImeField :value="commentDraft" placeholder="说点什么..."
            :active="imeTarget === 'commentDraft'" name="commentDraft" @ime-focus="onImeFocus" />
          <text class="send-btn" @click="submitComment">发送</text>
        </div>
      </div>
      <div class="share-sheet" v-if="shareIndex >= 0" @click.stop>
        <text class="sheet-title">分享作品</text>
        <text class="share-copy">{{ list[shareIndex].scene }} · @{{ list[shareIndex].author }}</text>
        <div class="share-action" @click="shareLocally"><text class="publish-label">生成分享文案</text></div>
      </div>
    </div>
    <text class="toast" v-if="toast">{{ toast }}</text>

    <!-- 内嵌拼音软键盘（页面级渲染，事件按 imeTarget 路由到对应字段） -->
    <PinyinIme v-if="imeTarget" @commit="onImeCommit" @insert="onImeInsert"
      @delete-char="onImeDelete" @done="onImeDone" />

    <!-- 左侧分区栏（替代原来的底部导航栏）：横屏只有 254px 高，纵向空间比横向紧张得多，
         把导航放到左侧竖排更省高度，也给视频画面多留出底部空间。全部用中文标签，无 emoji -->
    <div class="rail">
      <!-- 返回主主页（本页由主主页「笔上抖音」进入） -->
      <div class="rail-back" @click="backHome">
        <text class="rail-back-txt">返回</text>
      </div>
      <div class="rail-item" v-for="sec in sections" :key="sec.idx" @click="selectPage(sec.idx)">
        <text class="rail-txt" :class="[dockIdx === sec.idx ? 'rail-txt-active' : '']">{{ sec.label }}</text>
      </div>
    </div>

  </div>
</template>

<script>
import FramePlayer from '../../components/FramePlayer.vue';
import VideoPlayer from '../../components/VideoPlayer.vue';
import ImeField from '../../components/ImeField.vue';
import PinyinIme from '../../components/PinyinIme.vue';
import { fetchVideoList, resolveVideoForItem, isVideoLink, saveImportedVideo } from '../../services/video.js';
import { resolveVideoFromLink } from '../../services/local-import.js';
import { readSession, saveSession, clearSession, requestLoginQr, checkLoginQr, sendSmsCode, loginBySmsCode } from '../../utils/auth.js';
import { loadUserState, persistUserState, stateKeyOf, followKeyOf, loadHistory, addHistory, removeHistory, clearHistory } from '../../utils/user-state.js';
import { jsapiHttpRequest, previewPayload, storageSelfCheck } from '../../services/libjsapi.js';
import { videoCapsText } from '../../services/video-caps.js';
import { loadCookies, cookieSummary, hasLoginCookie, cookieCount, clearCookies, saveCookiesFromText, inspectRawForCookies } from '../../services/session-cookies.js';
import { fetchItemInfo } from '../../services/douyin-api.js';
import { available as nativeVideoAvailable, playUrlCandidates, badHostList, probeCandidatesViaRelay, relayPlayableUrl, play as nativePlay, stop as nativeStop } from '../../services/native-player.js';
import { setPendingPlay } from '../../services/play-request.js';
import { API_RELAY, DOUYIN_HOT_FEED_API, APP_VERSION } from '../../config.js';

// 设备屏是**逻辑横屏 800×254**（物理 254×800，运行时 direction=270）。
// 之前按竖屏 254×800 写的滑动距离/尺寸在笔上是错的，这里统一按横屏。
const HEIGHT = 254;
const WIDTH = 800;

export default {
  name: 'Douyin',
  components: { FramePlayer, VideoPlayer, ImeField, PinyinIme },
  data() {
    return {
      HEIGHT,
      WIDTH,
      // 左侧分区栏条目（替代底部导航栏）
      sections: [
        { idx: 0, label: '视频' },
        { idx: 1, label: '搜索' },
        { idx: 2, label: '发布' },
        { idx: 3, label: '消息' },
        { idx: 4, label: '我的' }
      ],
      tab: 'rec',
      dockIdx: 0,
      cur: 0,
      dragY: 0,
      startY: 0,
      startX: 0,
      moving: false,
      settleTimer: null,
      commentIndex: -1,
      shareIndex: -1,
      commentDraft: '',
      draft: '',
      toast: '',
      dataSource: '',
      offlineFallback: false,
      cookieText: '',
      nativeVideoReady: false,
      sourceErrors: [],
      session: null,
      loginQr: null,
      loginStatus: '',
      loginFailCount: 0,
      loginPollTimer: null,
      userState: { liked: {}, followed: {}, collected: {} },
      history: [],
      showHistory: false,
      netDiag: [],
      netDiagRunning: false,
      // 上次「点解析」的结果（成功/失败 + 关键字段），网络诊断第 12 行会显示
      lastResolve: '',
      phone: '',
      smsCode: '',
      smsCountdown: 0,
      cookieDraft: '',
      searchQuery: '',
      manualUrl: '',
      myVideoQuery: '',
      notifications: [],
      list: [],
      imeTarget: ''
    };
  },
  created() {
    // 先把本机保存的登录 Cookie 灌进内存，之后的抖音请求才能带上登录态
    loadCookies().then(() => {
      this.cookieText = cookieSummary();
      this.loadVideos();
    });
    // 探测随包的原生播放模块（决定点视频是进原生播放页还是页内播放）
    nativeVideoAvailable().then((ok) => { this.nativeVideoReady = !!ok; }).catch(() => {});
    loadUserState().then((state) => {
      this.userState = state;
      this.applyUserState();
    });
    loadHistory().then((history) => {
      this.history = history;
    });
    readSession().then((session) => {
      this.session = session;
    });
  },
  beforeDestroy() {
    this.stopLoginPoll();
    clearInterval(this._smsTimer);
    this._smsTimer = null;
  },
  computed: {
    visibleList() {
      if (this.tab === 'live') return this.list.filter((item) => item.live);
      if (this.tab === 'follow') return this.list.filter((item) => item.followed);
      return this.list;
    },
    likedCount() {
      return this.list.filter((item) => item.liked).length;
    },
    collectedCount() {
      return this.list.filter((item) => item.collected).length;
    },
    collectedItems() {
      return this.list
        .map((item, index) => ({ item, index }))
        .filter((entry) => entry.item.collected);
    },
    avatarLetter() {
      const nick = this.session && this.session.nick;
      return nick ? nick.slice(0, 1).toUpperCase() : '抖';
    },
    loginTimeText() {
      const at = this.session && this.session.loginAt;
      if (!at) return '已登录';
      try {
        return '扫码登录 ' + new Date(at).toISOString().slice(0, 10);
      } catch (error) {
        return '已登录';
      }
    },
    loginStatusText() {
      const map = {
        loading: '正在获取二维码…',
        waiting: '等待扫码…',
        new: '等待扫码…',
        scanned: '已扫码，请在手机上确认',
        confirmed: '登录成功',
        expired: '二维码已过期，请点击刷新',
        refused: '已取消登录',
        error: '网络异常，请点击刷新'
      };
      return map[this.loginStatus] || '';
    },
    appVersion() {
      // 目标：**必须能可靠报出真实版本号**。
      // 为什么重要：真机排查时"用户装的是哪个包"是第一件事。
      // 早前这里只试 `$falcon.__AppClazz.meta.version`，取不到就返回 ''，
      // 模板再回退成硬编码 '1.0.0' → **装了新包也显示 1.0.0**（真机踩过，误事）。
      // 现在**首选 config.js 里的权威常量**（和 package.json 同步维护），
      // 运行时那几处只作为兜底。
      if (APP_VERSION) return APP_VERSION;
      try {
        if (typeof $falcon !== 'undefined' && $falcon && $falcon.__AppClazz && $falcon.__AppClazz.meta) {
          const v = $falcon.__AppClazz.meta.version;
          if (v) return String(v);
        }
      } catch (error) { /* 继续试下一个来源 */ }
      try {
        if (typeof $falcon !== 'undefined' && $falcon && $falcon.__AppInfo) {
          const v = $falcon.__AppInfo.version || ($falcon.__AppInfo.meta && $falcon.__AppInfo.meta.version);
          if (v) return String(v);
        }
      } catch (error) { /* 继续 */ }
      try {
        const app = (typeof getApp === 'function') ? getApp() : null;
        if (app && app.meta && app.meta.version) return String(app.meta.version);
      } catch (error) { /* 继续 */ }
      return '';
    },
    // 版本号的来源（诊断用）：让"读不到版本"这件事本身可见，而不是悄悄回退
    appVersionSource() {
      if (APP_VERSION) return 'config.js（权威）';
      try {
        if (typeof $falcon !== 'undefined' && $falcon && $falcon.__AppClazz && $falcon.__AppClazz.meta
          && $falcon.__AppClazz.meta.version) return 'AppClazz.meta';
      } catch (error) { /* 忽略 */ }
      try {
        if (typeof $falcon !== 'undefined' && $falcon && $falcon.__AppInfo) return '__AppInfo';
      } catch (error) { /* 忽略 */ }
      try {
        if (typeof getApp === 'function' && getApp() && getApp().meta) return 'getApp().meta';
      } catch (error) { /* 忽略 */ }
      return '读不到（显示的是回退值，不代表真实版本）';
    },
    // 登录态 Cookie 一行摘要（依赖 this.cookieText 以便登录后自动刷新）
    cookieLine() {
      const summary = this.cookieText || cookieSummary();
      if (!this.session) return '未登录（登录后会在抖音请求里带上登录态 Cookie）';
      if (hasLoginCookie()) return '登录态 Cookie：' + summary;
      return '登录态 Cookie：未取到 —— 设备端读不到响应头，可在 config.js 配置 LOGIN_HELPER 指向 PC 中转抓取';
    },
    myVideoResults() {
      const query = (this.myVideoQuery || '').trim().toLocaleLowerCase();
      return this.findVideos(query);
    },
    searchResults() {
      const query = (this.searchQuery || '').trim().toLocaleLowerCase();
      return this.findVideos(query);
    }
  },
  methods: {
    // ---------- 返回主主页 ----------
    // 本页从「笔上抖音」进入，返回按钮回主主页，不要依赖导航栈深度。
    backHome() {
      const falcon = typeof $falcon !== 'undefined' && $falcon ? $falcon : null;
      if (falcon && typeof falcon.navTo === 'function') {
        try {
          falcon.navTo('home', {});
          return;
        } catch (error) {
          /* 落到 navBack 兜底 */
        }
      }
      if (falcon && typeof falcon.navBack === 'function') {
        try {
          falcon.navBack();
          return;
        } catch (error) {
          /* 无返回 API，忽略（模拟器预览可接受） */
        }
      }
    },

    // ---------- 内嵌拼音输入法（PinyinIme）事件路由 ----------
    onImeFocus(name) {
      this.imeTarget = name;
    },
    onImeCommit(text) {
      if (!this.imeTarget) return;
      this[this.imeTarget] = String(this[this.imeTarget] || '') + String(text);
    },
    onImeInsert(ch) {
      if (!this.imeTarget) return;
      this[this.imeTarget] = String(this[this.imeTarget] || '') + String(ch);
    },
    onImeDelete() {
      if (!this.imeTarget) return;
      const cur = String(this[this.imeTarget] || '');
      this[this.imeTarget] = cur.slice(0, Math.max(0, cur.length - 1));
    },
    onImeDone() {
      this.imeTarget = '';
    },
    findVideos(query) {
      return this.list.reduce((results, item, index) => {
        const searchable = [item.title, item.scene, item.author, item.desc, item.videoId, item.url]
          .filter(Boolean)
          .join(' ')
          .toLocaleLowerCase();
        if (!query || searchable.indexOf(query) >= 0) results.push({ item, index });
        return results;
      }, []);
    },
    playingOf(i) {
      return !!this.visibleList[i] && !!this.visibleList[i].frames.length && this.cur === i && !this.visibleList[i].paused;
    },
    // 上一条/下一条“视频”：只在真正有视频的条目之间跳（热榜话题没有视频文件，
    // 跳过它们），到头会循环；整个列表都没有视频条目时退化为前后翻一条。
    jumpVideo(dir) {
      const vis = this.visibleList;
      if (!vis.length) return;
      const isVideo = (item) => !!(item && (item.playUrl || item.videoLink || isVideoLink(item.url)));
      const hasVideo = vis.some(isVideo);

      if (!hasVideo) {
        const fallback = this.cur + dir;
        if (fallback < 0 || fallback >= vis.length) {
          this.showToast(dir > 0 ? '已经是最后一条了' : '已经是第一条了');
          return;
        }
        this.go(fallback);
        return;
      }

      for (let step = 1; step <= vis.length; step++) {
        const idx = ((this.cur + dir * step) % vis.length + vis.length) % vis.length;
        if (!isVideo(vis[idx])) continue;
        if (idx === this.cur) {
          this.showToast('当前只有这一条视频');
          return;
        }
        this.go(idx); // go() 内部会触发该条的自动解析
        return;
      }
    },
    // 明确区分“能播的视频/帧动画”和“热榜话题”——话题只有封面，本来就没有视频文件
    itemKind(item) {
      if (!item) return '话题';
      if (item.resolving) return '解析中';
      if (item.playUrl) return '视频';
      if (item.frames.length) return '短片';
      return '话题';
    },
    // 头像/占位图用作者首字：emoji 在词典笔屏幕上不显示
    avatarChar(item) {
      const name = String((item && item.author) || '').trim();
      return name ? name.slice(0, 1) : '视';
    },
    // 只有“视频条目但还没解析出播放地址”时才在封面上给提示
    coverHint(item) {
      if (!item || item.playUrl || item.frames.length) return '';
      if (!item.videoLink && !isVideoLink(item.url)) return '';
      return item.resolving ? '解析中…' : '点击解析播放';
    },
    // 点击封面：有播放地址就进原生播放页；视频条目先解析再进；话题给出说明
    onCoverTap(item) {
      const index = this.list.indexOf(item);
      if (index < 0) return;
      if (item.playUrl) {
        this.openNativePlayer(item);
        return;
      }
      this.ensurePlayable(index, true);
    },
    // 打开原生横屏播放页（真播放靠随包的原生模块；没有模块时退回页内 HTML5 播放）
    async openNativePlayer(item) {
      if (!item || !item.playUrl) return;
      // ★ 这里**不再**用 nativePlayableUrl() 预先挑一个地址。
      //   原因（真 bug）：那个函数会 (1) 优先挑 `play_addr.url_list` 里的**直链 CDN**
      //   —— 而 HANDOFF §13.2 实测那些直链**恒 403**（douyin-api.js 里自己都写了这条警告）；
      //   (2) 把 https **改写成明文 http** —— 那是"模块没有 TLS"的旧前提，
      //   早已被真机诊断推翻（§13.7 `OK 1280x720`）。
      //   两者叠加会把好好的跳板入口换成打不开的地址。
      //   现在把**原始 playUrl + 候选**整体交给播放页，由它的 startWithFallback 按序试
      //   （那才是 §13.5 验证过 22/22 的那条路）。**选地址的职责只留一处。**
      const url = item.playUrl;
      const name = item.title || item.scene || '视频';
      setPendingPlay({ path: url, name: name, candidates: item.playCandidates || [] });
      try {
        const ready = this.nativeVideoReady || (await nativeVideoAvailable());
        this.nativeVideoReady = ready;
        if (ready && typeof $falcon !== 'undefined' && $falcon && typeof $falcon.navTo === 'function') {
          $falcon.navTo('player', { path: url, name: name, candidates: item.playCandidates || [] });
          return;
        }
      } catch (error) {
        /* 原生不可用则走页内播放 */
      }
      const index = this.list.indexOf(item);
      if (index >= 0) this.openVideo(index);
    },
    // 按需解析视频条目的播放地址：点开/滑到该条时触发（force = 用户主动点击，失败也重试）
    ensurePlayable(index, force) {
      const item = this.list[index];
      if (!item || item.playUrl || item.resolving) return;
      const link = item.videoLink || (isVideoLink(item.url) ? item.url : '');
      if (!link) {
        if (force) {
          this.showToast('该条是热搜话题，本身没有视频文件；可用顶部“导入”粘贴分享链接', 2800);
        }
        return;
      }
      if (item.resolveFailedAt && !force) return; // 自动触发时失败过就不再反复请求

      this.$set(this.list, index, Object.assign({}, item, { resolving: true }));
      this.showToast('正在解析视频…', 1200);
      resolveVideoForItem(item).then((parsed) => {
        const current = this.list[index];
        if (!current) return;
        // 原地改字段，**不替换数组元素**：这些字段本来就在条目上，赋值即触发响应式更新。
        // 同时刻意不动 scene/author 以外会参与 v-for key 的字段顺序问题（key 已换成 slideKey）。
        const patch = {
          resolving: false,
          resolveFailedAt: 0,
          playUrl: parsed.playUrl || current.playUrl,
          cover: parsed.cover || current.cover,
          title: parsed.title || current.title,
          desc: parsed.desc || parsed.title || current.desc,
          author: parsed.author || current.author,
          likes: parsed.likes || current.likes,
          comments: parsed.comments || current.comments,
          shares: parsed.shares || current.shares,
          videoId: parsed.videoId || current.videoId,
          playCandidates: parsed.playCandidates || current.playCandidates
        };
        Object.keys(patch).forEach((key) => { current[key] = patch[key]; });
        this.lastResolve = '成功 · 标题「' + String(parsed.title || '').slice(0, 14) + '」· playUrl '
          + (parsed.playUrl ? '有' : '空') + ' · videoId ' + (parsed.videoId ? '有' : '空');
        this.list = this.list.slice();
        this.showToast('解析完成，开始播放', 1200);
        // 用户主动点开 → 解析完直接进原生播放页
        if (force) this.openNativePlayer(current);
      }).catch((error) => {
        const current = this.list[index];
        if (current) {
          current.resolving = false;
          current.resolveFailedAt = Date.now();
        }
        this.lastResolve = '失败 · ' + ((error && error.message) || '未知原因');
        this.showToast('解析失败：' + ((error && error.message) || '未知原因'), 3000);
      });
    },
    go(i) {
      const n = this.visibleList.length;
      if (!n) return;
      if (this.settleTimer) {
        clearTimeout(this.settleTimer);
        this.settleTimer = null;
      }
      // 边界钳制：不循环——顶部往回滑弹出观看历史，底部上滑提示到底
      const next = i < 0 ? 0 : i >= n ? n - 1 : i;
      this.visibleList.forEach((it) => { it.paused = true; });
      this.visibleList[next].paused = false;
      this.cur = next;
      this.dragY = 0;
      this.recordHistory(this.visibleList[next]);
      // 滑到视频条目时自动解析出播放地址
      this.ensurePlayable(this.list.indexOf(this.visibleList[next]), false);
    },
    recordHistory(item) {
      if (!item) return;
      addHistory(this.history, item).then((history) => {
        this.history = history;
      });
    },
    // 本地状态（点赞/关注/收藏）异步加载完成后回填到已加载的列表
    applyUserState() {
      this.list = this.list.map((item) => ({
        ...item,
        liked: !!this.userState.liked[stateKeyOf(item)],
        collected: !!this.userState.collected[stateKeyOf(item)],
        followed: !!this.userState.followed[followKeyOf(item.author)] || !!item.followed
      }));
    },
    selectFeed(tab) {
      this.tab = tab;
      this.cur = 0;
      this.dragY = 0;
    },
    async loadVideos() {
      try {
        const result = await fetchVideoList();
        const videos = result.list;
        this.dataSource = result.dataSource;
        this.sourceErrors = result.errors || [];
        this.offlineFallback = !!result.offline;
        this.list = videos.map((item, index) => ({
          ...item,
          liked: !!this.userState.liked[stateKeyOf(item)],
          collected: !!this.userState.collected[stateKeyOf(item)],
          followed: !!this.userState.followed[followKeyOf(item.author)] || !!item.followed,
          heart: false,
          paused: index === 0 ? false : true,
          interval: item.interval || 125,
          frames: Array.isArray(item.frames) ? item.frames : [],
          commentList: Array.isArray(item.commentList) && item.commentList.length
            ? item.commentList
            : [{ author: '影像爱好者', text: '氛围感很棒！' }]
        }));
        if (!this.list.length) {
          this.list = [];
          return;
        }
        if (this.cur >= this.list.length) this.cur = 0;
        this.recordHistory(this.list[this.cur]);
        if (this.offlineFallback) {
          // 接口全挂时不要静默：把第一个失败原因直接抛到屏幕上
          this.showToast('接口未连通，已回退离线样例：' + (this.sourceErrors[0] || ''), 3000);
        } else {
          // 首屏就是视频条目时自动解析，打开即可播放
          this.ensurePlayable(this.cur, false);
        }
      } catch (error) {
        this.list = [];
        this.toast = '视频列表加载失败，已回退到本地示例';
        setTimeout(() => { this.toast = ''; }, 1800);
      }
    },
    reloadVideos() {
      this.showToast('正在重新加载视频…', 1200);
      this.loadVideos();
    },
    async addVideoFromUrl() {
      const value = (this.manualUrl || '').trim();
      if (!value) {
        this.toast = '请输入抖音分享链接';
        setTimeout(() => { this.toast = ''; }, 1600);
        return;
      }

      try {
        this.toast = '正在抓取视频信息…';
        const item = await resolveVideoFromLink(value, this.list.length);
        // 导入的真视频落本机存储：重启后仍在信息流最前面，点开即可播
        if (item && item.playUrl) saveImportedVideo(item);
        this.list.unshift({
          ...item,
          liked: false,
          heart: false,
          paused: false,
          interval: 125,
          frames: [],
          commentList: item.commentList || [{ author: '影像爱好者', text: '本地抓取视频已导入！' }]
        });
        this.manualUrl = '';
        this.imeTarget = '';
        this.toast = item.playUrl ? '已导入，可播放' : '已导入视频列表';
      } catch (error) {
        this.toast = error.message || '抓取失败';
      }
      setTimeout(() => { this.toast = ''; }, 1800);
    },
    selectPage(index) {
      this.closeSheets();
      this.imeTarget = '';
      this.dockIdx = index;
    },
    openVideo(index) {
      this.tab = 'rec';
      this.dockIdx = 0;
      this.visibleList.forEach((item) => { item.paused = true; });
      this.list[index].paused = false;
      this.cur = index;
      this.dragY = 0;
      // 从列表点进来：自动解析该视频条目的播放地址
      this.ensurePlayable(index, false);
    },
    togglePause(i) {
      if (i === this.cur && this.visibleList[i]) this.visibleList[i].paused = !this.visibleList[i].paused;
    },
    togglePlayback(i) {
      if (this.visibleList[i]) this.visibleList[i].paused = !this.visibleList[i].paused;
      if (i !== this.cur && this.visibleList[i]) this.cur = i;
    },
    like(i) {
      const item = this.visibleList[i];
      if (!item) return;
      item.liked = !item.liked;
      item.heart = true;
      const key = stateKeyOf(item);
      if (item.liked) {
        this.userState.liked[key] = true;
        this.notifications.unshift('你赞了 @' + item.author + ' 的作品');
      } else {
        delete this.userState.liked[key];
      }
      persistUserState(this.userState);
      setTimeout(() => { item.heart = false; }, 900);
    },
    followAuthor(i) {
      const item = this.visibleList[i];
      if (!item) return;
      const key = followKeyOf(item.author);
      const followed = !this.userState.followed[key];
      if (followed) this.userState.followed[key] = true;
      else delete this.userState.followed[key];
      item.followed = followed;
      persistUserState(this.userState);
      if (followed) this.notifications.unshift('你关注了 @' + item.author);
      this.showToast(followed ? '已关注 @' + item.author : '已取消关注 @' + item.author);
    },
    collectItem(i) {
      const item = this.visibleList[i];
      if (!item) return;
      const key = stateKeyOf(item);
      const collected = !this.userState.collected[key];
      if (collected) this.userState.collected[key] = true;
      else delete this.userState.collected[key];
      item.collected = collected;
      persistUserState(this.userState);
      if (collected) this.notifications.unshift('你收藏了「' + (item.title || item.scene) + '」');
      this.showToast(collected ? '已收藏' : '已取消收藏');
    },
    canFollow(item) {
      // 聚合类条目的"作者"是数据源而非真实用户，不提供关注
      return ['抖音热榜', '抖音热搜', '本地导入'].indexOf(item.author) < 0;
    },

    // ---------- 观看历史（找回刷掉的视频） ----------
    openHistory() {
      this.closeSheets();
      this.showHistory = true;
    },
    closeHistory() {
      this.showHistory = false;
    },
    jumpToHistory(entry) {
      this.closeHistory();
      const idx = this.list.findIndex((it) => stateKeyOf(it) === entry.key);
      if (idx >= 0) {
        this.openVideo(idx);
        return;
      }
      // 视频已不在当前列表（如热榜已刷新）→ 重建条目插到最前并跳转
      const item = {
        key: entry.key,
        videoId: entry.videoId,
        author: entry.author,
        desc: entry.desc,
        music: '历史回看',
        emoji: '',
        scene: entry.title,
        likes: entry.likes,
        comments: 0,
        shares: 0,
        bg: '#3d4a63',
        followed: false,
        live: false,
        liked: false,
        heart: false,
        paused: false,
        interval: 125,
        frames: [],
        title: entry.title,
        url: entry.url,
        playUrl: entry.playUrl,
        cover: entry.cover,
        source: entry.source || 'history',
        commentList: [{ author: '影像爱好者', text: '从观看历史找回的视频' }]
      };
      this.list = [item].concat(this.list);
      this.tab = 'rec';
      this.dockIdx = 0;
      this.list.forEach((it, i) => { it.paused = i !== 0; });
      this.cur = 0;
      this.dragY = 0;
      this.recordHistory(item);
      this.showToast('已找回：' + entry.title.slice(0, 12));
    },
    removeHistoryItem(entry) {
      removeHistory(this.history, entry.key).then((history) => {
        this.history = history;
      });
    },
    clearHistoryItems() {
      clearHistory().then((history) => {
        this.history = history;
        this.showToast('观看历史已清空');
      });
    },
    fmtTime(ts) {
      const dt = new Date(ts);
      const pad = (v) => (v < 10 ? '0' + v : '' + v);
      return pad(dt.getMonth() + 1) + '-' + pad(dt.getDate()) + ' ' + pad(dt.getHours()) + ':' + pad(dt.getMinutes());
    },

    // ---------- 手机号登录（爬网页端 passport 接口） ----------
    async sendCode() {
      if (this.smsCountdown > 0) return;
      const mobile = String(this.phone || '').replace(/\D/g, '');
      if (!/^1\d{10}$/.test(mobile)) {
        this.showToast('请输入 11 位手机号', 2200);
        return;
      }
      this.imeTarget = '';
      this.showToast('正在获取验证码…', 1500);
      try {
        const r = await sendSmsCode(mobile);
        this.showToast((r && r.description) || '验证码已发送', 2600);
        this.cookieText = cookieSummary();
        this.startSmsCountdown();
      } catch (error) {
        this.showToast('发送失败：' + ((error && error.message) || ''), 3000);
      }
    },
    startSmsCountdown() {
      this.smsCountdown = 60;
      clearInterval(this._smsTimer);
      this._smsTimer = setInterval(() => {
        this.smsCountdown -= 1;
        if (this.smsCountdown <= 0) {
          clearInterval(this._smsTimer);
          this._smsTimer = null;
        }
      }, 1000);
    },
    async phoneLogin() {
      const mobile = String(this.phone || '').replace(/\D/g, '');
      const code = String(this.smsCode || '').replace(/\D/g, '');
      if (!/^1\d{10}$/.test(mobile)) {
        this.showToast('请输入 11 位手机号', 2200);
        return;
      }
      if (!/^\d{4,6}$/.test(code)) {
        this.showToast('请输入短信验证码', 2200);
        return;
      }
      this.imeTarget = '';
      this.showToast('正在登录…', 1500);
      try {
        const result = await loginBySmsCode(mobile, code);
        if (!result.ok) {
          this.showToast('登录失败：' + (result.descriptions || ''), 3000);
          return;
        }
        const session = {
          nick: (result.user && result.user.nick) || mobile,
          id: (result.user && result.user.id) || mobile,
          loginAt: Date.now(),
          cookieCount: result.cookieCount || 0,
          cookieKeys: result.cookieKeys || [],
          via: 'sms'
        };
        await saveSession(session);
        this.session = session;
        this.cookieText = cookieSummary();
        this.smsCode = '';
        clearInterval(this._smsTimer);
        this.smsCountdown = 0;
        this.showToast(hasLoginCookie()
          ? ('登录成功，已抓到 ' + result.cookieCount + ' 项会话 Cookie（来自响应体/跳转）')
          : '登录成功，但未取到会话 Cookie —— 本机固件不回传响应头，请用上面的「粘贴 Cookie 登录」', 4000);
        this.loadVideos();
      } catch (error) {
        this.showToast('登录失败：' + ((error && error.message) || ''), 3000);
      }
    },
    // 手动粘贴 Cookie 登录：不依赖响应头，因此完全不需要中转
    async applyPastedCookies() {
      const text = String(this.cookieDraft || '').trim();
      if (!text) {
        this.showToast('请先粘贴 Cookie', 2000);
        return;
      }
      this.imeTarget = '';
      const saved = await saveCookiesFromText(text);
      this.cookieDraft = '';
      this.cookieText = cookieSummary();
      if (saved.count === 0) {
        this.showToast('没解析出会话 Cookie，请确认复制的是完整 Cookie 串', 3000);
        return;
      }
      if (!this.session) {
        const session = {
          nick: hasLoginCookie() ? 'Cookie 登录' : '抖音用户',
          id: 'cookie',
          loginAt: Date.now(),
          cookieCount: saved.count,
          cookieKeys: saved.keys,
          via: 'paste'
        };
        await saveSession(session);
        this.session = session;
      }
      this.showToast('已保存 ' + saved.count + ' 项 Cookie：' + saved.keys.slice(0, 3).join(','), 3000);
      this.loadVideos();
    },
    // ---------- 网络诊断：分段定位“视频页为什么没数据” ----------
    async runNetDiag() {
      if (this.netDiagRunning) return;
      this.netDiagRunning = true;
      this.netDiag = ['诊断中…'];
      const steps = [];

      steps.push('0 运行模式: ' + (API_RELAY ? '中转 ' + API_RELAY : '直连 https'));
      steps.push('0 视频页数据源: ' + (this.dataSource || '未知') + (this.offlineFallback ? '（离线样例＝接口没通）' : '（在线）'));

      // 1) 热榜接口直连：必须校验响应体。旧版只看“请求没抛错”就报 OK，
      //    会把“连上了但拿不到数据”误判成固件支持 TLS，从而掩盖真实断点。
      //    这里同时用 withMeta 取原始响应对象，判断“不开中转能不能抓到 Set-Cookie”。
      let directOk = false;
      try {
        const meta = await jsapiHttpRequest({ url: DOUYIN_HOT_FEED_API, timeoutMs: 10000, direct: true, withMeta: true });
        const payload = meta.body;
        const raw = inspectRawForCookies(meta.raw);
        steps.push('1 响应外层键: ' + (raw.envelopeKeys.length ? raw.envelopeKeys.join(',') : '（非对象）')
          + (raw.hasHeaders ? ' · 含 header/headers' : ' · 无 header 字段'));
        steps.push('1 响应头含 Set-Cookie: ' + (raw.cookieNames.length ? ('是（' + raw.cookieNames.join(',') + '）→ 可不开中转') : '否 → 抓会话需中转或粘贴 Cookie'));
        if (payload && Number(payload.code) === 200 && Array.isArray(payload.data)) {
          directOk = true;
          steps.push('1 直连热榜接口: OK ' + payload.data.length + ' 条'
            + (payload.data[0] ? ' · 首条「' + String(payload.data[0].title || '').slice(0, 12) + '」' : ''));
        } else {
          steps.push('1 直连热榜接口: 响应异常 ' + previewPayload(payload));
        }
      } catch (error) {
        steps.push('1 直连热榜接口失败: ' + ((error && error.message) || '') + '（固件无TLS时请配置中转）');
      }

      // 2) 中转通路（仅在配置了 API_RELAY 时）
      if (API_RELAY) {
        try {
          const r2 = await jsapiHttpRequest({
            url: API_RELAY + '/relay?url=' + encodeURIComponent(DOUYIN_HOT_FEED_API),
            timeoutMs: 15000
          });
          steps.push('2 经中转拉热榜: ' + (r2 && Number(r2.code) === 200
            ? 'OK ' + ((r2.data || []).length) + ' 条'
            : '响应异常 ' + previewPayload(r2)));
        } catch (error) {
          steps.push('2 经中转拉热榜失败: ' + ((error && error.message) || '') + '（检查PC中转是否运行/同网段）');
        }
      } else {
        steps.push('2 未配置中转：所有请求直连 https');
      }

      // 3) 端到端：真正跑一遍视频列表加载链路，看它最终落到了哪个数据源
      try {
        const result = await fetchVideoList();
        steps.push('3 数据链路: ' + result.dataSource + ' · ' + ((result.list || []).length) + ' 条');
        (result.errors || []).forEach((err) => steps.push('3 · ' + err));
      } catch (error) {
        steps.push('3 数据链路失败: ' + ((error && error.message) || ''));
      }

      steps.push('4 应用版本: ' + (this.appVersion || '未知') + '（来源: ' + this.appVersionSource + '）');
      steps.push('5 视频组件: ' + videoCapsText());

      // 6) 登录态与 Cookie：登录态数据全靠 Cookie，设备端读不到响应头时需要 LOGIN_HELPER
      steps.push('6 登录态: ' + (this.session ? '已登录' : '未登录') + ' · Cookie ' + cookieSummary());

      // 7) 登录态接口自检：iteminfo 未登录会返回 11110，登录后应能拿到 item_list
      try {
        const ids = this.list
          .map((item) => String(item.videoId || ''))
          .filter((id) => /^\d{10,}$/.test(id))
          .slice(0, 2);
        if (!ids.length) throw new Error('信息流里暂无视频 id（先点开一条视频再诊断）');
        const items = await fetchItemInfo(ids);
        steps.push('7 登录态接口 iteminfo: OK ' + items.length + ' 条 · 首条「'
          + String(items[0].title || '').slice(0, 12) + '」');
      } catch (error) {
        steps.push('7 登录态接口 iteminfo: ' + ((error && error.message) || ''));
      }

      // 8) 原生播放模块：本运行时没有 <video> 组件，真播放全靠随包的原生模块
      try {
        const ok = await nativeVideoAvailable();
        steps.push('8 原生播放模块 video: ' + (ok ? '可用' : '不可用（libs/*.so 未随包或未被加载）'));
      } catch (error) {
        steps.push('8 原生播放模块 video: 异常 ' + ((error && error.message) || ''));
      }

      // 9) 页面导航能力：解析出播放地址后要跳到原生横屏播放页，缺这个 API 就跳不过去
      try {
        const f = (typeof $falcon !== 'undefined' && $falcon) || {};
        const found = ['navTo', 'navigate', 'push', 'openPage', 'redirectTo', 'navBack']
          .filter((name) => typeof f[name] === 'function');
        steps.push('9 页面导航 API: ' + (found.length ? found.join(',') : '未发现（无法进入原生播放页）'));
      } catch (error) {
        steps.push('9 页面导航 API: 异常 ' + ((error && error.message) || ''));
      }

      // 11) 原生 https 直连播放测试：固件 FFmpeg 若自带 TLS，就完全不用中转（也不需要登录）
      //     用一个固定的公开视频 id 直接试播；会短暂占用屏幕（原生绘制在 fb 上），随后 stop。
      const PROBE_URL = 'https://aweme.snssdk.com/aweme/v1/play/?video_id=v0d00fg10000crr51nvog65hoikd5f6g';
      try {
        const probeUrl = PROBE_URL;
        const pr = await nativePlay({
          path: probeUrl,
          screenW: 800,
          screenH: 254,
          rectX: 0,
          rectY: 0,
          rectW: 800,
          rectH: 254,
          maxW: 800,
          maxH: 254,
          rate: 1,
          volume: 0
        });
        steps.push('11 原生 https 直连播放: ' + (pr && pr.ok
          ? ('OK ' + (pr.videoW || '?') + 'x' + (pr.videoH || '?') + ' → 固件 FFmpeg 自带 TLS，无需中转')
          : ('失败 ' + ((pr && pr.error) || '未知'))));
        try { await nativeStop(); } catch (error) { /* 忽略 */ }
      } catch (error) {
        steps.push('11 原生 https 直连播放: 异常 ' + ((error && error.message) || ''));
      }

      // 12) ★★ 关键对照：用**完全相同的方式**去播 feed 里的第一条视频。
      //     为什么必须做：第 11 行证明"原生模块 + TLS"是好的（那个固定 id 能播），
      //     但 feed 的视频全部黑屏。两者差别只能在"具体地址/字节流"上。
      //     这一步把结论收敛成两种，之后不用再猜：
      //       · 这里也 OK  → 模块与网络都没问题，问题在"播放页的调度/参数"
      //       · 这里失败   → 问题在这些具体地址（再看下面 13/14 行的探测结果）
      try {
        const first = this.list[0];
        const firstUrl = first && first.playUrl;
        if (!firstUrl) {
          steps.push('12 feed 首条实播: 首条还没有播放地址（等列表加载完再测）');
        } else {
          const cand = playUrlCandidates(firstUrl, []);
          const tryUrl = (cand && cand[0]) || firstUrl;
          steps.push('12 feed 首条实播: 用 ' + String(tryUrl).replace(/^https?:\/\//, '').slice(0, 46) + '…');
          const fr = await nativePlay({
            path: tryUrl,
            screenW: 800, screenH: 254,
            rectX: 0, rectY: 0, rectW: 800, rectH: 254,
            maxW: 800, maxH: 254, rate: 1, volume: 0
          });
          if (fr && fr.ok) {
            const hasSize = !!(fr.videoW && fr.videoH);
            steps.push('12 feed 首条实播: ok=' + fr.videoW + 'x' + fr.videoH
              + (hasSize ? ' → 能播' : ' → **打开了但无视频流**（就是黑屏的那种）'));
          } else {
            steps.push('12 feed 首条实播: 失败 ' + ((fr && fr.error) || '未知'));
          }
          try { await nativeStop(); } catch (error) { /* 忽略 */ }
        }
      } catch (error) {
        steps.push('12 feed 首条实播: 异常 ' + ((error && error.message) || ''));
      }
      // 12) 首条条目状态 + 上次解析结果：定位“解析成功但界面没反应”
      try {
        const first = this.list[0] || {};
        steps.push('12 首条: ' + (first.videoLink || isVideoLink(first.url) ? '视频条目' : '话题')
          + ' · ' + (first.playUrl ? '已解析' : '未解析')
          + ' · videoId ' + (first.videoId ? '有' : '无')
          + ' · 封面 ' + (first.cover ? '有' : '无')
          + ' · 标题「' + String(first.title || '').slice(0, 16) + '」');
        steps.push('12 上次解析: ' + (this.lastResolve || '（本次启动还没点过解析）'));
      } catch (error) {
        steps.push('12 首条: 检测失败 ' + ((error && error.message) || ''));
      }

      // 13/14) 候选 + **中转探测**：让 PC 中转去试，回报"能不能连上 / HTTP 状态 / 是不是视频"。
      //     ⛔ 设备端**绝不能自己 GET 视频地址**（二进制灌进原生字符串通道 → 词典笔软重启，
      //     见 HANDOFF §9/§13.10）。所以这一步只读中转回的几十字节 JSON。
      //     探测**同时**对"直连地址"和"套了中转的地址"各做一次，用来分辨失败在哪一层。
      try {
        const first = this.list[0];
        const firstUrl = (first && first.playUrl) || '';
        const cand = playUrlCandidates(firstUrl, []);
        const bad = badHostList();
        steps.push('13 播放候选: ' + cand.length + ' 个'
          + (cand.length ? '（首个 ' + String(cand[0]).replace(/^https?:\/\//, '').slice(0, 34) + '）' : '（首条还没有播放地址）')
          + ' · 已知坏主机 ' + (bad.length ? bad.join(',') : '无'));

        if (!cand.length) {
          steps.push('14 中转探测: 无候选可探');
        } else {
          // ① 探"不套中转的原始入口"：中转会自己去连，回报落点状态
          const raw = await probeCandidatesViaRelay([cand[0]], { limit: 1, timeoutMs: 9000 });
          if (!raw) {
            steps.push('14 探测(直连入口): 未启用中转（API_RELAY 为空）或探测失败');
          } else if (raw.good.length) {
            steps.push('14 探测(直连入口): 可达 ✅');
          } else {
            const b = raw.bad[0] || {};
            let host = '';
            const m = /^https?:\/\/([^/?#]+)/i.exec(String(b.url || ''));
            if (m) host = m[1];
            steps.push('14 探测(直连入口): **连不上** ❌ host=' + host + ' · ' + String(b.error || '').slice(0, 40));
          }
          // ② 探"套了中转的地址"：这是设备实际会用的播放路径（中转补 Referer 并跟 302）
          const relayed = relayPlayableUrl(cand[0]);
          if (relayed) {
            const viaRelay = await probeCandidatesViaRelay([relayed], { limit: 1, timeoutMs: 9000 });
            if (viaRelay && viaRelay.good.length) {
              steps.push('14 探测(经中转): 可达 ✅ → 走中转能播，直连不通');
            } else if (viaRelay) {
              const b = viaRelay.bad[0] || {};
              steps.push('14 探测(经中转): **连不上** ❌ ' + String(b.error || '').slice(0, 46));
            }
          } else {
            steps.push('14 探测(经中转): 未启用中转（API_RELAY 为空）');
          }

          // ③ 探测自身的自检：用一个**已知能播**的固定地址探一次。
          //    为什么要有它：探测若因为"中转地址没配对"而静默返回 null，前面两行都只会
          //    显示"未启用/探测失败"，分不清是"入口坏"还是"探测根本没工作"。
          //    这一行能把两者分开：自检 OK 说明探测链路是通的，前面报的就是真实结论。
          const selfTest = await probeCandidatesViaRelay([PROBE_URL], { limit: 1, timeoutMs: 9000 });
          if (!selfTest) {
            steps.push('15 探测自检: **探测没工作**（中转地址未生效）→ 14 行的结论不可信');
          } else if (selfTest.good.length) {
            steps.push('15 探测自检: OK ✅（探测链路正常，14 行的结论可信）');
          } else {
            steps.push('15 探测自检: 已知能播的地址也探不通 → 问题在中转/探测本身，不是视频');
          }
        }
      } catch (error) {
        steps.push('13/14 播放候选探测: 异常 ' + ((error && error.message) || ''));
      }

      // 10) 本机存储：登录态 / Cookie / 导入视频都靠它持久化，
      //     若这里异常，就会出现“登录完退出小程序又要重新登录”
      try {
        const probe = await storageSelfCheck();
        const savedSession = await readSession();
        steps.push('10 本机存储: ' + (probe.ok ? '读写正常' : ('异常 —— ' + probe.reason))
          + ' · 已保存登录态: ' + (savedSession ? ('有（' + (savedSession.nick || savedSession.id || '') + '）') : '无'));
      } catch (error) {
        steps.push('10 本机存储: 检测失败 ' + ((error && error.message) || ''));
      }
      this.netDiag = steps;
      this.netDiagRunning = false;

      // 诊断已证明通路可用，而视频页还停在离线样例 → 自动重载一次
      if (directOk && this.offlineFallback) this.reloadVideos();
    },

    openComments(i) {
      this.commentIndex = this.list.indexOf(this.visibleList[i]);
      this.shareIndex = -1;
      this.commentDraft = '';
    },
    openShare(i) {
      this.shareIndex = this.list.indexOf(this.visibleList[i]);
      this.commentIndex = -1;
    },
    closeSheets() {
      this.commentIndex = -1;
      this.shareIndex = -1;
    },
    submitComment() {
      const text = this.commentDraft.trim();
      if (!text || this.commentIndex < 0) return;
      const item = this.list[this.commentIndex];
      item.commentList.unshift({ author: '我', text });
      item.comments += 1;
      this.notifications.unshift('你评论了 @' + item.author + ' 的作品');
      this.commentDraft = '';
      this.imeTarget = '';
      this.toast = '评论已添加';
      setTimeout(() => { this.toast = ''; }, 1600);
    },
    shareLocally() {
      const item = this.list[this.shareIndex];
      if (!item) return;
      item.shares += 1;
      this.toast = '分享文案：' + item.desc;
      this.closeSheets();
      setTimeout(() => { this.toast = ''; }, 2200);
    },
    // ---------- 扫码登录 ----------
    async openLoginQr() {
      this.stopLoginPoll();
      this.loginStatus = 'loading';
      this.loginFailCount = 0;
      try {
        const qr = await requestLoginQr();
        this.loginQr = qr;
        this.loginStatus = 'waiting';
        this.loginPollTimer = setInterval(() => this.pollLogin(), 2000);
      } catch (error) {
        this.loginQr = null;
        this.loginStatus = '';
        this.showToast('获取二维码失败：' + error.message);
      }
    },
    // 多闪（抖音私信）登录：跳到独立页面，走 PC 网关（与上面的抖音扫码完全分开）
    openChatLogin() {
      this.imeTarget = '';
      if (typeof $falcon !== 'undefined' && $falcon && typeof $falcon.navTo === 'function') {
        try {
          $falcon.navTo('chat-login', {});
          return;
        } catch (error) {
          this.showToast('打开多闪登录页失败：' + error.message);
          return;
        }
      }
      this.showToast('当前环境不支持页面跳转（模拟器预览可忽略）');
    },
    async pollLogin() {
      if (!this.loginQr) {
        this.stopLoginPoll();
        return;
      }
      try {
        const result = await checkLoginQr(this.loginQr.token);
        this.loginFailCount = 0;
        this.loginStatus = result.status;
        if (result.status === 'confirmed') {
          const session = {
            nick: (result.user && result.user.nick) || '',
            id: (result.user && result.user.id) || '',
            loginAt: Date.now(),
            cookieCount: result.cookieCount || cookieCount(),
            cookieKeys: result.cookieKeys || []
          };
          await saveSession(session);
          this.session = session;
          this.cookieText = cookieSummary();
          this.closeLoginQr();
          this.showToast(result.cookieCount
            ? ('扫码登录成功，已获取 ' + result.cookieCount + ' 项 Cookie，正在按登录态刷新')
            : '扫码登录成功（未取到会话 Cookie，见“我的”页说明）', 3000);
          // 登录态下带 Cookie 重新拉一次数据
          this.loadVideos();
        } else if (result.status === 'expired' || result.status === 'refused') {
          this.stopLoginPoll();
        }
      } catch (error) {
        this.loginFailCount += 1;
        if (this.loginFailCount >= 5) {
          this.loginStatus = 'error';
          this.stopLoginPoll();
        }
      }
    },
    stopLoginPoll() {
      if (this.loginPollTimer) {
        clearInterval(this.loginPollTimer);
        this.loginPollTimer = null;
      }
    },
    closeLoginQr() {
      this.stopLoginPoll();
      this.loginQr = null;
      this.loginStatus = '';
    },
    async logoutAccount() {
      await clearSession();
      // 退出时把登录 Cookie 一并清掉（ttwid 会自动回落到 config.js 里的值）
      await clearCookies();
      this.session = null;
      this.cookieText = cookieSummary();
      this.showToast('已退出登录，登录 Cookie 已清除', 2400);
      this.loadVideos();
    },
    showToast(msg, ms) {
      this.toast = msg;
      setTimeout(() => {
        if (this.toast === msg) this.toast = '';
      }, ms || 1800);
    },
    publishPost() {
      const text = this.draft.trim();
      if (!text) {
        this.toast = '先写点作品内容';
        setTimeout(() => { this.toast = ''; }, 1600);
        return;
      }
      this.list.unshift({
        author: 'Falcon 创作者', desc: text, music: '原创声音', emoji: '',
        scene: text, likes: 0, comments: 0, shares: 0, bg: '#3d5962',
        liked: false, heart: false, paused: true, interval: 125,
        frames: [], followed: true, live: false, commentList: []
      });
      this.draft = '';
      this.imeTarget = '';
      this.tab = 'rec';
      this.cur = 0;
      this.dockIdx = 0;
    },
    onStart(e) {
      if (this.dockIdx !== 0 || this.commentIndex >= 0 || this.shareIndex >= 0 || this.settleTimer || this.imeTarget) return;
      const touches = e && e.touches;
      if (!touches || !touches.length || !touches[0] || typeof touches[0].pageY !== 'number') {
        this.moving = false;
        this.dragY = 0;
        return;
      }
      this.startY = touches[0].pageY;
      this.startX = typeof touches[0].pageX === 'number' ? touches[0].pageX : 0;
      this.dragY = 0;
      this.moving = true;
    },
    onMove(e) {
      if (!this.moving) return;
      const touches = e && e.touches;
      if (!touches || !touches.length || !touches[0] || typeof touches[0].pageY !== 'number') return;
      const dy = touches[0].pageY - this.startY;
      const dx = typeof touches[0].pageX === 'number' ? touches[0].pageX - this.startX : 0;
      this.dragY = Math.abs(dx) > Math.abs(dy) ? 0 : dy;
    },
    onEnd(e) {
      if (!this.moving) return;
      this.moving = false;
      const changedTouches = e && e.changedTouches;
      if (!changedTouches || !changedTouches.length || !changedTouches[0] || typeof changedTouches[0].pageY !== 'number') {
        this.dragY = 0;
        return;
      }
      const dy = changedTouches[0].pageY - this.startY;
      const dx = typeof changedTouches[0].pageX === 'number' ? changedTouches[0].pageX - this.startX : 0;
      if (Math.abs(dx) > Math.abs(dy) || Math.abs(dy) < 60) {
        this.dragY = 0;
        return;
      }

      const target = dy < 0 ? this.cur + 1 : this.cur - 1;
      const n = this.visibleList.length;
      if (target < 0) {
        // 已在第一个视频还想往回滑 → 打开观看历史，找回之前刷掉的视频
        this.dragY = 0;
        this.openHistory();
        return;
      }
      if (target >= n) {
        this.dragY = 0;
        this.showToast('已经到最后一个了');
        return;
      }
      this.dragY = dy < 0 ? -this.HEIGHT : this.HEIGHT;
      this.settleTimer = setTimeout(() => {
        this.settleTimer = null;
        this.go(target);
      }, 220);
    },
    onCancel() {
      this.moving = false;
      this.dragY = 0;
    },
    fmt(n) {
      return n >= 10000 ? (n / 10000).toFixed(1).replace(/\.0$/, '') + '万' : String(n);
    }
  }
};
</script>

<style scoped>
.input-bar {
  position: absolute;
  left: 302px;
  right: 8px;
  top: 0;
  height: 30px;
  z-index: 10;
  display: flex;
  flex-direction: row;
  align-items: center;
  background-color: rgba(255, 255, 255, 0.12);
  border-radius: 10px;
  padding: 0 6px;
}

.link-input {
  flex: 1;
  font-size: 12px;
  color: #ffffff;
  background-color: transparent;
  height: 28px;
}

.import-btn {
  margin-left: 6px;
  padding: 4px 10px;
  border-radius: 999px;
  background-color: #ff2d55;
}

.page {
  position: relative;
  width: 100%;
  height: 100%;
  overflow: hidden;
  background-color: #000000;
}

/* 顶部导航 */
.topbar {
  position: absolute;
  top: 0;
  left: 46px;
  width: 250px;
  height: 30px;
  z-index: 8;
  flex-direction: row;
  align-items: center;
  justify-content: center;
  padding-top: 6px;
  background-color: rgba(0, 0, 0, 0.6);
}
.tab {
  position: relative;
  margin-left: 8px;
  margin-right: 8px;
  padding-bottom: 2px;
}
.tab-txt {
  font-size: 12px;
  color: rgba(255, 255, 255, 0.55);
}
.tab-active {
  color: #ffffff;
  font-weight: bold;
}
.tab-line {
  position: absolute;
  left: 10px;
  right: 10px;
  bottom: 0;
  height: 3px;
  border-radius: 2px;
  background-color: #ffffff;
}
.tab-dot {
  position: absolute;
  top: 2px;
  right: -6px;
  font-size: 7px;
  color: #ff0000;
}

/* 离线回退提示条 */
.offline-tip {
  position: absolute;
  left: 54px;
  right: 8px;
  top: 34px;
  z-index: 9;
  padding: 3px 8px;
  border-radius: 8px;
  background-color: rgba(255, 45, 85, 0.85);
}
.offline-tip-txt {
  font-size: 10px;
  color: #ffffff;
}

/* 左侧分区栏（替代原来的底部导航栏）：
   横屏只有 254px 高，纵向比横向紧张得多，导航竖排更省高度，
   也给视频画面留出完整底部（作者信息/互动栏/控制条都用得上） */
.rail {
  position: absolute;
  left: 0;
  top: 0;
  bottom: 0;
  width: 46px;
  z-index: 9;
  flex-direction: column;
  align-items: center;
  padding-top: 6px;
  background-color: rgba(255, 255, 255, 0.06);
}
.rail-item {
  width: 40px;
  height: 42px;
  align-items: center;
  justify-content: center;
  border-radius: 6px;
  margin-bottom: 4px;
}
/* 返回主主页：254px 高度紧张，所以做矮一点，给下面 5 个分区腾地方 */
.rail-back {
  width: 40px;
  height: 24px;
  margin-bottom: 6px;
  border-radius: 6px;
  background-color: rgba(255, 255, 255, 0.14);
  align-items: center;
  justify-content: center;
}
.rail-back-txt {
  font-size: 9px;
  color: #ffffff;
  font-weight: bold;
}
.rail-txt {
  font-size: 11px;
  color: rgba(255, 255, 255, 0.6);
}
.rail-txt-active {
  color: #fe2c55;
  font-weight: bold;
}

/* 视频流 */
.feed {
  position: absolute;
  left: 46px;
  top: 0;
  right: 0;
  bottom: 0;
  overflow: hidden;
}
.slide {
  position: absolute;
  left: 0;
  top: 0;
  width: 100%;
  height: 100%;
  overflow: hidden;
  background-color: #000000;
}
.cover {
  position: absolute;
  left: 0;
  top: 0;
  width: 100%;
  height: 100%;
  z-index: 1;
}
.cover-art {
  position: absolute;
  left: 0;
  top: 0;
  width: 100%;
  height: 100%;
  z-index: 1;
  align-items: center;
  justify-content: center;
}
.cover-img {
  position: absolute;
  left: 0;
  top: 0;
  width: 100%;
  height: 100%;
}
.cover-fallback {
  align-items: center;
  justify-content: center;
}
.art-mark {
  font-size: 46px;
  opacity: 0.88;
}
.art-title {
  margin-top: 6px;
  color: #ffffff;
  font-size: 15px;
  font-weight: bold;
}
.art-caption {
  margin-top: 7px;
  color: rgba(255, 255, 255, 0.7);
  font-size: 9px;
}
/* 视频条目封面上“点击解析播放”的提示 */
.cover-hint {
  position: absolute;
  left: 0;
  right: 0;
  top: 58%;
  align-items: center;
  justify-content: center;
  z-index: 3;
}
.cover-hint-txt {
  color: #ffffff;
  font-size: 11px;
  padding: 4px 12px;
  border-radius: 999px;
  background-color: rgba(0, 0, 0, 0.55);
  border-width: 1px;
  border-style: solid;
  border-color: rgba(255, 255, 255, 0.35);
}

/* 播放器控制条：必须放在 44px 底部导航之上，否则会被 dock 完全盖住 */
.ctrl {
  position: absolute;
  left: 46px;
  right: 0;
  bottom: 0;
  height: 26px;
  z-index: 6;
  flex-direction: row;
  align-items: center;
  justify-content: space-between;
  background-color: rgba(0, 0, 0, 0.5);
  padding-left: 8px;
  padding-right: 8px;
}
/* 上一条/下一条视频 */
.ctrl-nav {
  font-size: 9px;
  color: #ffffff;
  padding: 3px 7px;
  border-radius: 999px;
  background-color: rgba(255, 255, 255, 0.16);
}
.ctrl-btn {
  font-size: 13px;
  color: #ffffff;
  width: 24px;
}
.vp-layer {
  position: absolute;
  left: 0;
  top: 0;
  width: 100%;
  height: 100%;
  z-index: 2;
}
.ctrl-txt {
  font-size: 9px;
  color: #ffffff;
  margin-left: 6px;
}

/* 底部作者信息 */
.meta {
  position: absolute;
  left: 8px;
  right: 46px;
  bottom: 30px;
  z-index: 4;
}
.author-row {
  flex-direction: row;
  align-items: center;
  margin-bottom: 5px;
}
.author-emoji {
  font-size: 14px;
  margin-right: 5px;
}
.author-name {
  font-size: 11px;
  color: #ffffff;
  font-weight: bold;
}
.desc {
  font-size: 10px;
  color: rgba(255, 255, 255, 0.95);
  line-height: 14px;
  margin-bottom: 3px;
}
.music-row {
  flex-direction: row;
  align-items: center;
}
.music-label {
  font-size: 9px;
  color: rgba(255, 255, 255, 0.7);
  margin-right: 4px;
}
.music-txt {
  font-size: 11px;
  color: rgba(255, 255, 255, 0.9);
}

/* 右侧互动栏 */
.actions {
  position: absolute;
  right: 4px;
  bottom: 30px;
  z-index: 4;
  flex-direction: column;
  align-items: center;
}
.avatar {
  width: 26px;
  height: 26px;
  border-radius: 19px;
  border-width: 2px;
  border-style: solid;
  border-color: #ffffff;
  align-items: center;
  justify-content: center;
  margin-bottom: 12px;
}
.avatar-txt {
  font-size: 16px;
}
.follow-mark {
  width: 22px;
  height: 22px;
  border-radius: 11px;
  background-color: #fe2c55;
  align-items: center;
  justify-content: center;
  margin-top: -6px;
  margin-bottom: 12px;
}
.follow-mark-txt {
  color: #ffffff;
  font-size: 12px;
  font-weight: bold;
}
.act {
  flex-direction: column;
  align-items: center;
  margin-bottom: 14px;
}
.act-ic {
  font-size: 13px;
  color: #ffffff;
  margin-bottom: 1px;
}
.ic-on {
  color: #fe2c55;
}
.act-num {
  font-size: 8px;
  color: #ffffff;
}
.num-on {
  color: #fe2c55;
}
.ic-col {
  color: #fcc21b;
}
.num-col {
  color: #fcc21b;
}

/* 双击点赞爱心 */
.heart {
  position: absolute;
  left: 50%;
  top: 40%;
  margin-left: -20px;
  font-size: 40px;
  color: #fe2c55;
  z-index: 7;
  animation: pop 0.9s ease 1;
}
@keyframes pop {
  0% { opacity: 0; transform: scale(0.4); }
  30% { opacity: 1; transform: scale(1.15); }
  100% { opacity: 0; transform: scale(1); }
}

/* 底部固定栏 */
.dock {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  height: 30px;
  z-index: 8;
  flex-direction: row;
  align-items: center;
  justify-content: space-around;
  background-color: rgba(0, 0, 0, 0.4);
}
.subpage {
  position: absolute;
  left: 46px;
  right: 0;
  top: 0;
  bottom: 0;
  z-index: 3;
  padding: 34px 12px 10px;
  background-color: #101214;
  flex-direction: column;
}
.search-row {
  height: 42px;
  margin-top: 8px;
  margin-bottom: 10px;
  padding-left: 10px;
  padding-right: 10px;
  flex-direction: row;
  align-items: center;
  background-color: #25292c;
  border-radius: 6px;
}
.search-input {
  flex: 1;
  height: 40px;
  color: #ffffff;
  font-size: 12px;
  background-color: transparent;
}
.search-clear {
  color: #fe6b86;
  font-size: 11px;
  padding-left: 8px;
}
.search-submit {
  color: #ffffff;
  font-size: 12px;
  font-weight: bold;
  padding-left: 10px;
}
.search-count {
  color: rgba(255, 255, 255, 0.58);
  font-size: 10px;
  margin-bottom: 5px;
}
.search-state {
  color: rgba(255, 255, 255, 0.72);
  font-size: 11px;
  margin-top: 14px;
}
.search-error {
  color: #ff8298;
  font-size: 11px;
  line-height: 17px;
  margin-top: 14px;
}
.search-empty {
  margin-top: 84px;
  align-items: center;
}
.search-result {
  min-height: 70px;
  flex-direction: row;
  align-items: center;
  border-bottom-width: 1px;
  border-bottom-style: solid;
  border-bottom-color: rgba(255, 255, 255, 0.1);
}
.search-result-cover {
  width: 48px;
  height: 58px;
  align-items: center;
  justify-content: center;
  border-radius: 4px;
}
.search-result-image {
  width: 48px;
  height: 58px;
  border-radius: 4px;
}
.search-result-emoji {
  font-size: 20px;
}
.search-result-copy {
  flex: 1;
  padding-left: 10px;
  padding-right: 8px;
  flex-direction: column;
}
.search-result-title {
  color: #ffffff;
  font-size: 12px;
  font-weight: bold;
}
.search-result-desc {
  color: rgba(255, 255, 255, 0.68);
  font-size: 10px;
  margin-top: 4px;
}
.search-result-author {
  color: rgba(255, 255, 255, 0.48);
  font-size: 9px;
  margin-top: 4px;
}
.search-more {
  height: 38px;
  margin-top: 10px;
  align-items: center;
  justify-content: center;
  background-color: rgba(255, 255, 255, 0.08);
  border-radius: 5px;
}
.search-more-text {
  color: #ffffff;
  font-size: 11px;
}
.page-heading {
  color: #ffffff;
  font-size: 15px;
  font-weight: bold;
  margin-bottom: 8px;
}
.page-copy {
  color: rgba(255, 255, 255, 0.66);
  font-size: 10px;
  line-height: 18px;
}
.composer-input {
  height: 48px;
  margin-top: 18px;
  padding-left: 12px;
  padding-right: 12px;
  color: #ffffff;
  font-size: 13px;
  background-color: #25292c;
  border-radius: 6px;
}
.publish-btn {
  height: 44px;
  margin-top: 16px;
  border-radius: 6px;
  background-color: #fe2c55;
  align-items: center;
  justify-content: center;
}
.publish-label {
  color: #ffffff;
  font-size: 14px;
  font-weight: bold;
}
.empty-state {
  margin-top: 56px;
  align-items: center;
}
.empty-title {
  color: #ffffff;
  font-size: 15px;
  margin-bottom: 7px;
}
.notice-row {
  flex-direction: row;
  align-items: center;
  padding-top: 14px;
  padding-bottom: 14px;
  border-bottom-width: 1px;
  border-bottom-style: solid;
  border-bottom-color: rgba(255, 255, 255, 0.12);
}
.notice-mark {
  color: #fe2c55;
  font-size: 11px;
  margin-right: 10px;
}
.notice-copy {
  color: #ffffff;
  font-size: 12px;
}
.profile-handle {
  color: rgba(255, 255, 255, 0.65);
  font-size: 12px;
}
.profile-copy {
  color: rgba(255, 255, 255, 0.66);
  font-size: 11px;
  line-height: 17px;
  margin-top: 8px;
}
.profile-errors {
  margin-top: 6px;
}
.profile-version {
  color: rgba(255, 255, 255, 0.45);
  font-size: 9px;
  margin-top: 2px;
  margin-bottom: 8px;
}
.net-diag {
  margin-top: 6px;
  padding: 8px 10px;
  border-radius: 6px;
  background-color: #20262b;
}
.net-diag-row {
  color: #8fd3ff;
  font-size: 10px;
  line-height: 16px;
}
.profile-error-row {
  color: rgba(255, 130, 150, 0.85);
  font-size: 9px;
  line-height: 14px;
}
.profile-login-btn {
  height: 30px;
  margin-top: 10px;
  border-radius: 6px;
  background-color: #fe2c55;
  align-items: center;
  justify-content: center;
}
.profile-user {
  flex-direction: row;
  align-items: center;
  margin-top: 4px;
  margin-bottom: 6px;
}
.profile-avatar {
  width: 44px;
  height: 44px;
  border-radius: 22px;
  background-color: #fe2c55;
  align-items: center;
  justify-content: center;
}
.profile-avatar-txt {
  color: #ffffff;
  font-size: 18px;
  font-weight: bold;
}
.profile-user-copy {
  flex: 1;
  flex-direction: column;
  padding-left: 10px;
}
.profile-nick {
  color: #ffffff;
  font-size: 15px;
  font-weight: bold;
}
.profile-uid {
  color: rgba(255, 255, 255, 0.55);
  font-size: 10px;
  margin-top: 3px;
}
.profile-logout {
  padding: 6px 12px;
  border-radius: 999px;
  background-color: #303438;
}
.profile-logout-txt {
  color: #ffffff;
  font-size: 11px;
}
.qr-overlay {
  position: absolute;
  left: 0;
  right: 0;
  top: 0;
  bottom: 0;
  z-index: 30;
  align-items: center;
  justify-content: center;
  background-color: rgba(0, 0, 0, 0.78);
}
.qr-panel {
  width: 234px;
  padding: 16px;
  align-items: center;
  background-color: #ffffff;
  border-radius: 10px;
}
.qr-title {
  color: #16181c;
  font-size: 15px;
  font-weight: bold;
  margin-bottom: 12px;
}
.qr-img {
  width: 110px;
  height: 110px;
  margin-bottom: 6px;
}
.qr-hint {
  color: #666666;
  font-size: 10px;
}
/* 扫码端品牌说明（字节统一账号：确认页显示“今日头条”） */
.qr-note {
  color: #999999;
  font-size: 9px;
  line-height: 13px;
  margin-top: 6px;
  text-align: center;
}
.qr-status {
  color: #fe2c55;
  font-size: 12px;
  margin-top: 6px;
  font-weight: bold;
}
.qr-actions {
  flex-direction: row;
  margin-top: 12px;
}
.qr-btn {
  width: 88px;
  height: 36px;
  border-radius: 6px;
  background-color: #fe2c55;
  align-items: center;
  justify-content: center;
  margin-left: 6px;
  margin-right: 6px;
}
.qr-btn-ghost {
  background-color: #e8eaed;
}
.qr-btn-txt {
  color: #ffffff;
  font-size: 12px;
}
.qr-btn-ghost-txt {
  color: #555555;
  font-size: 12px;
}
.profile-stats {
  flex-direction: row;
  margin-top: 24px;
  margin-bottom: 28px;
}
.profile-stat {
  flex: 1;
  align-items: center;
}
.stat-number {
  color: #ffffff;
  font-size: 16px;
  font-weight: bold;
}
.stat-label {
  color: rgba(255, 255, 255, 0.6);
  font-size: 10px;
  margin-top: 4px;
}
.profile-section {
  color: #ffffff;
  font-size: 12px;
  font-weight: bold;
  margin-bottom: 6px;
  margin-top: 10px;
}
/* 手机号登录：输入行 + 获取验证码 + 登录按钮 */
.phone-row {
  flex-direction: row;
  align-items: center;
  margin-top: 6px;
}
.phone-btn {
  margin-left: 6px;
  padding: 5px 10px;
  border-radius: 6px;
  background-color: #2b3038;
  align-items: center;
  justify-content: center;
}
.phone-btn-txt {
  color: #8fd3ff;
  font-size: 10px;
}
.phone-login-btn {
  height: 30px;
  margin-top: 8px;
  border-radius: 6px;
  background-color: #fe2c55;
  align-items: center;
  justify-content: center;
}
.profile-work {
  color: rgba(255, 255, 255, 0.85);
  font-size: 12px;
  padding-top: 10px;
  padding-bottom: 10px;
  border-bottom-width: 1px;
  border-bottom-style: solid;
  border-bottom-color: rgba(255, 255, 255, 0.1);
}
.video-search-input {
  height: 38px;
  margin-top: 4px;
  margin-bottom: 8px;
  padding-left: 10px;
  padding-right: 10px;
  color: #ffffff;
  font-size: 12px;
  background-color: #25292c;
  border-radius: 5px;
}
.video-search-count {
  color: rgba(255, 255, 255, 0.58);
  font-size: 10px;
  margin-bottom: 4px;
}
.profile-work-title {
  color: rgba(255, 255, 255, 0.9);
  font-size: 12px;
}
.profile-work-desc {
  color: rgba(255, 255, 255, 0.58);
  font-size: 10px;
  margin-top: 4px;
}
.video-search-empty {
  padding-top: 18px;
  padding-bottom: 18px;
  align-items: center;
}
.video-search-empty-text {
  color: rgba(255, 255, 255, 0.58);
  font-size: 11px;
}
.sheet-backdrop {
  position: absolute;
  left: 0;
  right: 0;
  top: 0;
  bottom: 0;
  z-index: 10;
  background-color: rgba(0, 0, 0, 0.55);
}
.comment-sheet {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  height: 78%;
  padding: 10px;
  background-color: #191c1f;
  flex-direction: column;
}
.share-sheet {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  height: 62%;
  padding: 10px;
  background-color: #191c1f;
  flex-direction: column;
}
.sheet-title {
  color: #ffffff;
  font-size: 14px;
  font-weight: bold;
  margin-bottom: 12px;
}
.comment-row {
  margin-top: 8px;
  margin-bottom: 8px;
}
.comment-author {
  color: rgba(255, 255, 255, 0.55);
  font-size: 10px;
  margin-bottom: 4px;
}
.comment-copy {
  color: #ffffff;
  font-size: 12px;
}
.comment-entry {
  position: absolute;
  left: 14px;
  right: 14px;
  bottom: 18px;
  flex-direction: row;
  align-items: center;
}
.sheet-input {
  flex: 1;
  height: 38px;
  padding-left: 10px;
  padding-right: 8px;
  color: #ffffff;
  font-size: 12px;
  background-color: #2b2f32;
  border-radius: 5px;
}
.send-btn {
  width: 38px;
  text-align: center;
  color: #fe2c55;
  font-size: 12px;
  margin-left: 8px;
}
.history-sheet {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  height: 62%;
  padding: 14px;
  background-color: #191c1f;
  flex-direction: column;
}
.history-tip {
  color: rgba(255, 255, 255, 0.5);
  font-size: 10px;
  margin-bottom: 10px;
}
.history-list {
  flex: 1;
}
.history-empty {
  flex: 1;
  align-items: center;
  justify-content: center;
}
.history-row {
  flex-direction: row;
  align-items: center;
  padding-top: 8px;
  padding-bottom: 8px;
  border-bottom-width: 1px;
  border-bottom-style: solid;
  border-bottom-color: rgba(255, 255, 255, 0.1);
}
.history-cover {
  width: 44px;
  height: 54px;
  border-radius: 4px;
}
.history-cover-ph {
  background-color: #2b2f32;
  align-items: center;
  justify-content: center;
}
.history-cover-emoji {
  font-size: 18px;
}
.history-copy {
  flex: 1;
  flex-direction: column;
  padding-left: 10px;
  padding-right: 6px;
}
.history-title {
  color: #ffffff;
  font-size: 12px;
  line-height: 16px;
}
.history-meta {
  color: rgba(255, 255, 255, 0.45);
  font-size: 9px;
  margin-top: 4px;
}
.history-del {
  color: rgba(255, 255, 255, 0.4);
  font-size: 13px;
  padding-left: 8px;
  padding-right: 4px;
}
.history-actions {
  flex-direction: row;
  justify-content: center;
  margin-top: 12px;
}
.profile-history-btn {
  height: 40px;
  padding-left: 12px;
  padding-right: 12px;
  margin-top: 4px;
  margin-bottom: 8px;
  border-radius: 6px;
  background-color: #25292c;
  flex-direction: row;
  align-items: center;
  justify-content: space-between;
}
.profile-history-txt {
  color: #ffffff;
  font-size: 12px;
}
.profile-history-arrow {
  color: rgba(255, 255, 255, 0.5);
  font-size: 14px;
}
.share-copy {
  color: rgba(255, 255, 255, 0.72);
  font-size: 12px;
  margin-bottom: 18px;
}
.share-action {
  height: 42px;
  border-radius: 6px;
  background-color: #fe2c55;
  align-items: center;
  justify-content: center;
}
.toast {
  position: absolute;
  left: 10px;
  right: 10px;
  bottom: 54px;
  z-index: 20;
  padding: 9px;
  color: #ffffff;
  font-size: 11px;
  text-align: center;
  background-color: rgba(20, 20, 20, 0.92);
  border-radius: 5px;
}
.item {
  flex-direction: column;
  align-items: center;
}
.item-ic {
  font-size: 13px;
  color: rgba(255, 255, 255, 0.85);
}
.item-txt {
  font-size: 8px;
  color: rgba(255, 255, 255, 0.85);
  margin-top: 0;
}
.item-ic-active {
  color: #fe2c55;
}
.item-txt-active {
  color: #ffffff;
}
</style>
