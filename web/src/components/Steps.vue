<script setup>
defineProps({ steps: { type: Array, default: () => [] } });
const ICON = { ok: '✓', no: '✕', q: '?' };
</script>
<template>
  <ul class="steps">
    <li v-for="(s, i) in steps" :key="i"><span class="ic" :class="s[0]">{{ ICON[s[0]] }}</span><span>{{ s[1] }}</span></li>
  </ul>
</template>
