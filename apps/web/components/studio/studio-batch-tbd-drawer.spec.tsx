// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { StudioBatchTbdDrawer } from './studio-batch-tbd-drawer';
import {
  batchReplaceMissingFactSlots,
  extractSlotContextSnippet,
  groupMissingFactSlots,
} from './studio-batch-tbd-helpers';

describe('studio-batch-tbd-helpers & StudioBatchTbdDrawer (#385)', () => {
  afterEach(() => {
    cleanup();
  });

  it('deduplicates same-name hints in first-appearance order while keeping bare [TBD] slots distinct', () => {
    const markdown = [
      '第一段实测满载功耗为 [待补充：满载功耗]，静音表现优秀。',
      '| 指标 | 实测值 |',
      '| --- | --- |',
      '| 满载功耗 | [待补充： 满载功耗 ] |',
      '| 质保 | [待补充：质保周期] |',
      '补充项 A：[TBD]；补充项 B：[TBD]。',
    ].join('\n');

    const groups = groupMissingFactSlots(markdown);
    expect(groups).toHaveLength(4);
    expect(groups[0]?.hint).toBe('满载功耗');
    expect(groups[0]?.slots).toHaveLength(2);
    expect(groups[0]?.contexts).toHaveLength(2);
    expect(groups[1]?.hint).toBe('质保周期');
    expect(groups[1]?.slots).toHaveLength(1);
    expect(groups[2]?.key).not.toBe(groups[3]?.key);

    const longLine = `${'前'.repeat(80)}[待补充：续航时长]${'后'.repeat(80)}`;
    const longGroups = groupMissingFactSlots(longLine);
    const snippet = extractSlotContextSnippet(longLine, longGroups[0]!.slots[0]!, 20);
    expect(snippet.startsWith('…')).toBe(true);
    expect(snippet.endsWith('…')).toBe(true);
    expect(snippet).toContain('[待补充：续航时长]');
  });

  it('replaces multiple occurrences in descending offset order, preserves $&/$$/$1 literally, and supports partial fill', () => {
    const markdown = [
      '功率：[待补充：满载功耗]。',
      '| 满载功耗 | [待补充：满载功耗] | 质保 | [待补充：质保周期] |',
    ].join('\n');
    const groups = groupMissingFactSlots(markdown);

    // Partial fill: only fill first group with special $ sequences
    const partialOut = batchReplaceMissingFactSlots(
      markdown,
      groups[0]!.slots.map((slot) => ({ slot, value: '$& $$42W $1' })),
    );
    expect(partialOut).toBe(
      ['功率：$& $$42W $1。', '| 满载功耗 | $& $$42W $1 | 质保 | [待补充：质保周期] |'].join('\n'),
    );

    // Full fill replaces all 3 tokens and preserves Markdown table pipes
    const fullOut = batchReplaceMissingFactSlots(markdown, [
      ...groups[0]!.slots.map((slot) => ({ slot, value: '42W' })),
      ...groups[1]!.slots.map((slot) => ({ slot, value: '3 年质保' })),
    ]);
    expect(fullOut).toBe(['功率：42W。', '| 满载功耗 | 42W | 质保 | 3 年质保 |'].join('\n'));

    // Stale/mismatched offset is safely ignored
    const staleSlot = { ...groups[0]!.slots[0]!, start: 0, end: 2 };
    expect(batchReplaceMissingFactSlots(markdown, [{ slot: staleSlot, value: '99W' }])).toBe(
      markdown,
    );

    // NaN / Infinity / float offsets MUST be ignored without corrupting valid replacements (C1-4)
    const plain = '0123456789ABCDEF';
    expect(
      batchReplaceMissingFactSlots(plain, [
        {
          slot: { index: 0, raw: '01234', hint: 'nan', start: Number.NaN, end: 5 },
          value: 'CORRUPT',
        },
        {
          slot: { index: 1, raw: '1234', hint: 'float', start: 1.5, end: 5 },
          value: 'FLOAT',
        },
        {
          slot: { index: 2, raw: '56789', hint: 'valid', start: 5, end: 10 },
          value: 'OK',
        },
      ]),
    ).toBe('01234OKABCDEF');

    // Bare [TBD] at index 0 MUST NOT collide with literal [TBD: __empty_0] (C1-4)
    const collisionMd = '第一项 [TBD] 与第二项 [TBD: __empty_0]';
    const collisionGroups = groupMissingFactSlots(collisionMd);
    expect(collisionGroups).toHaveLength(2);
    expect(collisionGroups[0]?.key).not.toBe(collisionGroups[1]?.key);
    expect(collisionGroups[0]?.slots).toHaveLength(1);
    expect(collisionGroups[1]?.slots).toHaveLength(1);
    expect(collisionGroups[1]?.hint).toBe('__empty_0');
  });

  it('renders deduplicated inputs, occurrence badge, context snippets, sync toggle, and submits filled entries', async () => {
    const markdown = [
      '实测满载功耗 [待补充：满载功耗]，另见表格：[待补充：满载功耗]。',
      '官方质保周期为 [待补充：质保周期]。',
    ].join('\n');
    const groups = groupMissingFactSlots(markdown);
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    const onClose = vi.fn();

    render(
      <StudioBatchTbdDrawer
        open
        articleId="art_1"
        groups={groups}
        readOnly={false}
        onClose={onClose}
        onSubmit={onSubmit}
      />,
    );

    const drawerBody = await screen.findByTestId('studio-batch-tbd-drawer');
    expect(drawerBody.textContent).toContain('满载功耗');
    expect(drawerBody.textContent).toContain('质保周期');
    expect(drawerBody.textContent).toContain('出现 2 处');

    // Exact count of text inputs MUST equal deduplicated group count (2, not 3)
    const textInputs = drawerBody.querySelectorAll('input[type="text"], textarea');
    expect(textInputs).toHaveLength(2);

    const submitBtn = screen.getByTestId('batch-tbd-submit-btn') as HTMLButtonElement;
    expect(submitBtn.disabled).toBe(true);

    fireEvent.change(screen.getByLabelText('满载功耗'), { target: { value: '42W' } });
    fireEvent.change(screen.getByLabelText('质保周期'), { target: { value: '3 年质保' } });
    expect(submitBtn.disabled).toBe(false);

    // Change target fact slot
    fireEvent.change(screen.getByLabelText('反哺事实卡分类'), {
      target: { value: 'CREDENTIALS' },
    });
    fireEvent.click(submitBtn);

    await waitFor(() => {
      expect(onSubmit).toHaveBeenCalledTimes(1);
    });
    expect(onSubmit).toHaveBeenCalledWith(
      [
        { group: groups[0], value: '42W' },
        { group: groups[1], value: '3 年质保' },
      ],
      { syncToFact: true, factSlot: 'CREDENTIALS' },
    );
  });
});
