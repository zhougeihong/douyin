// 登录态管理：基于 libjsapi 原生 storage 模块持久化（替代旧的后端会话方案）。
// 登录流程为抖音扫码（见 services/douyin-auth.js），设备端轮询确认后保存用户标识。
import { jsapiStorageGet, jsapiStorageSet, jsapiStorageRemove } from '../services/libjsapi.js';
import { requestLoginQr, checkLoginQr, sendSmsCode, loginBySmsCode } from '../services/douyin-auth.js';

const SESSION_KEY = 'douyin_app_session';

export { requestLoginQr, checkLoginQr, sendSmsCode, loginBySmsCode };

export function readSession() {
  return jsapiStorageGet(SESSION_KEY).then((stored) => {
    const session = typeof stored === 'string' ? safeParse(stored) : stored;
    if (session && (session.id || session.nick) && session.loginAt) return session;
    return null;
  }).catch(() => null);
}

function safeParse(text) {
  try {
    return JSON.parse(text);
  } catch (error) {
    return null;
  }
}

export function saveSession(session) {
  return jsapiStorageSet(SESSION_KEY, session).then(() => session);
}

export function clearSession() {
  return jsapiStorageRemove(SESSION_KEY).catch(() => {});
}
