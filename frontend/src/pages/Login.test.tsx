import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import Login from './Login';

vi.mock('../api/client', () => ({
  auth: {
    login: vi.fn(),
  },
}));

import { auth } from '../api/client';

const mockUser = { id: 'u1', email: 'admin@reins.local', name: 'Admin', role: 'admin' as const };

describe('Login', () => {
  const onSuccess = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  function renderLogin() {
    return render(<Login onSuccess={onSuccess} />);
  }

  it('renders email and password inputs', () => {
    renderLogin();
    expect(screen.getByPlaceholderText('Email')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('Password')).toBeInTheDocument();
  });

  it('renders the Reins branding', () => {
    renderLogin();
    expect(screen.getByText('Reins')).toBeInTheDocument();
    expect(screen.getByText('The trust layer for AI agents')).toBeInTheDocument();
  });

  it('submit button is disabled when fields are empty', () => {
    renderLogin();
    const btn = screen.getByRole('button', { name: /continue/i });
    expect(btn).toBeDisabled();
  });

  it('submit button is disabled when only email is filled', () => {
    renderLogin();
    fireEvent.change(screen.getByPlaceholderText('Email'), { target: { value: 'a@b.com' } });
    expect(screen.getByRole('button', { name: /continue/i })).toBeDisabled();
  });

  it('submit button is disabled when only password is filled', () => {
    renderLogin();
    fireEvent.change(screen.getByPlaceholderText('Password'), { target: { value: 'secret' } });
    expect(screen.getByRole('button', { name: /continue/i })).toBeDisabled();
  });

  it('submit button is enabled when both fields are filled', () => {
    renderLogin();
    fireEvent.change(screen.getByPlaceholderText('Email'), { target: { value: 'a@b.com' } });
    fireEvent.change(screen.getByPlaceholderText('Password'), { target: { value: 'secret' } });
    expect(screen.getByRole('button', { name: /continue/i })).not.toBeDisabled();
  });

  it('calls auth.login with email and password on submit', async () => {
    vi.mocked(auth.login).mockResolvedValue({ authenticated: true, user: mockUser });
    renderLogin();

    fireEvent.change(screen.getByPlaceholderText('Email'), { target: { value: 'admin@reins.local' } });
    fireEvent.change(screen.getByPlaceholderText('Password'), { target: { value: 'secret' } });
    fireEvent.submit(screen.getByRole('button', { name: /continue/i }).closest('form')!);

    await waitFor(() => {
      expect(auth.login).toHaveBeenCalledWith('admin@reins.local', 'secret');
    });
  });

  it('calls onSuccess with user when login succeeds', async () => {
    vi.mocked(auth.login).mockResolvedValue({ authenticated: true, user: mockUser });
    renderLogin();

    fireEvent.change(screen.getByPlaceholderText('Email'), { target: { value: 'admin@reins.local' } });
    fireEvent.change(screen.getByPlaceholderText('Password'), { target: { value: 'secret' } });
    fireEvent.submit(screen.getByRole('button', { name: /continue/i }).closest('form')!);

    await waitFor(() => {
      expect(onSuccess).toHaveBeenCalledWith(mockUser);
    });
  });

  it('shows error message when login fails', async () => {
    vi.mocked(auth.login).mockRejectedValue(new Error('Invalid email or password'));
    renderLogin();

    fireEvent.change(screen.getByPlaceholderText('Email'), { target: { value: 'bad@email.com' } });
    fireEvent.change(screen.getByPlaceholderText('Password'), { target: { value: 'wrong' } });
    fireEvent.submit(screen.getByRole('button', { name: /continue/i }).closest('form')!);

    await waitFor(() => {
      expect(screen.getByText('Invalid email or password')).toBeInTheDocument();
    });
  });

  it('clears the password field on failed login', async () => {
    vi.mocked(auth.login).mockRejectedValue(new Error('Bad credentials'));
    renderLogin();

    const passwordInput = screen.getByPlaceholderText('Password') as HTMLInputElement;
    fireEvent.change(screen.getByPlaceholderText('Email'), { target: { value: 'a@b.com' } });
    fireEvent.change(passwordInput, { target: { value: 'wrong' } });
    fireEvent.submit(screen.getByRole('button', { name: /continue/i }).closest('form')!);

    await waitFor(() => {
      expect(passwordInput.value).toBe('');
    });
  });

  it('clears error message when email input changes', async () => {
    vi.mocked(auth.login).mockRejectedValue(new Error('Bad credentials'));
    renderLogin();

    fireEvent.change(screen.getByPlaceholderText('Email'), { target: { value: 'a@b.com' } });
    fireEvent.change(screen.getByPlaceholderText('Password'), { target: { value: 'wrong' } });
    fireEvent.submit(screen.getByRole('button', { name: /continue/i }).closest('form')!);

    await waitFor(() => {
      expect(screen.getByText('Bad credentials')).toBeInTheDocument();
    });

    fireEvent.change(screen.getByPlaceholderText('Email'), { target: { value: 'new@email.com' } });
    expect(screen.queryByText('Bad credentials')).not.toBeInTheDocument();
  });

  it('does not call onSuccess when authenticated is false', async () => {
    vi.mocked(auth.login).mockResolvedValue({ authenticated: false });
    renderLogin();

    fireEvent.change(screen.getByPlaceholderText('Email'), { target: { value: 'a@b.com' } });
    fireEvent.change(screen.getByPlaceholderText('Password'), { target: { value: 'pw' } });
    fireEvent.submit(screen.getByRole('button', { name: /continue/i }).closest('form')!);

    await waitFor(() => {
      expect(auth.login).toHaveBeenCalled();
    });
    expect(onSuccess).not.toHaveBeenCalled();
  });
});
