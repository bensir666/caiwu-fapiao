<script setup>
import { ref } from 'vue';
import { useRouter } from 'vue-router';
import { api, state, toast } from '../api.js';

const router = useRouter();
const f = ref({ old_password: '', new_password: '', again: '' });
const err = ref('');
async function submit() {
  err.value = '';
  if (f.value.new_password !== f.value.again) { err.value = '两次输入的新密码不一样'; return; }
  try {
    await api.post('/api/me/password', f.value);
    state.me.must_change_password = 0;
    toast('密码已修改');
    router.replace('/');
  } catch (e) { err.value = e.message; }
}
</script>

<template>
  <section class="panel" style="max-width:420px">
    <div class="panel-h"><h2>修改密码</h2></div>
    <div class="panel-b">
      <p v-if="state.me?.must_change_password" class="notice" style="margin-top:0">第一次登录，请先设置自己的密码。</p>
      <form class="form" @submit.prevent="submit">
        <label class="full">原密码<input v-model="f.old_password" type="password" autocomplete="current-password" required></label>
        <label class="full">新密码（至少 8 位）<input v-model="f.new_password" type="password" autocomplete="new-password" minlength="8" required></label>
        <label class="full">再输一次<input v-model="f.again" type="password" autocomplete="new-password" required></label>
        <p v-if="err" class="err full" role="alert">{{ err }}</p>
        <div class="full"><button class="btn pri">保存</button></div>
      </form>
    </div>
  </section>
</template>
