# Changesets

Every change that users would notice gets a changeset: a short file saying how
the version should move and why. They accumulate here, and are collapsed into
one version bump and one changelog entry at release time.

```bash
bun run changeset   # describe your change (interactive)
```

Pre-1.0, breaking changes go in the **minor** slot — pick `minor` for anything
that changes the public API, `patch` for fixes and docs.

See [CONTRIBUTING.md](../CONTRIBUTING.md#releasing) for the release steps, and
[the changesets docs](https://github.com/changesets/changesets) for the format.
