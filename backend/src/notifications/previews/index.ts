/**
 * Loads every preview builder. Import this module (not approval-preview.ts
 * directly) wherever previews are resolved, so the builders are registered.
 */
import './mail-actions.js';
import './drive.js';
import './linear.js';
import './zendesk.js';
import './notion.js';
import './github.js';
import './pipedrive.js';

export {
  resolveApprovalPreview,
  formatPreviewApprovalMessage,
  hasApprovalPreview,
  previewFromMessageText,
  type ApprovalPreview,
} from '../approval-preview.js';
