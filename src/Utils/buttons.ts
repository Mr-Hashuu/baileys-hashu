import type { proto } from '../../WAProto/index.js'
import type { InteractiveButtonInfo, ListSectionInfo, WAMessage } from '../Types'
import { normalizeMessageContent } from './messages'

const nativeFlowButton = (name: string, params: Record<string, unknown>): InteractiveButtonInfo => ({
	name,
	buttonParamsJson: JSON.stringify(params)
})

/** button that sends `id` back to the bot when tapped */
export const quickReplyButton = (displayText: string, id: string) =>
	nativeFlowButton('quick_reply', { display_text: displayText, id })

/** button that opens a link */
export const urlButton = (displayText: string, url: string, merchantUrl: string = url) =>
	nativeFlowButton('cta_url', { display_text: displayText, url, merchant_url: merchantUrl })

/** button that copies `code` to the clipboard */
export const copyButton = (displayText: string, code: string, id: string = code) =>
	nativeFlowButton('cta_copy', { display_text: displayText, id, copy_code: code })

/** button that dials a phone number */
export const callButton = (displayText: string, phoneNumber: string) =>
	nativeFlowButton('cta_call', { display_text: displayText, phone_number: phoneNumber })

export type SingleSelectSection = {
	title?: string
	highlightLabel?: string
	rows: { id: string; title: string; header?: string; description?: string }[]
}

/** native flow drop-down list; use inside `interactiveButtons` */
export const singleSelectButton = (title: string, sections: SingleSelectSection[]) =>
	nativeFlowButton('single_select', {
		title,
		sections: sections.map(section => ({
			title: section.title ?? '',
			highlight_label: section.highlightLabel ?? '',
			rows: section.rows.map(row => ({
				header: row.header ?? '',
				title: row.title,
				description: row.description ?? '',
				id: row.id
			}))
		}))
	})

/** convenience for the classic `sections` list message */
export const listSection = (title: string, rows: ListSectionInfo['rows']): ListSectionInfo => ({ title, rows })

export type ButtonReply = {
	kind: 'buttons' | 'template' | 'list' | 'native_flow'
	/** the id you gave the button / row */
	id: string
	displayText?: string
	/** native flow button name, e.g. quick_reply, single_select */
	name?: string
}

const parseJson = (raw?: string | null): Record<string, unknown> => {
	if (!raw) return {}
	try {
		const parsed = JSON.parse(raw)
		return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {}
	} catch {
		return {}
	}
}

/**
 * Reads which button / list row a user tapped from an incoming message.
 * Works for classic buttons, templates, list messages and native flow replies.
 * Returns undefined when the message is not a button reply.
 */
export const getButtonReply = (message: WAMessage | proto.IMessage | null | undefined): ButtonReply | undefined => {
	const content = normalizeMessageContent(
		'message' in (message ?? {}) ? (message as WAMessage).message : (message as proto.IMessage)
	)
	if (!content) return undefined

	if (content.buttonsResponseMessage) {
		const reply = content.buttonsResponseMessage
		return { kind: 'buttons', id: reply.selectedButtonId ?? '', displayText: reply.selectedDisplayText ?? undefined }
	}

	if (content.templateButtonReplyMessage) {
		const reply = content.templateButtonReplyMessage
		return { kind: 'template', id: reply.selectedId ?? '', displayText: reply.selectedDisplayText ?? undefined }
	}

	if (content.listResponseMessage) {
		const reply = content.listResponseMessage
		return {
			kind: 'list',
			id: reply.singleSelectReply?.selectedRowId ?? '',
			displayText: reply.title ?? undefined
		}
	}

	const flow = content.interactiveResponseMessage?.nativeFlowResponseMessage
	if (flow) {
		const params = parseJson(flow.paramsJson)
		const id = typeof params.id === 'string' ? params.id : ''
		const displayText =
			typeof params.display_text === 'string'
				? params.display_text
				: typeof params.title === 'string'
					? params.title
					: (content.interactiveResponseMessage?.body?.text ?? undefined)
		return { kind: 'native_flow', id, displayText, name: flow.name ?? undefined }
	}

	return undefined
}

// ---------------------------------------------------------------------------------------------------------------------
// extra native flow button styles
// ---------------------------------------------------------------------------------------------------------------------

/** build any native flow button by hand: `nativeButton('cta_url', { display_text, url })` */
export const nativeButton = nativeFlowButton

/** "remind me" button */
export const reminderButton = (displayText: string, id: string) =>
	nativeFlowButton('cta_reminder', { display_text: displayText, id })

/** cancels a reminder made with `reminderButton` */
export const cancelReminderButton = (displayText: string, id: string) =>
	nativeFlowButton('cta_cancel_reminder', { display_text: displayText, id })

/** opens the business catalog of `businessPhoneNumber` (digits only, with country code) */
export const catalogButton = (displayText: string, businessPhoneNumber: string) =>
	nativeFlowButton('cta_catalog', { display_text: displayText, business_phone_number: businessPhoneNumber })

/** opens a page inside WhatsApp (in-app web view) */
export const webviewButton = (title: string, url: string) =>
	nativeFlowButton('open_webview', { title, link: { in_app_webview: true, url } })

/** asks the user to share their location */
export const locationButton = (displayText: string = 'Send location') =>
	nativeFlowButton('send_location', { display_text: displayText })
