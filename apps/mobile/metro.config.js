// CommonJS on purpose — Metro config is always require()d, even in an ESM package.
// Docs: https://docs.expo.dev/guides/monorepos/
const { getDefaultConfig } = require('expo/metro-config');

// Expo SDK 57's own defaults are already workspace-aware: getDefaultConfig detects the
// npm-workspaces root and sets watchFolders to [<root>/node_modules, packages/shared,
// apps/mobile, apps/api], nodeModulesPaths to [app, root], disableHierarchicalLookup
// false, and unstable_enablePackageExports true. Symlink following is unconditional in
// metro 0.84 (the unstable_enableSymlinks option no longer exists).
//
// Overriding watchFolders with the repo root was strictly worse — it made Metro crawl
// .git/, apps/api/dist/ and apps/api/var/storage/ (where the email worker writes PDFs
// at runtime). So this file deliberately adds nothing.
module.exports = getDefaultConfig(__dirname);
