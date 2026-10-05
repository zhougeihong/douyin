<template>
  <div class="screen">
    <!-- ============ 顶栏 ============ -->
    <div class="bar">
      <text class="bar-title">今日头条</text>
      <text class="bar-sub">{{ barSub }}</text>
      <div class="bar-right">
        <div class="btn-bar" v-if="tab === 0" @click="toggleSource">
          <text class="btn-bar-txt">{{ source === 'feed' ? '切到热榜' : '切到推荐' }}</text>
        </div>
        <div class="btn-bar" v-if="tab === 0" @click="reload">
          <text class="btn-bar-txt">刷新</text>
        </div>
        <text class="bar-user">{{ logged ? (uname || '已登录') : '未登录' }}</text>
      </div>
    </div>

    <!-- ============ 正文阅读视图（覆盖列表区）============ -->
    <div class="reader" v-if="article">
      <div class="reader-head">
        <text class="reader-title">{{ article.title }}</text>
        <text class="reader-meta">{{ article.author }} · {{ relTime(article.publishTime) }}<text v-if="article.hasVideo"> · 视频 {{ durText(article.videoDuration) }}</text></text>
      </div>
      <scroller class="reader-body" show-scrollbar="false">
        <text class="reader-text">{{ article.content }}</text>
        <text class="reader-note" v-if="article.hasVideo && !article.videoPlayable">本条是视频内容，头条的视频直链未登录拿不到（需要签名），这里展示的是文字部分。</text>
        <text class="reader-note">{{ article.commentCount }} 条评论 · {{ article.diggCount }} 赞</text>

        <!-- 评论：头条线上评论需签名拿不到（见 toutiao-api.js），这里是本地评论 -->
        <text class="cmt-head">评论（本地 {{ articleComments.length }} 条 · 头条 {{ article.commentCount || 0 }} 条）</text>
        <text class="cmt-note">头条线上评论需签名，笔上取不到；下面是存在本机的评论。</text>
        <div class="cmt-row" v-for="c in articleComments" :key="c.id">
          <text class="cmt-txt">{{ c.text }}</text>
          <text class="cmt-at">{{ relTime(c.at) }}</text>
          <div class="cmt-del" @click.stop="deleteComment(c)">
            <text class="cmt-del-txt">删</text>
          </div>
        </div>
        <text class="cmt-empty" v-if="!articleComments.length">还没有本地评论，点下面「写评论」。</text>
      </scroller>
      <div class="reader-actions">
        <div class="btn-act" :class="[isLiked(article) ? 'btn-act-on' : '']" @click="toggleLike(article)">
          <text class="btn-act-txt">{{ isLiked(article) ? '已赞' : '点赞' }}</text>
        </div>
        <div class="btn-act" @click="openCommentEditor">
          <text class="btn-act-txt">写评论</text>
        </div>
        <div class="btn-act" @click="closeArticle">
          <text class="btn-act-txt">返回列表</text>
        </div>
      </div>
    </div>

    <!-- ============ 评论输入（应用内键盘，254px 高度只放一行）============ -->
    <!-- ============ 评论输入：复用工程现有的 PinyinIme（六模式，支持中文）============ -->
    <div class="cmt-editor" v-if="commentEditing">
      <text class="cmt-editor-title">写评论（支持中文，用下面的输入法）</text>
      <div class="cmt-editor-val">
        <text class="cmt-editor-txt">{{ commentDraft || '（输入内容）' }}</text>
      </div>
      <div class="cmt-editor-btns">
        <div class="btn-act" @click="cancelComment">
          <text class="btn-act-txt">取消</text>
        </div>
        <div class="btn-act" :class="[commentDraft ? 'btn-act-on' : '']" @click="saveComment">
          <text class="btn-act-txt">发送</text>
        </div>
      </div>
      <PinyinIme @commit="onCmtCommit" @insert="onCmtInsert" @delete-char="onCmtDelete" @done="cancelComment" />
    </div>

    <!-- ============ 列表区（「我的」页不显示列表，否则两层内容会叠在一起）============ -->
    <scroller class="list" v-if="!article && tab !== 2" show-scrollbar="false">
      <div class="row" v-for="(it, i) in visibleList" :key="it.groupId + '_' + i" @click="openItem(it)">
        <div class="row-cover">
          <!-- 无 emoji。头条自家 feed 的封面未签名、实测一律 403/域名已废，
               所以没有可用封面时显示「头」字占位，而不是加载一张必然失败的图。 -->
          <image class="row-img" v-if="it.cover" :src="coverSrc(it.cover)" mode="aspectFill"></image>
          <text class="row-ph" v-else>头</text>
          <text class="row-tag" v-if="it.hasVideo">视频</text>
        </div>
        <div class="row-copy">
          <text class="row-title">{{ it.title }}</text>
          <text class="row-abs" v-if="it.abstract">{{ it.abstract }}</text>
          <text class="row-meta">{{ rowMeta(it) }}</text>
        </div>
        <div class="row-like" v-if="tab !== 3" @click.stop="toggleLike(it)">
          <text class="row-like-txt" :class="[isLiked(it) ? 'row-like-on' : '']">{{ isLiked(it) ? '已赞' : '赞' }}</text>
        </div>
      </div>
      <div class="more" v-if="tab === 0 && !article" @click="loadMore">
        <text class="more-txt">{{ loading ? '加载中…' : (hasMore ? '加载更多' : '没有更多了') }}</text>
      </div>
      <div class="empty" v-if="!visibleList.length">
        <text class="empty-title">{{ emptyText }}</text>
        <text class="empty-copy">{{ errText || emptyCopy }}</text>
      </div>
    </scroller>

    <!-- ============ 我的 ============ -->
    <div class="mine" v-if="tab === 2 && !article">
      <div class="mine-user">
        <div class="mine-avatar">
          <text class="mine-avatar-txt">{{ logged ? avatarChar : '未' }}</text>
        </div>
        <div class="mine-copy">
          <text class="mine-name">{{ logged ? (uname || '头条用户') : '未登录' }}</text>
          <text class="mine-sub">{{ logged ? ('ID ' + (uid || '未知')) : '登录后可点赞、同步我的内容' }}</text>
        </div>
      </div>
      <div class="mine-btns">
        <div class="btn-act" v-if="!logged" @click="openLogin">
          <text class="btn-act-txt">二维码登录</text>
        </div>
        <div class="btn-act" v-if="logged" @click="doLogout">
          <text class="btn-act-txt">退出登录</text>
        </div>
        <div class="btn-act" @click="go('index')">
          <text class="btn-act-txt">回主主页</text>
        </div>
      </div>
      <text class="mine-stat">已赞 {{ likedList.length }} 条 · 历史 {{ historyList.length }} 条</text>
      <text class="mine-note">登录走字节统一账号 SSO（service=toutiao.com），扫码页显示「今日头条APP」。</text>
    </div>

    <!-- ============ 左侧分区栏 ============ -->
    <div class="rail">
      <div class="rail-back" @click="go('index')">
        <text class="rail-back-txt">返回</text>
      </div>
      <div class="rail-item" v-for="sec in sections" :key="sec.idx" @click="selectTab(sec.idx)">
        <text class="rail-txt" :class="[tab === sec.idx ? 'rail-txt-active' : '']">{{ sec.label }}</text>
      </div>
    </div>

    <!-- ============ 登录弹层（二维码为 SSO 签发的 base64 PNG）============ -->
    <div class="qr-overlay" v-if="loginQr" @click="closeLogin">
      <div class="qr-panel" @click.stop>
        <text class="qr-title">今日头条扫码登录</text>
        <image class="qr-img" :src="loginQr.image" mode="aspectFit"></image>
        <text class="qr-hint">{{ loginQr.hint }}</text>
        <text class="qr-status">{{ loginStatusText }}</text>
        <div class="qr-actions">
          <div class="qr-btn" @click="openLogin">
            <text class="qr-btn-txt">刷新</text>
          </div>
          <div class="qr-btn qr-btn-ghost" @click="closeLogin">
            <text class="qr-btn-ghost-txt">关闭</text>
          </div>
        </div>
      </div>
    </div>

    <text class="toast" v-if="toast">{{ toast }}</text>
    <text class="err" v-if="errText">{{ errText }}</text>
  </div>
</template>

<script>
import {
  fetchToutiaoHot,
  fetchToutiaoFeed,
  fetchToutiaoArticle,
  relativeTime,
  loadComments,
  commentsOf,
  appendComment,
  removeComment,
  persistComments,
  TOUTIAO_KEYS
} from '../../services/toutiao-api.js';
import PinyinIme from '../../components/PinyinIme.vue';
import { jsapiStorageGet, jsapiStorageSet, relayAssetUrl } from '../../services/libjsapi.js';
import { requestLoginQr, checkLoginQr } from '../../services/douyin-auth.js';

// 头条内容列表上限（storage 与内存都按这个截断，别让笔上的存储被撑爆）
const LIST_MAX = 100;
const POLL_MS = 2000;
// 深链提示 key：只在本次启动生效，读完即清（避免下次进页面又跳进同一篇）
const PENDING_GROUP_KEY = 'toutiao_pending_group';

export default {
  name: 'Toutiao',
  components: { PinyinIme },
  data() {
    return {
      sections: [
        { idx: 0, label: '观看' },
        { idx: 1, label: '点赞' },
        { idx: 2, label: '我的' },
        { idx: 3, label: '历史' }
      ],
      tab: 0,
      source: 'feed',          // feed(推荐) / hot(热榜)
      feed: [],
      hot: [],
      nextMax: '',
      hasMore: true,
      loading: false,
      article: null,           // 当前阅读的正文
      articleFrom: null,       // 正文对应的列表条目（点赞/历史要它）
      liked: {},               // groupId -> 条目快照
      history: [],
      // 评论（本地存；头条线上评论需签名拿不到，见 toutiao-api.js）
      allComments: {},         // groupId -> [ {id,text,at} ]
      commentEditing: false,
      commentDraft: '',
      // 登录
      logged: false,
      uname: '',
      uid: '',
      loginQr: null,
      loginStatus: '',
      loginTimer: null,
      loginFailCount: 0,
      toast: '',
      errText: ''
    };
  },
  computed: {
    visibleList() {
      if (this.tab === 1) return this.likedList;
      if (this.tab === 3) return this.historyList;
      return this.source === 'hot' ? this.hot : this.feed;
    },
    likedList() {
      const out = [];
      const keys = Object.keys(this.liked);
      for (let i = 0; i < keys.length; i++) out.push(this.liked[keys[i]]);
      return out;
    },
    historyList() {
      return this.history;
    },
    // 当前正文的本地评论
    articleComments() {
      if (!this.article) return [];
      return commentsOf(this.allComments, this.article.groupId).slice().reverse();
    },
    barSub() {
      if (this.article) return '阅读中';
      if (this.tab === 0) return this.source === 'hot' ? '头条热榜' : '推荐信息流';
      if (this.tab === 1) return '我赞过的';
      if (this.tab === 2) return '账号';
      return '浏览记录';
    },
    emptyText() {
      if (this.tab === 1) return '还没有点赞';
      if (this.tab === 3) return '还没有浏览记录';
      return this.loading ? '加载中…' : '没有内容';
    },
    emptyCopy() {
      if (this.tab === 1) return '在「观看」里点右侧「赞」就会出现在这里';
      if (this.tab === 3) return '点开任意一条阅读后会记在这里';
      return this.errText || '点右上角刷新重试';
    },
    avatarChar() {
      return (this.uname || '头').slice(0, 1);
    },
    loginStatusText() {
      if (this.loginStatus === 'confirmed') return '登录成功';
      if (this.loginStatus === 'scanned') return '已扫码，请在手机上确认';
      if (this.loginStatus === 'expired') return '二维码已过期，请点刷新';
      if (this.loginStatus === 'refused') return '已取消登录';
      return '等待扫码…';
    }
  },
  methods: {
    // ---------- 通用 ----------
    go(page) {
      const falcon = typeof $falcon !== 'undefined' && $falcon ? $falcon : null;
      if (falcon && typeof falcon.navTo === 'function') {
        try { falcon.navTo(page, {}); return; } catch (error) { /* 忽略 */ }
      }
      this.showToast('当前环境不支持页面跳转');
    },
    showToast(msg, ms) {
      this.toast = msg;
      if (this.toastTimer) clearTimeout(this.toastTimer);
      this.toastTimer = setTimeout(() => { this.toast = ''; }, ms || 1800);
    },
    relTime(ts) { return relativeTime(ts); },
    // 封面走 <image>（原生图像栈，不是 libcurl）：无 TLS 的固件/模拟器直接加载 https 会空白，
    // 所以配了 API_RELAY 就套一层中转（与抖音页封面同一套做法）。
    coverSrc(url) { return relayAssetUrl(url); },
    durText(sec) {
      const s = parseInt(sec, 10) || 0;
      if (!s) return '';
      const m = Math.floor(s / 60);
      const r = s % 60;
      return m + ':' + (r < 10 ? '0' + r : r);
    },
    rowMeta(it) {
      const bits = [];
      if (it.source) bits.push(it.source);
      if (it.hotValue) bits.push('热度 ' + it.hotValue);
      if (it.videoPlayCount) bits.push(it.videoPlayCount + ' 次播放');
      if (it.commentsCount) bits.push(it.commentsCount + ' 评论');
      const t = relativeTime(it.behotTime || it.publishTime);
      if (t) bits.push(t);
      return bits.join(' · ');
    },

    // ---------- 列表 ----------
    selectTab(idx) {
      this.tab = idx;
      this.article = null;
      this.errText = '';
      if (idx === 0 && !this.feed.length && !this.hot.length) this.reload();
    },
    toggleSource() {
      this.source = this.source === 'feed' ? 'hot' : 'feed';
      this.article = null;
      if (this.source === 'hot' && !this.hot.length) this.loadHot();
      if (this.source === 'feed' && !this.feed.length) this.loadFeed(true);
    },
    async loadFeed(reset) {
      if (this.loading) return;
      this.loading = true;
      this.errText = '';
      try {
        const res = await fetchToutiaoFeed(reset ? '0' : this.nextMax);
        const items = res.items || [];
        this.feed = reset ? items : this.feed.concat(items);
        this.nextMax = res.nextMaxBehotTime || '';
        this.hasMore = !!res.hasMore;
        if (!this.feed.length) this.errText = '头条信息流返回为空';
      } catch (error) {
        this.errText = '加载失败：' + ((error && error.message) || '');
      } finally {
        this.loading = false;
      }
    },
    async loadHot() {
      if (this.loading) return;
      this.loading = true;
      this.errText = '';
      try {
        this.hot = await fetchToutiaoHot();
      } catch (error) {
        this.errText = '热榜加载失败：' + ((error && error.message) || '');
      } finally {
        this.loading = false;
      }
    },
    reload() {
      if (this.source === 'hot') this.loadHot();
      else this.loadFeed(true);
    },
    loadMore() {
      if (this.source === 'hot') { this.showToast('热榜没有更多了'); return; }
      if (!this.hasMore) { this.showToast('没有更多了'); return; }
      this.loadFeed(false);
    },

    // ---------- 观看（= 读正文；视频条目的直链拿不到，见 toutiao-api.js 头部 ④）----------
    async openItem(it) {
      if (!it.groupId) { this.showToast('这条没有可读的正文'); return; }
      this.showToast('正在取正文…', 1200);
      try {
        const art = await fetchToutiaoArticle(it.groupId, it);
        this.article = art;
        this.articleFrom = it;
        await this.addHistory(it);
      } catch (error) {
        const msg = (error && error.message) || '';
        // 视频条目取不到正文是**已知限制**（直链要加密 token + 混淆 JS VM，见 §13.10），
        // 所以说清楚原因，而不是丢一句"取正文失败"让用户以为坏了。
        if (it.hasVideo || msg.indexOf('没有可读正文') >= 0) {
          this.errText = '这是视频条目：头条的视频直链要加密 token，未登录/笔上取不到（'
            + (it.videoDurationStr ? '时长 ' + it.videoDurationStr + '，' : '')
            + '该条也没有文字正文）。可先看同页的图文条目。';
        } else {
          this.errText = '取正文失败：' + msg;
        }
      }
    },
    closeArticle() {
      this.article = null;
      this.commentEditing = false;
      this.commentDraft = '';
    },

    // ---------- 评论（本地）----------
    openCommentEditor() {
      if (!this.article) return;
      this.commentDraft = '';
      this.commentEditing = true;
    },
    onCmtCommit(text) {
      this.commentDraft = (this.commentDraft + String(text || '')).slice(0, 200);
    },
    onCmtInsert(ch) {
      this.commentDraft = (this.commentDraft + String(ch || '')).slice(0, 200);
    },
    onCmtDelete() {
      this.commentDraft = this.commentDraft.slice(0, Math.max(0, this.commentDraft.length - 1));
    },
    cancelComment() {
      this.commentEditing = false;
      this.commentDraft = '';
    },
    async saveComment() {
      const text = String(this.commentDraft || '').trim();
      if (!text) { this.showToast('评论不能为空'); return; }
      if (!this.article) return;
      this.allComments = appendComment(this.allComments, this.article.groupId, text);
      await persistComments(this.allComments);
      this.commentEditing = false;
      this.commentDraft = '';
      this.showToast('已保存到本机（头条线上评论需签名，笔上发不出去）', 2600);
    },
    async deleteComment(c) {
      if (!this.article || !c) return;
      this.allComments = removeComment(this.allComments, this.article.groupId, c.id);
      await persistComments(this.allComments);
      this.showToast('已删除');
    },
    async loadLocalComments() {
      this.allComments = await loadComments();
    },

    // ---------- 点赞 ----------
    isLiked(it) {
      return !!(it && it.groupId && this.liked[it.groupId]);
    },
    async toggleLike(it) {
      if (!it || !it.groupId) return;
      const key = it.groupId;
      if (this.liked[key]) {
        delete this.liked[key];
        this.showToast('已取消赞');
      } else {
        // 存快照：点赞列表要能独立渲染，不能只存 id
        this.liked[key] = {
          groupId: key,
          title: it.title || '',
          abstract: it.abstract || '',
          cover: it.cover || '',
          source: it.source || '',
          hasVideo: !!it.hasVideo,
          videoDuration: it.videoDuration || 0,
          commentsCount: it.commentsCount || 0,
          behotTime: it.behotTime || 0
        };
        this.showToast('已赞');
      }
      // 值会被 jsapiStorageSet JSON.stringify（HANDOFF §7.1 的 storage 契约）
      await jsapiStorageSet(TOUTIAO_KEYS.likes, this.liked);
    },
    async loadLikes() {
      try {
        const v = await jsapiStorageGet(TOUTIAO_KEYS.likes);
        this.liked = v && typeof v === 'object' && !Array.isArray(v) ? v : {};
      } catch (error) {
        this.liked = {};
      }
    },

    // ---------- 历史记录 ----------
    async addHistory(it) {
      if (!it || !it.groupId) return;
      const entry = {
        groupId: it.groupId,
        title: it.title || '',
        abstract: it.abstract || '',
        cover: it.cover || '',
        source: it.source || '',
        hasVideo: !!it.hasVideo,
        behotTime: it.behotTime || 0,
        viewedAt: Date.now()
      };
      // 去重置顶
      const rest = this.history.filter((h) => h.groupId !== entry.groupId);
      this.history = [entry].concat(rest).slice(0, LIST_MAX);
      await jsapiStorageSet(TOUTIAO_KEYS.history, this.history);
    },
    async loadHistory() {
      try {
        const v = await jsapiStorageGet(TOUTIAO_KEYS.history);
        this.history = Array.isArray(v) ? v.slice(0, LIST_MAX) : [];
      } catch (error) {
        this.history = [];
      }
    },
    async clearHistory() {
      this.history = [];
      await jsapiStorageSet(TOUTIAO_KEYS.history, []);
      this.showToast('已清空浏览记录');
    },

    // ---------- 登录（字节统一账号 SSO，扫码端显示「今日头条APP」）----------
    async openLogin() {
      this.stopLoginPoll();
      this.loginStatus = '';
      this.loginFailCount = 0;
      try {
        // hint 覆盖：同一个 SSO 换个 service 就换扫码端品牌，这里要显示"今日头条"
        const qr = await requestLoginQr({ hint: '请使用今日头条 APP 扫码登录' });
        this.loginQr = qr;
        this.loginStatus = 'waiting';
        this.loginTimer = setInterval(() => this.pollLogin(), POLL_MS);
      } catch (error) {
        this.loginQr = null;
        this.errText = '获取二维码失败：' + ((error && error.message) || '');
      }
    },
    async pollLogin() {
      if (!this.loginQr) { this.stopLoginPoll(); return; }
      try {
        const res = await checkLoginQr(this.loginQr.token);
        this.loginFailCount = 0;
        this.loginStatus = res.status;
        if (res.status === 'confirmed') {
          this.logged = true;
          this.uname = (res.user && (res.user.nick || res.user.name)) || '';
          this.uid = (res.user && res.user.id) || '';
          await jsapiStorageSet(TOUTIAO_KEYS.session, { uname: this.uname, uid: this.uid, at: Date.now() });
          this.stopLoginPoll();
          this.closeLogin();
          this.showToast('登录成功' + (this.uname ? '：' + this.uname : ''), 2600);
        } else if (res.status === 'expired' || res.status === 'refused') {
          this.stopLoginPoll();
        }
      } catch (error) {
        // 网络抖动不打断轮询，连续失败太多次才停
        this.loginFailCount += 1;
        if (this.loginFailCount >= 5) {
          this.stopLoginPoll();
          this.errText = '登录轮询失败：' + ((error && error.message) || '');
        }
      }
    },
    stopLoginPoll() {
      if (this.loginTimer) {
        clearInterval(this.loginTimer);
        this.loginTimer = null;
      }
    },
    closeLogin() {
      this.stopLoginPoll();
      this.loginQr = null;
      this.loginStatus = '';
    },
    async loadSession() {
      try {
        const s = await jsapiStorageGet(TOUTIAO_KEYS.session);
        if (s && (s.uid || s.uname)) {
          this.logged = true;
          this.uname = s.uname || '';
          this.uid = s.uid || '';
        }
      } catch (error) {
        this.logged = false;
      }
    },
    async doLogout() {
      this.logged = false;
      this.uname = '';
      this.uid = '';
      await jsapiStorageSet(TOUTIAO_KEYS.session, null);
      this.showToast('已退出头条登录（不影响抖音登录）');
    },

    // 深链：options.tab 切分区；options.group 直接打开某条正文；
    // options.source='hot' 时列表先切热榜。
    // 另外认一个**一次性 storage 提示**（PENDING_GROUP_KEY）—— 因为模拟器/设备把启动页
    // 参数当页面名整体解析（实测 `launchPage(toutiao?group=…)` 直接白屏），
    // 传不了查询串；用 storage 就需要一条真正能用的深链通路。
    async applyDeepLink(options) {
      const opt = options || {};
      if (opt.source === 'hot') {
        this.source = 'hot';
        this.loadHot();
      }
      const tab = parseInt(opt.tab, 10);
      if (!isNaN(tab) && tab >= 0 && tab <= 3) this.tab = tab;
      let gid = String(opt.group || '').trim();
      if (!gid) {
        try {
          const pending = await jsapiStorageGet(PENDING_GROUP_KEY);
          if (pending && pending.group) {
            gid = String(pending.group);
            if (pending.title) opt.title = pending.title;
            // 只生效一次
            await jsapiStorageSet(PENDING_GROUP_KEY, null);
          }
        } catch (error) {
          /* 读不到就当没有深链 */
        }
      }
      if (gid) {
        // 先让阅读视图有标题可显示，正文拿到后再覆盖
        this.openItem({ groupId: gid, title: opt.title || '', abstract: opt.abstract || '' });
      }
    }
  },

  async onLoad(options) {
    // 先把列表拉起来：storage 读取（session/likes/history）各自有 1.5s 超时，
    // 若串行 await 会把首屏网络请求一起拖住 —— 首页列表不该等本地状态。
    this.loadFeed(true);
    this.loadSession();
    this.loadLikes();
    this.loadHistory();
    this.loadLocalComments();
    // 深链：navTo('toutiao', { group: '<groupId>', tab: 1 }) 可直接落到某条正文/某个分区。
    // 用于「继续阅读」这类入口，也让自动化验收不必依赖模拟器的点击（它时灵时不灵）。
    this.applyDeepLink(options);
  },
  onShow() {
    if (this.tab === 0 && !this.feed.length) this.loadFeed(true);
  },
  onHide() {
    this.stopLoginPoll();
  },
  onDestroy() {
    this.stopLoginPoll();
    if (this.toastTimer) clearTimeout(this.toastTimer);
  }
};
</script>

<style lang="less" scoped>
/* 逻辑横屏 800×254。Weex 只支持单类名选择器。 */
.screen {
  position: relative;
  width: 100%;
  height: 100%;
  background-color: #0e0e12;
  overflow: hidden;
}

/* ---------- 顶栏 ---------- */
.bar {
  position: absolute;
  left: 46px;
  top: 0;
  right: 0;
  height: 28px;
  flex-direction: row;
  align-items: center;
  padding-left: 10px;
  padding-right: 10px;
  background-color: #15151b;
}
.bar-title {
  color: #ffffff;
  font-size: 14px;
  font-weight: bold;
}
.bar-sub {
  color: #6f757c;
  font-size: 10px;
  margin-left: 8px;
}
.bar-right {
  flex: 1;
  flex-direction: row;
  align-items: center;
  justify-content: flex-end;
}
.bar-user {
  color: #b9bec4;
  font-size: 10px;
  margin-left: 8px;
}
.btn-bar {
  height: 19px;
  padding-left: 9px;
  padding-right: 9px;
  border-radius: 10px;
  background-color: #26262e;
  justify-content: center;
  align-items: center;
  margin-left: 6px;
}
.btn-bar-txt {
  color: #ffffff;
  font-size: 10px;
}

/* ---------- 左侧分区栏 ---------- */
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
.rail-item {
  width: 40px;
  height: 42px;
  align-items: center;
  justify-content: center;
  border-radius: 6px;
  margin-bottom: 4px;
}
.rail-txt {
  font-size: 11px;
  color: rgba(255, 255, 255, 0.6);
}
.rail-txt-active {
  color: #fe2c55;
  font-weight: bold;
}

/* ---------- 列表 ---------- */
.list {
  position: absolute;
  left: 46px;
  top: 28px;
  right: 0;
  bottom: 0;
}
.row {
  min-height: 62px;
  flex-direction: row;
  align-items: center;
  padding-left: 10px;
  padding-right: 10px;
  padding-top: 6px;
  padding-bottom: 6px;
  border-bottom-width: 1px;
  border-bottom-style: solid;
  border-bottom-color: rgba(255, 255, 255, 0.08);
}
.row-cover {
  width: 74px;
  height: 50px;
  border-radius: 5px;
  background-color: #23272b;
  align-items: center;
  justify-content: center;
}
.row-img {
  width: 74px;
  height: 50px;
  border-radius: 5px;
}
/* 无可用封面时的占位（头条内容图未签名，实测一律取不到） */
.row-ph {
  color: #5a6068;
  font-size: 18px;
  font-weight: bold;
}
.row-tag {
  position: absolute;
  left: 4px;
  top: 4px;
  font-size: 8px;
  color: #ffffff;
  background-color: rgba(254, 44, 85, 0.9);
  padding-left: 4px;
  padding-right: 4px;
  border-radius: 3px;
}
.row-copy {
  flex: 1;
  flex-direction: column;
  padding-left: 10px;
  padding-right: 6px;
}
.row-title {
  color: #ffffff;
  font-size: 12px;
  line-height: 16px;
}
.row-abs {
  color: rgba(255, 255, 255, 0.55);
  font-size: 10px;
  margin-top: 3px;
}
.row-meta {
  color: rgba(255, 255, 255, 0.4);
  font-size: 9px;
  margin-top: 3px;
}
.row-like {
  width: 40px;
  height: 26px;
  border-radius: 13px;
  background-color: #26262e;
  align-items: center;
  justify-content: center;
}
.row-like-txt {
  color: #b9bec4;
  font-size: 11px;
}
.row-like-on {
  color: #fe2c55;
  font-weight: bold;
}
.more {
  height: 36px;
  align-items: center;
  justify-content: center;
}
.more-txt {
  color: #8fd3ff;
  font-size: 11px;
}
.empty {
  margin-top: 40px;
  align-items: center;
}
.empty-title {
  color: #ffffff;
  font-size: 13px;
}
.empty-copy {
  color: rgba(255, 255, 255, 0.5);
  font-size: 10px;
  margin-top: 6px;
  text-align: center;
  padding-left: 20px;
  padding-right: 20px;
}

/* ---------- 正文阅读 ---------- */
.reader {
  position: absolute;
  left: 46px;
  top: 28px;
  right: 0;
  bottom: 0;
  padding-left: 12px;
  padding-right: 12px;
  flex-direction: column;
}
.reader-head {
  flex-direction: column;
}
.reader-title {
  color: #ffffff;
  font-size: 14px;
  font-weight: bold;
  line-height: 19px;
}
.reader-meta {
  color: rgba(255, 255, 255, 0.45);
  font-size: 9px;
  margin-top: 4px;
}
.reader-body {
  flex: 1;
  margin-top: 6px;
}
.reader-text {
  color: rgba(255, 255, 255, 0.9);
  font-size: 12px;
  line-height: 18px;
}
.reader-note {
  color: #ffaa2b;
  font-size: 9px;
  margin-top: 8px;
}

/* ---------- 评论 ---------- */
.cmt-head {
  color: #ffffff;
  font-size: 12px;
  font-weight: bold;
  margin-top: 14px;
}
.cmt-note {
  color: #6f757c;
  font-size: 9px;
  margin-top: 4px;
  margin-bottom: 6px;
}
.cmt-row {
  flex-direction: row;
  align-items: center;
  padding-top: 6px;
  padding-bottom: 6px;
  border-bottom-width: 1px;
  border-bottom-style: solid;
  border-bottom-color: rgba(255, 255, 255, 0.08);
}
.cmt-txt {
  flex: 1;
  color: rgba(255, 255, 255, 0.9);
  font-size: 11px;
  line-height: 16px;
}
.cmt-at {
  color: #6f757c;
  font-size: 9px;
  margin-left: 6px;
}
.cmt-del {
  width: 34px;
  height: 22px;
  margin-left: 6px;
  border-radius: 4px;
  background-color: #3a3f44;
  align-items: center;
  justify-content: center;
}
.cmt-del-txt {
  color: #ff9aa9;
  font-size: 10px;
}
.cmt-empty {
  color: #666b70;
  font-size: 10px;
  margin-top: 8px;
}
.cmt-editor {
  position: absolute;
  left: 0;
  top: 0;
  right: 0;
  bottom: 0;
  z-index: 40;
  background-color: #0e0e12;
  padding-left: 12px;
  padding-right: 12px;
  padding-top: 8px;
}
.cmt-editor-title {
  color: #ffffff;
  font-size: 12px;
  font-weight: bold;
}
.cmt-editor-val {
  height: 26px;
  margin-top: 6px;
  padding-left: 8px;
  padding-right: 8px;
  border-radius: 5px;
  background-color: #23272b;
  justify-content: center;
}
.cmt-editor-txt {
  color: #25f4ee;
  font-size: 12px;
}
.cmt-editor-btns {
  flex-direction: row;
  align-items: center;
  margin-top: 6px;
  margin-bottom: 2px;
}
.reader-actions {
  flex-direction: row;
  align-items: center;
  padding-top: 6px;
  padding-bottom: 6px;
}
.btn-act {
  height: 26px;
  padding-left: 14px;
  padding-right: 14px;
  margin-right: 8px;
  border-radius: 13px;
  background-color: #26262e;
  justify-content: center;
  align-items: center;
}
.btn-act-on {
  background-color: #fe2c55;
}
.btn-act-txt {
  color: #ffffff;
  font-size: 11px;
}

/* ---------- 我的 ---------- */
.mine {
  position: absolute;
  left: 58px;
  top: 34px;
  right: 12px;
  flex-direction: column;
}
.mine-user {
  flex-direction: row;
  align-items: center;
}
.mine-avatar {
  width: 38px;
  height: 38px;
  border-radius: 19px;
  background-color: #fe2c55;
  align-items: center;
  justify-content: center;
}
.mine-avatar-txt {
  color: #ffffff;
  font-size: 16px;
  font-weight: bold;
}
.mine-copy {
  flex: 1;
  flex-direction: column;
  padding-left: 10px;
}
.mine-name {
  color: #ffffff;
  font-size: 14px;
  font-weight: bold;
}
.mine-sub {
  color: rgba(255, 255, 255, 0.5);
  font-size: 10px;
  margin-top: 3px;
}
.mine-btns {
  flex-direction: row;
  align-items: center;
  margin-top: 12px;
}
.mine-stat {
  color: #8fd3ff;
  font-size: 10px;
  margin-top: 10px;
}
.mine-note {
  color: rgba(255, 255, 255, 0.4);
  font-size: 9px;
  margin-top: 5px;
}

/* ---------- 登录弹层 ---------- */
.qr-overlay {
  position: absolute;
  left: 0;
  right: 0;
  top: 0;
  bottom: 0;
  z-index: 30;
  align-items: center;
  justify-content: center;
  background-color: rgba(0, 0, 0, 0.8);
}
.qr-panel {
  width: 240px;
  padding: 12px;
  align-items: center;
  background-color: #ffffff;
  border-radius: 10px;
}
.qr-title {
  color: #16181c;
  font-size: 13px;
  font-weight: bold;
  margin-bottom: 8px;
}
.qr-img {
  width: 116px;
  height: 116px;
  margin-bottom: 5px;
}
.qr-hint {
  color: #666666;
  font-size: 9px;
  text-align: center;
}
.qr-status {
  color: #fe2c55;
  font-size: 11px;
  margin-top: 5px;
  font-weight: bold;
}
.qr-actions {
  flex-direction: row;
  margin-top: 9px;
}
.qr-btn {
  width: 80px;
  height: 30px;
  margin-left: 5px;
  margin-right: 5px;
  border-radius: 6px;
  background-color: #fe2c55;
  align-items: center;
  justify-content: center;
}
.qr-btn-ghost {
  background-color: #e8eaed;
}
.qr-btn-txt {
  color: #ffffff;
  font-size: 11px;
}
.qr-btn-ghost-txt {
  color: #555555;
  font-size: 11px;
}

/* ---------- 提示 ---------- */
.toast {
  position: absolute;
  left: 60px;
  right: 60px;
  bottom: 10px;
  z-index: 20;
  padding: 7px;
  color: #ffffff;
  font-size: 11px;
  text-align: center;
  background-color: rgba(20, 20, 20, 0.92);
  border-radius: 5px;
}
.err {
  position: absolute;
  left: 52px;
  bottom: 2px;
  color: #ff8298;
  font-size: 9px;
}
</style>
