import { proto } from '../../../WAProto'
import type { MessageContentGenerationOptions } from '../../Types'
import {
	callButton,
	copyButton,
	getButtonReply,
	quickReplyButton,
	singleSelectButton,
	urlButton
} from '../../Utils/buttons'
import { generateWAMessageContent, normalizeMessageContent } from '../../Utils/messages'

const options = {} as MessageContentGenerationOptions

describe('button helpers', () => {
	it('builds a quick_reply native flow button', () => {
		const button = quickReplyButton('Yes', 'yes-id')
		expect(button.name).toBe('quick_reply')
		expect(JSON.parse(button.buttonParamsJson)).toEqual({ display_text: 'Yes', id: 'yes-id' })
	})

	it('builds url, copy and call buttons', () => {
		expect(urlButton('Open', 'https://example.com').name).toBe('cta_url')
		expect(JSON.parse(urlButton('Open', 'https://example.com').buttonParamsJson).merchant_url).toBe(
			'https://example.com'
		)
		expect(JSON.parse(copyButton('Copy', 'ABC123').buttonParamsJson).copy_code).toBe('ABC123')
		expect(JSON.parse(callButton('Call', '+94112223334').buttonParamsJson).phone_number).toBe('+94112223334')
	})

	it('builds a single_select button with rows', () => {
		const button = singleSelectButton('Menu', [{ title: 'Tools', rows: [{ id: 'ping', title: 'Ping' }] }])
		const params = JSON.parse(button.buttonParamsJson)
		expect(button.name).toBe('single_select')
		expect(params.sections[0].rows[0]).toMatchObject({ id: 'ping', title: 'Ping' })
	})
})

describe('generateWAMessageContent with buttons', () => {
	it('wraps classic buttons in the view once envelope', async () => {
		const content = await generateWAMessageContent(
			{
				text: 'Pick one',
				footer: 'footer',
				buttons: [
					{ buttonId: 'a', buttonText: { displayText: 'A' } },
					{ buttonId: 'b', buttonText: { displayText: 'B' } }
				]
			},
			options
		)

		expect(content.viewOnceMessage?.message?.messageContextInfo?.deviceListMetadataVersion).toBe(2)
		const buttons = normalizeMessageContent(content)?.buttonsMessage
		expect(buttons?.contentText).toBe('Pick one')
		expect(buttons?.footerText).toBe('footer')
		expect(buttons?.headerType).toBe(proto.Message.ButtonsMessage.HeaderType.EMPTY)
		expect(buttons?.buttons).toHaveLength(2)
		expect(buttons?.buttons?.[0]?.type).toBe(proto.Message.ButtonsMessage.Button.Type.RESPONSE)
	})

	it('creates a native flow interactive message', async () => {
		const content = await generateWAMessageContent(
			{
				text: 'Body',
				footer: 'Foot',
				title: 'Title',
				interactiveButtons: [quickReplyButton('Hi', 'hi'), urlButton('Site', 'https://example.com')]
			},
			options
		)

		const interactive = normalizeMessageContent(content)?.interactiveMessage
		expect(interactive?.body?.text).toBe('Body')
		expect(interactive?.footer?.text).toBe('Foot')
		expect(interactive?.header?.title).toBe('Title')
		expect(interactive?.header?.hasMediaAttachment).toBe(false)
		expect(interactive?.nativeFlowMessage?.buttons?.map(button => button.name)).toEqual(['quick_reply', 'cta_url'])
	})

	it('omits the interactive header when no title or media is given', async () => {
		const content = await generateWAMessageContent(
			{ text: 'Body', interactiveButtons: [quickReplyButton('Hi', 'hi')] },
			options
		)

		expect(normalizeMessageContent(content)?.interactiveMessage?.header).toBeUndefined()
	})

	it('creates a list message', async () => {
		const content = await generateWAMessageContent(
			{
				text: 'Choose a command',
				title: 'Menu',
				buttonText: 'Open',
				sections: [{ title: 'Tools', rows: [{ title: 'Ping', rowId: 'ping', description: 'latency' }] }]
			},
			options
		)

		const list = normalizeMessageContent(content)?.listMessage
		expect(list?.description).toBe('Choose a command')
		expect(list?.buttonText).toBe('Open')
		expect(list?.listType).toBe(proto.Message.ListMessage.ListType.SINGLE_SELECT)
		expect(list?.sections?.[0]?.rows?.[0]?.rowId).toBe('ping')
	})

	it('rejects empty button lists', async () => {
		await expect(generateWAMessageContent({ text: 'x', buttons: [] }, options)).rejects.toThrow(
			'at least one button is required'
		)
		await expect(generateWAMessageContent({ text: 'x', interactiveButtons: [] }, options)).rejects.toThrow(
			'at least one button is required'
		)
	})

	it('leaves plain text messages alone', async () => {
		const content = await generateWAMessageContent({ text: 'hello', linkPreview: null }, options)
		expect(content.viewOnceMessage).toBeUndefined()
		expect(content.extendedTextMessage?.text).toBe('hello')
	})
})

describe('getButtonReply', () => {
	it('reads classic button replies', () => {
		expect(getButtonReply({ buttonsResponseMessage: { selectedButtonId: 'a', selectedDisplayText: 'A' } })).toEqual({
			kind: 'buttons',
			id: 'a',
			displayText: 'A'
		})
	})

	it('reads template button replies', () => {
		expect(getButtonReply({ templateButtonReplyMessage: { selectedId: 't', selectedDisplayText: 'T' } })).toEqual({
			kind: 'template',
			id: 't',
			displayText: 'T'
		})
	})

	it('reads list replies', () => {
		expect(
			getButtonReply({ listResponseMessage: { title: 'Ping', singleSelectReply: { selectedRowId: 'ping' } } })
		).toEqual({ kind: 'list', id: 'ping', displayText: 'Ping' })
	})

	it('reads native flow replies', () => {
		const reply = getButtonReply({
			interactiveResponseMessage: {
				nativeFlowResponseMessage: {
					name: 'quick_reply',
					paramsJson: JSON.stringify({ id: 'yes', display_text: 'Yes' })
				}
			}
		})
		expect(reply).toEqual({ kind: 'native_flow', id: 'yes', displayText: 'Yes', name: 'quick_reply' })
	})

	it('survives malformed native flow params', () => {
		const reply = getButtonReply({
			interactiveResponseMessage: { nativeFlowResponseMessage: { name: 'quick_reply', paramsJson: '{oops' } }
		})
		expect(reply?.id).toBe('')
	})

	it('returns undefined for ordinary messages', () => {
		expect(getButtonReply({ conversation: 'hi' })).toBeUndefined()
		expect(getButtonReply(undefined)).toBeUndefined()
	})
})
