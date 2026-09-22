import { expect, it } from 'vitest';
import { readFile, readdir } from 'node:fs/promises';
import { resolve, relative, sep } from 'node:path';
import ts from 'typescript';

it('core imports stay inside the core and never depend on a host, SDK or transport', async () => {
  const root = resolve('packages/core/src');
  for (const name of await readdir(root)) {
    if (!name.endsWith('.ts')) continue;
    const source = ts.createSourceFile(
      name,
      await readFile(resolve(root, name), 'utf8'),
      ts.ScriptTarget.Latest,
      true,
    );
    const inspect = (node: ts.Node) => {
      if (
        ts.isIdentifier(node) &&
        [
          'window',
          'document',
          'localStorage',
          'sessionStorage',
          'XMLHttpRequest',
          'process',
          'Deno',
          'Bun',
        ].includes(node.text)
      )
        throw Error(`${name} must not access host-specific globals`);
      let imported: string | undefined;
      if (
        (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
        node.moduleSpecifier &&
        ts.isStringLiteral(node.moduleSpecifier)
      )
        imported = node.moduleSpecifier.text;
      if (
        ts.isImportTypeNode(node) &&
        ts.isLiteralTypeNode(node.argument) &&
        ts.isStringLiteral(node.argument.literal)
      )
        imported = node.argument.literal.text;
      if (imported !== undefined) {
        expect(imported.startsWith('./'), `${name} imports ${imported}`).toBe(true);
        expect(relative(root, resolve(root, imported)).startsWith('..' + sep), name).toBe(false);
      }
      if (
        ts.isCallExpression(node) &&
        (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
          (ts.isIdentifier(node.expression) && ['require', 'fetch'].includes(node.expression.text)))
      )
        throw Error(`${name} must not load host code or perform network requests`);
      ts.forEachChild(node, inspect);
    };
    inspect(source);
  }
  const pkg = JSON.parse(await readFile('packages/core/package.json', 'utf8'));
  expect(Object.keys(pkg.dependencies ?? {})).toEqual([]);
});
