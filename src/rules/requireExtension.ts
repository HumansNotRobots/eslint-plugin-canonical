import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { dirname, resolve, sep } from 'node:path';
import { type TSESTree, type TSESLint } from '@typescript-eslint/utils';
import resolveImport from 'eslint-module-utils/resolve';
import { createRule } from '../utilities';
import { findDirectory } from '../utilities/findDirectory';
import { readPackageJson } from '../utilities/readPackageJson';
import { findRootPath } from '../utilities/findRootPath';

const extensions = ['.js', '.ts', '.tsx'];

const defaultOptions = {
  // You may want to disable ignorePackages because there can be too many false-positives
  // when attempting to identify if a package import requires .js extension or not.
  //
  // * We need to consider that the resolved path can be @types/.
  // * We need to consider that the package.json might have package.json#exports rules.
  ignorePackages: false,
  overrideExtension: true,
};

type Options = [
  {
    ignorePackages?: boolean;
    overrideExtension?: boolean;
  },
];

type MessageIds = 'extensionMissing';

type Node =
  | TSESTree.ExportAllDeclaration
  | TSESTree.ExportNamedDeclaration
  | TSESTree.ImportDeclaration;

const isExistingFile = (fileName: string) => {
  return existsSync(fileName) && lstatSync(fileName).isFile();
};

const fixRelativeImport = (
  fixer: TSESLint.RuleFixer,
  node: Node,
  fileName: string,
  overrideExtension: boolean,
) => {
  if (!node.source) {
    throw new Error('Node has no source');
  }

  const importPath = resolve(dirname(fileName), node.source.value);

  for (const extension of extensions) {
    if (isExistingFile(importPath + extension)) {
      return fixer.replaceTextRange(
        node.source.range,
        `'${node.source.value + (overrideExtension ? '.js' : extension)}'`,
      );
    }
  }

  for (const extension of extensions) {
    if (isExistingFile(resolve(importPath, 'index') + extension)) {
      return fixer.replaceTextRange(
        node.source.range,
        `'${
          node.source.value + `${sep}index` + (overrideExtension ? '.js' : extension)
        }'`,
      );
    }
  }

  return null;
};

const fixPathImport = (
  fixer: TSESLint.RuleFixer,
  node: Node,
  fileName: string,
  resolvedImportPath: string,
  overrideExtension: boolean,
) => {
  if (!node.source) {
    throw new Error('Node has no source');
  }

  const importPath = node.source.value;

  const lastSegment = importPath.split('/').pop();

  for (const extension of extensions) {
    if (resolvedImportPath.endsWith(lastSegment + extension)) {
      return fixer.replaceTextRange(
        node.source.range,
        `'${node.source.value + (overrideExtension ? '.js' : extension)}'`,
      );
    }
  }

  for (const extension of extensions) {
    if (resolvedImportPath.endsWith(lastSegment + '/index' + extension)) {
      return fixer.replaceTextRange(
        node.source.range,
        `'${
          node.source.value + '/index' + (overrideExtension ? '.js' : extension)
        }'`,
      );
    }
  }

  return null;
};

type AliasPaths = {
  [key: string]: string[];
};

type TSConfig = {
  compilerOptions: {
    paths?: AliasPaths;
  };
};

const endsWith = (subject: string, needles: string[]) => {
  return needles.some((needle) => {
    return subject.endsWith(needle);
  });
};

const createTSConfigFinder = () => {
  const cache: Record<string, TSConfig | null> = {};

  return (fileName: string) => {
    if (cache[fileName] !== undefined) {
      return cache[fileName];
    }

    let tsconfig: TSConfig;

    try {
      tsconfig = JSON.parse(readFileSync(fileName, 'utf8'));
    } catch {
      throw new Error(`Failed to parse TSConfig ${fileName}`);
    }

    cache[fileName] = tsconfig;

    return tsconfig;
  };
};

const findTSConfig = createTSConfigFinder();

const handleRelativePath = (
  context: TSESLint.RuleContext<'extensionMissing', Options>,
  node: Node,
  importPath: string,
  overrideExtension: boolean,
) => {
  if (!importPath.startsWith('.')) {
    return false;
  }

  const filename = context.filename ?? context.getFilename();

  // This would mean that the import path resolves to a non-JavaScript file, e.g. CSS import.
  if (isExistingFile(resolve(dirname(filename), importPath))) {
    return true;
  }

  context.report({
    fix(fixer) {
      return fixRelativeImport(fixer, node, filename, overrideExtension);
    },
    messageId: 'extensionMissing',
    node,
  });

  return true;
};

const normalizePackageName = (packageName: string) => {
  if (packageName.startsWith('@types/')) {
    // @types/testing-library__jest-dom -> @testing-library/jest-dom
    return '@' + packageName.replace('@types/', '').replace('__', '/');
  }

  return packageName;
};

const handleAliasPath = (
  context: TSESLint.RuleContext<'extensionMissing', Options>,
  node: Node,
  importPath: string,
  ignorePackages: boolean,
  overrideExtension: boolean,
) => {
  // @ts-expect-error we know this setting exists
  const project = (context.settings['import/resolver']?.typescript?.project ??
    null) as string | null;

  if (typeof project !== 'string') {
    return false;
  }

  const tsconfig = findTSConfig(project);

  if (!tsconfig) {
    return false;
  }

  let resolvedImportPath: string | undefined | null;

  const filename = context.filename ?? context.getFilename();
  try {
    // There are odd cases where using `resolveImport` resolves to a unexpected file, e.g.
    // `import turbowatch from 'turbowatch';` inside of `turbowatch.ts` resolves to `turbowatch.js`.
    // Using `require.resolve` with the `paths` option resolves to the correct file in those instances.
    resolvedImportPath = require.resolve(importPath, {
      paths: [filename],
    });
  } catch {
    // no-op
  }

  if (!resolvedImportPath) {
    // @ts-expect-error TODO check what's going on here
    resolvedImportPath = resolveImport(importPath, context);
  }

  if (!resolvedImportPath) {
    return false;
  }

  // This would mean that the import path resolves to a non-JavaScript file, e.g. CSS import.
  if (!endsWith(resolvedImportPath, extensions)) {
    return true;
  }

  const targetPackageJsonPath = findDirectory(
    resolvedImportPath,
    'package.json',
    findRootPath(resolvedImportPath),
  );

  if (targetPackageJsonPath) {
    if (ignorePackages) {
      const currentPackageJsonPath = findDirectory(
        filename,
        'package.json',
        findRootPath(resolvedImportPath),
      );

      if (
        currentPackageJsonPath &&
        currentPackageJsonPath !== targetPackageJsonPath
      ) {
        return false;
      }
    }

    const packageJson = readPackageJson(
      resolve(targetPackageJsonPath, 'package.json'),
    );

    if (
      packageJson.name &&
      normalizePackageName(packageJson.name) === importPath
    ) {
      return false;
    }
  }

  context.report({
    fix(fixer) {
      return fixPathImport(
        fixer,
        node,
        filename,
        resolvedImportPath,
        overrideExtension,
      );
    },
    messageId: 'extensionMissing',
    node,
  });

  return true;
};

export default createRule<Options, MessageIds>({
  create: (context, [options]) => {
    const ignorePackages =
      options.ignorePackages ?? defaultOptions.ignorePackages;
    const overrideExtension =
      options.overrideExtension ?? defaultOptions.overrideExtension;

    const rule = (node: Node) => {
      if (!node.source) {
        // export { foo };
        // export const foo = () => {};
        return;
      }

      const importPath = node.source.value;

      if (importPath.includes('?')) {
        // import { foo } from './foo.svg?url';
        return;
      }

      const importPathHasExtension = endsWith(importPath, extensions);

      if (importPathHasExtension) {
        return;
      }

      void (
        handleRelativePath(context, node, importPath, overrideExtension) ||
        handleAliasPath(context, node, importPath, ignorePackages, overrideExtension)
      );
    };

    return {
      ExportAllDeclaration: rule,
      ExportNamedDeclaration: rule,
      ImportDeclaration: rule,
    };
  },
  defaultOptions: [defaultOptions],
  meta: {
    docs: {
      description: 'Require file extension in import and export statements',
    },
    fixable: 'code',
    messages: {
      extensionMissing: 'Must include file extension',
    },
    schema: [
      {
        additionalProperties: false,
        properties: {
          ignorePackages: {
            type: 'boolean',
          },
          overrideExtension: {
            type: 'boolean',
          },
        },
        type: 'object',
      },
    ],
    type: 'layout',
  },
  name: 'require-extension',
});
