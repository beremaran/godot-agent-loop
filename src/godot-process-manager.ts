import { spawn, type ChildProcess } from 'child_process';
import {
  GODOT_GRACEFUL_SHUTDOWN_TIMEOUT_MS,
  GODOT_PROCESS_LOG_LINE_LIMIT,
  GODOT_PROCESS_LOG_LINE_LIMIT_BYTES,
  GODOT_PROCESS_OBSERVATION_PAGE_BYTES,
} from './godot-subprocess.js';

export interface GodotProcess {
  process: ChildProcess;
  output: string[];
  errors: string[];
  outputDropped?: number;
  errorsDropped?: number;
}

export interface ProcessOutputPage {
  items: string[];
  remaining: number;
  byteLimited: boolean;
}

export interface StartGodotProcessOptions {
  executable: string;
  args: string[];
  env?: NodeJS.ProcessEnv;
  onExit?: (code: number | null) => void;
  onError?: (error: Error) => void;
}

/** Owns the active Godot child process and its captured output. */
export class GodotProcessManager {
  public activeProcess: GodotProcess | null = null;
  private lastErrorIndex = 0;
  private lastLogIndex = 0;

  constructor(
    private readonly log: (message: string) => void = () => undefined,
    private readonly logLineLimit = GODOT_PROCESS_LOG_LINE_LIMIT,
    private readonly gracefulShutdownTimeoutMs = GODOT_GRACEFUL_SHUTDOWN_TIMEOUT_MS,
    private readonly spawnProcess: typeof spawn = spawn,
  ) {}

  get active(): boolean {
    return this.activeProcess !== null;
  }

  start(options: StartGodotProcessOptions): GodotProcess {
    const child = this.spawnProcess(options.executable, options.args, {
      stdio: 'pipe',
      env: options.env === undefined ? undefined : { ...process.env, ...options.env },
    });
    const record: GodotProcess = { process: child, output: [], errors: [], outputDropped: 0, errorsDropped: 0 };
    this.activeProcess = record;
    this.resetCursors();

    child.stdout?.on('data', (data: Buffer) => {
      const lines = data.toString().split('\n');
      record.outputDropped = (record.outputDropped ?? 0) + this.appendLines(record.output, lines, 'logs');
      for (const line of lines) if (line.trim()) this.log(`[Godot stdout] ${line}`);
    });
    child.stderr?.on('data', (data: Buffer) => {
      const lines = data.toString().split('\n');
      record.errorsDropped = (record.errorsDropped ?? 0) + this.appendLines(record.errors, lines, 'errors');
      for (const line of lines) if (line.trim()) this.log(`[Godot stderr] ${line}`);
    });
    child.on('exit', (code: number | null) => {
      this.log(`Godot process exited with code ${code}`);
      if (this.activeProcess?.process === child) this.activeProcess = null;
      options.onExit?.(code);
    });
    child.on('error', (error: Error) => {
      if (this.activeProcess?.process === child) this.activeProcess = null;
      options.onError?.(error);
    });
    return record;
  }

  stop(): GodotProcess | null {
    const record = this.activeProcess;
    if (!record) return null;
    this.activeProcess = null;
    this.resetCursors();
    let exited = false;
    const forceKill = setTimeout(() => {
      if (!exited) {
        this.log(`Godot process did not exit after ${this.gracefulShutdownTimeoutMs}ms; forcing termination`);
        record.process.kill('SIGKILL');
      }
    }, this.gracefulShutdownTimeoutMs);
    if (typeof record.process.on === 'function') {
      record.process.on('exit', () => {
        exited = true;
        clearTimeout(forceKill);
      });
    }
    record.process.kill('SIGTERM');
    return record;
  }

  async stopAndWait(timeoutMs = this.gracefulShutdownTimeoutMs + 1_000): Promise<GodotProcess | null> {
    const record = this.stop();
    if (!record) return null;
    if (record.process.exitCode !== null || record.process.signalCode !== null) return record;
    await new Promise<void>(resolve => {
      const timer = setTimeout(resolve, timeoutMs);
      record.process.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
    });
    return record;
  }

  seedActiveProcess(process: GodotProcess | null): void {
    this.activeProcess = process;
  }

  readNewErrors(limit = 1000, byteLimit = GODOT_PROCESS_OBSERVATION_PAGE_BYTES): ProcessOutputPage {
    if (!this.activeProcess) return { items: [], remaining: 0, byteLimited: false };
    const page = this.readPage(this.activeProcess.errors, this.lastErrorIndex, limit, byteLimit);
    this.lastErrorIndex += page.items.length;
    return page;
  }

  readNewLogs(limit = 1000, byteLimit = GODOT_PROCESS_OBSERVATION_PAGE_BYTES): ProcessOutputPage {
    if (!this.activeProcess) return { items: [], remaining: 0, byteLimited: false };
    const page = this.readPage(this.activeProcess.output, this.lastLogIndex, limit, byteLimit);
    this.lastLogIndex += page.items.length;
    return page;
  }

  private resetCursors(): void {
    this.lastErrorIndex = 0;
    this.lastLogIndex = 0;
  }

  private appendLines(target: string[], lines: string[], stream: 'logs' | 'errors'): number {
    const boundedLines = lines.map(line => this.boundLine(line));
    target.push(...boundedLines);
    const excess = target.length - this.logLineLimit;
    if (excess > 0) {
      target.splice(0, excess);
      if (stream === 'logs') this.lastLogIndex = Math.max(0, this.lastLogIndex - excess);
      else this.lastErrorIndex = Math.max(0, this.lastErrorIndex - excess);
    }
    return Math.max(0, excess);
  }

  private readPage(lines: readonly string[], start: number, limit: number, byteLimit: number): ProcessOutputPage {
    const items: string[] = [];
    let bytes = 2; // JSON array brackets.
    const maximum = Math.min(lines.length, start + Math.max(1, limit));
    for (let index = start; index < maximum; index += 1) {
      const itemBytes = Buffer.byteLength(JSON.stringify(lines[index]), 'utf8') + (items.length > 0 ? 1 : 0);
      if (items.length > 0 && bytes + itemBytes > byteLimit) break;
      items.push(lines[index]);
      bytes += itemBytes;
    }
    const end = start + items.length;
    return { items, remaining: lines.length - end, byteLimited: end < maximum };
  }

  private boundLine(line: string): string {
    if (Buffer.byteLength(line, 'utf8') <= GODOT_PROCESS_LOG_LINE_LIMIT_BYTES) return line;
    const marker = '…[truncated at 65536 bytes]';
    let bounded = line.slice(0, GODOT_PROCESS_LOG_LINE_LIMIT_BYTES);
    while (Buffer.byteLength(`${bounded}${marker}`, 'utf8') > GODOT_PROCESS_LOG_LINE_LIMIT_BYTES) {
      bounded = bounded.slice(0, -256);
    }
    return `${bounded}${marker}`;
  }
}
