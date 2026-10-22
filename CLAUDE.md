# SuperSplat contributor guidance

Read the workspace `AGENTS.md` first. This is a PlayCanvas/PCUI editor fork, not React.
[Operations](OPERATIONS.md) and [package.json](package.json) define the build workflow.

- Keep reconstruction/auth integration separate from upstream editing behavior.
- Register events in `src/main.ts`; single-owner event functions must not be duplicated.
- Serialize asynchronous editing/history work through the shared CommandQueue.
- Preserve Rollup/TypeScript engine alias alignment and the configured worker policy.
- Follow the existing ESLint configuration and check TypeScript nullability assumptions.
- Localize UI strings in every static locale and run `lint:locales`.
- Keep secrets server-side and session state within its current owner/lifetime.
- Use existing scripts/tests. Avoid task plans and descriptions that duplicate source.
