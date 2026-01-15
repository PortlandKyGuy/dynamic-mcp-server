# Contributing

Thanks for contributing. This repo uses automated version bumps and changelog updates on PR merge.

## Release Bump Rules

Preferred (explicit): add one of these labels to the PR:
- `major`
- `minor`
- `patch`

If no label is present, the workflow falls back to PR title parsing:
- Title contains `breaking` -> major
- Title starts with `feat` -> minor
- Title starts with `fix` -> patch

If neither applies, the default is `patch`.

## PR Template (lightweight)

Use this structure when opening PRs:

```
## Summary
- 

## Testing
- 

## Release
- [ ] major
- [ ] minor
- [ ] patch
```
