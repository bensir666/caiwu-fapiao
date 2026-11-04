<script setup>
import { ref, computed, onMounted } from 'vue';
import { api, role } from '../api.js';

/** First-run checklist on the home page for finance and admin. Hides itself once everything is done. */
const s = ref(null);
const KEY = 'setup-guide-hidden';
const hidden = ref((() => { try { return localStorage.getItem(KEY) === '1'; } catch { return false; } })());
const hide = () => { hidden.value = true; try { localStorage.setItem(KEY, '1'); } catch { /* ignore */ } };
onMounted(async () => { try { s.value = await api.get('/api/setup-status'); } catch { /* not allowed or offline */ } });

const steps = computed(() => {
  const x = s.value;
  if (!x) return [];
  const missingBoard = ['电商', '工厂'].filter((b) => !x.buyer_boards.includes(b));
  const list = [
    { done: x.company && x.opening_date, title: '填写公司名称和启用日', hint: '启用日用来算期初欠票的账龄', to: '/users', admin: true },
    { done: x.users > 0, title: '给跟单员和财务建账号', hint: '每人一个账号，跟单员要分配供应商', to: '/users', admin: true },
    { done: x.buyers > 0 && !missingBoard.length, title: '登记我方受票主体（电商和工厂的收票公司）', hint: x.buyers ? `还没登记${missingBoard.join('、')}板块的公司` : '决定每张发票归哪个板块', to: '/master?tab=buyers' },
    { done: x.suppliers > 0 && x.entities > 0, title: '导入供应商和开票主体', hint: '用「批量导入」里的模板一次填好', to: '/master?tab=import' },
    { done: x.opening > 0, title: '核对期初欠票', hint: '系统启用前的历史欠票，分电商和工厂', to: '/master?tab=opening' },
    { done: x.statements > 0, title: '录第一张对账单并终审', hint: '跟单员创建提交，财务终审后计入应开', to: '/statements' },
    { done: x.invoices > 0, title: '上传第一张发票', hint: 'XML 或 PDF，系统会自动识别归属', to: '/invoices' },
  ];
  return list.filter((t) => !t.admin || role.admin());
});
const doneCount = computed(() => steps.value.filter((t) => t.done).length);
const show = computed(() => !hidden.value && steps.value.length && doneCount.value < steps.value.length);
</script>

<template>
  <section v-if="show" class="panel setup">
    <div class="panel-h">
      <h3>上手引导</h3>
      <span class="note">已完成 {{ doneCount }} / {{ steps.length }}，做完会自动消失</span>
      <span class="spacer"></span>
      <a class="btn sm" href="/manual.html#start" target="_blank" rel="noopener">操作手册</a>
      <button class="btn sm" type="button" @click="hide">不再显示</button>
    </div>
    <div class="panel-b">
      <div class="prog" :class="{ full: doneCount === steps.length }"><i :style="{ width: (doneCount / steps.length * 100) + '%' }"></i></div>
      <ol class="setup-list">
        <li v-for="(t, i) in steps" :key="i" :class="{ done: t.done }">
          <span class="ic" :class="t.done ? 'ok' : 'q'" aria-hidden="true">{{ t.done ? '✓' : i + 1 }}</span>
          <span class="setup-t"><b>{{ t.title }}</b><span class="note">{{ t.hint }}</span></span>
          <router-link v-if="!t.done" class="btn sm" :to="t.to">去完成</router-link>
          <span v-else class="note">已完成</span>
        </li>
      </ol>
    </div>
  </section>
</template>
