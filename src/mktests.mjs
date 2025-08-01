#!/usr/bin/env node

import { readdirSync, writeFileSync, existsSync } from 'fs';
import { join, extname, basename } from 'path';

const dir = process.argv[2] || '.';
const supportedExts = ['.ts', '.tsx', '.js', '.jsx'];

console.log(`Creating test files in ${dir}...`);

try {
  const files = readdirSync(dir);
  let created = 0;

  files.forEach(file => {
    const ext = extname(file);
    const base = basename(file, ext);
    
    // Skip if not supported extension
    if (!supportedExts.includes(ext)) return;
    
    // Skip test files and index files
    if (base.includes('.test') || base.includes('.spec') || base === 'index') return;
    
    const testFile = join(dir, `${base}.test${ext}`);
    
    // Skip if test file already exists
    if (existsSync(testFile)) return;
    
    // Create empty test file
    writeFileSync(testFile, '');
    console.log(`  ✓ ${base}.test${ext}`);
    created++;
  });

  console.log(`\nCreated ${created} test files.`);
} catch (error) {
  console.error(`Error: ${error.message}`);
  process.exit(1);
}