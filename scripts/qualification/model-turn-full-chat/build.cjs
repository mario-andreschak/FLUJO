const fs = require('node:fs'), path = require('node:path');
const crypto = require('node:crypto'), cp = require('node:child_process');
const root = process.argv[2];
process.env.INSPECTOR_SOURCE_ROOT = root;
const webpack = require(path.join(root, 'node_modules/next/dist/compiled/webpack/webpack.js')).webpack;
const base = path.resolve(process.argv[3]); fs.mkdirSync(base,{recursive:true});
const sourcePaths = ['src/frontend/components/Chat/ModelTurnInspector.tsx', 'src/frontend/components/Chat/ModelTurnJsonPreview.tsx', 'src/frontend/components/Chat/modelTurnJsonPage.ts', 'src/frontend/components/Chat/modelTurnDetailCache.ts', 'src/frontend/services/chat/index.ts', 'src/frontend/services/chat/modelTurnInspection.ts', 'src/frontend/components/Chat/index.tsx', 'src/backend/execution/flow/modelTurnSnapshotChunks.ts', 'src/backend/execution/flow/modelTurnSnapshotResponse.ts', 'src/backend/execution/flow/modelTurnArchive.ts', 'src/app/v1/chat/conversations/[conversationId]/model-turns/[dispatchId]/route.ts'];
const hashes = Object.fromEntries(sourcePaths.map(p => [p,crypto.createHash('sha256').update(fs.readFileSync(path.join(root,p))).digest('hex')]));
const head = cp.execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim();
webpack({ mode: 'production', target: 'web', context: root,
  entry: path.join(__dirname, 'entry.tsx'), output: { path: base, filename: 'bundle.js' },
  resolve: { extensions: ['.tsx','.ts','.js','.json'], alias: { '@': path.join(root,'src') }, modules: [path.join(root,'node_modules')] },
  module: { rules: [{ test: /\.tsx?$/, use: path.join(__dirname,'loader.cjs') }, { test: /\.css$/, use: path.join(__dirname,'css-loader.cjs') }] },
  optimization: { minimize: false },
  plugins: [new webpack.DefinePlugin({ 'process.env.NODE_ENV': JSON.stringify('production'), 'process.env': '{}' })],
}, (error, stats) => {
  if (error || stats.hasErrors()) { console.error(error || stats.toString({all:false,errors:true})); process.exitCode=1; }
  else {
    for (const p of sourcePaths) if(crypto.createHash('sha256').update(fs.readFileSync(path.join(root,p))).digest('hex') !== hashes[p]) throw Error('Source changed during browser bundle');
    fs.writeFileSync(path.join(base,'bundle-source.json'),JSON.stringify({head,sourceHashes:hashes,bundleSha256:crypto.createHash('sha256').update(fs.readFileSync(path.join(base,'bundle.js'))).digest('hex')},null,2));
    fs.writeFileSync(path.join(base,'build.log'), stats.toString({all:false,assets:true})); console.log('browser Source bundle ready');
  }
});
