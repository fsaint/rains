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
  });

  console.log('Notification handlers initialized');
}
