<script setup>
import PageGuide from '../components/PageGuide.vue';
import { ref, watch, computed } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { api, money, pct, dt, role, attempt, copyText } from '../api.js';
import { ST_CLASS, INV_CLASS } from '../ui.js';
import Aging from '../components/Aging.vue';

const props = defineProps({ id: String });
const route = useRoute();
const router = useRouter();
const board = computed(() => route.query.board || '');
const d = ref(null);
const load = async () => { d.value = await attempt(() => api.get(`/api/suppliers/${props.id}/detail`, { board: board.value })); };
watch(board, load, { immediate: true });
const setBoard = (b) => router.replace({ query: b ? { board: b } : {} });
const guideTips = ['上方是这家供应商在各板块的应开、已开、欠票和账龄。', '下面分别列出对账单、发票和税费成本，点发票能看原件。', '催票话术也在这里，可以直接复制。'];
</script>

<template>
  <template v-if="d">
    <div>
      <p class="sub" style="margin:0 0 4px"><router-link to="/">← 欠票总览</router-link></p>
      <h2>{{ d.supplier.name }}</h2>
      <p class="sub">{{ d.supplier.code }} · 默认税率 {{ pct(d.supplier.rate) }}<template v-if="d.supplier.owner_name"> · 跟单员 {{ d.supplier.owner_name }}</template><template v-if="d.supplier.tax_cost"> · 需另付税费成本</template><template v-if="d.supplier.contact"> · {{ d.supplier.contact }}</template></p>
    </div>
    <PageGuide id="supplier" anchor="f-supplier" :tips="guideTips" />
    <div class="subtabs" v-if="d.boards.length > 1">
      <button :aria-pressed="!board" @click="setBoard('')">全部板块</button>
      <button v-for="b in d.boards" :key="b" :aria-pressed="board === b" @click="setBoard(b)">{{ b }}</button>
    </div>
    <section v-for="l in d.ledgers" :key="l.board" class="panel">
      <div class="panel-h"><h3>{{ l.board }}板块</h3><span class="note">截至 {{ d.asOf }}</span></div>
      <div class="panel-b" style="display:grid;gap:14px">
        <div class="kpis" style="grid-template-columns:repeat(3,minmax(0,1fr))">
          <div class="kpi"><div class="lb">应开（含期初 {{ money(l.opening) }}）</div><div class="v">{{ money(l.should) }}</div></div>
          <div class="kpi"><div class="lb">已开</div><div class="v">{{ money(l.done) }}</div></div>
          <div class="kpi" :class="{ hot: l.owe > 0.004 }"><div class="lb">{{ l.owe < -0.004 ? '多开' : '欠票' }}</div><div class="v">{{ money(Math.abs(l.owe)) }}</div></div>
        </div>
        <Aging :buckets="l.buckets" />
      </div>
    </section>
    <section class="panel" v-if="d.dunning.length">
      <div class="panel-h"><h3>催票话术</h3><span class="note">复制后直接发给供应商</span></div>
      <div class="panel-b" style="display:grid;gap:10px">
        <div v-for="(t, i) in d.dunning" :key="i" style="display:grid;gap:6px">
          <div class="dunning">{{ t }}</div>
          <div><button class="btn sm" @click="copyText(t)">复制</button></div>
        </div>
      </div>
    </section>
    <section class="panel">
      <div class="panel-h"><h3>开票主体</h3><span class="note">{{ d.entities.length }} 个</span></div>
      <div class="tbl"><table>
        <thead><tr><th>主体全称</th><th>税号</th></tr></thead>
        <tbody>
          <tr v-for="e in d.entities" :key="e.id"><td>{{ e.name }}</td><td class="mono">{{ e.tax_id }}</td></tr>
          <tr v-if="!d.entities.length"><td colspan="2" class="empty">还没有登记开票主体</td></tr>
        </tbody>
      </table></div>
    </section>
    <section class="panel">
      <div class="panel-h"><h3>对账单</h3><span class="note">{{ d.statements.length }} 张</span></div>
      <div class="tbl"><table>
        <thead><tr><th>单号</th><th>板块</th><th>期间</th><th>口径</th><th class="r">应开（含税）</th><th>状态</th><th>终审日</th></tr></thead>
        <tbody>
          <tr v-for="s in d.statements" :key="s.id">
            <td class="mono">{{ s.code }}<span v-if="s.kind === '调整单'" class="chip c-acc" style="margin-left:4px">调整</span></td>
            <td>{{ s.board }}</td><td class="num">{{ dt(s.period_from) }} ~ {{ dt(s.period_to) }}</td>
            <td>{{ s.mode }} {{ pct(s.rate) }}</td><td class="r num">{{ money(s.gross) }}</td>
            <td><span class="chip" :class="ST_CLASS[s.status]">{{ s.status }}</span></td><td class="num">{{ dt(s.approved_at) }}</td>
          </tr>
          <tr v-if="!d.statements.length"><td colspan="7" class="empty">暂无</td></tr>
        </tbody>
      </table></div>
    </section>
    <section class="panel">
      <div class="panel-h"><h3>发票</h3><span class="note">{{ d.invoices.length }} 张</span></div>
      <div class="tbl"><table>
        <thead><tr><th>发票号码</th><th>日期</th><th>开票主体</th><th>板块</th><th class="r">价税合计</th><th>状态</th><th></th></tr></thead>
        <tbody>
          <tr v-for="i in d.invoices" :key="i.id">
            <td class="mono">{{ i.number }}<span v-if="i.total < 0" class="chip c-bad" style="margin-left:4px">红字</span><span v-if="i.moved" class="chip c-acc" style="margin-left:4px">跨板块</span></td>
            <td class="num">{{ dt(i.issue_date) }}</td><td>{{ i.seller_name }}</td><td>{{ i.board }}</td>
            <td class="r num">{{ money(i.total) }}</td><td><span class="chip" :class="INV_CLASS[i.status]">{{ i.status }}</span></td>
            <td><a v-if="i.file_name" :href="`/api/invoices/${i.id}/file`" target="_blank" rel="noopener">原件</a></td>
          </tr>
          <tr v-if="!d.invoices.length"><td colspan="7" class="empty">暂无</td></tr>
        </tbody>
      </table></div>
    </section>
    <section class="panel" v-if="role.fin()">
      <div class="panel-h"><h3>税费成本</h3><span class="note">合计 {{ money(d.tax_cost_total) }}，不影响欠票</span></div>
      <div class="tbl"><table>
        <thead><tr><th>支付日期</th><th>板块</th><th class="r">金额</th><th>对应发票</th><th>备注</th></tr></thead>
        <tbody>
          <tr v-for="t in d.tax_costs" :key="t.id"><td class="num">{{ t.paid_at }}</td><td>{{ t.board }}</td><td class="r num">{{ money(t.amount) }}</td><td class="mono">{{ t.invoice_number || '—' }}</td><td>{{ t.note }}</td></tr>
          <tr v-if="!d.tax_costs.length"><td colspan="5" class="empty">暂无</td></tr>
        </tbody>
      </table></div>
    </section>
  </template>
</template>
