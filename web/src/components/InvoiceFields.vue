<script setup>
const f = defineModel({ type: Object, required: true });
const TYPES = ['数电专票', '数电普票', '纸质专票', '纸质普票'];
</script>
<template>
  <div class="form">
    <label>发票号码<input v-model.trim="f.number" inputmode="numeric" required></label>
    <label>开票日期<input v-model="f.issue_date" type="date"></label>
    <label>发票类型<select v-model="f.type"><option v-for="t in TYPES" :key="t">{{ t }}</option></select></label>
    <label>税率<input v-model="f.rate" type="number" step="0.01" min="0" max="0.17" placeholder="如 0.13"></label>
    <label>销售方（开票主体）<input v-model="f.seller_name"></label>
    <label>销售方税号<input v-model.trim="f.seller_tax_id" autocapitalize="characters"></label>
    <label>购买方（我方）<input v-model="f.buyer_name"></label>
    <label>购买方税号<input v-model.trim="f.buyer_tax_id" autocapitalize="characters"></label>
    <label>金额（不含税）<input v-model="f.net" type="number" step="0.01" inputmode="decimal" required></label>
    <label>税额<input v-model="f.tax" type="number" step="0.01" inputmode="decimal" required></label>
    <label>价税合计<input v-model="f.total" type="number" step="0.01" inputmode="decimal" required></label>
    <label>备注<input v-model="f.remark"></label>
  </div>
</template>
