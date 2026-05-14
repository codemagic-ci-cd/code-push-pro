// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import * as assert from "assert";
import * as childProcess from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as sinon from "sinon";
import { getAndroidHermesEnabled, getiOSHermesEnabled, runHermesEmitBinaryCommand } from "../script/react-native-utils";

function getHermesOSBin(): string {
  switch (process.platform) {
    case "win32":
      return "win64-bin";
    case "darwin":
      return "osx-bin";
    case "freebsd":
    case "linux":
    case "sunos":
    default:
      return "linux64-bin";
  }
}

function getHermesCompilerExe(): string {
  return process.platform === "win32" ? "hermesc.exe" : "hermesc";
}

function writeFile(filePath: string, contents: string = ""): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, contents);
}

function writeReactNativeProject(projectPath: string, reactNativeVersion: string): void {
  writeFile(
    path.join(projectPath, "package.json"),
    JSON.stringify({
      name: "TestApp",
      dependencies: {
        "react-native": reactNativeVersion,
      },
    })
  );

  writeFile(
    path.join(projectPath, "node_modules", "react-native", "package.json"),
    JSON.stringify({
      name: "react-native",
      version: reactNativeVersion,
    })
  );

  writeFile(
    path.join(projectPath, "android", "app", "build.gradle"),
    `
apply plugin: "com.android.application"

android {
    defaultConfig {
        versionName "1.0.0"
    }
}
`
  );
}

describe("react-native-utils", () => {
  let originalCwd: string;
  let originalCodePushNodeArgs: string;
  let projectPath: string;
  let sandbox: sinon.SinonSandbox;

  beforeEach((): void => {
    originalCwd = process.cwd();
    originalCodePushNodeArgs = process.env.CODE_PUSH_NODE_ARGS;
    projectPath = fs.mkdtempSync(path.join(os.tmpdir(), "code-push-rn-utils-"));
    sandbox = sinon.createSandbox();
    process.chdir(projectPath);
  });

  afterEach((): void => {
    process.chdir(originalCwd);
    if (originalCodePushNodeArgs === undefined) {
      delete process.env.CODE_PUSH_NODE_ARGS;
    } else {
      process.env.CODE_PUSH_NODE_ARGS = originalCodePushNodeArgs;
    }

    sandbox.restore();
    fs.rmSync(projectPath, { recursive: true, force: true });
  });

  it("treats Android React Native 0.84 projects without explicit Hermes config as Hermes-enabled", async (): Promise<void> => {
    writeReactNativeProject(projectPath, "0.84.1");

    assert.equal(await getAndroidHermesEnabled(null), true);
  });

  it("treats Android React Native 0.70 projects without explicit Hermes config as Hermes-enabled", async (): Promise<void> => {
    writeReactNativeProject(projectPath, "0.70.0");

    assert.equal(await getAndroidHermesEnabled(null), true);
  });

  it("honors Android hermesEnabled=false in gradle.properties", async (): Promise<void> => {
    writeReactNativeProject(projectPath, "0.84.1");
    writeFile(path.join(projectPath, "android", "gradle.properties"), "hermesEnabled=false");

    assert.equal(await getAndroidHermesEnabled(null), false);
  });

  it("keeps Android Hermes enabled when React Native 0.84 opts out of Hermes V1 only", async (): Promise<void> => {
    writeReactNativeProject(projectPath, "0.84.1");
    writeFile(path.join(projectPath, "android", "gradle.properties"), "hermesV1Enabled=false");

    assert.equal(await getAndroidHermesEnabled(null), true);
  });

  it("honors Android hermesEnabled=true in gradle.properties", async (): Promise<void> => {
    writeReactNativeProject(projectPath, "0.83.0");
    writeFile(path.join(projectPath, "android", "gradle.properties"), "hermesEnabled=true");

    assert.equal(await getAndroidHermesEnabled(null), true);
  });

  it("keeps legacy Android project.ext.react.enableHermes detection", async (): Promise<void> => {
    writeReactNativeProject(projectPath, "0.69.0");
    writeFile(
      path.join(projectPath, "android", "app", "build.gradle"),
      `
project.ext.react = [
    enableHermes: true,
]

android {
    defaultConfig {
        versionName "1.0.0"
    }
}
`
    );

    assert.equal(await getAndroidHermesEnabled(null), true);
  });

  it("honors legacy Android enableHermes=false before the React Native 0.70 default", async (): Promise<void> => {
    writeReactNativeProject(projectPath, "0.84.1");
    writeFile(
      path.join(projectPath, "android", "app", "build.gradle"),
      `
project.ext.react = [
    enableHermes: false,
]

android {
    defaultConfig {
        versionName "1.0.0"
    }
}
`
    );

    assert.equal(await getAndroidHermesEnabled(null), false);
  });

  it("leaves Android React Native versions below 0.70 disabled without explicit Hermes config", async (): Promise<void> => {
    writeReactNativeProject(projectPath, "0.69.0");

    assert.equal(await getAndroidHermesEnabled(null), false);
  });

  it("uses React Native 0.70 default Hermes without parsing complex Android Gradle files", async (): Promise<void> => {
    writeReactNativeProject(projectPath, "0.70.0");
    writeFile(path.join(projectPath, "android", "app", "build.gradle"), "not a parseable Gradle file [");

    assert.equal(await getAndroidHermesEnabled(null), true);
  });

  it("honors iOS Podfile hermes_enabled=false", (): void => {
    writeReactNativeProject(projectPath, "0.84.1");
    writeFile(path.join(projectPath, "ios", "Podfile"), `use_react_native!(:path => "../node_modules/react-native", :hermes_enabled => false)`);

    assert.equal(getiOSHermesEnabled(null), false);
  });

  it("honors iOS Podfile hermes_enabled=true", (): void => {
    writeReactNativeProject(projectPath, "0.83.0");
    writeFile(path.join(projectPath, "ios", "Podfile"), `use_react_native!(:path => "../node_modules/react-native", hermes_enabled: true)`);

    assert.equal(getiOSHermesEnabled(null), true);
  });

  it("treats iOS React Native 0.84 projects without explicit Hermes config as Hermes-enabled", (): void => {
    writeReactNativeProject(projectPath, "0.84.1");
    writeFile(path.join(projectPath, "ios", "Podfile"), `use_react_native!(:path => "../node_modules/react-native")`);

    assert.equal(getiOSHermesEnabled(null), true);
  });

  it("treats iOS React Native 0.70 projects without explicit Hermes config as Hermes-enabled", (): void => {
    writeReactNativeProject(projectPath, "0.70.0");
    writeFile(path.join(projectPath, "ios", "Podfile"), `use_react_native!(:path => "../node_modules/react-native")`);

    assert.equal(getiOSHermesEnabled(null), true);
  });

  it("leaves iOS React Native versions below 0.70 disabled without explicit Hermes config", (): void => {
    writeReactNativeProject(projectPath, "0.69.0");
    writeFile(path.join(projectPath, "ios", "Podfile"), `use_react_native!(:path => "../node_modules/react-native")`);

    assert.equal(getiOSHermesEnabled(null), false);
  });

  it("prefers hermes-compiler and does not pass CODE_PUSH_NODE_ARGS to Hermes", async (): Promise<void> => {
    writeReactNativeProject(projectPath, "0.84.1");
    process.env.CODE_PUSH_NODE_ARGS = "  --max-old-space-size=8192  ";

    const hermesCompilerPath = path.join(
      "node_modules",
      "hermes-compiler",
      "hermesc",
      getHermesOSBin(),
      getHermesCompilerExe()
    );
    writeFile(path.join(projectPath, "node_modules", "hermes-compiler", "package.json"), JSON.stringify({ name: "hermes-compiler" }));
    writeFile(path.join(projectPath, hermesCompilerPath));
    writeFile(path.join(projectPath, "node_modules", "react-native", "sdks", "hermesc", getHermesOSBin(), getHermesCompilerExe()));

    const outputFolder = path.join(projectPath, "CodePush");
    const bundleName = "index.android.bundle";
    writeFile(path.join(outputFolder, bundleName), "plain js bundle");

    const spawn = sandbox.stub(childProcess, "spawn").callsFake((command: string, args: string[]): any => {
      const outputIndex = args.indexOf("-out");
      fs.writeFileSync(args[outputIndex + 1], "compiled hermes bundle");

      return {
        stdout: { on: () => {} },
        stderr: { on: () => {} },
        on: (event: string, callback: Function) => {
          if (event === "close") {
            callback(0, null);
          }
        },
      };
    });

    await runHermesEmitBinaryCommand(bundleName, outputFolder, null, [], null);

    sinon.assert.calledOnce(spawn);
    assert.equal(spawn.args[0][0], hermesCompilerPath);
    assert.deepEqual(spawn.args[0][1], [
      "-emit-binary",
      "-out",
      path.join(outputFolder, `${bundleName}.hbc`),
      path.join(outputFolder, bundleName),
    ]);
    assert.equal(fs.readFileSync(path.join(outputFolder, bundleName), "utf-8"), "compiled hermes bundle");
  });

  it("uses explicit Gradle hermesCommand before package autodetection", async (): Promise<void> => {
    writeReactNativeProject(projectPath, "0.84.1");
    const customHermesCommand = path.join("..", "..", "custom-hermes", "%OS-BIN%", getHermesCompilerExe());
    writeFile(
      path.join(projectPath, "android", "app", "build.gradle"),
      `
project.ext.react = [
    hermesCommand: "${customHermesCommand}",
]
`
    );
    writeFile(
      path.join(projectPath, "node_modules", "hermes-compiler", "hermesc", getHermesOSBin(), getHermesCompilerExe()),
      ""
    );

    const outputFolder = path.join(projectPath, "CodePush");
    const bundleName = "index.android.bundle";
    writeFile(path.join(outputFolder, bundleName), "plain js bundle");

    const spawn = sandbox.stub(childProcess, "spawn").callsFake((command: string, args: string[]): any => {
      const outputIndex = args.indexOf("-out");
      fs.writeFileSync(args[outputIndex + 1], "compiled hermes bundle");

      return {
        stdout: { on: () => {} },
        stderr: { on: () => {} },
        on: (event: string, callback: Function) => {
          if (event === "close") {
            callback(0, null);
          }
        },
      };
    });

    await runHermesEmitBinaryCommand(bundleName, outputFolder, null, [], null);

    sinon.assert.calledOnce(spawn);
    assert.equal(spawn.args[0][0], path.join("android", "app", customHermesCommand.replace("%OS-BIN%", getHermesOSBin())));
  });
});
