import type { InteractionRequest, PermissionPolicy } from '@yanbot-harness/contracts';

export type ToolEffect = 'read' | 'edit' | 'execute' | 'destructive' | 'unknown';
export type PermissionDecisionAction = 'allow' | 'deny' | 'prompt';

export type ToolClassification = {
  effect: ToolEffect;
  risk: 'low' | 'medium' | 'high';
};

export type PermissionDecision = ToolClassification & {
  action: PermissionDecisionAction;
  reason: string;
};

export type PermissionDecisionInput = {
  policy: PermissionPolicy;
  interaction: InteractionRequest;
  workspaceContained?: boolean;
};

const destructivePattern = /(?:delete|remove|unlink|rmdir|truncate|format|overwrite)/i;
const executePattern = /(?:bash|shell|terminal|execute|command|powershell|cmd)/i;
const editPattern = /(?:write|edit|patch|replace|create|mkdir|notebookedit)/i;
const readPattern = /(?:read|list|search|find|glob|grep|inspect|stat)/i;

export function classifyTool(toolName: string): ToolClassification {
  if (destructivePattern.test(toolName)) return { effect: 'destructive', risk: 'high' };
  if (executePattern.test(toolName)) return { effect: 'execute', risk: 'high' };
  if (editPattern.test(toolName)) return { effect: 'edit', risk: 'medium' };
  if (readPattern.test(toolName)) return { effect: 'read', risk: 'low' };
  return { effect: 'unknown', risk: 'high' };
}

export function decidePermission(input: PermissionDecisionInput): PermissionDecision {
  if (input.interaction.kind === 'question') {
    return { action: 'prompt', effect: 'read', risk: 'low', reason: 'Questions require an explicit user answer.' };
  }

  const classified = classifyTool(input.interaction.toolName);
  const risk = maxRisk(classified.risk, input.interaction.risk);

  if (input.policy === 'read-only') {
    return {
      action: 'deny',
      effect: classified.effect,
      risk,
      reason: 'The read-only policy denies requested tool execution.',
    };
  }
  if (input.policy === 'interactive') {
    return {
      action: 'prompt',
      effect: classified.effect,
      risk,
      reason: 'The interactive policy requires an explicit user decision.',
    };
  }
  if (risk === 'high') {
    return {
      action: 'prompt',
      effect: classified.effect,
      risk,
      reason: 'High-risk tools require an explicit user decision.',
    };
  }
  if (classified.effect === 'read') {
    return { action: 'allow', effect: classified.effect, risk, reason: 'Low-risk reads are allowed by auto-edit.' };
  }
  if (classified.effect === 'edit') {
    if (input.workspaceContained === true) {
      return {
        action: 'allow',
        effect: classified.effect,
        risk,
        reason: 'The edit is proven to stay within the granted workspace.',
      };
    }
    if (input.workspaceContained === false) {
      return {
        action: 'deny',
        effect: classified.effect,
        risk: 'high',
        reason: 'The edit resolves outside the granted workspace.',
      };
    }
  }
  return {
    action: 'prompt',
    effect: classified.effect,
    risk,
    reason: 'Unknown or unproven tools require an explicit user decision.',
  };
}

function maxRisk(left: ToolClassification['risk'], right: ToolClassification['risk']): ToolClassification['risk'] {
  const values = { low: 0, medium: 1, high: 2 } as const;
  return values[left] >= values[right] ? left : right;
}
