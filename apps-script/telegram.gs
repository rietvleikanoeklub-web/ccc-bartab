/**
 * CCC Bar Tab — Telegram webhook for the EXISTING Apps Script project.
 *
 * The live script is not in this repo. Paste this file, telegram-parser.gs,
 * and telegram-apply.gs into that project (club Google account). Do not add
 * a second doGet or doPost. V8 runtime is required (the Apps Script default).
 *
 * 1. At the very top of the existing doPost, before any save:
 *
 *    var telegramResponse = telegramTryHandle(e);
 *    if (telegramResponse) return telegramResponse;
 *
 *    App saves and sendEmail posts do not look like Telegram updates, so
 *    they fall through unchanged.
 *
 * 2. Point the bot at the same JSON document the app already uses. Add these
 *    two functions if the project does not already have them, calling the
 *    read and write the script already uses (Drive file or CCCBarTab!A1).
 *    Do not define them if you already have functions with these names.
 *
 *    function cccReadDocument() {
 *      // return the object the web app GET returns as data
 *    }
 *    function cccWriteDocument(doc) {
 *      // write that full object back the same way a normal save does
 *    }
 *
 *    If you do not add them, set Script Property BARTAB_STORE to "sheet"
 *    or "drive". For drive, also set BARTAB_FILE_ID. Sheet mode reads the
 *    existing CCCBarTab tab, cell A1, and does not create a new file.
 *
 * 3. Replace the line that overwrites the JSON with the phone's snapshot:
 *
 *    var saved = telegramLockedSave(payload);
 *    try { if (typeof updateViewSheets === 'function') updateViewSheets(saved); } catch (viewErr) {}
 *
 *    telegramLockedSave holds the script lock, re-reads the document, and
 *    keeps a Telegram booking from the last 5 minutes if this snapshot was
 *    read before the booking landed. It refuses a payload that is not a full
 *    bar document (members, drinks, and transactions arrays), so a stray
 *    post cannot replace the file. A normal app save still sends the full
 *    document, including a force push.
 *
 * 4. Deploy a new version of the SAME web app deployment so the /exec URL
 *    does not change. Script Properties can be changed without a new deploy.
 *    Set the webhook only after that deploy. See the README.
 *
 * Script properties (never commit the values):
 *   TELEGRAM_BOT_TOKEN
 *   TELEGRAM_ALLOWED_IDS       comma-separated numeric Telegram user ids
 *   TELEGRAM_WEBHOOK_SECRET    optional; matched to the ?tg= query on the webhook
 *   BARTAB_STORE               sheet | drive | auto
 *   BARTAB_FILE_ID             Drive file id when the JSON lives in Drive
 *   TRACK_INVENTORY            true only if the app's TRACK_INVENTORY flag is true
 */

function telegramTryHandle(e) {
  var payload = null;
  try {
    payload = telegramParseBody_(e);
    if (!tgIsTelegramUpdate(payload)) return null;
    if (!telegramSecretOk_(e)) return telegramJson_({ok: false, error: 'forbidden'});
  } catch (err) {
    telegramLog_(err);
    return null;
  }
  try {
    if (telegramSeen_(payload.update_id)) return telegramJson_({ok: true, duplicate: true});
    telegramDispatch_(payload);
    return telegramJson_({ok: true});
  } catch (err) {
    telegramLog_(err);
    return telegramJson_({ok: false, error: 'telegram'});
  }
}

function telegramLockedSave(payload) {
  if (tgIsTelegramUpdate(payload)) throw new Error('Refusing to store a Telegram update as the bar tab');
  if (!telegramPayloadComplete_(payload)) throw new Error('Refusing to store a payload that is not the full bar tab');
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var loaded = telegramLoadDocument_();
    var merged = telegramProtectSave(loaded.doc, payload);
    if (!telegramPayloadComplete_(merged)) throw new Error('Refusing to write an incomplete bar tab');
    telegramSaveDocument_(loaded, merged);
    return merged;
  } finally {
    lock.releaseLock();
  }
}

function telegramDispatch_(update) {
  if (update.callback_query) {
    telegramOnCallback_(update.callback_query);
    return;
  }
  var msg = update.message;
  if (!msg || !msg.chat) return;
  if (msg.from && msg.from.is_bot) return;
  var from = msg.from || {};
  var userId = from.id != null ? String(from.id) : '';
  var chatId = String(msg.chat.id);
  if (!userId) return;
  var text = msg.text ? String(msg.text) : '';
  var command = telegramCommand_(text);
  if (!telegramAllowed_(userId)) {
    if (command || text) {
      var reply = (command === 'start' || command === 'register' || command === 'help' || command === 'id')
        ? telegramRegisterText_(userId)
        : 'Send /start to get your Telegram id.';
      telegramSend_(chatId, reply, null);
    }
    return;
  }
  if (command === 'start' || command === 'help' || command === 'register' || command === 'id') {
    telegramSend_(chatId, telegramHelpText_(userId), null);
    return;
  }
  if (!text.replace(/^\s+|\s+$/g, '')) {
    telegramSend_(chatId, 'Send a text command, or /help.', null);
    return;
  }
  var loaded;
  try {
    loaded = telegramLoadDocument_();
  } catch (err) {
    telegramLog_(err);
    telegramSend_(chatId, 'Could not read the bar tab. Nothing was booked.', null);
    return;
  }
  var plan = tgPlan(text, telegramCatalog_(loaded.doc), {});
  var pending = telegramNewPending_(userId, chatId, text);
  telegramRender_(pending, loaded.doc, plan, null);
}

function telegramOnCallback_(cq) {
  var from = cq.from || {};
  var userId = from.id != null ? String(from.id) : '';
  var parsed = tgParseCallback(cq.data || '');
  var message = cq.message || {};
  var chat = message.chat || {};
  var chatId = chat.id != null ? String(chat.id) : userId;
  var messageId = message.message_id;
  if (!telegramAllowed_(userId)) {
    telegramAnswer_(cq.id, '');
    telegramSend_(chatId, telegramRegisterText_(userId), null);
    return;
  }
  if (!parsed) {
    telegramAnswer_(cq.id, '');
    return;
  }
  var pending = telegramLoadPending_(parsed.id);
  if (pending && pending.chatId) chatId = String(pending.chatId);
  if (!pending) {
    telegramAnswer_(cq.id, 'Expired');
    telegramEditOrSend_(chatId, messageId, 'That confirmation expired. Nothing was booked. Send the order again.', null);
    return;
  }
  if (String(pending.userId) !== userId) {
    telegramAnswer_(cq.id, 'Only the person who sent this order can confirm it.');
    return;
  }
  telegramAnswer_(cq.id, '');
  if (parsed.type === 'cancel') {
    telegramDropPending_(pending.id);
    telegramEditOrSend_(chatId, messageId, 'Cancelled. Nothing was booked.', null);
    return;
  }
  if (parsed.type === 'pick') {
    if (!pending.pick || !pending.pick.options || parsed.option < 0 || parsed.option >= pending.pick.options.length) {
      telegramEditOrSend_(chatId, messageId, 'That choice expired. Send the order again.', null);
      return;
    }
    var optionId = pending.pick.options[parsed.option].id;
    pending.choices = tgApplyChoice(pending.choices || {}, pending.pick, optionId);
    var loaded;
    try {
      loaded = telegramLoadDocument_();
    } catch (err) {
      telegramLog_(err);
      telegramSavePending_(pending);
      telegramEditOrSend_(chatId, messageId, 'Could not read the bar tab. Nothing was booked.', null);
      return;
    }
    var plan = tgPlan(pending.text, telegramCatalog_(loaded.doc), pending.choices);
    telegramRender_(pending, loaded.doc, plan, messageId);
    return;
  }
  if (pending.phase !== 'confirm' || Object.prototype.toString.call(pending.quoted) !== '[object Array]' || !pending.quoted.length) {
    telegramEditOrSend_(chatId, messageId, 'Nothing to confirm. Send the order again.', null);
    return;
  }
  var outcome = telegramCommit_(pending, from);
  if (outcome.keep) {
    telegramSend_(chatId, outcome.message, null);
    return;
  }
  telegramDropPending_(pending.id);
  telegramEditOrSend_(chatId, messageId, outcome.message, null);
}

function telegramRender_(pending, doc, plan, messageId) {
  var currency = (doc.settings && doc.settings.currency) || 'R';
  var chatId = pending.chatId;
  var side, body, buttons, i;
  if (plan.pick) {
    pending.phase = 'pick';
    pending.pick = {
      lineIndex: plan.pick.lineIndex,
      field: plan.pick.field,
      prompt: plan.pick.prompt,
      options: plan.pick.options,
      split: plan.pick.split || null
    };
    pending.quoted = null;
    telegramSavePending_(pending);
    buttons = [];
    for (i = 0; i < plan.pick.options.length; i++) {
      buttons.push({text: plan.pick.options[i].label, data: 'p:' + pending.id + ':' + i});
    }
    body = plan.pick.prompt;
    side = tgFormatSide(plan, doc, currency);
    if (side) body = side + '\n\n' + body;
    if (plan.bookable.length) body += '\n\nOther complete lines are held until you choose.';
    telegramEditOrSend_(chatId, messageId, body, telegramButtonRows_(buttons));
    return;
  }
  if (!plan.bookable.length) {
    telegramDropPending_(pending.id);
    side = tgFormatSide(plan, doc, currency);
    if (!side) side = 'Nothing to book. Send /help for examples.';
    telegramEditOrSend_(chatId, messageId, side, null);
    return;
  }
  pending.phase = 'confirm';
  pending.pick = null;
  pending.quoted = tgQuote(plan);
  pending.currency = currency;
  telegramSavePending_(pending);
  telegramEditOrSend_(chatId, messageId, tgFormatConfirm(plan, doc, currency), telegramConfirmRows_(pending.id));
}

function telegramCommit_(pending, from) {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) {
    return {keep: true, message: 'The bar tab is busy. Tap Confirm again in a few seconds. Nothing was saved yet.'};
  }
  try {
    var loaded = telegramLoadDocument_();
    var currency = (loaded.doc.settings && loaded.doc.settings.currency) || pending.currency || 'R';
    var result = tgApplyOps(loaded.doc, pending.quoted, {
      nowIso: new Date().toISOString(),
      trackInventory: telegramTrackInventory_(),
      confirmedById: String(from && from.id != null ? from.id : pending.userId),
      confirmedByName: telegramFromName_(from),
      sourceRef: 'tg:' + pending.id,
      nextId: telegramNewId_
    });
    if (!result.ok) return {keep: true, message: 'Could not update the bar tab. Nothing was saved.'};
    if (result.changed) {
      tgAssertNoLoss(loaded.doc, result.doc);
      telegramSaveDocument_(loaded, result.doc);
    }
    return {keep: false, message: tgFormatApplied(result, currency)};
  } catch (err) {
    telegramLog_(err);
    return {keep: true, message: 'Could not update the bar tab. Nothing was saved.'};
  } finally {
    lock.releaseLock();
  }
}

function telegramLoadDocument_() {
  var mode = (telegramProp_('BARTAB_STORE') || 'auto').toLowerCase();
  var fileId = telegramProp_('BARTAB_FILE_ID').replace(/^\s+|\s+$/g, '');
  var custom, text, driveDoc, sheet, sheetDoc;
  if (typeof cccReadDocument === 'function') {
    custom = telegramCoerceDoc_(cccReadDocument());
    if (!telegramDocLooksReal_(custom)) throw new Error('cccReadDocument did not return the bar tab');
    return {via: 'custom', doc: custom};
  }
  if (mode === 'drive' || (fileId && mode !== 'sheet')) {
    if (!fileId) throw new Error('Set BARTAB_FILE_ID to the Drive file the app already uses');
    text = DriveApp.getFileById(fileId).getBlob().getDataAsString('UTF-8');
    driveDoc = telegramCoerceDoc_(text);
    if (!telegramDocLooksReal_(driveDoc)) throw new Error('That Drive file is not the bar tab document');
    return {via: 'drive', fileId: fileId, doc: driveDoc};
  }
  sheet = telegramSheet_();
  if (!sheet) throw new Error('No CCCBarTab sheet. Set BARTAB_FILE_ID or add cccReadDocument.');
  sheetDoc = telegramCoerceDoc_(sheet.getRange('A1').getValue());
  if (!telegramDocLooksReal_(sheetDoc)) throw new Error('CCCBarTab!A1 is not the bar tab document');
  return {via: 'sheet', sheet: sheet, doc: sheetDoc};
}

function telegramSaveDocument_(loaded, doc) {
  var json;
  if (!telegramDocLooksReal_(doc)) throw new Error('refusing to write a document that is not the bar tab');
  if (loaded.via === 'custom') {
    if (typeof cccWriteDocument !== 'function') throw new Error('cccWriteDocument is missing');
    cccWriteDocument(doc);
    return;
  }
  json = JSON.stringify(doc);
  if (!json || json.length < 20) throw new Error('refusing to write an empty document');
  if (loaded.via === 'drive') {
    DriveApp.getFileById(loaded.fileId).setContent(json);
    return;
  }
  loaded.sheet.getRange('A1').setValue(json);
  loaded.sheet.getRange('B1').setValue(new Date().toISOString());
  if (typeof updateViewSheets === 'function') {
    try { updateViewSheets(doc); } catch (viewErr) { telegramLog_(viewErr); }
  }
}

function telegramSheet_() {
  try {
    var ss = SpreadsheetApp.getActive();
    if (!ss) return null;
    return ss.getSheetByName('CCCBarTab');
  } catch (err) {
    return null;
  }
}

function telegramCoerceDoc_(value) {
  if (value == null || value === '') return null;
  if (typeof value === 'string') {
    var text = String(value).replace(/^\uFEFF/, '').replace(/^\s+|\s+$/g, '');
    if (!text || text.charAt(0) !== '{') return null;
    value = JSON.parse(text);
  }
  if (value && value.ok === true && value.data && typeof value.data === 'object' && !Array.isArray(value.data)) {
    return value.data;
  }
  return value;
}

function telegramDocLooksReal_(doc) {
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return false;
  var keys = ['members', 'drinks', 'transactions'];
  var i;
  for (i = 0; i < keys.length; i++) {
    if (Object.prototype.toString.call(doc[keys[i]]) === '[object Array]') return true;
  }
  return false;
}

function telegramPayloadComplete_(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return false;
  if (payload.action) return false;
  var keys = ['members', 'drinks', 'transactions'];
  var i;
  for (i = 0; i < keys.length; i++) {
    if (Object.prototype.toString.call(payload[keys[i]]) !== '[object Array]') return false;
  }
  return true;
}

function telegramCatalog_(doc) {
  return {
    members: doc.members || [],
    drinks: doc.drinks || [],
    deletedDrinks: doc.deletedDrinks || [],
    settings: doc.settings || {}
  };
}

function telegramTrackInventory_() {
  var v = telegramProp_('TRACK_INVENTORY').toLowerCase();
  return v === 'true' || v === '1' || v === 'yes';
}

function telegramProp_(name) {
  var v = PropertiesService.getScriptProperties().getProperty(name);
  return v == null ? '' : String(v);
}

function telegramAllowed_(userId) {
  var parts = telegramProp_('TELEGRAM_ALLOWED_IDS').split(/[^0-9]+/);
  var want = String(userId);
  var i;
  for (i = 0; i < parts.length; i++) {
    if (parts[i] && parts[i] === want) return true;
  }
  return false;
}

function telegramSecretOk_(e) {
  var expected = telegramProp_('TELEGRAM_WEBHOOK_SECRET').replace(/^\s+|\s+$/g, '');
  var got = '';
  if (!expected) return true;
  if (e && e.parameter && e.parameter.tg != null) got = String(e.parameter.tg);
  return got === expected;
}

function telegramParseBody_(e) {
  var raw, trimmed;
  if (!e || !e.postData || typeof e.postData.contents !== 'string') return null;
  raw = e.postData.contents;
  trimmed = raw.replace(/^\uFEFF/, '').replace(/^\s+|\s+$/g, '');
  if (!trimmed || trimmed.charAt(0) !== '{') return null;
  try { return JSON.parse(trimmed); } catch (err) { return null; }
}

function telegramCommand_(text) {
  var m = /^\/([A-Za-z0-9_]+)(?:@[A-Za-z0-9_]+)?/.exec(String(text || '').replace(/^\s+|\s+$/g, ''));
  if (!m) return '';
  return m[1].toLowerCase();
}

function telegramRegisterText_(userId) {
  return 'Your Telegram id is ' + userId + '.\nSend that number to a bar admin to be added.\nNo bar data is available until then.';
}

function telegramHelpText_(userId) {
  return [
    'CCC Bar Tab. One command per line. Nothing is written until you tap Confirm.',
    '',
    'Sales',
    'Sam K 1 wine',
    'Alex 2 beer',
    'TC 1 water',
    'Alex 2x beer',
    '',
    'Payments',
    'Alex paid 200 EFT',
    'Alex paid 50 cash',
    'Alex paid 80 card',
    '',
    'Balances',
    'balance Sam K',
    'balances',
    '',
    'Your Telegram id is ' + userId + '.'
  ].join('\n');
}

function telegramFromName_(from) {
  var parts = [];
  var name = '';
  if (!from) return 'Telegram';
  if (from.first_name) parts.push(String(from.first_name));
  if (from.last_name) parts.push(String(from.last_name));
  name = parts.join(' ').replace(/[\r\n\t]+/g, ' ').replace(/^\s+|\s+$/g, '');
  if (!name && from.username) name = String(from.username);
  if (!name) name = 'Telegram ' + from.id;
  if (name.length > 60) name = name.substring(0, 60);
  return name;
}

function telegramNewId_() {
  return Date.now().toString(36) + Math.floor(Math.random() * 1e6).toString(36);
}

function telegramNewPending_(userId, chatId, text) {
  return {
    id: Utilities.getUuid().replace(/-/g, '').substring(0, 8),
    userId: String(userId),
    chatId: String(chatId),
    text: String(text || ''),
    choices: {},
    phase: 'pick',
    pick: null,
    quoted: null,
    currency: 'R'
  };
}

function telegramSavePending_(pending) {
  CacheService.getScriptCache().put('tgp:' + pending.id, JSON.stringify(pending), 1800);
}

function telegramLoadPending_(id) {
  var raw;
  if (!id || !/^[A-Za-z0-9]+$/.test(String(id))) return null;
  raw = CacheService.getScriptCache().get('tgp:' + id);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch (err) { return null; }
}

function telegramDropPending_(id) {
  if (!id) return;
  CacheService.getScriptCache().remove('tgp:' + id);
}

function telegramSeen_(updateId) {
  var cache, key;
  if (updateId == null || updateId === '') return false;
  cache = CacheService.getScriptCache();
  key = 'tgu:' + updateId;
  if (cache.get(key)) return true;
  cache.put(key, '1', 21600);
  return false;
}

function telegramJson_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function telegramClip_(text, max) {
  var s = String(text == null ? '' : text);
  if (s.length <= max) return s;
  return s.substring(0, Math.max(0, max - 1)) + '…';
}

function telegramButtonRows_(buttons) {
  var rows = [];
  var i;
  for (i = 0; i < buttons.length; i++) {
    rows.push([{text: telegramClip_(buttons[i].text, 40), callback_data: buttons[i].data}]);
  }
  return rows;
}

function telegramConfirmRows_(id) {
  return [[
    {text: 'Confirm', callback_data: 'y:' + id},
    {text: 'Cancel', callback_data: 'n:' + id}
  ]];
}

function telegramSend_(chatId, text, rows) {
  var payload = {chat_id: chatId, text: telegramClip_(text, 4000)};
  if (rows) payload.reply_markup = {inline_keyboard: rows};
  return telegramApi_('sendMessage', payload);
}

function telegramEditOrSend_(chatId, messageId, text, rows) {
  var payload = {chat_id: chatId, text: telegramClip_(text, 4000)};
  var edited;
  if (rows) payload.reply_markup = {inline_keyboard: rows};
  if (messageId) {
    payload.message_id = messageId;
    if (!rows) payload.reply_markup = {inline_keyboard: []};
    edited = telegramApi_('editMessageText', payload);
    if (edited && edited.ok) return edited;
    delete payload.message_id;
    if (!rows) delete payload.reply_markup;
  }
  return telegramApi_('sendMessage', payload);
}

function telegramAnswer_(callbackId, text) {
  var payload = {callback_query_id: callbackId};
  if (text) payload.text = telegramClip_(text, 180);
  try { return telegramApi_('answerCallbackQuery', payload); } catch (err) { telegramLog_(err); return null; }
}

function telegramApi_(method, payload) {
  var token = telegramProp_('TELEGRAM_BOT_TOKEN').replace(/^\s+|\s+$/g, '');
  var res, body, parsed;
  if (!token) throw new Error('TELEGRAM_BOT_TOKEN is not set');
  res = UrlFetchApp.fetch('https://api.telegram.org/bot' + token + '/' + method, {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  });
  body = res.getContentText() || '';
  try { parsed = JSON.parse(body); } catch (err) { parsed = null; }
  if (!parsed || parsed.ok !== true) telegramLog_('Telegram ' + method + ' failed (' + res.getResponseCode() + ')');
  return parsed || {ok: false};
}

function telegramLog_(err) {
  var msg = err && err.message ? err.message : String(err || '');
  try { console.error(msg); } catch (e) {}
  try { Logger.log(msg); } catch (e2) {}
}
