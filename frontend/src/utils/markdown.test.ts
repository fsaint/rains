import { describe, it, expect } from 'vitest';
import { renderMarkdown } from './markdown';

describe('renderMarkdown', () => {
  it('links http(s), mailto and relative URLs', () => {
    expect(renderMarkdown('[a](https://x.com/p)')).toContain('href="https://x.com/p"');
    expect(renderMarkdown('[a](/memory/1)')).toContain('href="/memory/1"');
  });

  it.each(['javascript:alert(1)', ' JavaScript:alert(1)', 'data:text/html,x'])('does not link %s', (url) => {
    expect(renderMarkdown(`[a](${url})`)).not.toContain('<a href');
  });

  it('does not let a URL break out of the href attribute', () => {
    const html = renderMarkdown('[x](https://a.com/ #onmouseover)');
    expect(html).not.toContain('<a href');
    expect(html).not.toMatch(/\sonmouseover\s*=/);
  });

  it('escapes raw HTML and quotes', () => {
    const html = renderMarkdown('<img src=x onerror=alert(1)> "q"');
    expect(html).not.toContain('<img');
    expect(html).toContain('&quot;q&quot;');
  });
});
