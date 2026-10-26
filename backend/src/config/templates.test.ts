import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { findTemplatesDir } from './templates.js';

describe('findTemplatesDir', () => {
  it('finds the repo templates from the source tree', () => {
    const dir = findTemplatesDir();
    expect(dir).not.toBeNull();
    expect(dir!.endsWith('templates')).toBe(true);
  });

  it('finds templates from the bundled layout used in the image', () => {
    // /app/backend/dist/index.js with templates at /app/templates
    const app = mkdtempSync(join(tmpdir(), 'reins-app-'));
    mkdirSync(join(app, 'templates', 'skills'), { recursive: true });
    mkdirSync(join(app, 'backend', 'dist'), { recursive: true });

    expect(findTemplatesDir(join(app, 'backend', 'dist'))).toBe(join(app, 'templates'));
  });

  it('returns null when no templates directory exists above', () => {
    const empty = mkdtempSync(join(tmpdir(), 'reins-none-'));
    expect(findTemplatesDir(empty)).toBeNull();
  });
});
