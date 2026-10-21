import { spawn } from 'child_process'
import { Boom } from '@hapi/boom'
import type { proto } from '../../WAProto/index.js'
import type { WAMediaUpload } from '../Types'
import { getStream, toBuffer } from './messages-media'

/** default channel used when `forwardFromChannel: true` is passed */
export const HASHU_CHANNEL_URL = 'https://whatsapp.com/channel/0029VazhnLzK0IBdwXG4152o'

/** pulls the invite code out of https://whatsapp.com/channel/<code> (or returns the input if it already is a code) */
export const parseChannelCode = (input: string): string | undefined => {
	const text = input.trim()
	const match = text.match(/whatsapp\.com\/channel\/([A-Za-z0-9_-]+)/i)
	if (match) return match[1]
	if (/^[A-Za-z0-9_-]{16,}$/.test(text)) return text
	return undefined
}

/** post id of a link like https://whatsapp.com/channel/<code>/683 */
export const parseChannelPostId = (input: string): string | undefined =>
	input.trim().match(/whatsapp\.com\/channel\/[A-Za-z0-9_-]+\/(\d+)/i)?.[1]

export const isChannelInput = (input: string) => input.endsWith('@newsletter') || !!parseChannelCode(input)

export type ChannelContextInfo = {
	jid: string
	name?: string
	/** id of the post the label should point to, 100 works for a generic "forwarded from channel" label */
	serverMessageId?: number
}

/** contextInfo that makes a message show "Forwarded from <channel>" with a tappable channel header */
export const channelForwardContext = ({ jid, name, serverMessageId = 100 }: ChannelContextInfo): proto.IContextInfo => ({
	isForwarded: true,
	forwardingScore: 1,
	forwardedNewsletterMessageInfo: {
		newsletterJid: jid,
		newsletterName: name,
		serverMessageId
	}
})

export type AdReplyOptions = {
	title: string
	body?: string
	/** small preview picture (jpeg bytes) */
	thumbnail?: Buffer
	thumbnailUrl?: string
	/** where the card opens when tapped */
	sourceUrl?: string
	mediaUrl?: string
	/** 1 = image, 2 = video */
	mediaType?: 1 | 2
	renderLargerThumbnail?: boolean
	showAdAttribution?: boolean
}

/** contextInfo for the rich link card (title, body, thumbnail) shown above a message */
export const adReplyContext = (opts: AdReplyOptions): proto.IContextInfo => ({
	externalAdReply: {
		title: opts.title,
		body: opts.body,
		thumbnail: opts.thumbnail,
		thumbnailUrl: opts.thumbnailUrl,
		sourceUrl: opts.sourceUrl,
		mediaUrl: opts.mediaUrl,
		mediaType: opts.mediaType ?? 1,
		renderLargerThumbnail: opts.renderLargerThumbnail ?? true,
		showAdAttribution: opts.showAdAttribution ?? false
	}
})

// ---------------------------------------------------------------------------------------------------------------------
// ffmpeg based converters (ffmpeg has to be installed on the machine, Railway/nixpacks: add `ffmpeg` to nixPkgs)
// ---------------------------------------------------------------------------------------------------------------------

const runFfmpeg = (input: Buffer, args: string[]): Promise<Buffer> =>
	new Promise((resolve, reject) => {
		const proc = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', ...args])
		const out: Buffer[] = []
		const err: Buffer[] = []
		proc.stdout.on('data', (d: Buffer) => out.push(d))
		proc.stderr.on('data', (d: Buffer) => err.push(d))
		proc.on('error', e =>
			reject(
				(e as NodeJS.ErrnoException).code === 'ENOENT'
					? new Boom('ffmpeg is not installed on this machine', { statusCode: 501 })
					: e
			)
		)
		proc.on('close', code => {
			if (code === 0 && out.length) return resolve(Buffer.concat(out))
			reject(new Boom(`ffmpeg failed: ${Buffer.concat(err).toString().slice(0, 300)}`, { statusCode: 500 }))
		})
		proc.stdin.on('error', () => {})
		proc.stdin.end(input)
	})

export const mediaToBuffer = async (media: WAMediaUpload): Promise<Buffer> => {
	if (Buffer.isBuffer(media)) return media
	const { stream } = await getStream(media)
	return toBuffer(stream)
}

/** any audio/video -> opus voice note (ogg) */
export const convertToPTT = async (media: WAMediaUpload) =>
	runFfmpeg(await mediaToBuffer(media), [
		'-i', 'pipe:0', '-vn', '-c:a', 'libopus', '-b:a', '48k', '-ar', '48000', '-ac', '1', '-f', 'ogg', 'pipe:1'
	])

const MP4_PIPE_FLAGS = ['-movflags', 'frag_keyframe+empty_moov+default_base_moof', '-f', 'mp4', 'pipe:1']

/** any video -> silent mp4 that WhatsApp plays as a gif */
export const convertToGif = async (media: WAMediaUpload) =>
	runFfmpeg(await mediaToBuffer(media), [
		'-i', 'pipe:0', '-an', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2', ...MP4_PIPE_FLAGS
	])

/** any video -> square 640x640 mp4 for round video notes, max 60s */
export const convertToVideoNote = async (media: WAMediaUpload) =>
	runFfmpeg(await mediaToBuffer(media), [
		'-i', 'pipe:0', '-t', '60', '-vf', "crop='min(iw,ih)':'min(iw,ih)',scale=640:640", '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
		'-c:a', 'aac', ...MP4_PIPE_FLAGS
	])
