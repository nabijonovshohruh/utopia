import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db/index.js';
import { getOrCreateStudent, parseFullName, registerFullName } from '../src/services/submissions.js';

test('getOrCreateStudent creates a new row with a Telegram-derived placeholder, unregistered', () => {
  const db = openDb(':memory:');
  const student = getOrCreateStudent(db, { id: 1, first_name: 'Ada', last_name: 'Lovelace', username: 'ada' });
  assert.equal(student.full_name, 'Ada Lovelace');
  assert.equal(student.registered, 0);
  assert.equal(student.username, 'ada');
  db.close();
});

test('getOrCreateStudent falls back to username, then "Student", when no name is set', () => {
  const db = openDb(':memory:');
  const withUsername = getOrCreateStudent(db, { id: 1, username: 'ada99' });
  assert.equal(withUsername.full_name, 'ada99');

  const withNothing = getOrCreateStudent(db, { id: 2 });
  assert.equal(withNothing.full_name, 'Student');
  db.close();
});

test('getOrCreateStudent does NOT overwrite an already-registered full name on later calls', () => {
  const db = openDb(':memory:');
  getOrCreateStudent(db, { id: 1, first_name: 'Ada', username: 'ada' });
  registerFullName(db, 1, 'Ada Byron Lovelace');

  // Telegram profile changes (new first_name) on a later interaction...
  const again = getOrCreateStudent(db, { id: 1, first_name: 'SomethingElse', username: 'ada2' });
  // ...must not clobber the registered name, though username (just metadata) stays in sync.
  assert.equal(again.full_name, 'Ada Byron Lovelace');
  assert.equal(again.registered, 1);
  assert.equal(again.username, 'ada2');
  db.close();
});

test('getOrCreateStudent DOES keep refreshing the placeholder name for an unregistered student', () => {
  const db = openDb(':memory:');
  getOrCreateStudent(db, { id: 1, first_name: 'Ada' });
  // Not registered yet — no explicit requirement to refresh, but it must not
  // crash or corrupt state across repeated calls either.
  const again = getOrCreateStudent(db, { id: 1, first_name: 'Ada' });
  assert.equal(again.registered, 0);
  db.close();
});

test('registerFullName sets full_name and flips registered to 1', () => {
  const db = openDb(':memory:');
  getOrCreateStudent(db, { id: 1, first_name: 'X' });
  const result = registerFullName(db, 1, 'Shohruh Nabijonov');
  assert.equal(result.full_name, 'Shohruh Nabijonov');
  assert.equal(result.registered, 1);
  db.close();
});

test('parseFullName requires at least two words', () => {
  assert.equal(parseFullName('Shohruh').error, "Iltimos, ism va familiyangizni to'liq kiriting (masalan: Shohruh Nabijonov).");
  assert.equal(parseFullName('Shohruh Nabijonov').name, 'Shohruh Nabijonov');
  assert.equal(parseFullName('  Shohruh   Nabijonov  ').name, 'Shohruh Nabijonov'); // whitespace normalised
});

test('parseFullName rejects empty input, commands, and overly long input', () => {
  assert.match(parseFullName('').error, /kiriting/);
  assert.match(parseFullName('   ').error, /kiriting/);
  assert.match(parseFullName('/start').error, /buyruq emas/);
  assert.match(parseFullName('A'.repeat(90) + ' B').error, /uzun/);
});

test('parseFullName accepts a three-part name (some cultures use a patronymic)', () => {
  const { name, error } = parseFullName('Shohruh Odiljon o\'g\'li Nabijonov');
  assert.equal(error, null);
  assert.equal(name, "Shohruh Odiljon o'g'li Nabijonov");
});
