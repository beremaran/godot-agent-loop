#!/usr/bin/env node
/**
 * Audits the MCP tool surface against the engine's own class list.
 *
 * Unlike docs/coverage/coverage-report.md, whose denominators come from our
 * own sources, the denominator here is produced by Godot itself
 * (`--dump-extension-api`). A class we never thought to support still appears,
 * so the gap list can grow when the engine grows and we stand still.
 *
 * Every class in the dump lands in exactly one bucket:
 *
 *   tooled       a named MCP tool targets the class (the class token appears
 *                in the GDScript we ship or in a tool schema)
 *   reachable    no named tool, but the class is generically drivable:
 *                ClassDB-instantiable (headless `add_node`, runtime `game_eval`)
 *                or exposed as a singleton
 *   out-of-scope editor/debugger/GDExtension surface the README does not claim
 *   gap          none of the above -- needs a decision
 *
 * Usage:
 *   node scripts/engine-surface-audit.js           # rewrite the report
 *   node scripts/engine-surface-audit.js --check   # fail if the report is stale
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, readdirSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const reportPath = join(root, 'docs/coverage/engine-surface.md');
const dataPath = join(root, 'docs/coverage/engine-surface.json');
const scopePath = join(root, 'docs/coverage/engine-scope.json');
const cacheDir = join(root, '.cache/engine-api');

/**
 * Classes the README declares unsupported. Kept as an explicit list with a
 * reason each, so "out of scope" is always a decision on record and never the
 * silent default for something we simply forgot.
 */
const scope = JSON.parse(readFileSync(scopePath, 'utf8'));

function dumpExtensionApi(godotBin) {
  const version = execFileSync(godotBin, ['--headless', '--version'], { encoding: 'utf8' }).trim().split('\n').pop().trim();
  mkdirSync(cacheDir, { recursive: true });
  const cached = join(cacheDir, `extension_api-${version}.json`);
  if (!existsSync(cached)) {
    // --dump-extension-api writes extension_api.json into the working directory.
    execFileSync(godotBin, ['--headless', '--dump-extension-api'], { cwd: cacheDir, stdio: 'ignore' });
    execFileSync('mv', [join(cacheDir, 'extension_api.json'), cached]);
  }
  return { version, api: JSON.parse(readFileSync(cached, 'utf8')) };
}

/** Every class name we mention in shipped GDScript or in a tool schema. */
function collectToolReferences() {
  const sources = [];
  const walk = dir => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (/\.(gd|ts)$/.test(entry.name)) sources.push(path);
    }
  };
  walk(join(root, 'src'));
  // The persistent editor bridge is shipped from its canonical AssetLib path;
  // build/scripts contains only the generated npm compatibility copy.
  walk(join(root, 'addons/godot_agent_loop'));

  const references = new Map();
  for (const path of sources) {
    const text = readFileSync(path, 'utf8');
    for (const token of text.match(/\b[A-Z][A-Za-z0-9_]{2,}\b/g) ?? []) {
      if (!references.has(token)) references.set(token, new Set());
      references.get(token).add(path.slice(root.length + 1));
    }
  }
  return references;
}

/**
 * A scope rule that matches nothing is worse than no rule: it reads like a
 * decision while excluding nobody, and it rots silently across engine releases.
 * (An earlier revision of engine-scope.json excluded `ScriptDebugger`, a class
 * that does not exist in Godot 4.) Fail loudly instead.
 */
function validateScope(api, scope) {
  const engineClasses = new Set(api.classes.map(c => c.name));
  const dead = [];
  for (const rule of scope.out_of_scope) {
    for (const name of rule.classes ?? []) {
      if (!engineClasses.has(name)) dead.push(`${rule.group}: "${name}" is not a class in this engine`);
    }
    if (rule.prefix && !api.classes.some(c => c.name.startsWith(rule.prefix))) {
      dead.push(`${rule.group}: prefix "${rule.prefix}" matches no class in this engine`);
    }
  }
  if (dead.length > 0) {
    console.error('docs/coverage/engine-scope.json has rules that match nothing:');
    for (const line of dead) console.error(`  ${line}`);
    process.exit(1);
  }
}

function classify(api, references) {
  const byName = new Map(api.classes.map(c => [c.name, c]));
  const singletons = new Set(api.singletons.map(s => s.type ?? s.name));

  const inheritsFrom = (cls, ancestor) => {
    for (let c = cls; c; c = byName.get(c.inherits)) if (c.name === ancestor) return true;
    return false;
  };

  const children = new Map();
  for (const cls of api.classes) {
    if (!cls.inherits) continue;
    if (!children.has(cls.inherits)) children.set(cls.inherits, []);
    children.get(cls.inherits).push(cls);
  }
  /** Instantiable classes below `cls`, i.e. the concrete forms of an abstraction. */
  const concreteDescendants = cls => {
    const found = [];
    const walk = c => {
      for (const child of children.get(c.name) ?? []) {
        if (child.is_instantiable) found.push(child.name);
        walk(child);
      }
    };
    walk(cls);
    return found;
  };

  return api.classes.map(cls => {
    const refs = references.get(cls.name);
    const scopeRule = scope.out_of_scope.find(rule =>
      rule.classes?.includes(cls.name) || (rule.prefix && cls.name.startsWith(rule.prefix)));

    // A tool that drives the class wins over any out-of-scope rule: the editor
    // bridge really does drive EditorInterface, and pretending otherwise would
    // understate what we ship.
    let bucket, why;
    if (refs) {
      bucket = 'tooled';
      why = [...refs].join(', ');
    } else if (scopeRule) {
      bucket = 'out-of-scope';
      why = `${scopeRule.group}: ${scopeRule.reason}`;
    } else if (cls.api_type === 'editor') {
      // The dump marks many of these is_instantiable, but that is an editor-side
      // fact: in a running game ClassDB.instantiate() returns null for them, so
      // game_eval cannot reach them however constructible they look here. Proven
      // by tests/e2e/engine-reach.test.ts, which failed on
      // EditorExportPlatformAndroid when this branch was missing.
      bucket = 'gap';
      why = 'editor-context class: not constructible in a running game, and no tool reaches it';
    } else if (cls.is_instantiable) {
      bucket = 'reachable';
      why = 'ClassDB-instantiable: headless add_node and runtime game_eval can construct it';
    } else if (singletons.has(cls.name)) {
      bucket = 'reachable';
      why = 'engine singleton: runtime game_eval can call it by name';
    } else if (concreteDescendants(cls).length > 0) {
      // Abstract by design (Light2D, SpriteBase3D, Tweener): you never construct
      // one, you construct a subclass. Reaching every concrete subclass reaches
      // the whole abstraction, so this is not a hole in the surface.
      const concrete = concreteDescendants(cls);
      bucket = 'reachable';
      why = `abstract base; reached through ${concrete.length} instantiable subclass(es), e.g. ${concrete.slice(0, 3).join(', ')}`;
    } else {
      // Not constructible, no concrete subclass, not a singleton: the only way
      // to hold one is to be handed it by an engine API (RenderingServer hands
      // out a RenderingDevice; a body hands out its PhysicsDirectBodyState3D).
      bucket = 'gap';
      why = 'handle class: obtainable only from an engine accessor, and no tool exposes one';
    }

    return {
      name: cls.name,
      bucket,
      why,
      api_type: cls.api_type,
      instantiable: Boolean(cls.is_instantiable),
      is_node: inheritsFrom(cls, 'Node'),
      is_resource: inheritsFrom(cls, 'Resource'),
      methods: (cls.methods ?? []).length,
      properties: (cls.properties ?? []).length,
    };
  });
}

function render(version, api, rows) {
  const count = bucket => rows.filter(r => r.bucket === bucket).length;
  const gaps = rows.filter(r => r.bucket === 'gap').sort((a, b) => b.methods - a.methods || a.name.localeCompare(b.name));
  const methods = api.classes.reduce((n, c) => n + (c.methods ?? []).length, 0);

  const lines = [
    '# Engine surface audit',
    '',
    'Generated by `scripts/engine-surface-audit.js`. Do not edit by hand;',
    'regenerate with `npm run coverage:engine`. `npm run coverage:engine -- --check`',
    'fails when this file is stale.',
    '',
    'The denominator here comes from the engine, not from our sources: it is',
    "Godot's own `--dump-extension-api` output. A class we never considered still",
    'appears below, so this report can regress when Godot grows and we stand still.',
    'That is the point, and it is what the tool coverage report cannot tell us.',
    '',
    `## Engine denominator (Godot ${version})`,
    '',
    '| Surface | Count |',
    '| --- | ---: |',
    `| Classes | ${api.classes.length} |`,
    `| Methods | ${methods} |`,
    `| Node subclasses | ${rows.filter(r => r.is_node).length} |`,
    `| Resource subclasses | ${rows.filter(r => r.is_resource).length} |`,
    `| Singletons | ${api.singletons.length} |`,
    '',
    '## Classification',
    '',
    '| Bucket | Classes | Meaning |',
    '| --- | ---: | --- |',
    `| tooled | ${count('tooled')} | The class is named in our shipped GDScript or in a tool schema |`,
    `| reachable | ${count('reachable')} | No named tool, but generically drivable via \`add_node\` / \`game_eval\` |`,
    `| out-of-scope | ${count('out-of-scope')} | Declared unsupported in the README support boundary |`,
    `| gap | ${count('gap')} | No tool, no generic reach, no scope decision |`,
    `| **Total** | **${rows.length}** | |`,
    '',
    '### Tooled is an upper bound',
    '',
    'The `tooled` bucket is populated by scanning our sources for class-name tokens,',
    'so it also catches base classes we merely reference as types (`Object`,',
    '`RefCounted`, `Node`) rather than target with a named tool. Read it as "we',
    'mention this class", not "we have a first-class affordance for it".',
    '',
    '### Reachable is a claim, not a measurement',
    '',
    'The `reachable` bucket asserts that `game_eval` and `add_node` can drive any',
    'ClassDB-instantiable class. That assertion is only worth what the evidence',
    'behind it is worth: `tests/e2e/engine-reach.test.ts` samples untooled classes',
    'from this bucket and drives them end to end. Classes it has not sampled are',
    'reachable in principle, not in evidence.',
    '',
    '## Out of scope',
    '',
    'Grouped by reason, from `docs/coverage/engine-scope.json`. Every group is a',
    'decision on record; the audit fails if a rule stops matching any class.',
    '',
    '| Group | Classes | Reason |',
    '| --- | ---: | --- |',
    ...scope.out_of_scope.map(rule => {
      const members = rows.filter(r => r.bucket === 'out-of-scope' && r.why.startsWith(`${rule.group}: `));
      return `| ${rule.group} | ${members.length} | ${rule.reason} |`;
    }),
    '',
    '## Gap list',
    '',
  ];

  if (gaps.length === 0) {
    lines.push('No gaps: every engine class is tooled, generically reachable, or scoped out.', '');
  } else {
    lines.push(
      `${gaps.length} classes have no tool, no generic reach, and no scope decision.`,
      'Each needs one: a tool, a reachability proof, or a line in `docs/coverage/engine-scope.json`.',
      '',
      '| Class | Node | Resource | Methods | Why it is a gap |',
      '| --- | --- | --- | ---: | --- |',
      ...gaps.map(g => `| \`${g.name}\` | ${g.is_node ? 'yes' : 'no'} | ${g.is_resource ? 'yes' : 'no'} | ${g.methods} | ${g.why} |`),
      '',
    );
  }
  return lines.join('\n');
}

const godotBin = process.env.GODOT_BIN;
if (!godotBin) {
  console.error('GODOT_BIN is not set; cannot dump the engine API.');
  process.exit(1);
}

const { version, api } = dumpExtensionApi(godotBin);
validateScope(api, scope);
const rows = classify(api, collectToolReferences());
const gaps = rows.filter(row => row.bucket === 'gap');
const report = render(version, api, rows);
const data = JSON.stringify({ engine: version, generated_from: '--dump-extension-api', classes: rows }, null, 2) + '\n';

if (process.argv.includes('--check')) {
  const baseline = existsSync(dataPath) ? JSON.parse(readFileSync(dataPath, 'utf8')) : null;
  const versionFamily = value => /^(\d+\.\d+)/.exec(value ?? '')?.[1] ?? null;
  const baselineVersion = typeof baseline?.engine === 'string' ? baseline.engine : version;
  // Patch releases often change only the version stamp. Accept them when the
  // complete generated report and class data remain identical to the audited
  // baseline; a changed class, method count, singleton count, or bucket still
  // makes the report stale. Different major/minor releases always need a new
  // checked-in audit.
  const comparisonVersion = versionFamily(version) === versionFamily(baselineVersion)
    ? baselineVersion
    : version;
  const comparableReport = render(comparisonVersion, api, rows);
  const comparableData = JSON.stringify({ engine: comparisonVersion, generated_from: '--dump-extension-api', classes: rows }, null, 2) + '\n';
  const stale = !existsSync(reportPath) || !existsSync(dataPath)
    || readFileSync(reportPath, 'utf8') !== comparableReport
    || readFileSync(dataPath, 'utf8') !== comparableData;
  if (stale) {
    console.error('docs/coverage/engine-surface.md is stale; run `npm run coverage:engine`.');
    process.exit(1);
  }
  if (gaps.length > 0) {
    console.error(`Engine surface audit has ${gaps.length} unresolved gap(s): ${gaps.map(row => row.name).join(', ')}`);
    process.exit(1);
  }
  const compatibility = comparisonVersion === version ? '' : ` (verified with compatible ${version})`;
  console.log(`Engine surface report is current for Godot ${comparisonVersion}${compatibility}.`);
} else {
  writeFileSync(reportPath, report);
  writeFileSync(dataPath, data);
  console.log(`Wrote ${reportPath} for Godot ${version}: ${rows.length} classes, ${gaps.length} gaps.`);
  if (gaps.length > 0) process.exit(1);
}
