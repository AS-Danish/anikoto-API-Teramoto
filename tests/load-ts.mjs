import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

// Compile the actual TypeScript modules without booting Next or making network
// calls. Test doubles replace only explicit external boundaries.
export function loadTs(relative, mocks = {}) {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const modules = new Map();
  function load(file) {
    if (modules.has(file)) return modules.get(file).exports;
    const module = { exports: {} };
    modules.set(file, module);
    const require = (name) => {
      if (Object.hasOwn(mocks, name)) return mocks[name];
      if (name === 'server-only') return {};
      if (name.startsWith('.') || name.startsWith('@/')) {
        const target = name.startsWith('@/') ? path.join(root, 'src', name.slice(2)) : path.resolve(path.dirname(file), name);
        if (fs.existsSync(`${target}.ts`)) return load(`${target}.ts`);
      }
      return createRequire(file)(name);
    };
    const code = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
    }).outputText;
    new Function('require', 'module', 'exports', code)(require, module, module.exports);
    return module.exports;
  }
  return load(path.join(root, relative));
}
