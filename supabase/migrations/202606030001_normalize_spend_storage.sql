-- Normalize spend storage without deleting legacy JSON tables.
-- Existing spend_state.state and spend_budgets.budgets rows are copied into
-- tabular tables and left untouched as rollback/compatibility data.

create table if not exists public.spend_state (
  user_id uuid not null primary key references auth.users(id) on delete cascade,
  state jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.spend_budgets (
  user_id uuid not null primary key references auth.users(id) on delete cascade,
  budgets jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.spend_transactions (
  user_id uuid not null references auth.users(id) on delete cascade,
  id text not null,
  source text not null check (source in ('sms', 'gmail', 'manual')),
  source_message_id text,
  external_fingerprint text,
  occurred_at timestamptz not null,
  amount_minor integer not null check (amount_minor >= 0),
  currency_code text not null,
  merchant_name text not null,
  normalized_merchant_name text not null,
  counterparty_key text,
  description text not null,
  channel text not null check (channel in ('upi', 'card', 'bank_transfer', 'autopay', 'wallet', 'unknown')),
  direction text not null check (direction in ('debit', 'credit', 'refund')),
  status text not null check (status in ('posted', 'pending', 'ignored')),
  category_id text,
  category_label text,
  category_source text not null check (category_source in ('merchant_rule', 'learned_rule', 'manual', 'uncategorized')),
  needs_review boolean not null default false,
  plan_type text check (plan_type in ('planned', 'unplanned')),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, id)
);

create table if not exists public.spend_categories (
  user_id uuid not null references auth.users(id) on delete cascade,
  id text not null,
  label text not null,
  tint text not null,
  is_system boolean not null default false,
  is_review_category boolean not null default false,
  parent_id text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, id)
);

create table if not exists public.spend_merchant_rules (
  user_id uuid not null references auth.users(id) on delete cascade,
  id text not null,
  label text not null,
  category_id text not null,
  priority integer not null default 0,
  merchant_tokens text[],
  sender_tokens text[],
  upi_handle_tokens text[],
  description_tokens text[],
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, id)
);

create table if not exists public.spend_learned_category_rules (
  user_id uuid not null references auth.users(id) on delete cascade,
  id text not null,
  category_id text not null,
  category_label text not null,
  normalized_counterparty text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, id),
  unique (user_id, normalized_counterparty)
);

create table if not exists public.spend_sync_states (
  user_id uuid not null references auth.users(id) on delete cascade,
  source text not null check (source in ('sms', 'gmail', 'manual')),
  status text not null check (status in ('idle', 'ready', 'needs_permission', 'syncing', 'error')),
  label text not null,
  detail text not null,
  accent text not null,
  last_synced_at timestamptz,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, source)
);

create table if not exists public.spend_monthly_budgets (
  user_id uuid not null references auth.users(id) on delete cascade,
  month_key text not null check (month_key ~ '^[0-9]{4}-[0-9]{2}$'),
  amount_minor integer not null check (amount_minor >= 0),
  set_at timestamptz not null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, month_key)
);

create table if not exists public.spend_monthly_category_budgets (
  user_id uuid not null references auth.users(id) on delete cascade,
  month_key text not null,
  category_id text not null,
  amount_minor integer not null check (amount_minor > 0),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, month_key, category_id),
  foreign key (user_id, month_key)
    references public.spend_monthly_budgets(user_id, month_key)
    on delete cascade
);

create index if not exists spend_transactions_user_occurred_idx
  on public.spend_transactions (user_id, occurred_at desc);
create index if not exists spend_transactions_user_review_idx
  on public.spend_transactions (user_id, needs_review)
  where needs_review = true and status <> 'ignored';
create unique index if not exists spend_transactions_user_external_fingerprint_idx
  on public.spend_transactions (user_id, external_fingerprint)
  where external_fingerprint is not null;
create index if not exists spend_monthly_category_budgets_user_month_idx
  on public.spend_monthly_category_budgets (user_id, month_key);

alter table public.spend_transactions enable row level security;
alter table public.spend_categories enable row level security;
alter table public.spend_merchant_rules enable row level security;
alter table public.spend_learned_category_rules enable row level security;
alter table public.spend_sync_states enable row level security;
alter table public.spend_monthly_budgets enable row level security;
alter table public.spend_monthly_category_budgets enable row level security;
alter table public.spend_state enable row level security;
alter table public.spend_budgets enable row level security;

grant all on table public.spend_transactions to authenticated;
grant all on table public.spend_categories to authenticated;
grant all on table public.spend_merchant_rules to authenticated;
grant all on table public.spend_learned_category_rules to authenticated;
grant all on table public.spend_sync_states to authenticated;
grant all on table public.spend_monthly_budgets to authenticated;
grant all on table public.spend_monthly_category_budgets to authenticated;
grant all on table public.spend_state to authenticated;
grant all on table public.spend_budgets to authenticated;

drop policy if exists "Users manage own legacy spend state" on public.spend_state;
create policy "Users manage own legacy spend state"
  on public.spend_state for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

drop policy if exists "Users manage own legacy spend budgets" on public.spend_budgets;
create policy "Users manage own legacy spend budgets"
  on public.spend_budgets for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

drop policy if exists "Users manage own spend transactions" on public.spend_transactions;
create policy "Users manage own spend transactions"
  on public.spend_transactions for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

drop policy if exists "Users manage own spend categories" on public.spend_categories;
create policy "Users manage own spend categories"
  on public.spend_categories for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

drop policy if exists "Users manage own spend merchant rules" on public.spend_merchant_rules;
create policy "Users manage own spend merchant rules"
  on public.spend_merchant_rules for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

drop policy if exists "Users manage own learned category rules" on public.spend_learned_category_rules;
create policy "Users manage own learned category rules"
  on public.spend_learned_category_rules for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

drop policy if exists "Users manage own spend sync states" on public.spend_sync_states;
create policy "Users manage own spend sync states"
  on public.spend_sync_states for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

drop policy if exists "Users manage own monthly budgets" on public.spend_monthly_budgets;
create policy "Users manage own monthly budgets"
  on public.spend_monthly_budgets for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

drop policy if exists "Users manage own monthly category budgets" on public.spend_monthly_category_budgets;
create policy "Users manage own monthly category budgets"
  on public.spend_monthly_category_budgets for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

insert into public.spend_transactions (
  user_id,
  id,
  source,
  source_message_id,
  external_fingerprint,
  occurred_at,
  amount_minor,
  currency_code,
  merchant_name,
  normalized_merchant_name,
  counterparty_key,
  description,
  channel,
  direction,
  status,
  category_id,
  category_label,
  category_source,
  needs_review,
  plan_type,
  updated_at
)
select
  s.user_id,
  item->>'id',
  coalesce(item->>'source', 'sms'),
  item->>'sourceMessageId',
  item->>'externalFingerprint',
  (item->>'occurredAt')::timestamptz,
  coalesce((item->>'amountMinor')::integer, 0),
  coalesce(item->>'currencyCode', 'INR'),
  coalesce(item->>'merchantName', 'Unknown payee'),
  coalesce(item->>'normalizedMerchantName', ''),
  item->>'counterpartyKey',
  coalesce(item->>'description', ''),
  coalesce(item->>'channel', 'unknown'),
  coalesce(item->>'direction', 'debit'),
  coalesce(item->>'status', 'posted'),
  item->>'categoryId',
  item->>'categoryLabel',
  coalesce(item->>'categorySource', 'uncategorized'),
  coalesce((item->>'needsReview')::boolean, false),
  item->>'planType',
  now()
from public.spend_state s
cross join lateral jsonb_array_elements(coalesce(s.state::jsonb->'transactions', '[]'::jsonb)) item
where item ? 'id'
on conflict (user_id, id) do update set
  source = excluded.source,
  source_message_id = excluded.source_message_id,
  external_fingerprint = excluded.external_fingerprint,
  occurred_at = excluded.occurred_at,
  amount_minor = excluded.amount_minor,
  currency_code = excluded.currency_code,
  merchant_name = excluded.merchant_name,
  normalized_merchant_name = excluded.normalized_merchant_name,
  counterparty_key = excluded.counterparty_key,
  description = excluded.description,
  channel = excluded.channel,
  direction = excluded.direction,
  status = excluded.status,
  category_id = excluded.category_id,
  category_label = excluded.category_label,
  category_source = excluded.category_source,
  needs_review = excluded.needs_review,
  plan_type = excluded.plan_type,
  updated_at = excluded.updated_at;

insert into public.spend_categories (
  user_id,
  id,
  label,
  tint,
  is_system,
  is_review_category,
  parent_id,
  updated_at
)
select
  s.user_id,
  item->>'id',
  coalesce(item->>'label', 'Untitled'),
  coalesce(item->>'tint', 'rgba(255, 255, 255, 0.72)'),
  coalesce((item->>'isSystem')::boolean, false),
  coalesce((item->>'isReviewCategory')::boolean, false),
  item->>'parentId',
  now()
from public.spend_state s
cross join lateral jsonb_array_elements(coalesce(s.state::jsonb->'categories', '[]'::jsonb)) item
where item ? 'id'
on conflict (user_id, id) do update set
  label = excluded.label,
  tint = excluded.tint,
  is_system = excluded.is_system,
  is_review_category = excluded.is_review_category,
  parent_id = excluded.parent_id,
  updated_at = excluded.updated_at;

insert into public.spend_merchant_rules (
  user_id,
  id,
  label,
  category_id,
  priority,
  merchant_tokens,
  sender_tokens,
  upi_handle_tokens,
  description_tokens,
  updated_at
)
select
  s.user_id,
  item->>'id',
  coalesce(item->>'label', 'Rule'),
  coalesce(item->>'categoryId', 'uncategorized'),
  coalesce((item->>'priority')::integer, 0),
  array(select jsonb_array_elements_text(coalesce(item->'merchantTokens', '[]'::jsonb))),
  array(select jsonb_array_elements_text(coalesce(item->'senderTokens', '[]'::jsonb))),
  array(select jsonb_array_elements_text(coalesce(item->'upiHandleTokens', '[]'::jsonb))),
  array(select jsonb_array_elements_text(coalesce(item->'descriptionTokens', '[]'::jsonb))),
  now()
from public.spend_state s
cross join lateral jsonb_array_elements(coalesce(s.state::jsonb->'merchantRules', '[]'::jsonb)) item
where item ? 'id'
on conflict (user_id, id) do update set
  label = excluded.label,
  category_id = excluded.category_id,
  priority = excluded.priority,
  merchant_tokens = excluded.merchant_tokens,
  sender_tokens = excluded.sender_tokens,
  upi_handle_tokens = excluded.upi_handle_tokens,
  description_tokens = excluded.description_tokens,
  updated_at = excluded.updated_at;

insert into public.spend_learned_category_rules (
  user_id,
  id,
  category_id,
  category_label,
  normalized_counterparty,
  created_at,
  updated_at
)
select
  s.user_id,
  item->>'id',
  coalesce(item->>'categoryId', 'uncategorized'),
  coalesce(item->>'categoryLabel', 'Uncategorized'),
  coalesce(item->>'normalizedCounterparty', ''),
  coalesce((item->>'createdAt')::timestamptz, now()),
  coalesce((item->>'updatedAt')::timestamptz, now())
from public.spend_state s
cross join lateral jsonb_array_elements(coalesce(s.state::jsonb->'learnedRules', '[]'::jsonb)) item
where item ? 'id'
on conflict (user_id, id) do update set
  category_id = excluded.category_id,
  category_label = excluded.category_label,
  normalized_counterparty = excluded.normalized_counterparty,
  updated_at = excluded.updated_at;

insert into public.spend_sync_states (
  user_id,
  source,
  status,
  label,
  detail,
  accent,
  last_synced_at,
  updated_at
)
select
  s.user_id,
  coalesce(item->>'source', 'sms'),
  coalesce(item->>'status', 'idle'),
  coalesce(item->>'label', item->>'source', 'Sync'),
  coalesce(item->>'detail', ''),
  coalesce(item->>'accent', 'rgba(255, 255, 255, 0.85)'),
  nullif(item->>'lastSyncedAt', '')::timestamptz,
  now()
from public.spend_state s
cross join lateral jsonb_array_elements(coalesce(s.state::jsonb->'syncStates', '[]'::jsonb)) item
where item ? 'source'
on conflict (user_id, source) do update set
  status = excluded.status,
  label = excluded.label,
  detail = excluded.detail,
  accent = excluded.accent,
  last_synced_at = excluded.last_synced_at,
  updated_at = excluded.updated_at;

insert into public.spend_monthly_budgets (
  user_id,
  month_key,
  amount_minor,
  set_at,
  updated_at
)
select
  b.user_id,
  entry.key,
  coalesce((entry.value->>'amountMinor')::integer, 0),
  coalesce((entry.value->>'setAt')::timestamptz, now()),
  now()
from public.spend_budgets b
cross join lateral jsonb_each(coalesce(b.budgets::jsonb, '{}'::jsonb)) entry
on conflict (user_id, month_key) do update set
  amount_minor = excluded.amount_minor,
  set_at = excluded.set_at,
  updated_at = excluded.updated_at;

insert into public.spend_monthly_category_budgets (
  user_id,
  month_key,
  category_id,
  amount_minor,
  updated_at
)
select
  b.user_id,
  entry.key,
  cat.key,
  (cat.value #>> '{}')::integer,
  now()
from public.spend_budgets b
cross join lateral jsonb_each(coalesce(b.budgets::jsonb, '{}'::jsonb)) entry
cross join lateral jsonb_each(coalesce(entry.value->'categoryBudgets', '{}'::jsonb)) cat
where (cat.value #>> '{}')::integer > 0
on conflict (user_id, month_key, category_id) do update set
  amount_minor = excluded.amount_minor,
  updated_at = excluded.updated_at;
