export type SmsPermissionState = 'granted' | 'denied' | 'unavailable';

export function resolveSmsPermissionState(
  canReadInbox: boolean,
  canReceiveMessages: boolean,
): SmsPermissionState {
  return canReadInbox && canReceiveMessages ? 'granted' : 'denied';
}
