<template>
  <div class="screen">
    <!--
      原生视频区：画面由 libjsapi_better_video.so 直接写 /dev/fb0（逻辑横屏 800×254），
      不经 Falcon UI 合成。点按画面唤出/收起控制栏。
    -->
    <div class="videoarea" @click="toggleControls"></div>

    <!-- 原生模块不可用时（浏览器预览）退化为 HTML5 video，便于开发调试 -->
    <video
      v-if="fallbackMode"
      class="fallback"
      :src="path"
      controls
      autoplay
    ></video>

    <div class="centerbox" v-if="errorText">
      <text class="errtext">{{ errorText }}</text>
    </div>

    <div class="hintbox" v-if="showHint && !errorText">
      <text class="hinttext">点按画面唤出控制</text>
    </div>

    <!-- 屏上诊断（黑屏排查用）：显示是否拿到播放参数、play() 返回、以及播放状态/进度 -->
    <text class="dbgtext">{{ dbg }}</text>

    <!-- 控制栏：默认隐藏；唤出时视频区收缩到其上方（setView WITHBAR），互不遮挡 -->
    <div class="controls" v-if="controlsVisible">
      <div class="row1">
        <text class="time">{{ clock(positionMs) }}</text>
        <slider
          class="seekbar"
          :min="0"
          :max="seekMax"
          :step="1"
          :value="seekVal"
          active-color="#fe2c55"
          background-color="#3a3a3a"
          @change="onSeekChange"
        ></slider>
        <text class="time time-right">{{ durationMs > 0 ? clock(durationMs) : '--:--' }}</text>
      </div>
      <div class="row2">
        <div class="btn" @click="togglePlay"><text class="btntext">{{ playing ? '暂停' : '播放' }}</text></div>
        <div class="btn" @click="seekBy(-30)"><text class="btntext">-30s</text></div>
        <div class="btn" @click="seekBy(30)"><text class="btntext">+30s</text></div>
        <div class="btn btn-accent" @click="cycleRate"><text class="btntext accent-t">{{ rateLabel }}</text></div>
        <div class="volbox">
          <text class="volicon">音</text>
          <slider
            class="volbar"
            :min="0"
            :max="100"
            :step="5"
            :value="volume"
            active-color="#f5b85c"
            background-color="#3a3a3a"
            @change="onVolumeChange"
          ></slider>
          <text class="voltext">{{ volume }}</text>
        </div>
        <text class="qtag" v-if="qualityLabel">{{ qualityLabel }}</text>
        <div class="btn btn-back" @click="goBack"><text class="btntext">返回</text></div>
      </div>
    </div>

    <div class="toast" v-if="toastText"><text class="toasttext">{{ toastText }}</text></div>
  </div>
</template>

<script>
// 横屏播放页：视频由随包的原生模块绘制（Falcon UI 没有 <video> 组件）。
// 参考实现来自 better-video-player 项目，已按本工程（Vue 2 + 官方 aiot-cli）适配。
import bridge, { playUrlCandidates, orderByHostHealth, markHostBad, badHostList } from '../../services/native-player.js';
import { takePendingPlay } from '../../services/play-request.js';
import { detectScreen } from '../../services/device-screen.js';
import { jsapiStorageGet, jsapiStorageSet } from '../../services/libjsapi.js';

// 逻辑横屏 800×254（设备屏）
const FULL = { rectX: 0, rectY: 0, rectW: 800, rectH: 254 };
const WITHBAR = { rectX: 0, rectY: 0, rectW: 800, rectH: 190 };
const RATES = [1, 1.25, 1.5, 2, 0.5];
const HISTORY_KEY = 'native_play_history_v1';
// 断点续播历史的上限：键是**播放地址**（带一次性签名，几乎不会命中），
// 不设上限就会无限增长把 storage 撑爆。
const HISTORY_MAX = 60;

export default {
  name: 'Player',
  data() {
    return {
      path: '',
      name: '',
      positionMs: 0,
      durationMs: 0,
      seekVal: 0,
      seekMax: 1000,
      playing: false,
      ended: false,
      rate: 1,
      volume: 70,
      qualityLabel: '',
      errorText: '',
      // 真机逻辑分辨率（由 cfg.json 探测；原生侧按它算 blit 几何）
      screenW: 800,
      screenH: 254,
      // 黑屏排查用的屏上诊断文本
      dbg: '',
      dbgBase: '',
      screenInfo: '',
      controlsVisible: false,
      showHint: true,
      fallbackMode: false,
      // 直连失败后是否已改用中转重试过（避免中转也失败时无限递归）
      relayTried: false,
      // 本条的播放候选地址（轮换重试用）
      candidates: [],
      // 最近一次播放失败原因（重试过程中累积，最后统一提示）
      lastPlayError: '',
      toastText: ''
    };
  },
  computed: {
    rateLabel() {
      const r = Number(this.rate) || 1;
      return (r === Math.floor(r) ? r.toFixed(0) : String(r)) + 'x';
    }
  },
  methods: {
    clock(ms) {
      const total = Math.max(0, Math.floor((Number(ms) || 0) / 1000));
      const m = Math.floor(total / 60);
      const s = total % 60;
      return m + ':' + (s < 10 ? '0' + s : s);
    },
    toast(text, ms) {
      this.toastText = String(text || '');
      clearTimeout(this._toastTimer);
      this._toastTimer = setTimeout(() => { this.toastText = ''; }, ms || 2000);
    },
    goBack() {
      // 不同固件的返回 API 名称不一致，逐个尝试
      try {
        if (this.$page && typeof this.$page.finish === 'function') { this.$page.finish(); return; }
      } catch (error) { /* 继续尝试 */ }
      try {
        if (typeof $falcon !== 'undefined' && $falcon && typeof $falcon.navBack === 'function') { $falcon.navBack(); return; }
      } catch (error) { /* 继续尝试 */ }
      this.toast('当前运行时不支持返回，请用系统返回键', 2600);
    },
    toggleControls() {
      this.controlsVisible = !this.controlsVisible;
      this.showHint = false;
      if (!this.fallbackMode) {
        bridge.setView(this.controlsVisible ? WITHBAR : FULL);
      }
      if (this.controlsVisible) this.syncProgress();
    },
    // 依次尝试**多个等价播放入口**，直到有一个能播。
    // 为什么需要：`/aweme/v1/play/` 每次 302 到的 CDN 主机不同，有的要求 Referer（403）、
    // 有的不要求（200）。重试会重抽落点主机 —— 实测单形态 ~68%，轮换候选可达 100%。
    // 这样**不需要 PC 中转**也能播抖音 web feed 的视频。
    async startWithFallback(candidates, resumeMs) {
      // 尝试上限：候选有 8 个，**不要砍太狠**。
      // ★ PC 实测（20 条真实 uri，按候选顺序逐个试到成功）：
      //     第 1 个就成功 13/20、前 2 个 14、前 4 个 19、**全部 8 个 = 20/20（100%）**
      //   → 之前把上限设成 4，等于**自己把 100% 砍到 95%**。
      //   现在放到 8（全试），由下面的"首帧总预算"控制总耗时，而不是靠砍候选数。
      const MAX_TRIES = 8;
      const list = (candidates || []).filter(Boolean).slice(0, MAX_TRIES);
      if (!list.length) return false;
      // 等首帧的**总预算**：单个候选最多 FIRST_FRAME_MS，但所有候选加起来不超过这个数。
      // 取值依据同上：平均要试 2~3 次才成功，所以给到 20s；最坏情况也不会无限等下去。
      // 预算耗尽就停（`frameBudgetMs <= 0` 时 break），不再让用户干等。
      const FIRST_FRAME_MS = 6000;
      let frameBudgetMs = 20000;
      let lastError = '';
      for (let i = 0; i < list.length; i++) {
        if (i > 0) {
          // ★ 重试前必须先把上一次**中止掉**。
          // 真机实测：上一个入口 open 失败后直接 open 下一个，模块会返回 ok:true
          // 但 videoW/videoH 为空（屏上显示 `play ok ?x?`）→ 黑屏。
          // 先 stop 一次把状态清掉，再 open 下一个。
          this.dbg = '第 ' + (i + 1) + '/' + list.length + ' 个入口重试中（上一个：' + lastError + '）';
          try { await bridge.stop(); } catch (error) { /* 忽略 */ }
          await new Promise((resolve) => setTimeout(resolve, 350));
        }
        const waitMs = Math.max(800, Math.min(FIRST_FRAME_MS, frameBudgetMs));
        this._frameWaitUsed = 0;                 // start() 把实际等了多久写回这里
        const ok = await this.start(list[i], resumeMs, waitMs);
        frameBudgetMs -= (this._frameWaitUsed || waitMs);
        if (ok) {
          if (i > 0) this.toast('已换第 ' + (i + 1) + ' 个入口播放成功', 2200);
          return true;
        }
        lastError = (this.lastPlayError || '失败');
        if (frameBudgetMs <= 0) break;            // 预算用完了，别再让用户干等
      }
      return false;
    },
    async start(path, resumeMs, waitMs) {
      this.path = path;
      const r = await bridge.play({
        path: path,
        screenW: this.screenW,
        screenH: this.screenH,
        rectX: FULL.rectX,
        rectY: FULL.rectY,
        rectW: FULL.rectW,
        rectH: FULL.rectH,
        maxW: this.screenW,
        maxH: this.screenH,
        rate: this.rate,
        volume: this.volume
      });
      if (!r || !r.ok) {
        this.lastPlayError = (r && r.error) || '未知错误';
        this.playing = false;
        this.errorText = '无法播放\n' + this.lastPlayError;
        this.dbg = 'play FAIL: ' + this.lastPlayError + ' | ' + this.dbgBase;
        try { markHostBad(path, this.lastPlayError); } catch (error) { /* 忽略 */ }
        // 注意：这里**不弹 toast** —— 由 startWithFallback 决定还有没有下一个入口，
        // 全部试完才提示（否则重试过程中会闪一堆失败提示）。
        return false;
      }
      // ★★ 模块报 ok 但尺寸还没填 —— **不能立刻判死**。
      //
      // 为什么（这是黑屏的一个很可能的原因）：
      //   `play()` 返回 ok 只代表"输入打开了"，几何要等**解出第一帧**才填。
      //   而 feed 视频的码率可以到 2864 kbps（真机可播的那个探针视频只有 1291），
      //   高码率的初次解码 + 缓冲完全可能要 1~3 秒。
      //   早前这里只等 **600ms 就判"无视频流"并关掉换下一个候选** ——
      //   等于**在视频刚要出画面的瞬间把它掐掉**，于是用户看到的一直是黑屏。
      //
      // 现在改成**渐进等待**：轮询 status()，最多等 waitMs，期间一旦拿到尺寸就继续播。
      // 只有全程都拿不到尺寸，才认为这个入口真的不行、交给下一个候选。
      const TOTAL_MS = Math.max(800, Number(waitMs) || 6000);
      const STEP_MS = 400;
      let w = Number(r.videoW) || 0;
      let h = Number(r.videoH) || 0;
      let waited = 0;
      while ((!w || !h) && waited < TOTAL_MS) {
        await new Promise((resolve) => setTimeout(resolve, STEP_MS));
        waited += STEP_MS;
        try {
          const st = await bridge.status();
          const sw = Number(st && st.videoW) || 0;
          const sh = Number(st && st.videoH) || 0;
          if (sw && sh) { w = sw; h = sh; }
          // 模块自己说没在播且也没尺寸 → 不用再等
          if (!sw && !sh && st && st.playing === false && st.eos === true) break;
        } catch (error) { /* 探测失败继续等 */ }
        // 屏上诊断能看到等待进度，便于判断"是不是等得不够久"
        this.dbg = '等首帧 ' + waited + 'ms' + (w ? (' → ' + w + 'x' + h) : '') + ' | ' + this.dbgBase;
      }
      if (!w || !h) {
        this._frameWaitUsed = waited;
        this.lastPlayError = '等 ' + TOTAL_MS + 'ms 仍未出首帧（模块已打开但无视频流）';
        this.playing = false;
        this.dbg = 'play SOFT-FAIL: ' + this.lastPlayError + ' | ' + this.dbgBase;
        // 记住这台落点主机不好使，下次同类候选沉底（坏主机是主机级问题）
        try { markHostBad(path, this.lastPlayError); } catch (error) { /* 忽略 */ }
        return false;
      }
      this.lastPlayError = '';
      this._frameWaitUsed = waited;
      // 注意：屏上诊断要用**轮询到的** w/h，而不是 play() 当场返回的 r.videoW/H
      // （后者常常是 0 —— 几何还没填，这正是过去被误判成"无视频流"的原因）。
      this.dbgBase = this.screenInfo + ' | play ok ' + w + 'x' + h + ' (首帧 ' + waited + 'ms)'
        + ' rate=' + this.rate + ' vol=' + this.volume;
      this.dbg = this.dbgBase;
      this.errorText = '';
      this.playing = true;
      if (r.durationMs > 0) this.durationMs = r.durationMs;
      // 分辨率超出屏幕时原生已按 maxW/maxH 降到屏内，这里只做提示
      if (w > bridge.SCREEN_W || h > bridge.SCREEN_H) {
        this.qualityLabel = '已降到流畅画质';
        this.toast('原片 ' + w + '×' + h + '，已降到流畅画质', 2600);
      } else {
        this.qualityLabel = '';
      }
      if (resumeMs > 3000) {
        await bridge.seek(resumeMs);
        this.positionMs = resumeMs;
        this.syncProgress();
      }
      return true;
    },
    togglePlay() {
      if (this.fallbackMode) {
        this.playing = !this.playing;
        return;
      }
      if (this.ended) {
        this.ended = false;
        bridge.seek(0);
        bridge.resume();
        this.playing = true;
        return;
      }
      if (this.playing) {
        bridge.pause();
        this.playing = false;
      } else {
        bridge.resume();
        this.playing = true;
      }
    },
    seekBy(sec) {
      const target = Math.max(0, this.positionMs + sec * 1000);
      bridge.seek(target);
      this.positionMs = target;
      this.syncProgress();
    },
    onSeekChange(val) {
      const v = Number(val) || 0;
      if (this.durationMs > 0) {
        const target = Math.round(v / this.seekMax * this.durationMs);
        bridge.seek(target);
        this.positionMs = target;
        this.seekVal = v;
      }
    },
    async cycleRate() {
      let i = RATES.indexOf(Number(this.rate) || 1);
      if (i === -1) i = 0;
      this.rate = RATES[(i + 1) % RATES.length];
      await bridge.setRate(this.rate);
      this.toast(this.rateLabel, 1200);
    },
    async onVolumeChange(val) {
      this.volume = Number(val) || 0;
      await bridge.setVolume(this.volume);
    },
    syncProgress() {
      if (this.durationMs <= 0) return;
      this.seekVal = Math.min(this.seekMax, Math.round(this.positionMs / this.durationMs * this.seekMax));
    },
    // 500ms 轮询进度与状态
    async tick() {
      if (!this.path || this.fallbackMode) return;
      const pos = await bridge.position();
      const st = await bridge.status();
      // ★关键：控制栏隐藏时**绝不更新任何响应式数据**。
      // 原生播放器把视频帧直接写在 framebuffer 上，而 Falcon UI 与它共用同一块 fb：
      // 只要页面重绘一次，就会把视频帧盖掉（表现为“明明在播却整屏黑”）。
      // 所以隐藏状态下只把读数记在非响应式字段里，等唤出控制栏（视频已被 setView 收缩到上方）
      // 再一次性同步到界面。
      this._posMs = pos;
      this._status = st;
      if (!this.controlsVisible) return;
      this.positionMs = pos;
      this.dbg = 'tick pos=' + Math.round(pos) + ' dur=' + Math.round((st && st.durationMs) || 0)
        + ' ok=' + ((st && st.ok) ? 1 : 0) + ' playing=' + ((st && st.playing) ? 1 : 0)
        + ' eos=' + ((st && st.eos) ? 1 : 0) + ' | ' + this.dbgBase;
      if (st && st.durationMs > 0) this.durationMs = st.durationMs;
      if (st && st.ok) {
        this.playing = st.playing;
        if (st.eos && !this.ended) {
          this.ended = true;
          this.playing = false;
          this.controlsVisible = true;
          bridge.setView(WITHBAR);
        }
      }
      if (this.controlsVisible) this.syncProgress();
      this._tickCount = (this._tickCount || 0) + 1;
      if (this._tickCount % 6 === 0) this.saveProgress();
    },
    async saveProgress() {
      if (!this.path) return;
      try {
        const raw = await jsapiStorageGet(HISTORY_KEY);
        const map = (typeof raw === 'string' ? JSON.parse(raw) : raw) || {};
        map[this.path] = { positionMs: this.positionMs, durationMs: this.durationMs, at: Date.now() };
        // ★ 必须有上限：这个 map 的键是**播放地址**，每换一个视频就多一条，
        //   而抖音的播放地址里带一次性签名 —— 等于**永不命中、无限增长**，
        //   迟早把笔上的 storage 撑爆（外部评价也点了这一条）。
        //   按 at 留最近的 N 条。
        const keys = Object.keys(map);
        if (keys.length > HISTORY_MAX) {
          keys.sort((a, b) => ((map[a] && map[a].at) || 0) - ((map[b] && map[b].at) || 0));
          keys.slice(0, keys.length - HISTORY_MAX).forEach((k) => { delete map[k]; });
        }
        await jsapiStorageSet(HISTORY_KEY, map);
      } catch (error) { /* 存储不可用则跳过 */ }
    },
    async restoreProgress() {
      try {
        const raw = await jsapiStorageGet(HISTORY_KEY);
        const map = (typeof raw === 'string' ? JSON.parse(raw) : raw) || {};
        const hit = map[this.path];
        return hit ? Number(hit.positionMs || 0) : 0;
      } catch (error) {
        return 0;
      }
    }
  },
  async mounted() {
    // 导航参数：优先 $page.options（参考项目真机验证写法），兜底用导航前暂存的请求
    const options = (this.$page && this.$page.options) || {};
    const pending = takePendingPlay();
    this.path = String(options.path || (pending && pending.path) || '');
    this.name = String(options.name || (pending && pending.name) || '');
    // 条目自带的播放候选（分享页解析出的直链等），与轮换候选一起排队尝试
    const cand = options.candidates || (pending && pending.candidates);
    this.candidates = Array.isArray(cand) ? cand.map(String).filter(Boolean) : [];
    this.rate = Number(options.rate || 1) || 1;
    // 真机分辨率探测（与参考项目一致）：原生模块按它算 blit 几何，写死尺寸可能整屏错位
    let screen = { w: bridge.SCREEN_W, h: bridge.SCREEN_H, raw: '默认', direction: 0 };
    try { screen = await detectScreen(); } catch (error) { /* 用默认 */ }
    this.screenW = screen.w;
    this.screenH = screen.h;
    // 黑屏排查：把"参数从哪来、path 长什么样"直接显示出来
    this.screenInfo = 'screen=' + this.screenW + 'x' + this.screenH
      + '(cfg ' + screen.raw + ' dir' + screen.direction + ')';
    this.dbgBase = this.screenInfo + ' pending=' + (pending && pending.path ? '有' : '无')
      + ' options=' + (options.path ? '有' : '无')
      + ' path=' + (this.path ? (String(this.path).replace(/^https?:\/\//, '').slice(0, 26) + '…len' + this.path.length) : '空');
    this.dbg = this.dbgBase;

    const ok = await bridge.available();
    this.fallbackMode = !ok;
    if (!this.path) {
      this.errorText = '没有拿到播放地址';
      return;
    }

    // ① 候选入口（跳板入口会展开成多形态）+ 主机健康度排序。
    //    ⛔ 设备端**不做媒体探测** —— 用 JS 的 http 通道读视频字节会把二进制灌进
    //    原生字符串通道，实测**导致词典笔软重启**（见 native-player.js 顶部的警告）。
    //    坏主机的发现靠原生播放器自己的失败结果（start 里 markHostBad）；
    //    "哪些入口根本连不上"用诊断页的「中转探测」看（不阻塞播放）。
    let list = orderByHostHealth(playUrlCandidates(this.path, this.candidates));
    const badHosts = badHostList();
    if (badHosts.length) this.dbg = '已知坏主机 ' + badHosts.length + ' 个 | ' + this.dbgBase;

    if (this.fallbackMode) {
      // 浏览器预览 / 模拟器无原生视频模块：没有内置播放器可顶，直接如实提示。
      this.playing = true;
      this.showHint = false;
      return;
    }
    const resumeMs = await this.restoreProgress();
    try {
      const okPlay = await this.startWithFallback(list.length ? list : [this.path], resumeMs);
      if (!okPlay) {
        this.errorText = '无法播放\n' + (this.lastPlayError || '未知错误');
        this.dbg = 'play FAIL(全部 ' + (list.length || 1) + ' 个入口): '
          + (this.lastPlayError || '?') + ' | ' + this.dbgBase;
        this.toast('所有播放入口都失败：' + (this.lastPlayError || '未知错误'), 3600);
      }
    } catch (error) {
      this.errorText = '播放启动异常\n' + error;
    }
    this._pollTimer = setInterval(() => { this.tick().catch(() => {}); }, 500);
    this._hintTimer = setTimeout(() => { this.showHint = false; }, 4000);
  },
  beforeDestroy() {
    clearInterval(this._pollTimer);
    clearTimeout(this._hintTimer);
    clearTimeout(this._toastTimer);
    if (!this.fallbackMode) {
      this.saveProgress();
      bridge.stop();
    }
  }
};
</script>

<style scoped>
/* 逻辑横屏 800×254 */
.screen {
  position: relative;
  width: 100%;
  height: 100%;
  background-color: #000000;
  overflow: hidden;
}
.videoarea {
  position: absolute;
  left: 0;
  top: 0;
  width: 100%;
  height: 100%;
}
.fallback {
  position: absolute;
  left: 0;
  top: 0;
  width: 100%;
  height: 100%;
  background-color: #000000;
}
.centerbox {
  position: absolute;
  left: 20px;
  top: 70px;
  width: 460px;
}
.errtext {
  color: #ff6b72;
  font-size: 13px;
  line-height: 20px;
}
.hintbox {
  position: absolute;
  left: 300px;
  top: 200px;
  width: 200px;
}
.hinttext {
  color: rgba(255, 255, 255, 0.75);
  font-size: 12px;
  text-align: center;
}
/* 黑屏排查用的屏上诊断行（横屏顶部，够显眼但不高） */
.dbgtext {
  position: absolute;
  left: 6px;
  top: 2px;
  width: 788px;
  height: 16px;
  color: #7CFC00;
  font-size: 11px;
}
/* 控制栏：高 64px，视频区收缩到其上方（190px） */
.controls {
  position: absolute;
  left: 0;
  top: 190px;
  width: 100%;
  height: 64px;
  background-color: #121922;
}
.row1 {
  display: flex;
  flex-direction: row;
  align-items: center;
  padding: 0 10px;
  height: 30px;
}
.row2 {
  display: flex;
  flex-direction: row;
  align-items: center;
  padding: 0 10px;
  height: 34px;
}
.time {
  width: 46px;
  color: #8ca0ad;
  font-size: 11px;
  text-align: center;
}
/* Weex 只支持单类名选择器，复合选择器（.time.right）会被丢弃 */
.time-right {
  text-align: right;
}
.seekbar {
  flex: 1;
  height: 24px;
}
.btn {
  min-width: 54px;
  height: 26px;
  background-color: #19242f;
  border-radius: 4px;
  margin-right: 6px;
  display: flex;
  flex-direction: row;
  align-items: center;
  justify-content: center;
}
.btn-accent {
  background-color: #123a37;
}
.btn-back {
  margin-left: auto;
  margin-right: 0;
}
.btntext {
  color: #e8eef2;
  font-size: 11px;
}
.accent-t {
  color: #4fd6c3;
}
.qtag {
  color: #8ca0ad;
  font-size: 10px;
  margin-right: 6px;
}
.volbox {
  display: flex;
  flex-direction: row;
  align-items: center;
  margin-right: 8px;
}
.volicon {
  color: #f5b85c;
  font-size: 11px;
  width: 14px;
}
.volbar {
  width: 90px;
  height: 24px;
}
.voltext {
  color: #8ca0ad;
  font-size: 10px;
  width: 26px;
  text-align: right;
}
.toast {
  position: absolute;
  left: 250px;
  top: 100px;
  width: 300px;
  padding: 6px 10px;
  border-radius: 6px;
  background-color: rgba(31, 44, 56, 0.94);
}
.toasttext {
  color: #e8eef2;
  font-size: 11px;
  text-align: center;
}
</style>
