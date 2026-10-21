import { Boom } from '@hapi/boom'
import type { proto } from '../../WAProto/index.js'
import type {
	AnyMessageContent,
	MiscMessageGenerationOptions,
	SocketConfig,
	WAMediaUpload,
	WAMessage,
	WAMessageKey
} from '../Types'
import { WAMessageStubType } from '../Types'
import type { ButtonReply } from '../Utils'
import {
	downloadMediaMessage,
	getButtonReply,
	getKeyAuthor,
	normalizeMessageContent,
	sha256
} from '../Utils'
import { jidNormalizedUser } from '../WABinary'
import type { makeCommunitiesSocket } from './communities'

type BaseSocket = ReturnType<typeof makeCommunitiesSocket>

// ---------------------------------------------------------------------------------------------------------------------
// small message cache, used for anti-delete, polls and as a getMessage source
// ---------------------------------------------------------------------------------------------------------------------

const cacheKey = (key: WAMessageKey) => `${key.remoteJid}|${key.id}`

export const makeMessageCache = (limit = 1000) => {
	const map = new Map<string, WAMessage>()
	return {
		set(msg: WAMessage) {
			if (!msg?.key?.id) return
			const id = cacheKey(msg.key)
			map.delete(id)
			map.set(id, msg)
			if (map.size > limit) {
				const oldest = map.keys().next().value
				if (oldest !== undefined) map.delete(oldest)
			}
		},
		get(key: WAMessageKey) {
			return map.get(cacheKey(key))
		},
		/** newest first */
		values() {
			return [...map.values()].reverse()
		},
		get size() {
			return map.size
		}
	}
}

export type MessageCache = ReturnType<typeof makeMessageCache>

const pick = <T>(list: T[]): T => list[Math.floor(Math.random() * list.length)]!
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))
const waitFor = (delay: number | [number, number] | undefined) => {
	if (!delay) return Promise.resolve()
	const ms = Array.isArray(delay) ? delay[0] + Math.random() * (delay[1] - delay[0]) : delay
	return sleep(ms)
}

// ---------------------------------------------------------------------------------------------------------------------
// types
// ---------------------------------------------------------------------------------------------------------------------

export type ButtonMatcher = string | RegExp | ((reply: ButtonReply) => boolean)
export type ButtonReplyHandler = (reply: ButtonReply, msg: WAMessage) => unknown

export type AntiDeleteInfo = {
	chat: string
	sender: string
	/** the message as it was before it got deleted */
	message: WAMessage
}

export type AntiDeleteOptions = {
	/** where to send the recovered message. Default: the chat where it was deleted */
	sendTo?: string
	/** skip messages deleted by yourself (default true) */
	ignoreMe?: boolean
	/** set to false if you only want the callback and no automatic resend */
	autoSend?: boolean
	onDelete?: (info: AntiDeleteInfo) => unknown
}

export type AntiViewOnceOptions = {
	/** where to send the revealed media. Default: your own chat */
	sendTo?: string
	ignoreMe?: boolean
}

export type RevealedMedia = {
	type: 'image' | 'video' | 'audio'
	buffer: Buffer
	caption?: string
	mimetype?: string
	ptt?: boolean
}

export type PollResult = {
	name: string
	options: { name: string; votes: number; voters: string[] }[]
	totalVoters: number
}

export type PollVoteInfo = {
	pollKey: WAMessageKey
	voter: string
	/** option names this voter has selected now */
	selected: string[]
	results: PollResult
}

export type AutoStatusOptions = {
	/** mark statuses as seen (default true) */
	view?: boolean
	/** true = random emoji from the default list, a string = that emoji, an array = random one of them */
	react?: boolean | string | string[]
	/** ms, or [min, max] for a random wait before each action. Default [1500, 4000] */
	delay?: number | [number, number]
	/** only handle these senders */
	onlyJids?: string[]
	/** never handle these senders */
	ignoreJids?: string[]
}

export type AutoReactChannelsOptions = {
	emojis?: string[]
	/** ms, or [min, max]. Default [800, 2500] */
	delay?: number | [number, number]
	/** also follow the channels (default false) */
	follow?: boolean
}

export const DEFAULT_REACTIONS = ['❤️', '🔥', '👏', '😍', '🙌']

// ---------------------------------------------------------------------------------------------------------------------

type ToolsInput = {
	sock: BaseSocket
	config: SocketConfig
	cache: MessageCache
	sendMessage: (jid: string, content: AnyMessageContent, options?: MiscMessageGenerationOptions) => Promise<WAMessage | undefined>
	resolveChannel: (input: string) => Promise<{ jid: string; name?: string }>
}

export const makeHashuTools = ({ sock, config, cache, sendMessage, resolveChannel }: ToolsInput) => {
	const { ev } = sock
	const logger = config.logger
	const ownJid = () => (sock.user?.id ? jidNormalizedUser(sock.user.id) : undefined)
	const swallow = (what: string) => (err: unknown) => logger.error({ err }, `${what} failed`)

	// -------------------------------------------------------------------------------------------------------------
	// button / list reply handlers
	// -------------------------------------------------------------------------------------------------------------
	type Registered = {
		match: ButtonMatcher
		handler: ButtonReplyHandler
		accepts: (reply: ButtonReply) => boolean
	}
	const registered = new Set<Registered>()
	let buttonListener = false

	const isSelect = (reply: ButtonReply) => reply.kind === 'list' || reply.name === 'single_select'

	const matches = (match: ButtonMatcher, reply: ButtonReply) => {
		if (typeof match === 'string') return match === '*' || match === reply.id
		if (match instanceof RegExp) return match.test(reply.id)
		return match(reply)
	}

	const register = (match: ButtonMatcher, handler: ButtonReplyHandler, accepts: Registered['accepts']) => {
		const entry = { match, handler, accepts }
		registered.add(entry)
		if (!buttonListener) {
			buttonListener = true
			ev.on('messages.upsert', ({ messages, type }) => {
				if (type !== 'notify') return
				for (const msg of messages) {
					if (msg.key.fromMe) continue
					const reply = getButtonReply(msg)
					if (!reply) continue
					for (const item of [...registered]) {
						if (item.accepts(reply) && matches(item.match, reply)) {
							Promise.resolve(item.handler(reply, msg)).catch(swallow('button handler'))
						}
					}
				}
			})
		}

		return () => {
			registered.delete(entry)
		}
	}

	/** runs `handler` when someone taps a button. `match` = button id, RegExp, function or '*' for all */
	const onButton = (match: ButtonMatcher, handler: ButtonReplyHandler) =>
		register(match, handler, reply => !isSelect(reply))

	/** runs `handler` when someone picks a row of a list / single_select menu */
	const onSelect = (match: ButtonMatcher, handler: ButtonReplyHandler) => register(match, handler, isSelect)

	// -------------------------------------------------------------------------------------------------------------
	// anti delete + view once
	// -------------------------------------------------------------------------------------------------------------
	const mentionTag = (jid: string) => `@${jid.split('@')[0]}`

	const enableAntiDelete = (opts: AntiDeleteOptions = {}) => {
		const handler = (updates: { key: WAMessageKey; update: Partial<WAMessage> }[]) => {
			for (const { key, update } of updates) {
				if (update.messageStubType !== WAMessageStubType.REVOKE) continue
				if (!key.remoteJid || key.remoteJid === 'status@broadcast') continue
				if (key.fromMe && opts.ignoreMe !== false) continue

				const original = cache.get(key)
				if (!original) continue

				const sender = getKeyAuthor(key, sock.user?.id)
				const info: AntiDeleteInfo = { chat: key.remoteJid, sender, message: original }
				Promise.resolve(opts.onDelete?.(info)).catch(swallow('anti delete callback'))
				if (opts.autoSend === false) continue

				const target = opts.sendTo ?? key.remoteJid
				;(async () => {
					await sendMessage(target, {
						text: `Deleted message from ${mentionTag(sender)}`,
						mentions: [sender]
					})
					await sendMessage(target, { forward: original } as unknown as AnyMessageContent)
				})().catch(swallow('anti delete resend'))
			}
		}

		ev.on('messages.update', handler)
		return () => ev.off('messages.update', handler)
	}

	const isViewOnceMessage = (msg: WAMessage) => {
		const raw = msg.message
		if (!raw) return false
		if (raw.viewOnceMessage || raw.viewOnceMessageV2 || raw.viewOnceMessageV2Extension) return true
		const content = normalizeMessageContent(raw)
		return !!(content?.imageMessage?.viewOnce || content?.videoMessage?.viewOnce || content?.audioMessage?.viewOnce)
	}

	/** downloads the media of a view once message */
	const revealViewOnce = async (msg: WAMessage): Promise<RevealedMedia> => {
		const content = normalizeMessageContent(msg.message)
		const media = content?.imageMessage || content?.videoMessage || content?.audioMessage
		const type = content?.imageMessage ? 'image' : content?.videoMessage ? 'video' : content?.audioMessage ? 'audio' : undefined
		if (!content || !media || !type) throw new Boom('this is not a view once photo / video / audio', { statusCode: 400 })

		const buffer = (await downloadMediaMessage(
			{ key: msg.key, message: content } as WAMessage,
			'buffer',
			{},
			{ logger, reuploadRequest: sock.updateMediaMessage }
		)) as Buffer

		return {
			type,
			buffer,
			caption: (media as proto.Message.IImageMessage).caption || undefined,
			mimetype: media.mimetype || undefined,
			ptt: content.audioMessage?.ptt || undefined
		}
	}

	const sendRevealed = (jid: string, media: RevealedMedia, caption?: string) => {
		const text = caption ?? media.caption
		const content: Record<string, unknown> =
			media.type === 'audio'
				? { audio: media.buffer, mimetype: media.mimetype, ptt: media.ptt }
				: { [media.type]: media.buffer, caption: text, mimetype: media.mimetype }
		return sendMessage(jid, content as AnyMessageContent)
	}

	/** reveals one view once message and sends it to `jid` as a normal message */
	const sendViewOnceReveal = async (jid: string, msg: WAMessage, caption?: string) =>
		sendRevealed(jid, await revealViewOnce(msg), caption)

	/** automatically reveals every incoming view once message */
	const enableAntiViewOnce = (opts: AntiViewOnceOptions = {}) => {
		const handler = ({ messages, type }: { messages: WAMessage[]; type: string }) => {
			if (type !== 'notify') return
			for (const msg of messages) {
				if (msg.key.fromMe && opts.ignoreMe !== false) continue
				if (!isViewOnceMessage(msg)) continue
				const target = opts.sendTo ?? ownJid()
				if (!target) continue
				;(async () => {
					const media = await revealViewOnce(msg)
					const sender = getKeyAuthor(msg.key, sock.user?.id)
					const note = `View once from ${mentionTag(sender)}${media.caption ? `\n${media.caption}` : ''}`
					await sendRevealed(target, media, note)
				})().catch(swallow('anti view once'))
			}
		}

		ev.on('messages.upsert', handler)
		return () => ev.off('messages.upsert', handler)
	}

	// -------------------------------------------------------------------------------------------------------------
	// polls
	// -------------------------------------------------------------------------------------------------------------
	type PollState = { message: proto.IMessage; votes: Map<string, string[]> }
	const polls = new Map<string, PollState>()
	const pollHandlers = new Set<(info: PollVoteInfo) => unknown>()

	const pollOf = (m?: proto.IMessage | null) =>
		m?.pollCreationMessage || m?.pollCreationMessageV2 || m?.pollCreationMessageV3 || undefined

	const hex = (data: Uint8Array | Buffer | string) => Buffer.from(data as Uint8Array).toString('hex')

	const loadPoll = async (key: WAMessageKey): Promise<PollState | undefined> => {
		const id = cacheKey(key)
		const known = polls.get(id)
		if (known) return known

		const message = cache.get(key)?.message || (await config.getMessage(key))
		if (!pollOf(message)) return undefined
		const state = { message: message!, votes: new Map<string, string[]>() }
		polls.set(id, state)
		return state
	}

	const buildResults = (state: PollState): PollResult => {
		const poll = pollOf(state.message)!
		const options = (poll.options || []).map(option => {
			const name = option.optionName || ''
			const hash = hex(sha256(Buffer.from(name)))
			const voters = [...state.votes.entries()].filter(([, picked]) => picked.includes(hash)).map(([voter]) => voter)
			return { name, votes: voters.length, voters }
		})
		const totalVoters = [...state.votes.values()].filter(picked => picked.length).length
		return { name: poll.name || '', options, totalVoters }
	}

	ev.on('messages.update', updates => {
		for (const { key, update } of updates) {
			if (!update.pollUpdates?.length) continue
			;(async () => {
				const state = await loadPoll(key)
				if (!state) return
				for (const pollUpdate of update.pollUpdates!) {
					if (!pollUpdate.vote) continue
					const voter = getKeyAuthor(pollUpdate.pollUpdateMessageKey, sock.user?.id)
					// WhatsApp sends the full selection every time, so the newest vote replaces the old one
					state.votes.set(voter, (pollUpdate.vote.selectedOptions || []).map(hex))
					const results = buildResults(state)
					const hashToName = new Map(
						(pollOf(state.message)?.options || []).map(o => [hex(sha256(Buffer.from(o.optionName || ''))), o.optionName || ''])
					)
					const selected = (state.votes.get(voter) || []).map(h => hashToName.get(h) || 'Unknown')
					for (const handler of pollHandlers) {
						Promise.resolve(handler({ pollKey: key, voter, selected, results })).catch(swallow('poll vote handler'))
					}
				}
			})().catch(swallow('poll tracking'))
		}
	})

	/** called on every new or changed vote of any poll the bot knows about (polls sent / received while it runs) */
	const onPollVote = (handler: (info: PollVoteInfo) => unknown) => {
		pollHandlers.add(handler)
		return () => {
			pollHandlers.delete(handler)
		}
	}

	/** current result of a poll. Pass the key (or the full message) returned by sendMessage */
	const getPollResults = async (poll: WAMessageKey | WAMessage): Promise<PollResult | undefined> => {
		const key = 'key' in poll ? poll.key : poll
		const state = await loadPoll(key)
		return state ? buildResults(state) : undefined
	}

	// -------------------------------------------------------------------------------------------------------------
	// auto status view / react
	// -------------------------------------------------------------------------------------------------------------
	const autoStatus = (opts: AutoStatusOptions = {}) => {
		const view = opts.view !== false
		const reactions =
			opts.react === true
				? DEFAULT_REACTIONS
				: typeof opts.react === 'string'
					? [opts.react]
					: Array.isArray(opts.react) && opts.react.length
						? opts.react
						: undefined
		const delay = opts.delay ?? [1500, 4000]
		let queue: Promise<unknown> = Promise.resolve()

		const handler = ({ messages }: { messages: WAMessage[] }) => {
			for (const msg of messages) {
				const { key } = msg
				if (key.remoteJid !== 'status@broadcast' || key.fromMe || !key.participant) continue
				if (msg.message?.protocolMessage) continue
				const sender = jidNormalizedUser(key.participant)
				if (opts.onlyJids?.length && !opts.onlyJids.map(jidNormalizedUser).includes(sender)) continue
				if (opts.ignoreJids?.map(jidNormalizedUser).includes(sender)) continue

				queue = queue
					.then(async () => {
						await waitFor(delay)
						if (view) await sock.readMessages([key])
						if (reactions) {
							await waitFor(delay)
							const viewers = [sender, ownJid()].filter(Boolean) as string[]
							await sendMessage('status@broadcast', { react: { text: pick(reactions), key } }, { statusJidList: viewers })
						}
					})
					.catch(swallow('auto status'))
			}
		}

		ev.on('messages.upsert', handler)
		return () => ev.off('messages.upsert', handler)
	}

	// -------------------------------------------------------------------------------------------------------------
	// channel auto react
	// -------------------------------------------------------------------------------------------------------------
	const autoReactChannels = (channels: string[] | '*', opts: AutoReactChannelsOptions = {}) => {
		const emojis = opts.emojis?.length ? opts.emojis : DEFAULT_REACTIONS
		const delay = opts.delay ?? [800, 2500]
		const jids = new Set<string>()
		const timers = new Set<ReturnType<typeof setTimeout>>()
		const done = new Set<string>()
		let stopped = false

		const subscribe = async (jid: string) => {
			if (stopped) return
			const result = await sock.subscribeNewsletterUpdates(jid)
			// live updates expire, ask again a bit before that
			const seconds = Math.max(60, Number(result?.duration || 300) * 0.8)
			const timer = setTimeout(() => {
				timers.delete(timer)
				subscribe(jid).catch(swallow('channel resubscribe'))
			}, seconds * 1000)
			;(timer as unknown as { unref?: () => void }).unref?.()
			timers.add(timer)
		}

		const setup = async () => {
			if (channels === '*') return
			for (const channel of channels) {
				try {
					const { jid } = await resolveChannel(channel)
					jids.add(jid)
					if (opts.follow) await sock.newsletterFollow(jid).catch(() => undefined)
					await subscribe(jid)
				} catch (err) {
					logger.error({ err, channel }, 'channel auto react setup failed')
				}
			}
		}

		const onMessages = ({ messages }: { messages: WAMessage[] }) => {
			for (const msg of messages) {
				const { remoteJid, server_id: serverId, fromMe } = msg.key
				if (!remoteJid?.endsWith('@newsletter') || !serverId || fromMe) continue
				if (channels !== '*' && !jids.has(remoteJid)) continue
				const id = `${remoteJid}|${serverId}`
				if (done.has(id)) continue
				done.add(id)
				if (done.size > 2000) done.delete(done.values().next().value!)

				waitFor(delay)
					.then(() => sock.newsletterReactMessage(remoteJid, serverId, pick(emojis)))
					.catch(swallow('channel auto react'))
			}
		}

		const onConnection = (update: { connection?: string }) => {
			if (update.connection === 'open') setup().catch(swallow('channel auto react setup'))
		}

		ev.on('messages.upsert', onMessages)
		ev.on('connection.update', onConnection)
		if (sock.user) setup().catch(swallow('channel auto react setup'))

		return () => {
			stopped = true
			ev.off('messages.upsert', onMessages)
			ev.off('connection.update', onConnection)
			timers.forEach(clearTimeout)
			timers.clear()
		}
	}

	// -------------------------------------------------------------------------------------------------------------
	// channel management
	// -------------------------------------------------------------------------------------------------------------
	const channelUrl = (invite?: string) => (invite ? `https://whatsapp.com/channel/${invite}` : undefined)

	/** creates a channel, optionally with a picture, and returns its jid + share url */
	const createChannel = async (opts: { name: string; description?: string; picture?: WAMediaUpload }) => {
		const meta = await sock.newsletterCreate(opts.name, opts.description)
		if (opts.picture) {
			await sock.newsletterUpdatePicture(meta.id, opts.picture).catch(swallow('channel picture'))
		}

		return { ...meta, url: channelUrl(meta.invite) }
	}

	/** changes name / description / picture of a channel you own. Pass `picture: null` to remove the picture */
	const updateChannel = async (
		channel: string,
		changes: { name?: string; description?: string; picture?: WAMediaUpload | null }
	) => {
		const { jid } = await resolveChannel(channel)
		if (changes.name !== undefined) await sock.newsletterUpdateName(jid, changes.name)
		if (changes.description !== undefined) await sock.newsletterUpdateDescription(jid, changes.description)
		if (changes.picture === null) await sock.newsletterRemovePicture(jid)
		else if (changes.picture) await sock.newsletterUpdatePicture(jid, changes.picture)
		return jid
	}

	const channelInfo = async (channel: string) => {
		const { jid } = await resolveChannel(channel)
		const meta = await sock.newsletterMetadata('jid', jid)
		return meta ? { ...meta, url: channelUrl(meta.invite) } : null
	}

	const deleteChannel = async (channel: string) => sock.newsletterDelete((await resolveChannel(channel)).jid)

	return {
		onButton,
		onSelect,
		enableAntiDelete,
		enableAntiViewOnce,
		isViewOnceMessage,
		revealViewOnce,
		sendViewOnceReveal,
		onPollVote,
		getPollResults,
		autoStatus,
		autoReactChannels,
		createChannel,
		updateChannel,
		channelInfo,
		deleteChannel
	}
}
