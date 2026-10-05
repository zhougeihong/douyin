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
      // 尝试上限：候选会有 7~8 个，但真机上一次次 stop/open 很重，太多轮会拖很久、
      // 也增加原生模块出错的风险 —— 取前 4 个足够覆盖"重抽落点"的机会。
      const MAX_TRIES = 4;
      const list = (candidates || []).filter(Boolean).slice(0, MAX_TRIES);
      if (!list.length) return false;
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
        const ok = await this.start(list[i], resumeMs);
        if (ok) {
          if (i > 0) this.toast('已换第 ' + (i + 1) + ' 个入口播放成功', 2200);
          return true;
        }
        lastError = (this.lastPlayError || '失败');
      }
      return false;
    },
    async start(path, resumeMs) {
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
      // 模块报 ok 但**探不出视频尺寸** = 这个地址其实播不了（真机实测屏上显示 `play ok ?x?` 且黑屏）。
      // 但原生模块有可能要过一小会儿才把几何填好，所以先等一拍再复查一次，
      // 仍然没有尺寸才当软失败交给下一个入口。
      let w = Number(r.videoW) || 0;
      let h = Number(r.videoH) || 0;
      if (!w || !h) {
        await new Promise((resolve) => setTimeout(resolve, 600));
        try {
          const st = await bridge.status();
          w = Number(st && st.videoW) || w;
          h = Number(st && st.videoH) || h;
        } catch (error) { /* 探测失败就按没有尺寸处理 */ }
      }
      if (!w || !h) {
        this.lastPlayError = '模块已打开但无视频流（可能不是可播地址）';
        this.playing = false;
        this.dbg = 'play SOFT-FAIL: ' + this.lastPlayError + ' | ' + this.dbgBase;
        // 记住这台落点主机不好使，下次同类候选沉底（坏主机是主机级问题）
        try { markHostBad(path, this.lastPlayError); } catch (error) { /* 忽略 */ }
        return false;
      }
      this.lastPlayError = '';
      this.dbgBase = this.screenInfo + ' | play ok ' + ((r && r.videoW) || '?') + 'x' + ((r && r.videoH) || '?')
        + ' rate=' + this.rate + ' vol=' + this.volume;
      this.dbg = this.dbgBase;
      this.errorText = '';
      this.playing = true;
      if (r.durationMs > 0) this.durationMs = r.durationMs;
      // 分辨率超出屏幕时原生已按 maxW/maxH 降到屏内，这里只做提示
      if (r.videoW > bridge.SCREEN_W || r.videoH > bridge.SCREEN_H) {
        this.qualityLabel = '已降到流畅画质';
        this.toast('原片 ' + r.videoW + '×' + r.videoH + '，已降到流畅画质', 2600);
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
    if (this.fallbackMode) {
      // 浏览器预览：没有原生模块，用 HTML5 播放器顶一下
      this.playing = true;
      this.showHint = false;
      return;
    }
    const resumeMs = await this.restoreProgress();
    try {
      // ① 候选入口（跳板入口会展开成多形态）。
      //    ⛔ 这里**不再**尝试"解析成明文 http 直链"：那会对**视频地址发 GET**，
      //    违反 native-player.js 顶部的禁令（会把二进制灌进原生字符串通道 → 软重启）；
      //    而且它依据的"模块没有 TLS"前提已被真机诊断推翻（HANDOFF §13.7）。
      //    真正有效的做法是按 CDN 主机健康度排序 + 逐个入口试（见下）。
      let list = playUrlCandidates(this.path, this.candidates);

      // ② 按「CDN 主机健康度」排序：失败过的落点主机沉底。
      //    ⛔ 这里**不做媒体探测** —— 用 JS 的 http 通道读视频字节会把二进制灌进
      //    原生字符串通道，实测**导致词典笔软重启**（见 native-player.js 顶部的警告）。
      //    坏主机的发现靠原生播放器自己的失败结果（见 start 里 markHostBad）。
      list = orderByHostHealth(list);
      const badHosts = badHostList();
      if (badHosts.length) this.dbg = '已知坏主机 ' + badHosts.length + ' 个 | ' + this.dbgBase;

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
