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
