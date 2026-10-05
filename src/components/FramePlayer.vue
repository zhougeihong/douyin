<template>
  <div class="player" @click.stop="togglePlayback">
    <image-frame
      ref="frame"
      class="frame"
      :src="frames"
      :interval="interval"
      :loop-count="-1"
      :auto-play="playing">
    </image-frame>

    <div class="player-mask" :style="{ opacity: playing ? 0.8 : 1 }"></div>

    <div class="player-badge" :style="{ opacity: playing ? 0.45 : 1 }">
      <text class="player-badge-text">{{ playing ? '播放中' : '已暂停' }}</text>
    </div>

    <div class="player-center" v-if="!playing">
      <div class="player-center-inner">
        <text class="player-center-icon">播放</text>
      </div>
    </div>

    <div class="player-progress">
      <div class="player-progress-bar" :style="{ width: progress + '%' }"></div>
    </div>
  </div>
</template>

<script>
export default {
  name: 'FramePlayer',
  props: {
    frames: { type: Array, required: true },
    interval: { type: Number, default: 100 },
    playing: { type: Boolean, default: false }
  },
  data() {
    return {
      elapsed: 0,
      ticker: null
    };
  },
  computed: {
    totalDuration() {
      return Math.max(this.frames.length * this.interval, this.interval || 1);
    },
    progress() {
      if (!this.frames.length) return 0;
      return Math.min(100, (this.elapsed / this.totalDuration) * 100);
    }
  },
  watch: {
    playing(v) {
      const f = this.$refs.frame;
      if (!f) return;
      try { v ? f.start() : f.pause(); } catch (err) {}

      this.syncTicker(v);
    },
    frames() {
      this.elapsed = 0;
      if (this.playing) this.syncTicker(true);
    }
  },
  mounted() {
    const f = this.$refs.frame;
    if (f && this.playing) {
      try { f.start(); } catch (err) {}
    }
    this.syncTicker(this.playing);
  },
  beforeDestroy() {
    this.syncTicker(false);
  },
  methods: {
    syncTicker(active) {
      if (this.ticker) {
        clearInterval(this.ticker);
        this.ticker = null;
      }

      if (!active || !this.frames.length) return;

      this.ticker = setInterval(() => {
        if (!this.playing || !this.frames.length) {
          this.syncTicker(false);
          return;
        }

        this.elapsed += 80;
        if (this.elapsed >= this.totalDuration) {
          this.elapsed = 0;
        }
      }, 80);
    },
    togglePlayback() {
      if (!this.frames.length) return;
      this.$emit('toggle-play', !this.playing);
    }
  }
};
</script>

<style scoped>
.player {
  position: relative;
  width: 100%;
  height: 100%;
  overflow: hidden;
  background-color: #000000;
}

.frame {
  width: 100%;
  height: 100%;
}

.player-mask {
  position: absolute;
  left: 0;
  right: 0;
  top: 0;
  bottom: 0;
  background-color: rgba(0, 0, 0, 0.12);
}

.player-badge {
  position: absolute;
  left: 10px;
  top: 12px;
  z-index: 2;
  padding: 4px 8px;
  border-radius: 999px;
  background-color: rgba(20, 20, 20, 0.42);
  border-width: 1px;
  border-style: solid;
  border-color: rgba(255, 255, 255, 0.3);
}

.player-badge-text {
  color: #ffffff;
  font-size: 9px;
  font-weight: bold;
}

.player-center {
  position: absolute;
  left: 50%;
  top: 46%;
  z-index: 3;
  transform: translate(-50%, -50%);
}

.player-center-inner {
  width: 52px;
  height: 52px;
  border-radius: 50%;
  background-color: rgba(0, 0, 0, 0.26);
  border-width: 1px;
  border-style: solid;
  border-color: rgba(255, 255, 255, 0.35);
  align-items: center;
  justify-content: center;
}

.player-center-icon {
  color: #ffffff;
  font-size: 18px;
  margin-left: 2px;
}

.player-progress {
  position: absolute;
  left: 10px;
  right: 10px;
  bottom: 12px;
  z-index: 2;
  height: 3px;
  border-radius: 2px;
  background-color: rgba(255, 255, 255, 0.2);
  overflow: hidden;
}

.player-progress-bar {
  height: 100%;
  border-radius: 2px;
  background-color: #fe2c55;
}
</style>
