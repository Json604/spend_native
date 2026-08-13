// `node --test tests/` resolves this package entry point. Keep the explicit
// imports so that command remains the single full-suite invocation.
await import('./parser.test.mjs');
await import('./coordinator.test.mjs');
await import('./wireCommands.test.mjs');
await import('./backupOps.test.mjs');
await import('./syncClient.test.mjs');
await import('./budgetPaste.test.mjs');
await import('./smsPermissions.test.mjs');
await import('./spendQueries.test.mjs');
