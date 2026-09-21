import assert from 'node:assert/strict';
import { test } from 'node:test';
import { launcherEnvironment } from '../lib/launcher-environment.mjs';

test('standalone launcher retains file credentials and OS configuration but drops installer tokens and injection', () => {
  assert.deepEqual(
    launcherEnvironment({
      PATH: '/node',
      YANBOT_HARNESS_STATE_DIR: '/private/state',
      YANBOT_HARNESS_EXTENSIONS_DIR: '/private/extensions',
      CODEBUDDY_API_KEY_FILE: '/private/key',
      NODE_AUTH_TOKEN: 'fixture',
      NPM_TOKEN: 'fixture',
      npm_config_token: 'fixture',
      CODEBUDDY_API_KEY: 'fixture',
      NODE_OPTIONS: '--import untrusted',
      NODE_PATH: '/untrusted',
      LD_PRELOAD: '/untrusted',
      DYLD_INSERT_LIBRARIES: '/untrusted',
    }),
    {
      PATH: '/node',
      YANBOT_HARNESS_STATE_DIR: '/private/state',
      YANBOT_HARNESS_EXTENSIONS_DIR: '/private/extensions',
      CODEBUDDY_API_KEY_FILE: '/private/key',
    },
  );
});
