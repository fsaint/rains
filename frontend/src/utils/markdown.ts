const INDEX_TYPE_MAP: Record<string, string> = {
  People: 'person',
  Companies: 'company',
  Projects: 'project',
  Notes: 'note',
};

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^\w-]/g, '')
    .replace(/^-+|-+$/g, '');
}

/** Simple Markdown renderer (subset). Escapes HTML and quotes, and only links http(s)/mailto/relative URLs. */
export function renderMarkdown(
  md: string,
  resolvedLinks: Record<string, string> = {},
  isIndex = false,
  resolvedHeadings: Record<string, string | null> = {},
  transclusions: Record<string, { id: string; title: string; content: string }> = {},
): string {
  void transclusions; // placeholder refs replaced post-render
  return md
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/!\[\[([^\]]+)\]\]/g, (_, title) =>
      `<div class="transclusion-placeholder" data-transclude="${title.trim()}"></div>`)
    .replace(/^### (.+)$/gm, (_, text) =>
      `<h3 id="${slugify(text)}" class="text-lg font-semibold text-white mt-4 mb-1">${text}</h3>`)
    .replace(/^## (.+)$/gm, (_, name) => {
      const typeFilter = isIndex ? INDEX_TYPE_MAP[name.trim()] : undefined;
      return typeFilter
        ? `<h2 id="${slugify(name)}" class="text-xl font-semibold mt-6 mb-2"><a data-typefilter="${typeFilter}" class="text-trust-blue hover:underline cursor-pointer">${name}</a></h2>`
        : `<h2 id="${slugify(name)}" class="text-xl font-semibold text-white mt-6 mb-2">${name}</h2>`;
    })
    .replace(/^# (.+)$/gm, (_, text) =>
      `<h1 id="${slugify(text)}" class="text-2xl font-bold text-white mt-6 mb-3">${text}</h1>`)
    .replace(/\*\*(.+?)\*\*/g, '<strong class="text-white font-semibold">$1</strong>')
    .replace(/\*(.+?)\*/g, '<em class="italic">$1</em>')
    .replace(/`(.+?)`/g, '<code class="bg-white/10 rounded px-1 text-sm font-mono text-green-300">$1</code>')
    .replace(/((?:^|\s))#([a-z][a-z0-9-]*)/gi, (_, lead, tag) =>
      `${lead}<a data-tag="${tag.toLowerCase()}" class="text-trust-blue/80 hover:text-trust-blue cursor-pointer text-sm">#${tag}</a>`)
    .replace(/\[\[([^\]|#]+?)(?:#([^\]|]+))?\]\]/g, (_, name, heading) => {
      const id = resolvedLinks[name.trim()];
      const effectiveHeading = heading?.trim() ?? resolvedHeadings[name.trim()] ?? null;
      if (id) {
        const headingAttr = effectiveHeading ? ` data-heading="${slugify(effectiveHeading)}"` : '';
        return `<a data-wikilink="${id}"${headingAttr} class="text-trust-blue underline cursor-pointer hover:text-trust-blue/80">${name.trim()}${heading ? `#${heading.trim()}` : ''}</a>`;
      }
      return `<span class="text-amber-400 underline decoration-dotted" title="No entry named '${name.trim()}' yet">${name.trim()}${heading ? `#${heading.trim()}` : ''}</span>`;
    })
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, (m, text, url) =>
      /^(https?:|mailto:|\/|#)/i.test(url.trim())
        ? `<a href="${url.trim()}" class="text-trust-blue underline" target="_blank" rel="noopener">${text}</a>`
        : m)
    .replace(/^- (.+)$/gm, '<li class="ml-4 list-disc text-gray-300">$1</li>')
    .replace(/\n{2,}/g, '</p><p class="mb-2">')
    .replace(/\n/g, '<br/>');
}

