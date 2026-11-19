/**
 * CCC Bar Tab — apply confirmed Telegram ops to the cloud document.
 *
 * Pure: no LockService, no Drive, no Sheets. telegram.gs calls these
 * functions inside a script lock after reading the same JSON document
 * the bar tab app reads. The document is cloned; existing rows are kept.
 * Sales and top-ups use the same fields as the on-screen buttons.
 *
 * telegramProtectSave is the small merge the existing doPost should run
 * before it writes a phone snapshot, so a booking made a few minutes
 * earlier is not dropped by a phone that had not seen it yet.
 */
/* TG_APPLY_START */
var TG_PROTECT_MS = 5 * 60 * 1000;

function tgPurchaseDesc(drink, qty) {
  var icon = (drink && drink.imgType === 'emoji' && drink.img) ? String(drink.img) : '';
  var name = drink && drink.name ? String(drink.name) : '';
  return (icon ? icon + ' ' : ' ') + name + ' ×' + qty;
}

function tgPaymentDesc(method) {
  if (method === 'bank') return '🏦 EFT/Bank Transfer';
  if (method === 'yoco') return '💳 Yoco Card Payment';
  return '💵 Cash Top-Up';
}

function tgStamp(nowIso, index) {
  var ms = Date.parse(nowIso);
  if (isNaN(ms)) ms = Date.now();
  return new Date(ms + (index || 0)).toISOString();
}

function tgNextId(ctx, n) {
  if (ctx && typeof ctx.nextId === 'function') return String(ctx.nextId());
  return 'tg' + n;
}

function tgAssertNoLoss(before, after) {
  var keys = ['transactions', 'members', 'drinks', 'users', 'stock_purchases', 'deletedDrinks'];
  var i, key, a, b, k;
  function len(obj, name) {
    if (!obj || Object.prototype.toString.call(obj[name]) !== '[object Array]') return 0;
    return obj[name].length;
  }
  for (i = 0; i < keys.length; i++) {
    key = keys[i];
    a = len(before, key);
    b = len(after, key);
    if (b < a) throw new Error('refusing to shrink ' + key);
  }
  if (before && before.settings && after && after.settings) {
    for (k in before.settings) {
      if (Object.prototype.hasOwnProperty.call(before.settings, k) &&
          !Object.prototype.hasOwnProperty.call(after.settings, k)) {
        throw new Error('refusing to drop settings');
      }
    }
  }
  return true;
}

function tgSkipText(reason) {
  if (reason === 'price-changed') return 'price changed, send the line again';
  if (reason === 'drink-missing') return 'drink is not on the menu';
  if (reason === 'member-missing') return 'member is not on the list';
  if (reason === 'duplicate') return 'already booked';
  return 'not booked';
}

function tgApplyOps(doc, ops, ctx) {
  var empty = {ok: false, changed: false, doc: doc, booked: [], skipped: [], already: [], balances: []};
  var next, existingRefs, existingIds, i, t, changed, seq, booked, skipped, already, touched;
  ctx = ctx || {};
  ops = ops || [];
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
    empty.error = 'bad-document';
    return empty;
  }
  if (doc.transactions != null && Object.prototype.toString.call(doc.transactions) !== '[object Array]') {
    empty.error = 'bad-transactions';
    return empty;
  }
  next = JSON.parse(JSON.stringify(doc));
  existingRefs = {};
  existingIds = {};
  if (Object.prototype.toString.call(next.transactions) === '[object Array]') {
    for (i = 0; i < next.transactions.length; i++) {
      t = next.transactions[i];
      if (t && t.id != null) existingIds[String(t.id)] = true;
      if (t && t.sourceRef) existingRefs[String(t.sourceRef)] = true;
    }
  }
  changed = false;
  seq = 0;
  booked = [];
  skipped = [];
  already = [];
  touched = [];
  function remember(memberId, memberName) {
    var id = String(memberId);
    var j;
    for (j = 0; j < touched.length; j++) if (touched[j].memberId === id) return;
    touched.push({memberId: id, name: memberName});
  }
  for (i = 0; i < ops.length; i++) {
    var op = ops[i] || {};
    var ref = String(ctx.sourceRef || 'tg') + ':' + i;
    var member, drink, livePrice, amount, desc, txId, stamp, tx, auditAction, who, whoId;
    if (existingRefs[ref]) {
      already.push({raw: op.raw || '', reason: 'duplicate', memberId: op.memberId, memberName: op.memberName || ''});
      remember(op.memberId, op.memberName || '');
      continue;
    }
    member = tgFindById(next.members, op.memberId);
    if (!member) {
      skipped.push({raw: op.raw || '', reason: 'member-missing'});
      continue;
    }
    who = ctx.confirmedByName ? String(ctx.confirmedByName) : 'Telegram';
    whoId = ctx.confirmedById != null ? String(ctx.confirmedById) : '';
    txId = tgNextId(ctx, seq);
    if (existingIds[txId]) txId = txId + 'x' + i;
    stamp = tgStamp(ctx.nowIso, seq);
    seq += 1;
    if (op.kind === 'sale') {
      drink = tgFindById(next.drinks, op.drinkId);
      if (!drink || tgIsTombstoned(drink, next.deletedDrinks || [])) {
        skipped.push({raw: op.raw || '', reason: 'drink-missing'});
        continue;
      }
      livePrice = Number(drink.price) || 0;
      if (Math.abs(livePrice - Number(op.unitPrice)) > 0.001) {
        skipped.push({raw: op.raw || '', reason: 'price-changed'});
        continue;
      }
      amount = -(livePrice * op.qty);
      desc = tgPurchaseDesc(drink, op.qty);
      tx = {
        id: txId,
        memberId: String(member.id),
        amount: amount,
        desc: desc,
        date: stamp,
        type: 'purchase',
        enteredBy: 'telegram:' + whoId,
        enteredByName: who,
        device: 'Telegram',
        source: 'telegram',
        sourceRef: ref
      };
      auditAction = 'Purchased ' + tgMoney((next.settings && next.settings.currency) || 'R', Math.abs(amount)) + ' for ' + member.name + ': ' + desc;
      if (ctx.trackInventory) {
        drink.stock = Math.max(0, (Number(drink.stock) || 0) - op.qty);
      }
    } else if (op.kind === 'payment') {
      amount = Number(op.amount);
      if (!(amount > 0)) {
        skipped.push({raw: op.raw || '', reason: 'line'});
        continue;
      }
      if (op.method !== 'bank' && op.method !== 'cash' && op.method !== 'yoco') {
        skipped.push({raw: op.raw || '', reason: 'method'});
        continue;
      }
      desc = tgPaymentDesc(op.method);
      tx = {
        id: txId,
        memberId: String(member.id),
        amount: amount,
        desc: desc,
        date: stamp,
        type: 'topup',
        method: op.method,
        enteredBy: 'telegram:' + whoId,
        enteredByName: who,
        device: 'Telegram',
        source: 'telegram',
        sourceRef: ref
      };
      auditAction = 'Top-up ' + tgMoney((next.settings && next.settings.currency) || 'R', amount) + ' for ' + member.name + ' (' + op.method + ')';
    } else {
      skipped.push({raw: op.raw || '', reason: 'line'});
      continue;
    }
    if (Object.prototype.toString.call(next.transactions) !== '[object Array]') next.transactions = [];
    if (Object.prototype.toString.call(next.audit) !== '[object Array]') next.audit = [];
    next.transactions.push(tx);
    next.audit.unshift({
      id: tgNextId(ctx, seq),
      date: stamp,
      userId: 'telegram:' + whoId,
      userName: who,
      userRole: 'telegram',
      device: 'Telegram',
      action: auditAction,
      type: tx.type,
      memberId: String(member.id),
      memberName: String(member.name || ''),
      amount: amount,
      txId: txId,
      source: 'telegram'
    });
    seq += 1;
    if (next.audit.length > 1000) next.audit = next.audit.slice(0, 1000);
    existingRefs[ref] = true;
    existingIds[txId] = true;
    changed = true;
    booked.push({
      kind: op.kind,
      memberId: String(member.id),
      memberName: String(member.name || ''),
      amount: amount,
      desc: desc,
      method: op.method || '',
      txId: txId,
      qty: op.qty || 0
    });
    remember(member.id, member.name || '');
  }
  try {
    tgAssertNoLoss(doc, next);
  } catch (err) {
    empty.error = String(err && err.message || err);
    return empty;
  }
  var balances = [];
  for (i = 0; i < touched.length; i++) {
    balances.push({
      memberId: touched[i].memberId,
      name: touched[i].name,
      balance: tgMemberBalance(next, touched[i].memberId)
    });
  }
  return {
    ok: true,
    changed: changed,
    doc: changed ? next : doc,
    booked: booked,
    skipped: skipped,
    already: already,
    balances: balances
  };
}

function tgFormatApplied(result, currency) {
  var cur = currency || 'R';
  var lines = [];
  var i, row, b;
  if (result.changed && result.booked && result.booked.length) {
    lines.push('Booked.');
    lines.push('');
    for (i = 0; i < result.booked.length; i++) {
      row = result.booked[i];
      if (row.kind === 'sale') lines.push('• ' + row.memberName + ' — ' + row.desc + ' — ' + tgMoney(cur, row.amount));
      else lines.push('• ' + row.memberName + ' paid ' + tgMoney(cur, row.amount) + ' ' + tgMethodLabel(row.method));
    }
  } else if (result.already && result.already.length) {
    lines.push('Already booked. Nothing new was written.');
  } else {
    lines.push('Nothing was booked.');
  }
  if (result.balances && result.balances.length) {
    lines.push('');
    lines.push('Balances:');
    for (i = 0; i < result.balances.length; i++) {
      b = result.balances[i];
      lines.push(b.name + ': ' + tgFormatBalance(cur, b.balance));
    }
  }
  if (result.skipped && result.skipped.length) {
    lines.push('');
    lines.push('Not booked:');
    for (i = 0; i < result.skipped.length; i++) {
      lines.push('• ' + (result.skipped[i].raw || 'line') + ' — ' + tgSkipText(result.skipped[i].reason));
    }
  }
  return lines.join('\n');
}

// Copy source "telegram" rows from the last few minutes that the incoming
// list has not seen. Returns the same array when nothing needs copying.
function tgRescueTelegramRows(currentRows, incomingRows, now) {
  var cur, ids, rescued, i, row, ms;
  if (Object.prototype.toString.call(incomingRows) !== '[object Array]') return incomingRows;
  cur = Object.prototype.toString.call(currentRows) === '[object Array]' ? currentRows : [];
  ids = {};
  rescued = [];
  for (i = 0; i < incomingRows.length; i++) {
    row = incomingRows[i];
    if (row && row.id != null) ids[String(row.id)] = true;
  }
  for (i = 0; i < cur.length; i++) {
    row = cur[i];
    if (!row || row.id == null || ids[String(row.id)]) continue;
    if (row.source !== 'telegram') continue;
    ms = Date.parse(row.date);
    if (isNaN(ms) || now - ms > TG_PROTECT_MS || now - ms < -TG_PROTECT_MS) continue;
    rescued.push(row);
    ids[String(row.id)] = true;
  }
  if (!rescued.length) return incomingRows;
  return incomingRows.slice().concat(rescued);
}

// Keep a Telegram booking that a phone snapshot has not seen yet.
// The phone snapshot stays the base, so a later force push can still
// delete old rows. Only source "telegram" transactions and audit rows
// from the last few minutes are copied back on. Inputs are not mutated.
function telegramProtectSave(current, incoming, nowMs) {
  var now = (nowMs == null) ? Date.now() : nowMs;
  var transactions, audit, out, k, changed;
  if (!incoming || typeof incoming !== 'object' || Array.isArray(incoming)) return incoming;
  if (!current || typeof current !== 'object' || Array.isArray(current)) return incoming;
  transactions = tgRescueTelegramRows(current.transactions, incoming.transactions, now);
  audit = tgRescueTelegramRows(current.audit, incoming.audit, now);
  changed = transactions !== incoming.transactions || audit !== incoming.audit;
  if (!changed) return incoming;
  out = {};
  for (k in incoming) {
    if (Object.prototype.hasOwnProperty.call(incoming, k)) out[k] = incoming[k];
  }
  if (transactions !== incoming.transactions) out.transactions = transactions;
  if (audit !== incoming.audit) out.audit = audit;
  return out;
}
/* TG_APPLY_END */
