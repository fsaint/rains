import { parse as parseYaml } from 'yaml';
import type { ParsedPolicy, ServicePolicy, ToolDecision, ToolConstraints } from '@reins/shared';

export interface PolicyValidationError {
  path: string;
  message: string;
}

export interface PolicyValidationResult {
  valid: boolean;
  errors: PolicyValidationError[];
  parsed?: ParsedPolicy;
}

export class PolicyEngine {
  /**
   * Parse and validate a policy YAML string
   */
  parsePolicy(yaml: string): PolicyValidationResult {
    const errors: PolicyValidationError[] = [];

    let parsed: unknown;
    try {
      parsed = parseYaml(yaml);
    } catch (e) {
      return {
        valid: false,
        errors: [{ path: 'root', message: `Invalid YAML: ${(e as Error).message}` }],
      };
    }

    if (!parsed || typeof parsed !== 'object') {
      return {
        valid: false,
        errors: [{ path: 'root', message: 'Policy must be an object' }],
      };
    }

    const policy = parsed as Record<string, unknown>;

    // Validate version
    if (!policy.version || typeof policy.version !== 'string') {
      errors.push({ path: 'version', message: 'Version is required and must be a string' });
    }

    // Validate services
    if (!policy.services || typeof policy.services !== 'object') {
      errors.push({ path: 'services', message: 'Services object is required' });
    } else {
      for (const [serviceName, servicePolicy] of Object.entries(policy.services as Record<string, unknown>)) {
        const serviceErrors = this.validateServicePolicy(serviceName, servicePolicy);
        errors.push(...serviceErrors);
      }
    }

    if (errors.length > 0) {
      return { valid: false, errors };
    }

    return {
      valid: true,
      errors: [],
      parsed: {
        version: policy.version as string,
        agent: policy.agent as string | undefined,
        services: policy.services as Record<string, ServicePolicy>,
      },
    };
  }

  private validateServicePolicy(serviceName: string, policy: unknown): PolicyValidationError[] {
    const errors: PolicyValidationError[] = [];
    const path = `services.${serviceName}`;

    if (!policy || typeof policy !== 'object') {
      errors.push({ path, message: 'Service policy must be an object' });
      return errors;
    }

    const servicePolicy = policy as Record<string, unknown>;

    // Validate tools
    if (servicePolicy.tools) {
      if (typeof servicePolicy.tools !== 'object') {
        errors.push({ path: `${path}.tools`, message: 'Tools must be an object' });
      } else {
        const tools = servicePolicy.tools as Record<string, unknown>;
        if (tools.allow && !Array.isArray(tools.allow)) {
          errors.push({ path: `${path}.tools.allow`, message: 'Allow list must be an array' });
        }
        if (tools.block && !Array.isArray(tools.block)) {
          errors.push({ path: `${path}.tools.block`, message: 'Block list must be an array' });
        }
      }
    }

    // Validate constraints
    if (servicePolicy.constraints && typeof servicePolicy.constraints !== 'object') {
      errors.push({ path: `${path}.constraints`, message: 'Constraints must be an object' });
    }

    // Validate approval_required / approvalRequired
    const approvalRequired = servicePolicy.approval_required ?? servicePolicy.approvalRequired;
    if (approvalRequired && !Array.isArray(approvalRequired)) {
      errors.push({ path: `${path}.approval_required`, message: 'Approval required must be an array' });
    }

    return errors;
  }

  /**
   * Evaluate whether a tool is allowed by a policy
   */
  evaluateTool(
    tool: string,
    service: string,
    policy: ParsedPolicy
  ): ToolDecision {
    const servicePolicy = policy.services[service];

    // No policy for this service - block by default
    if (!servicePolicy) {
      return { action: 'block', reason: `No policy defined for service: ${service}` };
    }

    const toolsPolicy = servicePolicy.tools;

    // Check block list first (explicit blocks take precedence)
    if (toolsPolicy?.block?.includes(tool)) {
      return { action: 'block', reason: `Tool "${tool}" is explicitly blocked` };
    }

    // Check allow list
    if (toolsPolicy?.allow) {
      // If allow list exists, tool must be in it
      if (!toolsPolicy.allow.includes(tool)) {
        return { action: 'block', reason: `Tool "${tool}" is not in the allow list` };
      }
    }

    // Check if approval is required
    const approvalRequired = servicePolicy.approvalRequired ?? (servicePolicy as { approval_required?: string[] }).approval_required;
    if (approvalRequired?.includes(tool)) {
      return { action: 'require_approval' };
    }

    return { action: 'allow' };
  }

  /**
   * Apply constraints to tool arguments
   */
  applyConstraints(
    tool: string,
    service: string,
    args: Record<string, unknown>,
    policy: ParsedPolicy
  ): Record<string, unknown> {
    const servicePolicy = policy.services[service];
    if (!servicePolicy?.constraints?.[tool]) {
      return args;
    }

    const constraints = servicePolicy.constraints[tool] as ToolConstraints;
    const constrainedArgs = { ...args };

    // Apply each constraint
    for (const [key, constraint] of Object.entries(constraints)) {
      if (key === 'max_results' && typeof constrainedArgs.max_results === 'number') {
        constrainedArgs.max_results = Math.min(
          constrainedArgs.max_results,
          constraint as number
        );
      }

      if (key === 'query_prefix' && typeof constrainedArgs.query === 'string') {
        const prefix = constraint as string;
        if (!constrainedArgs.query.startsWith(prefix)) {
          constrainedArgs.query = `${prefix} ${constrainedArgs.query}`;
        }
      }

      if (key === 'allowed_paths' && Array.isArray(constraint)) {
        // Path validation would be implemented here
        // For now, just pass through
      }
    }

    return constrainedArgs;
  }

  /**
   * Filter a list of tools based on policy
   */
  filterTools(
    tools: Array<{ name: string }>,
    service: string,
    policy: ParsedPolicy
  ): Array<{ name: string; requiresApproval: boolean }> {
    return tools
      .map((tool) => {
        const decision = this.evaluateTool(tool.name, service, policy);
        if (decision.action === 'block') {
          return null;
        }
        return {
          ...tool,
          requiresApproval: decision.action === 'require_approval',
        };
      })
      .filter((tool): tool is NonNullable<typeof tool> => tool !== null);
  }
}

export const policyEngine = new PolicyEngine();
