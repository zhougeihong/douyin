// 跨页传递“要播什么”的暂存位。
// 本运行时的页面导航参数投递方式在不同固件上不一致（参考项目用 $page.options），
// 所以导航前先在这里放一份，播放页优先读 options、读不到就用这份兜底。

let pending = null;

export function setPendingPlay(request) {
  pending = request ? Object.assign({}, request) : null;
}

export function takePendingPlay() {
  const value = pending;
  pending = null;
  return value;
}
