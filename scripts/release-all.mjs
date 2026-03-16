import { execSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const root = path.resolve(__dirname, "..");

const sharedPath = path.join(root, "packages", "shared", "package.json");
const dingtalkPath = path.join(root, "extensions", "dingtalk", "package.json");
const feishuPath = path.join(root, "extensions", "feishu", "package.json");
const wecomPath = path.join(root, "extensions", "wecom", "package.json");
const wecomAppPath = path.join(root, "extensions", "wecom-app", "package.json");
const wecomKfPath = path.join(root, "extensions", "wecom-kf", "package.json");
const qqbotPath = path.join(root, "extensions", "qqbot", "package.json");
const channelsPath = path.join(root, "packages", "channels", "package.json");
const channelIds = ["dingtalk", "feishu-china", "wecom", "wecom-app", "wecom-kf", "qqbot"];

function printUsage() {
  console.log(`
Usage:
  node scripts/release-all.mjs
  node scripts/release-all.mjs <channel>
  node scripts/release-all.mjs --version <x.y.z|x.y.z.w> [--tag <latest|next>]
  node scripts/release-all.mjs --channel <channel> [--with-shared] [--tag <latest|next>]
  node scripts/release-all.mjs --channel <channel> --version <x.y.z|x.y.z.w> [--with-shared] [--tag <latest|next>]

Channels:
  ${channelIds.join(", ")}

Options:
  --with-shared    Also bump & publish @openclaw-china/shared
  --version        Use a fixed version instead of auto patch bump
  --tag            npm dist-tag to publish with (latest|next, default: latest)
                   Note: x.y.z.w will be normalized to npm semver x.y.z-w
`);
}

function parseArgs(args) {
  let channel = null;
  let withShared = false;
  let version = null;
  let tag = "latest";

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--help" || arg === "-h") {
      printUsage();
      process.exit(0);
    }
    if (arg === "--with-shared") {
      withShared = true;
      continue;
    }
    if (arg === "--version" || arg === "-v") {
      const next = args[i + 1];
      if (!next) {
        throw new Error("Missing version after --version");
      }
      version = next;
      i += 1;
      continue;
    }
    if (arg === "--channel" || arg === "-c") {
      const next = args[i + 1];
      if (!next) {
        throw new Error("Missing channel after --channel");
      }
      channel = next;
      i += 1;
      continue;
    }
    if (arg === "--tag" || arg === "-t") {
      const next = args[i + 1];
      if (!next) {
        throw new Error("Missing tag after --tag");
      }
      if (next !== "latest" && next !== "next") {
        throw new Error(`Invalid tag: ${next}. Use "latest" or "next".`);
      }
      tag = next;
      i += 1;
      continue;
    }
    if (!arg.startsWith("-") && !channel) {
      channel = arg;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  return {
    mode: channel ? "channel" : "all",
    channel,
    withShared,
    version,
    tag,
  };
}

function readJson(p) {
  return JSON.parse(readFileSync(p, "utf-8"));
}

function writeJson(p, data) {
  writeFileSync(p, JSON.stringify(data, null, 2) + "\n", "utf-8");
}

function bumpPatch(version) {
  const parsed = parseVersion(version);
  if (parsed.hasRevision) {
    return `${parsed.major}.${parsed.minor}.${parsed.patch}-${parsed.revision + 1}`;
  }
  return `${parsed.major}.${parsed.minor}.${parsed.patch + 1}`;
}

function run(cmd, cwd = root) {
  execSync(cmd, { stdio: "inherit", cwd });
}

function publishPackage(pkgDir, tag) {
  const pkg = readJson(path.join(pkgDir, "package.json"));
  const parsed = parseVersion(pkg.version);
  if (parsed.hasRevision && tag === "latest") {
    throw new Error(
      `Refusing to publish prerelease version ${pkg.version} of ${pkg.name} with tag "latest". ` +
        'Use "--tag next" or publish a stable x.y.z version.'
    );
  }
  run(`npm publish --access public --tag ${tag}`, pkgDir);
}

function parseVersion(version) {
  const match = version.match(/^(\d+)\.(\d+)\.(\d+)(?:([.-])([0-9]+))?$/);
  if (!match) {
    throw new Error(`Invalid version: ${version}`);
  }
  const [, majorRaw, minorRaw, patchRaw, separatorRaw, revisionRaw] = match;
  const major = Number(majorRaw);
  const minor = Number(minorRaw);
  const patch = Number(patchRaw);
  const revision = revisionRaw === undefined ? 0 : Number(revisionRaw);
  const hasRevision = separatorRaw !== undefined;
  return { major, minor, patch, revision, hasRevision };
}

function compareVersions(a, b) {
  if (a.major !== b.major) return a.major - b.major;
  if (a.minor !== b.minor) return a.minor - b.minor;
  if (a.patch !== b.patch) return a.patch - b.patch;
  if (a.hasRevision !== b.hasRevision) {
    // Stable releases sort after prereleases with the same major.minor.patch.
    return a.hasRevision ? -1 : 1;
  }
  return a.revision - b.revision;
}

function getLatestPublishedVersion(pkgName) {
  try {
    const result = execSync(`npm view ${pkgName} versions --json`, {
      cwd: root,
      stdio: ["ignore", "pipe", "pipe"],
    })
      .toString()
      .trim();
    if (!result) return null;
    const parsed = JSON.parse(result);
    const versions = Array.isArray(parsed) ? parsed : typeof parsed === "string" ? [parsed] : [];
    if (versions.length === 0) return null;
    let latest = null;
    let latestParsed = null;
    for (const version of versions) {
      let candidateParsed;
      try {
        candidateParsed = parseVersion(version);
      } catch {
        continue;
      }
      if (!latestParsed || compareVersions(candidateParsed, latestParsed) > 0) {
        latest = version;
        latestParsed = candidateParsed;
      }
    }
    return latest;
  } catch (error) {
    const stderr = error?.stderr?.toString?.() ?? "";
    if (stderr.includes("E404") || stderr.includes("Not found")) {
      return null;
    }
    throw error;
  }
}

function getNextVersion(pkgName, localVersion) {
  const latest = getLatestPublishedVersion(pkgName);
  if (!latest) {
    return bumpPatch(localVersion);
  }
  const latestParsed = parseVersion(latest);
  const localParsed = parseVersion(localVersion);
  const base = compareVersions(latestParsed, localParsed) >= 0 ? latest : localVersion;
  return bumpPatch(base);
}

function normalizeVersionInput(version) {
  if (typeof version !== "string") {
    throw new Error("Version must be a string");
  }
  const normalized = version.startsWith("v") ? version.slice(1) : version;
  const legacyFourSegment = normalized.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (!legacyFourSegment) {
    return normalized;
  }
  const [, majorRaw, minorRaw, patchRaw, revisionRaw] = legacyFourSegment;
  const major = Number(majorRaw);
  const minor = Number(minorRaw);
  const patch = Number(patchRaw);
  const revision = Number(revisionRaw);
  const semver = `${major}.${minor}.${patch}-${revision}`;
  console.warn(
    `[release-all] "${normalized}" is not npm semver, normalized to "${semver}" for publish.`
  );
  return semver;
}

function ensureVersionGreaterThanPublished(pkgName, version) {
  const latest = getLatestPublishedVersion(pkgName);
  if (!latest) {
    return;
  }
  const requestedParsed = parseVersion(version);
  const latestParsed = parseVersion(latest);
  if (compareVersions(requestedParsed, latestParsed) <= 0) {
    throw new Error(
      `Requested version ${version} for ${pkgName} must be greater than npm version ${latest}.`
    );
  }
}

function getReleaseVersion(pkgName, localVersion, fixedVersion) {
  if (fixedVersion) {
    ensureVersionGreaterThanPublished(pkgName, fixedVersion);
    return fixedVersion;
  }
  return getNextVersion(pkgName, localVersion);
}

const sharedPkg = readJson(sharedPath);
const dingtalkPkg = readJson(dingtalkPath);
const feishuPkg = readJson(feishuPath);
const wecomPkg = readJson(wecomPath);
const wecomAppPkg = readJson(wecomAppPath);
const wecomKfPkg = readJson(wecomKfPath);
const qqbotPkg = readJson(qqbotPath);
const channelsPkg = readJson(channelsPath);

const originalShared = readJson(sharedPath);
const originalDingtalk = readJson(dingtalkPath);
const originalFeishu = readJson(feishuPath);
const originalWecom = readJson(wecomPath);
const originalWecomApp = readJson(wecomAppPath);
const originalWecomKf = readJson(wecomKfPath);
const originalQqbot = readJson(qqbotPath);
const originalChannels = readJson(channelsPath);

try {
  const options = parseArgs(process.argv.slice(2));
  if (options.version) {
    options.version = normalizeVersionInput(options.version);
    parseVersion(options.version);
  }
  if (options.channel === "feishu") {
    options.channel = "feishu-china";
  }
  const channelMap = {
    dingtalk: { pkg: dingtalkPkg, path: dingtalkPath },
    "feishu-china": { pkg: feishuPkg, path: feishuPath },
    wecom: { pkg: wecomPkg, path: wecomPath },
    "wecom-app": { pkg: wecomAppPkg, path: wecomAppPath },
    "wecom-kf": { pkg: wecomKfPkg, path: wecomKfPath },
    qqbot: { pkg: qqbotPkg, path: qqbotPath },
  };

  if (options.mode === "all") {
    const nextShared = getReleaseVersion(sharedPkg.name, sharedPkg.version, options.version);
    const nextDingtalk = getReleaseVersion(
      dingtalkPkg.name,
      dingtalkPkg.version,
      options.version
    );
    const nextFeishu = getReleaseVersion(feishuPkg.name, feishuPkg.version, options.version);
    const nextWecom = getReleaseVersion(wecomPkg.name, wecomPkg.version, options.version);
    const nextWecomApp = getReleaseVersion(
      wecomAppPkg.name,
      wecomAppPkg.version,
      options.version
    );
    const nextWecomKf = getReleaseVersion(
      wecomKfPkg.name,
      wecomKfPkg.version,
      options.version
    );
    const nextQqbot = getReleaseVersion(qqbotPkg.name, qqbotPkg.version, options.version);
    const nextChannels = getReleaseVersion(
      channelsPkg.name,
      channelsPkg.version,
      options.version
    );

    sharedPkg.version = nextShared;
    sharedPkg.private = false;

    dingtalkPkg.version = nextDingtalk;
    dingtalkPkg.private = false;
    dingtalkPkg.dependencies = dingtalkPkg.dependencies ?? {};
    dingtalkPkg.dependencies["@openclaw-china/shared"] = nextShared;

    feishuPkg.version = nextFeishu;
    feishuPkg.private = false;
    feishuPkg.dependencies = feishuPkg.dependencies ?? {};
    feishuPkg.dependencies["@openclaw-china/shared"] = nextShared;

    wecomPkg.version = nextWecom;
    wecomPkg.private = false;
    wecomPkg.dependencies = wecomPkg.dependencies ?? {};
    wecomPkg.dependencies["@openclaw-china/shared"] = nextShared;

    wecomAppPkg.version = nextWecomApp;
    wecomAppPkg.private = false;
    wecomAppPkg.dependencies = wecomAppPkg.dependencies ?? {};
    wecomAppPkg.dependencies["@openclaw-china/shared"] = nextShared;

    wecomKfPkg.version = nextWecomKf;
    wecomKfPkg.private = false;
    wecomKfPkg.dependencies = wecomKfPkg.dependencies ?? {};
    wecomKfPkg.dependencies["@openclaw-china/shared"] = nextShared;

    qqbotPkg.version = nextQqbot;
    qqbotPkg.private = false;
    qqbotPkg.dependencies = qqbotPkg.dependencies ?? {};
    qqbotPkg.dependencies["@openclaw-china/shared"] = nextShared;

    channelsPkg.version = nextChannels;
    channelsPkg.dependencies = channelsPkg.dependencies ?? {};
    channelsPkg.dependencies["@openclaw-china/dingtalk"] = nextDingtalk;
    channelsPkg.dependencies["@openclaw-china/feishu-china"] = nextFeishu;
    channelsPkg.dependencies["@openclaw-china/wecom"] = nextWecom;
    channelsPkg.dependencies["@openclaw-china/wecom-app"] = nextWecomApp;
    channelsPkg.dependencies["@openclaw-china/wecom-kf"] = nextWecomKf;
    channelsPkg.dependencies["@openclaw-china/qqbot"] = nextQqbot;
    channelsPkg.dependencies["@openclaw-china/shared"] = nextShared;

    writeJson(sharedPath, sharedPkg);
    writeJson(dingtalkPath, dingtalkPkg);
    writeJson(feishuPath, feishuPkg);
    writeJson(wecomPath, wecomPkg);
    writeJson(wecomAppPath, wecomAppPkg);
    writeJson(wecomKfPath, wecomKfPkg);
    writeJson(qqbotPath, qqbotPkg);
    writeJson(channelsPath, channelsPkg);

    run("pnpm -F @openclaw-china/shared build");
    run("pnpm -F @openclaw-china/dingtalk build");
    run("pnpm -F @openclaw-china/feishu-china build");
    run("pnpm -F @openclaw-china/wecom build");
    run("pnpm -F @openclaw-china/wecom-app build");
    run("pnpm -F @openclaw-china/wecom-kf build");
    run("pnpm -F @openclaw-china/qqbot build");
    run("pnpm -F @openclaw-china/channels build");

    publishPackage(path.join(root, "packages", "shared"), options.tag);
    publishPackage(path.join(root, "extensions", "dingtalk"), options.tag);
    publishPackage(path.join(root, "extensions", "feishu"), options.tag);
    publishPackage(path.join(root, "extensions", "wecom"), options.tag);
    publishPackage(path.join(root, "extensions", "wecom-app"), options.tag);
    publishPackage(path.join(root, "extensions", "wecom-kf"), options.tag);
    publishPackage(path.join(root, "extensions", "qqbot"), options.tag);
    publishPackage(path.join(root, "packages", "channels"), options.tag);
  } else {
    if (!channelMap[options.channel]) {
      throw new Error(
        `Unknown channel "${options.channel}". Use one of: ${channelIds.join(", ")}.`
      );
    }

    const target = channelMap[options.channel];
    const targetPkg = target.pkg;
    const targetDir = path.dirname(target.path);

    const latestShared = getLatestPublishedVersion(sharedPkg.name);
    const sharedVersionToUse = options.withShared
      ? getReleaseVersion(sharedPkg.name, sharedPkg.version, options.version)
      : latestShared;

    if (!sharedVersionToUse) {
      throw new Error(
        `${sharedPkg.name} has not been published yet. Use --with-shared or run full release.`
      );
    }

    if (!options.withShared) {
      const localSharedParsed = parseVersion(sharedPkg.version);
      const latestSharedParsed = parseVersion(sharedVersionToUse);
      if (compareVersions(localSharedParsed, latestSharedParsed) > 0) {
        throw new Error(
          `Local ${sharedPkg.name} version (${sharedPkg.version}) is ahead of npm (${sharedVersionToUse}). ` +
            "Use --with-shared or run full release."
        );
      }
    }

    const nextTarget = getReleaseVersion(targetPkg.name, targetPkg.version, options.version);
    const nextChannels = getReleaseVersion(
      channelsPkg.name,
      channelsPkg.version,
      options.version
    );

    if (options.withShared) {
      sharedPkg.version = sharedVersionToUse;
      sharedPkg.private = false;
      writeJson(sharedPath, sharedPkg);
    }

    targetPkg.version = nextTarget;
    targetPkg.private = false;
    targetPkg.dependencies = targetPkg.dependencies ?? {};
    targetPkg.dependencies["@openclaw-china/shared"] = sharedVersionToUse;

    channelsPkg.version = nextChannels;
    channelsPkg.dependencies = channelsPkg.dependencies ?? {};
    channelsPkg.dependencies[targetPkg.name] = nextTarget;
    channelsPkg.dependencies["@openclaw-china/shared"] = sharedVersionToUse;

    writeJson(target.path, targetPkg);
    writeJson(channelsPath, channelsPkg);

    if (options.withShared) {
      run("pnpm -F @openclaw-china/shared build");
    }
    run(`pnpm -F ${targetPkg.name} build`);
    run("pnpm -F @openclaw-china/channels build");

    if (options.withShared) {
      publishPackage(path.join(root, "packages", "shared"), options.tag);
    }
    publishPackage(targetDir, options.tag);
    publishPackage(path.join(root, "packages", "channels"), options.tag);
  }
} finally {
  // Restore workspace dependencies for local development
  if (originalDingtalk.dependencies) {
    originalDingtalk.dependencies["@openclaw-china/shared"] =
      originalDingtalk.dependencies["@openclaw-china/shared"] ?? "workspace:*";
  }
  if (originalFeishu.dependencies) {
    originalFeishu.dependencies["@openclaw-china/shared"] =
      originalFeishu.dependencies["@openclaw-china/shared"] ?? "workspace:*";
  }
  if (originalWecom.dependencies) {
    originalWecom.dependencies["@openclaw-china/shared"] =
      originalWecom.dependencies["@openclaw-china/shared"] ?? "workspace:*";
  }
  if (originalWecomApp.dependencies) {
    originalWecomApp.dependencies["@openclaw-china/shared"] =
      originalWecomApp.dependencies["@openclaw-china/shared"] ?? "workspace:*";
  }
  if (originalWecomKf.dependencies) {
    originalWecomKf.dependencies["@openclaw-china/shared"] =
      originalWecomKf.dependencies["@openclaw-china/shared"] ?? "workspace:*";
  }
  if (originalQqbot.dependencies) {
    originalQqbot.dependencies["@openclaw-china/shared"] =
      originalQqbot.dependencies["@openclaw-china/shared"] ?? "workspace:*";
  }
  if (originalChannels.dependencies) {
    originalChannels.dependencies["@openclaw-china/dingtalk"] =
      originalChannels.dependencies["@openclaw-china/dingtalk"] ?? "workspace:*";
    originalChannels.dependencies["@openclaw-china/feishu-china"] =
      originalChannels.dependencies["@openclaw-china/feishu-china"] ?? "workspace:*";
    originalChannels.dependencies["@openclaw-china/wecom"] =
      originalChannels.dependencies["@openclaw-china/wecom"] ?? "workspace:*";
    originalChannels.dependencies["@openclaw-china/wecom-app"] =
      originalChannels.dependencies["@openclaw-china/wecom-app"] ?? "workspace:*";
    originalChannels.dependencies["@openclaw-china/wecom-kf"] =
      originalChannels.dependencies["@openclaw-china/wecom-kf"] ?? "workspace:*";
    originalChannels.dependencies["@openclaw-china/qqbot"] =
      originalChannels.dependencies["@openclaw-china/qqbot"] ?? "workspace:*";
  }

  writeJson(sharedPath, originalShared);
  writeJson(dingtalkPath, originalDingtalk);
  writeJson(feishuPath, originalFeishu);
  writeJson(wecomPath, originalWecom);
  writeJson(wecomAppPath, originalWecomApp);
  writeJson(wecomKfPath, originalWecomKf);
  writeJson(qqbotPath, originalQqbot);
  writeJson(channelsPath, originalChannels);
}
