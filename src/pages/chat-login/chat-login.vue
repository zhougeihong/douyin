<template>
  <div class="screen">
    <!-- ============ 顶栏 ============ -->
    <div class="bar">
      <text class="bar-title">多闪登录</text>
      <text class="bar-sub">抖音私信 · PC 网关</text>
      <div class="bar-right">
        <div class="dot" :class="[dotCls]"></div>
        <text class="bar-state">{{ gwStateText }}</text>
        <div class="btn-bar" @click="refreshGateway">
          <text class="btn-bar-txt">检测</text>
        </div>
        <div class="btn-bar btn-bar-ghost" @click="openEditor">
          <text class="btn-bar-ghost-txt">改地址</text>
        </div>
      </div>
    </div>

    <!-- ============ 二维码 ============ -->
    <div class="qrbox">
      <image class="qrimg" v-if="qrImg" :src="qrImg" mode="aspectFit"></image>
      <div class="qrph" v-else>
        <text class="qrph-txt">{{ qrPlaceholder }}</text>
      </div>
    </div>

    <!-- ============ 右侧信息与操作 ============ -->
    <div class="side">
      <text class="side-phase">{{ phaseText }}</text>
      <text class="side-hint">{{ hintText }}</text>
      <text class="side-gw">网关 {{ gatewayDisplay }}</text>
      <text class="side-err" v-if="errText">{{ errText }}</text>
      <div class="side-btns">
        <div class="btn-main" @click="startQr">
          <text class="btn-main-txt">{{ mainBtnText }}</text>
        </div>
        <div class="btn-sub" @click="goBack">
          <text class="btn-sub-txt">返回</text>
        </div>
      </div>
    </div>

    <!-- ============ 网关地址编辑器（应用内键盘，不用系统输入法）============ -->
    <div class="kbd" v-if="editing">
      <div class="kbd-left">
        <text class="kbd-title">电脑网关地址</text>
        <text class="kbd-val">{{ addrDraft || '请输入' }}</text>
        <text class="kbd-tip">只要 IP 或 IP:端口，不用写 http://</text>
        <text class="kbd-tip">电脑上已启动 gateway.py，填它显示的局域网 IP</text>
        <text class="kbd-err" v-if="addrErr">{{ addrErr }}</text>
      </div>
      <div class="kbd-right">
        <div class="krow" v-for="(row, ri) in keyRows" :key="ri">
          <div class="key" v-for="k in row" :key="k" @click="tapKey(k)">
            <text class="key-txt">{{ k }}</text>
          </div>
        </div>
        <div class="krow">
          <div class="key key-wide" @click="pasteDraft">
            <text class="key-txt">粘贴</text>
          </div>
          <div class="key" @click="backspaceDraft">
            <text class="key-txt">退格</text>
          </div>
          <div class="key key-ok" @click="saveAddrDraft">
            <text class="key-txt key-txt-ok">保存</text>
          </div>
          <div class="key" @click="cancelEditor">
            <text class="key-txt">取消</text>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script>
import {
  loadGatewayAddr,
  saveGatewayAddr,
  getGatewayAddr,
  normalizeGatewayAddr,
  chatPing,
  chatQrNew,
  chatQrStatus,
  qrImageSrc
} from '../../services/chat-api.js';
import { jsapiStorageGet } from '../../services/libjsapi.js';

// 与 PinyinIme 共用同一个应用内剪贴板 key，便于把电脑上查到的 IP 先存进剪贴板再粘过来
const CLIP_KEY = 'douyin_ime_clipboard';

// 地址编辑器只用到数字/点/冒号 —— 键盘比 PinyinIme 小得多，254px 高度也放得下
const KEY_ROWS = [
  ['1', '2', '3'],
  ['4', '5', '6'],
  ['7', '8', '9'],
  ['.', '0', ':']
];

// 二维码状态轮询间隔（网关现算二维码要 1~2s，2s 轮询足够且不浪费）
const POLL_MS = 2000;

export default {
  name: 'ChatLogin',
  data() {
    return {
      gateway: '',
      gwState: 'unset',        // unset / checking / ok / fail
      loggedIn: false,
      uname: '',
      phase: 'idle',           // idle / generating / waiting / confirmed / error
      loginStatus: '',         // new / scanned / confirmed / expired
      qrImg: '',
      qrErr: '',
      errorMsg: '',
      pollTimer: null,
      navTimer: null,
      // 地址编辑器
      editing: false,
      addrDraft: '',
      addrErr: '',
      keyRows: KEY_ROWS
    };
  },
  computed: {
    gatewayDisplay() {
      return this.gateway || '未设置';
    },
    dotCls() {
      if (this.gwState === 'ok') return 'dot-ok';
      if (this.gwState === 'fail') return 'dot-fail';
      if (this.gwState === 'checking') return 'dot-wait';
      return 'dot-none';
    },
    gwStateText() {
      if (this.gwState === 'ok') return this.loggedIn ? '已登录' : '已连接';
      if (this.gwState === 'checking') return '检测中';
      if (this.gwState === 'fail') return '连不上';
      return '未设置';
    },
    qrPlaceholder() {
      if (!this.gateway) return '先设置网关地址';
      if (this.phase === 'generating') return '生成二维码中';
      if (this.phase === 'error') return '二维码失败';
      if (this.phase === 'confirmed') return '已登录';
      return '等待二维码';
    },
    phaseText() {
      if (this.phase === 'confirmed' || this.loggedIn) return this.uname ? ('已登录：' + this.uname) : '已登录';
      if (this.phase === 'error') return '登录出错';
      if (this.phase === 'generating') return '正在生成二维码';
      if (this.phase === 'waiting') return '等待扫码';
      return '未开始';
    },
    hintText() {
      if (this.phase === 'confirmed' || this.loggedIn) return '登录态保存在电脑网关，笔上不用再登';
      if (this.phase === 'error') return this.qrErr || this.errorMsg || '点「重新获取」重试';
      if (this.phase === 'generating' || this.phase === 'waiting') {
        if (this.loginStatus === 'scanned') return '已扫码，请在手机上确认';
        if (this.loginStatus === 'expired') return '二维码已过期，正在自动换新';
        if (this.loginStatus === 'new') return '请用手机抖音 APP 扫描左侧二维码';
        return '请用手机抖音 APP 扫描左侧二维码';
      }
      if (!this.gateway) return '先点「改地址」填电脑的局域网 IP:端口';
      return '点「获取二维码」开始扫码登录';
    },
    errText() {
      return this.addrErr || this.errorMsg || this.qrErr || '';
    },
    mainBtnText() {
      if (this.phase === 'confirmed' || this.loggedIn) return '刷新状态';
      if (this.phase === 'error') return '重新获取';
      if (this.phase === 'generating' || this.phase === 'waiting') return '刷新二维码';
      return '获取二维码';
    }
  },
  methods: {
    // ---------- 网关地址 ----------
    async refreshGateway() {
      this.errorMsg = '';
      if (!this.gateway) {
        this.gateway = getGatewayAddr() || '';
      }
      if (!this.gateway) {
        this.gwState = 'unset';
        return;
      }
      this.gwState = 'checking';
      try {
        const res = await chatPing();
        this.gwState = 'ok';
        this.loggedIn = !!res.logged_in;
        this.uname = res.uname || '';
        if (this.loggedIn) {
          this.stopPolling();
          this.phase = 'confirmed';
          // 已登录就不需要二维码了，避免留下过期图片
          this.qrImg = '';
        }
      } catch (error) {
        this.gwState = 'fail';
        this.errorMsg = this.gateway + ' 连不上：' + ((error && error.message) || '');
      }
    },

    // ---------- 扫码 ----------
    async startQr() {
      // 地址没填先引导去填，别直接报错
      if (!this.gateway) {
        this.openEditor();
        return;
      }
      this.errorMsg = '';
      this.qrErr = '';
      // 已经登录过就只是刷新一下状态
      if (this.phase === 'confirmed' || this.loggedIn) {
        await this.refreshGateway();
        return;
      }
      this.phase = 'generating';
      try {
        const res = await chatQrNew();
        this.applyQr(res);
        this.startPolling();
      } catch (error) {
        this.phase = 'error';
        this.errorMsg = '请求网关失败：' + ((error && error.message) || '');
      }
    },

    applyQr(res) {
      if (!res || typeof res !== 'object') return;
      const img = qrImageSrc(res);
      if (img) this.qrImg = img;
      if (res.login_status) this.loginStatus = res.login_status;
      if (res.err) this.qrErr = res.err;
      if (res.uname) this.uname = res.uname;

      const st = res.status || '';
      if (st === 'confirmed') {
        this.phase = 'confirmed';
        this.loggedIn = true;
        this.stopPolling();
        this.qrImg = '';
        this.onLoginOk();
      } else if (st === 'waiting') {
        // 注意：qr_png_b64 为空是正常中间态，不能当失败
        this.phase = img || this.qrImg ? 'waiting' : 'generating';
      } else if (st === 'generating') {
        this.phase = 'generating';
      } else if (st === 'error') {
        this.phase = 'error';
        this.stopPolling();
      }
    },

    startPolling() {
      this.stopPolling();
      this.pollTimer = setInterval(() => {
        if (this.phase === 'confirmed' || this.phase === 'error') {
          this.stopPolling();
          return;
        }
        chatQrStatus().then((res) => {
          this.applyQr(res);
        }).catch(() => {
          // 网络抖动保持现状，下一轮再试
        });
      }, POLL_MS);
    },

    stopPolling() {
      if (this.pollTimer) {
        clearInterval(this.pollTimer);
        this.pollTimer = null;
      }
    },

    onLoginOk() {
      // 登录成功后停 1.2s 让用户看到「已登录」，再尝试进会话列表
      if (this.navTimer) clearTimeout(this.navTimer);
      this.navTimer = setTimeout(() => {
        this.enterChat();
      }, 1200);
    },

    // 会话列表页属于下一步（§12.6 第 4 步），没注册就留在本页显示成功态，
    // 不要弹一个用户看不懂的错误。
    enterChat() {
      const falcon = typeof $falcon !== 'undefined' && $falcon ? $falcon : null;
      if (falcon && typeof falcon.navTo === 'function') {
        try {
          falcon.navTo('chat-list', {});
          return;
        } catch (error) {
          this.errorMsg = '进入会话列表失败：' + ((error && error.message) || '');
        }
      }
      this.errorMsg = '已登录。会话列表页待做（HANDOFF §12.6 第 4 步）';
    },

    goBack() {
      const falcon = typeof $falcon !== 'undefined' && $falcon ? $falcon : null;
      if (falcon && typeof falcon.navBack === 'function') {
        try {
          falcon.navBack();
          return;
        } catch (error) {
          /* 落到下面的兜底 */
        }
      }
      if (falcon && typeof falcon.navTo === 'function') {
        try {
          falcon.navTo('home', {});
          return;
        } catch (error) {
          /* 落到下面的兜底 */
        }
      }
      this.errorMsg = '当前环境没有返回 API（模拟器预览可忽略）';
    },

    // ---------- 地址编辑器 ----------
    openEditor() {
      this.addrErr = '';
      // 编辑已有地址时把 http:// 去掉，用户看到的就是「IP:端口」
      this.addrDraft = (this.gateway || '').replace(/^https?:\/\//i, '');
      this.editing = true;
    },
    cancelEditor() {
      this.editing = false;
      this.addrErr = '';
    },
    tapKey(k) {
      this.addrDraft = String(this.addrDraft || '') + k;
      this.addrErr = '';
    },
    backspaceDraft() {
      const cur = String(this.addrDraft || '');
      this.addrDraft = cur.slice(0, Math.max(0, cur.length - 1));
      this.addrErr = '';
    },
    // 从应用内剪贴板取最近一条（PinyinIme 存的），省得用小键盘一位位敲 IP
    pasteDraft() {
      jsapiStorageGet(CLIP_KEY).then((list) => {
        const first = Array.isArray(list) && list.length ? String(list[0]) : '';
        if (!first) {
          this.addrErr = '剪贴板是空的（可在输入法里保存过地址）';
          return;
        }
        this.addrDraft = first.replace(/^https?:\/\//i, '');
        this.addrErr = '';
      }).catch(() => {
        this.addrErr = '读剪贴板失败';
      });
    },
    async saveAddrDraft() {
      const normalized = normalizeGatewayAddr(this.addrDraft);
      if (!normalized) {
        this.addrErr = '地址格式不对，例如 192.168.1.100';
        return;
      }
      const okSaved = await saveGatewayAddr(normalized);
      if (!okSaved) {
        this.addrErr = '保存到本机存储失败';
        return;
      }
      this.gateway = normalized;
      this.editing = false;
      this.addrErr = '';
      // 换了网关就重置登录态显示与二维码，避免拿旧状态骗自己
      this.loggedIn = false;
      this.uname = '';
      this.phase = 'idle';
      this.qrImg = '';
      this.loginStatus = '';
      this.qrErr = '';
      await this.refreshGateway();
    }
  },

  async onLoad() {
    this.gateway = await loadGatewayAddr();
    await this.refreshGateway();
  },
  onShow() {
    if (this.phase === 'generating' || this.phase === 'waiting') this.startPolling();
  },
  onHide() {
    this.stopPolling();
  },
  onDestroy() {
    this.stopPolling();
    if (this.navTimer) {
      clearTimeout(this.navTimer);
      this.navTimer = null;
    }
  }
};
</script>

<style lang="less" scoped>
/* 逻辑横屏 800×254：横向富余、纵向紧张，所以左右分栏而不是上下堆叠。
   Weex 只支持单类名选择器，动态样式一律走 :class 绑定。 */
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
  padding-left: 12px;
  padding-right: 12px;
  background-color: #15151b;
}
.bar-title {
  color: #ffffff;
  font-size: 15px;
  font-weight: bold;
}
.bar-sub {
  color: #7a8086;
  font-size: 10px;
  margin-left: 8px;
}
.bar-right {
  flex: 1;
  flex-direction: row;
  align-items: center;
  justify-content: flex-end;
}
.dot {
  width: 7px;
  height: 7px;
  border-radius: 4px;
  margin-right: 5px;
}
.dot-ok {
  background-color: #00d26a;
}
.dot-fail {
  background-color: #ff3b5c;
}
.dot-wait {
  background-color: #ffaa2b;
}
.dot-none {
  background-color: #5a5a64;
}
.bar-state {
  color: #b9bec4;
  font-size: 11px;
  margin-right: 10px;
}
.btn-bar {
  height: 20px;
  padding-left: 10px;
  padding-right: 10px;
  border-radius: 10px;
  background-color: #26262e;
  justify-content: center;
  align-items: center;
  margin-left: 6px;
}
.btn-bar-txt {
  color: #ffffff;
  font-size: 11px;
}
.btn-bar-ghost {
  background-color: transparent;
  border-width: 1px;
  border-style: solid;
  border-color: #3a3a44;
}
.btn-bar-ghost-txt {
  color: #b9bec4;
  font-size: 11px;
}

/* ---------- 二维码 ---------- */
.qrbox {
  position: absolute;
  left: 12px;
  top: 38px;
  width: 174px;
  height: 174px;
  background-color: #ffffff;
  border-radius: 8px;
  justify-content: center;
  align-items: center;
}
.qrimg {
  width: 166px;
  height: 166px;
}
.qrph {
  justify-content: center;
  align-items: center;
}
.qrph-txt {
  color: #8a8a93;
  font-size: 12px;
}

/* ---------- 右侧信息 ---------- */
.side {
  position: absolute;
  left: 200px;
  top: 38px;
  width: 588px;
  height: 174px;
  flex-direction: column;
}
.side-phase {
  color: #ffffff;
  font-size: 16px;
  font-weight: bold;
}
.side-hint {
  color: #b9bec4;
  font-size: 12px;
  margin-top: 6px;
}
.side-gw {
  color: #7a8086;
  font-size: 11px;
  margin-top: 4px;
}
.side-err {
  color: #ffaa2b;
  font-size: 11px;
  margin-top: 4px;
}
.side-btns {
  flex-direction: row;
  align-items: center;
  margin-top: 14px;
}
.btn-main {
  height: 34px;
  padding-left: 22px;
  padding-right: 22px;
  border-radius: 17px;
  background-color: #fe2c55;
  justify-content: center;
  align-items: center;
}
.btn-main-txt {
  color: #ffffff;
  font-size: 14px;
  font-weight: bold;
}
.btn-sub {
  height: 34px;
  padding-left: 20px;
  padding-right: 20px;
  border-radius: 17px;
  background-color: #26262e;
  justify-content: center;
  align-items: center;
  margin-left: 12px;
}
.btn-sub-txt {
  color: #b9bec4;
  font-size: 14px;
}

/* ---------- 地址编辑器（整屏覆盖）---------- */
.kbd {
  position: absolute;
  left: 0;
  top: 0;
  width: 800px;
  height: 254px;
  flex-direction: row;
  background-color: #0e0e12;
  padding-left: 14px;
  padding-top: 10px;
}
.kbd-left {
  width: 430px;
  flex-direction: column;
  padding-right: 10px;
}
.kbd-title {
  color: #ffffff;
  font-size: 14px;
  font-weight: bold;
}
.kbd-val {
  color: #25f4ee;
  font-size: 20px;
  margin-top: 10px;
}
.kbd-tip {
  color: #7a8086;
  font-size: 10px;
  margin-top: 6px;
}
.kbd-err {
  color: #ff6b81;
  font-size: 11px;
  margin-top: 8px;
}
.kbd-right {
  width: 340px;
  flex-direction: column;
}
.krow {
  flex-direction: row;
  margin-bottom: 4px;
}
.key {
  width: 78px;
  height: 38px;
  margin-right: 4px;
  border-radius: 6px;
  background-color: #26262e;
  justify-content: center;
  align-items: center;
}
.key-wide {
  width: 78px;
}
.key-ok {
  background-color: #00d26a;
}
.key-txt {
  color: #ffffff;
  font-size: 13px;
}
.key-txt-ok {
  font-size: 13px;
  font-weight: bold;
}
</style>
