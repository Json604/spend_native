import {PermissionsAndroid, Platform} from 'react-native';

import {
  getSpendSmsCapabilities,
  listSpendSmsInboxMessages,
  listSpendSmsInboxMessagesSince,
  type SmsNativeCapabilities,
  type SmsNativeInboxMessage,
} from './smsNativeModule';
import {
  parseSmsTransactionCandidates,
  type ParsedSmsTransactionCandidate,
} from '../parsers/smsTransactionParser';
import {SpendSeedTransactionInput} from '../types/types';
import {
  resolveSmsPermissionState,
  type SmsPermissionState,
} from './smsPermissions';

export type {SmsPermissionState} from './smsPermissions';

export type SmsIngestionSnapshot = {
  capabilities: SmsNativeCapabilities;
  parsedCandidates: ParsedSmsTransactionCandidate[];
  permission: SmsPermissionState;
  rawMessages: SmsNativeInboxMessage[];
};

function inferChannel(rawText: string): SpendSeedTransactionInput['channel'] {
  if (/\bupi\b/i.test(rawText)) {
    return 'upi';
  }

  if (/\bcard\b/i.test(rawText)) {
    return 'card';
  }

  if (/\bautopay\b/i.test(rawText) || /\bsubscription\b/i.test(rawText)) {
    return 'autopay';
  }

  return 'unknown';
}

function inferDirection(
  candidate: ParsedSmsTransactionCandidate,
): SpendSeedTransactionInput['direction'] {
  return candidate.direction;
}

export function convertSmsCandidatesToTransactions(
  candidates: ParsedSmsTransactionCandidate[],
): SpendSeedTransactionInput[] {
  return candidates
    .map(candidate => {
      const amountMinor = candidate.amountMinor;

      if (!amountMinor) {
        return null;
      }

      const transaction: SpendSeedTransactionInput = {
        id: `sms:${candidate.rawMessageId ?? candidate.timestamp}`,
        source: 'sms',
        sourceMessageId: candidate.rawMessageId ?? undefined,
        externalFingerprint: candidate.dedupeKey,
        occurredAt: new Date(candidate.timestamp).toISOString(),
        amountMinor,
        currencyCode: candidate.currency === 'INR' ? 'INR' : 'UNKNOWN',
        merchantName: candidate.merchantHint ?? 'Unknown payee',
        counterpartyKey: candidate.counterpartyKey ?? undefined,
        description: candidate.rawText,
        channel: inferChannel(candidate.rawText),
        direction: inferDirection(candidate),
        status: 'posted',
      };

      return transaction;
    })
    .filter((transaction): transaction is SpendSeedTransactionInput => transaction !== null);
}

export const getSmsPermissionState = async (): Promise<SmsPermissionState> => {
  if (Platform.OS !== 'android') {
    return 'unavailable';
  }

  const [canReadInbox, canReceiveMessages] = await Promise.all([
    PermissionsAndroid.check(PermissionsAndroid.PERMISSIONS.READ_SMS),
    PermissionsAndroid.check(PermissionsAndroid.PERMISSIONS.RECEIVE_SMS),
  ]);

  return resolveSmsPermissionState(canReadInbox, canReceiveMessages);
};

export const requestSmsReadPermission = async (): Promise<SmsPermissionState> => {
  if (Platform.OS !== 'android') {
    return 'unavailable';
  }

  const results = await PermissionsAndroid.requestMultiple([
    PermissionsAndroid.PERMISSIONS.READ_SMS,
    PermissionsAndroid.PERMISSIONS.RECEIVE_SMS,
  ]);

  return resolveSmsPermissionState(
    results[PermissionsAndroid.PERMISSIONS.READ_SMS] ===
      PermissionsAndroid.RESULTS.GRANTED,
    results[PermissionsAndroid.PERMISSIONS.RECEIVE_SMS] ===
      PermissionsAndroid.RESULTS.GRANTED,
  );
};

export const startOfTodayMillis = (): number => {
  const now = new Date();
  now.setHours(0, 0, 0, 0);
  return now.getTime();
};

export const loadSmsIngestionSnapshot = async (
  options: {sinceMillis?: number; limit?: number} = {},
): Promise<SmsIngestionSnapshot> => {
  const capabilities = await getSpendSmsCapabilities();
  const permission = await getSmsPermissionState();

  if (
    Platform.OS !== 'android' ||
    permission !== 'granted' ||
    !capabilities.supportsInboxQueries
  ) {
    return {
      capabilities,
      parsedCandidates: [],
      permission,
      rawMessages: [],
    };
  }

  const rawMessages =
    typeof options.sinceMillis === 'number'
      ? await listSpendSmsInboxMessagesSince(options.sinceMillis)
      : await listSpendSmsInboxMessages(options.limit ?? 2000);

  return {
    capabilities,
    parsedCandidates: parseSmsTransactionCandidates(rawMessages),
    permission,
    rawMessages,
  };
};
