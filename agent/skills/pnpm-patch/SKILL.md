---
name: pnpm-patch
description: "Create or update a pnpm patch that changes behavior of an dependency in the current workspace. Use when encoutering an issue in a dependency."
---

# pnpm patch

Patch an installed dependency to fix problems in the current workspace.

## Diverge at the smallest stable interface

The goal is to make the patched dependency diverge in the smallest possible unit of code.

Measure this by the behavior the patch takes ownership of, not by line count.

Bad — replaces the function's execution path:

```js
  function tool(options) {
+   if (options.router) return options.router.tool(options);
    // existing implementation
  }
```

Better — changes only the operation that must behave differently:

```js
- child = spawn(binary, ...);
+ child = (options.router?.spawn ?? spawn)(binary, ...);
```

Prefer changing existing argument, condition, callback, or call site.

When changing a call site, prefer changing a stable interface, like the case with `spawn`. Implement the compatibility logic outside the dependency if the interface can't be provided directly.

Do not copy or reimplement the surrounding function, module, or tool. Copies diverge from future dependency changes even when the patch itself is textually small.

The patch has exactly one consumer — this workspace — and is never upstreamed. Do not add compatibility layers, reusable interfaces, or speculative maintenance work.

## Find where the behavior is decided

Treat the package named by the user as a starting hypothesis.

Trace the path until you find the narrowest point where the unwanted behavior becomes fixed. This may be inside a different installed package.

Use evidence from:

- runtime call flow or stack
- logs around when the issue occurred
- imports and package entry points
- helper-process paths
- generated or transformed output

Before editing, identify:

1. The exact installed package and version.
2. The shipped file that executes during the workspace's usage.
3. The existing expression or call where the behavior is decided.
4. The smallest change at that point.

Inspect `package.json`, including `exports`, `main`, `module`, and `bin`. Do not assume the relevant code is in `src/` or in the package's original structure.

## Extract and edit

Run pnpm state-changing commands using `host_bash`:

```bash
pnpm patch <package>@<exact-version> --edit-dir <workspace>/.pnpm-patch-<package>
```

The edit directory must be inside the workspace so it is visible in the VM. Edit the extracted package there. When finished, run the `pnpm patch-commit` command printed by `pnpm patch` on the host.

Edit only shipped files that the workspace executes, normally under `dist/`, `lib/`, or `build/`, or files referenced by the package entry points. When the workspace uses multiple equivalent shipped variants, apply the same minimal edit to each relevant variant.

Do not edit source files, tests, documentation, source maps, or declarations unless they are themselves executed artifacts.

Do not run the dependency's formatter, linter, build, or test suite. Its development environment is not present, and rebuilding can overwrite the shipped-file edit.

## Verify

After committing the patch:

1. Inspect the generated patch and confirm it contains only the intended edit.
2. Validate through the smallest representative workspace invocation.
3. Remove the disposable `.pnpm-patch-<package>` directory.
