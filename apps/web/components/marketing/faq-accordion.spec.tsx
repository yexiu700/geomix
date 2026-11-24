// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { FaqAccordion } from './faq-accordion';
import { HOME_FAQ_ITEMS } from './marketing-home-data';

afterEach(() => {
  cleanup();
});

describe('FaqAccordion', () => {
  it('renders accessible ARIA triggers and toggles expanded panels cleanly', () => {
    render(<FaqAccordion items={HOME_FAQ_ITEMS.en} defaultOpenIndex={0} />);

    const triggers = screen.getAllByRole('button');
    expect(triggers).toHaveLength(HOME_FAQ_ITEMS.en.length);
    const [trigger0, trigger1] = triggers;
    if (!trigger0 || !trigger1) throw new Error('Expected at least 2 FAQ accordion triggers');

    expect(trigger0.getAttribute('aria-expanded')).toBe('true');
    expect(trigger1.getAttribute('aria-expanded')).toBe('false');

    const panel1Id = trigger1.getAttribute('aria-controls');
    expect(panel1Id).toBeTruthy();
    const panel1 = document.getElementById(panel1Id as string);
    expect(panel1?.hidden).toBe(true);

    // Open second FAQ item
    fireEvent.click(trigger1);
    expect(trigger0.getAttribute('aria-expanded')).toBe('false');
    expect(trigger1.getAttribute('aria-expanded')).toBe('true');
    expect(panel1?.hidden).toBe(false);

    // Collapse second FAQ item again
    fireEvent.click(trigger1);
    expect(trigger1.getAttribute('aria-expanded')).toBe('false');
    expect(panel1?.hidden).toBe(true);
  });
});
