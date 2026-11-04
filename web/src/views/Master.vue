<script setup>
import { ref, computed, onMounted, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { api, state, money, pct, attempt, toast, loadMaster, BOARDS } from '../api.js';
import { RATES } from '../ui.js';
import Modal from '../components/Modal.vue';

const route = useRoute();
const router = useRouter();
const tab = ref(route.query.tab || 'suppliers');
watch(tab, (t) => router.replace({ query: { tab: t } }));
const m = ref(null);
const users = ref([]);
const load = async () => { m.value = await attempt(() => loadMaster(true)); };
onMounted(async () => { load(); users.value = (await attempt(() => api.get('/api/users'))) || []; });
const owners = computed(() => users.value.filter((u) => u.role === '跟单员' && u.active !== 0));
const supName = (id) => m.value?.suppliers.find((s) => s.id === id)?.name || '?';
const q = ref('');
const match = (...xs) => !q.value || xs.some((x) => String(x || '').toUpperCase().includes(q.value.toUpperCase()));

// ---- suppliers ----
const sup = ref(null);
function editSup(s) {
  sup.value = s
    ? { ...s, tax_cost: !!s.tax_cost, active: !!s.active, owner_id: s.owner_id || '', contact: s.contact || '', note: s.note || '', b: Object.fromEntries(BOARDS.map((b) => [b, s.boards.find((x) => x.board === b)])) }
    : { name: '', rate: 0.13, tax_cost: false, active: true, owner_id: '', contact: '', note: '', b: { 电商: state.board !== '工厂' ? { opening: 0 } : undefined, 工厂: state.board === '工厂' ? { opening: 0 } : undefined } };
  for (const b of BOARDS) sup.value[`on_${b}`] = !!sup.value.b[b];
  for (const b of BOARDS) sup.value[`op_${b}`] = sup.value.b[b]?.opening ?? 0;
}
async function saveSup() {
  const s = sup.value;
  const body = { name: s.name, rate: s.rate, tax_cost: s.tax_cost, owner_id: s.owner_id || null, contact: s.contact, note: s.note, active: s.active,
    boards: BOARDS.filter((b) => s[`on_${b}`]).map((b) => ({ board: b, opening: s[`op_${b}`] || 0 })) };
  const r = await attempt(() => (s.id ? api.patch(`/api/suppliers/${s.id}`, body) : api.post('/api/suppliers', body)), '已保存');
  if (r !== undefined) { sup.value = null; load(); }
}

// ---- entities ----
const ent = ref(null);
const entQ = ref('');
const editEnt = (e) => { ent.value = e ? { ...e, supplier_ids: [...e.supplier_ids], note: e.note || '' } : { name: '', tax_id: '', supplier_ids: [], note: '' }; entQ.value = ''; };
async function saveEnt() {
  const e = ent.value;
  const r = await attempt(() => (e.id ? api.patch(`/api/entities/${e.id}`, e) : api.post('/api/entities', e)), '已保存');
  if (r !== undefined) { ent.value = null; load(); }
}
async function delEnt(e) { if (confirm(`删除开票主体「${e.name}」？以后它开的发票会进入待处理。`) && await attempt(() => api.del(`/api/entities/${e.id}`), '已删除') !== undefined) load(); }

// ---- buyers ----
const buyer = ref(null);
const editBuyer = (b) => { buyer.value = b ? { ...b, active: !!b.active } : { name: '', tax_id: '', board: state.board || '电商', active: true }; };
async function saveBuyer() {
  const b = buyer.value;
  const r = await attempt(() => (b.id ? api.patch(`/api/buyers/${b.id}`, b) : api.post('/api/buyers', b)), '已保存');
  if (r !== undefined) { buyer.value = null; load(); }
}

// ---- opening ----
const opening = ref([]);
watch(() => [m.value, tab.value], () => {
  if (tab.value !== 'opening' || !m.value) return;
  opening.value = m.value.suppliers.flatMap((s) => s.boards.map((b) => ({ supplier_id: s.id, name: s.name, code: s.code, board: b.board, opening: b.opening, orig: b.opening })));
}, { immediate: true });
const openingTotal = (b) => money(opening.value.filter((r) => r.board === b).reduce((a, r) => a + Number(r.opening || 0), 0));
const dirty = computed(() => opening.value.filter((r) => Number(r.opening) !== r.orig));
async function saveOpening() {
  const r = await attempt(() => api.put('/api/opening', { rows: dirty.value.map(({ supplier_id, board, opening: o }) => ({ supplier_id, board, opening: Number(o) || 0 })) }));
  if (r) { toast(`已更新 ${r.updated} 条期初欠票`); load(); }
}

// ---- import ----
const impFile = ref(null);
const impBoard = ref('');
const report = ref(null);
const pending = ref(null);
async function pickImport(ev) {
  const file = ev.target.files[0];
  ev.target.value = '';
  if (!file) return;
  pending.value = file;
  report.value = await attempt(() => api.upload('/api/import/master', file, { dry: 1, board: impBoard.value }));
}
async function doImport() {
  const r = await attempt(() => api.upload('/api/import/master', pending.value, { board: impBoard.value }));
  if (r) { report.value = r; pending.value = null; toast('导入完成'); load(); }
}
</script>

<template>
  <div>
    <h2>基础资料</h2>
    <p class="sub">供应商、开票主体（供应商开票用的公司）、受票主体（我方收票的公司）和期初欠票。</p>
  </div>
  <div class="subtabs">
    <button v-for="[k, l] in [['suppliers', '供应商'], ['entities', '开票主体'], ['buyers', '我方受票主体'], ['opening', '期初欠票'], ['import', '批量导入']]" :key="k" :aria-pressed="tab === k" @click="tab = k">{{ l }}</button>
  </div>
  <template v-if="m">
    <!-- suppliers -->
    <section v-if="tab === 'suppliers'" class="panel">
      <div class="panel-h"><h3>供应商</h3><span class="note">{{ m.suppliers.length }} 家</span><span class="spacer"></span>
        <input v-model="q" placeholder="搜索" style="width:120px"><button class="btn sm pri" @click="editSup()">新增供应商</button></div>
      <div class="tbl"><table>
        <thead><tr><th>编号</th><th>名称</th><th>板块</th><th>默认税率</th><th>另付税费</th><th>跟单员</th><th>开票主体</th><th>状态</th></tr></thead>
        <tbody>
          <tr v-for="s in m.suppliers.filter((s) => match(s.name, s.code))" :key="s.id" class="click" @click="editSup(s)">
            <td class="mono">{{ s.code }}</td><td><b>{{ s.name }}</b></td><td>{{ s.boards.map((b) => b.board).join(' + ') }}</td>
            <td>{{ pct(s.rate) }}</td><td>{{ s.tax_cost ? '是' : '' }}</td><td>{{ s.owner_name || '—' }}</td>
            <td>{{ m.entities.filter((e) => e.supplier_ids.includes(s.id)).length }}</td>
            <td><span class="chip" :class="s.active ? 'c-good' : 'c-mut'">{{ s.active ? '在用' : '停用' }}</span></td>
          </tr>
          <tr v-if="!m.suppliers.length"><td colspan="8" class="empty">还没有供应商。可以逐个新增，也可以用「批量导入」一次导入。</td></tr>
        </tbody>
      </table></div>
    </section>

    <!-- entities -->
    <section v-else-if="tab === 'entities'" class="panel">
      <div class="panel-h"><h3>开票主体</h3><span class="note">按税号识别发票属于哪个供应商</span><span class="spacer"></span>
        <input v-model="q" placeholder="搜索" style="width:120px"><button class="btn sm pri" @click="editEnt()">新增开票主体</button></div>
      <div class="tbl"><table>
        <thead><tr><th>主体全称</th><th>税号</th><th>关联供应商</th><th></th></tr></thead>
        <tbody>
          <tr v-for="e in m.entities.filter((e) => match(e.name, e.tax_id))" :key="e.id">
            <td>{{ e.name }}</td><td class="mono">{{ e.tax_id }}</td>
            <td>{{ e.supplier_ids.map(supName).join('、') }}<span v-if="e.supplier_ids.length > 1" class="chip c-warn" style="margin-left:4px">共用</span></td>
            <td><div class="row" style="flex-wrap:nowrap"><button class="btn sm" @click="editEnt(e)">修改</button><button class="btn sm danger" @click="delEnt(e)">删除</button></div></td>
          </tr>
          <tr v-if="!m.entities.length"><td colspan="4" class="empty">还没有开票主体</td></tr>
        </tbody>
      </table></div>
    </section>

    <!-- buyers -->
    <section v-else-if="tab === 'buyers'" class="panel">
      <div class="panel-h"><h3>我方受票主体</h3><span class="note">发票的购买方税号决定它属于哪个板块</span><span class="spacer"></span>
        <button class="btn sm pri" @click="editBuyer()">新增</button></div>
      <div class="tbl"><table>
        <thead><tr><th>公司名称</th><th>税号</th><th>板块</th><th>状态</th></tr></thead>
        <tbody>
          <tr v-for="b in m.buyers" :key="b.id" class="click" @click="editBuyer(b)">
            <td>{{ b.name }}</td><td class="mono">{{ b.tax_id }}</td><td>{{ b.board }}</td>
            <td><span class="chip" :class="b.active ? 'c-good' : 'c-mut'">{{ b.active ? '在用' : '停用' }}</span></td>
          </tr>
          <tr v-if="!m.buyers.length"><td colspan="4" class="empty">先把我方电商、工厂的收票公司都登记上，否则发票都会进待处理</td></tr>
        </tbody>
      </table></div>
    </section>

    <!-- opening -->
    <section v-else-if="tab === 'opening'" class="panel">
      <div class="panel-h"><h3>期初欠票</h3><span class="note">启用日 {{ state.settings.opening_date }} 之前的历史欠票（含税），电商和工厂分开填</span><span class="spacer"></span>
        <input v-model="q" placeholder="搜索" style="width:120px">
        <button class="btn sm pri" :disabled="!dirty.length" @click="saveOpening">保存{{ dirty.length ? `（${dirty.length} 处修改）` : '' }}</button></div>
      <div class="panel-b note" style="padding-bottom:0">合计：<template v-for="b in BOARDS" :key="b">{{ b }} <b class="num">{{ openingTotal(b) }}</b>　</template></div>
      <div class="tbl"><table>
        <thead><tr><th>编号</th><th>供应商</th><th>板块</th><th class="r">期初欠票（元）</th></tr></thead>
        <tbody>
          <tr v-for="r in opening.filter((r) => match(r.name, r.code))" :key="r.supplier_id + r.board">
            <td class="mono">{{ r.code }}</td><td>{{ r.name }}</td><td>{{ r.board }}</td>
            <td class="r"><input v-model="r.opening" type="number" step="0.01" min="0" inputmode="decimal" style="width:140px;text-align:right" :style="Number(r.opening) !== r.orig ? 'border-color:var(--accent)' : ''"></td>
          </tr>
          <tr v-if="!opening.length"><td colspan="4" class="empty">先新增供应商</td></tr>
        </tbody>
      </table></div>
    </section>

    <!-- import -->
    <section v-else class="panel">
      <div class="panel-h"><h3>批量导入</h3></div>
      <div class="panel-b" style="display:grid;gap:16px">
        <div style="display:grid;gap:6px">
          <b>方式一：供应商资料表（推荐第一次用）</b>
          <span class="note">一次录入供应商、开票主体、跟单员和期初欠票。同一供应商有多个开票主体就写多行。</span>
          <div class="row"><button class="btn sm" @click="api.download('/api/templates/master')">下载供应商资料模板</button></div>
        </div>
        <div style="display:grid;gap:6px">
          <b>方式二：供应商填好的对账单模板</b>
          <span class="note">读取其中的「开票主体」表，按下面选的板块登记。</span>
          <div class="row"><button class="btn sm" @click="api.download('/api/templates/statement')">下载对账单模板</button>
            <label class="ctl">板块 <select v-model="impBoard"><option value="">（用方式一时不用选）</option><option v-for="b in BOARDS" :key="b">{{ b }}</option></select></label></div>
        </div>
        <div class="row"><button class="btn pri" @click="impFile.click()">选择要导入的 Excel</button><input ref="impFile" type="file" accept=".xlsx" hidden @change="pickImport"></div>
        <div v-if="report" class="pend-card" :class="{ bad: report.errors.length }">
          <b>{{ report.dry ? '预检结果（还没有写入）' : '导入结果' }}</b>
          <div>新增供应商 {{ report.suppliers_created }} 家，更新 {{ report.suppliers_updated }} 家；新增开票主体 {{ report.entities_created }} 个，新关联 {{ report.entities_linked }} 个。</div>
          <ul v-if="report.errors.length" style="margin:0;padding-left:18px;color:var(--bad)"><li v-for="(e, i) in report.errors" :key="i">{{ e }}</li></ul>
          <div v-if="report.dry && pending" class="row"><button class="btn pri sm" @click="doImport">确认导入</button><button class="btn sm" @click="report = null; pending = null">取消</button></div>
        </div>
      </div>
    </section>
  </template>

  <Modal :open="!!sup" :title="sup?.id ? `修改供应商 ${sup.code}` : '新增供应商'" @close="sup = null">
    <form v-if="sup" class="form" @submit.prevent="saveSup">
      <label class="full">供应商名称（简称即可）<input v-model="sup.name" required></label>
      <label>默认税率<select v-model.number="sup.rate"><option v-for="r in [...new Set([...RATES, sup.rate])]" :key="r" :value="r">{{ pct(r) }}</option></select></label>
      <label>跟单员<select v-model="sup.owner_id"><option value="">（不指定）</option><option v-for="u in owners" :key="u.id" :value="u.id">{{ u.name }}</option></select></label>
      <label>联系方式<input v-model="sup.contact" placeholder="可留空"></label>
      <label>备注<input v-model="sup.note" placeholder="可留空"></label>
      <label class="ctl full" style="display:flex"><input type="checkbox" v-model="sup.tax_cost"> 开票时我方需要另付税费成本</label>
      <div class="full" style="display:grid;gap:8px">
        <span class="note">供应板块和期初欠票（含税）</span>
        <div v-for="b in BOARDS" :key="b" class="row">
          <label class="ctl" style="width:70px"><input type="checkbox" v-model="sup[`on_${b}`]"> {{ b }}</label>
          <input v-if="sup[`on_${b}`]" v-model="sup[`op_${b}`]" type="number" step="0.01" min="0" placeholder="期初欠票" style="width:160px" inputmode="decimal">
        </div>
      </div>
      <label v-if="sup.id" class="ctl full" style="display:flex"><input type="checkbox" v-model="sup.active"> 在用（停用后不再出现在下拉框里，欠票仍会显示）</label>
      <div class="full"><button class="btn pri">保存</button></div>
    </form>
  </Modal>

  <Modal :open="!!ent" :title="ent?.id ? '修改开票主体' : '新增开票主体'" @close="ent = null">
    <form v-if="ent" class="form" @submit.prevent="saveEnt">
      <label class="full">主体全称<input v-model="ent.name" required></label>
      <label class="full">统一社会信用代码 / 税号<input v-model.trim="ent.tax_id" required autocapitalize="characters"></label>
      <div class="full" style="display:grid;gap:6px">
        <span class="note">属于哪个供应商（可以多选；共用时发票要财务分配）</span>
        <input v-model="entQ" placeholder="筛选供应商">
        <div class="opts" style="max-height:220px;overflow:auto">
          <label v-for="s in m.suppliers.filter((s) => !entQ || s.name.includes(entQ))" :key="s.id"><input type="checkbox" :value="s.id" v-model="ent.supplier_ids"> {{ s.name }}</label>
        </div>
      </div>
      <label class="full">备注<input v-model="ent.note" placeholder="可留空"></label>
      <div class="full"><button class="btn pri">保存</button></div>
    </form>
  </Modal>

  <Modal :open="!!buyer" :title="buyer?.id ? '修改受票主体' : '新增受票主体'" @close="buyer = null">
    <form v-if="buyer" class="form" @submit.prevent="saveBuyer">
      <label class="full">公司全称<input v-model="buyer.name" required></label>
      <label>税号<input v-model.trim="buyer.tax_id" required autocapitalize="characters"></label>
      <label>板块<select v-model="buyer.board"><option v-for="b in BOARDS" :key="b">{{ b }}</option></select></label>
      <label v-if="buyer.id" class="ctl full" style="display:flex"><input type="checkbox" v-model="buyer.active"> 在用</label>
      <div class="full"><button class="btn pri">保存</button></div>
    </form>
  </Modal>
</template>
