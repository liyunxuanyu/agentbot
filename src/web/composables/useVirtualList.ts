import { computed, type Ref } from "vue";
import { useVirtualizer } from "@tanstack/vue-virtual";

/**
 * 长列表虚拟滚动（架构 §7：`@tanstack/vue-virtual`，item 粒度 = 折叠 Turn 一行 / 展开 Turn 内单条事件）。
 *
 * 为什么只用在会话流上：`/bots` 的卡片网格用 CSS 分页就够（≤100 张），
 * 而会话单轮可能 >2000 条事件（P0-05 边界），必须只渲染可视区 ±overscan。
 *
 * 关键点：
 *   - `estimateSize` 只是初始猜测，`measureElement` 会在渲染后量真实高度
 *     （Turn 高度差异极大：折叠 44px，展开可能 800px）；
 *   - 动态测量要求每项绑定 `:ref="virtualizer.measureElement"` 并带 `data-index`；
 *   - `getItemKey` 用 turnId，避免重排时错位复用 DOM。
 */
export interface UseVirtualListOptions {
  /** 滚动容器（.stream）。 */
  scrollRef: Ref<HTMLElement | null>;
  /** 数据项（Turn 列表）。用 id 取 key。 */
  count: Ref<number>;
  /** 取第 index 项的稳定 key。 */
  getKey: (index: number) => string;
  /** 初始估计高度（px）。 */
  estimateSize?: number;
  /** 可视区外多渲染几条。 */
  overscan?: number;
  /** 关闭虚拟化（短会话直接全渲染，避免测量抖动）。 */
  enabled?: Ref<boolean>;
}

export function useVirtualList(opts: UseVirtualListOptions) {
  const enabled = opts.enabled ?? computed(() => true);

  const virtualizer = useVirtualizer(
    computed(() => ({
      count: opts.count.value,
      getScrollElement: () => opts.scrollRef.value,
      estimateSize: () => opts.estimateSize ?? 160,
      getItemKey: (index: number) => opts.getKey(index),
      overscan: opts.overscan ?? 5,
      // 会话流是从上往下追加，不需要 lane 或横向测量
      enabled: enabled.value,
    })),
  );

  const items = computed(() => virtualizer.value.getVirtualItems());
  const totalSize = computed(() => virtualizer.value.getTotalSize());

  /** 滚到底（流式追加时用）。 */
  function scrollToEnd(): void {
    const el = opts.scrollRef.value;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }

  /** 滚到指定 key（点「待批」chip 跳卡片）。 */
  function scrollToKey(key: string): void {
    const index = virtualizer.value
      .getVirtualItems()
      .find((vi) => String(vi.key) === key)?.index;
    if (index === undefined) {
      // 不在可视区：先让虚拟器把目标滚进来
      const all = opts.count.value;
      for (let i = 0; i < all; i += 1) {
        if (opts.getKey(i) === key) {
          virtualizer.value.scrollToIndex(i, { align: "center" });
          return;
        }
      }
      return;
    }
    virtualizer.value.scrollToIndex(index, { align: "center" });
  }

  return { virtualizer, items, totalSize, scrollToEnd, scrollToKey };
}
