import {
  query,
  unstable_v2_createSession,
  type CanUseTool,
  type Options,
  type PermissionMode,
} from '@tencent-ai/agent-sdk';

type SettingSource = 'user' | 'project' | 'local';

export type CodeBuddyPermissionResult =
  | { behavior: 'allow'; updatedInput: Record<string, unknown> }
  | { behavior: 'deny'; message: string };

export type CodeBuddyCanUseTool = (
  toolName: string,
  input: Record<string, unknown>,
  options: { toolUseID: string; decisionReason?: string },
) => Promise<CodeBuddyPermissionResult>;

export type CodeBuddyQueryInput = {
  prompt: string;
  cwd?: string;
  model?: string;
  maxTurns?: number;
  systemPrompt?: string;
  permissionMode: PermissionMode;
  settingSources: SettingSource[];
  resume?: string;
  env: Record<string, string>;
  pathToCodebuddyCode?: string;
  abortController: AbortController;
  canUseTool: CodeBuddyCanUseTool;
};

export interface CodeBuddyQueryStream extends AsyncIterable<unknown> {
  interrupt(): Promise<void>;
}

export type CodeBuddyModelInput = {
  cwd?: string;
  env: Record<string, string>;
  pathToCodebuddyCode?: string;
  settingSources: SettingSource[];
};

export interface CodeBuddySdkFacade {
  query(input: CodeBuddyQueryInput): CodeBuddyQueryStream;
  listModels(input: CodeBuddyModelInput): Promise<Array<{ modelId: string; name: string; description?: string }>>;
}

export const defaultCodeBuddySdkFacade: CodeBuddySdkFacade = {
  query(input) {
    const options: Options = {
      permissionMode: input.permissionMode,
      settingSources: input.settingSources,
      env: input.env,
      abortController: input.abortController,
      includePartialMessages: true,
      canUseTool: input.canUseTool as CanUseTool,
      ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
      ...(input.model === undefined ? {} : { model: input.model }),
      ...(input.maxTurns === undefined ? {} : { maxTurns: input.maxTurns }),
      ...(input.systemPrompt === undefined ? {} : { systemPrompt: input.systemPrompt }),
      ...(input.resume === undefined ? {} : { resume: input.resume }),
      ...(input.pathToCodebuddyCode === undefined ? {} : { pathToCodebuddyCode: input.pathToCodebuddyCode }),
    };
    return query({ prompt: input.prompt, options });
  },

  async listModels(input) {
    const session = unstable_v2_createSession({
      permissionMode: 'plan',
      settingSources: input.settingSources,
      env: input.env,
      ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
      ...(input.pathToCodebuddyCode === undefined ? {} : { pathToCodebuddyCode: input.pathToCodebuddyCode }),
    });
    try {
      return await session.getAvailableModels();
    } finally {
      session.close();
    }
  },
};
