<script setup>
import PageGuide from '../components/PageGuide.vue';
import { ref, computed, watch, onMounted } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { api, state, money, pct, dt, role, attempt, toast, loadMaster, BOARDS } from '../api.js';
import { ST_CLASS, RATES } from '../ui.js';
import Modal from '../components/Modal.vue';

const route = useRoute();
const router = useRouter();
const list = ref([]);
const master = ref(null);
const status = ref(route.query.status || '');
const q = ref('');

const load = async () => { list.value = (await attempt(() => api.get('/api/statements', { board: state.board, status: status.value }))) || []; };
watch(() => [state.board, status.value], () => { router.replace({ query: status.value ? { status: status.value } : {} }); load(); });
onMounted(async () => { master.value = await attempt(() => loadMaster(true)); load(); });

const shown = computed(() => list.value.filter((s) => s.status !== '已作废' || status.value === '已作废')
  .filter((s) => !q.value || s.supplier_name.includes(q.value) || s.code.includes(q.value.toUpperCase())));
const suppliers = computed(() => (master.value?.suppliers || []).filter((s) => s.active));
const supById = (id) => master.value?.suppliers.find((s) => s.id === Number(id));
const canEdit = (s) => ['草稿', '已驳回'].includes(s.status);

// ---- form ----
const open = ref(false);
const editing = ref(null);
const f = ref({});
const busy = ref(false);
const blank = () => ({ kind: '对账单', parent_id: '', supplier_id: '', board: state.board || '', period_from: '', period_to: '', mode: '含税', rate: 0.13, amount: '', tax_cost: '', supplier_ref: '', note: '' });
function newForm(extra = {}) {
  editing.value = null;
  f.value = { ...blank(), ...extra };
  if (f.value.supplier_id) onSupplier(false);
  open.value = true;
}
function editForm(s) {
  editing.value = s;
  f.value = { ...blank(), ...s, tax_cost: s.tax_cost ?? '', supplier_ref: s.supplier_ref || '', note: s.note || '', period_from: s.period_from || '', period_to: s.period_to || '' };
  open.value = true;
}
function onSupplier(setRate = true) {
  const s = supById(f.value.supplier_id);
  if (!s) return;
  const bs = s.boards.map((b) => b.board);
  if (!bs.includes(f.value.board)) f.value.board = bs[0];
  if (setRate) f.value.rate = s.rate;
}
const boardsOf = computed(() => supById(f.value.supplier_id)?.boards.map((b) => b.board) || BOARDS);
const parents = computed(() => list.value.filter((s) => s.status === '已生效' && s.kind === '对账单' && s.supplier_id === Number(f.value.supplier_id) && s.board === f.value.board));
const rateOptions = computed(() => [...new Set([...RATES, Number(f.value.rate)])].filter((r) => Number.isFinite(r)).sort((a, b) => b - a));
const calc = computed(() => {
  const a = Number(f.value.amount), r = Number(f.value.rate);
  if (!a) return null;
  const r2 = (n) => Math.round(n * 100) / 100;
  if (f.value.mode === '含税') { const net = r2(a / (1 + r)); return { net, tax: r2(a - net), gross: a }; }
  const tax = r2(a * r); return { net: a, tax, gross: r2(a + tax) };
});
async function save(submit) {
  busy.value = true;
  try {
    const body = { ...f.value, submit };
    if (editing.value) {
      await api.patch(`/api/statements/${editing.value.id}`, body);
      if (submit) await api.post(`/api/statements/${editing.value.id}/submit`);
      toast(submit ? '已提交，等待财务终审' : '已保存');
    } else {
      const r = await api.post('/api/statements', body);
      toast(submit ? `${r.code} 已提交，等待财务终审` : `${r.code} 已存为草稿`);
    }
    open.value = false;
    load();
  } catch (e) { toast(e.message); } finally { busy.value = false; }
}
const fileIn = ref(null);
async function importXlsx(ev) {
  const file = ev.target.files[0];
  ev.target.value = '';
  if (!file) return;
  const r = await attempt(() => api.upload('/api/statements/parse-xlsx', file));
  if (!r) return;
  if (!open.value) newForm();
  const x = f.value;
  if (r.supplier_id) { x.supplier_id = r.supplier_id; onSupplier(); }
  if (r.board && (!r.supplier_id || boardsOf.value.includes(r.board))) x.board = r.board;
  for (const k of ['period_from', 'period_to', 'mode', 'supplier_ref']) if (r[k]) x[k] = r[k];
  if (r.rate != null) x.rate = r.rate;
  if (r.amount) x.amount = r.amount;
  if (r.tax_cost) x.tax_cost = r.tax_cost;
  toast(`读到 ${r.lines} 行明细，合计 ${money(r.amount)}${r.supplier_id ? '' : '；没认出供应商「' + (r.supplier_name || '') + '」，请手动选择'}`);
}

// ---- actions ----
const act = async (s, action, body, msg) => { if (await attempt(() => api.post(`/api/statements/${s.id}/${action}`, body), msg) !== undefined) load(); };
const rejecting = ref(null);
const reason = ref('');
async function doReject() {
  if (!reason.value.trim()) { toast('请填写驳回原因'); return; }
  await act(rejecting.value, 'reject', { reason: reason.value }, '已驳回');
  rejecting.value = null; reason.value = '';
}
function doVoid(s) { if (confirm(`确定作废 ${s.code}？作废后不能恢复。`)) act(s, 'void', {}, '已作废'); }
function doApprove(s) { if (confirm(`终审通过 ${s.code}？\n${s.supplier_name} · ${s.board} · 计入应开 ${money(s.gross)}`)) act(s, 'approve', {}, '终审通过，已计入应开票额'); }
const guideTips = ['跟单员点「新建对账单」，选供应商和板块，填金额（可选含税或不含税）。也可以导入供应商填好的 Excel 模板。', '保存后是<b>草稿</b>，自己复核无误再点「提交终审」。', '财务在「待终审」里逐张核对，<b>终审通过</b>后才计入应开票额；驳回的单回到跟单员手里修改再提交。', '已生效的单不能改。要冲减就新建一张<b>调整单</b>，金额填负数。'];
</script>

<template>
  <div>
    <h2>对账单</h2>
    <p class="sub">跟单员创建并自行复核提交，财务一级终审。终审通过后才计入应开票额；已生效的单据要冲减请开调整单。</p>
  </div>
  <PageGuide id="statements" anchor="f-statements" :tips="guideTips" />
  <section class="panel">
    <div class="panel-h">
      <div class="subtabs">
        <button v-for="s in ['', '草稿', '待终审', '已驳回', '已生效', '已作废']" :key="s" :aria-pressed="status === s" @click="status = s">{{ s || '全部' }}</button>
      </div>
      <span class="spacer"></span>
      <input v-model="q" placeholder="搜索单号/供应商" style="width:150px">
    </div>
    <div class="panel-b toolbar" style="border-bottom:1px solid var(--line)">
      <button class="btn pri" @click="newForm()">新建对账单</button>
      <button class="btn" @click="fileIn.click()">导入供应商填的 Excel</button>
      <input ref="fileIn" type="file" accept=".xlsx" hidden @change="importXlsx">
      <span class="spacer"></span>
      <button class="btn sm" @click="api.download('/api/templates/statement')">下载对账单模板</button>
    </div>
    <div class="tbl"><table class="mtbl">
      <thead><tr><th>单号</th><th>供应商</th><th>板块</th><th>期间</th><th>口径</th><th class="r">对账金额</th><th class="r">应开（含税）</th><th>状态</th><th>创建人</th><th></th></tr></thead>
      <tbody>
        <tr v-for="s in shown" :key="s.id">
          <td class="mono lead">{{ s.code }}<span v-if="s.kind === '调整单'" class="chip c-acc" style="margin-left:4px">调整</span></td>
          <td data-l="供应商">{{ s.supplier_name }}</td><td data-l="板块">{{ s.board }}</td>
          <td data-l="期间" class="num">{{ dt(s.period_from) }} ~ {{ dt(s.period_to) }}</td>
          <td data-l="口径">{{ s.mode }} {{ pct(s.rate) }}</td>
          <td data-l="对账金额" class="r num">{{ money(s.amount) }}</td><td data-l="应开（含税）" class="r num"><b>{{ money(s.gross) }}</b></td>
          <td data-l="状态"><span class="chip" :class="ST_CLASS[s.status]">{{ s.status }}</span><div v-if="s.status === '已驳回'" class="note" style="white-space:normal;max-width:220px">{{ s.reject_reason }}</div></td>
          <td data-l="创建人">{{ s.created_by_name }}<div v-if="s.approved_by_name" class="note">终审 {{ s.approved_by_name }}</div></td>
          <td>
            <div class="row">
              <template v-if="canEdit(s)">
                <button class="btn sm" @click="editForm(s)">修改</button>
                <button class="btn sm pri" @click="act(s, 'submit', {}, '已提交，等待财务终审')">提交终审</button>
                <button class="btn sm danger" @click="doVoid(s)">作废</button>
              </template>
              <template v-if="s.status === '待终审' && role.fin()">
                <button class="btn sm pri" @click="doApprove(s)">通过</button>
                <button class="btn sm danger" @click="rejecting = s">驳回</button>
              </template>
              <button v-if="s.status === '已生效' && s.kind === '对账单'" class="btn sm" @click="newForm({ kind: '调整单', supplier_id: s.supplier_id, board: s.board, parent_id: s.id, mode: s.mode, rate: s.rate })">调整单</button>
            </div>
          </td>
        </tr>
        <tr v-if="!shown.length"><td colspan="10" class="empty">没有对账单</td></tr>
      </tbody>
    </table></div>
  </section>

  <Modal :open="open" :title="editing ? `修改 ${editing.code}` : (f.kind === '调整单' ? '新建调整单' : '新建对账单')" @close="open = false">
    <form class="form" @submit.prevent="save(true)">
      <p v-if="editing?.status === '已驳回'" class="notice full" style="margin:0">驳回原因：{{ editing.reject_reason }}</p>
      <label>供应商
        <select v-model="f.supplier_id" required :disabled="!!editing || f.kind === '调整单'" @change="onSupplier()">
          <option value="" disabled>请选择</option>
          <option v-for="s in suppliers" :key="s.id" :value="s.id">{{ s.name }}</option>
        </select>
      </label>
      <label>板块
        <select v-model="f.board" required :disabled="f.kind === '调整单'"><option v-for="b in boardsOf" :key="b">{{ b }}</option></select>
      </label>
      <label v-if="f.kind === '调整单'" class="full">关联的原对账单
        <select v-model="f.parent_id" required :disabled="!!editing">
          <option v-for="p in parents" :key="p.id" :value="p.id">{{ p.code }} · {{ money(p.gross) }}</option>
        </select>
      </label>
      <label>期间开始<input v-model="f.period_from" type="date"></label>
      <label>期间结束<input v-model="f.period_to" type="date"></label>
      <label>金额口径<select v-model="f.mode"><option>含税</option><option>不含税</option></select></label>
      <label>税率<select v-model.number="f.rate"><option v-for="r in rateOptions" :key="r" :value="r">{{ pct(r) }}</option></select></label>
      <label>{{ f.kind === '调整单' ? '调整金额（冲减填负数）' : '对账金额（元）' }}<input v-model="f.amount" type="number" step="0.01" required inputmode="decimal"></label>
      <label>另付税费成本（如有）<input v-model="f.tax_cost" type="number" step="0.01" min="0" placeholder="可留空" inputmode="decimal"></label>
      <label>供应商单号<input v-model="f.supplier_ref" placeholder="可留空"></label>
      <label>备注<input v-model="f.note" placeholder="可留空"></label>
      <div class="full note">
        <template v-if="calc">不含税 <span class="num">{{ money(calc.net) }}</span> · 税额 <span class="num">{{ money(calc.tax) }}</span> · 计入应开 <b class="num">{{ money(calc.gross) }}</b></template>
        <template v-else>填写金额后显示换算</template>
      </div>
      <div class="full row">
        <button class="btn" type="button" :disabled="busy" @click="save(false)">存为草稿</button>
        <button class="btn pri" type="submit" :disabled="busy">复核无误，提交终审</button>
        <span class="spacer"></span>
        <button v-if="!editing" class="btn sm" type="button" @click="fileIn.click()">从 Excel 填入</button>
      </div>
    </form>
  </Modal>

  <Modal :open="!!rejecting" :title="`驳回 ${rejecting?.code || ''}`" @close="rejecting = null">
    <form class="form" @submit.prevent="doReject">
      <label class="full">驳回原因（跟单员会看到）<textarea v-model="reason" rows="3" required></textarea></label>
      <div class="full"><button class="btn danger">确认驳回</button></div>
    </form>
  </Modal>
</template>
