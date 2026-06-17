# Changesets

This directory is managed by Changesets.

- Add a new markdown file here for each user-facing release change.
- Run `pnpm changeset` to author one.
- Run `pnpm version` to apply pending changesets locally.
- The GitHub release workflow turns merged changesets into a Version Packages PR,
  then publishes to npm from `main`.
