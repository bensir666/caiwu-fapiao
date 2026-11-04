<script setup>
import { ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { api, loadMe, state } from '../api.js';

const route = useRoute();
const router = useRouter();
const username = ref('');
const password = ref('');
const err = ref('');
const busy = ref(false);

async function submit() {
  err.value = ''; busy.value = true;
  try {
    await api.post('/api/login', { username: username.value, password: password.value });
    await loadMe();
    router.replace(state.me?.must_change_password ? '/password' : (route.query.next || '/'));
  } catch (e) { err.value = e.message; } finally { busy.value = false; }
}
</script>

<template>
  <div class="login">
    <div class="panel">
      <div class="panel-h"><h2>供应商发票跟踪</h2></div>
      <div class="panel-b">
        <form @submit.prevent="submit">
          <label>用户名<input v-model="username" autocomplete="username" autocapitalize="off" required></label>
          <label>密码<input v-model="password" type="password" autocomplete="current-password" required></label>
          <p v-if="err" class="err" role="alert">{{ err }}</p>
          <button class="btn pri" :disabled="busy">{{ busy ? '登录中…' : '登录' }}</button>
          <p class="note">忘记密码请找管理员重置。</p>
        </form>
      </div>
    </div>
  </div>
</template>
