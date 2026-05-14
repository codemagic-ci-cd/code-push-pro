# CLI Managed-First UX Plan

## Background

The current CLI still exposes several account-oriented commands in help output even though the Codemagic-managed CodePush model is centered around team-issued access keys.

The Slack discussion highlighted two concrete issues:

- `code-push help` shows commands that are not meaningful or not available in the managed flow, such as `collaborator`, `session`, and `link`.
- `code-push login` should authenticate with an access key by default, instead of starting a browser OAuth flow when `--access-key` is omitted.

The safest direction is to make the CLI managed-first without immediately deleting legacy or self-hosted command behavior.

## Goals

- Make `code-push login` the simplest managed authentication path.
- Default authentication to `https://codepush.pro`.
- Prompt for an access key when `code-push login` is run without an access key option.
- Hide misleading account/session/provider commands from primary help output.
- Keep existing command implementations available unless product policy explicitly confirms removal.
- Update docs so the main happy path is app, deployment, release, patch, promote, and rollback management.

## Non-Goals

- Do not remove implemented commands in the first patch.
- Do not break existing users who still call hidden commands directly.
- Do not redesign account, collaborator, or session server APIs.
- Do not introduce a new authentication mechanism beyond access-key login.

## Current Code Touchpoints

- `script/management-sdk.ts`
  - `AccountManager.SERVER_URL` currently defaults to `http://localhost:3000`.
- `script/command-executor.ts`
  - `login()` uses `--accessKey` when provided.
  - Plain `login` currently calls the external browser authentication flow.
  - `requestAccessKey()` already exists and can be reused for access-key prompting.
- `script/command-parser.ts`
  - Root help currently exposes account/provider/session commands.
  - `login --help` still describes access-key login as an alternative to username/password authentication.
- `README.md`
  - Authentication docs already mention Codemagic-provided access tokens, but still include session and access-key management flows in the main path.

## Phase 1: Managed Login UX

### Changes

- Change the default server URL to `https://codepush.pro`.
- Keep the existing positional server URL override for local, self-hosted, and test environments.
- Update `login()` so that:
  - `code-push login --access-key <key>` authenticates with the provided key.
  - `code-push login --accessKey <key>` remains supported for compatibility.
  - `code-push login --key <key>` remains supported for compatibility.
  - `code-push login` prompts for the access key.
  - plain `login` no longer launches browser OAuth.
- Store access-key login sessions with `preserveAccessKeyOnLogout: true`.
- Consider hiding typed access-key input in the prompt if supported cleanly by the existing prompt library.
- Reject empty access-key input with a clear error before constructing the SDK.

### Implementation Notes

- Prefer introducing a small helper such as `loginWithAccessKey(accessKey, serverUrl, preserveAccessKeyOnLogout)` so the explicit and prompted access-key paths share validation, authentication, and config serialization behavior.
- Keep `loginWithExternalAuthentication()` for `register` until runtime guardrails are explicitly approved.
- Define the login option as `access-key` with `key` as the visible alias. Yargs' default camel-case expansion still accepts `--accessKey`, while help output can show `--access-key` as the primary option.

### Acceptance Criteria

- `code-push login` prompts for an access key.
- `code-push login` does not open a browser.
- `code-push login --access-key <key>` still works.
- Existing `--accessKey` and `--key` aliases still work.
- A login without an explicit server URL targets `https://codepush.pro`.

## Phase 2: Help Output Cleanup

### Changes

- Hide misleading commands from root help while keeping them callable:
  - `collaborator`
  - `session`
  - `link`
  - `register`
- Consider also hiding `access-key` from root help because managed users receive access keys from Codemagic rather than creating their own as a normal first step.
- Mark `app transfer` as advanced or hide it from the `app` help surface if product policy agrees.
- Rewrite `login --help` examples around access-key authentication:
  - `code-push login`
  - `code-push login --access-key <accessKey>`

### Implementation Notes

- Yargs supports hidden commands by passing `false` as the command description. This keeps the command registered and directly callable, while removing it from parent help output.
- Direct help for a hidden command can still work, for example `code-push session --help`, which is useful for legacy users who already know the command.
- Consider setting the yargs script name to `code-push` so local verification through `node ./bin/script/cli.js --help` does not display `cli.js` in command examples.

### Acceptance Criteria

- `code-push --help` emphasizes managed release-management commands.
- Hidden commands remain executable by users who already know them.
- `code-push login --help` no longer suggests browser, username/password, or provider-based login as the default path.

## Phase 3: README Cleanup

### Changes

- Rewrite the getting-started flow around:
  - receiving a Codemagic team access token
  - logging in with `code-push login`
  - registering apps
  - managing deployments
  - releasing updates
- Remove `session ls` and `session rm` from the main authentication section.
- Move `access-key` management to an advanced or self-hosted section, or remove it from README if unsupported in managed CodePush.
- Document `code-push login <server_url>` only as an advanced local/self-hosted override.
- Avoid language that implies each CLI user must create and manage their own account/session/provider links.

### Acceptance Criteria

- The README primary path matches the managed CodePush product model.
- The first authentication command users see is `code-push login`.
- Advanced account/session/provider flows do not appear before the release-management workflow.

## Phase 4: Optional Runtime Guardrails

This phase should wait for explicit product-scope confirmation.

### Candidate Changes

- Reject `link` with a managed-friendly message.
- Reject `register` with a managed-friendly message.
- Adjust `whoami` wording to avoid provider-centric identity language.
- Keep a compatibility escape hatch only if self-hosted or legacy environments still need these flows.

### Acceptance Criteria

- Commands that cannot work in managed CodePush fail with clear guidance.
- The CLI does not send users into dead-end browser/provider flows.
- Any compatibility behavior is documented and intentional.

## Test Plan

- Run `npm run build`.
- Run `npm test` if the change touches command behavior.
- Manually verify:
  - `node ./bin/script/cli.js --help`
  - `node ./bin/script/cli.js login --help`
  - `node ./bin/script/cli.js login --access-key <testKey>` against a test or mocked server, if available.
  - `node ./bin/script/cli.js login <localServerUrl> --access-key <testKey>` still targets the explicit server URL.
- Add or update unit tests for:
  - parsing `--access-key`
  - preserving existing `--accessKey` compatibility
  - preserving existing `--key` compatibility
  - plain `login` taking the access-key prompt path instead of the browser OAuth path
  - empty prompted access-key input producing a clear error
  - hidden commands being omitted from parent help while remaining directly callable

## Risks

- Hidden commands may surprise legacy users who rely on help discovery.
- Changing the default server URL can affect local development workflows that assumed localhost.
- Changing the default server URL also affects existing cached sessions that do not include `customServerUrl`; their next command will use the new default. Codemagic users who followed the current docs likely have `customServerUrl` because the documented command passes `https://codepush.pro` explicitly.
- Changing plain `login` from browser authentication to access-key prompting can break users who rely on the inherited provider/browser login flow, but that flow is not part of the documented Codemagic CodePush setup.
- Changing plain `login` to preserve the supplied access key changes `logout` semantics only for users who previously used plain browser login. Existing documented `--access-key` login already preserves the access key on logout.
- Prompting for access keys may require test adjustments because prompt behavior is interactive.
- Runtime rejection of `link` or `register` could break self-hosted users, so that should be a later decision.

## Recommended First Patch

Implement a low-risk first patch with:

1. Default server URL set to `https://codepush.pro`.
2. Plain `code-push login` prompting for an access key.
3. `--access-key` documented as the canonical login option while keeping old aliases.
4. Root help hiding for `collaborator`, `session`, `link`, and `register`.
5. README authentication flow rewritten around `code-push login`.

This addresses the Slack feedback directly while avoiding destructive command removal.

## Simulation Review

Walking through the plan against the current code suggests the approach is sound, but the first patch should be slightly more precise than the original outline:

- `--access-key` parsing already works through yargs camel-case expansion, but help output currently presents `--accessKey`. The implementation should make `access-key` the declared option and keep `--accessKey` as compatibility behavior.
- The prompted login path should not reuse `loginWithExternalAuthentication()` directly, because that helper opens the browser and stores the resulting key with `preserveAccessKeyOnLogout: false`. A shared `loginWithAccessKey()` helper avoids accidental behavior drift.
- Hiding commands via yargs is low-risk: direct invocation remains available, so this is safer than command removal.
- Changing `AccountManager.SERVER_URL` is the highest-impact change. Keeping and documenting the explicit server URL override is important for local development and self-hosted users.
- Prompted access-key input is interactive, so tests will be easier if prompt collection is kept small and isolated. The existing `prompt` package supports hidden input with `hidden: true` and `replace: "*"`.
- The first implementation should avoid runtime rejection for `link` and `register`; hiding them from primary help is enough to resolve the immediate Slack complaint without deciding legacy policy.

## Breaking Change Review

### Official Codemagic Documentation Baseline

The current Codemagic React Native CodePush docs describe access-key authentication, not browser authentication:

- Setup: `code-push login "https://codepush.pro/" --access-key $ACCESS_TOKEN`
- Security and access: access to the CodePush server is controlled using access keys, used by developer machines and CI systems.
- CLI quick reference: `code-push login "https://codepush.pro" --accessKey $CODEPUSH_ACCESS_KEY`

Based on that documented Codemagic surface, browser/provider login is not a supported user-facing contract for Codemagic CodePush.

### Breaking For Documented Codemagic Usage

- Defaulting `code-push login` to `https://codepush.pro` is not breaking for documented Codemagic usage. It removes the need to pass the documented server URL explicitly.
- Prompting for an access key when `code-push login` is run without `--access-key` is not breaking for documented Codemagic usage, because plain browser login was not documented as a Codemagic path.
- Keeping `--access-key`, `--accessKey`, and `--key` means the documented setup and quick-reference commands remain valid.
- The proposed logout behavior matches documented access-key login semantics. Existing documented `--access-key` login already uses `preserveAccessKeyOnLogout: true`.

### Compatibility Risks Outside Documented Codemagic Usage

- Default server URL change: `AccountManager.SERVER_URL` is currently `http://localhost:3000`. Changing it to `https://codepush.pro` affects local development, tests, self-hosted users, and any cached login without `customServerUrl`.
- Plain `login` behavior change: `code-push login` and `code-push login <server_url>` currently start browser authentication. Users who discovered or depended on that inherited flow would see a behavior change.
- Provider/session-oriented commands such as `link`, `register`, and `session` may still matter for legacy or self-hosted scenarios, even though they are not part of the Codemagic managed path.

### Low-Risk Or Non-Breaking

- Hiding commands from root help is not runtime breaking if implemented with yargs hidden command descriptions. Existing direct invocations such as `code-push session ls` and `code-push collaborator ls` can keep working.
- Changing README ordering and examples is not runtime breaking.
- Declaring `--access-key` as the primary option is not breaking if `--accessKey` and `--key` remain accepted.
- Hiding access-key input in the prompt is not functionally breaking, though it changes terminal behavior.

### Mitigations

- Keep `code-push login <server_url> --access-key <key>` as an explicit override path and document it for local/self-hosted use.
- Consider an advanced compatibility flag, such as `code-push login --browser` or `code-push login --oauth`, only if self-hosted or legacy browser login is an intentional support target.
- Consider an environment variable override such as `CODE_PUSH_SERVER_URL` if local development needs a non-positional default. This would reduce friction for tests and self-hosted operators.
- Add release notes that call out the default URL and plain-login behavior changes explicitly, framed as aligning the CLI with Codemagic's documented access-key flow.
- Preserve direct invocation for hidden account/session/provider commands until a separate self-hosted/legacy policy decision is made.

### Recommendation

From the documented Codemagic CodePush perspective, the proposed first patch is not a breaking change. It makes the CLI match the documented access-key-only authentication model more closely.

There is still compatibility risk for inherited legacy/self-hosted behavior. The safest version of the first patch is therefore:

1. Keep all old commands executable.
2. Keep `--accessKey` and `--key` accepted.
3. Keep positional server URL override.
4. Do not reject `link` or `register` at runtime yet.
5. Do not add a browser-login compatibility flag unless legacy/self-hosted browser auth is explicitly in scope.
