-- Entity ids are DEVICE-generated and deliberately meaningful: 'sms:8393'
-- embeds the provider message id, which is what makes re-ingesting the same SMS
-- idempotent; categories use slugs like 'custom:fruits'; there is a literal
-- 'uncategorized'. Those are unique on one device, never across accounts. Two
-- people both have an 'sms:8393' within their first week.
--
-- Every table here was keyed on that id ALONE. The second user to push a given
-- id did not get their own row: applyOne scopes its lookup by user, found
-- nothing, and ran the INSERT, which hit the primary key and failed the WHOLE
-- push — a push is one transaction. sync_ops failed differently and no better:
-- the duplicate check found the other user's row and raised 409 op_id_taken.
--
-- Either way that user's backup pauses permanently. The op ids are
-- deterministic, so every retry rebuilds the identical batch and collides in
-- exactly the same place, forever. That is the failure this codebase has now
-- hit twice from two other directions.
--
-- The id was never meant to be globally unique. Scope it to the account that
-- owns it, which is what every read already assumed.

-- Must go first: it references transactions(id), which stops being unique below.
ALTER TABLE transaction_allocations
  DROP CONSTRAINT IF EXISTS transaction_allocations_transaction_id_fkey;

ALTER TABLE transactions            DROP CONSTRAINT IF EXISTS transactions_pkey;
ALTER TABLE transactions            ADD PRIMARY KEY (user_id, id);

ALTER TABLE transaction_allocations DROP CONSTRAINT IF EXISTS transaction_allocations_pkey;
ALTER TABLE transaction_allocations ADD PRIMARY KEY (user_id, id);

ALTER TABLE categories              DROP CONSTRAINT IF EXISTS categories_pkey;
ALTER TABLE categories              ADD PRIMARY KEY (user_id, id);

ALTER TABLE category_memory         DROP CONSTRAINT IF EXISTS category_memory_pkey;
ALTER TABLE category_memory         ADD PRIMARY KEY (user_id, id);

ALTER TABLE budgets                 DROP CONSTRAINT IF EXISTS budgets_pkey;
ALTER TABLE budgets                 ADD PRIMARY KEY (user_id, id);

ALTER TABLE source_alerts           DROP CONSTRAINT IF EXISTS source_alerts_pkey;
ALTER TABLE source_alerts           ADD PRIMARY KEY (user_id, id);

ALTER TABLE suggestions             DROP CONSTRAINT IF EXISTS suggestions_pkey;
ALTER TABLE suggestions             ADD PRIMARY KEY (user_id, id);

-- op_id is a client-minted idempotency key, so it carries the same problem: two
-- devices deriving an id from the same entity id derive the same op id.
ALTER TABLE sync_ops                DROP CONSTRAINT IF EXISTS sync_ops_pkey;
ALTER TABLE sync_ops                ADD PRIMARY KEY (user_id, op_id);

-- Rebuilt to match the new key. transaction_id stays nullable, and MATCH SIMPLE
-- means a row with a NULL transaction_id satisfies the constraint as before.
ALTER TABLE transaction_allocations
  ADD CONSTRAINT transaction_allocations_transaction_id_fkey
  FOREIGN KEY (user_id, transaction_id) REFERENCES transactions(user_id, id)
  ON DELETE CASCADE;
