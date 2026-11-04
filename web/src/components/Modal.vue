<script setup>
import { ref, watch, onMounted } from 'vue';
const props = defineProps({ open: Boolean, title: String, wide: Boolean });
const emit = defineEmits(['close']);
const el = ref(null);
const sync = () => { if (!el.value) return; if (props.open && !el.value.open) el.value.showModal(); if (!props.open && el.value.open) el.value.close(); };
watch(() => props.open, sync);
onMounted(sync);
</script>

<template>
  <dialog ref="el" :style="wide ? 'width:min(960px,calc(100vw - 32px))' : ''" @close="emit('close')" @cancel.prevent="emit('close')">
    <div class="dlg-h"><h3>{{ title }}</h3><span class="spacer"></span><button class="btn sm" type="button" @click="emit('close')">关闭</button></div>
    <div class="dlg-b"><slot /></div>
  </dialog>
</template>
