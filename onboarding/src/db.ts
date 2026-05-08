import postgres from 'postgres';
import { config } from './config.js';

export const sql = postgres(config.databaseUrl);

export interface Applicant {
  telegram_user_id: string;
  username: string | null;
  use_case: string | null;
  gmail_address: string | null;
  state: string;
  minimax_key: string | null;
  bot_token: string | null;
  bot_username: string | null;
  notify_chat_id: string | null;
  agent_id: string | null;
  deployment_id: string | null;
  rejected_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

export async function initDb(): Promise<void> {
  await sql`
    CREATE TABLE IF NOT EXISTS applicants (
      telegram_user_id   BIGINT PRIMARY KEY,
      username           TEXT,
      use_case           TEXT,
      gmail_address      TEXT,
      state              TEXT NOT NULL DEFAULT 'qualification',
      minimax_key        TEXT,
      bot_token          TEXT,
      notify_chat_id     BIGINT,
      agent_id           TEXT,
      deployment_id      TEXT,
      rejected_at        TIMESTAMP,
      created_at         TIMESTAMP NOT NULL DEFAULT NOW(),
      updated_at         TIMESTAMP NOT NULL DEFAULT NOW()
    )
  `;
  // Migrate existing tables
  await sql`ALTER TABLE applicants ADD COLUMN IF NOT EXISTS gmail_address TEXT`;
  await sql`ALTER TABLE applicants ADD COLUMN IF NOT EXISTS bot_username TEXT`;
}

export async function getApplicant(telegramUserId: number): Promise<Applicant | null> {
  const rows = await sql<Applicant[]>`
    SELECT * FROM applicants WHERE telegram_user_id = ${telegramUserId}
  `;
  return rows[0] ?? null;
}

export async function upsertApplicant(
  telegramUserId: number,
  username: string | null,
  updates: Partial<Omit<Applicant, 'telegram_user_id' | 'created_at'>>
): Promise<Applicant> {
  const rows = await sql<Applicant[]>`
    INSERT INTO applicants (telegram_user_id, username, state, updated_at)
    VALUES (${telegramUserId}, ${username}, 'qualification', NOW())
    ON CONFLICT (telegram_user_id) DO UPDATE
    SET updated_at = NOW()
    RETURNING *
  `;
  const applicant = rows[0];

  if (Object.keys(updates).length > 0) {
    return updateApplicant(telegramUserId, updates);
  }

  return applicant;
}

export async function updateApplicant(
  telegramUserId: number,
  updates: Partial<Omit<Applicant, 'telegram_user_id' | 'created_at'>>
): Promise<Applicant> {
  const entries = Object.entries(updates).filter(([, v]) => v !== undefined) as [string, unknown][];

  if (entries.length === 0) {
    const rows = await sql<Applicant[]>`SELECT * FROM applicants WHERE telegram_user_id = ${telegramUserId}`;
    return rows[0];
  }

  const setClauses = entries.map(([k], i) => `${k} = $${i + 2}`).join(', ');
  const values = entries.map(([, v]) => v);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rows = await (sql.unsafe as any)(
    `UPDATE applicants SET ${setClauses}, updated_at = NOW() WHERE telegram_user_id = $1 RETURNING *`,
    [telegramUserId, ...values]
  ) as Applicant[];
  return rows[0];
}
