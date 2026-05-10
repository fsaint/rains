import type { Context } from 'grammy';
import type { Applicant } from '../db.js';
import { config } from '../config.js';

// The platform now provides the MiniMax API key — users are never asked to supply one.
// This handler exists only to auto-advance applicants who were left in this state
// by an older version of the onboarding flow.
export async function handleMinimaxKey(
  _ctx: Context,
  _applicant: Applicant
): Promise<'botfather' | 'notify_bot'> {
  return config.sharedBotEnabled ? 'notify_bot' : 'botfather';
}
