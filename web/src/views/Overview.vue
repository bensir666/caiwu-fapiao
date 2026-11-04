<script setup>
import { ref, watch, computed } from 'vue';
import { useRouter } from 'vue-router';
import { api, state, money, role, attempt } from '../api.js';
import { ageChip } from '../ui.js';
import Aging from '../components/Aging.vue';

const router = useRouter();
const data = ref(null);
const q = ref('');
const onlyOwe = ref(true);
const load = async () => { data.value = await attempt(() => api.get('/api/overview', { board: state.board })); };
watch(() => state.board, load, { immediate: true });

const rows = computed(() => (data.value?.rows || []).filter((r) => (!onlyOwe.value || Math.abs(r.owe) > 0.004)
  && (!q.value || r.name.includes(q.value) || r.code.includes(q.value.toUpperCase()))));
const prog = (r) => (r.should > 0 ? Math.max(0, Math.min(100, Math.round((r.done / r.should) * 100))) : 100);
const open = (r) => router.push({ name: 'supplier', params: { id: r.id }, query: { board: r.board } });
</script>

<template>
  <div>
    <h2>欠票总览</h2>
    <p class="sub">截至 {{ data?.asOf }} · {{ state.board || '电商 + 工厂' }}<template v-if="role.gd()"> · 只显示你负责的供应商</template> · 金额均为价税合计</p>
  </div>
  <template v-if="data">
    <div class="kpis">
      <div class="kpi"><div class="lb">应开票额</div><div class="v">{{ money(data.totals.should) }}</div></div>
      <div class="kpi"><div class="lb">已开票额</div><div class="v">{{ money(data.totals.done) }}</div></div>
      <div class="kpi hot"><div class="lb">欠票额</div><div class="v">{{ money(data.totals.owe) }}</div></div>
      <div class="kpi" v-if="role.fin()">
        <div class="lb">待处理</div>
        <div class="v" style="font-size:15px;display:grid;gap:2px">
          <router-link to="/invoices?tab=pending">发票 {{ data.counts.invoices_pending }} 张</router-link>
          <router-link to="/statements?status=待终审">待终审 {{ data.counts.statements_pending }} 张</router-link>
        </div>
      </div>
      <div class="kpi" v-else>
        <div class="lb">需要你处理</div>
        <div class="v" style="font-size:15px;display:grid;gap:2px">
          <router-link to="/statements?status=已驳回">被驳回 {{ data.counts.statements_rejected }} 张</router-link>
          <router-link to="/statements?status=草稿">草稿 {{ data.counts.statements_draft }} 张</router-link>
        </div>
      </div>
    </div>
    <section class="panel">
      <div class="panel-h"><h3>欠票账龄</h3><span class="note">按对账单终审日起算，先开的票先抵最早的单</span></div>
      <div class="panel-b"><Aging :buckets="data.totals.buckets" /></div>
    </section>
    <section class="panel">
      <div class="panel-h">
        <h3>供应商欠票</h3><span class="note">点一行看明细</span><span class="spacer"></span>
        <input v-model="q" placeholder="搜索供应商" style="width:140px">
        <label class="ctl"><input type="checkbox" v-model="onlyOwe"> 只看有差额的</label>
        <button class="btn sm" @click="api.download('/api/export/overview', { board: state.board })">导出 Excel</button>
      </div>
      <div class="tbl">
        <table class="ovw">
          <thead><tr><th>供应商</th><th>板块</th><th class="r">应开</th><th class="r">已开</th><th class="r">欠票</th><th>进度</th><th>状态</th></tr></thead>
          <tbody>
            <tr v-for="r in rows" :key="r.id + r.board" class="click" @click="open(r)">
              <td class="c-name"><b>{{ r.name }}</b><div class="note">{{ r.code }} · {{ r.board }}<template v-if="r.owner_name"> · {{ r.owner_name }}</template><template v-if="r.tax_cost"> · 另付税费</template></div></td>
              <td class="c-board" style="white-space:nowrap">{{ r.board }}</td>
              <td class="r num c-amt" data-l="应开">{{ money(r.should) }}</td>
              <td class="r num c-amt" data-l="已开">{{ money(r.done) }}</td>
              <td class="r num c-amt c-owe" data-l="欠票"><b>{{ money(r.owe) }}</b></td>
              <td class="c-prog"><div class="prog" :class="{ full: prog(r) >= 100 }"><i :style="{ width: prog(r) + '%' }"></i></div><div class="note num">{{ prog(r) }}%</div></td>
              <td class="c-state"><span class="chip" :class="ageChip(r.oldest, r.owe).cls">{{ ageChip(r.oldest, r.owe).text }}</span></td>
            </tr>
            <tr v-if="!rows.length"><td colspan="7" class="empty">{{ data.rows.length ? '没有符合条件的供应商' : (role.fin() ? '还没有供应商，先去「基础资料」录入或导入' : '还没有分配给你的供应商') }}</td></tr>
          </tbody>
        </table>
      </div>
    </section>
  </template>
</template>
