import http2 from 'http2';
import jwt from 'jsonwebtoken';
import { client } from '../db/index.js';
import type { ApprovalRequest } from '@reins/shared';

/**
 * Apple Push Notification Service client
 *
 * Uses HTTP/2 to communicate with APNs.
 * Requires:
 * - APNS_KEY_ID: Key ID from Apple Developer Portal
 * - APNS_TEAM_ID: Team ID from Apple Developer Portal
 * - APNS_KEY_PATH: Path to .p8 private key file
 * - APNS_BUNDLE_ID: Your app's bundle identifier
 */

interface APNsConfig {
  keyId: string;
  teamId: string;
  keyPath: string;
  bundleId: string;
  production: boolean;
}

interface DeviceToken {
  id: string;
  deviceId: string;
  token: string;
  platform: 'ios' | 'android';
  userId?: string;
  createdAt: Date;
  updatedAt: Date;
}

interface APNsPayload {
  aps: {
    alert: {
      title: string;
      subtitle?: string;
      body: string;
    };
    badge?: number;
    sound?: string;
    category?: string;
    'mutable-content'?: number;
    'thread-id'?: string;
  };
  approvalId?: string;
  agentId?: string;
  tool?: string;
}

export class APNsService {
  private config: APNsConfig | null = null;
  private jwtToken: string | null = null;
  private jwtIssuedAt: number = 0;
  private readonly JWT_EXPIRY = 3500; // Refresh before 1 hour

  constructor() {
    this.loadConfig();
  }

  private loadConfig() {
    const keyId = process.env.APNS_KEY_ID;
    const teamId = process.env.APNS_TEAM_ID;
    const keyPath = process.env.APNS_KEY_PATH;
    const bundleId = process.env.APNS_BUNDLE_ID || 'com.reins.mobile';
    const production = process.env.APNS_PRODUCTION === 'true';

    if (keyId && teamId && keyPath) {
      this.config = { keyId, teamId, keyPath, bundleId, production };
      console.log('APNs configured successfully');
    } else {
      console.log('APNs not configured - push notifications disabled');
    }
  }

  private getJWT(): string | null {
    if (!this.config) return null;

    const now = Math.floor(Date.now() / 1000);

    // Refresh if token is expired or about to expire
    if (this.jwtToken && (now - this.jwtIssuedAt) < this.JWT_EXPIRY) {
      return this.jwtToken;
    }

    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const fs = require('fs');
      const key = fs.readFileSync(this.config.keyPath);

      this.jwtToken = jwt.sign({}, key, {
        algorithm: 'ES256',
        keyid: this.config.keyId,
        issuer: this.config.teamId,
        expiresIn: '1h',
        header: {
          alg: 'ES256',
          kid: this.config.keyId,
        },
      });

      this.jwtIssuedAt = now;
      return this.jwtToken;
    } catch (error) {
      console.error('Failed to generate APNs JWT:', error);
      return null;
    }
  }

  private getHost(): string {
    if (!this.config) return '';
    return this.config.production
      ? 'api.push.apple.com'
      : 'api.sandbox.push.apple.com';
  }

  /**
   * Send a push notification to a device
   */
  async sendNotification(deviceToken: string, payload: APNsPayload): Promise<boolean> {
    if (!this.config) {
      console.log('APNs not configured, skipping notification');
      return false;
    }

    const token = this.getJWT();
    if (!token) {
      console.error('Failed to get APNs JWT');
      return false;
    }

    return new Promise((resolve) => {
      const client = http2.connect(`https://${this.getHost()}`);

      client.on('error', (err) => {
        console.error('APNs connection error:', err);
        resolve(false);
      });

      const headers = {
        ':method': 'POST',
        ':path': `/3/device/${deviceToken}`,
        'authorization': `bearer ${token}`,
        'apns-topic': this.config!.bundleId,
        'apns-push-type': 'alert',
        'apns-priority': '10',
        'apns-expiration': '0',
      };

      const req = client.request(headers);

      req.on('response', (headers) => {
        const status = headers[':status'];
        if (status === 200) {
          resolve(true);
        } else {
          console.error('APNs request failed with status:', status);
          resolve(false);
        }
        client.close();
      });

      req.on('error', (err) => {
        console.error('APNs request error:', err);
        resolve(false);
        client.close();
      });

      req.setEncoding('utf8');
      req.write(JSON.stringify(payload));
      req.end();
    });
  }

  /**
   * Send approval request notification to all registered devices
   */
  async notifyApprovalRequest(approval: ApprovalRequest): Promise<void> {
    const devices = await this.getIOSDevices();

    if (devices.length === 0) {
      console.log('No iOS devices registered for push notifications');
      return;
    }

    const payload: APNsPayload = {
      aps: {
        alert: {
          title: 'Approval Required',
          subtitle: approval.tool,
          body: approval.context || `Agent ${approval.agentId} needs your approval`,
        },
        badge: await this.getPendingCount(),
        sound: 'default',
        category: 'APPROVAL_REQUEST',
        'mutable-content': 1,
      },
      approvalId: approval.id,
      agentId: approval.agentId,
      tool: approval.tool,
    };

    const results = await Promise.all(
      devices.map((device) => this.sendNotification(device.token, payload))
    );

    const successCount = results.filter(Boolean).length;
    console.log(`Sent approval notification to ${successCount}/${devices.length} devices`);
  }

  /**
   * Send approval resolved notification
   */
  async notifyApprovalResolved(approval: ApprovalRequest): Promise<void> {
    const devices = await this.getIOSDevices();

    if (devices.length === 0) return;

    const payload: APNsPayload = {
      aps: {
        alert: {
          title: `Request ${approval.status === 'approved' ? 'Approved' : 'Rejected'}`,
          body: `${approval.tool} - ${approval.status}`,
        },
        badge: await this.getPendingCount(),
        sound: 'default',
      },
      approvalId: approval.id,
    };

    await Promise.all(
      devices.map((device) => this.sendNotification(device.token, payload))
    );
  }

  /**
   * Get all registered iOS devices
   */
  private async getIOSDevices(): Promise<DeviceToken[]> {
    const result = await client.execute({
      sql: `SELECT * FROM device_tokens WHERE platform = 'ios'`,
      args: [],
    });

    return result.rows.map((row) => ({
      id: row.id as string,
      deviceId: row.device_id as string,
      token: row.token as string,
      platform: row.platform as 'ios' | 'android',
      userId: row.user_id as string | undefined,
      createdAt: new Date(row.created_at as string),
      updatedAt: new Date(row.updated_at as string),
    }));
  }

  /**
   * Get count of pending approvals for badge
   */
  private async getPendingCount(): Promise<number> {
    const result = await client.execute({
      sql: `SELECT COUNT(*) as count FROM approvals WHERE status = 'pending'`,
      args: [],
    });

    return (result.rows[0]?.count as number) || 0;
  }

  /**
   * Register a device for push notifications
   */
  async registerDevice(
    deviceId: string,
    token: string,
    platform: 'ios' | 'android',
    userId?: string
  ): Promise<string> {
    const now = new Date().toISOString();
    const id = `dev_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;

    // Upsert: update if device exists, insert if not
    await client.execute({
      sql: `INSERT INTO device_tokens (id, device_id, token, platform, user_id, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(device_id) DO UPDATE SET
              token = excluded.token,
              updated_at = excluded.updated_at`,
      args: [id, deviceId, token, platform, userId ?? null, now, now],
    });

    return id;
  }

  /**
   * Unregister a device from push notifications
   */
  async unregisterDevice(deviceId: string): Promise<boolean> {
    const result = await client.execute({
      sql: `DELETE FROM device_tokens WHERE device_id = ?`,
      args: [deviceId],
    });

    return result.rowsAffected > 0;
  }
}

export const apnsService = new APNsService();
