<script setup>
import { computed, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { state, api, role, setBoard } from './api.js';

const route = useRoute();
const router = useRouter();

const tabs = computed(() => {
  const c = state.counts || {};
  const t = [
    { to: '/', label: '欠票总览' },
    { to: '/statements', label: '对账单', badge: role.fin() ? c.statements_pending : c.statements_rejected },
    { to: '/invoices', label: '发票', badge: role.fin() ? c.invoices_pending : 0 },
    { to: '/dunning', label: '催票' },
  ];
  if (role.fin()) t.push({ to: '/tax-costs', label: '税费成本' }, { to: '/master', label: '基础资料' }, { to: '/audit', label: '操作记录' });
  if (role.admin()) t.push({ to: '/users', label: '用户与设置' });
  return t;
});
const isCurrent = (to) => (to === '/' ? route.path === '/' || route.path.startsWith('/suppliers') : route.path.startsWith(to));

async function refreshCounts() {
  if (!state.me || state.me.must_change_password) return;
  try { state.counts = (await api.get('/api/overview')).counts; } catch { /* ignore */ }
}
watch(() => [route.fullPath, state.me?.id], refreshCounts, { immediate: true });

async function logout() {
  await api.post('/api/logout').catch(() => {});
  state.me = null; state.master = null;
  router.replace({ name: 'login' });
}
</script>

<template>
  <template v-if="route.meta.public || !state.me">
    <router-view />
  </template>
  <template v-else>
    <header class="top">
      <div class="wrap bar">
        <div class="brand">{{ state.settings.company_name || '供应商发票跟踪' }}</div>
        <div class="seg" role="group" aria-label="板块">
          <button v-for="b in ['', '电商', '工厂']" :key="b" :aria-pressed="state.board === b" @click="setBoard(b)">{{ b || '全部' }}</button>
        </div>
        <div class="spacer"></div>
        <span class="user">{{ state.me.name }} · {{ state.me.role }}</span>
        <router-link class="btn sm" to="/password">改密码</router-link>
        <button class="btn sm" @click="logout">退出</button>
      </div>
      <div class="wrap">
        <nav class="tabs" v-if="!state.me.must_change_password">
          <router-link v-for="t in tabs" :key="t.to" :to="t.to" :aria-current="isCurrent(t.to) ? 'page' : null">
            {{ t.label }}<span v-if="t.badge" class="badge">{{ t.badge }}</span>
          </router-link>
        </nav>
      </div>
    </header>
    <main class="wrap">
      <router-view :key="route.path" />
    </main>
  </template>
  <div class="toast" :class="{ on: state.toast }" role="status" aria-live="polite">{{ state.toast }}</div>
</template>
