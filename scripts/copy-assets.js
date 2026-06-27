// Copies node icons (svg/png) into dist/, preserving the folder structure,
// because tsc only emits .js/.d.ts and ignores asset files.
const fs = require('fs');
const path = require('path');

function copyRecursive(srcDir, destDir, exts) {
	if (!fs.existsSync(srcDir)) return;
	for (const entry of fs.readdirSync(srcDir, { withFileTypes: true })) {
		const src = path.join(srcDir, entry.name);
		const dest = path.join(destDir, entry.name);
		if (entry.isDirectory()) {
			copyRecursive(src, dest, exts);
		} else if (exts.some((ext) => entry.name.endsWith(ext))) {
			fs.mkdirSync(path.dirname(dest), { recursive: true });
			fs.copyFileSync(src, dest);
			console.log(`copied ${path.relative(process.cwd(), src)} -> ${path.relative(process.cwd(), dest)}`);
		}
	}
}

const root = path.join(__dirname, '..');
copyRecursive(path.join(root, 'nodes'), path.join(root, 'dist', 'nodes'), ['.svg', '.png']);
console.log('Assets copied.');
