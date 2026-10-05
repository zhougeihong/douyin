import Player from './player.vue';

class PagePlayer extends $falcon.Page {
  onLoad(options) {
    super.onLoad(options);
    this.options = options || {};
    // 页面展示前必须设置根组件
    this.setRootComponent(Player);
  }
  onShow() {
    super.onShow();
  }
  onHide() {
    super.onHide();
  }
  onDestroy() {
    super.onDestroy();
  }
}
export default PagePlayer;
