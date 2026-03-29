import * as esbuild from 'esbuild';

async function build() {
  await esbuild.build({
    entryPoints: ['server.ts'],
    bundle: true,
    platform: 'node',
    target: 'node22', // Match the project's node version
    outfile: 'dist/server.cjs',
    format: 'cjs',
    external: [
      'express',
      'vite',
      'firebase/app',
      'firebase/firestore',
      'axios',
      '@google/genai',
      'dotenv',
      'path',
      'url',
      'fs',
      'crypto-js',
      'body-parser'
    ],
    banner: {
      js: '// Compiled from server.ts',
    },
  });
  console.log('Server build complete: dist/server.cjs');
}

build().catch((err) => {
  console.error('Server build failed:', err);
  process.exit(1);
});
