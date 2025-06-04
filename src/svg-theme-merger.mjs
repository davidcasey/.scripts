#!/usr/bin/env node

import fs from 'fs/promises';
import path from 'path';
import { load } from 'cheerio';

async function main() {
  try {
    if (process.argv.length < 3) {
      console.error('Usage: node svg-theme-merger.mjs <filename-or-path-to-base>');
      process.exit(1);
    }

    let inputArg = process.argv[2];
    let baseName, dir;

    // If input is a directory or path ending with '/', treat as directory + basename
    if (inputArg.endsWith(path.sep)) {
      dir = inputArg;
      baseName = path.basename(path.resolve(inputArg));
    } else {
      baseName = path.basename(inputArg);
      dir = path.dirname(inputArg);
      if (dir === '') dir = '.';
    }

    // Compose file paths
    const lightFile = path.resolve(dir, `${baseName}-LIGHT.svg`);
    const darkFile = path.resolve(dir, `${baseName}-DARK.svg`);
    const outFile = path.resolve(dir, `${baseName}.svg`);

    // Read files
    let [lightSvg, darkSvg] = await Promise.all([
      fs.readFile(lightFile, 'utf8').catch(() => null),
      fs.readFile(darkFile, 'utf8').catch(() => null),
    ]);

    if (!lightSvg || !darkSvg) {
      console.error(`❌ Missing input files:\n  ${!lightSvg ? lightFile : ''}\n  ${!darkSvg ? darkFile : ''}`);
      process.exit(1);
    }

    // Load SVG with cheerio
    const $light = load(lightSvg, { xmlMode: true });
    const $dark = load(darkSvg, { xmlMode: true });

    // Find existing <style> tag or create one inside <svg>
    let styleTag = $light('svg > style').first();
    if (!styleTag.length) {
      // No <style> tag inside <svg>, create one at top
      $light('svg').prepend('<style></style>');
      styleTag = $light('svg > style').first();
    }

    // Collect color classes to inject
    const fillColors = new Set();
    const strokeColors = new Set();

    // Helper to normalize colors (lowercase, no spaces)
    function normColor(c) {
      return c ? c.trim().toLowerCase() : '';
    }

    // Recursive function to walk all elements in LIGHT SVG
    function walkElements(lightEl, darkEl) {
      // Compare fill & stroke colors
      const lightFill = normColor($light(lightEl).attr('fill'));
      const darkFill = normColor($dark(darkEl).attr('fill'));

      const lightStroke = normColor($light(lightEl).attr('stroke'));
      const darkStroke = normColor($dark(darkEl).attr('stroke'));

      let classesToAdd = [];

      if (darkFill && darkFill !== lightFill && darkFill !== 'none') {
        const cls = `fill-${darkFill.replace(/^#/, '')}`;
        fillColors.add(darkFill.replace(/^#/, ''));
        classesToAdd.push(cls);
      }
      if (darkStroke && darkStroke !== lightStroke && darkStroke !== 'none') {
        const cls = `stroke-${darkStroke.replace(/^#/, '')}`;
        strokeColors.add(darkStroke.replace(/^#/, ''));
        classesToAdd.push(cls);
      }

      if (classesToAdd.length > 0) {
        const existingClass = $light(lightEl).attr('class') || '';
        // Append new classes, keep existing ones
        const newClass = existingClass
          ? existingClass + ' ' + classesToAdd.join(' ')
          : classesToAdd.join(' ');
        $light(lightEl).attr('class', newClass.trim());
      }

      // Recurse for children
      const lightChildren = $light(lightEl).children().toArray();
      const darkChildren = $dark(darkEl).children().toArray();

      for (let i = 0; i < lightChildren.length; i++) {
        if (darkChildren[i]) {
          walkElements(lightChildren[i], darkChildren[i]);
        }
      }
    }

    // Start from root <svg> children
    const lightRootChildren = $light('svg').children().toArray();
    const darkRootChildren = $dark('svg').children().toArray();

    for (let i = 0; i < lightRootChildren.length; i++) {
      if (darkRootChildren[i]) {
        walkElements(lightRootChildren[i], darkRootChildren[i]);
      }
    }

    // Build CSS rules for dark mode media query
    let cssRules = '@media (prefers-color-scheme: dark) {\n';

    for (const fill of fillColors) {
      cssRules += `  .fill-${fill} { fill: #${fill}; }\n`;
    }
    for (const stroke of strokeColors) {
      cssRules += `  .stroke-${stroke} { stroke: #${stroke}; }\n`;
    }

    cssRules += '}\n';

    // Append CSS to style tag content (append, don't replace)
    const oldCss = styleTag.html() || '';
    styleTag.html(oldCss + '\n' + cssRules);

    // Write output file
    await fs.writeFile(outFile, $light.xml(), 'utf8');
    console.log(`✅ Merged SVG written to: ${outFile}`);
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
}

main();
