import { createApp } from 'vue';
import App from './App.vue';
import router from './router.js';
import { state, loadMe, role } from './api.js';
import './style.css';

router.beforeEach(async (to) => {
  if (to.meta.public) return true;
  if (!state.me) await loadMe();
  if (!state.me) return { name: 'login', query: to.fullPath !== '/' ? { next: to.fullPath } : {} };
  if (state.me.must_change_password && to.name !== 'password') return { name: 'password' };
  if (to.meta.admin && !role.admin()) return { name: 'overview' };
  if (to.meta.fin && !role.fin()) return { name: 'overview' };
  return true;
});
router.afterEach((to) => {
  document.title = (to.meta.title ? to.meta.title + ' · ' : '') + (state.settings.company_name || '供应商发票跟踪');
});

createApp(App).use(router).mount('#app');
