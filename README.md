# .scripts

```
 ______     ______    __  __     _____     __     ______
/\  ___\   /\__  _\  /\ \/\ \   /\  __`.  /\ \   /\  __ \
\ \___  \  \/_/\ \/  \ \ \_\ \  \ \ \/\ \ \ \ \  \ \ \/\ \
 \/\_____\    \ \_\   \ \_____\  \ \____,  \ \_\  \ \_____\
  \/_____/     \/_/    \/_____/   \/____/   \/_/   \/_____/
      ______     ______     ______     ______     __  __   
     /\  ___\   /\  __ \   /\  ___\   /\  ___\   /\ \_\ \
     \ \ \____  \ \  __ \  \ \___  \  \ \  __\   \ \____ \    __
      \ \_____\  \ \_\ \_\  \/\_____\  \ \_____\  \/\_____\  /\_\
       \/_____/   \/_/\/_/   \/_____/   \/_____/   \/_____/  \/_/
```


## 📦 Install & Setup

Install dependencies using Yarn 4+:

```bash
yarn install
```

This project uses Yarn Plug'n'Play (PnP), so `node_modules/` folder will not exist.

---

## 🛠️ Building Scripts

To bundle all CLI scripts, run:

```bash
yarn build
```

This will:

- Traverse all scripts listed in `scriptmap.json`
- Compile each `.mjs` or `.ts` file in `.scripts/src/`
- Output bundled Node.js files to `.scripts/public/`
- Remove dead entries from `scriptmap.json`
- Add aliases (if defined) to your `~/.aliases` file

To build and optionally alias a specific script:

```bash
yarn build <script-name> [--alias [custom-alias]]
```

- `<script-name>` is the name of the `.mjs` file in `.scripts/src` (without extension)
- `--alias` (optional) adds a shell alias in `~/.aliases` pointing to the bundled output
- `[custom-alias]` — Optional custom alias name (defaults to `<script-name>` if omitted)

Remember to source the alias to enable the command in your shell:

```bash
source ~/.aliases
```

---

## 🔧 `scriptmap.json`

The `scriptmap.json` file serves as the manifest for all buildable scripts. Each entry defines:

```json
{
  "svg-theme-merger.mjs": {
    "alias": "svgmerge",
    "description": "Merges LIGHT and DARK themed SVGs into a responsive single SVG.",
    "args": ["<path/to/filename>"],
    "example": "svgmerge logo"
  },
  "another-script.mjs": {
    "description": "Does something useful.",
    "args": [],
    "example": "another-script"
  }
}
```

You can add more entries to this file as you develop new scripts. Each object key is the source filename inside `.scripts/src/`. The alias (if present) is added to `~/.aliases` automatically during the build.

---

## 🌟 svg-theme-merger

This script merges two nearly identical SVG images—differing only by fill and stroke color—into a single responsive SVG. It is designed to handle:

- `filename-DARK.svg` (dark mode)
- `filename-LIGHT.svg` (light mode)

This functionality was inspired by [Napkin AI](https://napkin.ai). Instead of managing two separate images, this script combines them seamlessly.

### Usage

```bash
svg-theme-merger [path/to/filename]
```

Where `[path/to/filename]` is the base filename without the `-LIGHT.svg` or `-DARK.svg` suffix.

### Alias Usage

After building and aliasing the script (see Bundling CLI Scripts), you can run:

```bash
svgmerge <path/to/filename>
```

Where `<path/to/filename>` is the base name of your SVG theme to merge (e.g., `logo`).

This command will:

- Load the corresponding -LIGHT.svg and -DARK.svg files from the configured location
- Merge or transform their contents into a combined responsive SVG
- Output the merged SVG as defined in the script

### Example

```bash
svgmerge logo
```

---

## 💡 Script Development

This repo uses a custom script builder located at `.scripts/build.mjs` to bundle and alias Node.js CLI scripts with no external dependencies at runtime.

Scripts that are ready for prime time are moved to the `public/` folder.

### How it works

- Input: `.scripts/src/<script-name>.mjs`
- Output: `.scripts/public/<script-name>.bundle.js` (fully self-contained)
- Bundler: esbuild via Yarn PnP (no need to install globally)
- Aliases: Written to `~/.aliases`, under the `# .scripts` section

### Examples

```bash
# Build svg-theme-merger.mjs without alias:
yarn build svg-theme-merger

# Build and create alias named svg-theme-merger (default alias):
yarn build svg-theme-merger --alias

# Build and create alias named svgmerge:
yarn build svg-theme-merger --alias svgmerge
```
