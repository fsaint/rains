/**
 * Inviting a user. The admin picks a trial length and nothing else: there is
 * no password, because an invited user signs in with Google.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import AdminUsers from './AdminUsers';

vi.mock('../api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api/client')>();
  return {
    ...actual,
    admin: {
      listUsers: vi.fn(),
      createUser: vi.fn(),
      updateUser: vi.fn(),
      deleteUser: vi.fn(),
      resetPassword: vi.fn(),
    },
  };
});

import { admin } from '../api/client';

const inDays = (n: number) => new Date(Date.now() + n * 86400000).toISOString();

function user(over: Record<string, unknown> = {}) {
  return {
    id: 'u1', email: 'ana@acme.com', name: 'Ana Ruiz', role: 'user', status: 'active',
    trial_ends_at: null, created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    ...over,
  };
}

function renderPage() {
  return render(
    <MemoryRouter>
      <AdminUsers />
    </MemoryRouter>
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(admin.listUsers).mockResolvedValue([user()] as never);
  vi.mocked(admin.createUser).mockResolvedValue(user() as never);
});

describe('inviting a user', () => {
  async function openForm() {
    renderPage();
    await screen.findByText('ana@acme.com');
    fireEvent.click(screen.getByRole('button', { name: /add user|invite|new user/i }));
    return screen.findByLabelText(/free trial/i);
  }

  it('offers only 30, 60 and 90 day trials', async () => {
    const select = await openForm();
    const options = within(select as HTMLElement).getAllByRole('option').map((o) => o.textContent);
    expect(options).toEqual(['30 days', '60 days', '90 days']);
  });

  it('asks for no password at all', async () => {
    await openForm();
    expect(screen.queryByLabelText(/password/i)).toBeNull();
  });

  it('sends the invite with the chosen trial length', async () => {
    const select = await openForm();
    fireEvent.change(screen.getByLabelText(/^email/i), { target: { value: 'new@acme.com' } });
    fireEvent.change(screen.getByLabelText(/^name/i), { target: { value: 'New Person' } });
    fireEvent.change(select, { target: { value: '90' } });
    fireEvent.click(screen.getByRole('button', { name: /send invite/i }));

    await waitFor(() => {
      expect(admin.createUser).toHaveBeenCalledWith(
        expect.objectContaining({ email: 'new@acme.com', name: 'New Person', trialDays: 90 })
      );
    });
    // No password is ever sent, whatever the form looked like.
    expect(vi.mocked(admin.createUser).mock.calls[0][0]).not.toHaveProperty('password');
  });
});

describe('the trial column', () => {
  it('counts down the days left', async () => {
    vi.mocked(admin.listUsers).mockResolvedValue([user({ trial_ends_at: inDays(12) })] as never);
    renderPage();
    expect(await screen.findByText('12 days left')).toBeInTheDocument();
  });

  it('says a trial has ended once the date passes', async () => {
    vi.mocked(admin.listUsers).mockResolvedValue([user({ trial_ends_at: inDays(-2) })] as never);
    renderPage();
    expect(await screen.findByText('ended')).toBeInTheDocument();
  });

  /** A user who predates trials has no date, and is not an expired trial. */
  it('shows a dash, not "ended", when there is no trial', async () => {
    vi.mocked(admin.listUsers).mockResolvedValue([user({ trial_ends_at: null })] as never);
    renderPage();
    await screen.findByText('ana@acme.com');
    expect(screen.queryByText('ended')).toBeNull();
    expect(screen.getByText('—')).toBeInTheDocument();
  });
});
