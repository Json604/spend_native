import { NativeModules } from "react-native";

type NativeSync = {
  claimLocalData(userId: string, deviceId: string): Promise<string>;
  acknowledgeOutbox(idsJson: string): Promise<number>;
  recordOutboxFailure(id: string, error: string, maxAttempts: number): Promise<number>;
  recoverDeadLettersOnce(migrationKey: string): Promise<number>;
  applyPulledOps(commandsJson: string, cursor: string, userId: string): Promise<string>;
  getDeadLetterCount(): Promise<number>;
};

export const nativeSync = NativeModules.SpendDatabase as NativeSync;
