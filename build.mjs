// .scripts/build.mjs
import esbuild from 'esbuild';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';

const banner = String.raw`
   ______          ___      _____                 
  / __/ /___ _____/ (_)__  / ___/__ ____ ___ __ __
 _\ \/ __/ // / _  / / _ \/ /__/ _ \(_-</ -_) // /
/___/\__/\_,_/\_,_/_/\___/\___/\_,_/___/\__/\_, / 
                                           /___/  
    D A V I D   C A S E Y
`;
console.log(banner);

const args = process.argv.slice(2);
const filename = args.find(arg => !arg.startsWith('--'));
const aliasFlagIndex = args.indexOf('--alias');
const customAlias = aliasFlagIndex !== -1 ? args[aliasFlagIndex + 1] : null;

if (!filename) {
  console.error('❌ You must provide a filename to build.');
  process.exit(1);
}

const scriptsDir = path.join(os.homedir(), '.scripts');
const srcDir = path.join(scriptsDir, 'src');
const publicDir = path.join(scriptsDir, 'public');
await fs.mkdir(publicDir, { recursive: true });

const inputFile = path.join(srcDir, `${filename}.mjs`);
const outputFile = path.join(publicDir, `${filename}.bundle.js`);

try {
  await esbuild.build({
    entryPoints: [inputFile],
    bundle: true,
    platform: 'node',
    outfile: outputFile,
  });
  console.log(`✅ Built ${filename} to ${outputFile}`);
} catch (err) {
  console.error(`❌ Build failed for ${filename}`);
  console.error(err);
  process.exit(1);
}

if (aliasFlagIndex !== -1) {
  const aliasesFile = path.join(os.homedir(), '.aliases');
  const aliasName = customAlias ?? filename;
  const relativeOutfile = outputFile.replace(os.homedir(), '~');
  const aliasLine = `alias ${aliasName}='node ${relativeOutfile}'`;

  let content = '';
  try {
    content = await fs.readFile(aliasesFile, 'utf8');
  } catch {
    // File does not exist, will create below
  }

  const header = '# .scripts';
  let updatedContent = '';

  if (!content.includes(header)) {
    updatedContent = `${content.trim()}\n\n${header}\n${aliasLine}\n`;
  } else if (!content.includes(aliasLine)) {
    const lines = content.split('\n');
    const insertIndex = lines.findIndex(line => line.trim() === header) + 1;
    lines.splice(insertIndex, 0, aliasLine);
    updatedContent = lines.join('\n');
  } else {
    console.log(`ℹ️ Alias already exists for ${aliasName}`);
    updatedContent = content;
  }

  await fs.writeFile(aliasesFile, updatedContent);
  console.log(`✅ Alias added to ~/.aliases as '${aliasName}'`);

  console.log(`\n💡 Run or copy this to apply immediately:`);
  console.log(`source ~/.aliases`);
}
