<script setup>
import { ref } from 'vue';

/**
 * Short "how to use this page" tips under a page heading. Open the first time, then remembers
 * (per browser) whether the user folded it away. Links to the matching section of the manual.
 */
const props = defineProps({
  id: { type: String, required: true },
  anchor: { type: String, default: '' },
  tips: { type: Array, required: true },
});
const KEY = `guide-folded:${props.id}`;
const read = () => { try { return localStorage.getItem(KEY) === '1'; } catch { return false; } };
const folded = ref(read());
const toggle = () => {
  folded.value = !folded.value;
  try { localStorage.setItem(KEY, folded.value ? '1' : '0'); } catch { /* private mode */ }
};
const href = `/manual.html${props.anchor ? `#${props.anchor}` : ''}`;
</script>

<template>
  <div class="guide" :class="{ folded }">
    <button class="guide-h" type="button" :aria-expanded="!folded" @click="toggle">
      <span class="guide-ic" aria-hidden="true">?</span>
      <span>这个页面怎么用</span>
      <span class="spacer"></span>
      <span class="note">{{ folded ? '展开' : '收起' }}</span>
    </button>
    <div v-if="!folded" class="guide-b">
      <ol>
        <li v-for="(t, i) in tips" :key="i" v-html="t"></li>
      </ol>
      <a :href="href" target="_blank" rel="noopener">看完整说明和流程图 →</a>
    </div>
  </div>
</template>
