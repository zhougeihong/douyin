<template>
  <div class="blank-page">
    <text class="blank-txt">...</text>
  </div>
</template>

<script>
// 占位页：仅用于让构建走“多文件 jsbundle”模式（单页面会被 aiot-cli 强制合并为单 bundle，
// 而 bin 化后的单 bundle 页面模块无法被运行时按页面名加载——见预置包 Launcher 的多文件形态）。
export default {
  name: 'Blank',
  data() {
    return {};
  }
};
</script>

<style scoped>
.blank-page {
  background-color: #101214;
  align-items: center;
  justify-content: center;
}
.blank-txt {
  color: rgba(255, 255, 255, 0.3);
  font-size: 12px;
}
</style>
