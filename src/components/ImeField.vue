<template>
  <!-- 输入位：替代系统 input（设备无可用输入法）。
       点击后 emit('ime-focus')，由页面唤起 PinyinIme 软键盘并把事件路由回本字段。 -->
  <div class="ime-field" @click="onTap">
    <text class="ime-val" v-if="value">{{ value }}</text>
    <text class="ime-ph" v-else>{{ placeholder }}</text>
    <text class="ime-caret" v-if="active">{{ value ? ' ' : '' }}|</text>
  </div>
</template>

<script>
export default {
  name: 'ImeField',
  props: {
    value: { type: String, default: '' },
    placeholder: { type: String, default: '' },
    active: { type: Boolean, default: false },
    name: { type: String, default: '' }
  },
  methods: {
    onTap() {
      this.$emit('ime-focus', this.name);
    }
  }
};
</script>

<style scoped>
.ime-field {
  flex: 1;
  height: 28px;
  flex-direction: row;
  align-items: center;
}
.ime-val {
  color: #ffffff;
  font-size: 12px;
}
.ime-ph {
  color: #7a8086;
  font-size: 12px;
}
.ime-caret {
  color: #fe2c55;
  font-size: 12px;
}
</style>
