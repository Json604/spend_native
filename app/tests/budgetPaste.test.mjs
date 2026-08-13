import test from 'node:test';
import assert from 'node:assert/strict';
import {parseBudgetPaste} from '../src/features/spend/utils/parseBudgetPaste.ts';
import {categoriesForMonthlyBudget} from '../src/features/spend/store/budgetSelectors.ts';

test('review choices contain only this month budget categories and their parents', () => {
  const categories = [
    {id: 'food', label: 'Food'},
    {id: 'groceries', label: 'Groceries', parentId: 'food'},
    {id: 'travel', label: 'Travel'},
    {id: 'old', label: 'Old category'},
  ];
  assert.deepEqual(
    categoriesForMonthlyBudget(categories, {groceries: 500000, travel: 0}),
    [categories[0], categories[1]],
  );
});

test('accepts the separators people actually type', () => {
  const {entries, skipped} = parseBudgetPaste([
    'Rent 15000',
    'Groceries: 8,000',
    'Piano = 16000',
    'Spotify ₹69',
    'Diet coke - 1000',
    'Travel\t3000',
    'Claude  Rs 2300',
  ].join('\n'));
  assert.deepEqual(entries, [
    {label: 'Rent', amountMinor: 1500000},
    {label: 'Groceries', amountMinor: 800000},
    {label: 'Piano', amountMinor: 1600000},
    {label: 'Spotify', amountMinor: 6900},
    {label: 'Diet coke', amountMinor: 100000},
    {label: 'Travel', amountMinor: 300000},
    {label: 'Claude', amountMinor: 230000},
  ]);
  assert.deepEqual(skipped, []);
});

test('the amount is the number at the end, so names may contain digits', () => {
  const {entries} = parseBudgetPaste('Laptop repair 2 35000\nQ1 fees 2000');
  assert.deepEqual(entries, [
    {label: 'Laptop repair 2', amountMinor: 3500000},
    {label: 'Q1 fees', amountMinor: 200000},
  ]);
});

test('paise survive, and blank lines are not noise', () => {
  const {entries, skipped} = parseBudgetPaste('\n\nAir fryer 2000.50\n\n');
  assert.deepEqual(entries, [{label: 'Air fryer', amountMinor: 200050}]);
  assert.deepEqual(skipped, []);
});

test('lines that are not budget lines are reported, not silently dropped', () => {
  const {entries, skipped} = parseBudgetPaste('August budget\nRent 15000\nremember to cancel gym');
  assert.deepEqual(entries, [{label: 'Rent', amountMinor: 1500000}]);
  assert.deepEqual(skipped, ['August budget', 'remember to cancel gym']);
});

test('a repeated name is a correction: the last value wins, once', () => {
  const {entries} = parseBudgetPaste('Rent 15000\nFood 5000\nrent 18000');
  assert.deepEqual(entries, [
    {label: 'rent', amountMinor: 1800000},
    {label: 'Food', amountMinor: 500000},
  ]);
});

test('a zero is a real instruction, not a parse failure', () => {
  const {entries, skipped} = parseBudgetPaste('Junk 0');
  assert.deepEqual(entries, [{label: 'Junk', amountMinor: 0}]);
  assert.deepEqual(skipped, []);
});

test('an amount with no name is skipped rather than creating a nameless row', () => {
  const {entries, skipped} = parseBudgetPaste('15000\n₹2300');
  assert.deepEqual(entries, []);
  assert.deepEqual(skipped, ['15000', '₹2300']);
});
