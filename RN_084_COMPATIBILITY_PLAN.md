# React Native 0.84 Compatibility Plan

## Goal

Improve `release-react` compatibility with React Native 0.84 projects, especially projects that rely on Hermes being enabled by default and on the modern `hermes-compiler` package layout.

Reference PR: https://github.com/CodePushNext/code-push-server/pull/12

## Current Findings

- The local repository already has some related changes:
  - `npm test` support is present.
  - `release-react` already prefers `node_modules/react-native/cli.js` when `local-cli/cli.js` is absent.
  - `getReactNativePackagePath()` already tries `require.resolve("react-native/package.json")`.
  - `getHermesCommand()` already checks the React Native bundled Hermes path before older fallbacks.
- The current Hermes detection still misses important React Native 0.84 behavior:
  - Android detection only checks legacy `project.ext.react.enableHermes: true`.
  - It does not read `android/gradle.properties`.
  - It does not treat React Native 0.84+ as Hermes-enabled by default when no explicit opt-out exists.
  - iOS detection only accepts explicit `hermes_enabled: true` / `:hermes_enabled => true`.
- `runHermesEmitBinaryCommand()` currently forwards `CODE_PUSH_NODE_ARGS` to the Hermes compiler. That is risky for modern native Hermes binaries because Node-specific flags such as `--max-old-space-size` are not valid Hermes compiler flags.

## Design Principles

- Keep the change narrow and local to the existing flow.
- Prefer editing the existing functions over introducing new abstractions.
- Do not add generic helpers such as `isVersionAtLeast`, `reactNativeVersionDefaultsToHermes`, or `readGradleProperties` unless duplication later proves they are needed.
- Use a single constant for the version threshold:
  - `REACT_NATIVE_HERMES_DEFAULT_VERSION = "0.84.0"`
- Treat `hermesV1Enabled=false` carefully:
  - It opts out of Hermes V1, not necessarily Hermes itself.
  - Do not use it as a signal to skip Hermes bytecode compilation.

## Implementation Plan

1. Add a React Native Hermes default version constant in `script/react-native-utils.ts`.

2. Update `getReactNativeVersion()`.
   - First try to read the installed version from `node_modules/react-native/package.json`.
   - Fall back to the existing app `package.json` dependency/devDependency value.
   - Keep the existing error behavior for missing or invalid app `package.json`.

3. Update `getAndroidHermesEnabled()`.
   - Check `android/gradle.properties` when present.
   - If `hermesEnabled=false`, return `false`.
   - If `hermesEnabled=true`, return `true`.
   - Keep the existing legacy `project.ext.react.enableHermes: true` check.
   - If no explicit setting exists, compare the React Native version inline:
     - coerce the version with `semver.coerce`
     - return `true` when it is `>= 0.84.0`
     - otherwise return `false`

4. Update `getiOSHermesEnabled()`.
   - If a user explicitly passes `--podFile` and the file is missing, keep the current error.
   - If the default `ios/Podfile` is absent, allow version-based fallback.
   - If Podfile explicitly sets Hermes false, return `false`.
   - If Podfile explicitly sets Hermes true, return `true`.
   - If no explicit setting exists, use the same inline React Native `>= 0.84.0` fallback.

5. Update `getHermesCommand()`.
   - Add the modern package path as the first candidate:
     - `node_modules/hermes-compiler/hermesc/<os-bin>/hermesc`
   - Then keep the existing React Native bundled Hermes path:
     - `node_modules/react-native/sdks/hermesc/<os-bin>/hermesc`
   - Keep existing fallback order after that:
     - Gradle `hermesCommand`
     - `node_modules/hermes-engine/<os-bin>/<exe>`
     - `node_modules/hermesvm/<os-bin>/hermes`
   - A simple ordered list of candidates is enough. No resolver class or provider abstraction.

6. Update `runHermesEmitBinaryCommand()`.
   - Remove `CODE_PUSH_NODE_ARGS` from Hermes compiler arguments.
   - Leave `CODE_PUSH_NODE_ARGS` behavior unchanged for the React Native bundle command, where it is passed to `node`.
   - Add an `error` event handler for the Hermes process if needed, so missing compiler errors are clearer.

7. Add focused tests in a new `test/react-native-utils.ts`.
   - Use temporary project directories instead of replacing the existing CLI fixture wholesale.
   - Cover:
     - React Native 0.84 with no Android Hermes config defaults to `true`.
     - `hermesEnabled=false` returns `false`.
     - `hermesEnabled=true` returns `true`.
     - Legacy `project.ext.react.enableHermes: true` still returns `true`.
     - React Native below 0.84 with no explicit config returns `false`.
     - iOS Podfile explicit false/true works.
     - iOS React Native 0.84 with no explicit Podfile Hermes setting defaults to `true`.
     - `hermes-compiler` is preferred over the React Native bundled Hermes path.
     - Hermes compiler spawn args do not include `CODE_PUSH_NODE_ARGS`.

8. Update README documentation.
   - Clarify that `--useHermes` forces Hermes compilation.
   - Clarify that automatic detection now includes:
     - Android `gradle.properties`
     - legacy Android `project.ext.react.enableHermes`
     - iOS Podfile explicit settings
     - React Native 0.84+ default Hermes behavior

## Verification

Run:

```sh
npm run build
npm test
```

Additional smoke testing should be done in a real React Native 0.84 project under Node.js 22.11 or newer, because React Native 0.84 requires Node 22.11+.

## Risks And Notes

- `gradle-to-js` can parse simple modern `build.gradle` files, but Hermes detection should not depend on Gradle parsing for React Native 0.84 defaults.
- Dependency specs such as `^0.84.1`, `latest`, git URLs, or workspace protocol values are less reliable than the installed React Native package version, so installed package version should be preferred.
- `hermesV1Enabled=false` should not be treated as a general Hermes opt-out.
- Avoid broad fixture upgrades unless necessary. Isolated tests should reduce churn and make failures easier to diagnose.
