import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outputPath = resolve(process.argv[2] ?? join(
  repositoryRoot, 'assets/demo/godot-agent-loop-launch.mp4',
));
const posterPath = resolve(process.argv[3] ?? join(
  repositoryRoot, 'assets/demo/godot-agent-loop-launch-poster.png',
));
const work = mkdtempSync(join(tmpdir(), 'godot-agent-loop-launch-video-'));

const colors = {
  background: '#07101d', panel: '#0d1a2b', blue: '#478CBF',
  paleBlue: '#9dd8ff', green: '#73d99c', red: '#ff7d86',
  white: '#f5f8fc', muted: '#b8c5d6',
};

function run(command, args) {
  execFileSync(command, args, { stdio: 'inherit' });
}

function addText(args, { text, x, y, size, color = colors.white, bold = false }) {
  args.push(
    '-font', bold ? 'DejaVu-Sans-Bold' : 'DejaVu-Sans',
    '-fill', color, '-pointsize', String(size), '-gravity', 'NorthWest',
    '-annotate', `+${x}+${y}`, text,
  );
}

function addImage(args, image) {
  args.push(
    '(', image.path, '-resize', image.size,
    '-bordercolor', image.borderColor ?? colors.blue,
    '-border', String(image.border ?? 3), ')',
    '-gravity', 'NorthWest', '-geometry', `+${image.x}+${image.y}`, '-composite',
  );
}

function makeSlide(index, options) {
  const output = join(work, `slide-${String(index).padStart(2, '0')}.png`);
  const args = [
    '-size', '1920x1080', `xc:${colors.background}`, '-fill', colors.panel,
    '-draw', 'roundrectangle 56,56 1864,1024 36,36', '-fill', colors.blue,
    '-draw', 'roundrectangle 56,56 1864,74 18,18',
  ];
  for (const text of options.texts ?? []) addText(args, text);
  if (options.image) addImage(args, options.image);
  if (options.secondImage) addImage(args, options.secondImage);
  addText(args, {
    text: options.footer ?? 'REAL COLD RUN  •  2026-07-14  •  GODOT AGENT LOOP 1.0.0',
    x: 100, y: 962, size: 24, color: colors.muted,
  });
  args.push(output);
  run('convert', args);
  return output;
}

const icon = join(repositoryRoot, 'assets/previews/assetlib-icon.png');
const editorOverview = join(repositoryRoot, 'assets/previews/assetlib-editor-overview.png');
const editorDock = join(repositoryRoot, 'assets/previews/assetlib-editor-dock.png');
const playing = join(repositoryRoot, 'assets/demo/launch-playing.png');
const win = join(repositoryRoot, 'assets/demo/launch-win.png');
const lose = join(repositoryRoot, 'assets/demo/launch-lose.png');

const slides = [
  {
    duration: 6,
    path: makeSlide(1, {
      texts: [
        { text: 'Godot Agent Loop', x: 120, y: 230, size: 92, bold: true },
        { text: 'Build it. Play it. Prove it.', x: 126, y: 370, size: 48, color: colors.paleBlue },
        { text: 'A 65-second proof from an actual cold-agent run', x: 126, y: 480, size: 34, color: colors.muted },
      ],
      image: { path: icon, size: '520x520', x: 1240, y: 210, border: 0 },
    }),
  },
  {
    duration: 7,
    path: makeSlide(2, {
      texts: [
        { text: '01  Empty directory → playable game', x: 110, y: 110, size: 54, bold: true },
        { text: 'Exact prompt:', x: 120, y: 245, size: 30, color: colors.paleBlue, bold: true },
        { text: '“Starting from the empty allowed directory,\nbuild a small playable Godot game…”', x: 120, y: 300, size: 42 },
        { text: 'Claude Sonnet 5  •  high effort\nBuilt-in tools disabled  •  39 MCP tools\nHuman corrections: 0', x: 120, y: 520, size: 34, color: colors.muted },
        { text: 'create_project', x: 1260, y: 330, size: 44, color: colors.green, bold: true },
        { text: 'launch_editor', x: 1260, y: 420, size: 44, color: colors.green, bold: true },
        { text: 'create_scene', x: 1260, y: 510, size: 44, color: colors.green, bold: true },
      ],
    }),
  },
  {
    duration: 9,
    path: makeSlide(3, {
      texts: [
        { text: '02  The editor follows the agent', x: 110, y: 100, size: 54, bold: true },
        { text: 'Authenticated activity streams into the real Godot dock', x: 116, y: 178, size: 30, color: colors.muted },
      ],
      image: { path: editorOverview, size: '1640x720', x: 140, y: 250 },
    }),
  },
  {
    duration: 7,
    path: makeSlide(4, {
      texts: [
        { text: '03  Human control stays in the loop', x: 110, y: 105, size: 54, bold: true },
        { text: 'Pause Agent', x: 130, y: 280, size: 66, color: colors.red, bold: true },
        { text: 'Mutation refused before dispatch\nInspection remains available\nResume Agent returns control', x: 135, y: 400, size: 39 },
        { text: 'Authenticated • bounded • cooperative', x: 135, y: 680, size: 30, color: colors.muted },
      ],
      image: { path: editorDock, size: '720x760', x: 1110, y: 195 },
    }),
  },
  {
    duration: 7,
    path: makeSlide(5, {
      texts: [
        { text: '04  PLAYING', x: 110, y: 105, size: 62, color: colors.paleBlue, bold: true },
        { text: 'Live UI: PLAYING\nLog: PLAYING\nScreenshot: 1152 × 648\nBlue player\nGreen goal\nRed hazard', x: 120, y: 290, size: 34 },
      ],
      image: { path: playing, size: '1080x608', x: 750, y: 250 },
    }),
  },
  {
    duration: 7,
    path: makeSlide(6, {
      texts: [
        { text: '05  WIN', x: 110, y: 105, size: 62, color: colors.green, bold: true },
        { text: 'Fresh live observation\nUI text: WIN\nLog line: WIN\nRendered player overlaps the goal', x: 120, y: 285, size: 36 },
        { text: 'Finding: the agent used 33 taps\ninstead of discovering hidden key_hold.', x: 120, y: 610, size: 28, color: colors.muted },
      ],
      image: { path: win, size: '1080x608', x: 750, y: 250, borderColor: colors.green },
    }),
  },
  {
    duration: 7,
    path: makeSlide(7, {
      texts: [
        { text: '06  LOSE', x: 110, y: 105, size: 62, color: colors.red, bold: true },
        { text: 'Separate clean run\nUI text: LOSE\nLog line: LOSE\nPlayer remained at start', x: 120, y: 285, size: 36 },
      ],
      image: { path: lose, size: '1080x608', x: 750, y: 250, borderColor: colors.red },
    }),
  },
  {
    duration: 9,
    path: makeSlide(8, {
      texts: [
        { text: '07  Independent compound verification', x: 110, y: 105, size: 54, bold: true },
        { text: '5 / 5 assertions passed', x: 120, y: 280, size: 62, color: colors.green, bold: true },
        { text: 'Player • Goal • Hazard • StatusLabel\nLog contains PLAYING\nScreenshot sha256: 4e1a66b8…\nstopped: true  •  teardown: true', x: 125, y: 400, size: 34 },
      ],
      image: { path: playing, size: '900x506', x: 920, y: 300, borderColor: colors.green },
    }),
  },
  {
    duration: 6,
    path: makeSlide(9, {
      texts: [
        { text: 'Build it. Play it. Prove it.', x: 120, y: 180, size: 72, bold: true },
        { text: '391.795 s  •  104 turns  •  103 MCP calls', x: 125, y: 350, size: 42, color: colors.paleBlue },
        { text: '25 tools used  •  0 built-in tool calls  •  0 human corrections', x: 125, y: 430, size: 34 },
        { text: '167 / 167 E2E tools  •  201 full-path tests\nGodot 4.4 floor  •  Godot 4.7 primary', x: 125, y: 560, size: 36 },
        { text: 'Exact prompt, project, screenshots, and replay ship with the source.', x: 125, y: 750, size: 30, color: colors.muted },
      ],
      image: { path: icon, size: '340x340', x: 1450, y: 560, border: 0 },
    }),
  },
];

try {
  mkdirSync(dirname(outputPath), { recursive: true });
  mkdirSync(dirname(posterPath), { recursive: true });
  run('convert', [
    '-define', 'png:exclude-chunk=date,tIME,tEXt,zTXt,iTXt',
    slides[0].path, '-strip', `PNG32:${posterPath}`,
  ]);

  const concatPath = join(work, 'slides.txt');
  const concat = slides.flatMap(slide => [`file '${slide.path}'`, `duration ${slide.duration}`]);
  concat.push(`file '${slides.at(-1).path}'`);
  writeFileSync(concatPath, `${concat.join('\n')}\n`);
  const duration = slides.reduce((sum, slide) => sum + slide.duration, 0);

  run('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', concatPath,
    '-t', String(duration), '-vf', 'fps=30,format=yuv420p', '-c:v', 'libx264',
    '-preset', 'slow', '-crf', '20', '-movflags', '+faststart',
    '-metadata', 'title=Godot Agent Loop 1.0 cold-agent proof',
    '-metadata', 'comment=Exact run evidence: docs/launch/launch-evidence.md', outputPath,
  ]);

  const probe = execFileSync('ffprobe', [
    '-v', 'error', '-show_entries', 'format=duration:stream=codec_name,width,height',
    '-of', 'json', outputPath,
  ], { encoding: 'utf8' });
  console.log(JSON.stringify({ output: outputPath, poster: posterPath, ...JSON.parse(probe) }, null, 2));
} finally {
  rmSync(work, { recursive: true, force: true });
}
