import * as fs from "fs";
import * as chalk from "chalk";
import * as path from "path";
import * as childProcess from "child_process";
import { coerce, compare, valid } from "semver";
import { fileDoesNotExistOrIsDirectory } from "./utils/file-utils";

const g2js = require("gradle-to-js/lib/parser");
const REACT_NATIVE_HERMES_DEFAULT_VERSION = "0.70.0";

export function isValidVersion(version: string): boolean {
  return !!valid(version) || /^\d+\.\d+$/.test(version);
}

export async function runHermesEmitBinaryCommand(
  bundleName: string,
  outputFolder: string,
  sourcemapOutput: string,
  extraHermesFlags: string[],
  gradleFile: string
): Promise<void> {
  const hermesArgs: string[] = [];

  Array.prototype.push.apply(hermesArgs, [
    "-emit-binary",
    "-out",
    path.join(outputFolder, bundleName + ".hbc"),
    path.join(outputFolder, bundleName),
    ...extraHermesFlags,
  ]);

  if (sourcemapOutput) {
    hermesArgs.push("-output-source-map");
  }

  console.log(chalk.cyan("Converting JS bundle to byte code via Hermes, running command:\n"));
  const hermesCommand = await getHermesCommand(gradleFile);
  const hermesProcess = childProcess.spawn(hermesCommand, hermesArgs);
  console.log(`${hermesCommand} ${hermesArgs.join(" ")}`);

  return new Promise<void>((resolve, reject) => {
    let hermesProcessError: Error = null;

    hermesProcess.stdout.on("data", (data: Buffer) => {
      console.log(data.toString().trim());
    });

    hermesProcess.stderr.on("data", (data: Buffer) => {
      console.error(data.toString().trim());
    });

    hermesProcess.on("error", (err: Error) => {
      hermesProcessError = err;
      reject(new Error(`Failed to run Hermes compiler "${hermesCommand}": ${err.message}`));
    });

    hermesProcess.on("close", (exitCode: number, signal: string) => {
      if (hermesProcessError) {
        return;
      }

      if (exitCode !== 0) {
        reject(new Error(`"hermes" command failed (exitCode=${exitCode}, signal=${signal}).`));
        return;
      }

      // Copy HBC bundle to overwrite JS bundle
      const source = path.join(outputFolder, bundleName + ".hbc");
      const destination = path.join(outputFolder, bundleName);
      fs.copyFile(source, destination, (err) => {
        if (err) {
          console.error(err);
          reject(new Error(`Copying file ${source} to ${destination} failed. "hermes" previously exited with code ${exitCode}.`));
          return;
        }

        fs.unlink(source, (err) => {
          if (err) {
            console.error(err);
            reject(err);
            return;
          }

          resolve(null as void);
        });
      });
    });
  }).then(() => {
    if (!sourcemapOutput) {
      // skip source map compose if source map is not enabled
      return;
    }

    const composeSourceMapsPath = getComposeSourceMapsPath();
    if (!composeSourceMapsPath) {
      throw new Error("react-native compose-source-maps.js scripts is not found");
    }

    const jsCompilerSourceMapFile = path.join(outputFolder, bundleName + ".hbc" + ".map");
    if (!fs.existsSync(jsCompilerSourceMapFile)) {
      throw new Error(`sourcemap file ${jsCompilerSourceMapFile} is not found`);
    }

    return new Promise((resolve, reject) => {
      const composeSourceMapsArgs = [composeSourceMapsPath, sourcemapOutput, jsCompilerSourceMapFile, "-o", sourcemapOutput];

      // https://github.com/facebook/react-native/blob/master/react.gradle#L211
      // https://github.com/facebook/react-native/blob/master/scripts/react-native-xcode.sh#L178
      // packager.sourcemap.map + hbc.sourcemap.map = sourcemap.map
      const composeSourceMapsProcess = childProcess.spawn("node", composeSourceMapsArgs);
      console.log(`${composeSourceMapsPath} ${composeSourceMapsArgs.join(" ")}`);

      composeSourceMapsProcess.stdout.on("data", (data: Buffer) => {
        console.log(data.toString().trim());
      });

      composeSourceMapsProcess.stderr.on("data", (data: Buffer) => {
        console.error(data.toString().trim());
      });

      composeSourceMapsProcess.on("close", (exitCode: number, signal: string) => {
        if (exitCode !== 0) {
          reject(new Error(`"compose-source-maps" command failed (exitCode=${exitCode}, signal=${signal}).`));
        }

        // Delete the HBC sourceMap, otherwise it will be included in 'code-push' bundle as well
        fs.unlink(jsCompilerSourceMapFile, (err) => {
          if (err) {
            console.error(err);
            reject(err);
          }

          resolve(null);
        });
      });
    });
  });
}

function parseBuildGradleFile(gradleFile: string) {
  let buildGradlePath: string = path.join("android", "app");
  if (gradleFile) {
    buildGradlePath = gradleFile;
  }
  if (fs.lstatSync(buildGradlePath).isDirectory()) {
    buildGradlePath = path.join(buildGradlePath, "build.gradle");
  }

  if (fileDoesNotExistOrIsDirectory(buildGradlePath)) {
    throw new Error(`Unable to find gradle file "${buildGradlePath}".`);
  }

  return g2js.parseFile(buildGradlePath).catch(() => {
    throw new Error(`Unable to parse the "${buildGradlePath}" file. Please ensure it is a well-formed Gradle file.`);
  });
}

async function getHermesCommandFromGradle(gradleFile: string): Promise<string> {
  const buildGradle: any = await parseBuildGradleFile(gradleFile);
  const hermesCommandProperty: any = Array.from(buildGradle["project.ext.react"] || []).find((prop: string) =>
    prop.trim().startsWith("hermesCommand:")
  );
  if (hermesCommandProperty) {
    return hermesCommandProperty.replace("hermesCommand:", "").trim().slice(1, -1);
  } else {
    return "";
  }
}

export async function getAndroidHermesEnabled(gradleFile: string): Promise<boolean> {
  const gradlePropertiesPath = path.join("android", "gradle.properties");
  if (fs.existsSync(gradlePropertiesPath)) {
    const gradlePropertiesContents = fs.readFileSync(gradlePropertiesPath).toString();
    const hermesEnabledMatch = gradlePropertiesContents.match(/^\s*hermesEnabled\s*=\s*(true|false)\s*$/im);
    if (hermesEnabledMatch) {
      return hermesEnabledMatch[1].toLowerCase() === "true";
    }
  }

  const reactNativeVersion = coerce(getReactNativeVersion());
  if (reactNativeVersion && compare(reactNativeVersion.version, REACT_NATIVE_HERMES_DEFAULT_VERSION) >= 0) {
    return true;
  }

  if (gradleFile || fs.existsSync(path.join("android", "app", "build.gradle"))) {
    const buildGradle: any = await parseBuildGradleFile(gradleFile);
    const legacyHermesEnabled = Array.from(buildGradle["project.ext.react"] || []).some((line: string) =>
      /^enableHermes\s{0,}:\s{0,}true/.test(line)
    );
    if (legacyHermesEnabled) {
      return true;
    }
  }

  return false;
}

export function getiOSHermesEnabled(podFile: string): boolean {
  let podPath = path.join("ios", "Podfile");
  if (podFile) {
    podPath = podFile;
  }
  if (fileDoesNotExistOrIsDirectory(podPath)) {
    if (podFile) {
      throw new Error(`Unable to find Podfile file "${podPath}".`);
    }

    const reactNativeVersion = coerce(getReactNativeVersion());
    return !!reactNativeVersion && compare(reactNativeVersion.version, REACT_NATIVE_HERMES_DEFAULT_VERSION) >= 0;
  }

  try {
    const podFileContents = fs.readFileSync(podPath).toString();
    if (/^[^#\n]*:?\bhermes_enabled\b\s*(=>|:)\s*false\b/im.test(podFileContents)) {
      return false;
    }

    if (/^[^#\n]*:?\bhermes_enabled\b\s*(=>|:)\s*true\b/im.test(podFileContents)) {
      return true;
    }

    const reactNativeVersion = coerce(getReactNativeVersion());
    return !!reactNativeVersion && compare(reactNativeVersion.version, REACT_NATIVE_HERMES_DEFAULT_VERSION) >= 0;
  } catch (error) {
    throw error;
  }
}

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

function getHermesOSExe(): string {
  const reactNativeVersion = coerce(getReactNativeVersion());
  const react63orAbove = !!reactNativeVersion && compare(reactNativeVersion.version, "0.63.0") !== -1;
  const hermesExecutableName = react63orAbove ? "hermesc" : "hermes";
  switch (process.platform) {
    case "win32":
      return hermesExecutableName + ".exe";
    default:
      return hermesExecutableName;
  }
}

async function getHermesCommand(gradleFile: string): Promise<string> {
  const fileExists = (file: string): boolean => {
    try {
      return fs.statSync(file).isFile();
    } catch (e) {
      return false;
    }
  };

  let buildGradlePath = gradleFile || path.join("android", "app", "build.gradle");
  if (fs.existsSync(buildGradlePath) && fs.lstatSync(buildGradlePath).isDirectory()) {
    buildGradlePath = path.join(buildGradlePath, "build.gradle");
  }

  if (fs.existsSync(buildGradlePath) && fs.readFileSync(buildGradlePath).toString().indexOf("hermesCommand") !== -1) {
    const gradleHermesCommand = await getHermesCommandFromGradle(gradleFile);
    if (gradleHermesCommand) {
      return path.join("android", "app", gradleHermesCommand.replace("%OS-BIN%", getHermesOSBin()));
    }
  }

  const hermesCompilerExe = process.platform === "win32" ? "hermesc.exe" : "hermesc";
  const hermesCompiler = path.join("node_modules", "hermes-compiler", "hermesc", getHermesOSBin(), hermesCompilerExe);
  if (fileExists(hermesCompiler)) {
    return hermesCompiler;
  }

  // Hermes is bundled with react-native since 0.69
  const bundledHermesEngine = path.join(getReactNativePackagePath(), "sdks", "hermesc", getHermesOSBin(), getHermesOSExe());
  if (fileExists(bundledHermesEngine)) {
    return bundledHermesEngine;
  }

  // assume if hermes-engine exists it should be used instead of hermesvm
  const hermesEngine = path.join("node_modules", "hermes-engine", getHermesOSBin(), getHermesOSExe());
  if (fileExists(hermesEngine)) {
    return hermesEngine;
  }
  return path.join("node_modules", "hermesvm", getHermesOSBin(), "hermes");
}

function getComposeSourceMapsPath(): string {
  // detect if compose-source-maps.js script exists
  const composeSourceMaps = path.join(getReactNativePackagePath(), "scripts", "compose-source-maps.js");
  if (fs.existsSync(composeSourceMaps)) {
    return composeSourceMaps;
  }
  return null;
}

function getReactNativePackagePath(): string {
  const result = childProcess.spawnSync("node", ["--print", "require.resolve('react-native/package.json')"]);
  const packagePath = path.dirname(result.stdout.toString().trim());
  if (result.status === 0 && directoryExistsSync(packagePath)) {
    return packagePath;
  }

  return path.join("node_modules", "react-native");
}

export function directoryExistsSync(dirname: string): boolean {
  try {
    return fs.statSync(dirname).isDirectory();
  } catch (err) {
    if (err.code !== "ENOENT") {
      throw err;
    }
  }
  return false;
}

export function getReactNativeVersion(): string {
  let packageJsonFilename;
  let projectPackageJson;
  try {
    packageJsonFilename = path.join(process.cwd(), "package.json");
    projectPackageJson = JSON.parse(fs.readFileSync(packageJsonFilename, "utf-8"));
  } catch (error) {
    throw new Error(
      `Unable to find or read "package.json" in the CWD. The "release-react" command must be executed in a React Native project folder.`
    );
  }

  const projectName: string = projectPackageJson.name;
  if (!projectName) {
    throw new Error(`The "package.json" file in the CWD does not have the "name" field set.`);
  }

  try {
    const reactNativePackageJsonFilename = path.join(getReactNativePackagePath(), "package.json");
    const reactNativePackageJson = JSON.parse(fs.readFileSync(reactNativePackageJsonFilename, "utf-8"));
    if (reactNativePackageJson.version) {
      return reactNativePackageJson.version;
    }
  } catch (error) {
    // Fall back to the app package.json dependency range below.
  }

  return (
    (projectPackageJson.dependencies && projectPackageJson.dependencies["react-native"]) ||
    (projectPackageJson.devDependencies && projectPackageJson.devDependencies["react-native"])
  );
}
