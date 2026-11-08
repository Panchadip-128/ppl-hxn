'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const window = {};
vm.runInNewContext(fs.readFileSync('public/expenses.js', 'utf8'), {window, Intl, console});
const helpers = window.GroupPayExpenses.test;

const empty = helpers.readinessFor();
assert.equal(empty.doneCount, 0);
assert.equal(empty.next.view, 'account');

const named = helpers.readinessFor({profile: {displayName: 'Aarya'}});
assert.equal(named.doneCount, 1);
assert.equal(named.next.view, 'friends');

const withFriend = helpers.readinessFor({
  profile: {displayName: 'Aarya'}, friends: [{id: 'f1', name: 'Riya'}],
});
assert.equal(withFriend.doneCount, 2);
assert.equal(withFriend.next.action, 'new-split');

const openSplit = helpers.readinessFor({
  profile: {displayName: 'Aarya'}, friends: [{id: 'f1'}], splits: [{allSettled: false}],
});
assert.equal(openSplit.doneCount, 3);
assert.equal(openSplit.openCount, 1);
assert.equal(openSplit.next.view, 'activity');

const settled = helpers.readinessFor({
  profile: {displayName: 'Aarya'}, friends: [{id: 'f1'}], splits: [{allSettled: true}],
});
assert.equal(settled.next.action, 'new-split');

assert.equal(
  JSON.stringify(helpers.splitEqualCents(10000, ['Aarya', 'Riya', 'Sam'])),
  JSON.stringify({Aarya: 3334, Riya: 3333, Sam: 3333}),
);
assert.equal(helpers.cents('42.50'), 4250);
assert.throws(() => helpers.cents('0'), /greater than zero/);

assert.equal(
  JSON.stringify(helpers.splitDraftReadiness({title: 'Dinner', total: '42.50', selected: ['f1'], hostName: 'Aarya'})),
  JSON.stringify({bill: true, people: true, repayment: true}),
);
assert.equal(
  JSON.stringify(helpers.splitDraftReadiness({title: '', total: 'nope', selected: [], hostName: ''})),
  JSON.stringify({bill: false, people: false, repayment: false}),
);

async function settle() {
  await Promise.resolve();
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function fakeContainer() {
  return {
    innerHTML: '', listeners: {},
    addEventListener(name, callback) { this.listeners[name] = callback; },
    querySelector() { return null; },
    querySelectorAll() { return []; },
  };
}

async function renderContract() {
  const container = fakeContainer();
  const responses = {
    '/api/expenses/groups': {groups: []},
    '/api/expenses/friends': {friends: []},
    '/api/expenses/splits': {splits: []},
    '/api/expenses/subscriptions': {subscriptions: []},
    '/api/expenses/analytics': {analytics: {totalMinor: 0, splitCount: 0, byCategory: {}, byMonth: {}}},
    '/api/expenses/profile': {profile: {displayName: '', upiID: ''}},
  };
  window.GroupPayExpenses.mount(container, {api: async (path) => responses[path]});
  await settle();
  assert.match(container.innerHTML, /Get ready for your first shared bill/);
  assert.match(container.innerHTML, /Next best action/);
  assert.match(container.innerHTML, /Add your first person/);
  assert.match(container.innerHTML, /Nothing is charged automatically/);
  assert.match(container.innerHTML, /What this tab does/);
}

renderContract().then(() => console.log('Expenses readiness contract passed.')).catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
