export type ScamSignal = {
	id: string
	/** short human readable reason, shown to the owner */
	label: string
	/** 2 = strong sign on its own, 1 = needs another sign next to it */
	weight: number
	test: RegExp
}

/**
 * Plain, readable rules for typical scam messages. They only FLAG a message for a human to look at,
 * nothing is reported or blocked because of them alone. Add / remove rules to fit your area.
 */
export const DEFAULT_SCAM_SIGNALS: ScamSignal[] = [
	{
		id: 'otp',
		label: 'asks for an OTP / verification code',
		weight: 2,
		test: /\b(send|share|give|forward|tell)\b[^.\n]{0,30}\b(otp|one[- ]time (pass)?code|verification code|6[- ]digit code|security code)\b/i
	},
	{
		id: 'seed',
		label: 'asks for a seed phrase / private key',
		weight: 2,
		test: /\b(seed phrase|recovery phrase|private key|wallet phrase)\b/i
	},
	{
		id: 'guaranteed',
		label: 'guaranteed profit',
		weight: 2,
		test: /\b(guaranteed|assured|risk[- ]free)\s+(profit|returns?|income|payout)\b/i
	},
	{
		id: 'double',
		label: 'promises to multiply your money',
		weight: 2,
		test: /\b(double|triple|10x)\s+your\s+(money|investment|deposit)\b/i
	},
	{
		id: 'claim-fee',
		label: 'asks for a fee to release a prize / payment',
		weight: 2,
		test: /\b(pay|send|deposit)\b[^.\n]{0,30}\b(fee|tax|charges?|processing)\b[^.\n]{0,40}\b(claim|release|withdraw|receive)\b/i
	},
	{
		id: 'prize',
		label: 'prize / lottery winner message',
		weight: 1,
		test: /\b(you(?:'ve| have)? won|lucky draw|lottery)\b[^.\n]{0,60}\b(prize|gift|reward|cash|iphone|bonus)\b/i
	},
	{
		id: 'daily-income',
		label: 'easy daily income offer',
		weight: 1,
		test: /\b(earn|make)\s+(up to\s+)?(\$|rs\.?|usd|lkr)?\s?\d[\d,]*\+?\s*(per day|daily|a day|every day|per week|weekly)\b/i
	},
	{
		id: 'task-job',
		label: 'paid-for-likes / tasks job offer',
		weight: 1,
		test: /\b(like|follow|subscribe|rate)\b[^.\n]{0,40}\b(earn|paid|payment|commission)\b/i
	},
	{
		id: 'account-alert',
		label: 'fake account suspended / verify alert',
		weight: 1,
		test: /\b(account|card|bank|whatsapp)\b[^.\n]{0,30}\b(suspended|blocked|locked|expired|verification)\b/i
	},
	{
		id: 'urgent-money',
		label: 'urgent request to send money',
		weight: 1,
		test: /\b(urgent(ly)?|emergency)\b[^.\n]{0,50}\b(send|transfer)\b[^.\n]{0,30}\b(money|cash|funds|payment)\b/i
	},
	{
		id: 'short-link',
		label: 'shortened link',
		weight: 1,
		test: /\b(bit\.ly|tinyurl\.com|cutt\.ly|rb\.gy|is\.gd|shorturl\.at)\/\S+/i
	},
	{
		id: 'group-invite',
		label: 'pushes a group invite link',
		weight: 1,
		test: /chat\.whatsapp\.com\/\S+/i
	}
]

export type ScamScan = { score: number; matched: { id: string; label: string }[] }

export const detectScamSignals = (text: string, signals: ScamSignal[] = DEFAULT_SCAM_SIGNALS): ScamScan => {
	const matched = signals.filter(signal => signal.test.test(text))
	return {
		score: matched.reduce((sum, signal) => sum + signal.weight, 0),
		matched: matched.map(({ id, label }) => ({ id, label }))
	}
}
