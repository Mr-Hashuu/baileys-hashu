import { randomBytes } from 'crypto'
import { Boom } from '@hapi/boom'
import { proto } from '../../WAProto/index.js'
import type { AnyMessageContent, MiscMessageGenerationOptions, SocketConfig, WAMessage } from '../Types'
import {
	DEFAULT_SCAM_SIGNALS,
	detectScamSignals,
	getContentType,
	normalizeMessageContent,
	type ScamSignal
} from '../Utils'
import { type BinaryNode, isJidGroup, isLidUser, isPnUser, jidNormalizedUser, S_WHATSAPP_NET } from '../WABinary'
import type { makeCommunitiesSocket } from './communities'
import type { MessageCache } from './hashu-tools'

type BaseSocket = ReturnType<typeof makeCommunitiesSocket>

export type SpamFlow = 'MessageMenu' | 'ContactInfo' | 'GroupInfoReport' | 'GroupSpamBannerReport'

export type ScamSafetyOptions = {
	/** your own number, the only one who gets scam alerts and can confirm them */
	ownerJid?: string
	/** numbers / groups that must never be reported or blocked (owners, family, staff, your own groups) */
	protect?: string[]
	/** extra check, return true for anyone you know (contact book, customer database ...) */
	isTrusted?: (jid: string) => boolean | Promise<boolean>
	/** reports allowed in any rolling 24 hours (default 5) */
	maxReportsPerDay?: number
	/** the same number / group is not reported again for this many days (default 30) */
	cooldownDays?: number
	/** leave a group after reporting it (default true) */
	leaveReportedGroups?: boolean
}

export type ScamWatchOptions = ScamSafetyOptions & {
	/** replace or extend the default rules */
	signals?: ScamSignal[]
	/** score needed before the owner is alerted (default 2) */
	minScore?: number
	/** watch private chats (default true) */
	watchPrivate?: boolean
	/** watch groups you are in (default true) */
	watchGroups?: boolean
	/** your own alert text / delivery, by default a message to ownerJid is sent */
	onCase?: (scamCase: ScamCase) => unknown
}

export type ScamCase = {
	id: string
	kind: 'user' | 'group'
	/** the number (private chat) or group jid that is suspected */
	target: string
	signals: string[]
	evidence: WAMessage[]
	createdAt: number
}

export type ScamReportLogEntry = { target: string; kind: 'user' | 'group'; at: number }

export type ScamActionResult = {
	target: string
	reported: boolean
	blocked: boolean
	leftGroup: boolean
	reportError?: string
}

const MAX_EVIDENCE = 5
/** nobody can raise the daily limit above this, it keeps the tool from being used as a report bomb */
const HARD_DAILY_CEILING = 20
const DAY = 24 * 60 * 60 * 1000

const textOf = (msg: WAMessage): string => {
	const content = normalizeMessageContent(msg.message)
	return (
		content?.conversation ||
		content?.extendedTextMessage?.text ||
		content?.imageMessage?.caption ||
		content?.videoMessage?.caption ||
		content?.documentMessage?.caption ||
		''
	)
}

const timestampOf = (msg: WAMessage) => {
	const ts = msg.messageTimestamp
	return typeof ts === 'number' ? ts : Number(ts?.toString() || Math.floor(Date.now() / 1000))
}

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))

export const makeHashuSafety = ({
	sock,
	config,
	cache,
	sendMessage
}: {
	sock: BaseSocket
	config: SocketConfig
	cache: MessageCache
	sendMessage: (jid: string, content: AnyMessageContent, options?: MiscMessageGenerationOptions) => Promise<WAMessage | undefined>
}) => {
	const logger = config.logger
	const log: ScamReportLogEntry[] = []
	const cases = new Map<string, ScamCase>()
	const trustedNow = new Set<string>()
	let defaults: ScamSafetyOptions = {}

	const ownJid = () => (sock.user?.id ? jidNormalizedUser(sock.user.id) : undefined)
	const same = (a?: string | null, b?: string | null) => !!a && !!b && jidNormalizedUser(a) === jidNormalizedUser(b)

	// ---------------------------------------------------------------------------------------------------------
	// safety rules, every report goes through this. There is deliberately no bulk API.
	// ---------------------------------------------------------------------------------------------------------
	const guard = async (kind: 'user' | 'group', target: string, evidence: WAMessage[], options: ScamSafetyOptions) => {
		const opts = { ...defaults, ...options }
		const refuse = (reason: string, status = 403) => {
			throw new Boom(`refused: ${reason}`, { statusCode: status })
		}

		if (kind === 'group' ? !isJidGroup(target) : !(isPnUser(target) || isLidUser(target))) {
			refuse(kind === 'group' ? 'target must be a group jid' : 'target must be a private chat number, not a group or channel')
		}

		const protectedJids = [ownJid(), opts.ownerJid, ...(opts.protect || [])].filter(Boolean) as string[]
		if (protectedJids.some(jid => same(jid, target)) || trustedNow.has(jidNormalizedUser(target))) {
			refuse('this jid is protected / trusted')
		}

		if (opts.isTrusted && (await opts.isTrusted(target))) refuse('this jid is trusted')

		// only report what the bot really received from that number / group
		const real = evidence
			.filter(m => !m.key.fromMe && m.message)
			.filter(m =>
				kind === 'group' ? m.key.remoteJid === target : same(m.key.remoteJid!, target) || same(m.key.remoteJidAlt, target)
			)
			.sort((a, b) => timestampOf(b) - timestampOf(a))
			.slice(0, MAX_EVIDENCE)
		if (!real.length) refuse('no received messages from this target were given as evidence', 400)

		// somebody you wrote to yourself is a conversation, not an unsolicited scam
		if (kind === 'user' && cache.values().some(m => m.key.fromMe && same(m.key.remoteJid!, target))) {
			refuse('you have chatted with this number, report it by hand if you are sure')
		}

		const now = Date.now()
		const recent = log.filter(entry => now - entry.at < DAY)
		if (recent.length >= Math.min(opts.maxReportsPerDay ?? 5, HARD_DAILY_CEILING)) refuse('daily report limit reached', 429)
		const cooldown = (opts.cooldownDays ?? 30) * DAY
		if (log.some(entry => same(entry.target, target) && now - entry.at < cooldown)) {
			refuse('this target was already reported recently', 409)
		}

		return { evidence: real, opts }
	}

	// ---------------------------------------------------------------------------------------------------------
	// the report itself (same thing the "Report" button in WhatsApp sends)
	// ---------------------------------------------------------------------------------------------------------
	const buildSpamList = (flow: SpamFlow, msg: WAMessage, group?: { jid: string; subject?: string }): BinaryNode => {
		const content = normalizeMessageContent(msg.message)
		const type = getContentType(content)
		const mediatype = type && type !== 'conversation' && type !== 'extendedTextMessage' ? type.replace(/Message$/, '') : undefined

		const sender = msg.key.participant || msg.key.remoteJid!
		const messageAttrs: Record<string, string> = {
			id: msg.key.id!,
			t: String(timestampOf(msg)),
			from: group ? group.jid : msg.key.remoteJid!
		}
		if (group) messageAttrs.participant = sender

		return {
			tag: 'spam_list',
			attrs: {
				spam_flow: flow,
				...(group ? { jid: group.jid, ...(group.subject ? { subject: group.subject } : {}) } : {})
			},
			content: [
				{
					tag: 'message',
					attrs: messageAttrs,
					content: [
						{
							tag: 'raw',
							attrs: { v: '3', ...(mediatype ? { mediatype } : {}) },
							content: proto.Message.encode(msg.message!).finish()
						}
					]
				}
			]
		}
	}

	const sendSpamReport = (flow: SpamFlow, msg: WAMessage, group?: { jid: string; subject?: string }) =>
		sock.query({
			tag: 'iq',
			attrs: { id: sock.generateMessageTag(), type: 'set', xmlns: 'spam', to: S_WHATSAPP_NET },
			content: [buildSpamList(flow, msg, group)]
		})

	const record = (target: string, kind: 'user' | 'group') => log.push({ target: jidNormalizedUser(target), kind, at: Date.now() })

	/**
	 * Reports a private chat as spam / scam and blocks the number, like "Report and block" in WhatsApp.
	 * `evidence` = the messages you received from that number (max 5 are sent).
	 */
	const blockAndReport = async (
		jid: string,
		options: ScamSafetyOptions & { evidence: WAMessage[]; block?: boolean }
	): Promise<ScamActionResult> => {
		const { evidence, opts } = await guard('user', jid, options.evidence, options)
		const result: ScamActionResult = { target: jid, reported: false, blocked: false, leftGroup: false }

		try {
			for (const msg of evidence) {
				await sendSpamReport('MessageMenu', msg)
				await sleep(700)
			}

			result.reported = true
		} catch (err) {
			result.reportError = (err as Error).message
			logger.error({ err }, 'scam report failed')
		}

		if (options.block !== false) {
			await sock.updateBlockStatus(jid, 'block')
			result.blocked = true
		}

		if (result.reported || result.blocked) record(jid, 'user')
		void opts
		return result
	}

	/** Reports a scam group (you have to be in it) and leaves it unless `leave: false`. */
	const reportGroup = async (
		groupJid: string,
		options: ScamSafetyOptions & { evidence: WAMessage[]; leave?: boolean }
	): Promise<ScamActionResult> => {
		const { evidence, opts } = await guard('group', groupJid, options.evidence, options)
		const result: ScamActionResult = { target: groupJid, reported: false, blocked: false, leftGroup: false }

		let subject: string | undefined
		try {
			subject = (await sock.groupMetadata(groupJid)).subject
		} catch {
			// the subject is optional
		}

		try {
			for (const msg of evidence) {
				await sendSpamReport('GroupInfoReport', msg, { jid: groupJid, subject })
				await sleep(700)
			}

			result.reported = true
		} catch (err) {
			result.reportError = (err as Error).message
			logger.error({ err }, 'group report failed')
		}

		if (result.reported && (options.leave ?? opts.leaveReportedGroups ?? true)) {
			await sock.groupLeave(groupJid)
			result.leftGroup = true
		}

		if (result.reported) record(groupJid, 'group')
		return result
	}

	// ---------------------------------------------------------------------------------------------------------
	// scam watch: flags suspicious messages, a human confirms before anything is reported
	// ---------------------------------------------------------------------------------------------------------
	const defaultAlert = async (c: ScamCase, ownerJid: string) => {
		const first = textOf(c.evidence[0]!).replace(/\s+/g, ' ').slice(0, 220)
		const who = c.kind === 'group' ? `group ${c.target}` : `@${c.target.split('@')[0]}`
		await sendMessage(ownerJid, {
			text:
				`Possible scam (${c.kind === 'group' ? 'group' : 'private chat'})\n` +
				`From: ${who}\n` +
				`Signals: ${c.signals.join(', ')}\n` +
				`Message: "${first}"\n\n` +
				`Case: ${c.id}\n` +
				`Reply ".scam yes ${c.id}" to ${c.kind === 'group' ? 'report the group and leave' : 'report and block'}\n` +
				`Reply ".scam no ${c.id}" if it is fine`,
			mentions: c.kind === 'user' ? [c.target] : []
		})
	}

	const scamWatch = (options: ScamWatchOptions = {}) => {
		defaults = { ...defaults, ...options }
		const signals = options.signals ?? DEFAULT_SCAM_SIGNALS
		const minScore = options.minScore ?? 2

		const handler = ({ messages, type }: { messages: WAMessage[]; type: string }) => {
			if (type !== 'notify') return
			for (const msg of messages) {
				const chat = msg.key.remoteJid
				if (!chat || msg.key.fromMe || chat === 'status@broadcast' || chat.endsWith('@newsletter')) continue
				const isGroup = isJidGroup(chat)
				if (isGroup ? options.watchGroups === false : options.watchPrivate === false) continue
				if (same(chat, options.ownerJid) || trustedNow.has(jidNormalizedUser(chat))) continue

				const text = textOf(msg)
				if (!text) continue
				const scan = detectScamSignals(text, signals)
				if (scan.score < minScore) continue

				const target = chat
				const existing = [...cases.values()].find(c => c.target === target)
				if (existing) {
					if (existing.evidence.length < MAX_EVIDENCE) existing.evidence.push(msg)
					continue
				}

				// skip anything the safety rules would refuse anyway, the owner is not bothered with it
				guard(isGroup ? 'group' : 'user', target, [msg], options)
					.then(async () => {
						const scamCase: ScamCase = {
							id: randomBytes(3).toString('hex'),
							kind: isGroup ? 'group' : 'user',
							target,
							signals: scan.matched.map(m => m.label),
							evidence: [msg],
							createdAt: Date.now()
						}
						cases.set(scamCase.id, scamCase)
						if (options.onCase) await options.onCase(scamCase)
						else if (options.ownerJid) await defaultAlert(scamCase, options.ownerJid)
					})
					.catch(() => undefined)
			}
		}

		sock.ev.on('messages.upsert', handler)
		return () => sock.ev.off('messages.upsert', handler)
	}

	// ---------------------------------------------------------------------------------------------------------
	// owner only: with `ownerJid` set, every case action needs `by` (a jid or the received message) from the owner
	// ---------------------------------------------------------------------------------------------------------
	const assertOwner = (by?: string | WAMessage) => {
		const owner = defaults.ownerJid
		if (!owner) return
		const candidates: (string | null | undefined)[] =
			typeof by === 'object' && by
				? [by.key.fromMe ? ownJid() : undefined, by.key.participant, by.key.remoteJid, by.key.participantAlt, by.key.remoteJidAlt]
				: [by as string | undefined]
		if (!candidates.some(jid => same(jid, owner))) {
			throw new Boom('refused: only the owner can do this', { statusCode: 403 })
		}
	}

	const getCase = (id: string) => {
		const scamCase = cases.get(id)
		if (!scamCase) throw new Boom(`no open scam case with id ${id}`, { statusCode: 404 })
		return scamCase
	}

	const runCase = async (scamCase: ScamCase) => {
		const result =
			scamCase.kind === 'group'
				? await reportGroup(scamCase.target, { evidence: scamCase.evidence })
				: await blockAndReport(scamCase.target, { evidence: scamCase.evidence })
		cases.delete(scamCase.id)
		return result
	}

	/** the owner said yes: report (and block / leave) one case */
	const confirmScamCase = async (id: string, by?: string | WAMessage) => {
		assertOwner(by)
		return runCase(getCase(id))
	}

	/**
	 * the owner said yes to many flagged cases at once.
	 * Each case still needs its own evidence and goes through the same rules and the daily limit
	 * (max ${HARD_DAILY_CEILING} a day, no matter what is configured). It stops by itself when the limit is hit.
	 */
	const confirmAllScamCases = async (opts: { by?: string | WAMessage; kind?: 'user' | 'group'; ids?: string[] } = {}) => {
		assertOwner(opts.by)
		const chosen = [...cases.values()].filter(
			c => (!opts.kind || c.kind === opts.kind) && (!opts.ids || opts.ids.includes(c.id))
		)

		const results: { id: string; target: string; result?: ScamActionResult; error?: string }[] = []
		for (const scamCase of chosen) {
			try {
				results.push({ id: scamCase.id, target: scamCase.target, result: await runCase(scamCase) })
			} catch (err) {
				results.push({ id: scamCase.id, target: scamCase.target, error: (err as Error).message })
				if ((err as Boom).output?.statusCode === 429) break
			}

			// slow and random, never a burst
			await sleep(3000 + Math.random() * 3000)
		}

		return results
	}

	/** the owner said no. `trust: true` also stops this number / group from being flagged again until restart */
	const dismissScamCase = (id: string, opts: { trust?: boolean; by?: string | WAMessage } = {}) => {
		assertOwner(opts.by)
		const scamCase = getCase(id)
		if (opts.trust) trustedNow.add(jidNormalizedUser(scamCase.target))
		cases.delete(id)
	}

	return {
		blockAndReport,
		reportGroup,
		scamWatch,
		/** open cases with their evidence, owner only when `ownerJid` is set */
		scamCases: (by?: string | WAMessage) => {
			assertOwner(by)
			return [...cases.values()]
		},
		/** set the owner and safety limits without starting the watcher */
		configureScamSafety: (options: ScamSafetyOptions) => {
			defaults = { ...defaults, ...options }
		},
		confirmScamCase,
		confirmAllScamCases,
		dismissScamCase,
		/** save this somewhere to keep the daily limit and cooldown over restarts */
		exportScamReportLog: () => log.map(entry => ({ ...entry })),
		importScamReportLog: (entries: ScamReportLogEntry[]) => {
			for (const entry of entries) log.push({ ...entry })
		}
	}
}
