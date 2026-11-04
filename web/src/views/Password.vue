<script setup>
import { ref, computed, onMounted } from 'vue';
import { useRouter } from 'vue-router';
import { api, state, toast, attempt, dtm, passwordProblem, PASSWORD_RULE } from '../api.js';

const router = useRouter();
const f = ref({ old_password: '', new_password: '', again: '' });
const err = ref('');
const sessions = ref([]);
const loadSessions = async () => { if (!state.me?.must_change_password) sessions.value = (await attempt(() => api.get('/api/me/sessions'))) || []; };
onMounted(loadSessions);
const hint = computed(() => (f.value.new_password ? passwordProblem(f.value.new_password, state.me?.username) : ''));

async function submit() {
  err.value = '';
  if (hint.value) { err.value = hint.value; return; }
  if (f.value.new_password !== f.value.again) { err.value = '两次输入的新密码不一样'; return; }
  try {
    const first = state.me.must_change_password;
    await api.post('/api/me/password', f.value);
    state.me.must_change_password = 0;
    f.value = { old_password: '', new_password: '', again: '' };
    toast('密码已修改，其他设备上的登录已全部退出');
    if (first) router.replace('/'); else loadSessions();
  } catch (e) { err.value = e.message; }
}
async function logoutOthers() {
  const r = await attempt(() => api.post('/api/me/sessions/logout-others'));
  if (r) { toast(`已退出 ${r.count} 台其他设备`); loadSessions(); }
}
const device = (ua) => {
  const s = String(ua || '');
  const os = /iPhone|iPad/.test(s) ? 'iPhone/iPad' : /Android/.test(s) ? '安卓手机' : /Windows/.test(s) ? 'Windows 电脑' : /Mac OS/.test(s) ? 'Mac 电脑' : '其他设备';
  const br = /MicroMessenger/.test(s) ? '微信' : /Edg\//.test(s) ? 'Edge' : /Chrome\//.test(s) ? 'Chrome' : /Safari\//.test(s) ? 'Safari' : /Firefox\//.test(s) ? 'Firefox' : '';
  return br ? `${os} · ${br}` : os;
};
</script>

<template>
  <div>
    <h2>账号安全</h2>
    <p class="sub">{{ state.me?.name }}（{{ state.me?.username }}）· 超过 {{ state.security?.idle_hours || 12 }} 小时不操作会自动退出，每次登录最长保持 {{ state.security?.session_days || 7 }} 天。</p>
  </div>
  <div class="grid2">
    <section class="panel">
      <div class="panel-h"><h3>修改密码</h3></div>
      <div class="panel-b">
        <p v-if="state.me?.must_change_password" class="notice" style="margin-top:0">第一次登录，请先把初始密码改成只有你自己知道的密码，改完才能使用系统。</p>
        <form class="form" @submit.prevent="submit">
          <label class="full">原密码<input v-model="f.old_password" type="password" autocomplete="current-password" required></label>
          <label class="full">新密码<input v-model="f.new_password" type="password" autocomplete="new-password" required></label>
          <p class="full note" style="margin:0" :style="hint ? 'color:var(--warn)' : ''">{{ hint || PASSWORD_RULE }}</p>
          <label class="full">再输一次<input v-model="f.again" type="password" autocomplete="new-password" required></label>
          <p v-if="err" class="err full" role="alert">{{ err }}</p>
          <div class="full"><button class="btn pri">保存新密码</button></div>
        </form>
      </div>
    </section>
    <section class="panel" v-if="!state.me?.must_change_password">
      <div class="panel-h"><h3>登录中的设备</h3><span class="spacer"></span>
        <button class="btn sm danger" :disabled="sessions.length < 2" @click="logoutOthers">退出其他设备</button></div>
      <div class="panel-b pend">
        <div v-for="s in sessions" :key="s.id" class="pend-card" :style="s.current ? 'border-left-color:var(--good)' : ''">
          <div class="row"><b>{{ device(s.user_agent) }}</b><span v-if="s.current" class="chip c-good">当前设备</span><span class="spacer"></span><span class="note mono">{{ s.ip }}</span></div>
          <div class="note">登录于 {{ dtm(s.created_at) }} · 最近活动 {{ dtm(s.last_seen) }}</div>
        </div>
        <p class="note" style="margin:0">看到不认识的设备，先「退出其他设备」，再改密码。</p>
      </div>
    </section>
  </div>
</template>
