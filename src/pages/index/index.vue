<template>
  <div class="screen">
    <!-- ============ 顶栏：一眼看清各边登录态 ============ -->
    <div class="bar">
      <text class="bar-title">字节全家桶</text>
      <text class="bar-sub">词典笔 · v1.0.2 · 横屏 800x254</text>
      <div class="bar-right">
        <text class="bar-stat">抖音 {{ douyinLogged ? '已登录' : '未登录' }}</text>
        <text class="bar-dot">·</text>
        <text class="bar-stat">头条 {{ toutiaoLogged ? '已登录' : '未登录' }}</text>
        <text class="bar-dot">·</text>
        <text class="bar-stat">番茄 {{ fanqieLogged ? '已登录' : '未登录' }}</text>
      </div>
    </div>

    <!-- ============ 两个入口卡片 ============ -->
    <div class="tiles">
      <!-- ① 笔上抖音：本程序已开发好的全部抖音功能 -->
      <div class="tile" @click="openDouyin">
        <div class="tile-head">
          <div class="icon icon-dy">
            <text class="icon-note">d</text>
          </div>
          <text class="tile-title">笔上抖音</text>
        </div>
        <text class="tile-desc">视频 · 搜索 · 发布 · 消息 · 我的</text>
        <text class="tile-meta">原生播放 · 扫码/手机号/Cookie 登录</text>
        <div class="tile-foot">
          <text class="tile-stat">{{ douyinLogged ? '抖音已登录' : '抖音未登录' }}</text>
          <div class="tile-go">
            <text class="tile-go-txt">进入</text>
          </div>
        </div>
      </div>

      <!-- ② 今日头条：观看 / 点赞 / 登录 / 我的 / 历史记录 -->
      <div class="tile" @click="openToutiao">
        <div class="tile-head">
          <div class="icon icon-tt">
            <text class="icon-note">T</text>
          </div>
          <text class="tile-title">今日头条</text>
        </div>
        <text class="tile-desc">观看 · 点赞 · 我的 · 历史记录</text>
        <text class="tile-meta">头条二维码登录</text>
        <div class="tile-foot">
          <text class="tile-stat">{{ toutiaoLogged ? '头条已登录' : '头条未登录' }}</text>
          <div class="tile-go tile-go-tt">
            <text class="tile-go-txt">进入</text>
          </div>
        </div>
      </div>

      <!-- ③ 番茄小说：书架 / 章节 / 阅读（正文有字体反爬，见 HANDOFF §14） -->
      <div class="tile" @click="openFanqie">
        <div class="tile-head">
          <div class="icon icon-fq">
            <text class="icon-note">番</text>
          </div>
          <text class="tile-title">番茄小说</text>
        </div>
        <text class="tile-desc">书架 · 章节 · 阅读</text>
        <text class="tile-meta">番茄二维码登录</text>
        <div class="tile-foot">
          <text class="tile-stat">{{ fanqieLogged ? '番茄已登录' : '番茄未登录' }}</text>
          <div class="tile-go tile-go-fq">
            <text class="tile-go-txt">进入</text>
          </div>
        </div>
      </div>
    </div>

    <!-- ============ 右侧工具区 ============ -->
    <div class="side">
      <div class="side-row" @click="openHistory">
        <text class="side-row-txt">观看历史</text>
      </div>
      <text class="side-info">版本 {{ version }}</text>
      <text class="side-err" v-if="errText">{{ errText }}</text>
    </div>
  </div>
</template>

<script>
import { readSession } from '../../utils/auth.js';
import { jsapiStorageGet } from '../../services/libjsapi.js';

const VERSION = '1.0.2';

export default {
  name: 'Home',
  data() {
    return {
      douyinLogged: false,
      toutiaoLogged: false,
      fanqieLogged: false,
      version: VERSION,
      errText: ''
    };
  },
  methods: {
    // 统一跳转：navTo 不存在时给可读提示，而不是静默失败
    go(page, params) {
      this.errText = '';
      const falcon = typeof $falcon !== 'undefined' && $falcon ? $falcon : null;
      if (falcon && typeof falcon.navTo === 'function') {
        try {
          falcon.navTo(page, params || {});
          return true;
        } catch (error) {
          this.errText = '打开「' + page + '」失败：' + ((error && error.message) || '');
          return false;
        }
      }
      this.errText = '当前环境不支持页面跳转（模拟器预览可忽略）';
      return false;
    },

    openDouyin() {
      this.go('douyin', { from: 'home' });
    },

    // 今日头条：观看 / 点赞 / 我的 / 历史记录，登录走字节统一账号 SSO
    openToutiao() {
      this.go('toutiao', { from: 'home' });
    },

    // 番茄小说：书架 / 章节 / 阅读
    openFanqie() {
      this.go('fanqie', { from: 'home' });
    },

    // 首页的「观看历史」进抖音页后由它自己打开历史抽屉
    openHistory() {
      this.go('douyin', { from: 'home', open: 'history' });
    },

    // 读各边的登录态，让首页一眼能看出现在什么状态
    async refreshState() {
      try {
        const session = await readSession();
        this.douyinLogged = !!(session && (session.id || session.nick));
      } catch (error) {
        this.douyinLogged = false;
      }
      // 头条 / 番茄登录态各用独立 storage key
      try {
        const tt = await jsapiStorageGet('toutiao_session');
        this.toutiaoLogged = !!(tt && (tt.uid || tt.uname));
      } catch (error) {
        this.toutiaoLogged = false;
      }
      try {
        const fq = await jsapiStorageGet('fanqie_session');
        this.fanqieLogged = !!(fq && (fq.uid || fq.uname));
      } catch (error) {
        this.fanqieLogged = false;
      }
    }
  },
  onLoad() {
    this.refreshState();
  },
  onShow() {
    // 从子页面返回时刷新一次：登录状态可能已经变了
    this.refreshState();
  }
};
</script>

<style lang="less" scoped>
/* 逻辑横屏 800×254。Weex 只支持单类名选择器，动态样式走 :class 绑定。 */
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
  left: 0;
  top: 0;
  width: 800px;
  height: 30px;
  flex-direction: row;
  align-items: center;
  padding-left: 14px;
  padding-right: 14px;
  background-color: #15151b;
}
.bar-title {
  color: #ffffff;
  font-size: 15px;
  font-weight: bold;
}
.bar-sub {
  color: #6f757c;
  font-size: 9px;
  margin-left: 6px;
}
.bar-right {
  flex: 1;
  flex-direction: row;
  align-items: center;
  justify-content: flex-end;
}
.bar-stat {
  color: #b9bec4;
  font-size: 9px;
}
.bar-dot {
  color: #4a4f55;
  font-size: 9px;
  margin-left: 3px;
  margin-right: 3px;
}

/* ---------- 入口卡片 ---------- */
.tiles {
  position: absolute;
  left: 14px;
  top: 40px;
  width: 566px;
  flex-direction: row;
}
/* 卡片纵向排布：图标+标题一行、说明一行、底部状态+按钮一行。
   横排时说明文字会被图标和按钮挤到换行，254px 高度下很难看。
   三个入口（抖音/头条/番茄）横排，每张 172px：172*3 + 8*2 = 532，留出余量。 */
.tile {
  width: 172px;
  height: 176px;
  margin-right: 8px;
  border-radius: 12px;
  background-color: #1c1c22;
  border-width: 1px;
  border-style: solid;
  border-color: #2c2c34;
  flex-direction: column;
  padding-left: 10px;
  padding-right: 10px;
  padding-top: 10px;
  padding-bottom: 8px;
}
.tile-head {
  flex-direction: row;
  align-items: center;
}
.icon {
  width: 34px;
  height: 34px;
  border-radius: 9px;
  justify-content: center;
  align-items: center;
}
.icon-dy {
  background-color: #17171c;
  border-width: 2px;
  border-style: solid;
  border-color: #25f4ee;
}
.icon-tt {
  background-color: #fe2c55;
}
.icon-fq {
  background-color: #ff7a45;
}
.icon-note {
  color: #ffffff;
  font-size: 17px;
  font-weight: bold;
}
.tile-title {
  color: #ffffff;
  font-size: 14px;
  font-weight: bold;
  margin-left: 7px;
}
.tile-desc {
  color: #9aa0a6;
  font-size: 9px;
  margin-top: 10px;
}
.tile-meta {
  color: #62686e;
  font-size: 8px;
  margin-top: 5px;
}
.tile-foot {
  flex: 1;
  flex-direction: row;
  align-items: center;
  justify-content: space-between;
}
.tile-stat {
  color: #7a8086;
  font-size: 8px;
}
.tile-go {
  height: 28px;
  padding-left: 14px;
  padding-right: 14px;
  border-radius: 14px;
  background-color: #fe2c55;
  justify-content: center;
  align-items: center;
}
.tile-go-tt {
  background-color: #e0231a;
}
.tile-go-fq {
  background-color: #ff7a45;
}
.tile-go-txt {
  color: #ffffff;
  font-size: 12px;
  font-weight: bold;
}

/* ---------- 右侧工具区 ---------- */
.side {
  position: absolute;
  left: 590px;
  top: 40px;
  width: 196px;
  flex-direction: column;
}
.side-row {
  height: 34px;
  margin-bottom: 8px;
  border-radius: 8px;
  background-color: #202027;
  justify-content: center;
  padding-left: 12px;
}
.side-row-txt {
  color: #cfd4d9;
  font-size: 12px;
}
.side-info {
  color: #565c62;
  font-size: 9px;
  margin-top: 4px;
}
.side-err {
  color: #ffaa2b;
  font-size: 10px;
  margin-top: 6px;
}
</style>
