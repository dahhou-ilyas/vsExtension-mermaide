# Publishing to the Visual Studio Marketplace

This guide is for maintainers. It is not shipped in the extension package.

## 1. One-time setup

1. **Publisher.** Sign in at <https://marketplace.visualstudio.com/manage> with a Microsoft account and create a publisher. Its **ID** must be exactly the `publisher` field of `package.json` (currently `GeneratedFlowChart`); change one of the two if needed. The ID cannot be changed later.
2. **Personal Access Token.** In Azure DevOps (<https://dev.azure.com>, any organization) → *User settings* → *Personal access tokens* → *New token*:
   - Organization: **All accessible organizations**
   - Scopes: *Custom defined* → **Marketplace → Manage**
3. **GitHub secrets** (repository → *Settings* → *Secrets and variables* → *Actions*):
   - `AZURE_TOKEN`: the token above (required).
   - `OVSX_PAT`: an [Open VSX](https://open-vsx.org) token, to also publish for VSCodium, Cursor, Windsurf… (optional).

## 2. Before each release

1. Merge the work into the **default branch** of the GitHub repository (`master`). The Marketplace page shows the README images from the default branch (`media/…`), so they must be there.
2. Update `version` in `package.json` (and `package-lock.json`) and add a section to `CHANGELOG.md`.
3. Check the package locally:

   ```bash
   npm ci
   npm run lint
   npm run test:unit
   npx vsce ls --no-dependencies   # files that go into the package
   npm run vsix                    # builds flowchartgenerator-<version>.vsix
   ```

   Install the `.vsix` once to try it: *Extensions* view → `…` → *Install from VSIX…*.

## 3. Publish

**Automatic (recommended).** Create a tag `v<version>` on the default branch, then a **GitHub Release** from it. The *Release* workflow lints, tests, packages, publishes to the Marketplace (and Open VSX if `OVSX_PAT` is set) and attaches the `.vsix` to the release.

```bash
git tag -a v3.2.0 -m "Flowchart Generator 3.2.0"
git push origin v3.2.0
```

Pushing a tag alone publishes nothing: only publishing the GitHub Release does. The workflow can also be started by hand (*Actions* → *Release* → *Run workflow*).

**Manual.**

```bash
npx vsce login GeneratedFlowChart   # paste the token
npx vsce publish --no-dependencies
```

The extension appears at `https://marketplace.visualstudio.com/items?itemName=GeneratedFlowChart.flowchartgenerator` after a few minutes (Microsoft scans every new version).

## 4. After publishing

- Check the Marketplace page: icon, banner, README images, changelog tab.
- The badges at the top of the README start working once the extension is public.
- To withdraw a broken version, publish a fixed one with a higher version number (`npx vsce unpublish` removes the whole extension).
