# Publishing to npm

1. Pick a package name nobody has taken. Check with `npm view <name>`; a 404 means it is free. A scoped name such as
   `@your-npm-username/baileys` is always free for you.
2. Edit `package.json`: `name`, `version`, `author`, `homepage`, `repository`.
3. Install and build (Node 20+ and Yarn 4 through Corepack):

   ```bash
   corepack enable
   yarn install
   yarn lint
   yarn test
   yarn build
   ```

   `npm install` also works if you do not want Yarn, it just ignores `yarn.lock` and the `resolutions` block.
4. Log in and publish:

   ```bash
   npm login
   npm publish --access public
   ```

   `prepack` runs the build for you, so `lib/` does not need to be committed.
5. Use it in a bot:

   ```bash
   npm i hashu-baileys
   ```

   To keep existing imports working without touching bot code, alias it in the bot's `package.json`:

   ```json
   "dependencies": {
   	"@whiskeysockets/baileys": "npm:hashu-baileys@1.0.0"
   }
   ```

   Or install straight from GitHub without publishing: `"hashu-baileys": "github:YOUR_GITHUB_USERNAME/hashu-baileys"`.

Keep the `LICENSE` file as it is. Baileys is MIT licensed and the copyright notice has to stay with copies of the code.


## Publish from GitHub (Actions), works from a phone

1. github.com -> New repository -> `hashu-baileys`, Public.
2. Add file -> Create new file, name `.github/workflows/hashu.yml`, paste the content of `.github/workflows/publish.yml` from this project. Commit.
3. Add file -> Upload files, pick `hashu-baileys.zip`. Commit.
4. Actions tab -> Hashu -> Run workflow -> mode `unpack`. It unzips the project into the repo (it skips `.github`, GitHub does not allow Actions to change workflow files).
5. Open `package.json` on GitHub (pencil icon), replace `YOUR_GITHUB_USERNAME` (2 places). Commit.
6. npmjs.com -> Access Tokens -> Generate New Token -> Granular, read and write on `hashu-baileys`, allow it to bypass 2FA.
7. GitHub repo -> Settings -> Secrets and variables -> Actions -> New repository secret `NPM_TOKEN` = the token.
8. Raise the version in `package.json` if it was already published (a version cannot be published twice). Releases -> Draft a new release -> tag `v<version>` -> Publish release.
   Or Actions -> Hashu -> Run workflow -> `publish`, or `stage` for npm staged publishing (then approve on npmjs.com, Staged Packages tab).

The publish job also runs `scripts/audit-baileys-fork.cjs` and stops if it finds auto-follow malware patterns.
