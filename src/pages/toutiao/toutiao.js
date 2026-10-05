import Toutiao from './toutiao.vue';

class PageToutiao extends $falcon.Page {
  onLoad(options) {
    super.onLoad(options);
    // 页面展示前必须设置根组件
    this.setRootComponent(Toutiao);
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
export default PageToutiao;
