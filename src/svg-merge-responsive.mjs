#!/usr/bin/env node

import fs from 'fs/promises';
import path from 'path';
import { load } from 'cheerio';

function normalizeColor(color) {
  const hex = color.trim().toLowerCase().replace(/^#/, '');
  if (hex.length === 3) {
    return hex.split('').map(c => c + c).join(''); // expand shorthand
  }
  return hex;
}

function addClass($el, className) {
  const existing = $el.attr('class');
  const classes = new Set((existing || '').split(/\s+/).filter(Boolean));
  classes.add(className);
  $el.attr('class', Array.from(classes).join(' '));
}

async function main() {
  const input = process.argv[2];
  if (!input) {
    const cmd = path.basename(process.argv[1]);
    console.error(`Usage: ${cmd} <filename>`);
    process.exit(1);
  }

  const dir = path.dirname(input);
  const base = path.basename(input);
  const outFile = path.resolve(dir, `${base}.svg`);
  const darkFile = path.resolve(dir, `${base}-DARK.svg`);
  const lightFile = path.resolve(dir, `${base}-LIGHT.svg`);

  const [lightSvg, darkSvg] = await Promise.all([
    fs.readFile(lightFile, 'utf8'),
    fs.readFile(darkFile, 'utf8'),
  ]);

  const $light = load(lightSvg, { xmlMode: true });
  const $dark = load(darkSvg, { xmlMode: true });

  // Ensure there is a <style> tag inside <svg>
  const styleTag = $light('svg > style').first();
  if (!styleTag.length) {
    $light('svg').prepend('<style></style>');
  }

  const fillSet = new Set();
  const strokeSet = new Set();

  // Maps to track LIGHT color -> DARK color for fill and stroke
  const lightToDarkFillMap = new Map();
  const lightToDarkStrokeMap = new Map();

  // Keep track of LIGHT elements that did not get a match in the first pass
  const unmatchedElements = [];

  const lightElems = $light('*').toArray();
  const darkElems = $dark('*').toArray();

  // First pass: match elements pairwise by index
  for (let i = 0; i < lightElems.length; i++) {
    const $lightEl = $light(lightElems[i]);
    const $darkEl = darkElems[i] ? $dark(darkElems[i]) : null;

    const lightFillRaw = $lightEl.attr('fill');
    const darkFillRaw = $darkEl?.attr('fill');
    const lightStrokeRaw = $lightEl.attr('stroke');
    const darkStrokeRaw = $darkEl?.attr('stroke');

    const lightFill = lightFillRaw ? normalizeColor(lightFillRaw) : null;
    const darkFill = darkFillRaw ? normalizeColor(darkFillRaw) : null;
    const lightStroke = lightStrokeRaw ? normalizeColor(lightStrokeRaw) : null;
    const darkStroke = darkStrokeRaw ? normalizeColor(darkStrokeRaw) : null;

    let matched = false;

    // Handle fill color differences
    if (darkFill && darkFill !== 'none' && darkFill !== lightFill) {
      addClass($lightEl, `fill-${darkFill}`);
      fillSet.add(darkFill);
      if (lightFill) lightToDarkFillMap.set(lightFill, darkFill);
      matched = true;
    }

    // Handle stroke color differences
    if (darkStroke && darkStroke !== 'none' && darkStroke !== lightStroke) {
      addClass($lightEl, `stroke-${darkStroke}`);
      strokeSet.add(darkStroke);
      if (lightStroke) lightToDarkStrokeMap.set(lightStroke, darkStroke);
      matched = true;
    }

    // If no difference or no dark element, mark for second pass
    if (!matched) {
      unmatchedElements.push($lightEl);
    }
  }

  // Second pass: assign classes to unmatched LIGHT elements based on known mappings
  for (const $lightEl of unmatchedElements) {
    const lightFillRaw = $lightEl.attr('fill');
    const lightStrokeRaw = $lightEl.attr('stroke');
    const lightFill = lightFillRaw ? normalizeColor(lightFillRaw) : null;
    const lightStroke = lightStrokeRaw ? normalizeColor(lightStrokeRaw) : null;

    if (lightFill && lightToDarkFillMap.has(lightFill)) {
      const darkFill = lightToDarkFillMap.get(lightFill);
      addClass($lightEl, `fill-${darkFill}`);
      fillSet.add(darkFill);
    }

    if (lightStroke && lightToDarkStrokeMap.has(lightStroke)) {
      const darkStroke = lightToDarkStrokeMap.get(lightStroke);
      addClass($lightEl, `stroke-${darkStroke}`);
      strokeSet.add(darkStroke);
    }
  }

  // Build the CSS for dark mode color overrides
  let css = '\n@media (prefers-color-scheme: dark) {\n';
  for (const color of fillSet) {
    css += `  .fill-${color} { fill: #${color}; }\n`;
  }
  for (const color of strokeSet) {
    css += `  .stroke-${color} { stroke: #${color}; }\n`;
  }
  css += '}\n';

  // Append CSS inside <style> tag
  $light('svg > style').first().append(css);

  // Write the merged SVG file
  await fs.writeFile(outFile, $light.xml(), 'utf8');
  console.log(`✅ Wrote merged file: ${outFile}`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
