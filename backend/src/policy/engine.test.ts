/**
 * Policy Engine Tests
 */

import { describe, it, expect } from 'vitest';
import { PolicyEngine } from './engine.js';
import type { ParsedPolicy } from '@reins/shared';

const engine = new PolicyEngine();

describe('PolicyEngine', () => {
  // ==========================================================================
  // parsePolicy
  // ==========================================================================

  describe('parsePolicy', () => {
    it('should parse a valid policy YAML', () => {
      const yaml = `
version: "1.0"
services:
  gmail:
    tools:
      allow: [list_messages, read_message]
      block: [delete_message]
    constraints:
      list_messages:
        max_results: 50
    approval_required:
      - send_message
`;
      const result = engine.parsePolicy(yaml);

      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
      expect(result.parsed).toBeDefined();
      expect(result.parsed!.version).toBe('1.0');
      expect(result.parsed!.services.gmail.tools!.allow).toEqual(['list_messages', 'read_message']);
      expect(result.parsed!.services.gmail.tools!.block).toEqual(['delete_message']);
    });

    it('should reject invalid YAML syntax', () => {
      const result = engine.parsePolicy('{ invalid: yaml: [');

      expect(result.valid).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
      expect(result.errors[0].path).toBe('root');
      expect(result.errors[0].message).toContain('Invalid YAML');
    });

    it('should reject non-object YAML', () => {
      const result = engine.parsePolicy('"just a string"');

      expect(result.valid).toBe(false);
      expect(result.errors[0].message).toBe('Policy must be an object');
    });

    it('should require version field', () => {
      const result = engine.parsePolicy(`
services:
  gmail:
    tools:
      allow: [read_message]
`);
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.path === 'version')).toBe(true);
    });

    it('should require services field', () => {
      const result = engine.parsePolicy(`version: "1.0"`);

      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.path === 'services')).toBe(true);
    });

    it('should validate tools.allow is an array', () => {
      const result = engine.parsePolicy(`
version: "1.0"
services:
  gmail:
    tools:
      allow: "not_an_array"
`);
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.message.includes('Allow list must be an array'))).toBe(true);
    });

    it('should validate tools.block is an array', () => {
      const result = engine.parsePolicy(`
version: "1.0"
services:
  gmail:
    tools:
      block: "not_an_array"
`);
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.message.includes('Block list must be an array'))).toBe(true);
    });

    it('should validate approval_required is an array', () => {
      const result = engine.parsePolicy(`
version: "1.0"
services:
  gmail:
    approval_required: "not_an_array"
`);
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.message.includes('Approval required must be an array'))).toBe(true);
    });

    it('should validate constraints is an object', () => {
      const result = engine.parsePolicy(`
version: "1.0"
services:
  gmail:
    constraints: "not_an_object"
`);
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.message.includes('Constraints must be an object'))).toBe(true);
    });

    it('should reject non-object service policy', () => {
      const result = engine.parsePolicy(`
version: "1.0"
services:
  gmail: "not_an_object"
`);
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.message.includes('Service policy must be an object'))).toBe(true);
    });

    it('should parse policy with multiple services', () => {
      const result = engine.parsePolicy(`
version: "1.0"
services:
  gmail:
    tools:
      allow: [read_message]
  drive:
    tools:
      allow: [list_files]
  calendar:
    tools:
      block: [delete_event]
`);
      expect(result.valid).toBe(true);
      expect(Object.keys(result.parsed!.services)).toEqual(['gmail', 'drive', 'calendar']);
    });

    it('should preserve agent field if present', () => {
      const result = engine.parsePolicy(`
version: "1.0"
agent: research-bot
services:
  gmail:
    tools:
      allow: [read_message]
`);
      expect(result.valid).toBe(true);
      expect(result.parsed!.agent).toBe('research-bot');
    });

    it('should accept camelCase approvalRequired', () => {
      const result = engine.parsePolicy(`
version: "1.0"
services:
  gmail:
    approvalRequired:
      - send_message
`);
      expect(result.valid).toBe(true);
    });
  });

  // ==========================================================================
  // evaluateTool
  // ==========================================================================

  describe('evaluateTool', () => {
    const policy: ParsedPolicy = {
      version: '1.0',
      services: {
        gmail: {
          tools: {
            allow: ['list_messages', 'read_message', 'send_message'],
            block: ['delete_message'],
          },
          approvalRequired: ['send_message'],
        },
        drive: {
          tools: {
            allow: ['list_files'],
          },
        },
        calendar: {},
      },
    };

    it('should allow tools in the allow list', () => {
      const decision = engine.evaluateTool('list_messages', 'gmail', policy);
      expect(decision.action).toBe('allow');
    });

    it('should block tools in the block list (takes precedence)', () => {
      const decision = engine.evaluateTool('delete_message', 'gmail', policy);
      expect(decision.action).toBe('block');
      expect('reason' in decision && decision.reason).toContain('explicitly blocked');
    });

    it('should block tools not in allow list when allow list exists', () => {
      const decision = engine.evaluateTool('create_draft', 'gmail', policy);
      expect(decision.action).toBe('block');
      expect('reason' in decision && decision.reason).toContain('not in the allow list');
    });

    it('should require approval for tools in approval_required', () => {
      const decision = engine.evaluateTool('send_message', 'gmail', policy);
      expect(decision.action).toBe('require_approval');
    });

    it('should block tools for undefined services', () => {
      const decision = engine.evaluateTool('some_tool', 'unknown_service', policy);
      expect(decision.action).toBe('block');
      expect('reason' in decision && decision.reason).toContain('No policy defined');
    });

    it('should allow any tool when service has no tools policy', () => {
      const decision = engine.evaluateTool('any_tool', 'calendar', policy);
      expect(decision.action).toBe('allow');
    });

    it('should handle snake_case approval_required', () => {
      const snakePolicy: ParsedPolicy = {
        version: '1.0',
        services: {
          gmail: {
            tools: { allow: ['draft_email'] },
          },
        },
      };
      // Set approval_required via snake_case
      (snakePolicy.services.gmail as any).approval_required = ['draft_email'];

      const decision = engine.evaluateTool('draft_email', 'gmail', snakePolicy);
      expect(decision.action).toBe('require_approval');
    });
  });

  // ==========================================================================
  // applyConstraints
  // ==========================================================================

  describe('applyConstraints', () => {
    const policy: ParsedPolicy = {
      version: '1.0',
      services: {
        gmail: {
          constraints: {
            search_messages: {
              max_results: 50,
              query_prefix: 'in:inbox',
            },
          },
        },
      },
    };

    it('should cap max_results to constraint value', () => {
      const args = { max_results: 100 };
      const result = engine.applyConstraints('search_messages', 'gmail', args, policy);
      expect(result.max_results).toBe(50);
    });

    it('should keep max_results if under constraint', () => {
      const args = { max_results: 20 };
      const result = engine.applyConstraints('search_messages', 'gmail', args, policy);
      expect(result.max_results).toBe(20);
    });

    it('should prepend query_prefix if missing', () => {
      const args = { query: 'from:alice' };
      const result = engine.applyConstraints('search_messages', 'gmail', args, policy);
      expect(result.query).toBe('in:inbox from:alice');
    });

    it('should not double-prepend query_prefix', () => {
      const args = { query: 'in:inbox from:alice' };
      const result = engine.applyConstraints('search_messages', 'gmail', args, policy);
      expect(result.query).toBe('in:inbox from:alice');
    });

    it('should return args unchanged for unconstrained tools', () => {
      const args = { query: 'anything', max_results: 999 };
      const result = engine.applyConstraints('read_message', 'gmail', args, policy);
      expect(result).toEqual(args);
    });

    it('should return args unchanged for unconstrained services', () => {
      const args = { query: 'anything' };
      const result = engine.applyConstraints('search', 'drive', args, policy);
      expect(result).toEqual(args);
    });

    it('should not mutate original args', () => {
      const args = { max_results: 100 };
      engine.applyConstraints('search_messages', 'gmail', args, policy);
      expect(args.max_results).toBe(100);
    });
  });

  // ==========================================================================
  // filterTools
  // ==========================================================================

  describe('filterTools', () => {
    const policy: ParsedPolicy = {
      version: '1.0',
      services: {
        gmail: {
          tools: {
            allow: ['list_messages', 'read_message', 'send_message'],
            block: ['delete_message'],
          },
          approvalRequired: ['send_message'],
        },
      },
    };

    it('should remove blocked tools', () => {
      const tools = [
        { name: 'list_messages' },
        { name: 'delete_message' },
        { name: 'read_message' },
      ];
      const result = engine.filterTools(tools, 'gmail', policy);

      expect(result.map(t => t.name)).toEqual(['list_messages', 'read_message']);
    });

    it('should mark approval-required tools', () => {
      const tools = [{ name: 'send_message' }, { name: 'list_messages' }];
      const result = engine.filterTools(tools, 'gmail', policy);

      expect(result.find(t => t.name === 'send_message')!.requiresApproval).toBe(true);
      expect(result.find(t => t.name === 'list_messages')!.requiresApproval).toBe(false);
    });

    it('should remove tools not in allow list', () => {
      const tools = [
        { name: 'list_messages' },
        { name: 'unknown_tool' },
      ];
      const result = engine.filterTools(tools, 'gmail', policy);

      expect(result.map(t => t.name)).toEqual(['list_messages']);
    });

    it('should return empty array for undefined service', () => {
      const tools = [{ name: 'some_tool' }];
      const result = engine.filterTools(tools, 'unknown', policy);
      expect(result).toHaveLength(0);
    });

    it('should preserve additional tool properties', () => {
      const tools = [{ name: 'list_messages', description: 'List all messages' }];
      const result = engine.filterTools(tools, 'gmail', policy);

      expect(result[0]).toHaveProperty('description', 'List all messages');
    });
  });
});
