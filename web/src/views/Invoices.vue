<script setup>
import { ref, computed, watch, onMounted } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { api, state, money, dt, role, attempt, toast, loadMaster, BOARDS } from '../api.js';
import { INV_CLASS } from '../ui.js';
import Modal from '../components/Modal.vue';
import InvoiceFields from '../components/InvoiceFields.vue';
import Steps from '../components/Steps.vue';

const route = useRoute();
const router = useRouter();
const tab = ref(route.query.tab || 'upload');
watch(tab, (t) => router.replace({ query: { tab: t } }));
const master = ref(null);
onMounted(async () => { master.value = await attempt(() => loadMaster(true)); });
const suppliers = computed(() => (master.value?.suppliers || []).filter((s) => s.active));

// ---------- upload & review ----------
const queue = ref([]); // {file, name, state: 'wait'|'parsing'|'ready'|'done'|'skip'|'error', token, source, fields, preview, error, result}
const cur = ref(-1);
const fileIn = ref(null);
const busy = ref(false);
const emptyFields = () => ({ number: '', issue_date: '', type: '数电专票', seller_name: '', seller_tax_id: '', buyer_name: '', buyer_tax_id: '', net: '', tax: '', total: '', rate: '', remark: '' });

function addFiles(ev) {
  const files = [...(ev.target.files || ev.dataTransfer?.files || [])];
  if (ev.target.value) ev.target.value = '';
  for (const file of files) queue.value.push({ file, name: file.name, state: 'wait' });
  if (cur.value < 0 || ['done', 'skip'].includes(queue.value[cur.value]?.state)) next();
}
function manual() {
  queue.value.push({ name: '手工录入', state: 'ready', fields: emptyFields(), source: 'manual', preview: null, error: null });
  cur.value = queue.value.length - 1;
}
async function next() {
  const i = queue.value.findIndex((x) => x.state === 'wait' || x.state === 'ready');
  cur.value = i;
  if (i < 0) return;
  const it = queue.value[i];
  if (it.state !== 'wait') return;
  it.state = 'parsing';
  try {
    const r = await api.upload('/api/invoices/parse', it.file);
    Object.assign(it, { state: 'ready', token: r.token, source: r.source, fields: { ...emptyFields(), ...(r.fields || {}) }, preview: r.preview, error: r.error });
  } catch (e) {
    Object.assign(it, { state: 'error', error: e.message });
    cur.value = i;
  }
}
const item = computed(() => queue.value[cur.value]);
let pvTimer;
watch(() => item.value?.fields, (f) => {
  if (!f || item.value.state !== 'ready') return;
  clearTimeout(pvTimer);
  pvTimer = setTimeout(async () => { const it = item.value; if (it) it.preview = await api.post('/api/invoices/preview', { fields: f }).catch(() => it.preview); }, 400);
}, { deep: true });

async function confirmInvoice() {
  const it = item.value;
  busy.value = true;
  try {
    const r = await api.post('/api/invoices', { fields: it.fields, token: it.token, source: it.source });
    it.state = 'done'; it.result = r;
    let msg = r.status === '已入账' ? `已入账：${r.supplier_name} · ${r.board}${r.moved ? '（已自动改归该板块）' : ''}` : `已放入待处理：${r.pending_reason}，财务会处理`;
    if (r.tax_cost_reminder) msg += '。这个供应商需要另付税费，记得去「税费成本」登记';
    toast(msg);
    next();
  } catch (e) { toast(e.message); if (e.status === 409) { it.state = 'skip'; it.error = e.message; next(); } } finally { busy.value = false; }
}
function skip() { item.value.state = 'skip'; next(); }
const STATE_TEXT = { wait: '等待', parsing: '识别中…', ready: '待确认', done: '已提交', skip: '已跳过', error: '失败' };

// ---------- lists ----------
const rows = ref([]);
const pick = ref({}); // pending invoice id -> {supplier_id, board, register_entity}
const status = ref('');
const q = ref('');
const loadList = async () => {
  const st = tab.value === 'pending' ? '待处理' : status.value;
  const list = (await attempt(() => api.get('/api/invoices', { status: st, board: tab.value === 'pending' ? '' : state.board, q: q.value }))) || [];
  const p = {};
  for (const i of list) if (i.status === '待处理') p[i.id] = pick.value[i.id] || { supplier_id: i.candidates?.[0]?.id || '', board: i.board || '', register_entity: true };
  pick.value = p;
  rows.value = list;
};
watch(() => [tab.value, status.value, state.board], () => { if (tab.value !== 'upload') loadList(); }, { immediate: true });

// pending resolution
const pickOf = (i) => pick.value[i.id] || {};
const boardsFor = (sid) => suppliers.value.find((s) => s.id === Number(sid))?.boards.map((b) => b.board) || BOARDS;
async function assign(i) {
  const p = pickOf(i);
  if (!p.supplier_id || !p.board) { toast('请选择供应商和板块'); return; }
  if (await attempt(() => api.post(`/api/invoices/${i.id}/assign`, p), '已入账') !== undefined) loadList();
}
async function giveBack(i) {
  const reason = prompt('退回原因（会记录下来）', i.pending_reason || '');
  if (reason === null) return;
  if (await attempt(() => api.post(`/api/invoices/${i.id}/return`, { reason }), '已退回') !== undefined) loadList();
}

// edit / move / delete
const edit = ref(null);
const editFields = ref({});
function openEdit(i) { edit.value = i; editFields.value = { ...emptyFields(), ...Object.fromEntries(Object.keys(emptyFields()).map((k) => [k, i[k] ?? ''])) }; }
async function saveEdit() {
  if (await attempt(() => api.patch(`/api/invoices/${edit.value.id}`, { fields: editFields.value }), '已修改') !== undefined) { edit.value = null; loadList(); }
}
async function move(i) {
  const to = BOARDS.find((b) => b !== i.board);
  if (!confirm(`把发票 ${i.number} 从${i.board}改到${to}？用于跨板块核销。`)) return;
  if (await attempt(() => api.post(`/api/invoices/${i.id}/move`, { board: to }), '已改板块') !== undefined) loadList();
}
async function remove(i) {
  if (!confirm(`删除发票 ${i.number}？只在录错时使用，删除会留痕。`)) return;
  if (await attempt(() => api.del(`/api/invoices/${i.id}`), '已删除') !== undefined) loadList();
}
</script>

<template>
  <div>
    <h2>发票</h2>
    <p class="sub">上传数电发票的 XML 或 PDF，系统读出金额和开票主体，按税号自动归到供应商；认不出的放进待处理由财务分配。</p>
  </div>
  <div class="subtabs">
    <button :aria-pressed="tab === 'upload'" @click="tab = 'upload'">上传发票</button>
    <button v-if="role.fin()" :aria-pressed="tab === 'pending'" @click="tab = 'pending'">待处理<span v-if="state.counts.invoices_pending" class="badge">{{ state.counts.invoices_pending }}</span></button>
    <button :aria-pressed="tab === 'list'" @click="tab = 'list'">{{ role.gd() ? '我负责的发票' : '全部发票' }}</button>
  </div>

  <!-- upload -->
  <div v-if="tab === 'upload'" class="grid2">
    <section class="panel">
      <div class="panel-h"><h3>选择文件</h3></div>
      <div class="panel-b" style="display:grid;gap:12px">
        <div class="drop" @dragover.prevent @drop.prevent="addFiles">
          <div>支持 <b>XML</b>（最准）、<b>PDF</b>，也可以传 OFD 或照片（需手工填写，原件会存档）。可以一次选多张。</div>
          <div class="row">
            <button class="btn pri" @click="fileIn.click()">选择发票文件</button>
            <button class="btn" @click="manual">手工录入</button>
          </div>
          <input ref="fileIn" type="file" multiple accept=".xml,.pdf,.ofd,.jpg,.jpeg,.png,.webp" hidden @change="addFiles">
        </div>
        <div class="queue" v-if="queue.length">
          <div v-for="(x, i) in queue" :key="i" class="it" :aria-current="i === cur">
            <span>{{ x.name }}</span>
            <span class="chip" :class="{ done: 'c-good', skip: 'c-mut', error: 'c-bad', ready: 'c-warn' }[x.state] || 'c-mut'">{{ STATE_TEXT[x.state] }}</span>
            <span v-if="x.result" class="note">{{ x.result.status }}</span>
          </div>
        </div>
      </div>
    </section>
    <section class="panel">
      <div class="panel-h"><h3>核对并入账</h3><span v-if="item" class="note wrap-any">{{ item.name }}</span></div>
      <div class="panel-b" style="display:grid;gap:14px">
        <template v-if="item && item.state === 'ready'">
          <p v-if="item.error" class="notice" style="margin:0">{{ item.error }}</p>
          <p v-else class="note" style="margin:0">已自动识别，请对照原件核对一遍。</p>
          <InvoiceFields v-model="item.fields" />
          <div v-if="item.preview">
            <h3 style="margin-bottom:8px">归属判断
              <span class="chip" :class="item.preview.status === '已入账' ? 'c-good' : item.preview.status === '重复' ? 'c-bad' : 'c-warn'">
                {{ item.preview.status === '已入账' ? `将入账：${item.preview.supplier_name} · ${item.preview.board}` : item.preview.status === '重复' ? '重复发票' : `将进入待处理：${item.preview.pending_reason}` }}
              </span>
            </h3>
            <Steps :steps="item.preview.steps" />
          </div>
          <div class="row">
            <button class="btn pri" :disabled="busy || item.preview?.status === '重复'" @click="confirmInvoice">确认提交</button>
            <button class="btn" @click="skip">跳过这张</button>
          </div>
        </template>
        <p v-else-if="item && item.state === 'parsing'" class="empty">正在识别…</p>
        <template v-else-if="item && item.state === 'error'">
          <p class="notice" style="margin:0">{{ item.error }}</p>
          <div><button class="btn" @click="skip">跳过</button></div>
        </template>
        <p v-else class="empty">{{ queue.length ? '这一批都处理完了' : '选择发票文件后在这里核对' }}</p>
      </div>
    </section>
  </div>

  <!-- pending -->
  <section v-else-if="tab === 'pending'" class="panel">
    <div class="panel-h"><h3>待处理发票</h3><span class="note">{{ rows.length }} 张</span></div>
    <div class="panel-b pend">
      <div v-for="i in rows" :key="i.id" class="pend-card" :class="{ bad: ['购买方不是我方', '金额需核对'].includes(i.pending_reason) }">
        <div class="row"><span class="chip c-warn">{{ i.pending_reason }}</span><b class="mono">{{ i.number }}</b><span class="spacer"></span><b class="num">{{ money(i.total) }}</b></div>
        <dl class="kv">
          <dt>销售方</dt><dd>{{ i.seller_name || '—' }} <span class="mono">{{ i.seller_tax_id }}</span></dd>
          <dt>购买方</dt><dd>{{ i.buyer_name || '—' }} <span class="mono">{{ i.buyer_tax_id }}</span></dd>
          <dt>金额</dt><dd class="num">{{ money(i.net) }} + {{ money(i.tax) }} = {{ money(i.total) }}</dd>
          <dt>上传</dt><dd>{{ i.created_by_name }} · {{ dt(i.created_at) }} <a v-if="i.file_name" :href="`/api/invoices/${i.id}/file`" target="_blank" rel="noopener">看原件</a></dd>
        </dl>
        <div v-if="i.candidates?.length" class="opts">
          <div class="note">这个开票主体由多个供应商共用，选一个：</div>
          <label v-for="c in i.candidates" :key="c.id"><input type="radio" :value="c.id" v-model="pick[i.id].supplier_id"> {{ c.name }} <span class="note num">本板块欠票 {{ money(c.owe) }}</span></label>
        </div>
        <div class="row">
          <select v-model="pick[i.id].supplier_id" @change="!boardsFor(pick[i.id].supplier_id).includes(pick[i.id].board) && (pick[i.id].board = boardsFor(pick[i.id].supplier_id)[0])">
            <option value="" disabled>选择供应商</option>
            <option v-for="s in suppliers" :key="s.id" :value="s.id">{{ s.name }}</option>
          </select>
          <select v-model="pick[i.id].board"><option value="" disabled>板块</option><option v-for="b in BOARDS" :key="b">{{ b }}</option></select>
          <label v-if="i.pending_reason === '开票主体未登记'" class="ctl"><input type="checkbox" v-model="pick[i.id].register_entity"> 同时登记这个开票主体</label>
        </div>
        <div class="row">
          <button class="btn pri sm" @click="assign(i)">分配并入账</button>
          <button class="btn sm" @click="openEdit(i)">修改信息</button>
          <button class="btn sm danger" @click="giveBack(i)">退回供应商</button>
        </div>
      </div>
      <div v-if="!rows.length" class="empty">没有待处理的发票</div>
    </div>
  </section>

  <!-- list -->
  <section v-else class="panel">
    <div class="panel-h">
      <div class="subtabs"><button v-for="s in ['', '已入账', '待处理', '已退回']" :key="s" :aria-pressed="status === s" @click="status = s">{{ s || '全部' }}</button></div>
      <span class="spacer"></span>
      <input v-model="q" placeholder="发票号/销售方" style="width:150px" @keyup.enter="loadList">
      <button class="btn sm" @click="loadList">搜索</button>
      <button v-if="role.fin()" class="btn sm" @click="api.download('/api/export/invoices', { board: state.board, status })">导出 Excel</button>
    </div>
    <div class="tbl"><table class="mtbl">
      <thead><tr><th>发票号码</th><th>日期</th><th>销售方</th><th>归属供应商</th><th>板块</th><th class="r">价税合计</th><th>状态</th><th></th></tr></thead>
      <tbody>
        <tr v-for="i in rows" :key="i.id">
          <td class="mono lead">{{ i.number }}<span v-if="i.total < 0" class="chip c-bad" style="margin-left:4px">红字</span><span v-if="i.moved" class="chip c-acc" style="margin-left:4px">跨板块</span></td>
          <td data-l="日期" class="num">{{ dt(i.issue_date) }}</td><td data-l="销售方">{{ i.seller_name }}</td><td data-l="供应商">{{ i.supplier_name || '—' }}</td><td data-l="板块">{{ i.board || '—' }}</td>
          <td data-l="价税合计" class="r num">{{ money(i.total) }}</td>
          <td data-l="状态"><span class="chip" :class="INV_CLASS[i.status]">{{ i.status }}</span><div v-if="i.status !== '已入账'" class="note">{{ i.pending_reason }}</div></td>
          <td><div class="row">
            <a v-if="i.file_name" class="btn sm" :href="`/api/invoices/${i.id}/file`" target="_blank" rel="noopener">原件</a>
            <template v-if="role.fin()">
              <button v-if="i.status === '已入账'" class="btn sm" @click="move(i)">改板块</button>
              <button class="btn sm" @click="openEdit(i)">修改</button>
              <button class="btn sm danger" @click="remove(i)">删除</button>
            </template>
          </div></td>
        </tr>
        <tr v-if="!rows.length"><td colspan="8" class="empty">没有发票</td></tr>
      </tbody>
    </table></div>
  </section>

  <Modal :open="!!edit" :title="`修改发票 ${edit?.number || ''}`" @close="edit = null">
    <InvoiceFields v-model="editFields" />
    <p class="note" style="margin:0">只改识别错的字段。改了税号不会自动重新归属，待处理的发票改完后再分配。</p>
    <div class="row"><button class="btn pri" @click="saveEdit">保存</button></div>
  </Modal>
</template>
