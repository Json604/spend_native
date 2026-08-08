import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';
import {fileURLToPath} from 'node:url';

import {classifyMessage} from '../src/parser/messageClassifier.ts';
import {extractMonetarySpans} from '../src/parser/monetaryRoles.ts';
import {
  buildCounterpartyKey,
  isLowSpecificityKey,
} from '../src/parser/counterpartyKey.ts';
import {parseMessage} from '../src/parser/parseMessage.ts';
import {DEFAULT_RULE_PACK} from '../src/parser/rulePack.ts';
import {parseSmsTransactionCandidate} from '../src/features/spend/parsers/smsTransactionParser.ts';

const corpusPath = fileURLToPath(
  new URL('./fixtures/sms_corpus.json', import.meta.url),
);
const corpus = JSON.parse(await readFile(corpusPath, 'utf8'));

test('credit-card limit promotion is marketing and cannot create a transaction', () => {
  const message =
    'Get upto 8 PVR INOX tickets on Lifetime Free pre-approved Kotak League Credit Card. Limit Rs. 90000';
  const result = parseMessage(message);

  assert.equal(result.classification, 'marketing');
  assert.equal(result.transaction, null);
  assert.deepEqual(result.monetarySpans, [
    {
      raw: 'Rs. 90000',
      amountMinor: 9_000_000,
      role: 'credit_limit',
      index: message.indexOf('Rs. 90000'),
    },
  ]);
});

test('cashback promise is marketing and cannot create a transaction', () => {
  const message =
    'Get assured Rs.75 cashback on credit card bill payment today. Valid for limited time. Use code: PACHATAR';
  const result = parseMessage(message);

  assert.equal(result.classification, 'marketing');
  assert.equal(result.transaction, null);
  assert.equal(result.monetarySpans[0]?.role, 'promised_cashback');
});

test('posted UPI debit uses the transaction amount and extracted payee', () => {
  const message =
    'Sent Rs.48.00 from XXXXXX1234 to RAHUL SHARMA on 01/06/2026. UPI ref no. 651805890728.';
  const result = parseMessage(message);

  assert.equal(result.classification, 'posted_debit');
  assert.equal(result.transaction?.amountMinor, 4_800);
  assert.equal(result.transaction?.amountSpan.role, 'transaction_amount');
  assert.equal(result.counterpartyKey, 'merchant:rahul sharma');
});

test('posted VPA credit is linkable metadata, not a spend transaction', () => {
  const message =
    'Received Rs.2600.00 in your Kotak Bank AC X1234 from testuser-1@okaxis on 01-06-26.';
  const result = parseMessage(message);

  assert.equal(result.classification, 'posted_credit');
  assert.equal(result.transaction, null);
  assert.equal(result.isCredit, true);
  assert.equal(result.credit?.amountMinor, 260_000);
  assert.match(result.counterpartyKey ?? '', /^vpa:/);
  assert.equal(
    result.counterpartyKey,
    'vpa:testuser-1@okaxis',
  );
});

test('credited-by bank transfer is a credit, not a spend transaction', () => {
  const message =
    'Dear SBI User, your A/c X1234-credited by Rs.14850 on 01Jun26 transfer from TESTUSER';
  const result = parseMessage(message);

  assert.equal(result.classification, 'posted_credit');
  assert.equal(result.transaction, null);
  assert.equal(result.credit?.amountMinor, 1_485_000);
  assert.equal(result.counterpartyKey, 'merchant:testuser');
});

test('classification handles non-posted intents before transaction words', () => {
  assert.equal(classifyMessage('Your OTP is 123456 for card payment'), 'security');
  assert.equal(
    classifyMessage('Autopay set: Rs.500 will be debited on 10 Aug'),
    'mandate_setup',
  );
  assert.equal(classifyMessage('Payment of Rs.500 is pending'), 'pending');
  assert.equal(classifyMessage('Txn of Rs.500 was declined'), 'reversal');
  assert.equal(classifyMessage('Available balance is Rs.500'), 'balance_only');
  assert.equal(classifyMessage('Your credit card limit is Rs.500'), 'unknown');
  assert.equal(classifyMessage('Unrecognized informational message'), 'unknown');
});

test('monetary extraction returns every span with distinct contextual roles', () => {
  const spans = extractMonetarySpans(
    'A/c debited INR 1,600.00. Available balance is INR 67,000.00. Minimum due Rs.500; EMI Rs.250.',
  );

  assert.deepEqual(
    spans.map(({amountMinor, role}) => ({amountMinor, role})),
    [
      {amountMinor: 160_000, role: 'transaction_amount'},
      {amountMinor: 6_700_000, role: 'available_balance'},
      {amountMinor: 50_000, role: 'minimum_due'},
      {amountMinor: 25_000, role: 'emi_amount'},
    ],
  );
});

test('counterparty keys are namespaced and never fall back to sender IDs', () => {
  assert.equal(
    buildCounterpartyKey('Paid Rs.10 using card XX1234'),
    'card:1234',
  );
  assert.equal(buildCounterpartyKey('Available balance Rs.500'), null);
  assert.equal(isLowSpecificityKey('vpa:checkout.payu@hdfcbank'), true);
  assert.equal(isLowSpecificityKey('vpa:pay@okaxis'), true);
  assert.equal(isLowSpecificityKey('vpa:testuser-1@okaxis'), false);
  assert.equal(isLowSpecificityKey('merchant:paytm mart'), false);
});

test('the app-facing SMS adapter uses the restructured parser', () => {
  const baseMessage = {
    address: 'JD-KOTAKD-S',
    id: 'fixture-id',
    read: true,
    threadId: 'thread-id',
    timestamp: Date.UTC(2026, 5, 1),
    type: 1,
  };

  const debit = parseSmsTransactionCandidate({
    ...baseMessage,
    body: 'Sent Rs.48.00 from XXXXXX1234 to RAHUL SHARMA on 01/06/2026.',
  });
  assert.equal(debit?.counterpartyKey, 'merchant:rahul sharma');
  assert.equal(debit?.merchantHint, 'rahul sharma');
  assert.equal(debit?.amountMinor, 4_800);

  const promotion = parseSmsTransactionCandidate({
    ...baseMessage,
    body: 'Lifetime Free pre-approved credit card. Limit Rs. 90000. Apply now',
  });
  assert.equal(promotion, null);

  const credit = parseSmsTransactionCandidate({
    ...baseMessage,
    body: 'Received Rs.2600.00 in your account from user@okaxis',
  });
  assert.equal(credit, null);
});

test('generic successful payment grammar creates a debit with its payee', () => {
  const result = parseMessage(
    'Payment of Rs.1,200 to SWIGGY is successful. UPI Ref 123456789012.',
  );

  assert.equal(result.classification, 'posted_debit');
  assert.equal(result.transaction?.amountMinor, 120_000);
  assert.equal(result.transaction?.amountSpan.role, 'transaction_amount');
  assert.equal(result.counterpartyKey, 'merchant:swiggy');
  assert.equal(result.rulePackVersion, 1);
});

test('balance-first debit selects the debit amount, never the balance', () => {
  const result = parseMessage(
    'Avl Bal Rs.12,345 in A/c X1234 after debit of Rs.500.',
  );

  assert.equal(result.classification, 'posted_debit');
  assert.equal(result.transaction?.amountMinor, 50_000);
  assert.equal(result.transaction?.amountSpan.role, 'transaction_amount');
  assert.deepEqual(
    result.monetarySpans.map(({amountMinor, role}) => ({amountMinor, role})),
    [
      {amountMinor: 1_234_500, role: 'available_balance'},
      {amountMinor: 50_000, role: 'transaction_amount'},
    ],
  );
});

test('adversarial non-posted messages never create transactions', () => {
  const messages = [
    'Your Kotak Credit Card bill of Rs.4,500 is due on 15/08',
    'pre-approved for a loan of Rs.5,00,000. Apply now!',
    'Collect request of Rs.350 received from merchant@paytm',
    'Txn of Rs.2,000 on Kotak Card x9999 failed',
  ];

  for (const message of messages) {
    const result = parseMessage(message);
    assert.equal(result.createsTransaction, false, message);
    assert.equal(result.transaction, null, message);
  }
});

test('an in-memory rule provider extends classification without source changes', () => {
  const extendedPack = structuredClone(DEFAULT_RULE_PACK);
  extendedPack.version = 2;
  extendedPack.classifiers.posted_debit.push(
    '\\bsettled under novabank protocol\\b',
  );
  const inMemoryRuleProvider = {getRulePack: () => extendedPack};
  const message = 'NOVA alert: Rs.321 settled under novabank protocol.';

  assert.equal(parseMessage(message).classification, 'unknown');

  const result = parseMessage(message, {ruleProvider: inMemoryRuleProvider});
  assert.equal(result.classification, 'posted_debit');
  assert.equal(result.transaction?.amountMinor, 32_100);
  assert.equal(result.transaction?.amountSpan.role, 'transaction_amount');
  assert.equal(result.rulePackVersion, 2);
});

test('real SMS corpus never creates a transaction from balance or limit money', () => {
  assert.equal(corpus.length, 266);

  const breakdown = Object.fromEntries(
    [
      'posted_debit',
      'posted_credit',
      'pending',
      'reversal',
      'mandate_setup',
      'balance_only',
      'marketing',
      'security',
      'unknown',
    ].map(classification => [classification, 0]),
  );
  let transactions = 0;

  for (const message of corpus) {
    const result = parseMessage(message);
    breakdown[result.classification] += 1;

    if (!result.transaction) continue;
    transactions += 1;
    assert.equal(result.classification, 'posted_debit', message);
    assert.equal(result.transaction.amountSpan.role, 'transaction_amount', message);
    assert.notEqual(result.transaction.amountSpan.role, 'available_balance', message);
    assert.notEqual(result.transaction.amountSpan.role, 'credit_limit', message);
  }

  const summary = {
    corpusMessages: corpus.length,
    transactions,
    abstained: corpus.length - transactions,
    classifications: breakdown,
  };
  console.log(`SMS corpus summary ${JSON.stringify(summary)}`);

  assert.equal(transactions + summary.abstained, corpus.length);
});
