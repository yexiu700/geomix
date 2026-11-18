// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import HomePage from '../app/page';
import { HomePanel } from './home-panel';

const pushMock = vi.fn();
const redirectMock = vi.fn((url: string) => {
  throw new Error(`NEXT_REDIRECT:${url}`);
});

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: pushMock }),
  redirect: (url: string) => redirectMock(url),
}));

afterEach(() => {
  cleanup();
  pushMock.mockReset();
  redirectMock.mockClear();
});

describe('Root entry and HomePanel (#127)', () => {
  it('redirects root path / directly to /login without an intermediate landing card', () => {
    expect(() => HomePage()).toThrow('NEXT_REDIRECT:/login');
    expect(redirectMock).toHaveBeenCalledWith('/login');
  });

  it('does not nest interactive elements (<a><button>) in HomePanel and navigates cleanly', () => {
    const { container } = render(<HomePanel />);

    expect(container.querySelector('a button')).toBeNull();
    expect(container.querySelector('button a')).toBeNull();
    expect(container.querySelector('a [role="button"]')).toBeNull();

    const loginBtn = screen.getByRole('button', { name: /登\s*录/ });
    fireEvent.click(loginBtn);
    expect(pushMock).toHaveBeenCalledWith('/login');
  });
});
