import {mkdir, readFile, writeFile} from 'node:fs/promises';
import {dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const BACKUP_PATH = '/Users/arka/Desktop/spend_backup/spend_transactions.json';
const testDirectory = dirname(fileURLToPath(import.meta.url));
const fixturePath = resolve(testDirectory, 'fixtures/sms_corpus.json');

export async function generateSmsCorpus() {
  const backup = JSON.parse(await readFile(BACKUP_PATH, 'utf8'));
  if (!Array.isArray(backup)) {
    throw new TypeError(`Expected an array in ${BACKUP_PATH}`);
  }

  const messages = backup
    .filter(row => row?.source === 'sms' && typeof row.description === 'string')
    .map(row => row.description);

  await mkdir(dirname(fixturePath), {recursive: true});
  await writeFile(fixturePath, `${JSON.stringify(messages, null, 2)}\n`, 'utf8');
  return {fixturePath, messageCount: messages.length};
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const result = await generateSmsCorpus();
  console.log(`Wrote ${result.messageCount} SMS messages to ${result.fixturePath}`);
}

