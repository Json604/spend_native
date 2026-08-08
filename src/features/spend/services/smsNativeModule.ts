import {NativeModules, Platform} from 'react-native';

export type SmsNativeCapabilities = {
  canReadInbox: boolean;
  isAndroid: boolean;
  moduleName: string;
  supportsInboxQueries: boolean;
};

export type SmsNativeInboxMessage = {
  address: string | null;
  body: string | null;
  id: string | null;
  read: boolean;
  threadId: string | null;
  timestamp: number;
  type: number;
};

type SpendSmsNativeModule = {
  getCapabilities(): Promise<SmsNativeCapabilities>;
  listInboxMessages(limit: number): Promise<SmsNativeInboxMessage[]>;
  listInboxMessagesSince(sinceTimestamp: number): Promise<SmsNativeInboxMessage[]>;
  consumePendingRefreshFlag(): Promise<boolean>;
  markIgnored(
    dedupeKey: string,
    amountMinor: number,
    occurredAtMillis: number,
    categoryLabel: string | null,
  ): Promise<void>;
  unmarkIgnored(dedupeKey: string): Promise<void>;
};

const nativeModule = NativeModules.SpendSmsModule as
  | SpendSmsNativeModule
  | undefined;

export const hasSpendSmsNativeModule = (): boolean =>
  Platform.OS === 'android' && nativeModule != null;

export const getSpendSmsCapabilities =
  async (): Promise<SmsNativeCapabilities> => {
    if (!hasSpendSmsNativeModule()) {
      return {
        canReadInbox: false,
        isAndroid: Platform.OS === 'android',
        moduleName: 'SpendSmsModule',
        supportsInboxQueries: false,
      };
    }

    return nativeModule!.getCapabilities();
  };

export const listSpendSmsInboxMessages = async (
  limit = 2000,
): Promise<SmsNativeInboxMessage[]> => {
  if (!hasSpendSmsNativeModule()) {
    return [];
  }

  return nativeModule!.listInboxMessages(limit);
};

export const listSpendSmsInboxMessagesSince = async (
  sinceTimestamp: number,
): Promise<SmsNativeInboxMessage[]> => {
  if (!hasSpendSmsNativeModule()) {
    return [];
  }

  return nativeModule!.listInboxMessagesSince(sinceTimestamp);
};

export const consumePendingSmsRefreshFlag = async (): Promise<boolean> => {
  if (!hasSpendSmsNativeModule()) {
    return false;
  }

  return nativeModule!.consumePendingRefreshFlag();
};

export const markSpendIgnored = async (
  dedupeKey: string,
  amountMinor: number,
  occurredAtMillis: number,
  categoryLabel: string | null,
): Promise<void> => {
  if (!hasSpendSmsNativeModule()) return;
  await nativeModule!.markIgnored(dedupeKey, amountMinor, occurredAtMillis, categoryLabel);
};

export const unmarkSpendIgnored = async (dedupeKey: string): Promise<void> => {
  if (!hasSpendSmsNativeModule()) return;
  await nativeModule!.unmarkIgnored(dedupeKey);
};
