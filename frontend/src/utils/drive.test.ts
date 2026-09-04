import { describe, it, expect } from 'vitest';
import { parseDriveFolderId } from './drive';

const ID = '1AbC_dEf-GhIjKlMnOpQrStUvWxYz0123';

describe('parseDriveFolderId', () => {
  it.each([
    ['a bare id', ID],
    ['a bare id with whitespace', `  ${ID}\n`],
    ['a folder URL', `https://drive.google.com/drive/folders/${ID}`],
    ['a folder URL with a query string', `https://drive.google.com/drive/folders/${ID}?usp=sharing`],
    ['a folder URL under an account index', `https://drive.google.com/drive/u/0/folders/${ID}`],
    ['a legacy open URL with an id query param', `https://drive.google.com/open?id=${ID}`],
    ['a file URL', `https://drive.google.com/file/d/${ID}/view?usp=drive_link`],
    ['a docs URL', `https://docs.google.com/document/d/${ID}/edit`],
  ])('accepts %s', (_label, input) => {
    expect(parseDriveFolderId(input)).toBe(ID);
  });

  it('returns null for an empty string', () => {
    expect(parseDriveFolderId('   ')).toBeNull();
  });

  it('returns null for a URL that carries no id', () => {
    expect(parseDriveFolderId('https://drive.google.com/drive/my-drive')).toBeNull();
  });
});
