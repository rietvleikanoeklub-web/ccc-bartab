/**
 * CCC Bar Tab — pure Telegram command parser.
 *
 * Paste this file into the existing Apps Script project together with
 * telegram-apply.gs and telegram.gs. It has no Apps Script services, so
 * the same block is executed by test/telegram-parser.test.js.
 *
 * Matching is case-insensitive against member name, initials, and
 * nickname/alias fields, and against drink names plus alias fields.
 * "wine" also matches a drink whose name uses "wyn". Tombstoned drinks
 * (same rule as the app) are not offered and are not booked.
 */
/* TG_PARSER_START */
var TG_MEMBER_MIN = 78;
var TG_ITEM_MIN = 74;
var TG_MARGIN = 8;
var TG_METHOD_WORDS = {
  eft: 'bank',
  bank: 'bank',
  transfer: 'bank',
  cash: 'cash',
  card: 'yoco',
  yoco: 'yoco'
};
var TG_SYNONYM_GROUPS = [
  ['wine', 'wyn', 'witwyn', 'rooiwyn', 'redwine', 'whitewine'],
  ['beer', 'bier', 'lager', 'ale'],
  ['cider', 'sider'],
  ['water', 'aqua'],
  ['soda', 'cooldrink', 'colddrink', 'fizzy', 'softdrink'],
  ['energade', 'energy', 'energydrink']
];

function tgLoose(s) {
  return String(s || '').toLowerCase().replace(/×/g, 'x').replace(/\s+/g, ' ').replace(/^\s+|\s+$/g, '');
}

function tgNorm(s) {
  return tgLoose(s).replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').replace(/^\s+|\s+$/g, '');
}

function tgKey(s) {
  return tgNorm(s).replace(/ /g, '');
}

function tgMoney(currency, amount) {
  var n = Math.abs(Number(amount) || 0).toFixed(2);
  return String(currency || 'R') + ' ' + n;
}

function tgCurrency(catalog) {
  var settings = catalog && catalog.settings;
  if (settings && settings.currency) return String(settings.currency);
  return 'R';
}

function tgMethodLabel(method) {
  if (method === 'bank') return 'EFT';
  if (method === 'yoco') return 'Card';
  if (method === 'cash') return 'Cash';
  return '';
}

function tgLev(a, b) {
  var prev, cur, i, j, cost;
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  prev = [];
  for (j = 0; j <= b.length; j++) prev[j] = j;
  for (i = 1; i <= a.length; i++) {
    cur = [i];
    for (j = 1; j <= b.length; j++) {
      cost = a.charAt(i - 1) === b.charAt(j - 1) ? 0 : 1;
      cur[j] = Math.min(cur[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
    }
    prev = cur;
  }
  return prev[b.length];
}

function tgListField(row, keys) {
  var out = [];
  var i, j, v, parts;
  if (!row) return out;
  for (i = 0; i < keys.length; i++) {
    v = row[keys[i]];
    if (v == null || v === '') continue;
    if (Object.prototype.toString.call(v) === '[object Array]') {
      for (j = 0; j < v.length; j++) {
        if (v[j] != null && String(v[j]) !== '') out.push(String(v[j]));
      }
    } else {
      parts = String(v).split(/[,;/|]/);
      for (j = 0; j < parts.length; j++) {
        if (tgNorm(parts[j])) out.push(parts[j]);
      }
    }
  }
  return out;
}

function tgSynonymsOf(token) {
  var key = tgKey(token);
  var i, g;
  for (i = 0; i < TG_SYNONYM_GROUPS.length; i++) {
    g = TG_SYNONYM_GROUPS[i];
    if (g.indexOf(key) !== -1) return g;
  }
  return [key];
}

function tgTokenMatches(queryToken, nameToken) {
  var q = tgKey(queryToken);
  var n = tgKey(nameToken);
  if (!q || !n) return false;
  if (q === n) return true;
  return tgSynonymsOf(q).indexOf(n) !== -1;
}

function tgMemberInitials(member) {
  var stored = member && member.initials ? tgKey(member.initials) : '';
  var tokens, letters, i;
  if (stored.length >= 2 && stored.length <= 4 && /^[a-z]+$/.test(stored)) return stored;
  tokens = tgNorm(member && member.name).split(' ');
  letters = '';
  for (i = 0; i < tokens.length && letters.length < 4; i++) {
    if (tokens[i]) letters += tokens[i].charAt(0);
  }
  return letters;
}

function tgScoreMember(query, member) {
  var q = tgNorm(query);
  var name, aliases, initials, qKey, qTokens, nTokens, i, prefixOk, aliasNorm;
  if (!member || !q || q.length < 2) return 0;
  name = tgNorm(member.name);
  if (!name) return 0;
  if (q === name) return 100;
  aliases = tgListField(member, ['nickname', 'nick', 'aka', 'alias', 'aliases']);
  for (i = 0; i < aliases.length; i++) {
    if (tgNorm(aliases[i]) === q) return 100;
  }
  initials = tgMemberInitials(member);
  qKey = q.replace(/ /g, '');
  if (qKey.length >= 2 && qKey.length <= 4 && /^[a-z]+$/.test(qKey) && qKey === initials) return 96;
  qTokens = q.split(' ');
  nTokens = name.split(' ');
  if (qTokens.length === 2 && qTokens[1].length === 1 && nTokens.length >= 2 &&
      qTokens[0] === nTokens[0] && nTokens[nTokens.length - 1].charAt(0) === qTokens[1]) return 94;
  if (qTokens.length === 1 && qTokens[0].length >= 3 && qTokens[0] === nTokens[0]) return 90;
  if (qTokens.length === 1 && qTokens[0].length >= 3 && qTokens[0] === nTokens[nTokens.length - 1]) return 86;
  if (qTokens.length >= 1 && qTokens.length <= nTokens.length) {
    prefixOk = true;
    for (i = 0; i < qTokens.length; i++) {
      if (qTokens[i].length < 3 || nTokens[i].indexOf(qTokens[i]) !== 0) {
        prefixOk = false;
        break;
      }
    }
    if (prefixOk && qTokens.length === nTokens.length) return 92;
    if (prefixOk) return 84;
  }
  if (q.length >= 5 && name.length >= 5 && tgLev(q, name) === 1) return 80;
  for (i = 0; i < aliases.length; i++) {
    aliasNorm = tgNorm(aliases[i]);
    if (aliasNorm.length >= 4 && q.length >= 4 && tgLev(q, aliasNorm) === 1) return 78;
  }
  return 0;
}

function tgScoreItem(query, drink) {
  var q = tgNorm(query);
  var name, aliases, i, qTokens, nTokens, all, qKey, nKey;
  if (!drink || !q || q.length < 3) return 0;
  name = tgNorm(drink.name);
  if (!name) return 0;
  if (q === name) return 100;
  aliases = tgListField(drink, ['alias', 'aliases', 'aka', 'nickname']);
  for (i = 0; i < aliases.length; i++) {
    if (tgNorm(aliases[i]) === q) return 98;
  }
  qTokens = q.split(' ');
  nTokens = name.split(' ');
  all = qTokens.length > 0;
  for (i = 0; i < qTokens.length; i++) {
    var hit = false;
    var t;
    for (t = 0; t < nTokens.length; t++) {
      if (tgTokenMatches(qTokens[i], nTokens[t])) { hit = true; break; }
    }
    if (!hit) { all = false; break; }
  }
  if (all && qTokens.length === nTokens.length) return 97;
  if (all) return 86;
  qKey = q.replace(/ /g, '');
  nKey = name.replace(/ /g, '');
  if (qKey.length >= 4 && nKey.indexOf(qKey) !== -1) return 76;
  if (q.length >= 5 && name.length >= 5 && tgLev(q, name) === 1) return 74;
  return 0;
}

function tgClassify(scored, minScore) {
  var ok = [];
  var i, best, close;
  for (i = 0; i < scored.length; i++) {
    if (scored[i].score >= minScore) ok.push(scored[i]);
  }
  ok.sort(function(a, b) {
    if (b.score !== a.score) return b.score - a.score;
    if (a.label < b.label) return -1;
    if (a.label > b.label) return 1;
    return 0;
  });
  if (!ok.length) return {status: 'none', options: [], bestScore: 0};
  best = ok[0].score;
  close = [];
  for (i = 0; i < ok.length; i++) {
    if (ok[i].score >= best - TG_MARGIN) close.push(ok[i]);
  }
  if (close.length > 6) close = close.slice(0, 6);
  if (close.length >= 2) return {status: 'ambiguous', options: close, bestScore: best, best: ok[0]};
  return {status: 'match', match: ok[0], options: close, bestScore: best};
}

function tgScoreMembers(query, members, forceId) {
  var scored = [];
  var i, score;
  members = members || [];
  for (i = 0; i < members.length; i++) {
    if (forceId && String(members[i].id) !== String(forceId)) continue;
    score = tgScoreMember(query, members[i]);
    if (forceId && score < TG_MEMBER_MIN) score = TG_MEMBER_MIN;
    scored.push({
      id: String(members[i].id),
      label: String(members[i].name || ''),
      score: score,
      row: members[i]
    });
  }
  return tgClassify(scored, TG_MEMBER_MIN);
}

function tgNameKey(name) {
  return String(name || '').toLowerCase().replace(/^\s+|\s+$/g, '');
}

function tgTimeMs(v) {
  var n;
  if (v == null || v === '') return NaN;
  if (typeof v === 'number') return isFinite(v) ? v : NaN;
  n = new Date(v).getTime();
  return n;
}

function tgMaxMs(values) {
  var best = 0;
  var i, n;
  for (i = 0; i < values.length; i++) {
    n = tgTimeMs(values[i]);
    if (!isNaN(n) && n > best) best = n;
  }
  return best;
}

function tgDrinkActivityMs(dk) {
  if (!dk) return 0;
  return tgMaxMs([dk.updatedAt, dk.createdAt, dk.updated, dk.created]);
}

function tgTombstoneDeletionMs(t) {
  if (!t) return 0;
  return tgMaxMs([t.date, t.deletedAt, t.created, t.createdAt]);
}

function tgTombstoneRevivedMs(t) {
  var n;
  if (!t) return 0;
  n = tgTimeMs(t.revivedAt);
  return isNaN(n) || n < 0 ? 0 : n;
}

function tgTombstoneSuppresses(t) {
  var del = tgTombstoneDeletionMs(t);
  var rev = tgTombstoneRevivedMs(t);
  if (rev && (!del || rev >= del)) return false;
  return true;
}

// Same rule as the app: a tombstone hides a drink only while the deletion
// is strictly newer than the drink. A revival, or a re-added drink with a
// later updatedAt, is sellable again. Name match is case-insensitive.
function tgIsTombstoned(dk, tombstones) {
  var list = tombstones || [];
  var id = String(dk && dk.id || '');
  var nm = tgNameKey(dk && dk.name);
  var drinkMs = tgDrinkActivityMs(dk);
  var i, t, idMatch, nameMatch, del;
  for (i = 0; i < list.length; i++) {
    t = list[i];
    if (!t) continue;
    idMatch = !!id && String(t.id) === id;
    nameMatch = !!nm && tgNameKey(t.name) === nm;
    if (!idMatch && !nameMatch) continue;
    if (!tgTombstoneSuppresses(t)) continue;
    del = tgTombstoneDeletionMs(t);
    if (!del) {
      if (drinkMs === 0) return true;
      continue;
    }
    if (del > drinkMs) return true;
  }
  return false;
}

function tgActiveDrinks(catalog) {
  var drinks = (catalog && catalog.drinks) || [];
  var tombs = (catalog && catalog.deletedDrinks) || [];
  var out = [];
  var i;
  for (i = 0; i < drinks.length; i++) {
    if (!tgIsTombstoned(drinks[i], tombs)) out.push(drinks[i]);
  }
  return out;
}

function tgScoreItems(query, catalog, forceId, currency) {
  var drinks = tgActiveDrinks(catalog);
  var scored = [];
  var i, score, label;
  for (i = 0; i < drinks.length; i++) {
    if (forceId && String(drinks[i].id) !== String(forceId)) continue;
    score = tgScoreItem(query, drinks[i]);
    if (forceId && score < TG_ITEM_MIN) score = TG_ITEM_MIN;
    label = String(drinks[i].name || '') + ' — ' + tgMoney(currency, drinks[i].price);
    scored.push({
      id: String(drinks[i].id),
      label: label,
      score: score,
      row: drinks[i]
    });
  }
  return tgClassify(scored, TG_ITEM_MIN);
}

function tgPublicOptions(options) {
  var out = [];
  var i;
  options = options || [];
  for (i = 0; i < options.length; i++) {
    out.push({id: options[i].id, label: options[i].label});
  }
  return out;
}

function tgFindById(rows, id) {
  var i;
  rows = rows || [];
  for (i = 0; i < rows.length; i++) {
    if (String(rows[i].id) === String(id)) return rows[i];
  }
  return null;
}

function tgSaleSplits(raw) {
  var tokens = tgLoose(raw).split(' ');
  var clean = [];
  var i, rest, taken, qty, item;
  for (i = 0; i < tokens.length; i++) if (tokens[i]) clean.push(tokens[i]);
  var out = [];
  for (i = 1; i < clean.length; i++) {
    rest = clean.slice(i);
    taken = tgTakeQty(rest);
    if (!taken) continue;
    qty = taken.qty;
    item = taken.item;
    if (!item.length || !qty || qty < 1 || qty > 99) continue;
    out.push({
      memberQuery: clean.slice(0, i).join(' '),
      itemQuery: item.join(' '),
      qty: qty
    });
  }
  return out;
}

function tgTakeQty(rest) {
  var m;
  if (!rest.length) return null;
  m = /^(\d+)x(.+)$/.exec(rest[0]);
  if (m && m[2]) return {qty: parseInt(m[1], 10), item: [m[2]].concat(rest.slice(1))};
  if (/^\d+x$/.test(rest[0]) && rest.length >= 2) return {qty: parseInt(rest[0], 10), item: rest.slice(1)};
  if (/^\d+$/.test(rest[0]) && rest.length >= 2) return {qty: parseInt(rest[0], 10), item: rest.slice(1)};
  if (rest.length >= 2 && /^x\d+$/.test(rest[rest.length - 1])) {
    return {qty: parseInt(rest[rest.length - 1].slice(1), 10), item: rest.slice(0, -1)};
  }
  return {qty: 1, item: rest.slice()};
}

function tgUnknown(raw, reason) {
  return {kind: 'unknown', raw: raw, reason: reason};
}

function tgUnknownText(note) {
  if (!note) return 'not understood';
  if (note.reason === 'member') return 'no matching member';
  if (note.reason === 'item') return 'no matching drink';
  if (note.reason === 'method') return 'use EFT, cash, or card';
  return 'not understood';
}

function tgSaleMiss(raw, catalog, splits) {
  var memberHit = false;
  var itemHit = false;
  var i;
  for (i = 0; i < splits.length; i++) {
    if (tgScoreMembers(splits[i].memberQuery, catalog.members || [], null).status !== 'none') memberHit = true;
    if (tgScoreItems(splits[i].itemQuery, catalog, null, 'R').status !== 'none') itemHit = true;
  }
  if (memberHit && !itemHit) return tgUnknown(raw, 'item');
  if (!memberHit && itemHit) return tgUnknown(raw, 'member');
  return tgUnknown(raw, 'line');
}

function tgParseSale(raw, catalog, choice) {
  var currency = tgCurrency(catalog);
  var splits, ranked, i, sp, ms, is, score, win, split, member, item;
  if (choice && choice.itemQuery) {
    splits = [{
      memberQuery: choice.memberQuery || '',
      itemQuery: choice.itemQuery,
      qty: Number(choice.qty) || 1
    }];
  } else {
    splits = tgSaleSplits(raw);
  }
  ranked = [];
  for (i = 0; i < splits.length; i++) {
    sp = splits[i];
    ms = tgScoreMembers(sp.memberQuery, catalog.members || [], choice && choice.memberId);
    is = tgScoreItems(sp.itemQuery, catalog, choice && choice.drinkId, currency);
    if (ms.status === 'none' || is.status === 'none') continue;
    score = ms.bestScore + is.bestScore;
    if (ms.status === 'ambiguous') score -= 12;
    if (is.status === 'ambiguous') score -= 12;
    ranked.push({sp: sp, ms: ms, is: is, score: score});
  }
  ranked.sort(function(a, b) { return b.score - a.score; });
  if (!ranked.length) return tgSaleMiss(raw, catalog, splits);
  win = ranked[0];
  split = {memberQuery: win.sp.memberQuery, itemQuery: win.sp.itemQuery, qty: win.sp.qty};
  if (win.ms.status === 'ambiguous' && !(choice && choice.memberId)) {
    return {
      kind: 'ambiguous',
      raw: raw,
      field: 'member',
      split: split,
      prompt: 'Which member is "' + win.sp.memberQuery + '"?',
      options: tgPublicOptions(win.ms.options)
    };
  }
  if (win.is.status === 'ambiguous' && !(choice && choice.drinkId)) {
    return {
      kind: 'ambiguous',
      raw: raw,
      field: 'item',
      split: split,
      prompt: 'Which drink is "' + win.sp.itemQuery + '"?',
      options: tgPublicOptions(win.is.options)
    };
  }
  member = (choice && choice.memberId) ? tgFindById(catalog.members, choice.memberId) : (win.ms.match && win.ms.match.row);
  item = (choice && choice.drinkId) ? tgFindById(tgActiveDrinks(catalog), choice.drinkId) : (win.is.match && win.is.match.row);
  if (!member || !item) return tgUnknown(raw, 'line');
  return {
    kind: 'sale',
    raw: raw,
    memberId: String(member.id),
    memberName: String(member.name || ''),
    drinkId: String(item.id),
    drinkName: String(item.name || ''),
    unitPrice: Number(item.price) || 0,
    qty: win.sp.qty,
    split: split
  };
}

function tgMethodOptions() {
  return [
    {id: 'cash', label: 'Cash'},
    {id: 'bank', label: 'EFT'},
    {id: 'yoco', label: 'Card'}
  ];
}

function tgParsePayment(raw, match, catalog, choice) {
  var memberQuery = tgNorm(match[1]);
  var amount = parseFloat(String(match[2]).replace(',', '.'));
  var methodWord = match[3] || '';
  var ms, member, method, currency;
  if (!(amount > 0) || amount >= 1000000) return tgUnknown(raw, 'line');
  ms = tgScoreMembers(memberQuery, catalog.members || [], choice && choice.memberId);
  if (ms.status === 'none') return tgUnknown(raw, 'member');
  if (ms.status === 'ambiguous' && !(choice && choice.memberId)) {
    return {
      kind: 'ambiguous',
      raw: raw,
      field: 'member',
      split: null,
      prompt: 'Which member paid ' + tgMoney(tgCurrency(catalog), amount) + '?',
      options: tgPublicOptions(ms.options)
    };
  }
  member = (choice && choice.memberId) ? tgFindById(catalog.members, choice.memberId) : ms.match.row;
  if (!member) return tgUnknown(raw, 'member');
  currency = tgCurrency(catalog);
  method = choice && choice.method;
  if (method && method !== 'bank' && method !== 'cash' && method !== 'yoco') method = '';
  if (!method) {
    if (!methodWord) {
      return {
        kind: 'ambiguous',
        raw: raw,
        field: 'method',
        split: null,
        prompt: 'How did ' + member.name + ' pay ' + tgMoney(currency, amount) + '?',
        options: tgMethodOptions(),
        memberId: String(member.id)
      };
    }
    method = TG_METHOD_WORDS[methodWord];
    if (!method) return tgUnknown(raw, 'method');
  }
  return {
    kind: 'payment',
    raw: raw,
    memberId: String(member.id),
    memberName: String(member.name || ''),
    amount: amount,
    method: method,
    methodLabel: tgMethodLabel(method)
  };
}

function tgParseBalance(raw, query, catalog, choice) {
  var ms = tgScoreMembers(tgNorm(query), catalog.members || [], choice && choice.memberId);
  var member;
  if (ms.status === 'none') return tgUnknown(raw, 'member');
  if (ms.status === 'ambiguous' && !(choice && choice.memberId)) {
    return {
      kind: 'ambiguous',
      raw: raw,
      field: 'member',
      split: null,
      prompt: 'Which member is "' + tgNorm(query) + '"?',
      options: tgPublicOptions(ms.options)
    };
  }
  member = (choice && choice.memberId) ? tgFindById(catalog.members, choice.memberId) : ms.match.row;
  if (!member) return tgUnknown(raw, 'member');
  return {kind: 'balance', raw: raw, memberId: String(member.id), memberName: String(member.name || '')};
}

function tgParseLine(raw, catalog, choice) {
  var loose = tgLoose(raw);
  var balance, paid;
  if (!loose) return {kind: 'empty', raw: raw};
  if (/^balances?$/.test(loose)) return {kind: 'balances', raw: raw};
  balance = /^balance\s+(.+)$/.exec(loose);
  if (balance) return tgParseBalance(raw, balance[1], catalog, choice);
  paid = /^(.*?)\s+paid\s+r?\s*(\d+(?:[.,]\d{1,2})?)\s*([a-z]+)?$/.exec(loose);
  if (paid && tgNorm(paid[1])) return tgParsePayment(raw, paid, catalog, choice);
  return tgParseSale(raw, catalog, choice);
}

function tgPlan(text, catalog, choices) {
  var rawLines = String(text || '').split(/\r?\n/);
  var lines = [];
  var i, choice, parsed, pick, bookable, notes, info, line;
  catalog = catalog || {};
  choices = choices || {};
  for (i = 0; i < rawLines.length; i++) {
    if (!tgLoose(rawLines[i])) continue;
    choice = choices[String(lines.length)] || null;
    if (choice && !choice.memberId && !choice.drinkId && !choice.method && !choice.itemQuery) choice = null;
    parsed = tgParseLine(rawLines[i], catalog, choice);
    parsed.index = lines.length;
    lines.push(parsed);
  }
  pick = null;
  bookable = [];
  notes = [];
  info = [];
  for (i = 0; i < lines.length; i++) {
    line = lines[i];
    if (line.kind === 'ambiguous' && !pick) {
      pick = {
        lineIndex: line.index,
        field: line.field,
        prompt: line.prompt,
        options: line.options || [],
        split: line.split || null
      };
    }
    if (line.kind === 'sale' || line.kind === 'payment') bookable.push(line);
    if (line.kind === 'unknown') notes.push(line);
    if (line.kind === 'balance' || line.kind === 'balances') info.push(line);
  }
  return {
    lines: lines,
    pick: pick,
    bookable: bookable,
    notes: notes,
    info: info,
    ready: !pick && bookable.length > 0
  };
}

function tgCopyChoice(ch) {
  if (!ch) return {};
  return {
    memberId: ch.memberId || '',
    drinkId: ch.drinkId || '',
    method: ch.method || '',
    memberQuery: ch.memberQuery || '',
    itemQuery: ch.itemQuery || '',
    qty: ch.qty || 0
  };
}

function tgApplyChoice(choices, pick, optionId) {
  var next = {};
  var k, key, cur;
  choices = choices || {};
  for (k in choices) {
    if (Object.prototype.hasOwnProperty.call(choices, k)) next[k] = tgCopyChoice(choices[k]);
  }
  key = String(pick.lineIndex);
  cur = next[key] || {};
  if (pick.split && pick.split.itemQuery) {
    cur.memberQuery = pick.split.memberQuery;
    cur.itemQuery = pick.split.itemQuery;
    cur.qty = pick.split.qty;
  }
  if (pick.field === 'member') cur.memberId = optionId;
  else if (pick.field === 'item') cur.drinkId = optionId;
  else if (pick.field === 'method') cur.method = optionId;
  next[key] = cur;
  return next;
}

function tgQuote(plan) {
  var ops = [];
  var i, line;
  for (i = 0; i < plan.bookable.length; i++) {
    line = plan.bookable[i];
    if (line.kind === 'sale') {
      ops.push({
        kind: 'sale',
        memberId: line.memberId,
        drinkId: line.drinkId,
        qty: line.qty,
        unitPrice: line.unitPrice,
        memberName: line.memberName,
        drinkName: line.drinkName,
        raw: line.raw
      });
    } else if (line.kind === 'payment') {
      ops.push({
        kind: 'payment',
        memberId: line.memberId,
        amount: line.amount,
        method: line.method,
        memberName: line.memberName,
        raw: line.raw
      });
    }
  }
  return ops;
}

function tgMemberBalance(doc, memberId) {
  var sum = 0;
  var txs = (doc && doc.transactions) || [];
  var i, t;
  for (i = 0; i < txs.length; i++) {
    t = txs[i];
    if (String(t.memberId) === String(memberId)) sum += Number(t.amount) || 0;
  }
  return sum;
}

function tgFormatBalance(currency, balance) {
  if (balance < -0.0001) return 'owes ' + tgMoney(currency, balance);
  if (balance > 0.0001) return 'credit ' + tgMoney(currency, balance);
  return 'settled ' + tgMoney(currency, 0);
}

function tgOwingRows(doc) {
  var members = (doc && doc.members) || [];
  var rows = [];
  var i, b;
  for (i = 0; i < members.length; i++) {
    b = tgMemberBalance(doc, members[i].id);
    if (b < -0.0001) rows.push({id: String(members[i].id), name: String(members[i].name || ''), balance: b});
  }
  rows.sort(function(a, b) {
    if (a.balance !== b.balance) return a.balance - b.balance;
    if (a.name < b.name) return -1;
    if (a.name > b.name) return 1;
    return 0;
  });
  return rows;
}

function tgFormatOwing(doc, currency) {
  var rows = tgOwingRows(doc);
  var lines, i, limit;
  if (!rows.length) return 'Nobody owes the bar.';
  lines = ['Members owing (' + rows.length + '):'];
  limit = 30;
  for (i = 0; i < rows.length && i < limit; i++) {
    lines.push(rows[i].name + ' — ' + tgMoney(currency, rows[i].balance));
  }
  if (rows.length > limit) lines.push('…and ' + (rows.length - limit) + ' more');
  return lines.join('\n');
}

function tgFormatSide(plan, doc, currency) {
  var lines = [];
  var i, info;
  if (plan.notes && plan.notes.length) {
    lines.push('Not booked:');
    for (i = 0; i < plan.notes.length; i++) {
      lines.push('• ' + plan.notes[i].raw + ' — ' + tgUnknownText(plan.notes[i]));
    }
  }
  if (plan.info && plan.info.length) {
    if (lines.length) lines.push('');
    for (i = 0; i < plan.info.length; i++) {
      info = plan.info[i];
      if (info.kind === 'balances') lines.push(tgFormatOwing(doc, currency));
      else lines.push(info.memberName + ': ' + tgFormatBalance(currency, tgMemberBalance(doc, info.memberId)));
    }
  }
  return lines.join('\n');
}

function tgFormatConfirm(plan, doc, currency) {
  var cur = currency || tgCurrency(doc);
  var lines = ['Check this, then tap Confirm. Nothing is saved yet.', ''];
  var saleTotal = 0;
  var payTotal = 0;
  var i, op, lineTotal, side;
  for (i = 0; i < plan.bookable.length; i++) {
    op = plan.bookable[i];
    if (op.kind === 'sale') {
      lineTotal = (Number(op.unitPrice) || 0) * op.qty;
      saleTotal += lineTotal;
      lines.push('• ' + op.memberName + ' — ' + op.drinkName + ' ×' + op.qty + ' @ ' + tgMoney(cur, op.unitPrice) + ' = ' + tgMoney(cur, lineTotal));
    } else {
      payTotal += Number(op.amount) || 0;
      lines.push('• ' + op.memberName + ' paid ' + tgMoney(cur, op.amount) + ' ' + (op.methodLabel || tgMethodLabel(op.method)));
    }
  }
  if (plan.bookable.length) {
    lines.push('');
    lines.push('Tab total: ' + tgMoney(cur, saleTotal));
    if (payTotal) lines.push('Payments: ' + tgMoney(cur, payTotal));
  }
  side = tgFormatSide(plan, doc, cur);
  if (side) {
    lines.push('');
    lines.push(side);
  }
  return lines.join('\n');
}

function tgIsTelegramUpdate(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return false;
  if (payload.action) return false;
  if (payload.update_id == null || payload.update_id === '') return false;
  if (Array.isArray(payload.members) || Array.isArray(payload.transactions) || Array.isArray(payload.drinks) || Array.isArray(payload.users)) return false;
  if (payload.settings || payload.stock_purchases || payload.deletedDrinks || payload.audit) return false;
  if (payload.callback_query && typeof payload.callback_query === 'object') return true;
  if (payload.message && typeof payload.message === 'object') return true;
  return false;
}

function tgParseCallback(data) {
  var parts = String(data || '').split(':');
  if ((parts[0] === 'y' || parts[0] === 'n') && parts.length === 2 && parts[1]) {
    return {type: parts[0] === 'y' ? 'confirm' : 'cancel', id: parts[1]};
  }
  if (parts[0] === 'p' && parts.length === 3 && parts[1] && /^\d+$/.test(parts[2])) {
    return {type: 'pick', id: parts[1], option: parseInt(parts[2], 10)};
  }
  return null;
}
/* TG_PARSER_END */
