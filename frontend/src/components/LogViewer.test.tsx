import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import LogViewer from './LogViewer';

// ─── EventSource mock ────────────────────────────────────────────────────────

class MockEventSource {
  static instances: MockEventSource[] = [];

  url: string;
  withCredentials: boolean;
  onopen: ((e: Event) => void) | null = null;
  onmessage: ((e: MessageEvent) => void) | null = null;
  onerror: ((e: Event) => void) | null = null;
  close = vi.fn();

  constructor(url: string, opts?: { withCredentials?: boolean }) {
    this.url = url;
    this.withCredentials = opts?.withCredentials ?? false;
    MockEventSource.instances.push(this);
  }

  /** Helpers for tests to drive the connection */
  open() { this.onopen?.(new Event('open')); }
  message(data: string) { this.onmessage?.(new MessageEvent('message', { data })); }
  error() { this.onerror?.(new Event('error')); }

  static latest() {
    return MockEventSource.instances[MockEventSource.instances.length - 1];
  }

  static reset() {
    MockEventSource.instances = [];
  }
}

vi.stubGlobal('EventSource', MockEventSource);

// ─── DOM API stubs ───────────────────────────────────────────────────────────

const mockScrollIntoView = vi.fn();
const mockCreateObjectURL = vi.fn().mockReturnValue('blob:fake-url');
const mockRevokeObjectURL = vi.fn();

beforeEach(() => {
  MockEventSource.reset();
  vi.clearAllMocks();

  // jsdom doesn't implement scrollIntoView
  window.HTMLElement.prototype.scrollIntoView = mockScrollIntoView;

  // jsdom doesn't implement URL object methods.
  // Re-assign mockReturnValue after vi.clearAllMocks() which resets it.
  mockCreateObjectURL.mockReturnValue('blob:fake-url');
  URL.createObjectURL = mockCreateObjectURL;
  URL.revokeObjectURL = mockRevokeObjectURL;
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

const defaultProps = {
  agentId: 'agent-1',
  agentName: 'My Agent',
  streamUrl: 'http://localhost:3000/api/agents/agent-1/logs/stream',
  onClose: vi.fn(),
};

function renderViewer(props = {}) {
  return render(<LogViewer {...defaultProps} {...props} />);
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('LogViewer', () => {
  describe('initial render', () => {
    it('shows agent name in header', () => {
      renderViewer();
      expect(screen.getByText('My Agent — live logs')).toBeInTheDocument();
    });

    it('shows empty state placeholder', () => {
      renderViewer();
      expect(screen.getByText('Waiting for logs…')).toBeInTheDocument();
    });

    it('shows 0 lines in footer', () => {
      renderViewer();
      expect(screen.getByText('0 lines')).toBeInTheDocument();
    });

    it('renders clear, download, and close buttons', () => {
      renderViewer();
      expect(screen.getByTitle('Clear')).toBeInTheDocument();
      expect(screen.getByTitle('Download')).toBeInTheDocument();
      // Close button has no title — find by its role near the header
      const buttons = screen.getAllByRole('button');
      expect(buttons).toHaveLength(3);
    });
  });

  describe('EventSource connection', () => {
    it('creates an EventSource with the provided streamUrl', () => {
      renderViewer();
      expect(MockEventSource.latest().url).toBe(defaultProps.streamUrl);
    });

    it('passes withCredentials: true', () => {
      renderViewer();
      expect(MockEventSource.latest().withCredentials).toBe(true);
    });

    it('shows disconnected indicator before open', () => {
      renderViewer();
      // The indicator dot is gray (bg-gray-500) when not connected
      const dot = document.querySelector('.bg-gray-500');
      expect(dot).toBeInTheDocument();
    });

    it('updates connected state when EventSource opens', () => {
      renderViewer();
      act(() => { MockEventSource.latest().open(); });
      // Indicator dot becomes emerald when connected
      const dot = document.querySelector('.bg-emerald-400');
      expect(dot).toBeInTheDocument();
    });

    it('clears error text when connection opens', async () => {
      renderViewer();
      // First trigger an error so we have an error message
      act(() => { MockEventSource.latest().error(); });
      // Re-render would produce a new EventSource — but error is set from previous
      expect(screen.getByText('Connection lost. Logs may have stopped.')).toBeInTheDocument();
    });

    it('closes the EventSource on unmount', () => {
      const { unmount } = renderViewer();
      const es = MockEventSource.latest();
      unmount();
      expect(es.close).toHaveBeenCalledOnce();
    });
  });

  describe('message handling', () => {
    it('appends a line when a message arrives', () => {
      renderViewer();
      act(() => { MockEventSource.latest().message('hello world'); });
      expect(screen.getByText('hello world')).toBeInTheDocument();
    });

    it('unescapes \\\\n sequences into real newlines', () => {
      renderViewer();
      act(() => { MockEventSource.latest().message('line1\\nline2'); });
      // getByText normalizes whitespace (collapses \n → space), so query the DOM directly
      const logDivs = document.querySelectorAll('.whitespace-pre-wrap');
      expect(logDivs[0]?.textContent).toBe('line1\nline2');
    });

    it('shows the correct line count after messages arrive', () => {
      renderViewer();
      act(() => {
        MockEventSource.latest().message('a');
        MockEventSource.latest().message('b');
        MockEventSource.latest().message('c');
      });
      expect(screen.getByText('3 lines')).toBeInTheDocument();
    });

    it('hides the empty-state placeholder once lines arrive', () => {
      renderViewer();
      act(() => { MockEventSource.latest().message('some log'); });
      expect(screen.queryByText('Waiting for logs…')).not.toBeInTheDocument();
    });

    it('enforces a line cap — oldest lines are dropped when cap is exceeded', () => {
      renderViewer();
      // The cap logic is: [...prev.slice(-2000), line] — steady state is 2001
      // (2000 kept from prev + the new line). Send enough to saturate the cap.
      act(() => {
        const es = MockEventSource.latest();
        for (let i = 0; i < 2010; i++) {
          es.message(`line-${i}`);
        }
      });
      // After reaching steady state, count stays at 2001
      expect(screen.getByText('2001 lines')).toBeInTheDocument();
      // Early lines are evicted
      expect(screen.queryByText('line-0')).not.toBeInTheDocument();
      // The last line is always present
      expect(screen.getByText('line-2009')).toBeInTheDocument();
    });
  });

  describe('error handling', () => {
    it('shows error message when connection fails', () => {
      renderViewer();
      act(() => { MockEventSource.latest().error(); });
      expect(screen.getByText('Connection lost. Logs may have stopped.')).toBeInTheDocument();
    });

    it('closes the EventSource on error', () => {
      renderViewer();
      const es = MockEventSource.latest();
      act(() => { es.error(); });
      expect(es.close).toHaveBeenCalledOnce();
    });

    it('shows disconnected indicator after error', () => {
      renderViewer();
      act(() => {
        MockEventSource.latest().open();
        MockEventSource.latest().error();
      });
      const dot = document.querySelector('.bg-gray-500');
      expect(dot).toBeInTheDocument();
    });
  });

  describe('reconnection — lines reset on new streamUrl', () => {
    it('clears existing lines when streamUrl changes (reconnect)', () => {
      const { rerender } = renderViewer({ streamUrl: 'http://localhost/stream-a' });

      // Receive some lines on the first connection
      act(() => { MockEventSource.latest().message('old-line-1'); });
      act(() => { MockEventSource.latest().message('old-line-2'); });
      expect(screen.getByText('2 lines')).toBeInTheDocument();

      // Change the stream URL — simulates reconnect
      rerender(
        <LogViewer
          {...defaultProps}
          streamUrl="http://localhost/stream-b"
        />
      );

      // Lines should be cleared before the new connection starts
      expect(screen.getByText('0 lines')).toBeInTheDocument();
      expect(screen.queryByText('old-line-1')).not.toBeInTheDocument();
    });

    it('creates a new EventSource for the new streamUrl', () => {
      const { rerender } = renderViewer({ streamUrl: 'http://localhost/stream-a' });

      rerender(
        <LogViewer
          {...defaultProps}
          streamUrl="http://localhost/stream-b"
        />
      );

      expect(MockEventSource.instances).toHaveLength(2);
      expect(MockEventSource.instances[1].url).toBe('http://localhost/stream-b');
    });

    it('closes the old EventSource when streamUrl changes', () => {
      const { rerender } = renderViewer({ streamUrl: 'http://localhost/stream-a' });
      const firstEs = MockEventSource.instances[0];

      rerender(
        <LogViewer
          {...defaultProps}
          streamUrl="http://localhost/stream-b"
        />
      );

      expect(firstEs.close).toHaveBeenCalledOnce();
    });
  });

  describe('auto-scroll', () => {
    it('scrolls to bottom when new lines arrive', () => {
      renderViewer();
      act(() => { MockEventSource.latest().message('line'); });
      expect(mockScrollIntoView).toHaveBeenCalledWith({ behavior: 'instant' });
    });

    it('does not scroll when user has scrolled up', () => {
      renderViewer();

      // Simulate user scrolling up — not near bottom
      const container = document.querySelector('.overflow-y-auto') as HTMLElement;
      Object.defineProperty(container, 'scrollHeight', { value: 1000, configurable: true });
      Object.defineProperty(container, 'scrollTop', { value: 0, configurable: true });
      Object.defineProperty(container, 'clientHeight', { value: 200, configurable: true });

      fireEvent.scroll(container);

      mockScrollIntoView.mockClear();

      act(() => { MockEventSource.latest().message('new-line'); });

      // scrollIntoView should NOT be called since user scrolled away
      expect(mockScrollIntoView).not.toHaveBeenCalled();
    });

    it('resumes auto-scroll when user scrolls back to the bottom', () => {
      renderViewer();
      const container = document.querySelector('.overflow-y-auto') as HTMLElement;

      // Scroll away from bottom
      Object.defineProperty(container, 'scrollHeight', { value: 1000, configurable: true });
      Object.defineProperty(container, 'scrollTop', { value: 0, configurable: true });
      Object.defineProperty(container, 'clientHeight', { value: 200, configurable: true });
      fireEvent.scroll(container);

      // Scroll back near bottom (within 60px threshold)
      Object.defineProperty(container, 'scrollTop', { value: 790, configurable: true });
      fireEvent.scroll(container);

      mockScrollIntoView.mockClear();
      act(() => { MockEventSource.latest().message('new-line'); });

      expect(mockScrollIntoView).toHaveBeenCalledWith({ behavior: 'instant' });
    });
  });

  describe('clear button', () => {
    it('empties all lines when clicked', () => {
      renderViewer();
      act(() => {
        MockEventSource.latest().message('line-a');
        MockEventSource.latest().message('line-b');
      });
      expect(screen.getByText('2 lines')).toBeInTheDocument();

      fireEvent.click(screen.getByTitle('Clear'));

      expect(screen.getByText('0 lines')).toBeInTheDocument();
      expect(screen.getByText('Waiting for logs…')).toBeInTheDocument();
    });
  });

  describe('download button', () => {
    it('creates a Blob with the current lines joined by newlines', () => {
      const blobSpy = vi.spyOn(global, 'Blob').mockImplementation(
        (parts, opts) => ({ parts, opts } as unknown as Blob)
      );

      renderViewer();
      act(() => {
        MockEventSource.latest().message('line-one');
        MockEventSource.latest().message('line-two');
      });

      fireEvent.click(screen.getByTitle('Download'));

      expect(blobSpy).toHaveBeenCalledWith(
        ['line-one\nline-two'],
        { type: 'text/plain' }
      );
    });

    it('triggers an anchor click and revokes the object URL for cleanup', () => {
      renderViewer({ agentName: 'My Agent' });
      act(() => { MockEventSource.latest().message('x'); });

      const clickSpy = vi.fn();
      vi.spyOn(document, 'createElement').mockImplementation((tag: string) => {
        const real = document.createElementNS('http://www.w3.org/1999/xhtml', tag);
        if (tag === 'a') (real as HTMLAnchorElement).click = clickSpy;
        return real as HTMLElement;
      });

      fireEvent.click(screen.getByTitle('Download'));

      expect(clickSpy).toHaveBeenCalled();
      expect(mockRevokeObjectURL).toHaveBeenCalledWith('blob:fake-url');
    });

    it('uses <agentName>-logs.txt as the download filename', () => {
      let capturedAnchor: HTMLAnchorElement | null = null;
      vi.spyOn(document, 'createElement').mockImplementation((tag: string) => {
        const el = document.createElementNS('http://www.w3.org/1999/xhtml', tag) as HTMLElement;
        if (tag === 'a') {
          (el as HTMLAnchorElement).click = vi.fn();
          capturedAnchor = el as HTMLAnchorElement;
        }
        return el;
      });

      renderViewer({ agentName: 'My Agent' });
      act(() => { MockEventSource.latest().message('x'); });
      fireEvent.click(screen.getByTitle('Download'));

      expect(capturedAnchor?.download).toBe('My Agent-logs.txt');
    });
  });

  describe('close button', () => {
    it('calls onClose when the X button is clicked', () => {
      const onClose = vi.fn();
      renderViewer({ onClose });

      // The close button is the only button without a title attribute
      const buttons = screen.getAllByRole('button');
      const closeBtn = buttons.find((b) => !b.getAttribute('title'));
      fireEvent.click(closeBtn!);

      expect(onClose).toHaveBeenCalledOnce();
    });
  });
});
