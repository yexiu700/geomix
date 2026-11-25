// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { FormField } from './index';

describe('FormField', () => {
  afterEach(() => {
    cleanup();
  });

  it('links label via htmlFor, renders required marker + sr-only, extra, help, and error alert with merged aria attributes', () => {
    render(
      <FormField
        label="品牌英文名"
        htmlFor="brand-en-name"
        required
        extra={<span>GLOBAL 市场必填</span>}
        help="请填写面向海外 AI 引擎的正式英文品牌名"
        error="GLOBAL 市场品牌名不能包含中文字符"
        data-testid="field-brand-en"
      >
        <input id="brand-en-name" aria-describedby="external-hint" />
      </FormField>,
    );

    const field = screen.getByTestId('field-brand-en');
    expect(field.className).toContain('gm-ui-form-field');

    const input = screen.getByLabelText(/品牌英文名/);
    expect(input.id).toBe('brand-en-name');
    expect(input.getAttribute('aria-invalid')).toBe('true');

    const alert = screen.getByRole('alert');
    expect(alert.textContent).toBe('GLOBAL 市场品牌名不能包含中文字符');
    const help = screen.getByText('请填写面向海外 AI 引擎的正式英文品牌名');

    const describedBy = input.getAttribute('aria-describedby') ?? '';
    expect(describedBy).toContain('external-hint');
    expect(describedBy).toContain(alert.id);
    expect(describedBy).toContain(help.id);

    expect(screen.getByText('GLOBAL 市场必填')).toBeTruthy();
    expect(screen.getByText('（必填）')).toBeTruthy();
  });

  it('renders cleanly when given a Fragment or multiple children without throwing', () => {
    render(
      <FormField label="竞品列表" help="最多添加 10 个竞品" error="至少保留 1 个竞品">
        <>
          <input aria-label="竞品 1" />
          <input aria-label="竞品 2" />
        </>
      </FormField>,
    );

    expect(screen.getByLabelText('竞品 1')).toBeTruthy();
    expect(screen.getByLabelText('竞品 2')).toBeTruthy();
    expect(screen.getByRole('alert').textContent).toBe('至少保留 1 个竞品');
  });
});
