import { authenticatedFetch, secureDeviceId } from "../auth/authClient";
import { nativeCoordinator } from "../db/nativeCoordinator";
import { nativeSync } from "./nativeSync";
import { SpendSyncClient } from "./spendSyncClient";

export type { SyncReport } from "./spendSyncClient";
export { SpendSyncClient } from "./spendSyncClient";

export const syncClient = new SpendSyncClient({
  nativeSync,
  nativeCoordinator,
  authenticatedFetch,
  secureDeviceId,
});
