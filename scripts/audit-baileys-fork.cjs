#!/usr/bin/env node
/**
 * Checks a project for the "auto follow" Baileys fork malware (PhantomSub, reported by OX Security 2026-09-28):
 * packages that silently make the linked WhatsApp account follow + mute spam / scam channels.
 *
 *   node scripts/audit-baileys-fork.cjs                 checks ./package.json and ./node_modules
 *   node scripts/audit-baileys-fork.cjs /path/to/bot    checks another project
 *
 * No dependencies, nothing is changed, nothing is sent anywhere.
 */
const fs = require('fs')
const path = require('path')

// package names listed in the OX Security report (live and taken down). The list keeps growing, treat it as a start.
const BAD = new Set(
	`ourin-baileys @nexustechpro/baileys @badzz88/baileys @ostyado/baileys levvleys @vanzxy/baileys @yudzxml/baileys @chatunity/baileys
@kelvdra/baileys neuralwhatsapp lilys-baileys @fyxzpediaa/baileys noxleyss @xrelly-stack/bails alipclutch-baileys kurobails
eliteprotech-baileys @xayz/baileys chromestaff-baileys @sanzoffc/baileys @sairidev/baileys-new cloud-baileys @nyzzpediaa/baileys-new
ishumdz-bail nishiki-bail diezyclutch-baileys oktz-baileys my-auto-follow @kanaraa/baileys @fer2809fl/baileys jexkcode rafael-bails
@ikanngeming/ikannbail zero-baileys @zeronexcode/baileys @sakataoffc/baileys @astracode/byles-new @saazkira/baileys @lekzo/baileys
@revizahoshii/baileys my-baileys noverojava sauruskyah-baileys @modss/baileys @fhkryxv/baileys @japofc/baileys @lendxntaa/baileys
baileys-xbats kiyoramarkets @levvicode/baileys luoxy-baileys @mikudeveloper/grace cortana-md-engine @bellaxchuu/flowblue
@wanzlonely/bails4u mikuhostt-baileys cantarella-baileys saurustheking @mivesensei/baileys @revizahoshii/hoshino @noxleyss/baileys
@fhkryxv/baileys-new @fazzcodestudio/wa-web @ikyyjee/ikyysingle focashi @zanta/baileys shadowmd @ikyyjee/ikyysinggle
itsmeeaizat-bailey @bellaxchuu/privatebails arsya-baileys xzvexpzcbailey @mr-supun-fernando/supunmd-bail yonzofficial fixo-baileys
@jojoxyz/condemnedforce-baileys @rixxcodex/baileys @lendkzn/xntaabail spencer-baileys @wenzyx1/bails yonzoffic-baileys
@xatancchii/velycxbail @kxa/xbails monte-md-baileys albert-anitabaileys @web2apk/baileys dilxztech kiki-baileys anuaja
@bellaxchuu/xtrxbails noverojs sea-baileys focaleys @bottino/baileys saturn-baileys @bellaxchuu/belbails @bellaxchuu/teambails
@nyzzpedia/baileys-new noxxleys saturn-bail kasabaileys`
		.split(/\s+/)
		.filter(Boolean)
)

const root = path.resolve(process.argv[2] || '.')
let problems = 0
const warn = msg => {
	problems++
	console.log('  !! ' + msg)
}

// 1. package.json (also catches aliases like "@whiskeysockets/baileys": "npm:levvleys")
const pkgPath = path.join(root, 'package.json')
console.log(`Checking ${root}`)
if (fs.existsSync(pkgPath)) {
	const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'))
	for (const field of ['dependencies', 'devDependencies', 'optionalDependencies']) {
		for (const [name, spec] of Object.entries(pkg[field] || {})) {
			const real = String(spec).startsWith('npm:') ? String(spec).slice(4).replace(/@[^@/]*$/, '') : name
			if (BAD.has(name) || BAD.has(real)) warn(`${field}: "${name}": "${spec}" is on the malicious package list`)
		}
	}
}

// 2. code scan
const FOLLOW = /newsletterFollow|newsletterMute|newsletter_follow|groupAcceptInvite|xwa2_newsletter_(join|follow)/
const REMOTE = /raw\.githubusercontent\.com|raw\.github\.com|files\.gifted\.co\.ke/
const HIDDEN = /atob\(|Buffer\.from\([^)]*['"]base64['"]/
const HARD_ID = /\d{15,}@newsletter/

const walk = (dir, out = []) => {
	if (!fs.existsSync(dir)) return out
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		const full = path.join(dir, entry.name)
		if (entry.isDirectory()) {
			if (['.git', '.cache'].includes(entry.name)) continue
			walk(full, out)
		} else if (/\.(js|cjs|mjs|ts)$/.test(entry.name) && fs.statSync(full).size < 3_000_000) out.push(full)
	}
	return out
}

const targets = [path.join(root, 'node_modules')]
if (fs.existsSync(path.join(root, 'src'))) targets.push(path.join(root, 'src'))
const seen = new Set()
for (const target of targets) {
	for (const file of walk(target)) {
		// only look at WhatsApp libraries, not every package in node_modules
		const rel = path.relative(root, file)
		if (target.endsWith('node_modules') && !/baileys|bails|bailey|wa-web|whatsapp/i.test(rel)) continue
		const code = fs.readFileSync(file, 'utf8')
		if (!FOLLOW.test(code)) continue
		const reasons = []
		if (REMOTE.test(code)) reasons.push('downloads a list from GitHub / a file host')
		if (HIDDEN.test(code)) reasons.push('decodes hidden base64 data')
		if (HARD_ID.test(code)) reasons.push('has hard coded channel ids')
		if (reasons.length && !seen.has(rel)) {
			seen.add(rel)
			warn(`${rel}: follows / joins and ${reasons.join(', ')}`)
		}
	}
}

console.log(
	problems
		? `\n${problems} problem(s). Remove the package, then check which channels your number follows and unfollow the ones you do not know.`
		: '\nNothing suspicious found. (This is a quick check, not a guarantee.)'
)
process.exit(problems ? 1 : 0)
