import { describe, expect, it } from 'vitest';

import { classifyTool, decidePermission } from '../src/index.js';

describe('permission engine', () => {
  it('classifies destructive, executable, editable, readable, and unknown tools conservatively', () => {
    expect(classifyTool('mcp__files__delete_file')).toEqual({ effect: 'destructive', risk: 'high' });
    expect(classifyTool('Bash')).toEqual({ effect: 'execute', risk: 'high' });
    expect(classifyTool('NotebookEdit')).toEqual({ effect: 'edit', risk: 'medium' });
    expect(classifyTool('Read')).toEqual({ effect: 'read', risk: 'low' });
    expect(classifyTool('NovelTool')).toEqual({ effect: 'unknown', risk: 'high' });
  });

  it('denies tool interactions in read-only mode and prompts for questions', () => {
    expect(
      decidePermission({
        policy: 'read-only',
        interaction: { kind: 'permission', requestId: 'request', toolName: 'Write', risk: 'medium' },
      }).action,
    ).toBe('deny');
    expect(
      decidePermission({
        policy: 'read-only',
        interaction: {
          kind: 'question',
          requestId: 'question',
          questions: [{ id: 'answer', prompt: 'Continue?' }],
        },
      }).action,
    ).toBe('prompt');
  });

  it('only auto-allows edits proven to remain in the granted workspace', () => {
    const interaction = {
      kind: 'permission' as const,
      requestId: 'request',
      toolName: 'Edit',
      risk: 'medium' as const,
    };
    expect(decidePermission({ policy: 'auto-edit', interaction, workspaceContained: true }).action).toBe('allow');
    expect(decidePermission({ policy: 'auto-edit', interaction, workspaceContained: false }).action).toBe('deny');
    expect(decidePermission({ policy: 'auto-edit', interaction }).action).toBe('prompt');
  });

  it('never auto-allows commands or unknown tools', () => {
    for (const toolName of ['Bash', 'NovelTool']) {
      expect(
        decidePermission({
          policy: 'auto-edit',
          interaction: { kind: 'permission', requestId: toolName, toolName, risk: 'low' },
          workspaceContained: true,
        }).action,
      ).toBe('prompt');
    }
    expect(
      decidePermission({
        policy: 'auto-edit',
        interaction: { kind: 'permission', requestId: 'elevated-read', toolName: 'Read', risk: 'high' },
        workspaceContained: true,
      }).action,
    ).toBe('prompt');
  });
});
