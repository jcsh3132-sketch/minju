const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const output = path.join(root, 'public');
fs.mkdirSync(output, {recursive:true});
for (const file of ['index.html','style.css','game.js','manifest.webmanifest','icon.svg','icon-192.png','icon-512.png']) {
  fs.copyFileSync(path.join(root,file),path.join(output,file));
}
console.log('Built public mobile game assets.');
