import { detectScreen } from './services/device-screen.js';

class App extends $falcon.App {
  onCreate() {
    super.onCreate();
    // ★必须在任何 `import('video')` 之前把逻辑分辨率告知原生侧。
    // 参考实现里这个全局量（$shugeScreen）由播放页设置，而我们的诊断功能会提前把
    // video 模块 import 进来（模块只在首次加载时初始化），一旦抢在前面，原生侧就会
    // 固定错误的屏幕几何 → 解码正常、进度在走、但画面全黑。
    // 放到 App.onCreate：早于一切页面与模块加载。
    detectScreen().catch(() => {});
  }
  onHide() {
    super.onHide();
  }
  onDestroy() {
    super.onDestroy();
  }
}
export default App;
