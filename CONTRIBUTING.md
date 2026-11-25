# Contributing to @codmir/sdk

Thanks for your interest in contributing! Here's how to get started.

## Development Setup

```bash
git clone https://github.com/codmir-labs/sdk.git
cd sdk
npm install
npm run build
npm test
```

## Pull Requests

1. Fork the repo and create your branch from `main`
2. If you've added code, add tests
3. Ensure the test suite passes (`npm test`)
4. Ensure your code builds (`npm run build`)
5. Open a pull request

## Public words only

This repository is public, so every tracked file and file name holds public words only: no ticket key from a tracker,
no name of a private repository or service, no machine name, no chat link and no personal email address. Say in plain
words what a comment means; a link to a pull request of this repository (`#123`) is fine in `CHANGELOG.md` only.

`npm run check:words` finds them and CI runs it after lint. It prints `file:line: rule` (the rule's name, never the
word) and fails when there is a hit. A one-line exception goes on the line before it, with a reason:
`// public-words: allow <rule> <reason>`. The private names are kept as hashes in `scripts/check-public-words.mjs`;
`node scripts/check-public-words.mjs --hash <word>` prints the hash to add.

## Reporting Issues

Use [GitHub Issues](https://github.com/codmir-labs/sdk/issues) to report bugs. Include:

- SDK version (`npm ls @codmir/sdk`)
- Node.js version (`node -v`)
- Platform (Node, Browser, React Native, etc.)
- Steps to reproduce
- Expected vs actual behavior

## Code Style

- TypeScript strict mode
- No `any` types without justification
- Run `npm run lint` before committing

## License

By contributing, you agree that your contributions will be licensed under the Apache 2.0 License.
