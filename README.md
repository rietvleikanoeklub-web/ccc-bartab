# ccc-bartab

Bar tab for the club. The screen is `index.html`, published on GitHub Pages. The data lives in a Google Apps Script web app. The page reads and writes one JSON document through that app's `/exec` URL.

## Telegram commands

Text commands run through the same Apps Script project. The screen does not change. A booking is not written until someone taps Confirm.

Paste these three files into the **existing** Apps Script project (the club Google account). Do not create a second project and do not add another `doGet` or `doPost`.

- `apps-script/telegram-parser.gs`
- `apps-script/telegram-apply.gs`
- `apps-script/telegram.gs`

The editor needs the V8 runtime, which is the Apps Script default.

### What a message looks like

One command per line. Names and drinks are matched loosely (name, initials, nickname, drink name, alias). `wine` matches a drink named with `wyn` when that is the only wine. Quantity defaults to 1. `2x beer` is a quantity.

```
Sam K 1 wine
Alex 2 beer
TC 1 water
Alex paid 200 EFT
Alex paid 50 cash
Alex paid 80 card
balance Sam K
balances
```

`EFT` is stored as a bank top-up, `cash` as cash, and `card` as the same card method the screen uses. `balances` lists members who owe the bar. Unknown lines are reported and skipped. If a name or drink matches more than one record, the bot asks with buttons. Tombstoned drinks are not sold.

A confirmed sale is a normal purchase, and a confirmed payment is a normal top-up, using the same descriptions as the screen. The row's source is `telegram`, and the person who tapped Confirm is who entered it.

### Hook the existing web app

At the top of the existing `doPost`, before it reads the body as a save:

```javascript
var telegramResponse = telegramTryHandle(e);
if (telegramResponse) return telegramResponse;
```

Posts from the bar tab screen, including `sendEmail`, do not look like Telegram updates and continue as they do now.

Then make the bot use the **same** JSON the app already stores. In the script, find the read and the write (a Drive file id, or the `CCCBarTab` sheet cell A1). Add these wrappers if those names are not already used:

```javascript
function cccReadDocument() {
  // Return the object the web app GET returns as data.
  // Drive example:
  //   return JSON.parse(DriveApp.getFileById(FILE_ID).getBlob().getDataAsString());
  // Sheet example:
  //   return JSON.parse(getJsonSheet().getRange('A1').getValue() || '{}');
}

function cccWriteDocument(doc) {
  // Write the full object back the same way a normal save does,
  // including any view-sheet refresh that save already does.
}
```

Use the file id or sheet call that is **already** in the project. Do not create a new file.

Where the existing `doPost` overwrites that JSON with the phone snapshot, replace the overwrite with:

```javascript
var saved = telegramLockedSave(payload);
try { if (typeof updateViewSheets === 'function') updateViewSheets(saved); } catch (viewErr) {}
```

`telegramLockedSave` takes the script lock, re-reads the document, and writes the phone snapshot back. If a Telegram booking from the last 5 minutes is missing from that snapshot, it is copied back in so a phone that read just before the booking cannot drop it. The save is refused unless `members`, `drinks`, and `transactions` are all arrays, which is what the app sends. A force push still sends the full document. A force push in those 5 minutes keeps the recent bot booking; after that it can remove the row like any other transaction.

Leave `TRACK_INVENTORY` unset. The app flag is off, so a bot sale does not change stock counts. Set the property to `true` only if that app flag is turned on. Stock then drops the same way as the screen and never below zero.

### Create the bot

1. In Telegram, open `@BotFather` and send `/newbot`.
2. Choose a display name and a username ending in `bot`.
3. Copy the token BotFather shows. Put it only in Script Properties (below). Do not paste it into the repo, the sheet, or a chat.
4. Create a **new** bot. Do not reuse the token already stored in the bar tab for group alerts. `setWebhook` would move that bot onto this webhook.
5. Talk to the new bot in a **private** chat. A group only sees commands unless privacy mode is turned off.

### Script Properties

In the Apps Script editor: Project Settings → Script properties. Add:

| Property | Value |
| --- | --- |
| `TELEGRAM_BOT_TOKEN` | token from BotFather |
| `TELEGRAM_ALLOWED_IDS` | numeric ids, comma-separated. Leave empty until the register step. |
| `TELEGRAM_WEBHOOK_SECRET` | any long random string you choose. Optional, but recommended. |
| `BARTAB_STORE` | `drive` or `sheet`, if you did not add `cccReadDocument` |
| `BARTAB_FILE_ID` | the Drive file id already used by the script, when the store is Drive |
| `TRACK_INVENTORY` | omit it. The screen does not decrement stock. |

Property changes apply immediately. Code changes need the redeploy below.

An id that is not on the list can send `/start` or `/register` and receives only its numeric id. No members, balances, or drinks are sent. `/start` from someone on the list shows the command help.

### Redeploy without changing the URL

1. Deploy → Manage deployments.
2. Edit the deployment that is already live (the URL saved in the bar tab settings, ending in `/exec`).
3. Version → New version. Leave "Execute as" and "Who has access" as they are (the app and Telegram both call this URL).
4. Deploy.

Do not create a second deployment. A new deployment would be a different `/exec` URL and the phones would keep writing to the old one.

### Set the webhook

Replace the placeholders. The exec URL is the one already in the bar tab settings. If you set `TELEGRAM_WEBHOOK_SECRET`, the URL must include `?tg=` and that same secret. If a property is empty, use the exec URL with no query string.

```bash
curl -s "https://api.telegram.org/bot<TELEGRAM_BOT_TOKEN>/setWebhook" \
  --data-urlencode "url=<APPS_SCRIPT_EXEC_URL>?tg=<TELEGRAM_WEBHOOK_SECRET>" \
  --data-urlencode 'allowed_updates=["message","callback_query"]'
```

Check it:

```bash
curl -s "https://api.telegram.org/bot<TELEGRAM_BOT_TOKEN>/getWebhookInfo"
```

The result should show that URL and no last error. If the bot never answers and a secret is set, Apps Script may not be receiving the query string: remove `TELEGRAM_WEBHOOK_SECRET`, redeploy is not required, and call `setWebhook` again with the bare `/exec` URL. The allowlist still blocks everyone else.

### Register the three admins

1. Each admin opens a private chat with the new bot and sends `/start`.
2. The reply is their numeric id and nothing else.
3. Paste those ids into `TELEGRAM_ALLOWED_IDS`, separated by commas.
4. No redeploy. Send `/help` from one of those accounts.
5. Send one real sale for a member who is on the tab, using a drink that is on the menu. Check the summary, then tap **Cancel** and confirm the tab did not change.
6. Send it again and tap **Confirm**. The reply shows the new balance. Open that member on the phone and confirm the same sale, entered from Telegram.

`balances` lists who owes the bar. It does not need Confirm.

### Tests

```bash
node test/telegram-parser.test.js
node test/sync-tombstone.test.js
```

The parser tests use fictional names only. They do not call Apps Script or the live URL.
