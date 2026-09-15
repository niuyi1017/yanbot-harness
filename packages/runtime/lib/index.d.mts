export type RuntimeLaunchDescriptor = {
  entryPath: string;
  runtimeVersion: string;
  protocolVersion: string;
  managedProtocolVersion: 1;
};
export type ResolveInstalledRuntimeOptions = {
  cacheRoot?: string;
  signal?: AbortSignal;
  /** Explicit host trust decision. No keys are read from payloads. */
  trustedKeys?: Readonly<Record<string, string>>;
};
export declare class RuntimeResolutionError extends Error {
  readonly reason: string;
  constructor(reason: string, message: string);
}
export declare function currentTarget(): { os: string; cpu: string; libc: string | null };
export declare function resolveInstalledRuntime(
  options?: ResolveInstalledRuntimeOptions,
): Promise<RuntimeLaunchDescriptor>;
