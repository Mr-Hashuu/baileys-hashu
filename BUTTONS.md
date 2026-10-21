# Buttons, lists and interactive messages

This fork adds sendable button messages on top of upstream Baileys. All of them go through the normal
`sock.sendMessage(jid, content)` call.

> WhatsApp decides what it renders. Button support for non-official clients changes on the server side without
> notice, so always test with a spare number first, and expect some message types to show up as plain text or
> "message not supported" on some app versions.

## Quick start

```js
import makeWASocket, { quickReplyButton, urlButton, copyButton, getButtonReply } from 'hashu-baileys'

// native flow buttons (the modern ones)
await sock.sendMessage(jid, {
	text: 'Welcome to the bot',
	footer: 'HASHU',
	interactiveButtons: [
		quickReplyButton('Menu', '.menu'),
		quickReplyButton('Ping', '.ping'),
		urlButton('Website', 'https://example.com'),
		copyButton('Copy code', 'ABC-123')
	]
})
```

## Message types

### 1. `interactiveButtons` (native flow)

| Field | Notes |
| --- | --- |
| `text` or `caption` | body text |
| `title`, `subtitle` | optional header text |
| `footer` | optional footer |
| `image`, `video`, `document` | optional media header (`document` also takes `mimetype`, `fileName`) |
| `interactiveButtons` | array of `{ name, buttonParamsJson }`, use the helpers below |

Helpers (all exported from the package root):

- `quickReplyButton(displayText, id)`
- `urlButton(displayText, url)`
- `copyButton(displayText, code)`
- `callButton(displayText, phoneNumber)`
- `singleSelectButton(title, sections)` for a drop-down list inside native flow

```js
await sock.sendMessage(jid, {
	image: { url: './logo.jpg' },
	caption: 'Pick a tool',
	interactiveButtons: [
		singleSelectButton('Open menu', [
			{
				title: 'Tools',
				rows: [
					{ id: '.sticker', title: 'Sticker', description: 'Image to sticker' },
					{ id: '.song', title: 'Song', description: 'Download audio' }
				]
			}
		])
	]
})
```

### 2. `buttons` (classic quick reply)

```js
await sock.sendMessage(jid, {
	text: 'Choose',
	footer: 'footer',
	buttons: [
		{ buttonId: 'a', buttonText: { displayText: 'Option A' } },
		{ buttonId: 'b', buttonText: { displayText: 'Option B' } }
	]
})
```

Add `image`, `video` or `document` to put media in the header; `headerType` is picked for you.

### 3. `sections` (classic list)

```js
await sock.sendMessage(jid, {
	text: 'Choose a command',
	title: 'Menu',
	buttonText: 'Open list',
	footer: 'footer',
	sections: [{ title: 'Tools', rows: [{ title: 'Ping', rowId: '.ping', description: 'Latency' }] }]
})
```

### 4. `cards` (carousel)

```js
await sock.sendMessage(jid, {
	text: 'Our plans',
	cards: [
		{
			image: { url: './basic.jpg' },
			title: 'Basic',
			body: 'For small groups',
			footer: 'Free',
			buttons: [quickReplyButton('Select', 'plan-basic')]
		},
		{
			image: { url: './pro.jpg' },
			title: 'Pro',
			body: 'For big communities',
			buttons: [urlButton('Buy', 'https://example.com/pro')]
		}
	]
})
```

## Reading what the user tapped

`getButtonReply` understands classic buttons, templates, lists and native flow replies:

```js
sock.ev.on('messages.upsert', async ({ messages }) => {
	const msg = messages[0]
	const reply = getButtonReply(msg)
	if (reply) {
		console.log(reply.kind, reply.id, reply.displayText)
		// e.g. 'native_flow' '.menu' 'Menu'
	}
})
```

The returned `id` is exactly what you passed as `id`, `buttonId` or `rowId`, so using your command text (`.menu`) as the
id lets you feed it straight into your command handler.

## What changed in the code

- `src/Utils/messages.ts`: builds `buttonsMessage`, `listMessage`, `interactiveMessage` (native flow and carousel)
  and wraps them in the view once envelope with `deviceListMetadata`.
- `src/Socket/messages-send.ts`: `relayMessage` adds the `<biz>` hint node (and the `<bot biz_bot="1">` node in
  private chats) when the message contains buttons, a list or an interactive message.
- `src/Utils/buttons.ts`: button builders and `getButtonReply`.
- `src/Types/Message.ts`: new content types.
- `src/__tests__/Utils/buttons.test.ts`: unit tests for the builders and the generated protobuf content.
