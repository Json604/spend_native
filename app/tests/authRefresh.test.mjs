import assert from 'node:assert/strict';
import test from 'node:test';

import {isFatalRefreshStatus} from '../src/auth/refreshPolicy.ts';

test('only 401 and 403 from refresh are a sign-out', () => {
  assert.equal(isFatalRefreshStatus(401), true);
  assert.equal(isFatalRefreshStatus(403), true);
  assert.equal(isFatalRefreshStatus(500), false);
  assert.equal(isFatalRefreshStatus(502), false);
  assert.equal(isFatalRefreshStatus(429), false);
  assert.equal(isFatalRefreshStatus(200), false);
});
