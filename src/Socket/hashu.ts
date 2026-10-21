import { randomBytes } from 'crypto'
import { Boom } from '@hapi/boom'
import { proto } from '../../WAProto/index.js'
import type {
	AnyMessageContent,
	AnyRegularMessageContent,
	MiscMessageGenerationOptions,
	SocketConfig,
	WAMediaUpload,
	WAMessage
} from '../Types'
import {
	type AdReplyOptions,
	adReplyContext,
	channelForwardContext,
	convertToGif,
	convertToPTT,
	convertToVideoNote,
	generateMessageIDV2,
	generateWAMessageContent,
	HASHU_CHANNEL_URL,
	parseChannelCode,
	parseChannelPostId,
	sha256
} from '../Utils'
import {
	type BinaryNode,
	getBinaryNodeChild,
	getBinaryNodeChildren,
	isJidGroup,
	jidNormalizedUser,
	S_WHATSAPP_NET
} from '../WABinary'
import { makeCommunitiesSocket } from './communities'
import { makeHashuSafety } from './hashu-safety'
import { makeHashuTools, makeMessageCache } from './hashu-tools'

/** extra keys understood by `sock.sendMessage` in this fork */
export type HashuMessageExtras = {
	/** show the "Forwarded from <channel>" label. `true` uses the default channel, or pass a channel url / jid */
	forwardFromChannel?: boolean | string
	/** rich link card above the message (title, body, thumbnail) */
	adReply?: AdReplyOptions
}

export type HashuStatusOptions = {
	/** who can see the status (jids). mentioned users are added automatically */
	statusJidList?: string[]
	/** users to tag in the status, they get a "mentioned you" notification */
	mentions?: string[]
	backgroundColor?: string
	/** 0-5 */
	font?: number
}

export type ChannelPost = {
	serverId: string
	type?: string
	message?: proto.IMessage
}

/** metadata sometimes comes back with name as a plain string, sometimes as { text } */
const channelName = (meta: unknown): string | undefined => {
	const name = (meta as { name?: unknown } | null)?.name
	if (typeof name === 'string') return name
	return (name as { text?: string } | undefined)?.text
}

const findNode = (node: BinaryNode | undefined, tag: string): BinaryNode | undefined => {
	if (!node) return undefined
	if (node.tag === tag) return node
	if (Array.isArray(node.content)) {
		for (const child of node.content) {
			const hit = findNode(child, tag)
			if (hit) return hit
		}
	}
	return undefined
}

export const makeHashuSocket = (config: SocketConfig) => {
	// remembers recent messages: needed for anti delete, poll votes and as a getMessage source
	const cache = makeMessageCache(1000)
	const sock = makeCommunitiesSocket({
		...config,
		getMessage: async key => cache.get(key)?.message || config.getMessage(key)
	})
	const { query, generateMessageTag } = sock
	sock.ev.on('messages.upsert', ({ messages }) => messages.forEach(m => cache.set(m)))

	// ---------------------------------------------------------------------------------------------------------------
	// channel helpers
	// ---------------------------------------------------------------------------------------------------------------
	const channelCache = new Map<string, { jid: string; name?: string }>()

	/** channel url / invite code / jid -> { jid, name } */
	const resolveChannel = async (input: string) => {
		const cached = channelCache.get(input)
		if (cached) return cached

		let result: { jid: string; name?: string }
		if (input.endsWith('@newsletter')) {
			result = { jid: input }
			try {
				const meta = await sock.newsletterMetadata('jid', input)
				result.name = channelName(meta)
			} catch {
				// the jid is enough, the name is optional
			}
		} else {
			const code = parseChannelCode(input)
			if (!code) throw new Boom('not a valid channel url, invite code or jid', { statusCode: 400 })
			const meta = await sock.newsletterMetadata('invite', code)
			if (!meta?.id) throw new Boom('channel not found', { statusCode: 404 })
			result = { jid: meta.id, name: channelName(meta) }
		}

		channelCache.set(input, result)
		return result
	}

	/** latest posts of a channel, with the serverId you need for reactions and poll votes */
	const fetchChannelPosts = async (channel: string, count = 20): Promise<ChannelPost[]> => {
		const { jid } = await resolveChannel(channel)
		const result = await query({
			tag: 'iq',
			attrs: { id: generateMessageTag(), type: 'get', xmlns: 'newsletter', to: S_WHATSAPP_NET },
			content: [{ tag: 'messages', attrs: { type: 'jid', jid, count: String(count) } }]
		})
		const container = findNode(result, 'messages') ?? result
		return getBinaryNodeChildren(container, 'message')
			.filter(node => node.attrs.edit !== '8') // 8 = deleted by an admin
			.map(node => {
				const plain = getBinaryNodeChild(node, 'plaintext')?.content
				let message: proto.IMessage | undefined
				if (plain instanceof Uint8Array) {
					try {
						message = proto.Message.decode(plain)
					} catch {
						message = undefined
					}
				}

				return { serverId: node.attrs.server_id!, type: node.attrs.type, message }
			})
	}

	/** where a vote should go: a channel url (optionally with /<postId>), a jid, an invite code or a received channel message */
	type PollTarget = string | { jid: string; serverId?: string } | Pick<WAMessage, 'key'>

	const resolvePollTarget = async (target: PollTarget, serverId?: string) => {
		if (typeof target === 'string') {
			const { jid } = await resolveChannel(target)
			return { jid, serverId: serverId ?? parseChannelPostId(target) }
		}

		if ('key' in target) {
			const jid = target.key.remoteJid
			if (!jid?.endsWith('@newsletter')) throw new Boom('this message is not from a channel', { statusCode: 400 })
			return { jid, serverId: serverId ?? target.key.server_id ?? undefined }
		}

		return { jid: target.jid, serverId: serverId ?? target.serverId }
	}

	/**
	 * Votes in a channel poll (channel polls are not encrypted, the vote is a plain stanza that names
	 * every selected option by sha256(option text)).
	 *
	 * - `options`: option text, 1-based number, or an array of them for multi-select polls
	 * - `[]` or `null` removes your vote
	 * - every vote replaces the previous one, WhatsApp always takes the whole selection
	 * - without a post id (`.../channel/CODE/683` or `serverId`) the newest poll of the channel is used
	 */
	const voteChannelPoll = async (
		target: PollTarget,
		options: string | number | (string | number)[] | null,
		opts: { serverId?: string } = {}
	) => {
		const { jid, serverId: wanted } = await resolvePollTarget(target, opts.serverId)
		const posts = await fetchChannelPosts(jid, 40)
		const post = wanted ? posts.find(p => p.serverId === String(wanted)) : posts.find(p => hasPoll(p.message))
		if (!post) {
			throw new Boom(wanted ? `post ${wanted} was not found in the latest posts of this channel` : 'no poll found in this channel', {
				statusCode: 404
			})
		}

		const poll = getPoll(post.message)
		if (!poll) throw new Boom(`post ${post.serverId} is not a poll`, { statusCode: 400 })

		const available = (poll.options || []).map(o => o.optionName || '')
		const wantedList = options === null ? [] : Array.isArray(options) ? options : [options]

		const selected: string[] = []
		for (const item of wantedList) {
			const text = String(item).trim()
			const byText = available.find(name => name === text) ?? available.find(name => name.toLowerCase() === text.toLowerCase())
			let name = byText
			if (!name && (typeof item === 'number' || /^\d+$/.test(text))) {
				name = available[Number(text) - 1]
			}

			if (!name) {
				throw new Boom(`option "${text}" not found. Options: ${available.map((o, i) => `${i + 1}. ${o}`).join(' | ')}`, {
					statusCode: 400
				})
			}

			if (!selected.includes(name)) selected.push(name)
		}

		const maxChoices = poll.selectableOptionsCount || 0
		if (maxChoices > 0 && selected.length > maxChoices) {
			throw new Boom(`this poll allows only ${maxChoices} choice(s)`, { statusCode: 400 })
		}

		const votes: BinaryNode[] = selected.map(name => ({
			tag: 'vote',
			attrs: {},
			content: sha256(Buffer.from(name, 'utf8'))
		}))

		const id = generateMessageTag()
		const ack = await query({
			tag: 'message',
			attrs: { to: jid, id, type: 'poll', server_id: post.serverId },
			content: [
				{ tag: 'meta', attrs: { polltype: 'vote' } },
				{ tag: 'votes', attrs: {}, content: votes }
			]
		})
		if (ack?.attrs?.error) {
			throw new Boom(`WhatsApp rejected the vote (error ${ack.attrs.error})`, { statusCode: Number(ack.attrs.error) || 500 })
		}

		return { jid, serverId: post.serverId, poll: poll.name || '', selected, removed: selected.length === 0, id }
	}

	/** takes your vote back */
	const removeChannelPollVote = (target: PollTarget, opts: { serverId?: string } = {}) =>
		voteChannelPoll(target, null, opts)

	const hasPoll = (m?: proto.IMessage | null) => !!getPoll(m)
	const getPoll = (m?: proto.IMessage | null) =>
		m?.pollCreationMessage || m?.pollCreationMessageV2 || m?.pollCreationMessageV3 || undefined

	// ---------------------------------------------------------------------------------------------------------------
	// sendMessage with channel label + ad reply support
	// ---------------------------------------------------------------------------------------------------------------
	const baseSendMessage = sock.sendMessage

	const sendMessage = async (
		jid: string,
		content: AnyMessageContent & HashuMessageExtras,
		options: MiscMessageGenerationOptions = {}
	): Promise<WAMessage | undefined> => {
		const sent = await sendWithExtras(jid, content, options)
		if (sent) cache.set(sent)
		return sent
	}

	const sendWithExtras = async (
		jid: string,
		content: AnyMessageContent & HashuMessageExtras,
		options: MiscMessageGenerationOptions = {}
	): Promise<WAMessage | undefined> => {
		const { forwardFromChannel, adReply, ...rest } = content as AnyMessageContent & HashuMessageExtras
		if (!forwardFromChannel && !adReply) {
			return baseSendMessage(jid, content as AnyMessageContent, options)
		}

		let context: proto.IContextInfo = {}
		if (forwardFromChannel) {
			const channel = await resolveChannel(forwardFromChannel === true ? HASHU_CHANNEL_URL : forwardFromChannel)
			context = { ...context, ...channelForwardContext(channel) }
		}

		if (adReply) {
			context = { ...context, ...adReplyContext(adReply) }
		}

		const existing = (rest as { contextInfo?: proto.IContextInfo }).contextInfo
		return baseSendMessage(jid, { ...rest, contextInfo: { ...context, ...existing } } as AnyMessageContent, options)
	}

	// ---------------------------------------------------------------------------------------------------------------
	// status (stories)
	// ---------------------------------------------------------------------------------------------------------------

	/** posts a status. Pass text / image / video / audio content, optionally tag users with `mentions` */
	const sendStatus = async (content: AnyRegularMessageContent, opts: HashuStatusOptions = {}) => {
		const mentions = (opts.mentions || []).map(jidNormalizedUser)
		const own = sock.user?.id ? jidNormalizedUser(sock.user.id) : undefined
		const viewers = [...new Set([...(opts.statusJidList || []).map(jidNormalizedUser), ...mentions, ...(own ? [own] : [])])]
		if (!viewers.length) throw new Boom('statusJidList is empty and the socket has no user yet', { statusCode: 400 })

		const msg = await baseSendMessage(
			'status@broadcast',
			{ ...(content as AnyMessageContent), ...(mentions.length ? { mentions } : {}) } as AnyMessageContent,
			{ statusJidList: viewers, backgroundColor: opts.backgroundColor, font: opts.font }
		)
		if (!msg) return msg

		// a plain tag is not enough for WhatsApp to notify people, each mentioned user needs this extra message
		for (const jid of mentions) {
			await sock.relayMessage(
				jid,
				{
					statusMentionMessage: {
						message: {
							protocolMessage: {
								key: msg.key,
								type: proto.Message.ProtocolMessage.Type.STATUS_MENTION_MESSAGE
							}
						}
					}
				},
				{ additionalNodes: [{ tag: 'meta', attrs: { is_status_mention: 'true' }, content: undefined }] }
			)
		}

		return msg
	}

	/** text status with background colour and font */
	const sendTextStatus = (text: string, opts: HashuStatusOptions = {}) =>
		sendStatus({ text }, { backgroundColor: '#128C7E', font: 0, ...opts })

	// ---------------------------------------------------------------------------------------------------------------
	// group status
	// ---------------------------------------------------------------------------------------------------------------

	/**
	 * Posts a "group status" (the pinned story-like update of a group).
	 * `content` is any normal content: { text }, { image }, { video }, { audio } ...
	 */
	const sendGroupStatus = async (groupJid: string, content: AnyRegularMessageContent) => {
		if (!isJidGroup(groupJid)) throw new Boom('sendGroupStatus needs a group jid', { statusCode: 400 })

		const inner = await generateWAMessageContent(content as AnyMessageContent, {
			logger: config.logger,
			upload: sock.waUploadToServer,
			mediaCache: config.mediaCache,
			options: config.options,
			jid: groupJid
		})

		const messageSecret = randomBytes(32)
		const message: proto.IMessage = {
			messageContextInfo: { messageSecret },
			groupStatusMessageV2: {
				message: { ...inner, messageContextInfo: { ...(inner.messageContextInfo || {}), messageSecret } }
			}
		}

		const id = generateMessageIDV2(sock.user?.id)
		await sock.relayMessage(groupJid, message, { messageId: id })
		return { key: { remoteJid: groupJid, fromMe: true, id }, message } as WAMessage
	}

	// ---------------------------------------------------------------------------------------------------------------
	// media helpers (need ffmpeg)
	// ---------------------------------------------------------------------------------------------------------------
	const sendPTT = async (jid: string, media: WAMediaUpload, options: MiscMessageGenerationOptions = {}) => {
		const audio = await convertToPTT(media)
		return sendMessage(jid, { audio, ptt: true, mimetype: 'audio/ogg; codecs=opus' }, options)
	}

	const sendGif = async (jid: string, media: WAMediaUpload, caption?: string, options: MiscMessageGenerationOptions = {}) => {
		const video = await convertToGif(media)
		return sendMessage(jid, { video, gifPlayback: true, caption }, options)
	}

	const sendVideoNote = async (jid: string, media: WAMediaUpload, options: MiscMessageGenerationOptions = {}) => {
		const video = await convertToVideoNote(media)
		return sendMessage(jid, { video, ptv: true }, options)
	}

	const tools = makeHashuTools({ sock, config, cache, sendMessage, resolveChannel })
	const safety = makeHashuSafety({ sock, config, cache, sendMessage })

	return {
		...sock,
		...tools,
		...safety,
		sendMessage,
		// channels
		resolveChannel,
		followChannel: async (channel: string) => sock.newsletterFollow((await resolveChannel(channel)).jid),
		unfollowChannel: async (channel: string) => sock.newsletterUnfollow((await resolveChannel(channel)).jid),
		sendChannelPost: async (
			channel: string,
			content: AnyMessageContent,
			options: MiscMessageGenerationOptions = {}
		) => baseSendMessage((await resolveChannel(channel)).jid, content, options),
		reactChannelPost: async (channel: string, serverId: string, emoji?: string) =>
			sock.newsletterReactMessage((await resolveChannel(channel)).jid, serverId, emoji),
		fetchChannelPosts,
		voteChannelPoll,
		removeChannelPollVote,
		// status
		sendStatus,
		sendTextStatus,
		sendGroupStatus,
		// media
		sendPTT,
		sendGif,
		sendVideoNote
	}
}

export type HashuSocket = ReturnType<typeof makeHashuSocket>
