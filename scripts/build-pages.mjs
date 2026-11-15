import { cp, mkdir, rm, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const publicDir = join(root, 'public');
const distDir = join(root, 'dist');

async function copyFile(source, destination) {
  await mkdir(join(destination, '..'), { recursive: true });
  await cp(source, destination);
}

async function copyRoute(route, sourceFile) {
  const source = join(publicDir, sourceFile);
  if (!existsSync(source)) return;
  const destination = join(distDir, route, 'index.html');
  await copyFile(source, destination);
}

async function main() {
  if (!existsSync(join(publicDir, 'index.html'))) {
    throw new Error('public/index.html is missing; refusing to produce a fake deployment');
  }

  await rm(distDir, { recursive: true, force: true });
  await mkdir(distDir, { recursive: true });
  await cp(publicDir, distDir, { recursive: true });

  // Cloudflare Pages can serve these paths directly as static directories.
  // When Functions are deployed, _middleware still enforces dashboard auth.
  await copyRoute('login', 'login.html');
  await copyRoute('dashboard', 'dashboard.html');
  await copyRoute(join('dashboard', 'products'), 'dashboard.html');
  await copyRoute(join('dashboard', 'import'), 'dashboard.html');
  await copyRoute(join('dashboard', 'research'), 'dashboard.html');
  await copyRoute(join('dashboard', 'review'), 'dashboard.html');
  await copyRoute('demo', 'demo.html');

  const index = await stat(join(distDir, 'index.html'));
  if (index.size === 0) {
    throw new Error('Generated dist/index.html is empty');
  }

  console.log('Static Pages build written to dist/');
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
