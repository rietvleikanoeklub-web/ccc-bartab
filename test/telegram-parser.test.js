// Parser, confirm summary, and cloud-apply tests for Telegram commands.
// Uses fictional members only. Does not read or write the live bar tab.
'use strict';

var fs = require('fs');
var path = require('path');
var vm = require('vm');

function extract(file, start, end) {
  var src = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
  var re = new RegExp('/\\* ' + start + ' \\*/([\\s\\S]*?)/\\* ' + end + ' \\*/');
  var marked = src.match(re);
  if (!marked) {
    console.error('Missing ' + start + ' block in ' + file);
    process.exit(1);
  }
  return marked[1];
}

var parserSrc = extract('apps-script/telegram-parser.gs', 'TG_PARSER_START', 'TG_PARSER_END');
var applySrc = extract('apps-script/telegram-apply.gs', 'TG_APPLY_START', 'TG_APPLY_END');
[parserSrc, applySrc].forEach(function(src) {
  if (/UrlFetchApp|LockService|PropertiesService|DriveApp|SpreadsheetApp|ContentService|script\.google\.com/.test(src)) {
    console.error('Pure Telegram block must not touch Apps Script services or the live URL');
    process.exit(1);
  }
});

var sandbox = {console: {log: function() {}, warn: function() {}, error: function() {}}};
vm.createContext(sandbox);
vm.runInContext(parserSrc, sandbox, {filename: 'telegram-parser.gs'});
vm.runInContext(applySrc, sandbox, {filename: 'telegram-apply.gs'});

var html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
var syncMarked = html.match(/\/\* SYNC_PURE_START \*\/([\s\S]*?)\/\* SYNC_PURE_END \*\//);
if (!syncMarked) {
  console.error('SYNC_PURE block missing');
  process.exit(1);
}
var appBox = {console: {log: function() {}, warn: function() {}, error: function() {}}};
vm.createContext(appBox);
vm.runInContext(syncMarked[1], appBox, {filename: 'sync-pure.js'});

var tgPlan = sandbox.tgPlan;
var tgApplyChoice = sandbox.tgApplyChoice;
var tgQuote = sandbox.tgQuote;
var tgFormatConfirm = sandbox.tgFormatConfirm;
var tgFormatOwing = sandbox.tgFormatOwing;
var tgIsTelegramUpdate = sandbox.tgIsTelegramUpdate;
var tgParseCallback = sandbox.tgParseCallback;
var tgIsTombstoned = sandbox.tgIsTombstoned;
var tgApplyOps = sandbox.tgApplyOps;
var tgAssertNoLoss = sandbox.tgAssertNoLoss;
var tgFormatApplied = sandbox.tgFormatApplied;
var telegramProtectSave = sandbox.telegramProtectSave;

var passed = 0;
var failed = 0;
function assert(cond, msg) {
  if (cond) { passed++; return; }
  failed++;
  console.error('FAIL: ' + msg);
}

function catalog() {
  return {
    settings: {currency: 'R'},
    members: [
      {id: 'm-samk', name: 'Sam Kestrel', nickname: 'Skip', cell: '09991', email: 'sam@example.com'},
      {id: 'm-samr', name: 'Sam Rivera'},
      {id: 'm-alex', name: 'Alex Rivera', nickname: 'Lex'},
      {id: 'm-pat', name: 'Pat Lee'},
      {id: 'm-tess', name: 'Tessa Crowe'}
    ],
    drinks: [
      {id: 'd-wyn', name: 'Wit Wyn', price: 25, stock: 6, imgType: 'emoji', img: '🍷'},
      {id: 'd-lager', name: 'Lager', price: 20, stock: 3, imgType: 'emoji', img: '🍺', aliases: ['beer', 'bier']},
      {id: 'd-water', name: 'Still Water', price: 10, stock: 12, imgType: 'emoji', img: '💧', aliases: 'water'}
    ],
    deletedDrinks: []
  };
}

function baseDoc() {
  return {
    clubNote: 'keep-me',
    members: [
      {id: 'm-samk', name: 'Sam Kestrel', email: 'sam@example.com', cell: '09991'},
      {id: 'm-alex', name: 'Alex Rivera'}
    ],
    drinks: [
      {id: 'd-wyn', name: 'Wit Wyn', price: 25, stock: 6, imgType: 'emoji', img: '🍷'},
      {id: 'd-lager', name: 'Lager', price: 20, stock: 3, imgType: 'emoji', img: '🍺', aliases: ['beer']}
    ],
    transactions: [
      {id: 'tx-old', memberId: 'm-samk', amount: -10, desc: 'opening', date: '2026-11-01T00:00:00.000Z', type: 'purchase'}
    ],
    users: [{id: 'u-op', name: 'Operator', role: 'admin'}],
    deletedDrinks: [],
    stock_purchases: [{id: 'sp1', drinkId: 'd-lager', qty: 1, cost: 10}],
    audit: [],
    settings: {currency: 'R', telegramToken: 'not-a-real-token', barName: 'Test Bar'}
  };
}

function makeCtx(over) {
  var n = 0;
  var ctx = {
    nowIso: '2026-11-19T12:00:00.000Z',
    trackInventory: false,
    confirmedById: '4242',
    confirmedByName: 'Test Operator',
    sourceRef: 'tg:pend1',
    nextId: function() { n += 1; return 'new-' + n; }
  };
  if (over) {
    Object.keys(over).forEach(function(k) { ctx[k] = over[k]; });
  }
  return ctx;
}

(function salesPaymentsAndBalances() {
  var text = [
    'Sam K 1 wine',
    'Alex 2 beer',
    'TC 1 water',
    'Alex paid 200 EFT',
    'balance Sam K',
    'balances',
    'Zora 1 water'
  ].join('\n');
  var plan = tgPlan(text, catalog(), {});
  assert(plan.ready, 'multi-line plan is ready to confirm');
  assert(!plan.pick, 'no ambiguity in the sample');
  assert(plan.bookable.length === 4, 'three sales and one payment');
  assert(plan.bookable[0].memberName === 'Sam Kestrel' && plan.bookable[0].drinkName === 'Wit Wyn' && plan.bookable[0].qty === 1 && plan.bookable[0].unitPrice === 25, 'wine maps onto Wit Wyn');
  assert(plan.bookable[1].memberId === 'm-alex' && plan.bookable[1].drinkId === 'd-lager' && plan.bookable[1].qty === 2, 'beer alias and quantity');
  assert(plan.bookable[2].memberId === 'm-tess' && plan.bookable[2].drinkName === 'Still Water' && plan.bookable[2].qty === 1, 'initials TC');
  assert(plan.bookable[3].kind === 'payment' && plan.bookable[3].method === 'bank' && plan.bookable[3].amount === 200, 'EFT payment');
  assert(plan.info.length === 2 && plan.info[0].kind === 'balance' && plan.info[0].memberId === 'm-samk', 'single balance');
  assert(plan.info[1].kind === 'balances', 'owing list');
  assert(plan.notes.length === 1 && plan.notes[0].reason === 'member', 'unknown member is not booked');
  var ops = tgQuote(plan);
  assert(ops.length === 4 && ops[0].kind === 'sale' && ops[3].method === 'bank', 'quote follows bookable lines');
  var summary = tgFormatConfirm(plan, baseDoc(), 'R');
  assert(summary.indexOf('Sam Kestrel — Wit Wyn ×1 @ R 25.00 = R 25.00') !== -1, 'summary shows price');
  assert(summary.indexOf('Alex Rivera — Lager ×2 @ R 20.00 = R 40.00') !== -1, 'summary shows qty total');
  assert(summary.indexOf('Tab total: R 75.00') !== -1, 'tab total');
  assert(summary.indexOf('Payments: R 200.00') !== -1, 'payment total');
  assert(summary.indexOf('Nothing is saved yet') !== -1, 'confirm copy');
  assert(summary.indexOf('no matching member') !== -1, 'unknown line called out');
  assert(summary.indexOf('sam@example.com') === -1 && summary.indexOf('09991') === -1, 'summary has no contact details');
})();

(function quantityForms() {
  var cat = catalog();
  var a = tgPlan('aLeX 2X BeEr', cat, {});
  assert(a.bookable.length === 1 && a.bookable[0].qty === 2 && a.bookable[0].drinkId === 'd-lager', '2x beer');
  var b = tgPlan('Alex beer', cat, {});
  assert(b.bookable.length === 1 && b.bookable[0].qty === 1, 'quantity defaults to 1');
  var c = tgPlan('Alex beer x2', cat, {});
  assert(c.bookable.length === 1 && c.bookable[0].qty === 2, 'x2 suffix');
  var d = tgPlan('Skip 1 water', cat, {});
  assert(d.bookable.length === 1 && d.bookable[0].memberId === 'm-samk', 'nickname');
  var e = tgPlan('Alex paid R200 cash', cat, {});
  assert(e.bookable[0].method === 'cash' && e.bookable[0].amount === 200, 'cash with currency letter');
  var f = tgPlan('Alex paid 200,50 card', cat, {});
  assert(f.bookable[0].method === 'yoco' && f.bookable[0].amount === 200.5, 'card maps to the app yoco method');
  var g = tgPlan('Alex 1 moonjuice', cat, {});
  assert(!g.ready && g.notes[0].reason === 'item' && g.bookable.length === 0, 'unknown drink books nothing');
  var h = tgPlan('hello there', cat, {});
  assert(h.notes[0].reason === 'line', 'unparsed line');
  var i = tgPlan('   \n', cat, {});
  assert(i.lines.length === 0 && !i.ready, 'blank message');
  var j = tgPlan('balances', cat, {});
  assert(j.info.length === 1 && !j.ready, 'balances alone does not write');
})();

(function ambiguousPicks() {
  var cat = catalog();
  var plan = tgPlan('Sam 1 water', cat, {});
  assert(plan.pick && plan.pick.field === 'member', 'shared first name asks');
  assert(plan.pick.options.length === 2, 'two Sam options');
  assert(JSON.stringify(plan.pick.options).indexOf('example.com') === -1, 'pick buttons are names only');
  assert(JSON.stringify(plan.pick.options).indexOf('09991') === -1, 'pick buttons omit phone');
  var frozen = JSON.stringify({});
  var choices = tgApplyChoice({}, plan.pick, 'm-samk');
  assert(frozen === '{}', 'applyChoice does not need the original object');
  var again = tgPlan('Sam 1 water', cat, choices);
  assert(again.ready && again.bookable[0].memberId === 'm-samk' && again.bookable[0].drinkName === 'Still Water', 'member pick resolves the line');

  cat.drinks.push({id: 'd-rooi', name: 'Rooi Wyn', price: 30, stock: 4, imgType: 'emoji', img: '🍷'});
  var wines = tgPlan('Alex 1 wyn', cat, {});
  assert(wines.pick && wines.pick.field === 'item', 'two wines ask which one');
  var ids = wines.pick.options.map(function(o) { return o.id; }).sort();
  assert(ids.join() === 'd-rooi,d-wyn', 'both wines are options');
  var picked = tgApplyChoice({}, wines.pick, 'd-wyn');
  var resolved = tgPlan('Alex 1 wyn', cat, picked);
  assert(resolved.ready && resolved.bookable[0].drinkId === 'd-wyn' && resolved.bookable[0].unitPrice === 25, 'drink pick keeps the chosen price');

  var pay = tgPlan('Alex paid 200', cat, {});
  assert(pay.pick && pay.pick.field === 'method', 'missing method asks');
  var labels = pay.pick.options.map(function(o) { return o.label; }).join(',');
  assert(labels === 'Cash,EFT,Card', 'method buttons');
  var paid = tgApplyChoice({}, pay.pick, 'cash');
  var paidPlan = tgPlan('Alex paid 200', cat, paid);
  assert(paidPlan.ready && paidPlan.bookable[0].method === 'cash', 'method pick');
  var bad = tgPlan('Alex paid 20 bitcoin', catalog(), {});
  assert(bad.notes[0].reason === 'method' && bad.bookable.length === 0, 'unknown method books nothing');
})();

(function tombstonesFollowTheApp() {
  var cases = [
    {
      name: 'newer deletion hides the drink',
      drink: {id: 'd-wyn', name: 'Wit Wyn', updatedAt: '2026-01-01T00:00:00.000Z'},
      tombs: [{id: 'd-wyn', name: 'Wit Wyn', date: '2026-06-01T00:00:00.000Z'}],
      expect: true
    },
    {
      name: 'older tombstone does not hide a re-added drink',
      drink: {id: 'd-new', name: 'Wit Wyn', createdAt: '2026-11-12T15:00:00.000Z', updatedAt: '2026-11-12T15:00:00.000Z'},
      tombs: [{id: 'd-old', name: 'Wit Wyn', date: '2026-01-01T00:00:00.000Z'}],
      expect: false
    },
    {
      name: 'revival supersedes the deletion',
      drink: {id: 'd-wyn', name: 'Wit Wyn', updatedAt: '2026-01-01T00:00:00.000Z'},
      tombs: [{id: 'd-wyn', name: 'Wit Wyn', date: '2026-06-01T00:00:00.000Z', revivedAt: '2026-06-02T00:00:00.000Z'}],
      expect: false
    }
  ];
  cases.forEach(function(c) {
    var app = appBox.isTombstoned(c.drink, c.tombs);
    var ours = tgIsTombstoned(c.drink, c.tombs);
    assert(app === c.expect && ours === c.expect && app === ours, c.name);
  });

  var hidden = catalog();
  hidden.drinks[0].updatedAt = '2026-01-01T00:00:00.000Z';
  hidden.deletedDrinks = [{id: 'd-wyn', name: 'Wit Wyn', date: '2026-11-01T00:00:00.000Z'}];
  var plan = tgPlan('Alex 1 wine', hidden, {});
  assert(plan.bookable.length === 0 && plan.notes[0].reason === 'item', 'tombstoned wine is not a match');

  var back = catalog();
  back.drinks[0].createdAt = '2026-11-12T15:00:00.000Z';
  back.drinks[0].updatedAt = '2026-11-12T15:00:00.000Z';
  back.deletedDrinks = [{id: 'd-old', name: 'Wit Wyn', date: '2026-01-01T00:00:00.000Z'}];
  var open = tgPlan('Alex 1 wine', back, {});
  assert(open.bookable.length === 1 && open.bookable[0].drinkId === 'd-wyn', 're-added wine can be sold');
})();

(function owingList() {
  var doc = baseDoc();
  doc.transactions.push({id: 'tx-credit', memberId: 'm-alex', amount: 20, desc: 'credit', date: '2026-11-02T00:00:00.000Z', type: 'topup'});
  var text = tgFormatOwing(doc, 'R');
  assert(text.indexOf('Sam Kestrel') !== -1, 'owes the bar');
  assert(text.indexOf('Alex') === -1, 'credit is not an owing row');
  assert(text.indexOf('sam@example.com') === -1 && text.indexOf('09991') === -1, 'owing list has no contacts');
  assert(text.indexOf('R 10.00') !== -1, 'owing amount');
})();

(function applyKeepsCloudData() {
  var doc = baseDoc();
  var snap = JSON.stringify(doc);
  var ops = [{kind: 'sale', memberId: 'm-samk', drinkId: 'd-wyn', qty: 1, unitPrice: 25, raw: 'Sam K 1 wine'}];
  var result = tgApplyOps(doc, ops, makeCtx());
  assert(JSON.stringify(doc) === snap, 'input document is not mutated');
  assert(result.ok && result.changed, 'sale applied');
  assert(result.doc.transactions.length === 2 && result.doc.transactions[0].id === 'tx-old', 'old transaction kept');
  var tx = result.doc.transactions[1];
  assert(tx.amount === -25 && tx.type === 'purchase', 'sale is a negative purchase');
  assert(tx.desc === '🍷 Wit Wyn ×1', 'description matches the app');
  assert(tx.source === 'telegram' && tx.enteredByName === 'Test Operator' && tx.enteredBy === 'telegram:4242', 'source and who confirmed');
  assert(tx.device === 'Telegram' && tx.sourceRef === 'tg:pend1:0', 'device and idempotency ref');
  assert(result.doc.drinks[0].stock === 6, 'stock unchanged while inventory tracking is off');
  assert(result.doc.settings.telegramToken === 'not-a-real-token', 'settings kept');
  assert(result.doc.clubNote === 'keep-me' && result.doc.users.length === 1 && result.doc.stock_purchases.length === 1, 'unrelated keys kept');
  assert(result.balances[0].balance === -35, 'new balance includes the old row');
  assert(tgFormatApplied(result, 'R').indexOf('owes R 35.00') !== -1, 'reply shows the new balance');
  assert(result.doc.audit[0].source === 'telegram' && result.doc.audit[0].type === 'purchase', 'audit row');

  var tracked = tgApplyOps(baseDoc(), [{kind: 'sale', memberId: 'm-alex', drinkId: 'd-lager', qty: 2, unitPrice: 20}], makeCtx({trackInventory: true}));
  assert(tracked.doc.drinks[1].stock === 1, 'stock decremented like the app');
  var clamped = tgApplyOps(baseDoc(), [{kind: 'sale', memberId: 'm-alex', drinkId: 'd-lager', qty: 5, unitPrice: 20}], makeCtx({trackInventory: true}));
  assert(clamped.booked.length === 1 && clamped.doc.drinks[1].stock === 0, 'stock does not go below zero');

  var hidden = baseDoc();
  hidden.drinks[0].updatedAt = '2026-01-01T00:00:00.000Z';
  hidden.deletedDrinks = [{id: 'd-wyn', name: 'Wit Wyn', date: '2026-12-01T00:00:00.000Z'}];
  var skipped = tgApplyOps(hidden, ops, makeCtx());
  assert(!skipped.changed && skipped.doc.transactions.length === 1 && skipped.skipped[0].reason === 'drink-missing', 'tombstoned drink is not booked');
  assert(skipped.doc.deletedDrinks.length === 1 && skipped.doc.drinks.length === 2, 'tombstones and drinks stay');

  var priced = tgApplyOps(baseDoc(), [{kind: 'sale', memberId: 'm-samk', drinkId: 'd-wyn', qty: 1, unitPrice: 10}], makeCtx());
  assert(!priced.changed && priced.skipped[0].reason === 'price-changed', 'a changed price is not silently charged');

  var pay = tgApplyOps(baseDoc(), [{kind: 'payment', memberId: 'm-alex', amount: 200, method: 'bank', raw: 'Alex paid 200 EFT'}], makeCtx());
  var ptx = pay.doc.transactions[1];
  assert(ptx.amount === 200 && ptx.type === 'topup' && ptx.method === 'bank', 'top-up fields');
  assert(ptx.desc === '🏦 EFT/Bank Transfer', 'EFT description matches the app');
  assert(pay.doc.audit[0].action.indexOf('(bank)') !== -1, 'audit names the method');
  assert(tgFormatApplied(pay, 'R').indexOf('credit R 200.00') !== -1, 'payment balance');

  var card = tgApplyOps(baseDoc(), [{kind: 'payment', memberId: 'm-alex', amount: 80, method: 'yoco'}], makeCtx());
  assert(card.doc.transactions[1].desc === '💳 Yoco Card Payment' && card.doc.transactions[1].method === 'yoco', 'card uses the app card method');

  var once = tgApplyOps(baseDoc(), ops, makeCtx());
  var twice = tgApplyOps(once.doc, ops, makeCtx());
  assert(!twice.changed && twice.doc.transactions.length === once.doc.transactions.length && twice.already.length === 1, 'confirm twice does not double book');
})();

(function protectAndLossGuard() {
  var now = Date.parse('2026-11-19T12:00:00.000Z');
  var current = {
    transactions: [
      {id: 'phone-1', source: 'app', date: '2026-11-19T11:59:00.000Z', amount: -1},
      {id: 'tg-new', source: 'telegram', date: '2026-11-19T11:58:00.000Z', amount: -5, memberId: 'm-samk'},
      {id: 'tg-old', source: 'telegram', date: '2026-11-19T10:00:00.000Z', amount: -9}
    ],
    members: [{id: 'm-keep'}, {id: 'm-drop'}],
    audit: [
      {id: 'aud-new', source: 'telegram', date: '2026-11-19T11:58:30.000Z', action: 'booked'},
      {id: 'aud-old', source: 'telegram', date: '2026-11-19T10:00:00.000Z', action: 'old'}
    ]
  };
  var incoming = {
    transactions: [{id: 'phone-1', source: 'app', date: '2026-11-19T11:59:00.000Z', amount: -1}],
    members: [{id: 'm-keep'}],
    audit: []
  };
  var merged = telegramProtectSave(current, incoming, now);
  assert(incoming.transactions.length === 1 && incoming.members.length === 1, 'phone snapshot is not mutated');
  assert(merged.transactions.length === 2 && merged.transactions[1].id === 'tg-new', 'recent telegram row is kept');
  assert(merged.transactions.some(function(t) { return t.id === 'tg-old'; }) === false, 'old telegram row can be removed by a later save');
  assert(merged.transactions.some(function(t) { return t.id === 'phone-1'; }), 'phone rows stay');
  assert(merged.members.length === 1 && merged.members[0].id === 'm-keep', 'member edits in the phone snapshot stay');
  assert(merged.audit.length === 1 && merged.audit[0].id === 'aud-new', 'recent telegram audit row is kept');
  assert(incoming.audit.length === 0, 'incoming audit list is not mutated');
  var same = telegramProtectSave(current, current, now);
  assert(same === current, 'nothing to rescue returns the snapshot as-is');

  var threw = false;
  try { tgAssertNoLoss({transactions: [1, 2]}, {transactions: [1]}); }
  catch (err) { threw = /transactions/.test(err.message); }
  assert(threw, 'shrinking transactions is refused');
  threw = false;
  try { tgAssertNoLoss({settings: {a: 1}}, {settings: {}}); }
  catch (err) { threw = /settings/.test(err.message); }
  assert(threw, 'dropping a settings key is refused');
})();

(function updatesAreNotAppPosts() {
  assert(tgIsTelegramUpdate({update_id: 1, message: {text: 'hi', from: {id: 5}}}) === true, 'message update');
  assert(tgIsTelegramUpdate({update_id: 2, callback_query: {data: 'y:abc'}}) === true, 'button update');
  assert(tgIsTelegramUpdate({action: 'sendEmail', update_id: 3, message: {text: 'x'}}) === false, 'email action stays an app post');
  assert(tgIsTelegramUpdate({update_id: 4, message: {text: 'x'}, members: [], settings: {bar: 1}}) === false, 'full snapshot is not a bot update');
  assert(tgIsTelegramUpdate({members: [], transactions: [], drinks: []}) === false, 'save payload');
  assert(tgIsTelegramUpdate({update_id: 5, edited_message: {text: 'x'}}) === false, 'edits are ignored');
  assert(tgParseCallback('y:abcd1234').type === 'confirm', 'confirm callback');
  assert(tgParseCallback('n:abcd1234').type === 'cancel', 'cancel callback');
  assert(tgParseCallback('p:abcd1234:2').option === 2, 'pick callback');
  assert(tgParseCallback('y:abcd:extra') === null, 'malformed callback');
})();

(function webhookFileStaysOutOfTheAppSave() {
  var hook = fs.readFileSync(path.join(__dirname, '..', 'apps-script', 'telegram.gs'), 'utf8');
  assert(hook.indexOf('function telegramTryHandle') !== -1, 'webhook entry point');
  assert(hook.indexOf('function telegramLockedSave') !== -1, 'locked save helper');
  assert(!/^function doPost\b/m.test(hook) && !/^function doGet\b/m.test(hook), 'does not replace doPost or doGet');
  assert(hook.indexOf('script.google.com') === -1, 'no live web app URL');
  assert(!/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i.test(hook), 'no email address');
  assert(!/\d{6,}:AA[A-Za-z0-9_-]+/.test(hook), 'no bot token');
  assert(hook.indexOf('TELEGRAM_BOT_TOKEN') !== -1 && hook.indexOf('TELEGRAM_ALLOWED_IDS') !== -1, 'properties are named');
})();

if (failed) {
  console.error(failed + ' failed, ' + passed + ' passed');
  process.exit(1);
}
console.log(passed + ' passed');
