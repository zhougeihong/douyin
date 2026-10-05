import ChatLogin from './chat-login.vue';

class PageChatLogin extends $falcon.Page {
  onLoad(options) {
    super.onLoad(options);
    // 页面展示前必须设置根组件
    this.setRootComponent(ChatLogin);
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
export default PageChatLogin;
