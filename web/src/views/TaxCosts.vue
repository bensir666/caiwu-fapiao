<script setup>
import { ref, computed, watch, onMounted } from 'vue';
import { api, state, money, dt, attempt, loadMaster, todayStr, BOARDS } from '../api.js';

const master = ref(null);
const list = ref([]);
const reminders = ref([]);
const f = ref({});
const reset = () => { f.value = { supplier_id: '', board: state.board || '', amount: '', paid_at: todayStr(), invoice_number: '', note: '' }; };
reset();
const load = async () => {
  list.value = (await attempt(() => api.get('/api/tax-costs', { board: state.board }))) || [];
  reminders.value = (await attempt(() => api.get('/api/tax-costs/reminders'))) || [];
};
watch(() => state.board, load);
onMounted(async () => { master.value = await attempt(() => loadMaster(true)); load(); });
const suppliers = computed(() => (master.value?.suppliers || []).filter((s) => s.tax_cost || s.id === Number(f.value.supplier_id)));
const allSuppliers = computed(() => master.value?.suppliers || []);
const total = computed(() => Math.round(list.value.reduce((a, t) => a + t.amount, 0) * 100) / 100);
const boardsOf = computed(() => allSuppliers.value.find((s) => s.id === Number(f.value.supplier_id))?.boards.map((b) => b.board) || BOARDS);

function fromReminder(r) {
  f.value = { supplier_id: r.supplier_id, board: r.board, amount: '', paid_at: todayStr(), invoice_number: r.number, note: '' };
  document.getElementById('tc-amount')?.focus();
}
async function skip(r) { if (await attempt(() => api.post(`/api/tax-costs/skip/${r.id}`), '已标记为无需税费') !== undefined) load(); }
async function save() { if (await attempt(() => api.post('/api/tax-costs', f.value), '已登记') !== undefined) { reset(); load(); } }
async function remove(t) { if (confirm(`删除这笔 ${money(t.amount)} 的税费成本？`) && await attempt(() => api.del(`/api/tax-costs/${t.id}`), '已删除') !== undefined) load(); }
</script>

<template>
  <div>
    <h2>税费成本</h2>
    <p class="sub">部分供应商开票时需要我方另付税费，这里单独记支出，不影响欠票。</p>
  </div>
  <div class="grid2">
    <section class="panel">
      <div class="panel-h"><h3>登记一笔</h3></div>
      <form class="panel-b form" @submit.prevent="save">
        <label>供应商
          <select v-model="f.supplier_id" required>
            <option value="" disabled>请选择</option>
            <option v-for="s in suppliers" :key="s.id" :value="s.id">{{ s.name }}</option>
            <optgroup label="其他供应商"><option v-for="s in allSuppliers.filter((x) => !x.tax_cost)" :key="s.id" :value="s.id">{{ s.name }}</option></optgroup>
          </select>
        </label>
        <label>板块<select v-model="f.board" required><option v-for="b in boardsOf" :key="b">{{ b }}</option></select></label>
        <label>金额（元）<input id="tc-amount" v-model="f.amount" type="number" step="0.01" min="0.01" required inputmode="decimal"></label>
        <label>支付日期<input v-model="f.paid_at" type="date" required></label>
        <label>对应发票号码<input v-model.trim="f.invoice_number" placeholder="可留空"></label>
        <label>备注<input v-model="f.note" placeholder="可留空"></label>
        <div class="full"><button class="btn pri">登记</button></div>
      </form>
    </section>
    <section class="panel">
      <div class="panel-h"><h3>待登记</h3><span class="note">需另付税费的供应商新入账的发票</span></div>
      <div class="panel-b pend">
        <div v-for="r in reminders" :key="r.id" class="pend-card">
          <div class="row"><b>{{ r.supplier_name }}</b><span class="chip c-mut">{{ r.board }}</span><span class="spacer"></span><span class="num">{{ money(r.total) }}</span></div>
          <div class="note mono">{{ r.number }} · {{ dt(r.issue_date) }}</div>
          <div class="row"><button class="btn sm pri" @click="fromReminder(r)">登记税费</button><button class="btn sm" @click="skip(r)">这张不需要</button></div>
        </div>
        <div v-if="!reminders.length" class="empty">没有待登记的</div>
      </div>
    </section>
  </div>
  <section class="panel">
    <div class="panel-h"><h3>税费成本明细</h3><span class="note">合计 <b class="num">{{ money(total) }}</b></span><span class="spacer"></span>
      <button class="btn sm" @click="api.download('/api/export/tax-costs', { board: state.board })">导出 Excel</button></div>
    <div class="tbl"><table class="mtbl">
      <thead><tr><th>支付日期</th><th>供应商</th><th>板块</th><th class="r">金额</th><th>对应发票</th><th>备注</th><th>登记人</th><th></th></tr></thead>
      <tbody>
        <tr v-for="t in list" :key="t.id">
          <td class="num lead">{{ t.paid_at }}</td><td data-l="供应商">{{ t.supplier_name }}</td><td data-l="板块">{{ t.board }}</td><td data-l="金额" class="r num">{{ money(t.amount) }}</td>
          <td data-l="对应发票" class="mono">{{ t.invoice_number || '—' }}</td><td data-l="备注">{{ t.note }}</td><td data-l="登记人">{{ t.created_by_name }}</td>
          <td><button class="btn sm danger" @click="remove(t)">删除</button></td>
        </tr>
        <tr v-if="!list.length"><td colspan="8" class="empty">暂无</td></tr>
      </tbody>
    </table></div>
  </section>
</template>
