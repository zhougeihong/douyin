import Fanqie from './fanqie.vue';

class PageFanqie extends $falcon.Page {
  onLoad(options) {
    super.onLoad(options);
    // 页面展示前必须设置根组件
    this.setRootComponent(Fanqie);
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
export default PageFanqie;
