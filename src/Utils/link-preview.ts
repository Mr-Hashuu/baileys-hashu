import type { WAMediaUploadFunction, WAUrlInfo } from '../Types'
import type { ILogger } from './logger'
import { prepareWAMessageMedia } from './messages'
import { extractImageThumb, getHttpStream } from './messages-media'

const THUMBNAIL_WIDTH_PX = 192

/** Fetches an image and generates a thumbnail for it */
const getCompressedJpegThumbnail = async (url: string, { thumbnailWidth, fetchOpts }: URLGenerationOptions) => {
	const stream = await getHttpStream(url, fetchOpts)
	const result = await extractImageThumb(stream, thumbnailWidth)
	return result
}

export type URLGenerationOptions = {
	thumbnailWidth: number
	fetchOpts: {
		/** Timeout in ms */
		timeout: number
		proxyUrl?: string
		headers?: HeadersInit
	}
	uploadImage?: WAMediaUploadFunction
	logger?: ILogger
}

/**
 * Given a piece of text, checks for any URL present, generates link preview for the same and returns it
 * Return undefined if the fetch failed or no URL was found
 * @param text first matched URL in text
 * @returns the URL info required to generate link preview
 */
export const getUrlInfo = async (
	text: string,
	opts: URLGenerationOptions = {
		thumbnailWidth: THUMBNAIL_WIDTH_PX,
		fetchOpts: { timeout: 3000 }
	}
): Promise<WAUrlInfo | undefined> => {
	try {
		// retries
		let retries = 0
		const maxRetry = 5

		const { getLinkPreview } = await import('link-preview-js')
		let previewLink = text
		if (!text.startsWith('https://') && !text.startsWith('http://')) {
			previewLink = 'https://' + previewLink
		}

		const info = await getLinkPreview(previewLink, {
			...opts.fetchOpts,
			followRedirects: 'follow',
			handleRedirects: (baseURL: string, forwardedURL: string) => {
				const urlObj = new URL(baseURL)
				const forwardedURLObj = new URL(forwardedURL)
				if (retries >= maxRetry) {
					return false
				}

				if (
					forwardedURLObj.hostname === urlObj.hostname ||
					forwardedURLObj.hostname === 'www.' + urlObj.hostname ||
					'www.' + forwardedURLObj.hostname === urlObj.hostname
				) {
					retries += 1
					return true
				} else {
					return false
				}
			},
			headers: opts.fetchOpts?.headers as {}
		})
		if (info && 'title' in info && info.title) {
			const [image] = info.images

			const urlInfo: WAUrlInfo = {
				'canonical-url': info.url,
				'matched-text': text,
				title: info.title,
				description: info.description,
				originalThumbnailUrl: image
			}

			// high quality thumbnail: upload the picture so WhatsApp shows the big preview card.
			// if there is no picture or the upload fails we still send the link with the small thumbnail
			let highQuality = false
			if (opts.uploadImage && image) {
				try {
					const { imageMessage } = await prepareWAMessageMedia(
						{ image: { url: image } },
						{
							upload: opts.uploadImage,
							mediaTypeOverride: 'thumbnail-link',
							options: opts.fetchOpts
						}
					)
					urlInfo.jpegThumbnail = imageMessage?.jpegThumbnail ? Buffer.from(imageMessage.jpegThumbnail) : undefined
					urlInfo.highQualityThumbnail = imageMessage || undefined
					highQuality = !!imageMessage
				} catch (error: any) {
					opts.logger?.debug({ err: error?.stack, url: previewLink }, 'high quality thumbnail failed, using small one')
				}
			}

			if (!highQuality && image) {
				try {
					urlInfo.jpegThumbnail = (await getCompressedJpegThumbnail(image, opts)).buffer
				} catch (error: any) {
					opts.logger?.debug({ err: error.stack, url: previewLink }, 'error in generating thumbnail')
				}
			}

			return urlInfo
		}
	} catch (error: any) {
		if (!error.message.includes('receive a valid')) {
			throw error
		}
	}
}
