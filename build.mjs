import esbuild from 'esbuild';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { spawnSync } from 'child_process';

const banner = String.raw`
   ______          ___      _____                 
  / __/ /___ _____/ (_)__  / ___/__ ____ ___ __ __
 _\ \/ __/ // / _  / / _ \/ /__/ _ \(_-</ -_) // /
/___/\__/\_,_/\_,_/_/\___/\___/\_,_/___/\__/\_, / 
                                           /___/  
    D A V I D   C A S E Y
`;

// Detect if this is a child subprocess build to suppress banner
const isChild = process.env.IS_CHILD === 'true';

const args = process.argv.slice(2);
const filename = args.find(arg => !arg.startsWith('--'));
const aliasArgIndex = args.indexOf('--alias');
const customAlias = aliasArgIndex !== -1 ? args[aliasArgIndex + 1] : null;

const scriptsDir = process.cwd();
const srcDir = path.join(scriptsDir, 'src');
const publicDir = path.join(scriptsDir, 'public');
const mapPath = path.join(scriptsDir, 'scriptmap.json');

await fs.mkdir(publicDir, { recursive: true });

const isBulk = !filename;

// Only print banner if NOT child process
if (!isChild) {
  console.log(banner);
}

if (isBulk) {
  let scriptMap;
  try {
    const raw = await fs.readFile(mapPath, 'utf8');
    scriptMap = JSON.parse(raw);
  } catch {
    console.error('❌ Could not read scriptmap.json. Run a specific build first to generate it.');
    process.exit(1);
  }

  const filesInSrc = (await fs.readdir(srcDir)).filter(f =>
    (f.endsWith('.mjs') || f.endsWith('.ts')) &&
    !f.endsWith('.test.ts') &&
    !f.endsWith('.d.ts')
  );
  const activeFiles = new Set(filesInSrc);

  const cleanedMap = Object.fromEntries(
    Object.entries(scriptMap).filter(([file]) => {
      if (!activeFiles.has(file)) {
        console.log(`🧹 Removed dead entry from scriptmap.json: ${file}`);
        return false;
      }
      return true;
    })
  );

  for (const [file, meta] of Object.entries(cleanedMap)) {
    const name = path.basename(file, path.extname(file));
    const subArgs = [name];
    if (meta?.alias) subArgs.push('--alias', meta.alias);

    // Pass IS_CHILD= true to suppress banner on child process
    const proc = spawnSync('node', ['./build.mjs', ...subArgs], {
      cwd: scriptsDir,
      stdio: 'inherit',
      env: { ...process.env, IS_CHILD: 'true' },
    });

    if (proc.status !== 0) {
      console.error(`❌ Failed to build ${name}`);
    }
  }

  await fs.writeFile(mapPath, JSON.stringify(cleanedMap, null, 2));
  process.exit(0);
}

if (!filename) {
  console.error('❌ You must provide a filename to build or omit for full build.');
  process.exit(1);
}

let inputExt = '.mjs';
let inputFile = path.join(srcDir, `${filename}${inputExt}`);
try {
  await fs.access(inputFile);
} catch {
  inputExt = '.ts';
  inputFile = path.join(srcDir, `${filename}${inputExt}`);
  try {
    await fs.access(inputFile);
  } catch {
    console.error(`❌ No .mjs or .ts script found for '${filename}' in src/`);
    process.exit(1);
  }
}

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

let scriptMap = {};
try {
  const raw = await fs.readFile(mapPath, 'utf8');
  scriptMap = JSON.parse(raw);
} catch {
  // no map yet
}

if (customAlias) {
  for (const [scriptFile, meta] of Object.entries(scriptMap)) {
    if (meta?.alias === customAlias && scriptFile !== `${filename}${inputExt}`) {
      console.error(`❌ Alias '${customAlias}' is already used by '${scriptFile}'. Please choose a different alias.`);
      process.exit(1);
    }
  }
}

const scriptKey = `${filename}${inputExt}`;
scriptMap[scriptKey] = scriptMap[scriptKey] || {};
scriptMap[scriptKey].alias = customAlias || scriptMap[scriptKey].alias || '';

await fs.writeFile(mapPath, JSON.stringify(scriptMap, null, 2));
console.log(`📦 Updated scriptmap.json`);

if (customAlias) {
  const aliasesFile = path.join(os.homedir(), '.aliases');
  const relativeOutfile = outputFile.replace(os.homedir(), '~');
  const aliasLine = `alias ${customAlias}='node ${relativeOutfile}'`;

  let content = '';
  try {
    content = await fs.readFile(aliasesFile, 'utf8');
  } catch {
    // file doesn't exist yet, will create
  }

  const header = '# .scripts';
  let updatedContent = '';
  let aliasAdded = false;

  if (!content.includes(header)) {
    updatedContent = `${content.trim()}\n\n${header}\n${aliasLine}\n`;
    aliasAdded = true;
  } else if (!content.includes(aliasLine)) {
    const lines = content.split('\n');
    const insertIndex = lines.findIndex(line => line.trim() === header) + 1;
    lines.splice(insertIndex, 0, aliasLine);
    updatedContent = lines.join('\n');
    aliasAdded = true;
  } else {
    updatedContent = content;
  }

  await fs.writeFile(aliasesFile, updatedContent);

  if (aliasAdded) {
    console.log(`✅ Alias added to ~/.aliases as '${customAlias}'`);
    console.log(`💡 Run or copy this to apply immediately:\nsource ~/.aliases`);
  } else {
    console.log(`ℹ️ Alias already exists for ${customAlias}`);
  }
}
