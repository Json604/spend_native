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

export type SmsPermissionState = 'granted' | 'denied' | 'unavailable';

export type SmsIngestionSnapshot = {
  capabilities: SmsNativeCapabilities;
  parsedCandidates: ParsedSmsTransactionCandidate[];
  permission: SmsPermissionState;
  rawMessages: SmsNativeInboxMessage[];
};

function parseAmountMinor(amountText: string | null) {
  if (!amountText) {
    return 0;
  }

  const normalized = amountText.replace(/,/g, '');
  const parsed = Number.parseFloat(normalized);

  if (!Number.isFinite(parsed)) {
    return 0;
  }

  return Math.round(parsed * 100);
}

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
      const amountMinor = parseAmountMinor(candidate.amountText);

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
        merchantName: candidate.merchantHint ?? candidate.rawSender ?? 'Unknown payee',
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

  const granted = await PermissionsAndroid.check(
    PermissionsAndroid.PERMISSIONS.READ_SMS,
  );

  return granted ? 'granted' : 'denied';
};

export const requestSmsReadPermission = async (): Promise<SmsPermissionState> => {
  if (Platform.OS !== 'android') {
    return 'unavailable';
  }

  const result = await PermissionsAndroid.request(
    PermissionsAndroid.PERMISSIONS.READ_SMS,
  );

  return result === PermissionsAndroid.RESULTS.GRANTED ? 'granted' : 'denied';
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
