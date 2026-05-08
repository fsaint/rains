import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import Login from './Login';

describe('Login', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  function renderLogin(search = '') {
    return render(
      <MemoryRouter initialEntries={[`/${search}`]}>
        <Login onSuccess={vi.fn()} />
      </MemoryRouter>
    );
  }

  it('renders the branding', () => {
    renderLogin();
    expect(screen.getByText('AgentHelm')).toBeInTheDocument();
    expect(screen.getByText('The trust layer for AI agents')).toBeInTheDocument();
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
    expect(screen.getByText(/hasn't been set up yet/i)).toBeInTheDocument();
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
});
