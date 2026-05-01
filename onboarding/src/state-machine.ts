import type { Context } from 'grammy';
import { getApplicant, upsertApplicant, updateApplicant, type Applicant } from './db.js';

export type ApplicantState =
  | 'qualification'
  | 'pending_approval'
  | 'gmail_oauth'
  | 'minimax_key'
  | 'botfather'
  | 'notify_bot'
  | 'provisioning'
  | 'validating'
  | 'password_setup'
  | 'done'
  | 'rejected';

export type StateHandler = (ctx: Context, applicant: Applicant) => Promise<ApplicantState | void>;

// Lazy-loaded handler dispatch table — avoids circular imports
const handlers: Partial<Record<ApplicantState, StateHandler>> = {};

export function registerHandler(state: ApplicantState, handler: StateHandler): void {
  handlers[state] = handler;
}

export async function handleMessage(ctx: Context): Promise<void> {
  if (!ctx.from) return;

  const telegramUserId = ctx.from.id;
  const username = ctx.from.username ?? null;

  let applicant = await getApplicant(telegramUserId);
  if (!applicant) {
    applicant = await upsertApplicant(telegramUserId, username, {});
  } else if (username && applicant.username !== username) {
    applicant = await updateApplicant(telegramUserId, { username });
  }

  const state = applicant.state as ApplicantState;
  const handler = handlers[state];

  if (!handler) {
    await ctx.reply(`State "${state}" has no handler.`);
    return;
  }

  try {
    let currentState = state;
    let currentApplicant = applicant;
    let currentHandler: StateHandler | null = handler;

    while (currentHandler) {
      const nextState = await currentHandler(ctx, currentApplicant);
      if (!nextState || nextState === currentState) break;

      currentApplicant = await updateApplicant(telegramUserId, { state: nextState });
      currentState = nextState;
      currentHandler = handlers[nextState] ?? null;
    }
  } catch (err) {
    console.log(`[state-machine] Error in state "${state}" for user ${telegramUserId}:`, err instanceof Error ? err.stack : err);
    throw err; // re-throw so bot.catch logs it too
  }
}
