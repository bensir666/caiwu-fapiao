<script setup>
import { ref, onMounted } from 'vue';
import { api, state, dt, attempt, toast, loadMe } from '../api.js';
import Modal from '../components/Modal.vue';

const ROLES = ['跟单员', '财务', '管理员'];
const users = ref([]);
const load = async () => { users.value = (await attempt(() => api.get('/api/users'))) || []; };
onMounted(load);

const nu = ref({ username: '', name: '', role: '跟单员', password: '' });
async function create() {
  if (await attempt(() => api.post('/api/users', nu.value), `已创建，把用户名和初始密码告诉${nu.value.name}，首次登录会要求改密码`) !== undefined) {
    nu.value = { username: '', name: '', role: '跟单员', password: '' }; load();
  }
}
const ed = ref(null);
const openEd = (u) => { ed.value = { ...u, active: !!u.active, password: '' }; };
async function saveEd() {
  const { id, name, role, active, password } = ed.value;
  if (await attempt(() => api.patch(`/api/users/${id}`, { name, role, active, password: password || undefined }), '已保存') !== undefined) { ed.value = null; load(); }
}

const st = ref({ company_name: state.settings.company_name, opening_date: state.settings.opening_date });
async function saveSettings() {
  if (await attempt(() => api.put('/api/settings', st.value), '设置已保存') !== undefined) loadMe();
}
const gen = () => { nu.value.password = Math.random().toString(36).slice(2, 6) + Math.random().toString(36).slice(2, 8); };
</script>

<template>
  <div><h2>用户与设置</h2><p class="sub">跟单员只能看到分配给自己的供应商；财务负责终审、发票分配和基础资料；管理员另外管理用户。</p></div>
  <div class="grid2">
    <section class="panel">
      <div class="panel-h"><h3>新建用户</h3></div>
      <form class="panel-b form" @submit.prevent="create">
        <label>姓名<input v-model="nu.name" required></label>
        <label>登录用户名（字母数字）<input v-model.trim="nu.username" required pattern="[A-Za-z0-9_.\-]{2,32}" autocapitalize="off"></label>
        <label>角色<select v-model="nu.role"><option v-for="r in ROLES" :key="r">{{ r }}</option></select></label>
        <label>初始密码（至少 8 位）<span class="row" style="flex-wrap:nowrap"><input v-model="nu.password" required minlength="8" style="flex:1"><button class="btn sm" type="button" @click="gen">随机</button></span></label>
        <div class="full"><button class="btn pri">创建</button></div>
      </form>
    </section>
    <section class="panel">
      <div class="panel-h"><h3>系统设置</h3></div>
      <form class="panel-b form" @submit.prevent="saveSettings">
        <label class="full">公司名称（显示在页面顶部和催票话术里）<input v-model="st.company_name" maxlength="60"></label>
        <label class="full">启用日（期初欠票的日期，用来算账龄）<input v-model="st.opening_date" type="date"></label>
        <div class="full"><button class="btn pri">保存设置</button></div>
      </form>
    </section>
  </div>
  <section class="panel">
    <div class="panel-h"><h3>用户</h3><span class="note">{{ users.length }} 人</span></div>
    <div class="tbl"><table>
      <thead><tr><th>姓名</th><th>用户名</th><th>角色</th><th>状态</th><th>创建</th></tr></thead>
      <tbody>
        <tr v-for="u in users" :key="u.id" class="click" @click="openEd(u)">
          <td><b>{{ u.name }}</b></td><td class="mono">{{ u.username }}</td><td>{{ u.role }}</td>
          <td><span class="chip" :class="u.active ? 'c-good' : 'c-mut'">{{ u.active ? '在用' : '停用' }}</span></td><td class="num">{{ dt(u.created_at) }}</td>
        </tr>
      </tbody>
    </table></div>
  </section>
  <Modal :open="!!ed" :title="`修改用户 ${ed?.username || ''}`" @close="ed = null">
    <form v-if="ed" class="form" @submit.prevent="saveEd">
      <label>姓名<input v-model="ed.name" required></label>
      <label>角色<select v-model="ed.role" :disabled="ed.id === state.me.id"><option v-for="r in ROLES" :key="r">{{ r }}</option></select></label>
      <label class="full">重置密码（留空不改；重置后对方要重新登录并改密码）<input v-model="ed.password" minlength="8" autocomplete="new-password"></label>
      <label v-if="ed.id !== state.me.id" class="ctl full" style="display:flex"><input type="checkbox" v-model="ed.active"> 在用（停用后立即退出登录）</label>
      <div class="full"><button class="btn pri">保存</button></div>
    </form>
  </Modal>
</template>
