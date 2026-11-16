<script setup lang="ts">
import { computed, ref, useId, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import MotionCollapse from './MotionCollapse.vue';
import { parseUpdateNotes, summarizeUpdateNotes, updateNotesNeedExpansion } from '../lib/update-notes';

const props = defineProps<{ body: string }>();
const { t } = useI18n();
const expanded = ref(false);
const contentId = useId();
const blocks = computed(() => parseUpdateNotes(props.body));
const collapsible = computed(() => updateNotesNeedExpansion(blocks.value));
const summary = computed(() => summarizeUpdateNotes(blocks.value));
watch(() => props.body, () => { expanded.value = false; });
</script>

<template>
  <section v-if="blocks.length" class="update-notes">
    <div class="notes-header">
      <span>{{ t('updates.releaseNotes') }}</span>
      <button v-if="collapsible" class="notes-toggle" :aria-expanded="expanded" :aria-controls="contentId" @click="expanded = !expanded">
        {{ t(expanded ? 'updates.collapseNotes' : 'updates.expandNotes') }}
        <svg viewBox="0 0 16 16" width="12" height="12" :class="{ expanded }" aria-hidden="true">
          <path d="m4.5 6.5 3.5 3.5 3.5-3.5" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" />
        </svg>
      </button>
    </div>
    <MotionCollapse :open="collapsible && !expanded">
      <p class="notes-summary">{{ summary }}</p>
    </MotionCollapse>
    <MotionCollapse :open="!collapsible || expanded">
      <div :id="contentId" class="notes-content">
        <template v-for="(block, index) in blocks" :key="index">
          <h4 v-if="block.kind === 'heading'">{{ block.text }}</h4>
          <p v-else-if="block.kind === 'paragraph'">{{ block.text }}</p>
          <ol v-else-if="block.ordered" :start="block.start">
            <li v-for="(item, itemIndex) in block.items" :key="itemIndex">{{ item }}</li>
          </ol>
          <ul v-else>
            <li v-for="(item, itemIndex) in block.items" :key="itemIndex">{{ item }}</li>
          </ul>
        </template>
      </div>
    </MotionCollapse>
  </section>
</template>

<style scoped>
.update-notes { margin-top: 12px; padding-top: 10px; border-top: 1px solid var(--surface-line); overflow-wrap: anywhere; }
.notes-header { display: flex; align-items: center; justify-content: space-between; gap: 8px; color: var(--text-tertiary); font-size: 11px; line-height: 20px; }
.notes-toggle { display: inline-flex; align-items: center; gap: 4px; flex-shrink: 0; padding: 2px 5px; margin-right: -5px; border: 0; border-radius: var(--radius-control); background: transparent; color: var(--text-secondary); font: inherit; cursor: pointer; transition: var(--control-transition); }
.notes-toggle:hover { background: var(--bg-overlay-l1); color: var(--text-default); }
.notes-toggle:focus-visible { outline: 2px solid var(--interaction-border); outline-offset: 2px; }
.notes-toggle svg { display: block; transition: transform var(--motion-fast) var(--ease-out); }
.notes-toggle svg.expanded { transform: rotate(180deg); }
.notes-summary { margin: 5px 0 0; color: var(--text-secondary); line-height: var(--body-md-line-height); }
.notes-content { padding-top: 5px; color: var(--text-secondary); line-height: var(--body-md-line-height); }
.notes-content > :first-child { margin-top: 0; }
.notes-content > :last-child { margin-bottom: 0; }
.notes-content h4 { margin: 12px 0 5px; color: var(--text-default); font-size: inherit; font-weight: var(--font-weight-strong); }
.notes-content p { margin: 5px 0; }
.notes-content ul, .notes-content ol { margin: 5px 0; padding-left: 18px; }
.notes-content li { padding-left: 1px; margin: 4px 0; }
.notes-content li::marker { color: var(--text-tertiary); }
</style>
