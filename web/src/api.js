import { reactive } from 'vue';
import router from './router.js';

export class ApiError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

async function request(method, url, body, isForm) {
  const opts = { method, credentials: 'same-origin', headers: {} };
  if (body !== undefined) {
    if (isForm) opts.body = body;
    else { opts.body = JSON.stringify(body); opts.headers['Content-Type'] = 'application/json'; }
  }
  let res;
  try { res = await fetch(url, opts); } catch { throw new ApiError(0, '网络连接失败，请检查网络'); }
  const data = res.headers.get('content-type')?.includes('json') ? await res.json() : null;
  if (!res.ok) {
    if (res.status === 401 && !url.endsWith('/login')) {
      state.me = null;
      if (router.currentRoute.value.name !== 'login') router.replace({ name: 'login', query: { next: router.currentRoute.value.fullPath } });
    }
    throw new ApiError(res.status, data?.error || `请求失败（${res.status}）`);
  }
  return data;
}

const qs = (o = {}) => {
  const p = Object.entries(o).filter(([, v]) => v !== undefined && v !== null && v !== '');
  return p.length ? '?' + new URLSearchParams(p).toString() : '';
};

export const api = {
  get: (url, q) => request('GET', url + qs(q)),
  post: (url, body) => request('POST', url, body ?? {}),
  patch: (url, body) => request('PATCH', url, body),
  put: (url, body) => request('PUT', url, body),
  del: (url) => request('DELETE', url),
  upload: (url, file, q) => { const f = new FormData(); f.append('file', file); return request('POST', url + qs(q), f, true); },
  /** Downloads go through a normal link so the browser saves the file. */
  download: (url, q) => { const a = document.createElement('a'); a.href = url + qs(q); a.download = ''; document.body.append(a); a.click(); a.remove(); },
};

export const state = reactive({
  me: null,
  settings: {},
  board: localStorageGet('board') || '',
  master: null,
  toast: '',
  counts: {},
});

function localStorageGet(k) { try { return localStorage.getItem(k); } catch { return null; } }
export function setBoard(b) { state.board = b; try { localStorage.setItem('board', b); } catch { /* ignore */ } }

let toastTimer;
export function toast(msg) {
  state.toast = msg;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { state.toast = ''; }, 2600);
}
/** Run an action, show its error as a toast, return its result (or undefined on error). */
export async function attempt(fn, okMsg) {
  try {
    const r = await fn();
    if (okMsg) toast(okMsg);
    return r;
  } catch (e) {
    toast(e.message || '出错了');
    return undefined;
  }
}

export async function loadMe() {
  try {
    const r = await api.get('/api/me');
    state.me = r.user; state.settings = r.settings;
  } catch { state.me = null; }
  return state.me;
}

export async function loadMaster(force) {
  if (!state.master || force) state.master = await api.get('/api/master');
  return state.master;
}

export const role = {
  fin: () => ['管理员', '财务'].includes(state.me?.role),
  admin: () => state.me?.role === '管理员',
  gd: () => state.me?.role === '跟单员',
};

export const money = (n) => (n == null || n === '' ? '—' : Number(n).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
export const pct = (r) => (r == null ? '—' : `${Math.round(Number(r) * 10000) / 100}%`);
export const dt = (s) => (s ? String(s).slice(0, 10) : '—');
export const dtm = (s) => (s ? String(s).slice(0, 16).replace('T', ' ') : '—');
export const BOARDS = ['电商', '工厂'];
export const todayStr = () => new Date().toISOString().slice(0, 10);

export async function copyText(t) {
  try { await navigator.clipboard.writeText(t); toast('已复制'); }
  catch {
    const ta = document.createElement('textarea'); ta.value = t; document.body.append(ta); ta.select();
    try { document.execCommand('copy'); toast('已复制'); } catch { toast('复制失败，请手动选择文字'); }
    ta.remove();
  }
}
