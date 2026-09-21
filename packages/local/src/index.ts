import { resolveInstalledRuntime, type ResolveInstalledRuntimeOptions } from '@yanbot-harness/runtime';
import { startManagedRuntime as startSdkManagedRuntime, type StartManagedRuntimeOptions } from '@yanbot-harness/sdk';

export * from '@yanbot-harness/sdk';

export type LocalRuntimeOptions = StartManagedRuntimeOptions &
  Pick<ResolveInstalledRuntimeOptions, 'cacheRoot' | 'trustedKeys'>;

const allowedEnvironment = [
  'PATH',
  'Path',
  'SystemRoot',
  'SYSTEMROOT',
  'WINDIR',
  'COMSPEC',
  'PATHEXT',
  'HOME',
  'USERPROFILE',
  'LOCALAPPDATA',
  'APPDATA',
  'TEMP',
  'TMP',
  'TMPDIR',
  'LANG',
  'LC_ALL',
  'XDG_CACHE_HOME',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'http_proxy',
  'https_proxy',
  'no_proxy',
  'NODE_EXTRA_CA_CERTS',
  'SSL_CERT_FILE',
  'YANBOT_HARNESS_RUNTIME_PATH',
  'YANBOT_HARNESS_ADAPTER',
  'YANBOT_HARNESS_ALLOWED_ORIGINS',
  'YANBOT_HARNESS_REFERENCE_SCENARIO',
  'YANBOT_HARNESS_EXTENSIONS_DIR',
  'YANBOT_HARNESS_EXPERIMENTAL_EXTENSIONS',
  'CODEBUDDY_API_KEY_FILE',
  'CODEBUDDY_INTERNET_ENVIRONMENT',
  'CODEBUDDY_BASE_URL',
  'CODEBUDDY_CODE_PATH',
] as const;

export function localRuntimeEnvironment(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): Record<string, string> {
  return Object.fromEntries(
    allowedEnvironment.flatMap((key) => (environment[key] === undefined ? [] : [[key, environment[key]!]])),
  );
}

export function startManagedRuntime(options: LocalRuntimeOptions = {}) {
  const { cacheRoot, trustedKeys, ...sdkOptions } = options;
  return startSdkManagedRuntime({
    ...sdkOptions,
    environment: options.environment ?? localRuntimeEnvironment(),
    runtimeResolver:
      options.runtimeResolver ??
      (({ signal }) =>
        resolveInstalledRuntime({
          signal,
          ...(cacheRoot === undefined ? {} : { cacheRoot }),
          ...(trustedKeys === undefined ? {} : { trustedKeys }),
        })),
  });
}
