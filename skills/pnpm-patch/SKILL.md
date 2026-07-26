---
name: pnpm-patch
description: "Create or update pnpm dependency patches for the current workspace. Use when changing installed package runtime behavior with pnpm patch."
---

# pnpm patch

Patch the dependency used by the current workspace. Optimize only for this workspace and its concrete problem; do not add compatibility layers, reusable interfaces, or speculative maintenance work.

## Constraints

- Run `pnpm install`, `pnpm patch`, and `pnpm patch-commit` on the host with `host_bash`. They usually do not work correctly in the VM.
- Give `pnpm patch` an edit directory inside the current workspace so the extracted package is visible in the VM. Use a disposable directory such as `.pnpm-patch-<package>`.
- Edit only shipped runtime files, normally `dist/`, `lib/`, `build/`, or the exact files referenced by the package's `exports`, `main`, or `bin` fields. Do not edit `src/`, tests, documentation, source maps, or type declarations unless one of them is itself the runtime artifact that must change.
- Do not run the dependency's formatter, linter, build, or test suite. Its development environment is not present, and rebuilding can overwrite the runtime-only edit.
- Do not manually copy package code or create a replacement implementation. Keep the patch as a small change to the existing execution path. Duplicated code can diverge when the dependency changes.

## Workflow

1. Identify the exact installed package version and the runtime file that executes. Inspect the dependency's `package.json`, entry points, and call path rather than assuming its source layout.
2. Before editing, state the smallest behavioral change that solves the workspace's concrete problem. Prefer changing an argument, path, condition, or existing call site over adding a wrapper, helper, duplicate implementation, or generalized abstraction.
3. From the workspace root on the host, extract the package into a workspace-relative directory:

   ```bash
   pnpm patch <package>@<exact-version> --edit-dir <workspace>/.pnpm-patch-<package>
   ```

   If dependencies must first be installed, run `pnpm install` on the host.
4. In the VM, inspect and edit the corresponding directory under the mounted workspace (commonly `/workspace/.pnpm-patch-<package>`).
5. Commit the extracted directory on the host following the command prompted in the result of `pnpm patch`.
6. Inspect the resulting patch file and the workspace manifest or lockfile changes. Verify the patch contains only the minimal edit and that the workspace references it.
7. Validate through the current workspace's relevant behavior or a focused invocation. Do not lint, format, build, or broadly test the patched dependency.
8. After the patch is committed and verified, remove the disposable `.pnpm-patch-<package>` directory.

## Editing principle

Change the existing code at the point where behavior must differ. For example, when a dependency launches a helper with the wrong environment, path, or arguments, alter that existing launch call. Do not add another copy of the launcher or reimplement the surrounding tool. Every added line should be necessary for this workspace's current behavior.
