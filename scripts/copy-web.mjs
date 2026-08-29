import { cp, mkdir } from 'node:fs/promises';
await mkdir('dist/apps/web', { recursive: true });
await cp('apps/web/public', 'dist/apps/web/public', { recursive: true });
