import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import Login from './Login';

const { mockGetPublic } = vi.hoisted(() => ({ mockGetPublic: vi.fn() }));
vi.mock('../api/client', () => ({ config: { getPublic: mockGetPublic } }));

describe('Login', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetPublic.mockResolvedValue({ selfEnroll: false });
  });

  function renderLogin(search = '', path = '/') {
    return render(
      <MemoryRouter initialEntries={[`${path}${search}`]}>
        <Login onSuccess={vi.fn()} />
      </MemoryRouter>
    );
  }

  it('renders the branding', () => {
    renderLogin();
    expect(screen.getByText('Helm')).toBeInTheDocument();
    expect(screen.getByText('Tools. Memory. Skills. Any harness.')).toBeInTheDocument();
  });

  it('renders the Google sign-in button', () => {
    renderLogin();
    expect(screen.getByRole('button', { name: /continue with google/i })).toBeInTheDocument();
  });

  it('Google sign-in button is initially enabled', () => {
    renderLogin();
    expect(screen.getByRole('button', { name: /continue with google/i })).not.toBeDisabled();
  });

  it('clicking sign-in button disables the button (loading state)', () => {
    renderLogin();
    const btn = screen.getByRole('button', { name: /continue with google/i });
    fireEvent.click(btn);
    expect(btn).toBeDisabled();
  });

  it('shows error for not_authorized login error', () => {
    renderLogin('?login_error=not_authorized');
    expect(screen.getByText('Sign-ups are closed. Ask your administrator for an invite.')).toBeInTheDocument();
  });

  describe('trial pitch', () => {
    it('invites a stranger to start the trial when self-enrollment is on', async () => {
      mockGetPublic.mockResolvedValue({ selfEnroll: true, selfTrialDays: 15 });
      renderLogin();
      expect(await screen.findByText('Sign in with Google to start your 15-day free trial')).toBeInTheDocument();
    });

    it('takes the trial length from config', async () => {
      mockGetPublic.mockResolvedValue({ selfEnroll: true, selfTrialDays: 30 });
      renderLogin();
      expect(await screen.findByText(/start your 30-day free trial/)).toBeInTheDocument();
    });

    it('keeps the plain subtitle when self-enrollment is off', async () => {
      renderLogin();
      await vi.waitFor(() => expect(mockGetPublic).toHaveBeenCalled());
      expect(screen.getByText('Use your Google account to continue')).toBeInTheDocument();
      expect(screen.queryByText(/free trial/)).not.toBeInTheDocument();
    });

    it('keeps the plain subtitle when config cannot be read', async () => {
      mockGetPublic.mockRejectedValue(new Error('offline'));
      renderLogin();
      await vi.waitFor(() => expect(mockGetPublic).toHaveBeenCalled());
      expect(screen.getByText('Use your Google account to continue')).toBeInTheDocument();
    });
  });

  it('shows error for invalid_state login error', () => {
    renderLogin('?login_error=invalid_state');
    expect(screen.getByText(/session expired/i)).toBeInTheDocument();
  });

  it('shows generic error for unknown error key', () => {
    renderLogin('?login_error=true');
    expect(screen.getByText(/sign-in failed/i)).toBeInTheDocument();
  });

  it('shows no error when no login_error param', () => {
    renderLogin();
    expect(screen.queryByRole('img', { name: /alert/i })).not.toBeInTheDocument();
  });

  describe('next parameter', () => {
    let hrefSetter: ReturnType<typeof vi.fn>;
    beforeEach(() => {
      hrefSetter = vi.fn();
      Object.defineProperty(window, 'location', {
        configurable: true,
        value: { href: 'http://localhost/', origin: 'http://localhost', assign: vi.fn() },
      });
      Object.defineProperty(window.location, 'href', { configurable: true, set: hrefSetter, get: () => 'http://localhost/' });
    });

    it('forwards next to the Google login endpoint', () => {
      const next = 'http://localhost/mcp/oauth/authorize?client_id=x';
      renderLogin(`?next=${encodeURIComponent(next)}`);
      fireEvent.click(screen.getByRole('button', { name: /continue with google/i }));
      expect(hrefSetter).toHaveBeenCalledWith(
        `/api/auth/google?next=${encodeURIComponent('/mcp/oauth/authorize?client_id=x')}`
      );
    });

    it('goes to the Google login endpoint without next when absent', () => {
      renderLogin();
      fireEvent.click(screen.getByRole('button', { name: /continue with google/i }));
      expect(hrefSetter).toHaveBeenCalledWith('/api/auth/google');
    });

    it('returns to next after a successful password login', async () => {
      const next = '/mcp/oauth/authorize?client_id=x';
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }));
      renderLogin(`?next=${encodeURIComponent(next)}`);
      fireEvent.click(screen.getByRole('button', { name: /sign in with email/i }));
      fireEvent.change(screen.getByPlaceholderText(/email/i), { target: { value: 'a@b.c' } });
      fireEvent.change(screen.getByPlaceholderText(/password/i), { target: { value: 'pw' } });
      fireEvent.submit(screen.getByRole('button', { name: /^sign in$/i }).closest('form')!);
      await vi.waitFor(() => expect(hrefSetter).toHaveBeenCalledWith(next));
      vi.unstubAllGlobals();
    });

    it('returns to the page it replaced, such as /pricing', () => {
      renderLogin('', '/pricing');
      fireEvent.click(screen.getByRole('button', { name: /continue with google/i }));
      expect(hrefSetter).toHaveBeenCalledWith(`/api/auth/google?next=${encodeURIComponent('/pricing')}`);
    });

    it('prefers an explicit next over the current page', () => {
      renderLogin(`?next=${encodeURIComponent('/billing')}`, '/pricing');
      fireEvent.click(screen.getByRole('button', { name: /continue with google/i }));
      expect(hrefSetter).toHaveBeenCalledWith(`/api/auth/google?next=${encodeURIComponent('/billing')}`);
    });

    it('ignores a foreign-origin next', () => {
      renderLogin(`?next=${encodeURIComponent('https://evil.example/x')}`);
      fireEvent.click(screen.getByRole('button', { name: /continue with google/i }));
      expect(hrefSetter).toHaveBeenCalledWith('/api/auth/google');
    });
  });
});
