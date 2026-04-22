/**
 * Wire up approval queue events to push notification services
 */
import { approvalQueue } from '../approvals/queue.js';
import { apnsService } from './apns.js';
import { telegramNotifier } from './telegram.js';

/**
 * Initialize notification handlers
 * Call this during server startup to wire events to push notifications
 */
export function initializeNotificationHandlers(): void {
  // Send push notification when new approval request is created
  approvalQueue.on('request', async (approval) => {
    try {
      await apnsService.notifyApprovalRequest(approval);
    } catch (error) {
      console.error('Failed to send APNs approval request notification:', error);
    }
    try {
      await telegramNotifier.notifyApprovalRequest(approval);
    } catch (error) {
      console.error('Failed to send Telegram approval request notification:', error);
    }
  });

  // Send push notification when approval is resolved
  approvalQueue.on('resolved', async (approval) => {
    try {
      await apnsService.notifyApprovalResolved(approval);
    } catch (error) {
      console.error('Failed to send APNs approval resolved notification:', error);
    }
    try {
      await telegramNotifier.notifyApprovalResolved(approval);
    } catch (error) {
      console.error('Failed to send Telegram approval resolved notification:', error);
    }

    // Apply Telegram group config when a group-join approval is approved
    console.info(`[notifications] resolved event: tool=${approval.tool} status=${approval.status} id=${approval.id}`);
    if (approval.tool === 'telegram_group' && approval.status === 'approved') {
      console.info(`[notifications] calling applyGroupConfig for approval ${approval.id}`);
      try {
        const { applyGroupConfig } = await import('../services/agent-bot-relay.js');
        await applyGroupConfig(approval);
      } catch (error) {
        console.error('Failed to apply Telegram group config after approval:', error);
      }
    }
  });

  console.log('Notification handlers initialized');
}
