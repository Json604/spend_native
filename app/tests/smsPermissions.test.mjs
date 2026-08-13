import assert from 'node:assert/strict';
import test from 'node:test';

import {resolveSmsPermissionState} from '../src/features/spend/services/smsPermissions.ts';

test('live SMS tracking requires inbox and receiver permissions', () => {
  assert.equal(resolveSmsPermissionState(true, true), 'granted');
  assert.equal(resolveSmsPermissionState(true, false), 'denied');
  assert.equal(resolveSmsPermissionState(false, true), 'denied');
  assert.equal(resolveSmsPermissionState(false, false), 'denied');
});
