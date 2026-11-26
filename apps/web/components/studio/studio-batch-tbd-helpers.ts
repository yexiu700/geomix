import { extractMissingFactSlots, type MissingFactSlot } from '@geomix/shared';

export type MissingFactSlotGroup = {
  key: string;
  hint: string;
  slots: MissingFactSlot[];
  contexts: string[];
};

export function extractSlotContextSnippet(
  markdown: string,
  slot: MissingFactSlot,
  radius = 48,
): string {
  if (!markdown) return slot.raw;
  const safeStart = Math.max(0, Math.min(slot.start, markdown.length));
  const safeEnd = Math.max(safeStart, Math.min(slot.end, markdown.length));
  const lineStart = safeStart > 0 ? markdown.lastIndexOf('\n', safeStart - 1) + 1 : 0;
  const nextNewline = markdown.indexOf('\n', safeEnd);
  const lineEnd = nextNewline === -1 ? markdown.length : nextNewline;

  const sliceStart = Math.max(lineStart, safeStart - radius);
  const sliceEnd = Math.min(lineEnd, safeEnd + radius);
  const prefix = sliceStart > lineStart ? '…' : '';
  const suffix = sliceEnd < lineEnd ? '…' : '';
  return `${prefix}${markdown.slice(sliceStart, sliceEnd).trim()}${suffix}`;
}

export function groupMissingFactSlots(
  markdown: string,
  slots?: readonly MissingFactSlot[],
): MissingFactSlotGroup[] {
  const sourceSlots = slots ?? extractMissingFactSlots(markdown);
  const groups: MissingFactSlotGroup[] = [];
  const byKey = new Map<string, MissingFactSlotGroup>();

  for (const slot of sourceSlots) {
    const cleanHint = slot.hint.trim();
    const key =
      cleanHint.length > 0
        ? `hint:${cleanHint.replace(/\s+/g, ' ').toLowerCase()}`
        : `empty:${slot.index}`;
    const displayHint = cleanHint.length > 0 ? cleanHint : '待补充参数';
    const context = extractSlotContextSnippet(markdown, slot);

    const existing = byKey.get(key);
    if (existing) {
      existing.slots.push(slot);
      existing.contexts.push(context);
    } else {
      const nextGroup: MissingFactSlotGroup = {
        key,
        hint: displayHint,
        slots: [slot],
        contexts: [context],
      };
      byKey.set(key, nextGroup);
      groups.push(nextGroup);
    }
  }

  return groups;
}

export function batchReplaceMissingFactSlots(
  markdown: string,
  replacements: ReadonlyArray<{ slot: MissingFactSlot; value: string }>,
): string {
  const validByStart = new Map<number, { slot: MissingFactSlot; value: string }>();

  for (const entry of replacements) {
    const cleanValue = entry.value.trim();
    if (!cleanValue) continue;
    const { slot } = entry;
    if (!Number.isInteger(slot.start) || !Number.isInteger(slot.end)) continue;
    if (slot.start < 0 || slot.end > markdown.length || slot.end <= slot.start) continue;
    if (markdown.slice(slot.start, slot.end) !== slot.raw) continue;
    if (!validByStart.has(slot.start)) {
      validByStart.set(slot.start, { slot, value: cleanValue });
    }
  }

  const ordered = Array.from(validByStart.values()).sort((a, b) => b.slot.start - a.slot.start);
  let output = markdown;
  let prevStart = Number.POSITIVE_INFINITY;

  for (const item of ordered) {
    if (item.slot.end > prevStart) {
      // Skip overlapping intervals defensively
      continue;
    }
    output = output.slice(0, item.slot.start) + item.value + output.slice(item.slot.end);
    prevStart = item.slot.start;
  }

  return output;
}
