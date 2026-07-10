import { describe, it, expect } from 'vitest';
import {
  toDotnetIdentifier,
  isValidCsharpIdentifier,
  generateGodotProjectFeatures,
  generateCsprojContent,
  generateCsharpScriptSource,
  DEFAULT_GODOT_NET_SDK_VERSION,
  DEFAULT_DOTNET_TARGET_FRAMEWORK,
} from '../src/utils.js';

describe('toDotnetIdentifier', () => {
  it('replaces invalid characters with underscores', () => {
    expect(toDotnetIdentifier('My Rpg-Game!')).toBe('My_Rpg_Game_');
  });
  it('prefixes leading digits', () => {
    expect(toDotnetIdentifier('2Fast')).toBe('_2Fast');
  });
  it('falls back to Game for empty input', () => {
    expect(toDotnetIdentifier('')).toBe('Game');
    expect(toDotnetIdentifier('***')).toBe('___');
  });
});

describe('generateGodotProjectFeatures', () => {
  it('omits the C# feature for a plain project', () => {
    expect(generateGodotProjectFeatures(false)).toBe('PackedStringArray("4.4")');
  });
  it('adds the C# feature (not DotNet) for a .NET project', () => {
    const f = generateGodotProjectFeatures(true);
    expect(f).toBe('PackedStringArray("4.4", "C#")');
    expect(f).not.toContain('DotNet');
  });
  it('honors an explicit version', () => {
    expect(generateGodotProjectFeatures(true, '4.5')).toBe('PackedStringArray("4.5", "C#")');
  });
});

describe('generateCsprojContent', () => {
  const csproj = generateCsprojContent('My Game');
  it('uses the Godot.NET.Sdk with the default version', () => {
    expect(csproj).toContain(`<Project Sdk="Godot.NET.Sdk/${DEFAULT_GODOT_NET_SDK_VERSION}">`);
  });
  it('targets the default framework and enables dynamic loading', () => {
    expect(csproj).toContain(`<TargetFramework>${DEFAULT_DOTNET_TARGET_FRAMEWORK}</TargetFramework>`);
    expect(csproj).toContain('<EnableDynamicLoading>true</EnableDynamicLoading>');
  });
  it('sanitizes the root namespace', () => {
    expect(csproj).toContain('<RootNamespace>My_Game</RootNamespace>');
  });
  it('accepts custom sdk/framework versions', () => {
    const c = generateCsprojContent('X', '4.5.0', 'net9.0');
    expect(c).toContain('Godot.NET.Sdk/4.5.0');
    expect(c).toContain('<TargetFramework>net9.0</TargetFramework>');
  });
});

describe('generateCsharpScriptSource', () => {
  it('emits a partial class extending the given base', () => {
    const src = generateCsharpScriptSource({ className: 'Player', baseClass: 'CharacterBody2D' });
    expect(src).toContain('using Godot;');
    expect(src).toContain('public partial class Player : CharacterBody2D');
  });
  it('defaults the base class to Node', () => {
    const src = generateCsharpScriptSource({ className: 'Thing' });
    expect(src).toContain('public partial class Thing : Node');
  });
  it('generates correct override signatures for known Godot virtuals', () => {
    const src = generateCsharpScriptSource({ className: 'P', methods: ['_Ready', '_Process'] });
    expect(src).toContain('public override void _Ready()');
    expect(src).toContain('public override void _Process(double delta)');
  });
  it('generates plain void methods for non-virtual names', () => {
    const src = generateCsharpScriptSource({ className: 'P', methods: ['DoThing'] });
    expect(src).toContain('public void DoThing()');
  });
  it('wraps in a namespace when provided, preserving dotted segments', () => {
    const src = generateCsharpScriptSource({ className: 'P', namespaceName: 'My.Game' });
    expect(src).toContain('namespace My.Game;');
  });
  it('sanitizes each namespace segment', () => {
    const src = generateCsharpScriptSource({ className: 'P', namespaceName: 'My Game.Sub-Space' });
    expect(src).toContain('namespace My_Game.Sub_Space;');
  });
  it('sanitizes an invalid class name', () => {
    const src = generateCsharpScriptSource({ className: 'my-player' });
    expect(src).toContain('public partial class my_player : Node');
  });
  it('deduplicates repeated method names', () => {
    const src = generateCsharpScriptSource({ className: 'P', methods: ['_Ready', '_Ready'] });
    expect(src.match(/_Ready\(\)/g)?.length).toBe(1);
  });
});

describe('isValidCsharpIdentifier', () => {
  it('accepts valid identifiers', () => {
    expect(isValidCsharpIdentifier('Player')).toBe(true);
    expect(isValidCsharpIdentifier('_Thing2')).toBe(true);
  });
  it('rejects invalid identifiers', () => {
    expect(isValidCsharpIdentifier('my-player')).toBe(false);
    expect(isValidCsharpIdentifier('2Fast')).toBe(false);
    expect(isValidCsharpIdentifier('My.Game')).toBe(false);
    expect(isValidCsharpIdentifier('')).toBe(false);
  });
});
