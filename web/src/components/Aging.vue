<script setup>
import { money } from '../api.js';
import { BUCKETS } from '../ui.js';
defineProps({ buckets: { type: Array, default: () => [0, 0, 0, 0] } });
</script>
<template>
  <div class="aging">
    <div v-for="(b, i) in BUCKETS" :key="i" :class="'a' + i"><div class="lb">{{ b }}</div><div class="v">{{ money(buckets[i]) }}</div></div>
  </div>
</template>
