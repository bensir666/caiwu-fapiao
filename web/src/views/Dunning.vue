<script setup>
import { ref, watch, computed } from 'vue';
import { api, state, money, attempt, copyText } from '../api.js';

const rows = ref(null);
const min = ref('');
const load = async () => { rows.value = await attempt(() => api.get('/api/dunning', { board: state.board, min: min.value })); };
watch(() => state.board, load, { immediate: true });
const all = computed(() => (rows.value || []).map((r) => r.text).join('\n\n'));
</script>

<template>
  <div>
    <h2>催票清单</h2>
    <p class="sub">所有还欠票的供应商，每条都配好了可以直接发送的话术。</p>
  </div>
  <section class="panel">
    <div class="panel-h">
      <span class="ctl">欠票不少于 <input v-model="min" type="number" min="0" step="100" style="width:110px" @change="load"> 元</span>
      <span class="spacer"></span>
      <button class="btn sm" :disabled="!rows?.length" @click="copyText(all)">全部复制</button>
    </div>
    <div class="panel-b pend">
      <div v-for="r in rows" :key="r.supplier_id + r.board" class="pend-card" :class="{ bad: r.oldest > 90 }">
        <div class="row">
          <b><router-link :to="{ name: 'supplier', params: { id: r.supplier_id }, query: { board: r.board } }">{{ r.name }}</router-link></b>
          <span class="chip c-mut">{{ r.board }}</span>
          <span class="note" v-if="r.owner_name">{{ r.owner_name }}</span>
          <span class="spacer"></span>
          <b class="num">{{ money(r.owe) }}</b>
        </div>
        <div class="dunning">{{ r.text }}</div>
        <div><button class="btn sm" @click="copyText(r.text)">复制</button></div>
      </div>
      <div v-if="rows && !rows.length" class="empty">没有欠票的供应商</div>
    </div>
  </section>
</template>
