# Releasing

For maintainers of this repository.

```powershell
npm run release -- patch             # or minor, major, or an exact version like 1.4.0
npm run release -- minor --dry-run   # shows the new version and the commits since the last tag, changes nothing
```

`scripts/release.js` checks that you're on an up-to-date `main` with a clean tree, runs the tests, bumps `package.json`, builds the browser extension into `dist/` as a check, commits, tags `vX.Y.Z` and pushes. Pushing the tag starts two workflows:

| Workflow | What it does |
|---|---|
| `docker.yml` | Runs the tests on Node 22 and 24, then publishes the image as `X.Y.Z`, `X.Y`, `X` and `sha-<commit>` (pushes to `main` publish `latest`) |
| `release.yml` | Checks the tag matches `package.json`, then creates the GitHub Release with generated notes, a `docker-compose.yml` pinned to that version, `.env.example`, and the browser extension built for that version (two zips, plus a signed Firefox `.xpi` when the `AMO_JWT_*` secrets are set; see [extension/README.md](../extension/README.md#build-and-release)). Tags with a suffix such as `v1.2.0-rc.1` are marked as pre-releases |

Pull requests run the tests and build the image without publishing it. The first time the image is published, GitHub creates the package as private: open it under your profile's Packages and set its visibility to public so `docker pull` works without logging in.
