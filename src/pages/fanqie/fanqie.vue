<template>
  <div class="screen">
    <!-- ============ 顶栏 ============ -->
    <div class="bar">
      <text class="bar-title">番茄小说</text>
      <text class="bar-sub">{{ barSub }}</text>
      <div class="bar-right">
        <div class="btn-bar" v-if="tab === 0 && !reader" @click="reload">
          <text class="btn-bar-txt">刷新</text>
        </div>
        <div class="btn-bar" v-if="reader" @click="closeReader">
          <text class="btn-bar-txt">返回书页</text>
        </div>
        <text class="bar-user">{{ logged ? (uname || '已登录') : '未登录' }}</text>
      </div>
    </div>

    <!-- ============ 章节列表（选中一本书后）============ -->
    <scroller class="list" v-if="book && !reader" show-scrollbar="false">
      <div class="bookhead">
        <div class="bh-cover">
          <image class="bh-img" v-if="book.cover" :src="coverSrc(book.cover)" mode="aspectFill"></image>
          <text class="bh-ph" v-else>书</text>
        </div>
        <div class="bh-copy">
          <text class="bh-title">{{ book.title }}</text>
          <text class="bh-author">{{ book.author }}</text>
          <text class="bh-abs">{{ book.abstract || '（无简介）' }}</text>
          <text class="bh-meta">共 {{ book.chapters.length }} 章 · 可读性要打开才知道（部分章服务端不给正文）</text>
          <text class="bh-dl" v-if="dlStat.chapters">已下载 {{ dlStat.chapters }} 章（离线可读）· {{ dlSizeText }}</text>
          <text class="bh-dl" v-else>未下载 — 点「下载可读章节」缓存到本机，之后离线也能看</text>
        </div>
      </div>
      <div class="dl-bar">
        <div class="btn-act" :class="[downloading ? 'btn-act-off' : '']" @click="startDownload">
          <text class="btn-act-txt">{{ downloading ? '下载中…' : (dlStat.chapters ? '继续下载' : '下载可读章节') }}</text>
        </div>
        <div class="btn-act" v-if="downloading" @click="stopDownload">
          <text class="btn-act-txt">停止</text>
        </div>
        <div class="btn-act" v-if="dlStat.chapters && !downloading" @click="clearDownload">
          <text class="btn-act-txt">清除缓存</text>
        </div>
        <text class="dl-progress">{{ dlProgress }}</text>
      </div>
      <div class="row" v-for="(c, i) in book.chapters" :key="c.id" @click="openChapter(i)">
        <text class="ch-idx">{{ i + 1 }}</text>
        <text class="ch-title">{{ c.title }}</text>
        <text class="ch-dl" v-if="isChapterCached(c.id)">已存</text>
        <text class="ch-cur" v-if="progressOf(book.bookId) && progressOf(book.bookId).chapterId === c.id">在读</text>
      </div>
    </scroller>

    <!-- ============ 阅读视图 ============ -->
    <div class="reader" v-if="reader">
      <div class="reader-head">
        <text class="reader-title">{{ reader.title }}</text>
        <text class="reader-meta">{{ reader.bookName }} · {{ reader.author }}</text>
      </div>
      <scroller class="reader-body" show-scrollbar="false">
        <text class="reader-text">{{ reader.content }}</text>
        <text class="reader-note" v-if="reader.ratio > 0">
          该章含 {{ reader.masked }} 个字体反爬字符（占 {{ reader.ratio }}%），已显示为「□」。
          番茄把常用字换成了自定义字体里的私用区码点，笔上还原不了；未替换的部分可正常阅读。
        </text>
      </scroller>
      <div class="reader-actions">
        <div class="btn-act" :class="[reader.prevItemId ? '' : 'btn-act-off']" @click="goChapter('prev')">
          <text class="btn-act-txt">上一章</text>
        </div>
        <div class="btn-act" :class="[reader.nextItemId ? '' : 'btn-act-off']" @click="goChapter('next')">
          <text class="btn-act-txt">下一章</text>
        </div>
        <div class="btn-act" :class="[inShelf(book) ? 'btn-act-on' : '']" @click="toggleShelfBook">
          <text class="btn-act-txt">{{ inShelf(book) ? '已收藏' : '收藏' }}</text>
        </div>
        <text class="reader-cache" v-if="reader.fromCache">离线缓存</text>
      </div>
    </div>

    <!-- ============ 书架 / 阅读历史 ============ -->
    <scroller class="list" v-if="!book && !reader" show-scrollbar="false">
      <div class="row" v-for="(b, i) in visibleList" :key="b.bookId + '_' + i" @click="openBook(b)">
        <div class="row-cover">
          <image class="row-img" v-if="b.cover" :src="coverSrc(b.cover)" mode="aspectFill"></image>
          <text class="row-ph" v-else>书</text>
        </div>
        <div class="row-copy">
          <text class="row-title">{{ b.title }}</text>
          <text class="row-abs" v-if="b.abstract">{{ b.abstract }}</text>
          <text class="row-meta">{{ rowMeta(b) }}</text>
        </div>
      </div>
      <div class="empty" v-if="!visibleList.length">
        <text class="empty-title">{{ emptyText }}</text>
        <text class="empty-copy">{{ errText || emptyCopy }}</text>
      </div>
    </scroller>

    <!-- ============ 我的 ============ -->
    <div class="mine" v-if="tab === 2 && !book && !reader">
      <div class="mine-user">
        <div class="mine-avatar">
          <text class="mine-avatar-txt">{{ logged ? avatarChar : '未' }}</text>
        </div>
        <div class="mine-copy">
          <text class="mine-name">{{ logged ? (uname || '番茄用户') : '未登录' }}</text>
          <text class="mine-sub">{{ logged ? ('ID ' + (uid || '未知')) : '登录走字节统一账号 SSO' }}</text>
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
      <text class="mine-stat">书架 {{ shelf.length }} 本 · 阅读记录 {{ readHistory.length }} 条</text>
      <text class="mine-note">登录走字节统一账号 SSO（service=fanqienovel.com），扫码页显示「番茄小说」。</text>
      <text class="mine-note">书源仅榜单 26 本（番茄的搜索/分类接口未公开）；正文有字体反爬，见下。</text>
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

    <!-- ============ 登录弹层 ============ -->
    <div class="qr-overlay" v-if="loginQr" @click="closeLogin">
      <div class="qr-panel" @click.stop>
        <text class="qr-title">番茄小说扫码登录</text>
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
  fetchFanqieShelf,
  fetchFanqieBook,
  fetchFanqieChapter,
  loadShelf,
  inShelf,
  toggleShelf,
  persistShelf,
  loadProgress,
  saveProgressTo,
  persistProgress,
  loadReadHistory,
  pushReadHistory,
  persistReadHistory,
  relativeTime,
  loadDownloads,
  persistDownloads,
  isDownloaded,
  cachedChapter,
  downloadStat,
  downloadBook,
  pruneDownloads,
  FANQIE_KEYS
} from '../../services/fanqie-api.js';
import { jsapiStorageGet, jsapiStorageSet, relayAssetUrl } from '../../services/libjsapi.js';
import { requestLoginQr, checkLoginQr } from '../../services/douyin-auth.js';

const POLL_MS = 2000;

export default {
  name: 'Fanqie',
  data() {
    return {
      sections: [
        { idx: 0, label: '书架' },
        { idx: 1, label: '最近' },
        { idx: 2, label: '我的' }
      ],
      tab: 0,
      shelfBooks: [],      // 榜单拉来的全部书（书源）
      shelf: [],           // 本地收藏
      readHistory: [],
      progress: {},
      book: null,          // 当前打开的书（含章节表）
      reader: null,        // 当前读的章
      chapterIndex: -1,
      // 下载（离线缓存正文文本；设备无文件 API，见 fanqie-api.js 说明）
      downloads: {},
      downloading: false,
      dlStopFlag: false,
      dlProgress: '',
      dlDone: 0,
      dlLocked: 0,
      dlFailed: 0,
      loading: false,
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
      if (this.tab === 1) return this.readHistory;
      if (this.tab === 2) return [];
      // 书架：优先显示本地收藏；没收藏时显示榜单全部（等同于书源）
      return this.shelf.length ? this.shelf : this.shelfBooks;
    },
    barSub() {
      if (this.reader) return '阅读中';
      if (this.book) return '章节目录';
      if (this.tab === 0) return this.shelf.length ? '我的书架' : '榜单书源';
      if (this.tab === 1) return '最近阅读';
      return '账号';
    },
    emptyText() {
      if (this.tab === 1) return '还没有阅读记录';
      return this.loading ? '加载中…' : '没有书';
    },
    emptyCopy() {
      if (this.tab === 1) return '打开任意一本书读一章就会记在这里';
      return '点右上角刷新重试';
    },
    avatarChar() {
      return (this.uname || '番').slice(0, 1);
    },
    dlStat() {
      if (!this.book) return { chapters: 0, chars: 0 };
      return downloadStat(this.downloads, this.book.bookId);
    },
    dlSizeText() {
      const n = this.dlStat.chars;
      if (n < 1000) return n + ' 字';
      return (n / 1000).toFixed(1) + ' 千字';
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
    // 封面走 <image>（原生图像栈），无 TLS 的固件/模拟器要套中转（与抖音/头条同一套做法）
    coverSrc(url) { return relayAssetUrl(url); },
    rowMeta(b) {
      const bits = [];
      if (b.author) bits.push(b.author);
      if (b.chapterIndex !== undefined && b.chapterIndex >= 0) bits.push('读到第 ' + (b.chapterIndex + 1) + ' 章');
      const t = relativeTime(b.at);
      if (t) bits.push(t);
      return bits.join(' · ');
    },

    // ---------- 书架 ----------
    selectTab(idx) {
      this.tab = idx;
      this.errText = '';
      if (idx === 0 && !this.shelfBooks.length) this.reload();
    },
    async reload() {
      if (this.loading) return;
      this.loading = true;
      this.errText = '';
      try {
        this.shelfBooks = await fetchFanqieShelf();
      } catch (error) {
        this.errText = '书单加载失败：' + ((error && error.message) || '');
      } finally {
        this.loading = false;
      }
    },
    isInShelf(b) { return !!(b && inShelf(this.shelf, b.bookId)); },
    inShelf(b) { return this.isInShelf(b); },
    async toggleShelfBook() {
      if (!this.book) return;
      const was = this.isInShelf(this.book);
      this.shelf = toggleShelf(this.shelf, this.book);
      await persistShelf(this.shelf);
      this.showToast(was ? '已移出书架' : '已加入书架');
    },
    async loadLocal() {
      this.shelf = await loadShelf();
      this.progress = await loadProgress();
      this.readHistory = await loadReadHistory();
      this.downloads = await loadDownloads();
    },
    progressOf(bookId) {
      return this.progress[String(bookId || '')] || null;
    },

    // ---------- 打开书 / 读章 ----------
    async openBook(b) {
      if (!b || !b.bookId) return;
      this.showToast('正在取章节目录…', 1200);
      this.errText = '';
      try {
        this.book = await fetchFanqieBook(b.bookId, b);
        this.chapterIndex = -1;
      } catch (error) {
        this.errText = '取目录失败：' + ((error && error.message) || '');
      }
    },
    closeBook() {
      this.book = null;
      this.reader = null;
      this.chapterIndex = -1;
      this.dlProgress = '';
    },
    isChapterCached(cid) {
      return !!(this.book && isDownloaded(this.downloads, this.book.bookId, cid));
    },
    async openChapter(index) {
      if (!this.book || index < 0 || index >= this.book.chapters.length) return;
      const c = this.book.chapters[index];
      this.errText = '';
      // ① 先看本地缓存（下载过的章离线可读，不再请求网络）
      const hit = cachedChapter(this.downloads, this.book.bookId, c.id);
      if (hit && hit.c) {
        this.reader = {
          kind: 'chapter',
          chapterId: c.id,
          bookId: this.book.bookId,
          bookName: this.book.title,
          author: this.book.author,
          title: hit.t || c.title,
          content: hit.c,
          masked: 0,
          total: hit.c.length,
          ratio: 0,
          locked: false,
          fromCache: true,
          nextItemId: (this.book.chapters[index + 1] && this.book.chapters[index + 1].id) || '',
          prevItemId: (this.book.chapters[index - 1] && this.book.chapters[index - 1].id) || ''
        };
        this.chapterIndex = index;
        await this.rememberProgress(this.reader, index);
        this.showToast('离线缓存', 1000);
        return;
      }
      // ② 没缓存才走网络
      this.showToast('正在取正文…', 1200);
      try {
        const ch = await fetchFanqieChapter(c.id, {
          bookId: this.book.bookId,
          bookName: this.book.title,
          author: this.book.author,
          title: c.title
        });
        if (ch.locked) {
          // 服务端只回了占位：如实说明，不要伪装成"加载失败"
          this.errText = '这一章拿不到正文（服务端返回占位，约 24 字）。番茄的部分章节笔上读不了。';
          return;
        }
        this.reader = ch;
        this.chapterIndex = index;
        await this.rememberProgress(ch, index);
      } catch (error) {
        this.errText = '取正文失败：' + ((error && error.message) || '');
      }
    },

    // ---------- 下载（把可读章节的正文缓存到本机）----------
    // ⚠️ 设备没有文件 API，所以这不是"下载文件"，而是**离线文本缓存**。
    //    详见 fanqie-api.js 顶部说明与 HANDOFF §14。
    async startDownload() {
      if (!this.book || this.downloading) return;
      this.downloading = true;
      this.dlStopFlag = false;
      this.dlDone = 0;
      this.dlLocked = 0;
      this.dlFailed = 0;
      this.dlProgress = '准备中…';
      const total = this.book.chapters.length;
      let flushed = this.downloads;
      try {
        const res = await downloadBook(this.book, {
          existing: this.downloads,
          // 已有缓存的章跳过，所以每次从 0 走（函数内部会 isDownloaded 判重）
          maxChapters: 40,
          // 遇到锁定章**不停止**：实测前 6 章是「可读/锁/锁/锁/可读/锁」，
          // 看到第 2 章就停会漏掉第 5 章。连续跳过 60 章都没收获才收工。
          skipLimit: 60,
          delayMs: 220,
          onProgress: (p) => {
            this.dlProgress = '第 ' + (p.index + 1) + '/' + total + ' 章 · 已存 ' + p.done
              + (p.locked ? ' · 跳过 ' + p.locked : '') + ' · ' + p.title;
            if (this.dlStopFlag) return false;
            return true;
          }
        });
        flushed = res.all;
        this.downloads = res.all;
        await persistDownloads(res.all);
        this.dlDone = res.done;
        this.dlLocked = res.locked;
        this.dlFailed = res.failed;
        // 如实说明"停"的原因，不谎称下全了
        if (this.dlStopFlag) {
          this.dlProgress = '已停止，已存 ' + res.done + ' 章';
        } else if (res.done >= 40) {
          this.dlProgress = '已存满 40 章（本机上限），可清除缓存后重下';
        } else if (res.locked && res.done) {
          this.dlProgress = '已存 ' + res.done + ' 章，跳过 ' + res.locked
            + ' 章（服务端不给正文），后面也没有更多可读章了';
        } else if (res.done) {
          this.dlProgress = '已完成 ' + res.done + ' 章'
            + (res.failed ? '，失败 ' + res.failed + ' 章（可再点继续下载）' : '');
        } else {
          this.dlProgress = '这本书没有可缓存的正文（服务端全部只回占位）';
        }
        this.showToast(this.dlProgress, 3000);
      } catch (error) {
        // 中断也要保住已完成的部分
        this.downloads = pruneDownloads(flushed);
        await persistDownloads(this.downloads);
        this.errText = '下载中断：' + ((error && error.message) || '');
      } finally {
        this.downloading = false;
        this.dlStopFlag = false;
      }
    },
    stopDownload() {
      this.dlStopFlag = true;
      this.dlProgress = '正在停止…';
      this.showToast('会在当前这章之后停下');
    },
    async clearDownload() {
      if (!this.book) return;
      const next = Object.assign({}, this.downloads);
      delete next[this.book.bookId];
      this.downloads = next;
      await persistDownloads(next);
      this.dlProgress = '';
      this.showToast('已清除这本书的离线缓存');
    },
    closeReader() {
      this.reader = null;
    },
    async goChapter(dir) {
      if (!this.book || !this.reader) return;
      let idx = -1;
      if (dir === 'next') {
        // 优先用服务端给的 nextItemId 定位，找不到再按序号 +1
        if (this.reader.nextItemId) {
          idx = this.book.chapters.findIndex((c) => c.id === this.reader.nextItemId);
        }
        if (idx < 0) idx = this.chapterIndex + 1;
      } else {
        if (this.reader.prevItemId) {
          idx = this.book.chapters.findIndex((c) => c.id === this.reader.prevItemId);
        }
        if (idx < 0) idx = this.chapterIndex - 1;
      }
      if (idx < 0 || idx >= this.book.chapters.length) {
        this.showToast(dir === 'next' ? '已经是最后一章' : '已经是第一章');
        return;
      }
      await this.openChapter(idx);
    },
    async rememberProgress(ch, index) {
      const entry = {
        chapterId: ch.chapterId,
        chapterIndex: index,
        title: ch.title || (this.book.chapters[index] && this.book.chapters[index].title) || ''
      };
      this.progress = saveProgressTo(this.progress, this.book.bookId, entry);
      await persistProgress(this.progress);
      this.readHistory = pushReadHistory(this.readHistory, Object.assign({
        bookId: this.book.bookId,
        bookName: this.book.title,
        author: this.book.author,
        cover: this.book.cover
      }, entry));
      await persistReadHistory(this.readHistory);
    },

    // ---------- 登录（字节统一账号 SSO，扫码端显示「番茄小说」）----------
    async openLogin() {
      this.stopLoginPoll();
      this.loginStatus = '';
      this.loginFailCount = 0;
      try {
        const qr = await requestLoginQr({ hint: '请使用抖音/番茄 APP 扫码登录' });
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
          await jsapiStorageSet(FANQIE_KEYS.session, { uname: this.uname, uid: this.uid, at: Date.now() });
          this.stopLoginPoll();
          this.closeLogin();
          this.showToast('登录成功' + (this.uname ? '：' + this.uname : ''), 2600);
        } else if (res.status === 'expired' || res.status === 'refused') {
          this.stopLoginPoll();
        }
      } catch (error) {
        this.loginFailCount += 1;
        if (this.loginFailCount >= 5) {
          this.stopLoginPoll();
          this.errText = '登录轮询失败：' + ((error && error.message) || '');
        }
      }
    },
    stopLoginPoll() {
      if (this.loginTimer) { clearInterval(this.loginTimer); this.loginTimer = null; }
    },
    closeLogin() {
      this.stopLoginPoll();
      this.loginQr = null;
      this.loginStatus = '';
    },
    async loadSession() {
      try {
        const s = await jsapiStorageGet(FANQIE_KEYS.session);
        if (s && (s.uid || s.uname)) {
          this.logged = true;
          this.uname = s.uname || '';
          this.uid = s.uid || '';
        }
      } catch (error) { this.logged = false; }
    },
    async doLogout() {
      this.logged = false;
      this.uname = '';
      this.uid = '';
      await jsapiStorageSet(FANQIE_KEYS.session, null);
      this.showToast('已退出番茄登录（不影响抖音/头条）');
    }
  },

  async onLoad() {
    // 先把书单拉起来，本地状态并行读（各自有超时，别串行拖慢首屏）
    this.reload();
    this.loadLocal();
    this.loadSession();
  },
  onShow() {
    if (this.tab === 0 && !this.shelfBooks.length) this.reload();
  },
  onHide() { this.stopLoginPoll(); },
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
  background-color: #14110e;
  overflow: hidden;
}
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
  background-color: #1d1913;
}
.bar-title { color: #ffffff; font-size: 14px; font-weight: bold; }
.bar-sub { color: #7c7367; font-size: 10px; margin-left: 8px; }
.bar-right { flex: 1; flex-direction: row; align-items: center; justify-content: flex-end; }
.bar-user { color: #cbbfae; font-size: 10px; margin-left: 8px; }
.btn-bar {
  height: 19px; padding-left: 9px; padding-right: 9px; border-radius: 10px;
  background-color: #332c22; justify-content: center; align-items: center; margin-left: 6px;
}
.btn-bar-txt { color: #ffffff; font-size: 10px; }

.rail {
  position: absolute; left: 0; top: 0; bottom: 0; width: 46px; z-index: 9;
  flex-direction: column; align-items: center; padding-top: 6px;
  background-color: rgba(255, 255, 255, 0.06);
}
.rail-back {
  width: 40px; height: 24px; margin-bottom: 6px; border-radius: 6px;
  background-color: rgba(255, 255, 255, 0.14); align-items: center; justify-content: center;
}
.rail-back-txt { font-size: 9px; color: #ffffff; font-weight: bold; }
.rail-item { width: 40px; height: 42px; align-items: center; justify-content: center; border-radius: 6px; margin-bottom: 4px; }
.rail-txt { font-size: 11px; color: rgba(255, 255, 255, 0.6); }
.rail-txt-active { color: #ff7a45; font-weight: bold; }

.list { position: absolute; left: 46px; top: 28px; right: 0; bottom: 0; }
.row {
  min-height: 58px; flex-direction: row; align-items: center;
  padding-left: 10px; padding-right: 10px; padding-top: 6px; padding-bottom: 6px;
  border-bottom-width: 1px; border-bottom-style: solid; border-bottom-color: rgba(255, 255, 255, 0.08);
}
.row-cover {
  width: 42px; height: 56px; border-radius: 4px; background-color: #2b2419;
  align-items: center; justify-content: center;
}
.row-img { width: 42px; height: 56px; border-radius: 4px; }
.row-ph { color: #6b6153; font-size: 18px; font-weight: bold; }
.row-copy { flex: 1; flex-direction: column; padding-left: 10px; }
.row-title { color: #ffffff; font-size: 13px; }
.row-abs { color: rgba(255, 255, 255, 0.55); font-size: 10px; margin-top: 3px; }
.row-meta { color: rgba(255, 255, 255, 0.4); font-size: 9px; margin-top: 3px; }

.bookhead {
  flex-direction: row; padding: 10px;
  border-bottom-width: 1px; border-bottom-style: solid; border-bottom-color: rgba(255, 255, 255, 0.12);
}
.bh-cover { width: 56px; height: 74px; border-radius: 5px; background-color: #2b2419; align-items: center; justify-content: center; }
.bh-img { width: 56px; height: 74px; border-radius: 5px; }
.bh-ph { color: #6b6153; font-size: 22px; font-weight: bold; }
.bh-copy { flex: 1; flex-direction: column; padding-left: 12px; }
.bh-title { color: #ffffff; font-size: 15px; font-weight: bold; }
.bh-author { color: #cbbfae; font-size: 11px; margin-top: 3px; }
.bh-abs { color: rgba(255, 255, 255, 0.5); font-size: 10px; margin-top: 5px; }
.bh-meta { color: #ff7a45; font-size: 9px; margin-top: 5px; }

.ch-idx { width: 30px; color: #6b6153; font-size: 10px; }
.ch-title { flex: 1; color: rgba(255, 255, 255, 0.9); font-size: 12px; }
.ch-cur { color: #ff7a45; font-size: 9px; }
.ch-dl { color: #5aa76a; font-size: 9px; margin-left: 6px; }

/* 下载区 */
.dl-bar {
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
.dl-progress { flex: 1; color: #7c7367; font-size: 9px; margin-left: 6px; }
.bh-dl { color: #5aa76a; font-size: 9px; margin-top: 4px; }
.reader-cache { color: #5aa76a; font-size: 9px; margin-left: 4px; }

.reader { position: absolute; left: 46px; top: 28px; right: 0; bottom: 0; padding-left: 12px; padding-right: 12px; flex-direction: column; }
.reader-head { flex-direction: column; }
.reader-title { color: #ffffff; font-size: 14px; font-weight: bold; }
.reader-meta { color: rgba(255, 255, 255, 0.45); font-size: 9px; margin-top: 3px; }
.reader-body { flex: 1; margin-top: 6px; }
.reader-text { color: rgba(255, 255, 255, 0.88); font-size: 12px; line-height: 19px; }
.reader-note { color: #ffaa2b; font-size: 9px; margin-top: 10px; }
.reader-actions { flex-direction: row; align-items: center; padding-top: 6px; padding-bottom: 6px; }
.btn-act {
  height: 26px; padding-left: 14px; padding-right: 14px; margin-right: 8px; border-radius: 13px;
  background-color: #332c22; justify-content: center; align-items: center;
}
.btn-act-on { background-color: #ff7a45; }
.btn-act-off { background-color: #241f18; }
.btn-act-txt { color: #ffffff; font-size: 11px; }

.mine { position: absolute; left: 58px; top: 34px; right: 12px; flex-direction: column; }
.mine-user { flex-direction: row; align-items: center; }
.mine-avatar { width: 38px; height: 38px; border-radius: 19px; background-color: #ff7a45; align-items: center; justify-content: center; }
.mine-avatar-txt { color: #ffffff; font-size: 16px; font-weight: bold; }
.mine-copy { flex: 1; flex-direction: column; padding-left: 10px; }
.mine-name { color: #ffffff; font-size: 14px; font-weight: bold; }
.mine-sub { color: rgba(255, 255, 255, 0.5); font-size: 10px; margin-top: 3px; }
.mine-btns { flex-direction: row; align-items: center; margin-top: 12px; }
.mine-stat { color: #ffb08a; font-size: 10px; margin-top: 10px; }
.mine-note { color: rgba(255, 255, 255, 0.4); font-size: 9px; margin-top: 5px; }

.empty { margin-top: 40px; align-items: center; }
.empty-title { color: #ffffff; font-size: 13px; }
.empty-copy { color: rgba(255, 255, 255, 0.5); font-size: 10px; margin-top: 6px; text-align: center; padding-left: 20px; padding-right: 20px; }

.qr-overlay {
  position: absolute; left: 0; right: 0; top: 0; bottom: 0; z-index: 30;
  align-items: center; justify-content: center; background-color: rgba(0, 0, 0, 0.8);
}
.qr-panel { width: 240px; padding: 12px; align-items: center; background-color: #ffffff; border-radius: 10px; }
.qr-title { color: #16181c; font-size: 13px; font-weight: bold; margin-bottom: 8px; }
.qr-img { width: 116px; height: 116px; margin-bottom: 5px; }
.qr-hint { color: #666666; font-size: 9px; text-align: center; }
.qr-status { color: #ff7a45; font-size: 11px; margin-top: 5px; font-weight: bold; }
.qr-actions { flex-direction: row; margin-top: 9px; }
.qr-btn {
  width: 80px; height: 30px; margin-left: 5px; margin-right: 5px; border-radius: 6px;
  background-color: #ff7a45; align-items: center; justify-content: center;
}
.qr-btn-ghost { background-color: #e8eaed; }
.qr-btn-txt { color: #ffffff; font-size: 11px; }
.qr-btn-ghost-txt { color: #555555; font-size: 11px; }

.toast {
  position: absolute; left: 60px; right: 60px; bottom: 10px; z-index: 20; padding: 7px;
  color: #ffffff; font-size: 11px; text-align: center;
  background-color: rgba(20, 20, 20, 0.92); border-radius: 5px;
}
.err { position: absolute; left: 52px; bottom: 2px; color: #ff9aa9; font-size: 9px; }
</style>
