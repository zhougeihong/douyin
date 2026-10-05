<template>
  <div class="vp">
    <!--
      同时挂两种运行时的用法：
      · HTML5（浏览器预览）：play()/pause()/currentTime + play/timeupdate/ended 事件
      · falcon/Weex 原生（词典笔）：play-status 属性 + auto-play/loop，事件 start/pause/finish/fail
      多余属性在另一种运行时里会被忽略，不会互相干扰。
    -->
    <video
      ref="video"
      class="vp-video"
      :style="frameStyle"
      :src="src"
      :play-status="nativePlay ? 'play' : 'pause'"
      :auto-play="autoplay && !paused"
      :muted="muted_"
      :loop="loop_"
      :controls="false"
      playsinline
      webkit-playsinline
      autoplay
      @click="onTap"
      @start="onNativeStart"
      @finish="onNativeFinish"
      @fail="onNativeFail"
      @play="onPlay"
      @playing="onPlaying"
      @pause="onPause"
      @waiting="onWaiting"
      @timeupdate="onTime"
      @loadedmetadata="onMeta"
      @progress="onProgress"
      @ended="onEnded"
      @error="onError"
    ></video>

    <div class="vp-loading" v-if="loading && !errText">
      <text class="vp-loading-text">加载中...</text>
    </div>

    <!-- 加载失败/无法播放提示 -->
    <div class="vp-tip" v-if="errText">
      <text class="vp-tip-text">{{ errText }}</text>
    </div>

    <!-- 中央播放按钮（用文字：词典笔屏幕不显示 emoji 字形） -->
    <div class="vp-center" v-if="!playing && !errText" @click="onTap">
      <text class="vp-play-ic">播放</text>
    </div>

    <div class="vp-ctrl" :class="{ 'vp-ctrl-visible': ctrlShow }" :style="{ bottom: ctrlBottom + 'px' }" @click.stop @touchstart.stop @touchmove.stop @touchend.stop>
      <div class="vp-transport">
        <!-- 进度跳转/时间显示依赖 HTML5 的 currentTime/duration，Weex 运行时没有 -->
        <div class="vp-btn vp-skip" v-if="html5" @click.stop="jump(-10)"><text class="vp-ic vp-skip-icon">-10</text></div>
        <div class="vp-btn vp-play-btn" @click.stop="togglePlay">
          <text class="vp-ic vp-play-icon">{{ playing ? '暂停' : '播放' }}</text>
        </div>
        <div class="vp-btn vp-skip" v-if="html5" @click.stop="jump(10)"><text class="vp-ic vp-skip-icon">+10</text></div>
        <text class="vp-time" v-if="html5">{{ fmt(current) }} / {{ fmt(duration) }}</text>
        <text class="vp-time" v-else>{{ playing ? '播放中' : '已暂停' }}</text>
      </div>
      <div class="vp-seek-row" v-if="html5">
        <div
          class="vp-bar"
          ref="bar"
          @click.stop="onSeek"
          @touchstart.stop="onSeekStart"
          @touchmove.stop="onSeekMove"
          @touchend.stop="onSeekEnd"
        >
          <div class="vp-buffer" :style="{ width: bufferPct + '%' }"></div>
          <div class="vp-progress" :style="{ width: pct + '%' }"></div>
          <div class="vp-thumb" :style="{ left: pct + '%' }"></div>
        </div>
      </div>
      <div class="vp-options">
        <div class="vp-btn" @click.stop="toggleMute">
          <text class="vp-option-text">{{ muted_ ? '静音' : '有声' }}</text>
        </div>
        <div class="vp-btn" v-if="html5" @click.stop="cyclePlaybackRate">
          <text class="vp-option-text">{{ rateLabel }}</text>
        </div>
        <div class="vp-btn" @click.stop="toggleLoop">
          <text class="vp-option-text" :class="{ 'vp-option-active': loop_ }">{{ loop_ ? '循环中' : '循环' }}</text>
        </div>
        <div class="vp-btn" v-if="canFullscreen" @click.stop="toggleFull">
          <text class="vp-option-text">{{ fullscreen ? '退出全屏' : '全屏' }}</text>
        </div>
      </div>
    </div>
  </div>
</template>

<script>
import { reportVideoCaps } from '../services/video-caps.js';

export default {
  name: 'VideoPlayer',
  props: {
    src: { type: String, required: true },
    autoplay: { type: Boolean, default: false },
    muted: { type: Boolean, default: false },
    // 外部暂停控制： true 暂停 / false 播放（保持实例，不重载）
    paused: { type: Boolean, default: false },
    loop: { type: Boolean, default: false },
    // 播放画面强制尺寸：设备竖屏 254x800（见 simulator resources/cfg.json）。
    // 必须显式给像素值，否则部分原生 video 组件会按视频自身宽高比排版，
    // 出现横屏/上下黑边，看起来“比例不对”。
    frameWidth: { type: Number, default: 254 },
    frameHeight: { type: Number, default: 800 },
    // 控制条离底部距离：页面底部有 44px 的导航栏，默认 0 会被它盖住
    ctrlBottom: { type: Number, default: 0 }
  },
  data() {
    return {
      html5: false,          // 运行时是否提供 HTML5 的视频方法与属性
      canFullscreen: false,  // 是否有可用的全屏 API
      fullscreen: false,
      nativePlay: true,      // Weex 模式下的 play-status（play / pause）
      muted_: this.muted,
      playing: false,
      loading: true,
      current: 0,
      duration: 0,
      bufferPct: 0,
      ctrlShow: true,
      ctrlTimer: null,
      startWatch: null,
      errText: '',
      lastTap: 0,
      isSeeking: false,
      loop_: this.loop,
      playbackRates: [1, 1.25, 1.5, 2, 0.5],
      playbackRateIndex: 0
    };
  },
  computed: {
    pct() {
      return this.duration ? (this.current / this.duration) * 100 : 0;
    },
    rateLabel() {
      return this.playbackRates[this.playbackRateIndex] + 'x';
    },
    // 竖屏 254x800：显式像素尺寸，避免原生组件按视频原比例排版
    frameStyle() {
      return {
        width: this.frameWidth + 'px',
        height: this.frameHeight + 'px'
      };
    }
  },
  watch: {
    src() {
      const v = this.$refs.video;
      this.current = 0;
      this.duration = 0;
      this.bufferPct = 0;
      this.errText = '';
      this.loading = true;
      this.playing = false;
      if (this.html5 && v && typeof v.load === 'function') v.load();
    },
    paused(v) {
      if (v) this.pause();
      else if (this.autoplay) this.play();
    }
  },
  mounted() {
    const v = this.$refs.video;
    // 能力探测：Weex 风格的 video 节点没有 play()，只能靠 play-status 驱动
    this.html5 = !!(v && typeof v.play === 'function' && typeof v.pause === 'function');
    this.canFullscreen = this.html5 && !!(v && typeof (v.requestFullscreen || v.webkitRequestFullscreen) === 'function');
    reportVideoCaps({ hasNode: !!v, html5: this.html5, canFullscreen: this.canFullscreen });

    this.showCtrl();
    if (this.autoplay && !this.paused) {
      this.play();
    } else {
      this.nativePlay = false;
      this.loading = false;
    }
  },
  beforeDestroy() {
    clearTimeout(this.ctrlTimer);
    clearTimeout(this.tapTimer);
    clearTimeout(this.startWatch);
  },
  methods: {
    play() {
      this.showCtrl();
      this.loading = true;
      const v = this.$refs.video;

      if (this.html5) {
        if (!v) return;
        try {
          const ret = v.play();
          if (ret && typeof ret.then === 'function') ret.then(() => { this.playing = true; }).catch(() => {});
        } catch (err) { /* 不支持则忽略 */ }
        return;
      }

      // Weex/falcon 原生：改 play-status 即开始播放，靠 start 事件确认真的播起来了
      this.nativePlay = true;
      clearTimeout(this.startWatch);
      this.startWatch = setTimeout(() => {
        if (this.playing) return;
        this.loading = false;
        this.errText = '视频没有开始播放（本机可能不支持该地址或格式）';
      }, 6000);
    },
    pause() {
      const v = this.$refs.video;
      if (this.html5 && v) {
        try { v.pause(); } catch (err) { /* 忽略 */ }
      }
      this.nativePlay = false;
      this.playing = false;
      this.loading = false;
      this.showCtrl();
    },
    togglePlay() {
      if (this.playing) this.pause();
      else this.play();
    },
    // ---- 两种运行时共用的事件 ----
    onNativeStart() {
      clearTimeout(this.startWatch);
      this.playing = true;
      this.loading = false;
      this.showCtrl();
    },
    onNativeFinish() {
      this.playing = false;
      this.loading = false;
      this.$emit('ended');
      this.showCtrl();
    },
    onNativeFail(e) {
      clearTimeout(this.startWatch);
      const detail = e && (e.detail || e.errMsg || e.message);
      this.errText = '视频组件播放失败' + (detail ? '：' + String(detail).slice(0, 40) : '');
      this.playing = false;
      this.loading = false;
    },
    onPlay() { this.playing = true; this.showCtrl(); },
    onPlaying() { this.loading = false; this.playing = true; clearTimeout(this.startWatch); },
    onPause() {
      clearTimeout(this.startWatch);
      this.playing = false;
      this.loading = false;
      this.showCtrl();
    },
    onWaiting() { this.loading = true; },
    onEnded() {
      this.playing = false;
      this.loading = false;
      this.$emit('ended');
      this.showCtrl();
    },
    onError() {
      this.errText = '视频加载失败';
      this.playing = false;
      this.loading = false;
    },
    // ---- HTML5 专有能力 ----
    jump(seconds) {
      const v = this.$refs.video;
      if (!v || !Number.isFinite(v.duration)) return;
      const target = Math.max(0, Math.min(v.duration, (v.currentTime || 0) + seconds));
      v.currentTime = target;
      this.current = target;
      this.showCtrl();
    },
    toggleLoop() {
      this.loop_ = !this.loop_;
      const v = this.$refs.video;
      if (v) v.loop = this.loop_;
      this.showCtrl();
    },
    cyclePlaybackRate() {
      this.playbackRateIndex = (this.playbackRateIndex + 1) % this.playbackRates.length;
      const v = this.$refs.video;
      if (v) v.playbackRate = this.playbackRates[this.playbackRateIndex];
      this.showCtrl();
    },
    // 之前只绑了事件却没有实现，点“静音/全屏”是空操作
    toggleMute() {
      this.muted_ = !this.muted_;
      const v = this.$refs.video;
      if (v && 'muted' in v) {
        try { v.muted = this.muted_; } catch (err) { /* 运行时忽略 muted 时无副作用 */ }
      }
      this.showCtrl();
    },
    toggleFull() {
      const v = this.$refs.video;
      if (!v) return;
      try {
        if (this.fullscreen) {
          const exit = document.exitFullscreen || document.webkitExitFullscreen;
          if (exit) exit.call(document);
          this.fullscreen = false;
        } else {
          const enter = v.requestFullscreen || v.webkitRequestFullscreen;
          if (enter) enter.call(v);
          this.fullscreen = true;
        }
      } catch (err) {
        this.canFullscreen = false;
      }
      this.showCtrl();
    },
    onTap() {
      const v = this.$refs.video;
      if (!v) return;
      // 静音状态下：单击开声（与抖音交互一致）
      if (this.muted_) {
        this.toggleMute();
        if (!this.playing) this.play();
        return;
      }
      // 有声状态下：双击点赞，单击播放/暂停
      const now = Date.now();
      if (now - this.lastTap < 300) {
        this.lastTap = 0;
        this.$emit('doubletap');
      } else {
        this.lastTap = now;
        this.tapTimer = setTimeout(() => {
          if (this.lastTap === now) this.togglePlay();
        }, 300);
      }
    },
    onTime() {
      const v = this.$refs.video;
      if (!v) return;
      if (!this.isSeeking) this.current = v.currentTime || 0;
      this.duration = v.duration || this.duration;
      this.loading = false;
    },
    onMeta() {
      const v = this.$refs.video;
      this.duration = (v && v.duration) || 0;
      this.loading = false;
    },
    onProgress() {
      const v = this.$refs.video;
      if (v && v.buffered && v.buffered.length && v.duration) {
        this.bufferPct = (v.buffered.end(v.buffered.length - 1) / v.duration) * 100;
      }
    },
    onSeek(e) {
      this.seekFromEvent(e, false);
      this.showCtrl();
    },
    onSeekStart(e) {
      this.isSeeking = true;
      this.seekFromEvent(e, true);
      this.showCtrl();
    },
    onSeekMove(e) {
      if (this.isSeeking) this.seekFromEvent(e, true);
    },
    onSeekEnd(e) {
      if (!this.isSeeking) return;
      this.seekFromEvent(e, false);
      const v = this.$refs.video;
      if (v && v.duration) v.currentTime = this.current;
      this.isSeeking = false;
      this.showCtrl();
    },
    seekFromEvent(e, preview) {
      const v = this.$refs.video;
      const bar = this.$refs.bar;
      if (!v || !bar || !v.duration) return;
      const touch = e && e.changedTouches && e.changedTouches[0]
        || e && e.touches && e.touches[0];
      const clientX = touch ? touch.clientX : e && e.clientX;
      if (typeof clientX !== 'number') return;
      let rect;
      try { rect = bar.getBoundingClientRect(); } catch (err) { return; }
      if (!rect || !rect.width) return;
      const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
      const target = ratio * v.duration;
      this.current = target;
      if (!preview) v.currentTime = target;
    },
    showCtrl() {
      this.ctrlShow = true;
      clearTimeout(this.ctrlTimer);
      this.ctrlTimer = setTimeout(() => { this.ctrlShow = false; }, 2600);
    },
    fmt(s) {
      s = Math.floor(s || 0);
      const m = Math.floor(s / 60);
      const ss = s % 60;
      return m + ':' + (ss < 10 ? '0' + ss : ss);
    }
  }
};
</script>

<style scoped>
.vp {
  position: relative;
  width: 100%;
  height: 100%;
  background-color: transparent;
  overflow: hidden;
}
.vp-video {
  position: absolute;
  left: 0;
  top: 0;
  width: 100%;
  height: 100%;
  background-color: #000000;
  /* HTML5 环境下让视频铺满竖屏框（原生 Weex 运行时忽略该属性，靠上面的显式尺寸） */
  object-fit: cover;
}
.vp-tip {
  position: absolute;
  left: 0;
  right: 0;
  top: 50%;
  margin-top: -10px;
  display: flex;
  flex-direction: row;
  justify-content: center;
  z-index: 6;
}
.vp-loading {
  position: absolute;
  left: 50%;
  top: 50%;
  transform: translate(-50%, -50%);
  z-index: 4;
}
.vp-loading-text {
  color: #ffffff;
  font-size: 12px;
  background-color: rgba(0, 0, 0, .52);
  padding: 7px 11px;
}
.vp-tip-text {
  color: #ffffff;
  font-size: 12px;
  background-color: rgba(0, 0, 0, 0.6);
  padding: 8px 14px;
  border-radius: 12px;
}
.vp-center {
  position: absolute;
  left: 0;
  right: 0;
  top: 45%;
  display: flex;
  flex-direction: row;
  justify-content: center;
  z-index: 5;
}
.vp-play-ic {
  width: 52px;
  height: 52px;
  line-height: 52px;
  font-size: 22px;
  color: #ffffff;
  text-align: center;
  background-color: rgba(0, 0, 0, 0.35);
  border-radius: 26px;
}
.vp-ctrl {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  padding: 8px 10px 6px;
  background-color: rgba(0, 0, 0, .68);
  opacity: 0;
  transition: opacity 0.25s;
  z-index: 7;
}
.vp-ctrl-visible { opacity: 1; }
.vp-transport,
.vp-options,
.vp-seek-row {
  display: flex;
  flex-direction: row;
  align-items: center;
}
.vp-transport { height: 24px; }
.vp-seek-row { height: 18px; }
.vp-options { justify-content: space-between; height: 24px; }
.vp-time {
  font-size: 10px;
  color: #ffffff;
  margin-left: 9px;
}
.vp-bar {
  flex: 1;
  height: 4px;
  margin: 0 3px;
  border-radius: 3px;
  background-color: rgba(255, 255, 255, 0.3);
  position: relative;
  overflow: hidden;
}
.vp-buffer {
  position: absolute;
  left: 0;
  top: 0;
  height: 100%;
  background-color: rgba(255, 255, 255, 0.45);
}
.vp-progress {
  position: absolute;
  left: 0;
  top: 0;
  height: 100%;
  background-color: #fe2c55;
}
.vp-thumb {
  position: absolute;
  top: 50%;
  width: 10px;
  height: 10px;
  margin-left: -5px;
  transform: translateY(-50%);
  border-radius: 50%;
  background-color: #ffffff;
}
.vp-btn {
  min-width: 28px;
  height: 24px;
  display: flex;
  flex-direction: row;
  align-items: center;
  justify-content: center;
  padding: 0 3px;
}
.vp-ic {
  font-size: 12px;
  color: #ffffff;
}
.vp-play-icon { font-size: 15px; }
.vp-skip-icon { font-size: 10px; }
.vp-option-text { font-size: 10px; color: #ffffff; }
.vp-option-active { color: #fe2c55; }
</style>
