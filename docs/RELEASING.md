# Releasing

1. Update `version` in `package.json` **and** `src/version.mjs` (a test checks they match), and add a section to `CHANGELOG.md`.
2. `npm test` must pass locally; push and check the "test" workflow is green on all three OSes.
3. `npm publish --access public` (needs `npm login` as the package owner).
4. Tag and push: `git tag v<version> && git push origin v<version>`. The "release" workflow builds the standalone files and creates the GitHub Release.
5. Website: from `site/`, `vercel deploy --prod`.
