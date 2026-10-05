<template>
  <!-- 内嵌软键盘：模式栏 + 状态条 + 候选栏 + 键区（九键/全拼/英文/数字/符号/剪贴板）
       数据源：万象拼音（amzxyz/rime_wanxiang, CC-BY-4.0），引擎见 services/ime-engine.js
       对外事件契约（页面 index.vue 已接线，保持不变）：
         commit(完整词/串) / insert(原样字符) / delete-char(退格) / done(收起键盘)
       布局：逻辑横屏 800x254，各模式总高 156~184px（见 <style> 中的高度注释）。
       CSS 只用单类名选择器（Weex 不支持 .a.b 复合选择器）。 -->
  <div class="kbd">

    <!-- 模式栏：六选一，当前模式高亮（沿用工程内 class + :class 数组写法，避免复合选择器） -->
    <div class="kbd-modes">
      <div class="kbd-mode" v-for="m in modes" :key="m.key" :class="[mode === m.key ? 'kbd-mode-on' : '']" @click="switchMode(m.key)">
        <text class="kbd-mode-txt" :class="[mode === m.key ? 'kbd-mode-txt-on' : '']">{{ m.label }}</text>
      </div>
    </div>

    <!-- 状态条：拼音音节 / 九键数字串 / 各模式提示 + 清空 -->
    <div class="kbd-bar">
      <text class="kbd-bar-txt" v-if="barText">{{ barText }}</text>
      <text class="kbd-bar-txt kbd-bar-dim" v-else>{{ barHint }}</text>
      <text class="kbd-clr" v-if="hasBuffer" @click="clearBuffer">清空</text>
    </div>

    <!-- 候选栏：拼音/九键共用；英文/数字/符号模式作为提示行占位 -->
    <div class="kbd-cands" v-if="mode !== 'clip'">
      <div class="kbd-cand kbd-cand-raw" v-if="mode === 'py' && buffer" @click="pickRaw">
        <text class="kbd-cand-txt kbd-cand-txt-raw">{{ buffer }}</text>
      </div>
      <div class="kbd-cand" v-for="(c, i) in shownCands" :key="i" @click="pickCandidate(c)">
        <text class="kbd-cand-txt">{{ c.text }}</text>
      </div>
      <text class="kbd-cand-page" v-if="pageInfo">{{ pageInfo }}</text>
      <text class="kbd-cand-none" v-if="!shownCands.length">{{ candHint }}</text>
    </div>

    <!-- 键区：九键中文（T9） -->
    <div class="kbd-keys" v-if="mode === 't9'">
      <div class="kbd-row" v-for="(row, ri) in t9Rows" :key="ri">
        <div class="t9-key" v-for="k in row" :key="k" @click="tapT9(k)">
          <text class="t9-num">{{ k }}</text>
          <text class="t9-sub">{{ t9Sub(k) }}</text>
        </div>
      </div>
      <div class="kbd-row">
        <div class="kbd-key kbd-key-wide" @click="onBackspace">
          <text class="kbd-key-txt">退格</text>
        </div>
        <div class="kbd-key kbd-key-space" @click="onSpace">
          <text class="kbd-key-txt">空格 选字</text>
        </div>
        <div class="kbd-key kbd-key-mid" @click="emitInsert('，')">
          <text class="kbd-key-txt">，</text>
        </div>
        <div class="kbd-key kbd-key-mid" @click="onEnter">
          <text class="kbd-key-txt">回车</text>
        </div>
        <div class="kbd-key kbd-key-mid kbd-key-go" @click="onDone">
          <text class="kbd-key-txt kbd-key-txt-go">确定</text>
        </div>
      </div>
    </div>

    <!-- 键区：全键盘中文（26 键拼音，行为与旧版一致） -->
    <div class="kbd-keys" v-else-if="mode === 'py'">
      <div class="kbd-row">
        <div class="kbd-key" v-for="k in pyRow1" :key="k" @click="tapPy(k)">
          <text class="kbd-key-txt">{{ k }}</text>
        </div>
      </div>
      <div class="kbd-row kbd-row2">
        <div class="kbd-key" v-for="k in pyRow2" :key="k" @click="tapPy(k)">
          <text class="kbd-key-txt">{{ k }}</text>
        </div>
      </div>
      <div class="kbd-row">
        <div class="kbd-key" v-for="k in pyRow3" :key="k" @click="tapPy(k)">
          <text class="kbd-key-txt">{{ k }}</text>
        </div>
        <div class="kbd-key kbd-key-wide" @click="onBackspace">
          <text class="kbd-key-txt">退格</text>
        </div>
      </div>
      <div class="kbd-row">
        <div class="kbd-key kbd-key-space" @click="onSpace">
          <text class="kbd-key-txt">空格 选字</text>
        </div>
        <div class="kbd-key kbd-key-mid" @click="onEnter">
          <text class="kbd-key-txt">回车</text>
        </div>
        <div class="kbd-key kbd-key-mid kbd-key-go" @click="onDone">
          <text class="kbd-key-txt kbd-key-txt-go">确定</text>
        </div>
      </div>
    </div>

    <!-- 键区：英文（QWERTY + 大小写 + 空格/回车/退格） -->
    <div class="kbd-keys" v-else-if="mode === 'en'">
      <div class="kbd-row">
        <div class="kbd-key" v-for="k in pyRow1" :key="k" @click="tapEn(k)">
          <text class="kbd-key-txt">{{ enLabel(k) }}</text>
        </div>
      </div>
      <div class="kbd-row kbd-row2">
        <div class="kbd-key" v-for="k in pyRow2" :key="k" @click="tapEn(k)">
          <text class="kbd-key-txt">{{ enLabel(k) }}</text>
        </div>
      </div>
      <div class="kbd-row">
        <div class="kbd-key kbd-key-wide" :class="[shift ? 'kbd-key-shift-on' : '']" @click="toggleShift">
          <text class="kbd-key-txt">{{ shift ? '小写' : '大写' }}</text>
        </div>
        <div class="kbd-key" v-for="k in pyRow3" :key="k" @click="tapEn(k)">
          <text class="kbd-key-txt">{{ enLabel(k) }}</text>
        </div>
      </div>
      <div class="kbd-row">
        <div class="kbd-key kbd-key-space" @click="emitInsert(' ')">
          <text class="kbd-key-txt">空格</text>
        </div>
        <div class="kbd-key kbd-key-mid" @click="onEnter">
          <text class="kbd-key-txt">回车</text>
        </div>
        <div class="kbd-key kbd-key-wide" @click="onBackspace">
          <text class="kbd-key-txt">退格</text>
        </div>
      </div>
    </div>

    <!-- 键区：数字（0-9 + 小数点 + 负号 + 空格/退格/回车） -->
    <div class="kbd-keys" v-else-if="mode === 'num'">
      <div class="kbd-row">
        <div class="kbd-key" v-for="k in numRow1" :key="k" @click="emitInsert(k)">
          <text class="kbd-key-txt">{{ k }}</text>
        </div>
      </div>
      <div class="kbd-row">
        <div class="kbd-key" v-for="k in numRow2" :key="k" @click="emitInsert(k)">
          <text class="kbd-key-txt">{{ k }}</text>
        </div>
      </div>
      <div class="kbd-row">
        <div class="kbd-key kbd-key-space" @click="emitInsert(' ')">
          <text class="kbd-key-txt">空格</text>
        </div>
        <div class="kbd-key kbd-key-mid" @click="onBackspace">
          <text class="kbd-key-txt">退格</text>
        </div>
        <div class="kbd-key kbd-key-mid kbd-key-go" @click="onEnter">
          <text class="kbd-key-txt kbd-key-txt-go">回车</text>
        </div>
      </div>
    </div>

    <!-- 键区：符号（中文标点两组 + ASCII 符号两组，点按即 insert） -->
    <div class="kbd-keys" v-else-if="mode === 'sym'">
      <div class="kbd-row">
        <div class="kbd-key" v-for="(k, i) in symRow1" :key="i" @click="emitInsert(k)">
          <text class="kbd-key-txt">{{ k }}</text>
        </div>
      </div>
      <div class="kbd-row">
        <div class="kbd-key" v-for="(k, i) in symRow2" :key="i" @click="emitInsert(k)">
          <text class="kbd-key-txt">{{ k }}</text>
        </div>
      </div>
      <div class="kbd-row">
        <div class="kbd-key" v-for="(k, i) in symRow3" :key="i" @click="emitInsert(k)">
          <text class="kbd-key-txt">{{ k }}</text>
        </div>
      </div>
      <div class="kbd-row">
        <div class="kbd-key" v-for="(k, i) in symRow4" :key="i" @click="emitInsert(k)">
          <text class="kbd-key-txt">{{ k }}</text>
        </div>
        <div class="kbd-key kbd-key-space" @click="emitInsert(' ')">
          <text class="kbd-key-txt">空格</text>
        </div>
        <div class="kbd-key kbd-key-wide" @click="onBackspace">
          <text class="kbd-key-txt">退格</text>
        </div>
        <div class="kbd-key kbd-key-wide kbd-key-go" @click="onEnter">
          <text class="kbd-key-txt kbd-key-txt-go">回车</text>
        </div>
      </div>
    </div>

    <!-- 应用内剪贴板：设备无系统剪贴板 API，记录存本地 storage（最多 20 条，去重，新的在前） -->
    <div class="kbd-clip" v-else>
      <div class="kbd-clip-bar">
        <text class="kbd-clip-title">剪贴板 {{ clipList.length }}/20</text>
        <text class="kbd-clip-msg" v-if="clipMsg">{{ clipMsg }}</text>
        <div class="kbd-clip-btn kbd-clip-btn-save" @click="saveClip">
          <text class="kbd-clip-btn-txt">保存</text>
        </div>
        <div class="kbd-clip-btn" @click="pageClip(-1)">
          <text class="kbd-clip-btn-txt">上页</text>
        </div>
        <div class="kbd-clip-btn" @click="pageClip(1)">
          <text class="kbd-clip-btn-txt">下页</text>
        </div>
        <text class="kbd-clip-page" v-if="clipPageCount > 1">{{ clipPage + 1 }}/{{ clipPageCount }}</text>
        <div class="kbd-clip-btn kbd-clip-btn-danger" @click="clearClip">
          <text class="kbd-clip-btn-txt">清空</text>
        </div>
      </div>
      <div class="kbd-clip-row" v-for="it in clipPageItems" :key="it">
        <div class="kbd-clip-item" @click="useClip(it)">
          <text class="kbd-clip-item-txt">{{ clipLabel(it) }}</text>
        </div>
        <div class="kbd-clip-del" @click="removeClip(it)">
          <text class="kbd-clip-del-txt">删</text>
        </div>
      </div>
      <text class="kbd-clip-empty" v-if="!clipList.length">暂无记录：在其他模式输入后点「保存」</text>
    </div>

  </div>
</template>

<script>
import { imeQuery, imeT9Query } from '../services/ime-engine.js';
import { jsapiStorageGet, jsapiStorageSet } from '../services/libjsapi.js';

const MAX_CAND_SHOW = 8;     // 拼音模式候选显示数（沿用旧版）
const T9_PAGE = 8;           // 九键候选每页条数（用「1」键翻页）
const CLIP_KEY = 'douyin_ime_clipboard'; // 应用内剪贴板 storage key
const CLIP_MAX = 20;         // 剪贴板最多 20 条
const CLIP_SHOW = 4;         // 剪贴板每页 4 条
const CLIP_TEXT_MAX = 60;    // 单条最长 60 字
const SESSION_MAX = 120;     // 会话已上屏文本保留上限

export default {
  name: 'PinyinIme',
  data() {
    return {
      mode: 't9',        // 默认九键中文
      buffer: '',        // 全拼模式：拼音缓冲
      t9Buffer: '',      // 九键模式：数字串缓冲
      t9Page: 0,         // 九键候选页码
      shift: false,      // 英文大小写（单次生效）
      clipList: [],      // 应用内剪贴板（新的在前）
      clipPage: 0,
      clipLoaded: false,
      clipMsg: '',
      clipTimer: null,
      // 本次输入会话累计「已上屏」文本：剪贴板「保存」的数据来源。
      // 组件拿不到宿主字段值（不新增 props/事件），因此以会话累计量代表当前输入内容。
      sessionText: '',
      modes: [
        { key: 't9', label: '九键' },
        { key: 'py', label: '全拼' },
        { key: 'en', label: '英文' },
        { key: 'num', label: '数字' },
        { key: 'sym', label: '符号' },
        { key: 'clip', label: '剪贴板' }
      ],
      pyRow1: ['q', 'w', 'e', 'r', 't', 'y', 'u', 'i', 'o', 'p'],
      pyRow2: ['a', 's', 'd', 'f', 'g', 'h', 'j', 'k', 'l'],
      pyRow3: ['z', 'x', 'c', 'v', 'b', 'n', 'm'],
      t9Rows: [
        ['1', '2', '3'],
        ['4', '5', '6'],
        ['7', '8', '9']
      ],
      t9Letters: {
        '2': 'abc', '3': 'def', '4': 'ghi', '5': 'jkl',
        '6': 'mno', '7': 'pqrs', '8': 'tuv', '9': 'wxyz'
      },
      numRow1: ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0'],
      numRow2: ['.', '-', '+', '/', ':', ','],
      symRow1: ['，', '。', '？', '！', '、', '；', '：', '（', '）', '《', '》'],
      symRow2: ['“', '”', '‘', '’', '…', '—', '～', '·', '@', '#', '$', '%'],
      symRow3: ['&', '*', '+', '-', '/', '=', '_', '[', ']', '{', '}', '<', '>', '|'],
      symRow4: ['^', '`', '\\']
    };
  },
  computed: {
    // ---------- 全拼（26 键）候选 ----------
    pyQuery() {
      return imeQuery(this.buffer);
    },
    pyCands() {
      return (this.pyQuery.candidates || []).slice(0, MAX_CAND_SHOW);
    },
    // ---------- 九键（T9）候选 ----------
    t9Query() {
      return imeT9Query(this.t9Buffer);
    },
    t9All() {
      return this.t9Query.candidates || [];
    },
    t9PageCount() {
      return Math.max(1, Math.ceil(this.t9All.length / T9_PAGE));
    },
    t9Cands() {
      const start = this.t9Page * T9_PAGE;
      return this.t9All.slice(start, start + T9_PAGE);
    },
    // 九键「1」键的副标签：有可翻页候选时是翻页键，否则是标点键
    t9OneLabel() {
      return this.t9All.length > T9_PAGE ? '翻页' : '标点';
    },
    shownCands() {
      if (this.mode === 't9') return this.t9Cands;
      if (this.mode === 'py') return this.pyCands;
      return [];
    },
    pageInfo() {
      if (this.mode !== 't9' || this.t9PageCount <= 1) return '';
      return (this.t9Page + 1) + '/' + this.t9PageCount;
    },
    candHint() {
      if (this.mode === 't9') {
        return this.t9Buffer ? '无匹配候选' : '数字键 2-9 输入拼音，1 翻页/逗号';
      }
      if (this.mode === 'py') {
        return this.buffer ? '无候选' : '输入字母开始拼音';
      }
      if (this.mode === 'en') return '英文：字母直接上屏，回车提交';
      if (this.mode === 'num') return '数字：支持小数点与负号';
      if (this.mode === 'sym') return '符号：点按即上屏';
      return '';
    },
    // ---------- 状态条 ----------
    barText() {
      if (this.mode === 'py') {
        const head = (this.pyQuery.syls || []).join(' ');
        const pending = this.pyQuery.pending || '';
        return pending ? head + ' ' + pending : head;
      }
      if (this.mode === 't9') return this.t9Buffer;
      return '';
    },
    barHint() {
      if (this.mode === 'py') return '拼音输入';
      if (this.mode === 't9') return '九键：数字串拼音，1 翻页/逗号';
      if (this.mode === 'clip') {
        const tail = this.sessionText ? this.sessionText.slice(-12) : '（本次暂无上屏内容）';
        return '剪贴板：点条目插入输入框，保存本次已上屏：' + tail;
      }
      return this.candHint;
    },
    hasBuffer() {
      if (this.mode === 'py') return !!this.buffer;
      if (this.mode === 't9') return !!this.t9Buffer;
      return false;
    },
    // ---------- 剪贴板分页 ----------
    clipPageCount() {
      return Math.max(1, Math.ceil(this.clipList.length / CLIP_SHOW));
    },
    clipPageItems() {
      const start = this.clipPage * CLIP_SHOW;
      return this.clipList.slice(start, start + CLIP_SHOW);
    }
  },
  beforeDestroy() {
    if (this.clipTimer) {
      clearTimeout(this.clipTimer);
      this.clipTimer = null;
    }
  },
  methods: {
    // ---------- 对外事件的唯一出口：同步累计会话文本，保证剪贴板「保存」有内容可存 ----------
    emitInsert(ch) {
      const text = String(ch == null ? '' : ch);
      this.sessionText = this.trackSession(this.sessionText + text);
      this.$emit('insert', text);
    },
    emitCommit(text) {
      const out = String(text == null ? '' : text);
      this.sessionText = this.trackSession(this.sessionText + out);
      this.$emit('commit', out);
    },
    emitDelete() {
      if (this.sessionText) this.sessionText = this.sessionText.slice(0, -1);
      this.$emit('delete-char');
    },
    trackSession(text) {
      return text.length > SESSION_MAX ? text.slice(-SESSION_MAX) : text;
    },

    // ---------- 模式栏 ----------
    switchMode(key) {
      if (this.mode === key) return;
      this.mode = key;
      if (key === 'clip') this.loadClip();
    },

    // ---------- 全键盘中文 ----------
    tapPy(k) {
      this.buffer += k;
    },
    pickRaw() {
      if (!this.buffer) return;
      this.emitCommit(this.buffer);
      this.buffer = '';
    },
    // 候选分发：拼音模式剩余音节回填；九键模式剩余数字回填
    pickCandidate(c) {
      if (this.mode === 't9') this.pickT9Candidate(c);
      else this.pickPyCandidate(c);
    },
    pickPyCandidate(c) {
      this.emitCommit(c.text);
      const syls = this.pyQuery.syls || [];
      if (c.len && c.len < syls.length) {
        this.buffer = syls.slice(c.len).join('') + (this.pyQuery.pending || '');
      } else {
        this.buffer = '';
      }
    },

    // ---------- 九键中文（T9） ----------
    tapT9(k) {
      if (k === '1') {
        this.tapT9One();
        return;
      }
      this.t9Buffer += k;
      this.t9Page = 0;
    },
    // 九键「1」交互（自定）：有超过一页候选时循环翻页；某页显示不下时无候选可翻，则上屏中文逗号。
    // 「，」另有独立按键，因此有候选时也不会打不出逗号。
    tapT9One() {
      if (this.t9All.length > T9_PAGE) {
        this.t9Page = (this.t9Page + 1) % this.t9PageCount;
        return;
      }
      this.emitInsert('，');
    },
    t9Sub(k) {
      return k === '1' ? this.t9OneLabel : (this.t9Letters[k] || '');
    },
    pickT9Candidate(c) {
      this.emitCommit(c.text);
      // 候选可能只覆盖了前几位数字，剩下的数字留在缓冲里继续输入（逐字回退）
      if (c.len && c.len < this.t9Buffer.length) {
        this.t9Buffer = this.t9Buffer.slice(c.len);
      } else {
        this.t9Buffer = '';
      }
      this.t9Page = 0;
    },

    // ---------- 英文 ----------
    tapEn(k) {
      const ch = this.shift ? k.toUpperCase() : k;
      this.shift = false; // 单次大写，输入一个字母后自动回小写
      this.emitInsert(ch);
    },
    toggleShift() {
      this.shift = !this.shift;
    },
    enLabel(k) {
      return this.shift ? k.toUpperCase() : k;
    },

    // ---------- 公共键 ----------
    // 空格：中文模式选当前页首选（手机习惯），其他模式插入空格
    onSpace() {
      const first = this.shownCands[0];
      if (this.isChinese() && first) {
        this.pickCandidate(first);
        return;
      }
      this.emitInsert(' ');
    },
    // 回车：中文模式提交首选候选（无候选则提交原始字母）；英文/数字/符号逐字上屏，回车只发提交信号
    onEnter() {
      if (this.mode === 'py') {
        const first = this.pyCands[0];
        if (first) { this.pickPyCandidate(first); return; }
        if (this.buffer) { this.pickRaw(); return; }
      }
      if (this.mode === 't9') {
        const first = this.t9Cands[0];
        if (first) { this.pickT9Candidate(first); return; }
      }
      this.emitCommit('');
    },
    onBackspace() {
      if (this.mode === 'py' && this.buffer) {
        this.buffer = this.buffer.slice(0, -1);
        return;
      }
      if (this.mode === 't9' && this.t9Buffer) {
        this.t9Buffer = this.t9Buffer.slice(0, -1);
        this.t9Page = 0;
        return;
      }
      this.emitDelete();
    },
    clearBuffer() {
      if (this.mode === 'py') this.buffer = '';
      else if (this.mode === 't9') { this.t9Buffer = ''; this.t9Page = 0; }
    },
    onDone() {
      // 确定前若有未上屏候选，先把首选落进输入框
      const first = this.shownCands[0];
      if (this.isChinese() && first) this.pickCandidate(first);
      this.buffer = '';
      this.t9Buffer = '';
      this.t9Page = 0;
      this.$emit('done');
    },
    isChinese() {
      return this.mode === 't9' || this.mode === 'py';
    },

    // ---------- 应用内剪贴板 ----------
    // 持久化：libjsapi storage；浏览器预览/无 storage 模块时会 reject，一律 try/catch 兜底为内存态
    loadClip() {
      if (this.clipLoaded) return;
      this.clipLoaded = true;
      jsapiStorageGet(CLIP_KEY).then((raw) => {
        const list = typeof raw === 'string' ? JSON.parse(raw) : raw;
        if (Array.isArray(list)) {
          this.clipList = list.filter((x) => typeof x === 'string' && x).slice(0, CLIP_MAX);
        }
      }).catch(() => {
        this.clipList = [];
      });
    },
    persistClip() {
      try {
        jsapiStorageSet(CLIP_KEY, JSON.stringify(this.clipList)).catch(() => {});
      } catch (error) {
        // 无 storage 模块：静默降级为本次会话内存剪贴板
      }
    },
    // 保存：把本次会话已上屏文本存为一条记录（去重、新的在前、上限 20 条）
    saveClip() {
      const text = this.sessionText.trim().slice(0, CLIP_TEXT_MAX);
      if (!text) {
        this.toast('暂无可保存内容');
        return;
      }
      this.clipList = [text].concat(this.clipList.filter((x) => x !== text)).slice(0, CLIP_MAX);
      this.clipPage = 0;
      this.persistClip();
      this.toast('已保存');
    },
    // 点条目：insert 而非 commit——插入语义与输入框「追加」模型一致，不会把整条当作一次完整提交
    useClip(text) {
      this.emitInsert(text);
      this.toast('已插入输入框');
    },
    removeClip(text) {
      this.clipList = this.clipList.filter((x) => x !== text);
      if (this.clipPage >= this.clipPageCount) this.clipPage = this.clipPageCount - 1;
      this.persistClip();
      this.toast('已删除');
    },
    clearClip() {
      if (!this.clipList.length) {
        this.toast('剪贴板已空');
        return;
      }
      this.clipList = [];
      this.clipPage = 0;
      this.persistClip();
      this.toast('已清空');
    },
    pageClip(step) {
      const count = this.clipPageCount;
      if (count <= 1) return;
      this.clipPage = (this.clipPage + step + count) % count;
    },
    clipLabel(text) {
      return text.length > 16 ? text.slice(0, 16) + '…' : text;
    },
    toast(msg) {
      this.clipMsg = msg;
      if (this.clipTimer) clearTimeout(this.clipTimer);
      this.clipTimer = setTimeout(() => {
        this.clipMsg = '';
        this.clipTimer = null;
      }, 1600);
    }
  }
};
</script>

<style scoped>
/* 高度合计（逻辑横屏 800x254）：
   容器内边距 4+6=10；模式栏 22+2=24；状态条 20；候选栏 24+2=26；
   键区每行 24+2=26。
   九键/全拼/英文/符号 = 10+24+20+26+4*26 = 184px
   数字 = 10+24+20+26+3*26 = 158px
   剪贴板 = 10+24+20+(24+2)+4*26 = 184px
   均 < 254px。选择器全部为单类名（Weex 不支持 .a.b 复合选择器）。 */
.kbd {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  z-index: 15;
  background-color: #191c1f;
  border-top-width: 1px;
  border-top-style: solid;
  border-top-color: #33373b;
  padding: 4px 4px 6px;
}

/* 模式栏 */
.kbd-modes {
  height: 22px;
  flex-direction: row;
  margin-bottom: 2px;
}
.kbd-mode {
  flex: 1;
  height: 22px;
  margin-left: 2px;
  margin-right: 2px;
  border-radius: 4px;
  background-color: #23272b;
  align-items: center;
  justify-content: center;
}
.kbd-mode-on {
  background-color: #fe2c55;
}
.kbd-mode-txt {
  color: #9aa0a6;
  font-size: 11px;
}
.kbd-mode-txt-on {
  color: #ffffff;
  font-weight: bold;
}

/* 状态条（拼音条 / 九键数字串 / 模式提示） */
.kbd-bar {
  height: 20px;
  flex-direction: row;
  align-items: center;
  justify-content: space-between;
  padding-left: 6px;
  padding-right: 6px;
}
.kbd-bar-txt {
  color: #8fd3ff;
  font-size: 10px;
}
.kbd-bar-dim {
  color: #666b70;
}
.kbd-clr {
  color: #999fa5;
  font-size: 10px;
  padding: 3px 8px;
}

/* 候选栏 */
.kbd-cands {
  height: 24px;
  flex-direction: row;
  align-items: center;
  border-bottom-width: 1px;
  border-bottom-style: solid;
  border-bottom-color: #2b2f33;
  margin-bottom: 2px;
}
.kbd-cand {
  height: 22px;
  margin-left: 2px;
  margin-right: 2px;
  padding-left: 7px;
  padding-right: 7px;
  border-radius: 5px;
  background-color: #2b2f33;
  align-items: center;
  justify-content: center;
}
.kbd-cand-raw {
  background-color: #3a3f44;
}
.kbd-cand-txt {
  color: #ffffff;
  font-size: 10px;
}
.kbd-cand-txt-raw {
  color: #8fd3ff;
}
.kbd-cand-page {
  color: #8fd3ff;
  font-size: 9px;
  margin-left: 6px;
}
.kbd-cand-none {
  color: #666b70;
  font-size: 10px;
  margin-left: 8px;
}

/* 键区 */
.kbd-keys {
  flex-direction: column;
}
.kbd-row {
  height: 24px;
  flex-direction: row;
  margin-bottom: 2px;
}
.kbd-row2 {
  padding-left: 10px;
  padding-right: 10px;
}
.kbd-key {
  flex: 1;
  height: 24px;
  margin-left: 1px;
  margin-right: 1px;
  border-radius: 4px;
  background-color: #3a3f44;
  align-items: center;
  justify-content: center;
}
.kbd-key-txt {
  color: #ffffff;
  font-size: 10px;
}
.kbd-key-wide {
  flex: 1.6;
}
.kbd-key-mid {
  flex: 1.5;
}
.kbd-key-space {
  flex: 4;
}
.kbd-key-shift-on {
  background-color: #fe2c55;
}
.kbd-key-go {
  background-color: #fe2c55;
}
.kbd-key-txt-go {
  color: #ffffff;
  font-weight: bold;
}

/* 九键按键：数字 + 字母小标 */
.t9-key {
  flex: 1;
  height: 24px;
  margin-left: 1px;
  margin-right: 1px;
  border-radius: 4px;
  background-color: #2f3438;
  flex-direction: column;
  align-items: center;
  justify-content: center;
}
.t9-num {
  color: #ffffff;
  font-size: 11px;
}
.t9-sub {
  color: #9aa0a6;
  font-size: 7px;
}

/* 剪贴板面板 */
.kbd-clip {
  flex-direction: column;
}
.kbd-clip-bar {
  height: 24px;
  flex-direction: row;
  align-items: center;
  margin-bottom: 2px;
}
.kbd-clip-title {
  color: #ffffff;
  font-size: 10px;
  margin-left: 6px;
}
.kbd-clip-msg {
  color: #8fd3ff;
  font-size: 10px;
  margin-left: 8px;
}
.kbd-clip-page {
  color: #8fd3ff;
  font-size: 10px;
  margin-left: 6px;
  margin-right: 6px;
}
.kbd-clip-btn {
  width: 56px;
  height: 22px;
  margin-left: 6px;
  padding-left: 8px;
  padding-right: 8px;
  border-radius: 4px;
  background-color: #2b2f33;
  align-items: center;
  justify-content: center;
}
.kbd-clip-btn-save {
  background-color: #2f6f4f;
}
.kbd-clip-btn-danger {
  background-color: #7a2a33;
}
.kbd-clip-btn-txt {
  color: #ffffff;
  font-size: 10px;
}
.kbd-clip-row {
  height: 24px;
  flex-direction: row;
  align-items: center;
  margin-bottom: 2px;
}
.kbd-clip-item {
  flex: 1;
  height: 24px;
  margin-left: 2px;
  margin-right: 2px;
  padding-left: 8px;
  border-radius: 4px;
  background-color: #2b2f33;
  flex-direction: row;
  align-items: center;
}
.kbd-clip-item-txt {
  color: #ffffff;
  font-size: 10px;
}
.kbd-clip-del {
  width: 46px;
  height: 24px;
  margin-right: 2px;
  border-radius: 4px;
  background-color: #3a3f44;
  align-items: center;
  justify-content: center;
}
.kbd-clip-del-txt {
  color: #ff9aa9;
  font-size: 10px;
}
.kbd-clip-empty {
  color: #666b70;
  font-size: 10px;
  margin-left: 8px;
  margin-top: 6px;
}
</style>
