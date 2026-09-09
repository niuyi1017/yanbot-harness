import { query, type CanUseTool, type Options, type PermissionMode } from '@tencent-ai/agent-sdk';

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
  return?(): Promise<IteratorResult<unknown, void>>;
}

type VendorQueryStream = AsyncIterable<unknown> & {
  interrupt(): Promise<void>;
};

/**
 * The vendor Query.return() method only sends an interrupt. Its transport is
 * closed by the async iterator's return()/finally path, so retain and close the
 * exact iterator consumed by the adapter.
 */
export function createClosableQueryStream(source: VendorQueryStream): CodeBuddyQueryStream {
  let iterator: AsyncIterator<unknown, void> | undefined;
  const getIterator = () => (iterator ??= source[Symbol.asyncIterator]());

  return {
    [Symbol.asyncIterator]() {
      return getIterator();
    },
    interrupt() {
      return source.interrupt();
    },
    async return() {
      const activeIterator = getIterator();
      return activeIterator.return
        ? activeIterator.return()
        : ({ done: true, value: undefined } as IteratorResult<unknown, void>);
    },
  };
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
    return createClosableQueryStream(query({ prompt: input.prompt, options }));
  },

  async listModels() {
    throw new Error('CodeBuddy SDK 0.3.254 model discovery is disabled because its CLI process cannot be released.');
  },
};
