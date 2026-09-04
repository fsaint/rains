/**
 * The folder id behind whatever a user pastes into a Drive folder field.
 *
 * People copy the address bar, not the id, so a bare id, a folder URL (with
 * or without the /u/<n>/ account segment or a query string), the legacy
 * open?id= form, and a file or docs /d/<id>/ URL are all accepted. The backend
 * applies the same rules, so what is stored here matches what is resolved there.
 *
 * Returns null when nothing id-like can be found.
 */
export function parseDriveFolderId(input: string): string | null {
  const text = input.trim();
  if (!text) return null;

  // Google ids are URL-safe: letters, digits, underscore, hyphen.
  const ID = '([A-Za-z0-9_-]+)';
  const patterns = [
    new RegExp(`/folders/${ID}`),
    new RegExp(`/d/${ID}`),
    new RegExp(`[?&]id=${ID}`),
  ];
  for (const re of patterns) {
    const match = text.match(re);
    if (match) return match[1];
  }

  // Not a URL at all: accept it as a bare id.
  if (/^[A-Za-z0-9_-]+$/.test(text)) return text;

  return null;
}
