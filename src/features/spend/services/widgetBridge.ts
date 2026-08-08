import { NativeModules, Platform } from "react-native";
import type { SpendWidgetSnapshot } from "../types/types";

type BridgeModule = {
  updateSnapshot: (json: string) => Promise<boolean>;
};

const bridge: BridgeModule | undefined =
  Platform.OS === "android"
    ? (NativeModules.SpendWidgetBridge as BridgeModule | undefined)
    : undefined;

export function pushWidgetSnapshot(snapshot: SpendWidgetSnapshot): void {
  if (!bridge) return;
  bridge.updateSnapshot(JSON.stringify(snapshot)).catch((e) => {
    console.warn("widget bridge update failed", e);
  });
}
