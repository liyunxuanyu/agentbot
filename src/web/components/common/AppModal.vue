<script setup lang="ts">
import { onBeforeUnmount, onMounted } from "vue";
import AppIcon from "./AppIcon.vue";

/**
 * 弹层（原型 .overlay / .modal）。
 *
 * 与原型一致的细节：进入 spring 200ms、关闭 140ms 反向动画（`.is-closing` 后才真正卸载），
 * 点遮罩关闭（但点弹层内部不关），Esc 关闭由全局 hotkeys 兜（这里也监听一次，
 * 因为弹层可能在没有页面的独立场景里打开）。
 */
const props = withDefaults(
  defineProps<{
    title: string;
    /** 底部按钮区；不传则不渲染 footer。 */
    width?: string;
  }>(),
  { width: "" },
);

const open = defineModel<boolean>("open", { required: true });
const emit = defineEmits<{ close: [] }>();

let closing = false;

function requestClose(): void {
  if (closing) return;
  closing = true;
  window.setTimeout(() => {
    closing = false;
    open.value = false;
    emit("close");
  }, 140);
}

function onOverlayClick(e: MouseEvent): void {
  if (e.target === e.currentTarget) requestClose();
}

function onKeydown(e: KeyboardEvent): void {
  if (e.key === "Escape" && open.value) {
    e.stopPropagation();
    requestClose();
  }
}

onMounted(() => window.addEventListener("keydown", onKeydown));
onBeforeUnmount(() => window.removeEventListener("keydown", onKeydown));

defineExpose({ close: requestClose });
void props;
</script>

<template>
  <Teleport to="body">
    <div v-if="open" class="overlay" :class="{ 'is-closing': closing }" @click="onOverlayClick">
      <div
        class="modal"
        role="dialog"
        aria-modal="true"
        :aria-label="title"
        :style="width ? { maxWidth: width } : undefined"
      >
        <div class="modal-head">
          <h3>{{ title }}</h3>
          <span class="spacer" />
          <button class="icon-btn" aria-label="关闭" @click="requestClose">
            <AppIcon name="close" :size="14" />
          </button>
        </div>
        <div>
          <slot />
        </div>
        <div v-if="$slots.footer" class="modal-foot">
          <slot name="footer" />
        </div>
      </div>
    </div>
  </Teleport>
</template>
