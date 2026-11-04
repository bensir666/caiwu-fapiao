<script setup>
import { ref, watch } from 'vue';
import { api, dtm, attempt } from '../api.js';

const TARGETS = { '': '全部', statement: '对账单', invoice: '发票', tax_cost: '税费成本', supplier: '供应商', entity: '开票主体', buyer: '受票主体', opening: '期初欠票', import: '导入', user: '用户', settings: '设置' };
const target = ref('');
const rows = ref([]);
const open = ref(null);
const load = async () => { rows.value = (await attempt(() => api.get('/api/audit', { target: target.value, limit: 500 }))) || []; };
watch(target, load, { immediate: true });
</script>

<template>
  <div><h2>操作记录</h2><p class="sub">所有创建、修改、终审、入账、删除都会留痕，最近 500 条。</p></div>
  <section class="panel">
    <div class="panel-h"><div class="subtabs"><button v-for="(l, k) in TARGETS" :key="k" :aria-pressed="target === k" @click="target = k">{{ l }}</button></div></div>
    <div class="tbl"><table>
      <thead><tr><th>时间（UTC）</th><th>操作人</th><th>对象</th><th>操作</th><th>详情</th></tr></thead>
      <tbody>
        <tr v-for="a in rows" :key="a.id">
          <td class="num">{{ dtm(a.created_at) }}</td><td>{{ a.user_name || '—' }}</td><td>{{ TARGETS[a.target] || a.target }} <span class="note mono">#{{ a.target_id }}</span></td><td>{{ a.action }}</td>
          <td><button v-if="a.detail" class="linkbtn" @click="open = open === a.id ? null : a.id">{{ open === a.id ? '收起' : '查看' }}</button>
            <pre v-if="open === a.id" class="mono" style="white-space:pre-wrap;max-width:420px;margin:6px 0 0">{{ JSON.stringify(a.detail, null, 2) }}</pre></td>
        </tr>
        <tr v-if="!rows.length"><td colspan="5" class="empty">暂无记录</td></tr>
      </tbody>
    </table></div>
  </section>
</template>
