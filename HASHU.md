# hashu-baileys extras

```js
import makeWASocket from 'hashu-baileys'
// or in package.json: "@whiskeysockets/baileys": "npm:hashu-baileys"
```

## Pill buttons (separate buttons under the message)

`buttons` is now sent as native flow, so every button is shown as its own pill under the bubble.
All shapes can be mixed:

```js
await sock.sendMessage(jid, {
  text: 'Menu',
  footer: 'HASHU',
  buttons: [
    { id: '.menu', text: 'BACK TO MENU' },                 // reply
    { text: 'Get Script', url: 'https://example.com' },    // link
    { text: 'Copy code', copy: 'HASHU123' },               // copy
    { text: 'Call owner', phone: '+94700000000' },         // call
    { buttonId: 'old', buttonText: { displayText: 'Old style input also works' } }
  ]
})
```

Add `classic: true` to get the old attached `buttonsMessage`. `interactiveButtons` still works for full control.

Extra builders: `reminderButton`, `cancelReminderButton`, `catalogButton`, `webviewButton`, `locationButton`, and `nativeButton(name, params)` for any other native flow name.

## Location header + limited time offer card (the screenshot style)

This exact shape works as it is. `headerType` and `viewOnce` are accepted but not needed.

```js
await sock.sendMessage(jid, {
  location: { degreesLatitude: 0, degreesLongitude: 0, name: 'HASHU', address: '#! -Hashu', jpegThumbnail: buf },
  limited_time_offer: { text: 'Hashu - Menu', url: 'https://t.me/x', copy_code: '#Hashu', expiration_time: Math.floor(Date.now() / 1000) + 86400 },
  caption: 'Hello',
  footer: '\n┏ 『 *OWNER MENU* 』 ┓\n│ .addprem\n│ .delprem',
  buttons: [
    { buttonId: '.sc', buttonText: { displayText: 'Get Script' }, type: 1 },
    { buttonId: '.menu', buttonText: { displayText: 'BACK TO MENU' }, type: 1 }
  ],
  headerType: 6,
  viewOnce: true,
  contextInfo: { mentionedJid: [m.sender] }
}, { quoted: m })
```

Rules: `location` becomes the header, `caption` the body, `footer` the small text under it, `buttons` the pills. Add `classic: true` for the old buttonsMessage with a location header.

## Channel label and link card

```js
await sock.sendMessage(jid, { text: 'hi', forwardFromChannel: true })               // default channel
await sock.sendMessage(jid, { text: 'hi', forwardFromChannel: 'https://whatsapp.com/channel/XXXX' })
await sock.sendMessage(jid, { text: 'hi', adReply: { title: 'HASHU', body: 'bot', thumbnail: buf, sourceUrl: 'https://...' } })
```

## Status

```js
await sock.sendTextStatus('Hello', { backgroundColor: '#075E54', font: 2, statusJidList: [jid1, jid2], mentions: [jid1] })
await sock.sendStatus({ image: { url }, caption: 'hi' }, { statusJidList, mentions })
await sock.sendGroupStatus(groupJid, { image: { url }, caption: 'hi' })   // also { text }, { video }, { audio }
```

## Channels (url or jid accepted everywhere)

```js
await sock.followChannel(url) / sock.unfollowChannel(url)
await sock.sendChannelPost(url, { text: 'post' })      // you must be admin
await sock.fetchChannelPosts(url, 20)                  // [{ serverId, type, message }]
await sock.reactChannelPost(url, serverId, '❤️')
```

## Channel poll vote

```js
// link of the poll post: https://whatsapp.com/channel/<code>/<postId>
await sock.voteChannelPoll('https://whatsapp.com/channel/0029VazhnLzK0IBdwXG4152o/683', 1)        // option number (1 = first)
await sock.voteChannelPoll('https://whatsapp.com/channel/0029VazhnLzK0IBdwXG4152o/683', 'Yes')    // option text
await sock.voteChannelPoll(channelUrlOrJid, ['A', 'C'], { serverId: '683' })                      // multi select poll
await sock.voteChannelPoll(channelUrlOrJid, 2)                                                    // no post id: newest poll of the channel
await sock.voteChannelPoll(receivedChannelMessage, 1)                                             // a message you received from a channel
await sock.removeChannelPollVote(url)                                                             // take the vote back
```

Returns `{ jid, serverId, poll, selected, removed }`. Every vote replaces your old vote. Wrong option, deleted post or a post that is not a poll throws an error that lists the available options.

## Voice note, gif, video note (needs `ffmpeg` installed)

```js
await sock.sendPTT(jid, { url })
await sock.sendGif(jid, { url }, 'caption')
await sock.sendVideoNote(jid, { url })
```

## Button / list reply handlers

```js
const off = sock.onButton('.menu', async (reply, msg) => { /* tapped BACK TO MENU */ })
sock.onButton(/^dl_/, (reply, msg) => {})        // RegExp
sock.onButton('*', (reply, msg) => {})           // every button
sock.onSelect('row_1', (reply, msg) => {})       // list row / single_select row
off()                                            // stop listening
```

## Anti delete and view once

```js
sock.enableAntiDelete({ sendTo: ownerJid })      // resends deleted messages (default: same chat)
sock.enableAntiDelete({ autoSend: false, onDelete: ({ chat, sender, message }) => {} })
sock.enableAntiViewOnce({ sendTo: ownerJid })    // reveals every incoming view once (default: your own chat)
await sock.sendViewOnceReveal(jid, quotedMsg)    // reveal one message on demand
```

Anti delete only knows messages the bot saw since it started (last 1000 are kept in memory).

## Poll results

```js
const poll = await sock.sendMessage(jid, { poll: { name: 'Best?', values: ['A', 'B'], selectableCount: 1 } })
sock.onPollVote(({ voter, selected, results }) => console.log(voter, selected, results.options))
await sock.getPollResults(poll)   // { name, options: [{ name, votes, voters }], totalVoters }
```

Results are kept in memory, a restart forgets them.

## Auto status and channel react

```js
const stop = sock.autoStatus({ view: true, react: true })            // or react: '🔥' / ['🔥','❤️']
sock.autoStatus({ view: true, ignoreJids: [x], delay: [2000, 6000] })

sock.autoReactChannels([url1, url2], { emojis: ['🔥'], follow: true })
sock.autoReactChannels('*')                                           // every channel the account follows
```

## Channel management

```js
const ch = await sock.createChannel({ name: 'HASHU', description: 'news', picture: { url } })  // ch.url
await sock.updateChannel(url, { name: 'New', description: 'text', picture: null })             // null removes the picture
await sock.channelInfo(url)
await sock.deleteChannel(url)
```

## Link preview

High quality link previews are now on by default (`generateHighQualityLinkPreview: true`). If a site has no picture or the upload fails, the link is still sent with the small thumbnail instead of failing.

## Report and block scammers, report scam groups

Same thing as "Report" in WhatsApp. It is built so it cannot be used to mass report people:
there is no bulk call, one number / group per call, and every call goes through these rules.

- A human confirms. `scamWatch` only flags messages and alerts you, nothing is reported until you say yes.
- Only real evidence: you can only report a number / group the bot actually received messages from (max 5 are sent).
- Private chats only for numbers (no groups / channels as "users"). Groups are reported with `reportGroup`.
- Never your own number, `ownerJid`, anything in `protect`, anything `isTrusted()` says yes to, or a number you wrote to yourself.
- 5 reports per day and the same target only once per 30 days (change with `maxReportsPerDay`, `cooldownDays`). The daily limit can never go above 20.
- Owner only: with `ownerJid` set, every case action (`scamCases`, `confirmScamCase`, `confirmAllScamCases`, `dismissScamCase`) needs `by` and refuses anyone else.
- Private: alerts go only to `ownerJid`, the evidence stays in memory and is never written to disk, the saved log has only jid + time.

```js
sock.scamWatch({
  ownerJid: '94712345678@s.whatsapp.net',        // alerts go here
  protect: [friend1, friend2],                   // never reported
  isTrusted: jid => myContacts.has(jid)          // optional: your own contact list
})

// in your command handler, pass the received message as `by` (m = the message with the command):
if (cmd === '.scam' && arg1 === 'yes') await sock.confirmScamCase(arg2, m)     // report + block (group: report + leave)
if (cmd === '.scam' && arg1 === 'all') await sock.confirmAllScamCases({ by: m }) // every open case, slowly, within the daily limit
if (cmd === '.scam' && arg1 === 'no')  sock.dismissScamCase(arg2, { trust: true, by: m })
sock.scamCases(m)                                                               // open cases

// or by hand, with the messages you received from them
await sock.blockAndReport(scammerMsg.key.remoteJid, { evidence: [scammerMsg] })
await sock.reportGroup(groupJid, { evidence: [scammerMsg], leave: true })
```

Keep the daily limit over restarts: save `sock.exportScamReportLog()` and load it again with `sock.importScamReportLog(list)`.
The detection rules are plain regexes in `src/Utils/scam-signals.ts`, edit them for your area. They can be wrong, that is why a person confirms.
The report stanza follows what other open source WhatsApp clients send. It is not tested against WhatsApp here, and the group version is the least certain part. Test it once with a spare number you own.

## Safety: no auto follow

This fork never follows, mutes or joins anything by itself. `forwardFromChannel: true` only looks up the channel name to show the label.
A malware campaign (PhantomSub, OX Security 2026-09-28) hides auto-follow code in Baileys forks, `levvleys` is one of them.
Check any project (also its `node_modules`) with:

```
node scripts/audit-baileys-fork.cjs /path/to/your/bot
```
