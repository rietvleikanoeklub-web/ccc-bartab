// Unit tests for drink tombstones and the cloud merge.
// Reads the pure helpers out of index.html and runs them in a sandbox.
// Does not load the app, does not touch the network, and does not post
// to the live Apps Script.
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const htmlPath = path.join(__dirname, '..', 'index.html');
const html = fs.readFileSync(htmlPath, 'utf8');
const marked = html.match(/\/\* SYNC_PURE_START \*\/([\s\S]*?)\/\* SYNC_PURE_END \*\//);
if(!marked){
  console.error('SYNC_PURE block missing from index.html');
  process.exit(1);
}
const pureSource = marked[1];
if(/\bfetch\s*\(|localStorage|XMLHttpRequest|script\.google\.com/.test(pureSource)){
  console.error('Pure sync block must not touch the network or storage');
  process.exit(1);
}

const sandbox = { console: { log(){}, warn(){}, error(){} } };
vm.createContext(sandbox);
vm.runInContext(pureSource, sandbox, { filename: 'sync-pure.js' });

const api = [
  'drinkNameKey','isTombstoned','mergeDeletedDrinks','pruneDeletedDrinks',
  'reviveMatchingTombstones','stampDrinkTimes','applyDrinkDeletion',
  'decideSync','cloudSnapshotUsable','mergeCloudState','cloudPayload'
];
api.forEach(name=>{
  if(typeof sandbox[name] !== 'function'){
    console.error('Missing helper: '+name);
    process.exit(1);
  }
});

const {
  isTombstoned, mergeDeletedDrinks, pruneDeletedDrinks, reviveMatchingTombstones,
  stampDrinkTimes, applyDrinkDeletion, decideSync, cloudPayload
} = sandbox;

let passed = 0;
let failed = 0;
function assert(cond, msg){
  if(cond){ passed++; return; }
  failed++;
  console.error('FAIL: '+msg);
}

function clone(v){ return JSON.parse(JSON.stringify(v)); }

function baseState(over){
  const state = {
    members:[{id:'m1', name:'Pat'}],
    transactions:[{id:'tx1', memberId:'m1', amount:-20, desc:'Beer', date:'2026-11-01T10:00:00.000Z'}],
    users:[{id:'u1', pin:'1111', name:'Ada'}],
    drinks:[{id:'beer-1', name:'Beer', price:20, createdAt:'2026-01-01T00:00:00.000Z', updatedAt:'2026-01-01T00:00:00.000Z'}],
    deletedDrinks:[],
    stock_purchases:[{id:'sp-local', drinkId:'beer-1', paidBy:'m1', qty:1, cost:10}],
    audit:[{id:'a-local', date:'2026-11-12T12:00:00.000Z', action:'local'}],
    settings:{barName:'Local', deviceName:'Phone'}
  };
  if(over) Object.assign(state, over);
  return state;
}

// --- reported bug: old name tombstone must not eat a newer re-add ---
(function readdSurvivesOldTombstone(){
  const state = baseState({
    drinks:[
      {id:'beer-1', name:'Beer', price:20, createdAt:'2026-01-01T00:00:00.000Z', updatedAt:'2026-01-01T00:00:00.000Z'},
      {id:'ww-new', name:'White Wine', price:25, createdAt:'2026-11-12T15:00:00.000Z', updatedAt:'2026-11-12T15:00:00.000Z'}
    ],
    transactions:[
      {id:'tx-local', memberId:'m1', amount:-25, desc:'White Wine', date:'2026-11-12T15:00:00.000Z'}
    ]
  });
  const cloud = {
    members:[{id:'m1', name:'Pat'}, {id:'m2', name:'Sam'}],
    transactions:[{id:'tx-cloud', memberId:'m1', amount:-20, desc:'Beer', date:'2026-11-01T10:00:00.000Z'}],
    users:[{id:'u1', pin:'2222', name:'Ada'}],
    drinks:[{id:'beer-1', name:'Beer', price:22}],
    deletedDrinks:[{id:'tomb-white-wine', name:'White Wine', date:'2026-08-12'}],
    stock_purchases:[],
    audit:[{id:'a-cloud', date:'2026-11-11T00:00:00.000Z', action:'cloud'}],
    settings:{barName:'Cloud'}
  };
  const cloudTomb = cloud.deletedDrinks[0];
  const decision = decideSync(false, cloud, state);
  assert(decision.post === true, 'successful read still posts the merge');
  assert(state.drinks.some(d=>d.id==='ww-new' && d.name==='White Wine'), 're-added White Wine stays');
  assert(state.drinks.some(d=>d.id==='beer-1' && d.price===22), 'cloud drink fields win on the same id');
  assert(state.transactions.some(t=>t.id==='tx-local'), 'new local transaction kept');
  assert(state.transactions.some(t=>t.id==='tx-cloud'), 'cloud transaction kept');
  assert(state.members.some(m=>m.id==='m1') && state.members.some(m=>m.id==='m2'), 'cloud and existing members kept');
  assert(state.users.length===1 && state.users[0].pin==='2222', 'cloud users win');
  assert(state.settings.barName==='Cloud' && state.settings.deviceName==='Phone', 'settings merge keeps local-only keys');
  assert(state.stock_purchases.some(p=>p.id==='sp-local'), 'local-only stock purchase kept');
  assert(state.audit.some(a=>a.id==='a-local') && state.audit.some(a=>a.id==='a-cloud'), 'audit rows from both sides kept');
  assert(state.deletedDrinks.some(t=>t.id==='tomb-white-wine'), 'cloud tombstone is still recorded');
  assert(cloudTomb.revivedAt===undefined, 'merge does not mutate the cloud tombstone object');
  const body = cloudPayload(state);
  assert(body.drinks.some(d=>d.id==='ww-new'), 'payload includes the re-added drink');
  assert(body.transactions.some(t=>t.id==='tx-cloud') && body.transactions.some(t=>t.id==='tx-local'), 'payload keeps both transactions');
})();

(function nameMatchIsCaseInsensitive(){
  const drink = {id:'ww-2', name:'  white wine ', createdAt:'2026-11-12T15:00:00.000Z', updatedAt:'2026-11-12T15:00:00.000Z'};
  const tombs = [{id:'tomb-white-wine', name:'White Wine', date:'2026-08-12'}];
  assert(isTombstoned(drink, tombs)===false, 'older tombstone does not suppress a newer drink, ignoring case and spaces');
  const legacy = {id:'old', name:'WHITE WINE'};
  assert(isTombstoned(legacy, tombs)===true, 'unstamped drink is still suppressed by an active tombstone');
})();

(function tombstoneMustBeStrictlyNewer(){
  const tombs = [{id:'t1', name:'Gin', date:'2026-11-12T12:00:00.000Z'}];
  const sameInstant = {id:'g1', name:'Gin', createdAt:'2026-11-12T12:00:00.000Z'};
  const older = {id:'g0', name:'Gin', createdAt:'2026-11-12T11:00:00.000Z'};
  const newer = {id:'g2', name:'Gin', createdAt:'2026-11-11T00:00:00.000Z', updatedAt:'2026-11-12T13:00:00.000Z'};
  assert(isTombstoned(sameInstant, tombs)===false, 'equal timestamps do not suppress');
  assert(isTombstoned(older, tombs)===true, 'older drink is suppressed');
  assert(isTombstoned(newer, tombs)===false, 'a later updatedAt beats the deletion');
  const byId = {id:'t1', name:'Something Else', createdAt:'2026-11-12T11:00:00.000Z'};
  assert(isTombstoned(byId, tombs)===true, 'id match suppresses even when the name changed');
})();

(function revivedTombstoneDoesNotSuppress(){
  const tombs = [{id:'tomb-white-wine', name:'White Wine', date:'2026-08-12T00:00:00.000Z', revivedAt:'2026-11-12T15:00:00.000Z'}];
  assert(isTombstoned({id:'old', name:'White Wine'}, tombs)===false, 'a revival supersedes the deletion');
  const laterDelete = [{id:'tomb-white-wine', name:'White Wine', date:'2026-11-12T18:00:00.000Z', revivedAt:'2026-11-12T15:00:00.000Z'}];
  assert(isTombstoned({id:'old', name:'White Wine', updatedAt:'2026-11-12T16:00:00.000Z'}, laterDelete)===true, 'a deletion after the revival suppresses again');
})();

(function readdMarksEveryMatchingTombstone(){
  const list = [
    {id:'tomb-white-wine', name:'White Wine', date:'2026-08-12T00:00:00.000Z'},
    {id:'other-ww', name:'white wine', date:'2026-08-01T00:00:00.000Z'},
    {id:'tomb-beer', name:'Beer', date:'2026-08-01T00:00:00.000Z'}
  ];
  reviveMatchingTombstones(list, 'White Wine', 'ww-new', '2026-11-12T15:00:00.000Z');
  assert(list.length===3, 'revival does not delete tombstones');
  assert(list[0].revivedAt==='2026-11-12T15:00:00.000Z' && list[1].revivedAt==='2026-11-12T15:00:00.000Z', 'every name match is revived');
  assert(!list[2].revivedAt, 'unrelated tombstone is left alone');
  const drink = {id:'ww-new', name:'White Wine', createdAt:'2026-11-12T15:00:00.000Z', updatedAt:'2026-11-12T15:00:00.000Z'};
  assert(isTombstoned(drink, list)===false, 'revived name matches do not suppress the new drink');
})();

(function latestWinsMerge(){
  const local = [{id:'tomb-white-wine', name:'White Wine', date:'2026-08-12T00:00:00.000Z', revivedAt:'2026-11-12T15:00:00.000Z'}];
  const cloud = [{id:'tomb-white-wine', name:'White Wine', date:'2026-08-12T00:00:00.000Z'}];
  const merged = mergeDeletedDrinks(local, cloud);
  assert(merged.length===1 && merged[0].revivedAt==='2026-11-12T15:00:00.000Z', 'newer revival beats the cloud deletion');
  assert(cloud[0].revivedAt===undefined && local[0].revivedAt==='2026-11-12T15:00:00.000Z', 'inputs are not aliased');

  const localOld = [{id:'tomb-white-wine', name:'White Wine', date:'2026-08-12T00:00:00.000Z'}];
  const cloudNew = [{id:'tomb-white-wine', name:'White Wine', date:'2026-08-12T00:00:00.000Z', revivedAt:'2026-11-12T16:00:00.000Z'}];
  const merged2 = mergeDeletedDrinks(localOld, cloudNew);
  assert(merged2[0].revivedAt==='2026-11-12T16:00:00.000Z', 'newer cloud revival replaces the local deletion');

  const extra = mergeDeletedDrinks(
    [{id:'local-only', name:'Gin', date:'2026-11-01T00:00:00.000Z'}],
    [{id:'cloud-only', name:'Soda', date:'2026-11-02T00:00:00.000Z'}]
  );
  assert(extra.length===2, 'tombstones that exist on only one side are kept');

  const tieLocal = [{id:'t', name:'Gin', date:'2026-11-12T12:00:00.000Z', revivedAt:'2026-11-12T12:00:00.000Z'}];
  const tieCloud = [{id:'t', name:'Gin', date:'2026-11-12T12:00:00.000Z'}];
  assert(mergeDeletedDrinks(tieLocal, tieCloud)[0].revivedAt==='2026-11-12T12:00:00.000Z', 'tie keeps the revived copy');
})();

(function deleteAfterRevival(){
  const list = [{id:'tomb-white-wine', name:'White Wine', date:'2026-08-12T00:00:00.000Z', revivedAt:'2026-11-12T15:00:00.000Z'}];
  applyDrinkDeletion(list, {id:'ww-new', name:'White Wine'}, '2026-11-12T18:00:00.000Z');
  assert(list.length===2, 'deletion keeps the name tombstone and records the drink id');
  assert(!list[0].revivedAt && list[0].date==='2026-11-12T18:00:00.000Z', 'new deletion clears revivedAt and moves date forward');
  const before = {id:'ww-new', name:'White Wine', createdAt:'2026-11-12T15:00:00.000Z', updatedAt:'2026-11-12T15:00:00.000Z'};
  const after = {id:'ww-later', name:'White Wine', createdAt:'2026-11-12T19:00:00.000Z', updatedAt:'2026-11-12T19:00:00.000Z'};
  assert(isTombstoned(before, list)===true, 'drink from before the new deletion is suppressed');
  assert(isTombstoned(after, list)===false, 'drink saved after the new deletion is kept');
})();

(function stampsOnSave(){
  const fresh = stampDrinkTimes({id:'a', name:'Gin'}, '2026-11-12T15:00:00.000Z');
  assert(fresh.createdAt==='2026-11-12T15:00:00.000Z' && fresh.updatedAt==='2026-11-12T15:00:00.000Z', 'missing stamps are filled');
  const edited = stampDrinkTimes({id:'a', name:'Gin', createdAt:'2026-01-01T00:00:00.000Z'}, '2026-11-12T15:00:00.000Z');
  assert(edited.createdAt==='2026-01-01T00:00:00.000Z' && edited.updatedAt==='2026-11-12T15:00:00.000Z', 'existing createdAt is preserved');
})();

(function pruneUsesLatestActivity(){
  const now = new Date('2026-11-12T00:00:00.000Z').getTime();
  const old = '2026-01-01T00:00:00.000Z';
  const kept = pruneDeletedDrinks([
    {id:'revived', name:'White Wine', date:old, revivedAt:'2026-11-01T00:00:00.000Z'},
    {id:'stale', name:'Gin', date:old},
    {id:'undated', name:'Soda', date:'not-a-date'}
  ], now);
  const ids = kept.map(t=>t.id).sort();
  assert(ids.join(',')==='revived,undated', 'recent revival is kept, stale deletion is dropped, undated row is kept');
})();

(function legacyLocalDrinkStillDropped(){
  const state = baseState({
    drinks:[
      {id:'beer-1', name:'Beer', price:20},
      {id:'old-ww', name:'White Wine', price:25}
    ]
  });
  const cloud = {
    members:state.members,
    transactions:state.transactions,
    users:state.users,
    drinks:[{id:'beer-1', name:'Beer', price:20}],
    deletedDrinks:[{id:'tomb-white-wine', name:'White Wine', date:'2026-08-12T00:00:00.000Z'}],
    settings:state.settings
  };
  decideSync(false, cloud, state);
  assert(!state.drinks.some(d=>d.id==='old-ww'), 'unstamped local-only drink matching a newer tombstone is still dropped');
  assert(state.drinks.some(d=>d.id==='beer-1'), 'unrelated drinks stay');
})();

(function cloudDrinkNotRemovedByTombstone(){
  const state = baseState({
    drinks:[{id:'old-local', name:'White Wine', price:10}]
  });
  const cloud = {
    members:state.members,
    transactions:state.transactions,
    users:state.users,
    drinks:[{id:'cloud-ww', name:'White Wine', price:30}],
    deletedDrinks:[{id:'tomb-white-wine', name:'White Wine', date:'2026-11-01T00:00:00.000Z'}],
    settings:state.settings
  };
  decideSync(false, cloud, state);
  assert(state.drinks.length===1 && state.drinks[0].id==='cloud-ww' && state.drinks[0].price===30, 'a drink already on the cloud is not deleted by a tombstone');
})();

(function memberAndTransactionRules(){
  const state = baseState({
    members:[{id:'m1', name:'Pat'}, {id:'m-local', name:'sam'}, {id:'m-new', name:'Bea'}],
    transactions:[
      {id:'tx1', memberId:'m1', amount:-20, desc:'123456789012345678901234567890', date:'2026-11-01T10:00:00.000Z'},
      {id:'tx-dup', memberId:'m1', amount:-20, desc:'123456789012345678901234567890 EXTRA', date:'2026-11-01T10:00:00.000Z'},
      {id:'tx-new', memberId:'m1', amount:-5, desc:'Soda', date:'2026-11-02T10:00:00.000Z'}
    ]
  });
  const cloud = {
    members:[{id:'m1', name:'Pat'}, {id:'m-cloud', name:'Sam'}],
    transactions:[
      {id:'tx1', memberId:'m1', amount:-20, desc:'123456789012345678901234567890', date:'2026-11-01T10:00:00.000Z'},
      {id:'tx-cloud', memberId:'m1', amount:-8, desc:'Cider', date:'2026-11-03T10:00:00.000Z'}
    ],
    users:[{id:'u1', pin:'2222', name:'Ada'}],
    drinks:[{id:'beer-1', name:'Beer', price:20}],
    deletedDrinks:[],
    settings:{barName:'Cloud'}
  };
  decideSync(false, cloud, state);
  assert(state.transactions.some(t=>t.id==='tx1'), 'cloud transaction kept');
  assert(state.transactions.some(t=>t.id==='tx-cloud'), 'other cloud transaction kept');
  assert(state.transactions.some(t=>t.id==='tx-new'), 'distinct local transaction kept');
  assert(!state.transactions.some(t=>t.id==='tx-dup'), 'content-duplicate local transaction dropped');
  assert(state.members.some(m=>m.id==='m-cloud'), 'cloud member kept when names collide');
  assert(!state.members.some(m=>m.id==='m-local'), 'local member with the same name is not duplicated');
  assert(state.members.some(m=>m.id==='m-new'), 'distinct local member kept');
  assert(state.members.filter(m=>m.name.toLowerCase()==='sam').length===1, 'one row per member name');
})();

(function failedReadDoesNotPostOrMutate(){
  const state = baseState({
    drinks:[{id:'ww-new', name:'White Wine', price:25, createdAt:'2026-11-12T15:00:00.000Z', updatedAt:'2026-11-12T15:00:00.000Z'}],
    transactions:[{id:'tx-only-local', memberId:'m1', amount:-25, desc:'White Wine', date:'2026-11-12T15:00:00.000Z'}]
  });
  const before = JSON.stringify(state);
  const missing = decideSync(false, null, state);
  assert(missing.post===false && missing.retry===true, 'null cloud aborts');
  assert(JSON.stringify(state)===before, 'null cloud does not change local data');
  const htmlBody = decideSync(false, '<!DOCTYPE html><html><body>interim</body></html>', state);
  assert(htmlBody.post===false, 'HTML body aborts');
  assert(JSON.stringify(state)===before, 'HTML body does not change local data');
  const notObj = decideSync(false, [{id:'nope'}], state);
  assert(notObj.post===false && JSON.stringify(state)===before, 'non-object snapshot aborts');
  assert(cloudPayload(state).drinks.some(d=>d.id==='ww-new'), 'local drink is still available for a later retry');
})();

(function emptyCloudDrinkListStillPosts(){
  // A real empty menu is valid JSON. Only a failed / non-JSON read aborts.
  const state = baseState();
  const cloud = {
    members:state.members,
    transactions:state.transactions,
    users:state.users,
    drinks:[],
    deletedDrinks:[],
    settings:state.settings
  };
  const decision = decideSync(false, cloud, state);
  assert(decision.post===true, 'usable empty drink list is not a failed read');
  assert(state.drinks.length===1 && state.drinks[0].id==='beer-1', 'empty cloud drinks do not wipe the local menu');
})();

(function versionAndSyncGate(){
  assert(html.includes('const APP_VERSION = \'4.41\';'), 'APP_VERSION is 4.41');
  assert(html.includes('const APP_BUILD = \'2026-11-12\';'), 'APP_BUILD is 2026-11-12');
  assert(html.includes('<meta name="app-version" content="4.41">'), 'meta app-version is 4.41');
  assert(!html.includes('seenT.has'), 'tombstones are not unioned by id only');
  assert(!html.includes('S.deletedDrinks=(S.deletedDrinks||[]).filter'), 're-add does not delete the tombstone');
  const save = html.slice(html.indexOf('function saveEditDrink'), html.indexOf('function renderStock'));
  assert(save.includes('reviveMatchingTombstones'), 'save revives matching tombstones');
  assert(save.includes('createdAt:savedAt') && save.includes('stampDrinkTimes'), 'save stamps createdAt and updatedAt');
  const sync = html.slice(html.indexOf('async function syncNow'), html.indexOf('// Auto-sync local edits'));
  const firstPost = sync.indexOf('cloudPost');
  const abortAt = sync.indexOf('Aborting without POST');
  const secondPost = sync.indexOf('cloudPost', firstPost+1);
  assert(firstPost>0 && abortAt>firstPost && secondPost>abortAt, 'normal sync returns before POST when the read is unusable');
  assert(sync.includes('decideSync(false, cloud, S)'), 'normal sync uses the read gate');
  assert(sync.includes('_cloudReadFailed=true'), 'failed read is retried later');
})();

if(failed){
  console.error(failed+' failed, '+passed+' passed');
  process.exit(1);
}
console.log(passed+' passed');
