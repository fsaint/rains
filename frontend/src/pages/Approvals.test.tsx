import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import Approvals from './Approvals';

vi.mock('../api/client', () => ({
  approvals: {
    list: vi.fn(),
    approve: vi.fn(),
    reject: vi.fn(),
    requestChanges: vi.fn(),
  },
}));

import { approvals } from '../api/client';

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
  return ({ children }: { children: React.ReactNode }) => (
    <MemoryRouter>
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    </MemoryRouter>
  );
}

const futureDate = new Date(Date.now() + 30 * 60 * 1000).toISOString(); // 30 min from now
const pastDate = new Date(Date.now() - 60 * 1000).toISOString(); // 1 min ago

const mockApproval = {
  id: 'appr-1',
  agentId: 'agent-abc',
  tool: 'gmail_send_message',
  arguments: { to: 'user@example.com', subject: 'Hello' },
  context: 'Sending a confirmation email',
  status: 'pending',
  requestedAt: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
  expiresAt: futureDate,
};

describe('Approvals page', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('shows loading spinner while fetching', () => {
    vi.mocked(approvals.list).mockReturnValue(new Promise(() => {})); // never resolves
    render(<Approvals />, { wrapper: createWrapper() });
    expect(document.querySelector('.animate-spin')).toBeInTheDocument();
  });

  it('shows empty state when there are no approvals', async () => {
    vi.mocked(approvals.list).mockResolvedValue([]);
    render(<Approvals />, { wrapper: createWrapper() });

    await waitFor(() => {
      expect(screen.getByText('No pending approvals')).toBeInTheDocument();
    });
    expect(screen.getByText('All caught up!')).toBeInTheDocument();
  });

  it('renders approval item with tool name', async () => {
    vi.mocked(approvals.list).mockResolvedValue([mockApproval]);
    render(<Approvals />, { wrapper: createWrapper() });

    await waitFor(() => {
      expect(screen.getByText('gmail_send_message')).toBeInTheDocument();
    });
  });

  it('renders agent ID in the approval card', async () => {
    vi.mocked(approvals.list).mockResolvedValue([mockApproval]);
    render(<Approvals />, { wrapper: createWrapper() });

    await waitFor(() => {
      expect(screen.getByText('agent-abc')).toBeInTheDocument();
    });
  });

  it('renders approval context', async () => {
    vi.mocked(approvals.list).mockResolvedValue([mockApproval]);
    render(<Approvals />, { wrapper: createWrapper() });

    await waitFor(() => {
      expect(screen.getByText('Sending a confirmation email')).toBeInTheDocument();
    });
  });

  it('renders serialized arguments', async () => {
    vi.mocked(approvals.list).mockResolvedValue([mockApproval]);
    render(<Approvals />, { wrapper: createWrapper() });

    await waitFor(() => {
      expect(screen.getByText(/user@example\.com/)).toBeInTheDocument();
    });
  });

  // A user approving an email must be able to see what is being attached.
  describe('attachments', () => {
    it('lists each attachment with its size and origin', async () => {
      vi.mocked(approvals.list).mockResolvedValue([
        {
          ...mockApproval,
          arguments: {
            to: 'user@example.com',
            subject: 'Hello',
            attachments: [
              { source: 'gmail', filename: 'invoice.pdf', _bytes: 2_400_000 },
              { source: 'text', filename: 'notes.csv', content: 'a,b' },
            ],
          },
        },
      ]);
      render(<Approvals />, { wrapper: createWrapper() });

      await waitFor(() => {
        expect(screen.getByText('invoice.pdf')).toBeInTheDocument();
      });
      expect(screen.getByText('2.3 MB')).toBeInTheDocument();
      expect(screen.getByText('forwarded from an email')).toBeInTheDocument();
      expect(screen.getByText('notes.csv')).toBeInTheDocument();
      expect(screen.getByText('written by the agent')).toBeInTheDocument();
    });

    it('keeps the attachment payload out of the raw argument dump', async () => {
      vi.mocked(approvals.list).mockResolvedValue([
        {
          ...mockApproval,
          arguments: {
            to: 'user@example.com',
            attachments: [{ source: 'text', filename: 'notes.csv', content: 'SECRETPAYLOAD' }],
          },
        },
      ]);
      render(<Approvals />, { wrapper: createWrapper() });

      await waitFor(() => {
        expect(screen.getByText('notes.csv')).toBeInTheDocument();
      });
      expect(screen.queryByText(/SECRETPAYLOAD/)).not.toBeInTheDocument();
    });

    it('renders no attachment block when there are none', async () => {
      vi.mocked(approvals.list).mockResolvedValue([mockApproval]);
      render(<Approvals />, { wrapper: createWrapper() });

      await waitFor(() => {
        expect(screen.getByText(/user@example\.com/)).toBeInTheDocument();
      });
      expect(screen.queryByText('Attachments')).not.toBeInTheDocument();
    });
  });

  it('renders Approve and Reject buttons', async () => {
    vi.mocked(approvals.list).mockResolvedValue([mockApproval]);
    render(<Approvals />, { wrapper: createWrapper() });

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /approve/i })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /reject/i })).toBeInTheDocument();
    });
  });

  it('calls approvals.approve with the correct id when Approve is clicked', async () => {
    vi.mocked(approvals.list).mockResolvedValue([mockApproval]);
    vi.mocked(approvals.approve).mockResolvedValue({});
    render(<Approvals />, { wrapper: createWrapper() });

    await waitFor(() => screen.getByRole('button', { name: /approve/i }));
    fireEvent.click(screen.getByRole('button', { name: /approve/i }));

    await waitFor(() => {
      expect(approvals.approve).toHaveBeenCalledWith('appr-1');
    });
  });

  it('calls approvals.reject with id and reason when Reject is clicked', async () => {
    vi.mocked(approvals.list).mockResolvedValue([mockApproval]);
    vi.mocked(approvals.reject).mockResolvedValue({});
    render(<Approvals />, { wrapper: createWrapper() });

    await waitFor(() => screen.getByRole('button', { name: /reject/i }));
    fireEvent.click(screen.getByRole('button', { name: /reject/i }));

    await waitFor(() => {
      expect(approvals.reject).toHaveBeenCalledWith('appr-1', 'Rejected by user');
    });
  });

  it('shows time remaining for pending approval', async () => {
    vi.mocked(approvals.list).mockResolvedValue([mockApproval]);
    render(<Approvals />, { wrapper: createWrapper() });

    await waitFor(() => {
      expect(screen.getByText(/\d+m remaining/)).toBeInTheDocument();
    });
  });

  it('shows Expired for past expiresAt', async () => {
    const expiredApproval = { ...mockApproval, expiresAt: pastDate };
    vi.mocked(approvals.list).mockResolvedValue([expiredApproval]);
    render(<Approvals />, { wrapper: createWrapper() });

    await waitFor(() => {
      expect(screen.getByText('Expired')).toBeInTheDocument();
    });
  });

  it('renders multiple approval items', async () => {
    const second = { ...mockApproval, id: 'appr-2', tool: 'drive_delete_file' };
    vi.mocked(approvals.list).mockResolvedValue([mockApproval, second]);
    render(<Approvals />, { wrapper: createWrapper() });

    await waitFor(() => {
      expect(screen.getByText('gmail_send_message')).toBeInTheDocument();
      expect(screen.getByText('drive_delete_file')).toBeInTheDocument();
    });
  });

  it('shows page heading', async () => {
    vi.mocked(approvals.list).mockResolvedValue([]);
    render(<Approvals />, { wrapper: createWrapper() });

    await waitFor(() => {
      expect(screen.getByText('Pending Approvals')).toBeInTheDocument();
    });
  });
  describe('request changes', () => {
    const openCorrectionBox = async () => {
      vi.mocked(approvals.list).mockResolvedValue([mockApproval]);
      render(<Approvals />, { wrapper: createWrapper() });

      await waitFor(() => {
        expect(screen.getByRole('button', { name: /request changes/i })).toBeInTheDocument();
      });
      fireEvent.click(screen.getByRole('button', { name: /request changes/i }));
      return screen.getByLabelText(/what should the agent change/i);
    };

    it('sends the typed feedback back to the agent', async () => {
      vi.mocked(approvals.requestChanges).mockResolvedValue({});

      const textarea = await openCorrectionBox();
      fireEvent.change(textarea, { target: { value: 'drop Bob, make it shorter' } });
      fireEvent.click(screen.getByRole('button', { name: /send back to agent/i }));

      await waitFor(() => {
        expect(approvals.requestChanges).toHaveBeenCalledWith('appr-1', 'drop Bob, make it shorter');
      });
    });

    it('will not send empty feedback', async () => {
      const textarea = await openCorrectionBox();
      fireEvent.change(textarea, { target: { value: '   ' } });

      expect(screen.getByRole('button', { name: /send back to agent/i })).toBeDisabled();
    });

    it('closes the box on cancel without sending', async () => {
      const textarea = await openCorrectionBox();
      fireEvent.change(textarea, { target: { value: 'nope' } });
      fireEvent.click(screen.getByRole('button', { name: /cancel/i }));

      await waitFor(() => {
        expect(screen.queryByLabelText(/what should the agent change/i)).not.toBeInTheDocument();
      });
      expect(approvals.requestChanges).not.toHaveBeenCalled();
    });

    it('hides the button at the revision cap so the user must approve or deny', async () => {
      vi.mocked(approvals.list).mockResolvedValue([{ ...mockApproval, revision: 3 }]);
      render(<Approvals />, { wrapper: createWrapper() });

      await waitFor(() => {
        expect(screen.getByText('gmail_send_message')).toBeInTheDocument();
      });
      expect(screen.queryByRole('button', { name: /request changes/i })).not.toBeInTheDocument();
      expect(screen.getByRole('button', { name: /approve/i })).toBeInTheDocument();
    });

    it('marks a redo so the user knows the agent already revised it', async () => {
      vi.mocked(approvals.list).mockResolvedValue([{ ...mockApproval, revision: 2 }]);
      render(<Approvals />, { wrapper: createWrapper() });

      await waitFor(() => {
        expect(screen.getByText('Revision 2 of 3')).toBeInTheDocument();
      });
    });

    it('shows no revision marker on an original request', async () => {
      vi.mocked(approvals.list).mockResolvedValue([mockApproval]);
      render(<Approvals />, { wrapper: createWrapper() });

      await waitFor(() => {
        expect(screen.getByText('gmail_send_message')).toBeInTheDocument();
      });
      expect(screen.queryByText(/Revision \d+ of/)).not.toBeInTheDocument();
    });
  });
});
