<script setup>
import PageGuide from '../components/PageGuide.vue';
import { ref, onMounted } from 'vue';
import { api, state, dt, dtm, attempt, toast, loadMe, randomPassword, PASSWORD_RULE } from '../api.js';
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
const gen = () => { nu.value.password = randomPassword(); };
const genEd = () => { ed.value.password = randomPassword(); };
const locked = (u) => u.locked_until && Date.parse(u.locked_until.replace(' ', 'T') + 'Z') > Date.now();
async function kick(u) {
  const r = await attempt(() => api.post(`/api/users/${u.id}/logout`));
  if (r) { toast(`已让 ${u.name} 在 ${r.count} 台设备上下线，并解除锁定`); ed.value = null; load(); }
}
const guideTips = ['先填<b>公司名称</b>和<b>启用日</b>，再给每个人建账号。新账号首次登录必须改密码。', '跟单员只能看分配给自己的供应商，分配在「基础资料 → 供应商」里设置。', '有人离职就<b>停用</b>账号（不要删除，留痕需要）；忘记密码可以重置，重置后会解锁并强制下线。', '列表里能看到每个人最近登录的时间和 IP，发现异常可以「强制下线」。'];
</script>

<template>
  <div><h2>用户与设置</h2><p class="sub">跟单员只能看到分配给自己的供应商；财务负责终审、发票分配和基础资料；管理员另外管理用户。</p></div>
  <PageGuide id="users" anchor="f-users" :tips="guideTips" />
  <div class="grid2">
    <section class="panel">
      <div class="panel-h"><h3>新建用户</h3></div>
      <form class="panel-b form" @submit.prevent="create">
        <label>姓名<input v-model="nu.name" required></label>
        <label>登录用户名（字母数字）<input v-model.trim="nu.username" required pattern="[A-Za-z0-9_.\-]{2,32}" autocapitalize="off"></label>
        <label>角色<select v-model="nu.role"><option v-for="r in ROLES" :key="r">{{ r }}</option></select></label>
        <label>初始密码<span class="row" style="flex-wrap:nowrap"><input v-model="nu.password" required minlength="8" style="flex:1" autocomplete="new-password"><button class="btn sm" type="button" @click="gen">随机生成</button></span></label>
        <p class="full note" style="margin:0">{{ PASSWORD_RULE }}。对方第一次登录时必须改成自己的密码。</p>
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
      <thead><tr><th>姓名</th><th>用户名</th><th>角色</th><th>状态</th><th>最近登录</th><th>在线设备</th><th>创建</th></tr></thead>
      <tbody>
        <tr v-for="u in users" :key="u.id" class="click" @click="openEd(u)">
          <td><b>{{ u.name }}</b></td><td class="mono">{{ u.username }}</td><td>{{ u.role }}</td>
          <td>
            <span class="chip" :class="u.active ? 'c-good' : 'c-mut'">{{ u.active ? '在用' : '停用' }}</span>
            <span v-if="locked(u)" class="chip c-bad" style="margin-left:4px">锁定中</span>
            <span v-if="u.must_change_password" class="chip c-warn" style="margin-left:4px">未改初始密码</span>
          </td>
          <td class="num">{{ dtm(u.last_login_at) }}<div class="note mono">{{ u.last_login_ip }}</div></td>
          <td class="num">{{ u.sessions }}</td>
          <td class="num">{{ dt(u.created_at) }}</td>
        </tr>
      </tbody>
    </table></div>
  </section>
  <Modal :open="!!ed" :title="`修改用户 ${ed?.username || ''}`" @close="ed = null">
    <form v-if="ed" class="form" @submit.prevent="saveEd">
      <label>姓名<input v-model="ed.name" required></label>
      <label>角色<select v-model="ed.role" :disabled="ed.id === state.me.id"><option v-for="r in ROLES" :key="r">{{ r }}</option></select></label>
      <label class="full">重置密码（留空不改；重置后对方会被退出登录，下次登录要改密码）
        <span class="row" style="flex-wrap:nowrap"><input v-model="ed.password" minlength="8" autocomplete="new-password" style="flex:1"><button class="btn sm" type="button" @click="genEd">随机生成</button></span></label>
      <label v-if="ed.id !== state.me.id" class="ctl full" style="display:flex"><input type="checkbox" v-model="ed.active"> 在用（停用后立即退出登录）</label>
      <div class="full row"><button class="btn pri">保存</button><span class="spacer"></span>
        <button v-if="ed.id !== state.me.id" class="btn danger" type="button" @click="kick(ed)">强制下线{{ locked(ed) ? '并解锁' : '' }}</button></div>
    </form>
  </Modal>
</template>
