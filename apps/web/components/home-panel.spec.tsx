// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import MarketingRootPage, {
  generateMetadata as generateRootMetadata,
} from '../app/(marketing)/page';
import { HomePanel } from './home-panel';

const pushMock = vi.fn();
const redirectMock = vi.fn((url: string) => {
  throw new Error(`NEXT_REDIRECT:${url}`);
});

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: pushMock }),
  usePathname: () => '/',
  redirect: (url: string) => redirectMock(url),
}));

afterEach(() => {
  cleanup();
  pushMock.mockReset();
  redirectMock.mockClear();
});

describe('Root entry and HomePanel (#127, #380)', () => {
  it('renders the Global-First EN brand homepage at / without redirecting to /login and exports hreflang metadata', () => {
    render(<MarketingRootPage />);

    expect(redirectMock).not.toHaveBeenCalled();
    expect(
      screen.getByRole('heading', {
        level: 1,
        name: /Make Your Brand the Source AI Cites/i,
      }),
    ).toBeTruthy();

    const demoCta = screen.getByTestId('hero-primary-cta');
    expect(demoCta.getAttribute('href')).toBe('/demo');

    const rootMetadata = generateRootMetadata();
    expect(rootMetadata.alternates?.canonical).toBeTruthy();
    const languages = rootMetadata.alternates?.languages as Record<string, string> | undefined;
    expect(languages?.en).toBeTruthy();
    expect(languages?.['zh-CN']).toBeTruthy();
    expect(languages?.['x-default']).toBe(languages?.en);
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
