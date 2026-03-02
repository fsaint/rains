/**
 * Wire up approval queue events to push notification service
 */
import { approvalQueue } from '../approvals/queue.js';
import { apnsService } from './apns.js';

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
      console.error('Failed to send approval request notification:', error);
    }
  });

  // Send push notification when approval is resolved
  approvalQueue.on('resolved', async (approval) => {
    try {
      await apnsService.notifyApprovalResolved(approval);
    } catch (error) {
      console.error('Failed to send approval resolved notification:', error);
    }
  });

  console.log('Notification handlers initialized');
}
