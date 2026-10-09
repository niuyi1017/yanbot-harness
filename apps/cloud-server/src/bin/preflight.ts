import { parseCloudConfig } from '../config.js';
import { brokerPoliciesSchema, readPrivateFile, readModelKey } from '../model-broker/policy.js';

// Local validation only: never connects to a provider or prints configuration values.
try {
  const config = parseCloudConfig(process.env);
  if (config.nodeEnv !== 'production') throw new Error();
  if (config.modelBrokerPoliciesFile) {
    const policies = brokerPoliciesSchema.parse(
      JSON.parse(await readPrivateFile(config.modelBrokerPoliciesFile, 256 * 1024)),
    );
    for (const policy of policies.policies) {
      await readModelKey(policy.apiKeyFile);
      if (policy.adapterId === 'cn.tencent.codebuddy' ? !config.experimentalCodeBuddy : !config.experimentalClaudeCli)
        throw new Error();
    }
    for (const [enabled, adapterId] of [
      [config.experimentalClaudeCli, 'com.anthropic.claude-code-cli'],
      [config.experimentalCodeBuddy, 'cn.tencent.codebuddy'],
    ] as const) {
      if (enabled && !policies.policies.some((policy) => policy.adapterId === adapterId)) throw new Error();
    }
  }
  process.stdout.write(
    JSON.stringify({ status: 'passed', scope: 'local-production-configuration', connectivityTested: false }) + '\n',
  );
} catch {
  process.stderr.write(
    'Production preflight failed. Check transport, adapter policy and private configuration files.\n',
  );
  process.exitCode = 1;
}
